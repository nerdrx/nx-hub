"use strict";
// NX Hub — fleet: hub-to-hub on the LAN (SPEC v0.6 "Fleet").
//
// This module ties the four pieces together:
//
//   protocol.js  the wire format and every crypto decision, as pure functions
//   store.js     fleet.json — this hub's id, and the peers it trusts
//   beacon.js    UDP discovery (who is out there)
//   server.js    the WS listener, pairing and the HMAC challenge
//   client.js    the dialling half, shared with the `nx fleet` CLI
//   arp.js       reading a peer's MAC out of the local ARP cache   (v0.7)
//   wol.js       the magic packet                                  (v0.7)
//   assets.js    the sha256 index, its auth, and the seeding fetch (v0.7)
//
// Module API (FROZEN — ipc.js, stacks.js and the CLI call exactly these):
//   init({config, jobs, discovery, emit, log}) -> {close}
//   getPeers() -> [{id, name, host, port, online, lastSeen, mac, summary}]
//   showCode() -> {code, expiresAt}
//   pair(host, code, port?) / unpair(id)
//   remoteInstall(peerId, appId, artifactId) / remoteLaunch(…) / remoteUpdateAll(peerId)
//   onHubEvent(evt)   <- index.js feeds the hub's event fan-out through here
//   --- v0.7 "fabric" -------------------------------------------------------
//   wake(peerId) -> Promise<bool>                 WOL to the stored mac
//   probePeerPort(peerId, port, {timeoutMs}) -> Promise<bool>
//                                                 remote TCP-connects 127.0.0.1:port
//   remoteStop(peerId, appId) -> Promise<ack>     remote's polite bus/SIGTERM dance
//   findAsset(sha256, {timeoutMs}) -> Promise<{peerId, peerName, size}|null>
//   fetchAsset(sha256, destPath, {peer, onProgress, signal}) -> Promise<{path,sha256,size}>
//   recordAsset(sha256, filePath) / assetIndex()  the seeding index
//   isRunning() / hasOnlinePeers()                cheap guards for jobs.js
//   isPeerOnline(peerId) -> bool                  the `peer-online` health gate
//
// SESSIONS. Both hubs listen and both hubs can dial, so without a rule they
// would connect to each other simultaneously, forever. protocol.shouldDial
// settles it without negotiation: the greater id dials, the lesser waits. An
// EXPLICIT request (remoteInstall from the waiting side) may still dial on
// demand — arbitration governs the idle background session, not the user.
//
// SUMMARY PUSH. SPEC says "pushed on state-change". The hub's event fan-out is
// assembled in index.js and this module is initialised from it, not into it,
// so there is no emit stream to subscribe to from here. Instead the summary is
// rebuilt on a 5s timer and only SENT when its hash changed — the observable
// behaviour SPEC asks for (a push per change, never more than one per 5s,
// nothing at all while nothing changes) without reaching into a sibling
// module's wiring. `onLocalChange()` is exported for a future direct hook.

const net = require("net");
const os = require("os");

const protocol = require("./protocol");
const { createStore } = require("./store");
const { createBeacon } = require("./beacon");
const { createServer } = require("./server");
const client = require("./client");
const arp = require("./arp");
const wol = require("./wol");
const assetsMod = require("./assets");
const frame = require("../connector/frame");

/** How often the local summary is rebuilt and (if changed) pushed. */
const SUMMARY_INTERVAL_MS = 5000;
/** How often we retry the peers we are supposed to be dialling. */
const DIAL_INTERVAL_MS = 5000;
/** A remote request that gets no ack in this long fails. */
const REQUEST_TIMEOUT_MS = 20000;
/** fleet-changed coalescing, same spirit as the connector's. */
const CHANGE_MIN_MS = 250;
/** v0.7: a health probe on a peered stack step. Short by design — it is a
 *  local TCP connect on the far side, not a network round trip. */
const PROBE_TIMEOUT_MS = 3000;
/** v0.7: how long a remote stop waits for the bus to say the app left. */
const STOP_WAIT_MS = 5000;

let current = null;

function noop() {}

function safely(fn, ...args) {
  try {
    if (typeof fn === "function") return fn(...args);
  } catch (_) {
    /* a listener must never break the fleet */
  }
  return undefined;
}

function hostPlatform() {
  return process.platform === "win32" ? "windows" : "linux";
}

/* ------------------------------------------------------------------ */

