"use strict";
// NX Hub — fleet: the UDP discovery beacon.
//
// Every BEACON_INTERVAL_MS a hub broadcasts
//   {nx:"fleet-beacon", id, name: hostname, hubVersion, port: 9023}
// to 255.255.255.255:9022 and listens on the same port for everybody else's.
//
// SPEC asked whether to also join 224.0.0.251 (mDNS's group). We do NOT:
// broadcast alone reaches every hub on the same subnet with no group
// membership, no multicast routing and no interface bookkeeping, and a fleet
// is by definition a handful of machines in one flat home network. Multicast
// would buy reach across subnets that the WS server could not use anyway
// (broadcast and multicast both stop at the router that would also NAT the
// :9023 connection away).
//
// A beacon carries NO authority. The worst a forged one can do is make a hub
// dial an address; the HMAC challenge there decides everything that matters.
// Discovery is therefore deliberately promiscuous and the trust lives one
// layer up.
//
// Everything is injectable (ports, addresses, interval, socket factory) so the
// tests run two beacons on loopback with ephemeral ports and never touch the
// real :9022 the user's own hub is sitting on.

const dgram = require("dgram");

const protocol = require("./protocol");

function noop() {}

/**
 * @param {object} o
 * @param {number} [o.port]              bind port (0 = ephemeral, tests)
 * @param {number} [o.sendPort]          where to send (defaults to `port`, or
 *                                       BEACON_PORT when port is ephemeral)
 * @param {string} [o.bindAddress]       "0.0.0.0" live, "127.0.0.1" in tests
 * @param {string} [o.broadcastAddress]  "255.255.255.255" live
 * @param {boolean} [o.broadcast]        SO_BROADCAST (false on loopback tests)
 * @param {number} [o.intervalMs]
 * @param {function} o.message           () => ({id, name, hubVersion, port})
 * @param {function} [o.onPeer]          (record, isNew) => void
 * @param {function} [o.log]
 * @param {number} [o.ttlMs]             how long a record counts as fresh
 */
function createBeacon(o = {}) {
  const log = typeof o.log === "function" ? o.log : noop;
  const message = typeof o.message === "function" ? o.message : () => ({});
  const onPeer = typeof o.onPeer === "function" ? o.onPeer : noop;
  const bindPort = Number.isInteger(o.port) ? o.port : protocol.BEACON_PORT;
  const sendPort = Number.isInteger(o.sendPort) ? o.sendPort : bindPort || protocol.BEACON_PORT;
  const bindAddress = o.bindAddress || "0.0.0.0";
  const broadcastAddress = o.broadcastAddress || "255.255.255.255";
  const wantBroadcast = o.broadcast !== false;
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : protocol.BEACON_INTERVAL_MS;
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : protocol.BEACON_TTL_MS;

  /** id -> {id, name, hubVersion, host, port, at} */
  const seen = new Map();
  let socket = null;
  let timer = null;
  let closed = false;
  let bound = false;

  function record(beacon, host) {
    const now = Date.now();
    const previous = seen.get(beacon.id) || null;
    const entry = {
      id: beacon.id,
      name: beacon.name || beacon.id,
      hubVersion: beacon.hubVersion || "",
      host,
      port: beacon.port,
      at: now,
      firstSeen: previous ? previous.firstSeen : now,
    };
    seen.set(beacon.id, entry);
    // "Dedupe" means: one entry per id, and the callback only fires when the
    // entry is new or its address/name actually moved. A five-second heartbeat
    // from a peer that has not changed is bookkeeping, not news.
    const isNew = !previous;
    const moved =
      previous && (previous.host !== entry.host || previous.port !== entry.port || previous.name !== entry.name);
    if (isNew || moved) onPeer(entry, isNew);
    return entry;
  }

  function onMessage(buf, rinfo) {
    if (closed) return;
    const beacon = protocol.parseBeacon(buf);
    if (!beacon) return; // junk on a broadcast port is the normal case
    const me = message() || {};
    if (me.id && beacon.id === me.id) return; // never discover ourselves
    record(beacon, protocol.normalizeHost(rinfo && rinfo.address));
  }

  function send() {
    if (closed || !socket || !bound) return false;
    const me = message() || {};
    if (!me.id) return false;
    const payload = protocol.beaconMessage(me);
    try {
      socket.send(payload, 0, payload.length, sendPort, broadcastAddress, (err) => {
        // ENETUNREACH / EACCES on a laptop with no network is routine — the
        // beacon must not become a log firehose over a closed lid.
        if (err && err.code !== "ENETUNREACH" && err.code !== "EACCES" && err.code !== "EHOSTUNREACH") {
          log(`fleet: beacon send failed — ${err.message}`);
        }
      });
      return true;
    } catch (e) {
      log(`fleet: beacon send failed — ${e.message}`);
      return false;
    }
  }

  const api = {
    port: bindPort,
    sendPort,
    ready: null,
    /** Everything heard from, newest state per id. */
    list() {
      return Array.from(seen.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    /** One id's record, or null. */
    get(id) {
      return seen.get(id) || null;
    },
    /** Was this id heard from within the freshness window? */
    isFresh(id, now = Date.now()) {
      const entry = seen.get(id);
      return Boolean(entry && now - entry.at <= ttlMs);
    },
    send,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        if (socket) socket.close();
      } catch (_) {
        /* never bound */
      }
      socket = null;
    },
  };

  api.ready = new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      socket = (o.createSocket || dgram.createSocket)({ type: "udp4", reuseAddr: true });
    } catch (e) {
      log(`fleet: beacon socket failed — ${e.message}`);
      closed = true;
      return settle({ ok: false, error: e });
    }
    socket.on("error", (err) => {
      // A busy :9022 means another hub on this machine already beacons; that
      // is not fatal, we just stop being discoverable ourselves.
      log(`fleet: beacon ${err && err.code === "EADDRINUSE" ? "port is busy" : `failed — ${err.message}`}`);
      api.close();
      settle({ ok: false, error: err });
    });
    socket.on("message", onMessage);
    socket.on("listening", () => {
      bound = true;
      try {
        if (wantBroadcast) socket.setBroadcast(true);
      } catch (e) {
        log(`fleet: SO_BROADCAST unavailable — ${e.message}`);
      }
      const addr = socket.address();
      api.port = addr.port;
      if (socket.unref) socket.unref();
      send(); // announce immediately; do not make a new hub wait 5s to appear
      timer = setInterval(send, intervalMs);
      if (timer.unref) timer.unref();
      settle({ ok: true, port: addr.port });
    });
    try {
      socket.bind(bindPort, bindAddress);
    } catch (e) {
      log(`fleet: beacon bind failed — ${e.message}`);
      api.close();
      settle({ ok: false, error: e });
    }
    return undefined;
  });

  return api;
}

module.exports = { createBeacon };
