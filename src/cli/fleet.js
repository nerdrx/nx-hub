"use strict";
// The CLI's half of the fleet.
//
// `nx fleet …` does NOT need the local hub to be running. It reads fleet.json
// itself and dials peers as an ordinary fleet client — same handshake, same
// HMAC session, same message types the GUI hub speaks. That is the whole point:
// a headless box with no GUI can still drive the rest of the fleet.
//
// Two consequences, both deliberate and both documented in SPEC:
//
//   * PAIRING from the CLI needs this machine's own hub id. If fleet.json has
//     none yet (the hub has never run here), one is minted and persisted right
//     here — exactly what the hub would have done on its next start, so the two
//     never disagree.
//   * A remote job's progress is followed on THIS process's session. Close the
//     terminal and the remote job keeps going; you simply stop watching it.

const config = require("../main/config");
const fleetProtocol = require("../main/fleet/protocol");
const fleetClient = require("../main/fleet/client");
const wol = require("../main/fleet/wol");
const { createStore } = require("../main/fleet/store");

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Ask one question over a session and wait for the ack.
 * @returns {Promise<object>} the ack body (throws on ok:false)
 */
function ask(session, payload, { timeoutMs = 15000 } = {}) {
  const rid = `cli-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${session.peerName} did not answer in time.`));
    }, timeoutMs);
    const previous = session.onPayload;
    function cleanup() {
      clearTimeout(timer);
      session.onPayload = previous;
    }
    session.onPayload = (msg, s) => {
      if (msg.type === "ack" && msg.rid === rid) {
        cleanup();
        if (msg.ok === false) reject(new Error(msg.error || `${session.peerName} refused the request.`));
        else resolve(Object.assign({ rid }, msg));
        return;
      }
      if (typeof previous === "function") previous(msg, s);
    };
    if (!session.send(Object.assign({ rid }, payload))) {
      cleanup();
      reject(new Error(`Could not reach ${session.peerName}.`));
    }
  });
}

/**
 * Follow the remote jobs started by one request until they all finish.
 * `onEvent` gets every relayed job event; the promise settles when every job
 * id in `jobIds` has reported done or error.
 */
function followJobs(session, { rid, jobIds, onEvent, timeoutMs = 30 * 60 * 1000 }) {
  const outstanding = new Set(jobIds);
  if (!outstanding.size) return Promise.resolve({ ok: true, failures: [] });
  return new Promise((resolve, reject) => {
    const failures = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("the remote job stopped reporting"));
    }, timeoutMs);
    const previous = session.onPayload;
    function cleanup() {
      clearTimeout(timer);
      session.onPayload = previous;
    }
    session.onClose = () => {
      cleanup();
      reject(new Error(`${session.peerName} closed the connection`));
    };
    session.onPayload = (msg, s) => {
      if (msg.type === "job-event" && (!rid || msg.rid === rid || outstanding.has(msg.jobId))) {
        if (onEvent) onEvent(msg);
        if (msg.event === "job-error") failures.push(msg);
        if (msg.event === "job-done" || msg.event === "job-error") {
          outstanding.delete(msg.jobId);
          if (!outstanding.size) {
            cleanup();
            resolve({ ok: failures.length === 0, failures });
          }
        }
        return;
      }
      if (typeof previous === "function") previous(msg, s);
    };
  });
}

/** Wait for the peer's opening `summary` (it pushes one the moment we connect). */
function firstSummary(session, { timeoutMs = 6000 } = {}) {
  if (session.summary) return Promise.resolve(session.summary);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.onPayload = previous;
      resolve(null);
    }, timeoutMs);
    const previous = session.onPayload;
    session.onPayload = (msg, s) => {
      if (msg.type === "summary") {
        clearTimeout(timer);
        session.onPayload = previous;
        session.summary = msg;
        resolve(msg);
        return;
      }
      if (typeof previous === "function") previous(msg, s);
    };
  });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]   defaults to config.dataDir()
 * @param {number} [opts.timeoutMs] dial timeout
 */
