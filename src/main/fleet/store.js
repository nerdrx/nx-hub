"use strict";
// NX Hub — fleet: `<dataDir>/fleet.json`.
//
//   { "id": "<16 hex>", "name": "<hostname>", "peers": [
//       { "id", "name", "host", "port", "secret", "lastSeen", "mac" } ] }
//
// `mac` (v0.7) is the peer's hardware address, learned from the local ARP cache
// while a session was up (see arp.js). It is the one field that is only ever
// ADDED, never cleared: a failed lookup — a peer behind a router, a cache that
// had not filled yet — must not throw away the address that lets us wake a
// machine that is, by definition, unreachable when we need it.
//
// The id is minted ONCE, on first read, and never changes — it is what a peer
// knows this hub by, and what the pairing secret was derived from. Every write
// goes through config.writeJsonAtomic (tmp + rename), so the GUI hub and a
// concurrently running `nx fleet …` can never leave a half-written file
// behind; last writer wins per file, exactly like state.json (SPEC).
//
// The file holds shared secrets, so it is created 0600 and re-chmod'ed on
// every write — a world-readable fleet.json would hand the LAN a free session.
//
// Pure node: the CLI drives this in its own process, without electron.

const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../config");
const protocol = require("./protocol");
const arp = require("./arp");

const FILE = "fleet.json";

function fleetPath(dataDir) {
  return path.join(dataDir || config.dataDir(), FILE);
}

/** A peer we are willing to keep. Anything malformed is dropped on load. */
function sanitizePeer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!protocol.isId(raw.id)) return null;
  const secret = typeof raw.secret === "string" && /^[0-9a-f]{64}$/i.test(raw.secret) ? raw.secret.toLowerCase() : null;
  if (!secret) return null;
  const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : null;
  if (!host) return null;
  const port = Number(raw.port);
  const lastSeen = Number(raw.lastSeen);
  const clean = {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 64) : raw.id,
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : protocol.FLEET_PORT,
    secret,
    lastSeen: Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : null,
  };
  // v0.7: the key is ADDED, never present-and-undefined. upsertPeer merges with
  // Object.assign, which happily copies an undefined value over a good one —
  // an absent mac has to be an absent KEY or re-pairing would forget it.
  const mac = arp.normalizeMac(raw.mac);
  if (mac) clean.mac = mac;
  return clean;
}

function sanitize(raw) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const peers = [];
  const seen = new Set();
  for (const entry of Array.isArray(data.peers) ? data.peers : []) {
    const peer = sanitizePeer(entry);
    if (!peer || seen.has(peer.id)) continue;
    seen.add(peer.id);
    peers.push(peer);
  }
  peers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    id: protocol.isId(data.id) ? data.id : null,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 64) : null,
    peers,
  };
}

/**
 * A store bound to one data dir.
 *
 * The whole file is re-read on every load() rather than cached: the CLI and the
 * GUI hub are separate processes writing the same file, and a stale in-memory
 * peer list is how you end up dialling a peer the user just unpaired.
 */
function createStore(dataDir) {
  const dir = dataDir || config.dataDir();
  const file = fleetPath(dir);

  function write(data) {
    config.ensureDir(dir);
    config.writeJsonAtomic(file, data);
    try {
      fs.chmodSync(file, 0o600); // secrets live here
    } catch (_) {
      /* some filesystems have no modes */
    }
    return data;
  }

  /** The file as stored, sanitised. `id` may still be null. */
  function read() {
    return sanitize(config.readJson(file, null));
  }

  /**
   * The file with an id guaranteed — minted and persisted on first call.
   * This is what everything except a pure inspection should use.
   */
  function load() {
    const data = read();
    if (data.id && data.name) return data;
    data.id = data.id || protocol.newId();
    data.name = data.name || String(os.hostname() || "nx-hub").slice(0, 64);
    return write(data);
  }

  function save(data) {
    return write(sanitize(data));
  }

  function peers() {
    return load().peers;
  }

  function getPeer(id) {
    return peers().find((p) => p.id === id) || null;
  }

  /**
   * Insert or update one peer, keeping the secret we already have unless the
   * caller supplies a new one (re-pairing legitimately rotates it).
   */
  function upsertPeer(peer) {
    const clean = sanitizePeer(peer);
    if (!clean) throw new Error("fleet: refusing to store a malformed peer");
    const data = load();
    const idx = data.peers.findIndex((p) => p.id === clean.id);
    if (idx >= 0) data.peers[idx] = Object.assign({}, data.peers[idx], clean);
    else data.peers.push(clean);
    write(data);
    return clean;
  }

  /** Update the volatile bits (host/port/lastSeen) without touching secrets. */
  function touchPeer(id, patch = {}) {
    const data = load();
    const peer = data.peers.find((p) => p.id === id);
    if (!peer) return null;
    let changed = false;
    if (patch.host && patch.host !== peer.host) {
      peer.host = String(patch.host);
      changed = true;
    }
    const port = Number(patch.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== peer.port) {
      peer.port = port;
      changed = true;
    }
    if (patch.name && patch.name !== peer.name) {
      peer.name = String(patch.name).slice(0, 64);
      changed = true;
    }
    // v0.7: a MAC is only ever written when we actually learned one. A null
    // (the ARP cache had nothing, the peer is a hop away) leaves the stored
    // address alone — losing it would cost the user the ability to wake a
    // machine, and there is no way to re-learn it while that machine is off.
    const mac = arp.normalizeMac(patch.mac);
    if (mac && mac !== peer.mac) {
      peer.mac = mac;
      changed = true;
    }
    if (patch.lastSeen) {
      // A lastSeen bump alone is not worth a disk write on every beacon; the
      // caller batches those (fleet/index.js persists at most once a minute).
      peer.lastSeen = Number(patch.lastSeen);
      changed = changed || patch.persist === true;
    }
    if (changed) write(data);
    return peer;
  }

  function removePeer(id) {
    const data = load();
    const before = data.peers.length;
    data.peers = data.peers.filter((p) => p.id !== id);
    if (data.peers.length === before) return false;
    write(data);
    return true;
  }

  return { dir, path: file, read, load, save, peers, getPeer, upsertPeer, touchPeer, removePeer };
}

module.exports = { createStore, fleetPath, sanitize, sanitizePeer, FILE };
