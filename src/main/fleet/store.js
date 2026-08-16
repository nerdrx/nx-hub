"use strict";
// NX Hub — fleet: `<dataDir>/fleet.json`.
//
//   { "id": "<16 hex>", "name": "<hostname>", "peers": [
//       { "id", "name", "host", "port", "secret", "lastSeen" } ] }
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
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 64) : raw.id,
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : protocol.FLEET_PORT,
    secret,
    lastSeen: Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : null,
  };
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