function createFleetCli(opts = {}) {
  const store = createStore(opts.dataDir || config.dataDir());
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

  /** This machine's hub identity, minting one if the hub never ran here. */
  function identity() {
    const data = store.load();
    return { id: data.id, name: data.name, path: store.path };
  }

  function peers() {
    return store.peers();
  }

  /** Open a session to one peer. The caller closes it. */
  function connect(peer) {
    const me = identity();
    return fleetClient.connect({
      host: peer.host,
      port: peer.port,
      localId: me.id,
      peer,
      timeoutMs,
    });
  }

  /** connect → run → close, whatever happens. */
  async function withPeer(peer, fn) {
    const session = await connect(peer);
    try {
      return await fn(session);
    } finally {
      try {
        session.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * One row per stored peer, dialled in PARALLEL — a fleet of five must not
   * take five dial timeouts to report that four of them are asleep.
   */
  async function list({ probe = true } = {}) {
    const stored = peers();
    if (!probe) {
      return stored.map((peer) => ({
        id: peer.id,
        name: peer.name,
        host: peer.host,
        port: peer.port,
        online: false,
        probed: false,
        error: null,
        hubVersion: null,
        apps: [],
        updates: 0,
      }));
    }
    return Promise.all(
      stored.map(async (peer) => {
        const row = {
          id: peer.id,
          name: peer.name,
          host: peer.host,
          port: peer.port,
          online: false,
          probed: true,
          error: null,
          hubVersion: null,
          apps: [],
          updates: 0,
        };
        try {
          await withPeer(peer, async (session) => {
            row.online = true;
            const summary = await firstSummary(session, { timeoutMs });
            if (summary) {
              row.name = summary.name || row.name;
              row.hubVersion = summary.hubVersion || null;
              row.apps = summary.apps || [];
              row.updates = fleetProtocol.summaryUpdates(summary);
            }
          });
        } catch (e) {
          row.error = e.message;
        }
        return row;
      })
    );
  }

  /** Pair with the hub at `host`, which must be showing `code` right now. */
  async function pair(host, code, port) {
    const me = identity();
    const peer = await fleetClient.pairWith({
      host: String(host || "").trim(),
      port: Number(port) > 0 ? Number(port) : fleetProtocol.FLEET_PORT,
      code: String(code || "").trim(),
      localId: me.id,
      localName: me.name,
      localPort: fleetProtocol.FLEET_PORT,
      timeoutMs,
    });
    if (peer.id === me.id) throw new Error("That is this very machine — pair two different hubs.");
    store.upsertPeer(peer);
    return peer;
  }

  function unpair(id) {
    return store.removePeer(id);
  }

  /** Install one app on a peer and follow the job to the end. */
  function install(peer, appId, artifactId, { onEvent } = {}) {
    return withPeer(peer, async (session) => {
      const ack = await ask(session, { type: "install", appId, artifactId: artifactId || null });
      const result = await followJobs(session, { rid: ack.rid, jobIds: [ack.jobId], onEvent });
      return Object.assign({}, ack, result);
    });
  }

  /** Update everything pending on a peer and follow every job it queued. */
  function updateAll(peer, { onEvent } = {}) {
    return withPeer(peer, async (session) => {
      const ack = await ask(session, { type: "update-all" });
      const jobIds = (ack.jobIds || []).map((j) => j.jobId);
      const result = await followJobs(session, { rid: ack.rid, jobIds, onEvent });
      return Object.assign({}, ack, result);
    });
  }

  function launch(peer, appId, artifactId) {
    return withPeer(peer, (session) => ask(session, { type: "launch", appId, artifactId: artifactId || null }));
  }

  /**
   * v0.7: `nx fleet wake <peer>` — magic packets straight off this process.
   *
   * The one fleet command with NO session behind it, and necessarily so: the
   * machine is asleep, so there is nothing to dial. Everything it needs is in
   * fleet.json (the mac a session captured while the peer was awake), which is
   * also why it works from a headless box with no hub running.
   *
   * @returns {Promise<{ok, sent, mac, reason?}>}
   */
  async function wake(peer, o = {}) {
    if (!peer) return { ok: false, sent: false, mac: null, reason: "unknown-peer" };
    if (!peer.mac) return { ok: false, sent: false, mac: null, reason: "no-mac" };
    const sent = await wol.wake(peer.mac, {
      address: o.address,
      ports: o.ports,
      dgram: o.dgram,
      log: o.log,
    });
    return { ok: sent, sent, mac: peer.mac, reason: sent ? null : "send-failed" };
  }

  return { store, identity, peers, connect, withPeer, list, pair, unpair, install, updateAll, launch, wake };
}

module.exports = { createFleetCli, ask, followJobs, firstSummary, DEFAULT_TIMEOUT_MS };