function createFleet(o = {}) {
  // eslint-disable-next-line global-require
  const config = o.config || require("../config");
  const jobs = o.jobs || null;
  const discovery = o.discovery || null;
  const emit = typeof o.emit === "function" ? o.emit : noop;
  const log = typeof o.log === "function" ? o.log : noop;

  const store = createStore(o.dataDir || config.dataDir());
  const identity = store.load(); // mints {id, name} on first ever run
  const hubVersion = String(o.hubVersion || "0.0.0");

  const summaryIntervalMs = Number(o.summaryIntervalMs) > 0 ? Number(o.summaryIntervalMs) : SUMMARY_INTERVAL_MS;
  const dialIntervalMs = Number(o.dialIntervalMs) > 0 ? Number(o.dialIntervalMs) : DIAL_INTERVAL_MS;
  const requestTimeoutMs = Number(o.requestTimeoutMs) > 0 ? Number(o.requestTimeoutMs) : REQUEST_TIMEOUT_MS;
  const dialTimeoutMs = Number(o.dialTimeoutMs) > 0 ? Number(o.dialTimeoutMs) : 8000;
  const pairWindowMs = Number(o.pairWindowMs) > 0 ? Number(o.pairWindowMs) : protocol.PAIR_WINDOW_MS;

  /* ---- v0.7 "fabric" knobs, all injectable so the tests stay on loopback ---- */

  /** The sha256 → path index this hub serves and consults. */
  const assets = o.assets || assetsMod.createAssetIndex(o.dataDir || config.dataDir());
  /** ip → Promise<mac|null>. The real one reads /proc/net/arp or `arp -a`. */
  const arpLookup = typeof o.arpLookup === "function" ? o.arpLookup : (ip) => arp.lookup(ip);
  /** Where WOL packets go. 255.255.255.255 in life, 127.0.0.1 in tests. */
  const wolAddress = o.wolAddress || wol.BROADCAST_ADDRESS;
  const wolPorts = Array.isArray(o.wolPorts) && o.wolPorts.length ? o.wolPorts : wol.WOL_PORTS;
  const assetFindMs = Number(o.assetFindMs) > 0 ? Number(o.assetFindMs) : assetsMod.FIND_TIMEOUT_MS;
  const probeTimeoutMs = Number(o.probeTimeoutMs) > 0 ? Number(o.probeTimeoutMs) : PROBE_TIMEOUT_MS;
  const stopWaitMs = Number.isFinite(o.stopWaitMs) ? Math.max(0, Number(o.stopWaitMs)) : STOP_WAIT_MS;
  /** The connector bus, for the polite half of a remote stop. Lazy: a hub
   *  without one (a unit test, a build without the bus) just goes to SIGTERM. */
  let connectorMod = o.connector === undefined ? undefined : o.connector;
  function bus() {
    if (connectorMod !== undefined) return connectorMod;
    try {
      // eslint-disable-next-line global-require
      connectorMod = require("../connector");
    } catch (_) {
      connectorMod = null;
    }
    return connectorMod;
  }
  /** process.kill, injectable — a test must never SIGTERM a real pid. */
  const kill = typeof o.kill === "function" ? o.kill : (pid, sig) => process.kill(pid, sig);

  /** peerId -> Session (at most one, by construction) */
  const sessions = new Map();
  /** peerId -> the last `summary` payload it pushed */
  const summaries = new Map();
  /** rid -> {peerId, resolve, reject, timer} for requests WE sent */
  const inflight = new Map();
  /** jobId -> {peerId, rid} for jobs a PEER asked us to run */
  const jobOwners = new Map();
  /** v0.7: rid -> (session, payload) => void, for the broadcast asset queries
   *  (which are one-to-many and therefore not `inflight` requests) */
  const assetQueries = new Map();
  /** peers we are currently dialling, so the retry loop cannot pile up */
  const dialing = new Set();
  /** peers whose dial already failed once — log the noise only the first time */
  const dialFailed = new Set();

  let pairing = null; // {code, expiresAt, timer}
  let lastSummary = null;
  let lastSummaryHash = null;
  let summaryTimer = null;
  let dialTimer = null;
  let changeTimer = null;
  let closed = false;
  let ridCounter = 0;

  const localChangeListeners = new Set();

  function local() {
    const data = store.read();
    return {
      id: data.id || identity.id,
      name: data.name || identity.name || String(os.hostname() || "nx-hub"),
      port: server ? server.port : protocol.FLEET_PORT,
      hubVersion,
    };
  }

  /* ---------------- events ---------------- */

  function fireChange() {
    safely(emit, { type: "fleet-changed" });
    for (const cb of Array.from(localChangeListeners)) safely(cb);
  }

  function notifyChange() {
    if (closed) return;
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      fireChange();
    }, CHANGE_MIN_MS);
    if (changeTimer.unref) changeTimer.unref();
  }

  /* ---------------- local summary ---------------- */

  function buildLocalSummary() {
    const me = local();
    let apps = [];
    try {
      apps = (discovery && discovery.getCached && discovery.getCached().apps) || [];
    } catch (e) {
      log(`fleet: could not read the app model — ${e.message}`);
    }
    return protocol.buildSummary(apps, { hubVersion, name: me.name, id: me.id });
  }

  /** Rebuild; push to every session when the fingerprint moved. */
  function pushSummary({ force = false } = {}) {
    if (closed) return null;
    const summary = buildLocalSummary();
    const hash = protocol.summaryHash(summary);
    const changed = hash !== lastSummaryHash;
    lastSummary = summary;
    lastSummaryHash = hash;
    if (!changed && !force) return summary;
    for (const session of sessions.values()) {
      if (session.alive) session.send(summary);
    }
    return summary;
  }

  /* ---------------- sessions ---------------- */

  function adopt(session) {
    const existing = sessions.get(session.peerId);
    if (existing && existing !== session) {
      // Latest wins. Detach first so the old session's teardown cannot delete
      // the entry we are about to write.
      existing.onClose = noop;
      existing.close(frame.CLOSE_NORMAL, "superseded");
      sessions.delete(session.peerId);
    }
    sessions.set(session.peerId, session);
    dialFailed.delete(session.peerId);
    session.onPayload = (payload) => onPayload(session, payload);
    session.onClose = (reason) => {
      if (sessions.get(session.peerId) === session) sessions.delete(session.peerId);
      failInflightFor(session.peerId, `the session with ${session.peerName} ended (${reason})`);
      log(`fleet: session with ${session.peerName} closed — ${reason}`);
      notifyChange();
    };
    store.touchPeer(session.peerId, { host: session.host, name: session.peerName, lastSeen: Date.now() });
    // A fresh session starts with the truth on both sides: BOTH ends adopt,
    // so both push their summary and neither has to ask.
    session.send(lastSummary || buildLocalSummary());
    captureMac(session);
    notifyChange();
    return session;
  }

  /**
   * v0.7: learn the peer's MAC while it is awake.
   *
   * Fire-and-forget on purpose — it takes up to two 2s retries when the ARP
   * entry is still INCOMPLETE, and nothing in the session may wait on that.
   * Runs on EVERY session, whichever side dialled, so a peer that changed NIC
   * (or moved to a new address) corrects itself the next time it connects.
   */
  function captureMac(session) {
    const ip = protocol.normalizeHost(session.host);
    if (!ip) return;
    Promise.resolve()
      .then(() => arpLookup(ip))
      .then((mac) => {
        if (closed || !arp.isMac(mac)) return;
        const before = store.getPeer(session.peerId);
        if (before && before.mac === mac) return;
        // touchPeer refuses to clear a mac, so a later failed lookup can never
        // undo this — see store.js.
        store.touchPeer(session.peerId, { mac });
        log(`fleet: ${session.peerName} is ${mac} (${ip}) — wake-on-LAN is available`);
        notifyChange();
      })
      .catch((e) => log(`fleet: could not read ${session.peerName}'s MAC — ${e.message}`));
  }

  async function ensureSession(peerId) {
    const live = sessions.get(peerId);
    if (live && live.alive) return live;
    const peer = store.getPeer(peerId);
    if (!peer) throw new Error(`No paired hub with id ${peerId}.`);
    return dialPeer(peer, { force: true });
  }

  /** Where a peer is right now: a fresh beacon beats what fleet.json remembers. */
  function addressFor(peer) {
    const heard = beacon ? beacon.get(peer.id) : null;
    if (heard && beacon.isFresh(peer.id)) return { host: heard.host, port: heard.port };
    return { host: peer.host, port: peer.port };
  }

  async function dialPeer(peer, { force = false } = {}) {
    if (closed) throw new Error("fleet: shutting down");
    if (dialing.has(peer.id)) throw new Error(`Already connecting to ${peer.name}.`);
    const me = local();
    if (!force && !protocol.shouldDial(me.id, peer.id)) {
      throw new Error(`${peer.name} dials this hub, not the other way round.`);
    }
    dialing.add(peer.id);
    const where = addressFor(peer);
    try {
      const session = await client.connect({
        host: where.host,
        port: where.port,
        localId: me.id,
        peer,
        timeoutMs: dialTimeoutMs,
        log,
      });
      log(`fleet: connected to ${peer.name} at ${where.host}:${where.port}`);
      return adopt(session);
    } finally {
      dialing.delete(peer.id);
    }
  }

  /** The background arbitration loop: dial every peer this hub is meant to. */
  function dialSweep() {
    if (closed) return;
    const me = local();
    for (const peer of store.peers()) {
      if (sessions.has(peer.id)) continue;
      if (dialing.has(peer.id)) continue;
      if (!protocol.shouldDial(me.id, peer.id)) continue;
      // Only chase a peer we have actually heard from, unless we have never
      // heard from it at all (first run after pairing, beacons still pending).
      const heard = beacon ? beacon.get(peer.id) : null;
      if (heard && !beacon.isFresh(peer.id)) continue;
      dialPeer(peer).catch((e) => {
        if (!dialFailed.has(peer.id)) {
          dialFailed.add(peer.id);
          log(`fleet: could not reach ${peer.name} — ${e.message}`);
        }
      });
    }
  }

  /* ---------------- requests ---------------- */

  function nextRid() {
    ridCounter += 1;
    return `r${ridCounter}-${Date.now().toString(36)}`;
  }

  function failInflightFor(peerId, message) {
    for (const [rid, entry] of Array.from(inflight.entries())) {
      if (entry.peerId !== peerId) continue;
      inflight.delete(rid);
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
  }

  async function request(peerId, payload, { timeoutMs } = {}) {
    const session = await ensureSession(peerId);
    const rid = nextRid();
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(rid);
        reject(new Error(`${session.peerName} did not answer in time.`));
      }, waitMs);
      if (timer.unref) timer.unref();
      inflight.set(rid, { peerId, resolve, reject, timer });
      if (!session.send(Object.assign({ rid }, payload))) {
        inflight.delete(rid);
        clearTimeout(timer);
        reject(new Error(`Could not reach ${session.peerName}.`));
      }
    });
  }

  /* ---------------- inbound payloads ---------------- */

  function onPayload(session, payload) {
    switch (payload.type) {
      case "summary":
        summaries.set(session.peerId, payload);
        store.touchPeer(session.peerId, { name: payload.name, lastSeen: Date.now() });
        notifyChange();
        return;
      case "get-summary":
        session.send(lastSummary || buildLocalSummary());
        return;
      case "install":
        return onRemoteInstall(session, payload);
      case "launch":
        return onRemoteLaunch(session, payload);
      case "update-all":
        return onRemoteUpdateAll(session, payload);
      case "ack":
        return onAck(session, payload);
      case "job-event":
        return onJobEvent(session, payload);
      // ---- v0.7 "fabric" ----
      case "probe":
        return onProbe(session, payload);
      case "probe-result":
        return onProbeResult(session, payload);
      case "stop":
        return onRemoteStop(session, payload);
      case "asset-query":
        return onAssetQuery(session, payload);
      case "asset-have":
        return onAssetHave(session, payload);
      default:
        // Forward compatibility: a newer peer's verb earns a complaint, not a
        // hangup — the session is authenticated, so it is a version gap.
        session.send({ type: "ack", rid: payload.rid || null, ok: false, error: `unknown request: ${payload.type}` });
        return;
    }
  }

  function ack(session, rid, body) {
    session.send(Object.assign({ type: "ack", rid: rid || null }, body));
  }

  /**
   * Resolve {appId, artifactId} against THIS hub's discovery model — the
   * remote side validates, never the requester. A peer can only ask for
   * something that already exists here; there is no path from the wire to an
   * arbitrary path, URL or command.
   */
  function resolveTarget(appId, artifactId) {
    let apps = [];
    try {
      apps = (discovery && discovery.getCached && discovery.getCached().apps) || [];
    } catch (_) {
      apps = [];
    }
    const app = apps.find((a) => a && a.id === String(appId || ""));
    if (!app) throw new Error(`No app called "${appId}" on this hub.`);
    const artifacts = app.artifacts || [];
    if (artifactId) {
      const artifact = artifacts.find((a) => a && a.id === String(artifactId));
      if (!artifact) throw new Error(`${app.name} has no download called "${artifactId}".`);
      return { app, artifact };
    }
    const host = hostPlatform();
    const eligible = artifacts.filter((a) => a && (a.platform === host || a.platform === "android"));
    if (eligible.length === 1) return { app, artifact: eligible[0] };
    if (!eligible.length) throw new Error(`${app.name} has nothing installable on that hub.`);
    throw new Error(`${app.name} has ${eligible.length} downloads — name one.`);
  }

  function onRemoteInstall(session, payload) {
    if (!jobs) return ack(session, payload.rid, { ok: false, error: "this hub cannot run jobs" });
    let target;
    try {
      target = resolveTarget(payload.appId, payload.artifactId);
    } catch (e) {
      return ack(session, payload.rid, { ok: false, error: e.message });
    }
    try {
      const jobId = jobs.install(target.app.id, target.artifact.id);
      jobOwners.set(jobId, { peerId: session.peerId, rid: payload.rid || null });
      log(`fleet: ${session.peerName} queued install ${target.app.id}/${target.artifact.id} (job ${jobId})`);
      return ack(session, payload.rid, {
        ok: true,
        jobId,
        appId: target.app.id,
        artifactId: target.artifact.id,
        appName: target.app.name,
      });
    } catch (e) {
      return ack(session, payload.rid, { ok: false, error: e.message });
    }
  }

  function onRemoteLaunch(session, payload) {
    if (!jobs) return ack(session, payload.rid, { ok: false, error: "this hub cannot run jobs" });
    let target;
    try {
      target = resolveTarget(payload.appId, payload.artifactId);
    } catch (e) {
      return ack(session, payload.rid, { ok: false, error: e.message });
    }
    Promise.resolve()
      .then(() => jobs.launch(target.app.id, target.artifact.id))
      .then(() => {
        log(`fleet: ${session.peerName} launched ${target.app.id}/${target.artifact.id}`);
        ack(session, payload.rid, { ok: true, launched: true, appId: target.app.id, artifactId: target.artifact.id });
      })
      .catch((e) => ack(session, payload.rid, { ok: false, error: e.message }));
    return undefined;
  }

  function onRemoteUpdateAll(session, payload) {
    if (!jobs) return ack(session, payload.rid, { ok: false, error: "this hub cannot run jobs" });
    let apps = [];
    try {
      apps = (discovery && discovery.getCached && discovery.getCached().apps) || [];
    } catch (_) {
      apps = [];
    }
    const jobIds = [];
    const failures = [];
    for (const app of apps) {
      for (const artifact of app.artifacts || []) {
        if (!artifact || !artifact.updateAvailable) continue;
        try {
          const jobId = jobs.install(app.id, artifact.id);
          jobOwners.set(jobId, { peerId: session.peerId, rid: payload.rid || null });
          jobIds.push({ jobId, appId: app.id, artifactId: artifact.id, appName: app.name });
        } catch (e) {
          failures.push(`${app.id}/${artifact.id}: ${e.message}`);
        }
      }
    }
    log(`fleet: ${session.peerName} queued update-all (${jobIds.length} job(s))`);
    return ack(session, payload.rid, { ok: true, jobIds, count: jobIds.length, failures });
  }

  /* ---------------- v0.7: probe · stop · assets ---------------- */

  /**
   * `probe {rid, port}` — a health gate on a PEERED stack step.
   *
   * The gate has to run on the remote, because "is 9757 open" means "open on
   * the machine the app is actually running on". We connect to 127.0.0.1 and
   * nowhere else: this is a health check for a service the remote hub just
   * launched, never a port scanner a peer can aim at its LAN.
   */
  function onProbe(session, payload) {
    const port = Number(payload.port);
    const rid = payload.rid || null;
    const reply = (open) => session.send({ type: "probe-result", rid, port, open: Boolean(open) });
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return reply(false);
    const timeoutMs = Number(payload.timeoutMs) > 0 ? Math.min(Number(payload.timeoutMs), 30000) : probeTimeoutMs;

    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      reply(open);
    };
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    return undefined;
  }

  /** The answer to OUR probe. Resolves the inflight promise with a bare bool. */
  function onProbeResult(session, payload) {
    const entry = payload.rid ? inflight.get(payload.rid) : null;
    if (!entry) return;
    inflight.delete(payload.rid);
    clearTimeout(entry.timer);
    entry.resolve(Boolean(payload.open));
  }

  /** Every pid this hub is watching for `appId` (jobs' launch tracking). */
  function trackedPidsFor(appId) {
    const table = jobs && jobs._tracked;
    if (!table || typeof table.values !== "function") return [];
    const pids = [];
    for (const entry of table.values()) {
      if (entry && entry.appId === appId && Number.isInteger(entry.pid)) pids.push(entry.pid);
    }
    return pids;
  }

  function sigterm(pid) {
    try {
      // Never SIGKILL — a fleet stop is as polite as a local one (SPEC v0.5).
      kill(pid, "SIGTERM");
      return true;
    } catch (_) {
      return false; // already gone, or not ours to signal
    }
  }

  /** Wait for the bus to stop seeing `appId`, up to `ms`. */
  async function waitForDeparture(appId, ms) {
    const c = bus();
    if (!c || typeof c.isPresent !== "function") return false;
    const deadline = Date.now() + ms;
    for (;;) {
      if (!c.isPresent(appId)) return true;
      if (Date.now() >= deadline) return false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const t = setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now())));
        if (t.unref) t.unref();
      });
    }
  }

  /**
   * `stop {rid, appId}` — the peered half of `stacks.stop` (SPEC v0.7).
   *
   * Same two-step dance the local stop does, for the same reason: an app that
   * speaks the NX Connector bus can save its state, so it gets asked first and
   * signalled only if it does not go. The pid comes from jobs' own launch
   * tracking, so a peer can only stop something THIS hub started — there is no
   * path from the wire to an arbitrary pid.
   */
  async function onRemoteStop(session, payload) {
    const appId = String(payload.appId || "").trim();
    if (!appId) return ack(session, payload.rid, { ok: false, error: "stop needs an appId" });

    let how = null;
    const c = bus();
    try {
      if (c && typeof c.isPresent === "function" && c.isPresent(appId) && typeof c.requestShutdown === "function") {
        if (c.requestShutdown(appId)) {
          how = (await waitForDeparture(appId, stopWaitMs)) ? "shutdown-request" : null;
        }
      }
    } catch (e) {
      log(`fleet: requestShutdown(${appId}) failed — ${e.message}`);
      how = null;
    }

    const pids = trackedPidsFor(appId);
    if (!how) {
      const signalled = pids.filter((pid) => sigterm(pid));
      how = signalled.length ? "sigterm" : "gone";
    }
    log(`fleet: ${session.peerName} stopped ${appId} (${how})`);
    return ack(session, payload.rid, { ok: true, appId, how, pids });
  }

  /**
   * `asset-query {rid, sha256}` — "do you have these bytes?"
   *
   * Answered either way, `have:false` included: findAsset counts the noes so a
   * fleet where nobody has the file gives up immediately instead of burning
   * the full 800ms budget before every single GitHub download.
   */
  function onAssetQuery(session, payload) {
    const sha = assetsMod.normalizeSha(payload.sha256);
    const rid = payload.rid || null;
    if (!sha) return session.send({ type: "asset-have", rid, sha256: null, have: false });
    const entry = assets ? assets.get(sha) : null;
    return session.send({
      type: "asset-have",
      rid,
      sha256: sha,
      have: Boolean(entry),
      size: entry ? entry.size : 0,
    });
  }

  /** An answer to one of OUR asset queries. */
  function onAssetHave(session, payload) {
    const handler = payload.rid ? assetQueries.get(payload.rid) : null;
    if (handler) handler(session, payload);
  }

  /**
   * Ask every live peer at once and take the first yes (SPEC: within 800ms).
   *
   * Broadcast rather than sequential: on a fleet of five, asking one at a time
   * would cost five timeouts before a download that GitHub would have finished
   * by then. The budget is a hard ceiling — a slow fleet costs the user 0.8s
   * once, never a stalled install.
   *
   * @returns {Promise<{peerId, peerName, size}|null>}
   */
  function findAsset(sha256, { timeoutMs = assetFindMs } = {}) {
    const sha = assetsMod.normalizeSha(sha256);
    return new Promise((resolve) => {
      if (closed || !sha) return resolve(null);
      const live = Array.from(sessions.values()).filter((s) => s.alive);
      if (!live.length) return resolve(null);

      const rid = nextRid();
      let settled = false;
      let outstanding = live.length;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        assetQueries.delete(rid);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (timer.unref) timer.unref();

      assetQueries.set(rid, (session, payload) => {
        if (payload.sha256 && payload.sha256 !== sha) return;
        if (payload.have) {
          finish({ peerId: session.peerId, peerName: session.peerName, size: Number(payload.size) || 0 });
          return;
        }
        outstanding -= 1;
        if (outstanding <= 0) finish(null);
      });

      for (const session of live) {
        if (!session.send({ type: "asset-query", rid, sha256: sha })) outstanding -= 1;
      }
      if (outstanding <= 0) finish(null);
      return undefined;
    });
  }

  /**
   * Pull one asset off a peer over the authed HTTP route.
   *
   * The peer is resolved to a host/port/secret HERE rather than in the caller:
   * jobs.js has no business holding a pairing secret, and findAsset's return
   * value deliberately carries none.
   */
  async function fetchAsset(sha256, destPath, opts = {}) {
    const sha = assetsMod.normalizeSha(sha256);
    if (!sha) throw new Error("fleet: not a sha256");
    const found = opts.peer && opts.peer.peerId ? opts.peer : await findAsset(sha, opts);
    if (!found) throw new Error("fleet: no peer has that file");
    const peer = store.getPeer(found.peerId);
    if (!peer || !peer.secret) throw new Error("fleet: that peer is not paired any more");
    const where = addressFor(peer);
    const session = sessions.get(peer.id);
    const result = await assetsMod.fetchAsset({
      // A live session knows the address the peer is ACTUALLY answering on,
      // which beats both the beacon and fleet.json when a DHCP lease moved.
      host: (session && session.alive && session.host) || where.host,
      port: where.port,
      sha256: sha,
      secret: peer.secret,
      destPath,
      onProgress: opts.onProgress,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    log(`fleet: fetched ${sha.slice(0, 12)}… (${result.size} bytes) from ${found.peerName || peer.name}`);
    return Object.assign({ peerId: peer.id, peerName: found.peerName || peer.name }, result);
  }

  /* ---------------- v0.7: wake-on-LAN ---------------- */

  /**
   * Send the magic packets for a peer's stored MAC.
   *
   * @returns {Promise<boolean>} whether the packets left this host. It is NOT
   *          a claim that the peer woke — nothing on this side can know that,
   *          which is what the `peer-online` gate is for.
   */
  function wake(peerId) {
    const peer = store.getPeer(String(peerId || ""));
    if (!peer) {
      log(`fleet: cannot wake ${peerId} — not a paired hub`);
      return Promise.resolve(false);
    }
    if (!peer.mac) {
      log(`fleet: cannot wake ${peer.name} — no MAC learned yet (connect to it once while it is awake)`);
      return Promise.resolve(false);
    }
    log(`fleet: waking ${peer.name} (${peer.mac})`);
    return wol.wake(peer.mac, { address: wolAddress, ports: wolPorts, log });
  }

  function onAck(session, payload) {
    const entry = payload.rid ? inflight.get(payload.rid) : null;
    if (!entry) return;
    inflight.delete(payload.rid);
    clearTimeout(entry.timer);
    if (payload.ok === false) entry.reject(new Error(payload.error || `${session.peerName} refused the request.`));
    else entry.resolve(Object.assign({ peerId: session.peerId }, payload, { type: undefined }));
  }

  /** A relayed job event from the hub that is doing the work for us. */
  function onJobEvent(session, payload) {
    safely(emit, {
      type: "fleet-progress",
      peerId: session.peerId,
      peerName: session.peerName,
      rid: payload.rid || null,
      jobId: payload.jobId || null,
      event: payload.event || "job-progress",
      appId: payload.appId || null,
      artifactId: payload.artifactId || null,
      appName: payload.appName || null,
      // Terminal events carry no phase of their own — synthesize one so the
      // renderer clears its row immediately instead of via staleness.
      phase:
        payload.phase ||
        (payload.event === "job-done" ? "done" : payload.event === "job-error" ? "error" : null),
      pct: typeof payload.pct === "number" ? payload.pct : null,
      message: payload.message || "",
    });
  }

  /**
   * The hub's own event fan-out, piped in from index.js. Only the jobs a PEER
   * asked for are relayed — everything else on the bus is none of their
   * business.
   */
  function onHubEvent(evt) {
    if (closed || !evt || !evt.jobId) return;
    if (evt.type !== "job-progress" && evt.type !== "job-done" && evt.type !== "job-error") return;
    const owner = jobOwners.get(evt.jobId);
    if (!owner) return;
    const session = sessions.get(owner.peerId);
    if (session && session.alive) {
      session.send({
        type: "job-event",
        rid: owner.rid,
        jobId: evt.jobId,
        event: evt.type,
        appId: evt.appId || null,
        artifactId: evt.artifactId || null,
        appName: evt.appName || null,
        phase: evt.phase || null,
        pct: typeof evt.pct === "number" ? evt.pct : null,
        message: evt.message || "",
      });
    }
    if (evt.type === "job-done" || evt.type === "job-error") jobOwners.delete(evt.jobId);
  }

  /* ---------------- pairing ---------------- */

  /** Arm the 120s window and return the code the human has to type. */
  function showCode() {
    if (pairing && pairing.timer) clearTimeout(pairing.timer);
    const code = protocol.newCode();
    const expiresAt = Date.now() + pairWindowMs;
    pairing = { code, expiresAt, timer: null };
    pairing.timer = setTimeout(() => {
      if (pairing && pairing.code === code) pairing = null;
      notifyChange();
    }, pairWindowMs);
    if (pairing.timer.unref) pairing.timer.unref();
    safely(emit, { type: "fleet-pair-code", code, expiresAt });
    log("fleet: pairing window open for 120s");
    return { code, expiresAt };
  }

  /** The window as the server sees it — expired windows read as closed. */
  function activeCode() {
    if (!pairing) return null;
    if (pairing.expiresAt <= Date.now()) {
      pairing = null;
      return null;
    }
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  async function pair(host, code, port) {
    const me = local();
    const target = Number(port) > 0 ? Number(port) : protocol.FLEET_PORT;
    const peer = await client.pairWith({
      host: String(host || "").trim(),
      port: target,
      code: String(code || "").trim(),
      localId: me.id,
      localName: me.name,
      localPort: me.port,
      timeoutMs: dialTimeoutMs,
    });
    if (peer.id === me.id) throw new Error("That is this very hub — pair two different machines.");
    store.upsertPeer(peer);
    log(`fleet: paired with ${peer.name} (${peer.id}) at ${peer.host}:${peer.port}`);
    notifyChange();
    // Bring the session up straight away rather than waiting for the sweep —
    // but only from the side arbitration says should dial; the other hub's own
    // beacon handler is already on its way to us.
    if (protocol.shouldDial(me.id, peer.id)) dialPeer(store.getPeer(peer.id)).catch(() => {});
    return peer;
  }

  function unpair(id) {
    const peerId = String(id || "");
    const session = sessions.get(peerId);
    if (session) {
      session.onClose = noop;
      session.close(frame.CLOSE_NORMAL, "unpaired");
      sessions.delete(peerId);
    }
    summaries.delete(peerId);
    const removed = store.removePeer(peerId);
    if (removed) log(`fleet: unpaired ${peerId}`);
    notifyChange();
    return removed;
  }

  /* ---------------- public reads ---------------- */

  function getPeers({ now = Date.now() } = {}) {
    // fleet.json is re-read per call, never per peer — this runs on every
    // getFleet() and the renderer polls it.
    const data = store.load();
    const myId = data.id;
    return data.peers.map((peer) => {
      const session = sessions.get(peer.id);
      const heard = beacon ? beacon.get(peer.id) : null;
      const beaconFresh = Boolean(beacon && beacon.isFresh(peer.id, now));
      const summary = summaries.get(peer.id) || null;
      const lastSeen = Math.max(
        session && session.alive ? session.lastSeen : 0,
        heard ? heard.at : 0,
        peer.lastSeen || 0
      );
      return {
        id: peer.id,
        name: (heard && heard.name) || peer.name,
        host: (heard && heard.host) || peer.host,
        port: (heard && heard.port) || peer.port,
        // SPEC: online = a live session OR a beacon inside the 15s window
        online: Boolean((session && session.alive) || beaconFresh),
        connected: Boolean(session && session.alive),
        beacon: beaconFresh,
        // v0.7: null until a session taught us one. The UI shows "wake" only
        // when this is set, because that is exactly when wake() can work.
        mac: peer.mac || null,
        hubVersion: (summary && summary.hubVersion) || (heard && heard.hubVersion) || null,
        lastSeen: lastSeen || null,
        summary,
        apps: summary ? summary.apps.length : 0,
        updates: protocol.summaryUpdates(summary),
        // Which way arbitration falls, for anyone debugging a stuck session.
        dialsUs: !protocol.shouldDial(myId, peer.id),
      };
    });
  }

  /** Everything getFleet() reports, in one object. */
  function snapshot() {
    const me = local();
    return {
      id: me.id,
      name: me.name,
      port: me.port,
      hubVersion,
      peers: getPeers(),
      pairing: activeCode(),
      beaconPort: beacon ? beacon.port : null,
      summary: lastSummary || buildLocalSummary(),
    };
  }

  function onLocalChange(cb) {
    if (typeof cb !== "function") return noop;
    localChangeListeners.add(cb);
    return () => localChangeListeners.delete(cb);
  }

  /* ---------------- lifecycle ---------------- */

  const server = createServer({
    port: Number.isInteger(o.port) ? o.port : protocol.FLEET_PORT,
    host: o.host || "0.0.0.0",
    authGraceMs: o.authGraceMs,
    log,
    local,
    peers: () => store.peers(),
    pairCode: activeCode,
    // v0.7: the seeding route lives on this same listener (SPEC).
    assets,
    onPair: (peer) => {
      store.upsertPeer(peer);
      notifyChange();
      return peer;
    },
    onSession: (session) => adopt(session),
  });

  const beacon =
    o.beacon === false
      ? null
      : createBeacon({
          port: Number.isInteger(o.beaconPort) ? o.beaconPort : protocol.BEACON_PORT,
          sendPort: o.beaconSendPort,
          bindAddress: o.beaconBindAddress,
          broadcastAddress: o.beaconBroadcastAddress,
          broadcast: o.beaconBroadcast,
          intervalMs: o.beaconIntervalMs,
          ttlMs: o.beaconTtlMs,
          log,
          message: () => {
            const me = local();
            return { id: me.id, name: me.name, hubVersion, port: server.port };
          },
          onPeer: (entry) => {
            if (closed) return;
            const peer = store.getPeer(entry.id);
            if (!peer) return; // an unpaired neighbour is just noise until paired
            store.touchPeer(entry.id, { host: entry.host, port: entry.port, name: entry.name, persist: true });
            notifyChange();
            if (!sessions.has(entry.id) && protocol.shouldDial(local().id, entry.id)) {
              dialPeer(store.getPeer(entry.id)).catch(() => {});
            }
          },
        });

  const api = {
    id: identity.id,
    store,
    server,
    beacon,
    ready: null,
    getPeers,
    snapshot,
    showCode,
    activeCode,
    pair,
    unpair,
    onHubEvent,
    onLocalChange,
    pushSummary,
    buildLocalSummary,
    ensureSession,
    request,
    sessions,
    remoteInstall(peerId, appId, artifactId) {
      return request(peerId, { type: "install", appId, artifactId: artifactId || null });
    },
    remoteLaunch(peerId, appId, artifactId) {
      return request(peerId, { type: "launch", appId, artifactId: artifactId || null });
    },
    remoteUpdateAll(peerId) {
      return request(peerId, { type: "update-all" });
    },

    /* ---- v0.7 "fabric" — the surface stacks.js and jobs.js call ---- */

    wake,
    findAsset,
    fetchAsset,
    assetIndex: () => assets,
    /** Remember a verified file so peers can pull it (jobs.js calls this). */
    recordAsset: (sha256, filePath) => (assets ? assets.record(sha256, filePath) : null),
    /** Is any peer actually connected? The cheap guard before a findAsset. */
    hasOnlinePeers: () => Array.from(sessions.values()).some((s) => s.alive),

    /**
     * SPEC's `peer-online` health gate, and the implicit gate after a wake
     * step: same definition as getPeers().online — a live session OR a beacon
     * inside its 15s window — without the caller having to scan the list.
     */
    isPeerOnline(peerId, { now = Date.now() } = {}) {
      const id = String(peerId || "");
      const session = sessions.get(id);
      if (session && session.alive) return true;
      return Boolean(beacon && beacon.isFresh(id, now));
    },

    /**
     * A health gate for a peered stack step: is `port` open on the PEER's
     * loopback? Never throws — a gate wants a boolean, and "the peer is not
     * reachable" and "the port is shut" mean the same thing to a stack.
     */
    async probePeerPort(peerId, port, { timeoutMs = probeTimeoutMs } = {}) {
      try {
        const open = await request(
          peerId,
          { type: "probe", port: Number(port), timeoutMs },
          // A little slack over the remote's own connect timeout, so a shut
          // port comes back as `false` rather than as our timeout.
          { timeoutMs: timeoutMs + 2000 }
        );
        return open === true;
      } catch (e) {
        log(`fleet: probe of ${port} on ${peerId} failed — ${e.message}`);
        return false;
      }
    },

    /** Ask a peer to stop one app the way it would stop it locally. */
    remoteStop(peerId, appId) {
      return request(peerId, { type: "stop", appId: String(appId || "") });
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      if (summaryTimer) clearInterval(summaryTimer);
      if (dialTimer) clearInterval(dialTimer);
      if (changeTimer) clearTimeout(changeTimer);
      if (pairing && pairing.timer) clearTimeout(pairing.timer);
      summaryTimer = dialTimer = changeTimer = null;
      pairing = null;
      for (const [rid, entry] of Array.from(inflight.entries())) {
        inflight.delete(rid);
        clearTimeout(entry.timer);
        entry.reject(new Error("fleet: the hub is shutting down"));
      }
      // v0.7: a pending findAsset resolves null rather than hanging — the
      // caller's fallback (GitHub) is always the right answer at shutdown.
      assetQueries.clear();
      for (const session of Array.from(sessions.values())) {
        session.onClose = noop;
        session.close(frame.CLOSE_NORMAL, "hub closing");
      }
      sessions.clear();
      if (beacon) beacon.close();
      return server.close();
    },
  };

  api.ready = (async () => {
    const listening = await server.ready;
    const beaconReady = beacon ? await beacon.ready : { ok: false, skipped: true };
    if (!closed) {
      summaryTimer = setInterval(() => pushSummary(), summaryIntervalMs);
      if (summaryTimer.unref) summaryTimer.unref();
      dialTimer = setInterval(dialSweep, dialIntervalMs);
      if (dialTimer.unref) dialTimer.unref();
      lastSummary = buildLocalSummary();
      lastSummaryHash = protocol.summaryHash(lastSummary);
      dialSweep();
    }
    return { ok: listening.ok, port: server.port, beacon: beaconReady, id: identity.id };
  })();

  return api;
}

/* ------------------------------------------------------------------ */
/* module surface (frozen)                                             */
/* ------------------------------------------------------------------ */

/**
 * Start the fleet. A second call replaces the first. Never throws: a busy port
 * (a second hub on this machine) leaves an inert handle behind, exactly like
 * the connector.
 */
function init(o = {}) {
  if (current) {
    try {
      current.close();
    } catch (_) {
      /* ignore */
    }
    current = null;
  }
  let fleet;
  try {
    fleet = createFleet(o);
  } catch (e) {
    safely(o.log, `fleet: init failed — ${e.message}`);
    return { close: noop, ready: Promise.resolve({ ok: false, error: e }) };
  }
  current = fleet;
  return fleet;
}

function close() {
  if (!current) return Promise.resolve();
  const fleet = current;
  current = null;
  return fleet.close();
}

const passthrough = (name, fallback) => (...args) => {
  if (!current) return typeof fallback === "function" ? fallback() : fallback;
  return current[name](...args);
};

module.exports = {
  init,
  close,
  createFleet,
  protocol,
  createStore,
  client,
  arp,
  wol,
  assets: assetsMod,
  _current: () => current,
  getPeers: passthrough("getPeers", () => []),
  snapshot: passthrough("snapshot", () => null),
  showCode: () => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.showCode();
  },
  pair: (host, code, port) => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.pair(host, code, port);
  },
  unpair: passthrough("unpair", () => false),
  remoteInstall: (...a) => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.remoteInstall(...a);
  },
  remoteLaunch: (...a) => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.remoteLaunch(...a);
  },
  remoteUpdateAll: (...a) => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.remoteUpdateAll(...a);
  },
  onHubEvent: (evt) => {
    if (current) current.onHubEvent(evt);
  },
  onLocalChange: (cb) => (current ? current.onLocalChange(cb) : noop),

  /* ---- v0.7 "fabric" ------------------------------------------------ */

  /** Whether a fleet is actually up. jobs.js checks this before seeding. */
  isRunning: () => Boolean(current),
  hasOnlinePeers: passthrough("hasOnlinePeers", () => false),
  isPeerOnline: passthrough("isPeerOnline", () => false),
  /** WOL. False (never a throw) when the fleet is off or the mac is unknown. */
  wake: (peerId) => (current ? current.wake(peerId) : Promise.resolve(false)),
  probePeerPort: (...a) => (current ? current.probePeerPort(...a) : Promise.resolve(false)),
  remoteStop: (...a) => {
    if (!current) throw new Error("The fleet is switched off — turn it on in Settings.");
    return current.remoteStop(...a);
  },
  findAsset: (...a) => (current ? current.findAsset(...a) : Promise.resolve(null)),
  fetchAsset: (...a) => {
    if (!current) return Promise.reject(new Error("The fleet is switched off — turn it on in Settings."));
    return current.fetchAsset(...a);
  },
  /**
   * The seeding index is maintained whether or not the fleet is RUNNING: a hub
   * with the setting off still records what it verified, so switching the
   * fleet on later does not start from an empty index.
   */
  assetIndex: (dataDir) => (current && !dataDir ? current.assetIndex() : assetsMod.createAssetIndex(dataDir)),
  recordAsset: (sha256, filePath) =>
    current ? current.recordAsset(sha256, filePath) : assetsMod.createAssetIndex().record(sha256, filePath),

  SUMMARY_INTERVAL_MS,
  DIAL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  STOP_WAIT_MS,
};
