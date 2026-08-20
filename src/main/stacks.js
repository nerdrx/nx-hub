"use strict";
// NX Hub — stacks: "launch these apps, in this order, waiting for each to come
// up before starting the next" (SPEC "NX Connector → Stacks").
//
// Pure node, no electron. Every collaborator is injected through init():
//   jobs       — jobs.launch(appId, artifactId) → {pid, …} (the install engine's)
//   connector  — the bus module (isPresent / requestShutdown / onChange), or null
//   config     — the hub's config module (dataDir + atomic writes)
//   emit       — the event fan-out; every phase change goes through it
//   engine     — v0.6: the install engine, for engine.getAdbStatus() (triggers)
//   fleet      — v0.7: the cross-hub fabric, for peered steps (remoteLaunch,
//                probePeerPort, remoteStop, wake, getPeers)
//
// The connector is deliberately OPTIONAL: the hub has to work with no bus at
// all (the module may not even exist), so a `connector` health gate simply
// fails fast instead of hanging for its whole timeout. `engine` and `fleet` are
// optional in exactly the same way (object OR lazy factory): without the engine,
// adb-device triggers say "adb unavailable" once and stay dormant; without the
// fleet, a peered step fails fast with "the fleet is not available" instead of
// hanging — everything else, including running local stacks by hand, keeps
// working.
//
// SPEC v0.7 "Cross-hub stacks": a step may name a `peer`, and then EVERYTHING
// about it happens over there — jobs.launch becomes fleet.remoteLaunch, a port
// gate is probed on the remote loopback, and the stop is the remote's own
// polite dance. `action: "wake"` is the one step that starts nothing: it sends
// the peer a magic packet and waits for it to come online.

const net = require("net");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 250;
const SHUTDOWN_WAIT_MS = 5000;
/** SPEC v0.6: adb-device triggers poll engine.getAdbStatus every 10s. */
const ADB_POLL_MS = 10000;

const HEALTH_TYPES = ["connector", "port", "delay", "peer-online"];
/** SPEC v0.7: gates that can only mean something on a step that names a peer. */
const PEER_ONLY_HEALTH_TYPES = ["peer-online"];
/** SPEC v0.7: a step either starts something, or wakes the machine that will. */
const STEP_ACTIONS = ["launch", "wake"];
/** SPEC v0.7: a wake gates peer-online for two minutes — a cold boot is slow. */
const WAKE_TIMEOUT_MS = 120000;
/** How long ONE remote port probe may take before it counts as "not yet". */
const PROBE_TIMEOUT_MS = 1000;
/** The one sentence every peered step says when there is no fabric to talk to. */
const FLEET_MISSING = "the fleet is not available";
/** SPEC v0.6: a stack may arm itself on a device/app arriving. */
const TRIGGER_TYPES = ["adb-device", "connector-app"];
const TRIGGER_COOLDOWN_MS = 60000;
const TRIGGER_COOLDOWN_MIN_MS = 5000;
const TRIGGER_COOLDOWN_MAX_MS = 60 * 60 * 1000;
/** SPEC: phase ∈ launching|waiting|healthy|failed|done|stopping|stopped (+ v0.6 triggered) */
const PHASES = ["triggered", "launching", "waiting", "healthy", "failed", "done", "stopping", "stopped"];

let deps = {
  jobs: null,
  connector: null,
  config: null,
  emit: () => {},
  // optional: the discovery model, for resolving a step that names no artifact
  // (lazily required when not injected — tests hand over a fake)
  discovery: null,
  // optional: the install engine — only the trigger watcher needs it
  engine: null,
  // optional (v0.7): the fleet — only peered/wake steps need it
  fleet: null,
  timing: null,
};

/** The run in flight — {stackId, stepIndex, phase, …} — or null. */
let current = null;
/** The last finished run, so stop() can still reach what it started. */
let last = null;

function init(d = {}) {
  deps = Object.assign({}, deps, d);
  if (!deps.config) deps.config = require("./config");
  if (typeof deps.emit !== "function") deps.emit = () => {};
  // v0.6: a re-init rewires the collaborators, so the old watcher (holding the
  // OLD connector subscription and the OLD engine) is torn down first.
  watchEnabled = true;
  syncWatcher();
  return module.exports;
}

/** For tests: forget every run (the store on disk is untouched). */
function _reset() {
  stopWatcher();
  cooldowns.clear();
  warned.clear();
  watchEnabled = false;
  current = null;
  last = null;
}

function cfg() {
  return deps.config || require("./config");
}

function log(msg) {
  try {
    const c = cfg();
    if (typeof c.log === "function") c.log(`[stacks] ${msg}`);
  } catch (_) {
    /* logging must never break a run */
  }
}

/**
 * Sentences that are TRUE for as long as the hub runs — "this gate cannot work",
 * "that probe keeps failing". Said once: sanitizing happens on every read of the
 * store, and a gate polls four times a second, so plain log() would drown the
 * file in the same line. Cleared by _reset()/init(), exactly like the watcher.
 */
const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  if (warned.size > 200) warned.clear(); // never a leak, just a rate limit
  warned.add(msg);
  log(msg);
}

/**
 * The bus module, or null. Injected as an object OR as a factory, so index.js
 * can hand over a connector that only exists once the server booted.
 */
function connector() {
  const c = deps.connector;
  if (!c) return null;
  if (typeof c === "function") {
    try {
      return c() || null;
    } catch (_) {
      return null;
    }
  }
  return c;
}

function isPresent(appId) {
  const c = connector();
  if (!c || typeof c.isPresent !== "function") return false;
  try {
    return Boolean(c.isPresent(appId));
  } catch (_) {
    return false;
  }
}

function requestShutdown(appId) {
  const c = connector();
  if (!c || typeof c.requestShutdown !== "function") return false;
  try {
    return Boolean(c.requestShutdown(appId));
  } catch (e) {
    log(`requestShutdown(${appId}) failed: ${e.message}`);
    return false;
  }
}

/**
 * The install engine, or null. Injected as an object OR as a factory, exactly
 * like the connector — index.js may only have it once the engines module is up.
 */
function engineMod() {
  const e = deps.engine;
  if (!e) return null;
  if (typeof e === "function") {
    try {
      return e() || null;
    } catch (_) {
      return null;
    }
  }
  return e;
}

/**
 * The fleet module, or null. Object OR lazy factory, like the connector: the
 * fabric may be switched off in settings, and index.js only has it once the
 * fleet server booted.
 */
function fleetMod() {
  const f = deps.fleet;
  if (!f) return null;
  if (typeof f === "function") {
    try {
      return f() || null;
    } catch (_) {
      return null;
    }
  }
  return f;
}

/** The fleet, or the one error every peered step raises without it. */
function requireFleet() {
  const f = fleetMod();
  if (!f) throw new Error(FLEET_MISSING);
  return f;
}

/** The stored peer record for an id, or null. Never throws at the caller. */
function peerRecord(peerId) {
  const f = fleetMod();
  if (!f || typeof f.getPeers !== "function" || !peerId) return null;
  let peers = [];
  try {
    peers = f.getPeers() || [];
  } catch (e) {
    warnOnce(`fleet.getPeers failed: ${e.message}`);
    return null;
  }
  if (!Array.isArray(peers)) return null;
  return peers.find((p) => p && String(p.id) === String(peerId)) || null;
}

/**
 * SPEC v0.7: a step's peer is resolved at RUN time, never at save time — pairing
 * (and un-pairing) happens under a stored stack, exactly like installs do.
 */
function requirePeer(peerId) {
  const peer = peerRecord(peerId);
  if (!peer) throw new Error(`Unknown fleet peer "${peerId}"`);
  return peer;
}

/** What a human calls that peer: its name while we know it, else the raw id. */
function peerLabel(peerId) {
  const peer = peerRecord(peerId);
  return (peer && String(peer.name || "").trim()) || String(peerId || "the peer");
}

/** Is that peer's session/beacon alive right now? */
function isPeerOnline(peerId) {
  const peer = peerRecord(peerId);
  return Boolean(peer && peer.online);
}

/**
 * v0.10 [fabric2]: is `appId` on THAT peer's connector bus?
 *
 * SPEC "Bus federation": every hub pushes its bus roster over the fleet, so a
 * `connector` gate on a peered step is answerable from here — it checks the
 * app's presence in the roster the NAMED peer relayed, never in any other
 * peer's and never in this hub's own bus. A hub whose fleet predates v0.10
 * simply never relays one, so the gate reads "not yet" and times out with the
 * usual sentence instead of passing on a hub that cannot see anything.
 */
function isPresentOnPeer(peerId, appId) {
  const f = fleetMod();
  if (!f || typeof f.getRemoteClients !== "function" || !peerId) return false;
  let rosters = [];
  try {
    rosters = f.getRemoteClients() || [];
  } catch (e) {
    warnOnce(`fleet.getRemoteClients failed: ${e.message}`);
    return false;
  }
  if (!Array.isArray(rosters)) return false;
  const entry = rosters.find((r) => r && String(r.peerId) === String(peerId));
  if (!entry || !Array.isArray(entry.clients)) return false;
  const wanted = String(appId == null ? "" : appId).trim().toLowerCase();
  if (!wanted) return false;
  return entry.clients.some((c) => c && String(c.app == null ? "" : c.app).trim().toLowerCase() === wanted);
}

/** The sentence inside a nack, whatever the remote called the field. */
function ackError(ack) {
  if (!ack || typeof ack !== "object") return null;
  const msg = ack.error || ack.message || ack.reason;
  return msg ? String(msg) : null;
}

function timing() {
  const t = deps.timing || {};
  return {
    pollMs: Number(t.pollMs) > 0 ? Number(t.pollMs) : POLL_MS,
    shutdownWaitMs: Number(t.shutdownWaitMs) >= 0 ? Number(t.shutdownWaitMs) : SHUTDOWN_WAIT_MS,
    // v0.6: how often the adb-device watcher asks the engine who is plugged in
    adbPollMs: Number(t.adbPollMs) > 0 ? Number(t.adbPollMs) : ADB_POLL_MS,
    // v0.7: how long ONE remote port probe may take before it counts as "not yet"
    probeTimeoutMs: Number(t.probeTimeoutMs) > 0 ? Number(t.probeTimeoutMs) : PROBE_TIMEOUT_MS,
  };
}

/* ------------------------------------------------------------------ */
/* the model: sanitizing whatever the renderer / a hand-edited file says */
/* ------------------------------------------------------------------ */

/** "My VR Stack!" → "my-vr-stack" — ordinal, locale-independent. */
function slugify(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function clampTimeout(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n), MAX_TIMEOUT_MS);
}

function sanitizePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * A step's health rule. Junk in → a usable rule out, or null when the rule
 * cannot mean anything (a `port` gate with no port is not a gate).
 * No rule at all → "launch it and move on" (delay 0), never a silent 30s wait.
 *
 * `peered` (v0.7) is what the SAME rule means on a step that runs somewhere
 * else: `peer-online` becomes possible, and a mistake drops to delay — the
 * file's standing answer to "that gate cannot mean anything": the step still
 * runs, it just is not waited on.
 *
 * v0.10 [fabric2]: a `connector` gate on a peered step is now VALID. It used to
 * be rewritten to delay because the remote's bus was invisible from here; bus
 * federation makes it visible, so the gate means what it always should have —
 * "wait until that app announces itself on THAT hub's bus" — and is answered
 * from the peer's relayed roster (see isPresentOnPeer).
 */
function sanitizeHealth(raw, peered = false) {
  const h = raw && typeof raw === "object" ? raw : {};
  let type = HEALTH_TYPES.includes(String(h.type)) ? String(h.type) : null;
  if (PEER_ONLY_HEALTH_TYPES.includes(type) && !peered) {
    warnOnce(`a ${type} gate needs a step with a peer — dropped to delay`);
    type = null;
  }
  if (!type) return { type: "delay", timeoutMs: 0 };
  const out = { type, timeoutMs: clampTimeout(h.timeoutMs, type === "delay" ? 0 : DEFAULT_TIMEOUT_MS) };
  if (type === "port") {
    const port = sanitizePort(h.port);
    if (port == null) return null; // unusable — the step gets dropped
    out.port = port;
  }
  return out;
}

/**
 * SPEC v0.7: a fleet peer id, trimmed and VERBATIM — peer ids are opaque
 * identity strings, so slugifying one would quietly point the step at nothing.
 * Objects and arrays are not ids ("[object Object]" is not a peer).
 */
function sanitizePeer(value) {
  if (value == null || typeof value === "object" || typeof value === "boolean") return null;
  const id = String(value).trim().slice(0, 128);
  return id || null;
}

/**
 * SPEC v0.7 steps:
 *   local  — {appId, artifactId?, health, optional}          (unchanged)
 *   peered — the same, plus `peer`: launched, gated and stopped over the fabric
 *   wake   — {peer, action:"wake", health:{type:"peer-online"}, optional}
 *
 * A wake step starts no app, so it carries no appId and no artifact: its gate is
 * always peer-online (whatever the caller asked for), defaulting to the two
 * minutes a cold boot wants — an explicit timeoutMs is still honoured, because
 * "how long do I give this machine" is exactly the knob a user needs. A wake
 * with no peer names nothing to wake, so the step is dropped like any junk step.
 */
function sanitizeStep(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const peer = sanitizePeer(s.peer);
  const action = String(s.action == null ? "" : s.action).trim().toLowerCase() === "wake" ? "wake" : "launch";

  if (action === "wake") {
    if (!peer) return null;
    const h = s.health && typeof s.health === "object" ? s.health : {};
    return {
      appId: null,
      artifactId: null,
      health: { type: "peer-online", timeoutMs: clampTimeout(h.timeoutMs, WAKE_TIMEOUT_MS) },
      optional: Boolean(s.optional),
      peer,
      action: "wake",
    };
  }

  const appId = slugify(s.appId);
  if (!appId) return null;
  const health = sanitizeHealth(s.health, Boolean(peer));
  if (!health) return null;
  const step = { appId, artifactId: null, health, optional: Boolean(s.optional) };
  if (s.artifactId != null && String(s.artifactId).trim()) step.artifactId = String(s.artifactId).trim();
  // The key only exists on a step that really is peered — every reader written
  // against v0.6 keeps seeing exactly the object it expects, and `action` only
  // ever appears on a wake step (absent = "launch", the default).
  if (peer) step.peer = peer;
  return step;
}

/**
 * SPEC v0.6: cooldownMs is clamped to [5s, 1h]; junk or absent means 60s.
 * `null` / `""` are ABSENT, not zero — a stored trigger that never carried the
 * field round-trips through JSON as null, and that must not become the 5s floor.
 */
function clampCooldown(value) {
  if (value == null || value === "") return TRIGGER_COOLDOWN_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return TRIGGER_COOLDOWN_MS;
  return Math.min(Math.max(Math.round(n), TRIGGER_COOLDOWN_MIN_MS), TRIGGER_COOLDOWN_MAX_MS);
}

/**
 * SPEC v0.6: `trigger: {type:"adb-device"|"connector-app", serial?, appId?,
 * stopOnLeave?, cooldownMs?}`. Junk in → null out, and a stack whose trigger is
 * null is simply a MANUAL stack: the rest of it still saves, runs and stops.
 * Never throw here — a hand-edited stacks.json must not take the hub down.
 *
 * `serial` absent = any device; `appId` is mandatory for connector-app, because
 * "wait for no app in particular to appear on the bus" cannot mean anything.
 * Ids stay verbatim (trimmed): serials are case-sensitive, and the connector
 * normalizes app ids on its own side.
 */
function sanitizeTrigger(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!t) return null;
  const type = String(t.type == null ? "" : t.type).trim().toLowerCase();
  if (!TRIGGER_TYPES.includes(type)) return null;
  const trigger = { type, stopOnLeave: Boolean(t.stopOnLeave), cooldownMs: clampCooldown(t.cooldownMs) };
  if (type === "adb-device") {
    const serial = String(t.serial == null ? "" : t.serial).trim();
    trigger.serial = serial || null; // null = "any device"
  } else {
    const appId = String(t.appId == null ? "" : t.appId).trim();
    if (!appId) return null;
    trigger.appId = appId;
  }
  return trigger;
}

/**
 * A whole stack. Returns null when nothing usable is left — the caller decides
 * whether that is a dropped junk entry (list) or an error (save).
 */
function sanitizeStack(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const id = slugify(s.id) || slugify(s.name);
  if (!id) return null;
  const name = String(s.name == null ? "" : s.name).trim() || id;
  const steps = (Array.isArray(s.steps) ? s.steps : []).map(sanitizeStep).filter(Boolean);
  const stack = { id, name, steps };
  // The key only exists on a stack that really has a trigger — every reader
  // written against v0.5 keeps seeing exactly the object it expects.
  const trigger = sanitizeTrigger(s.trigger);
  if (trigger) stack.trigger = trigger;
  // v0.10 [fabric2]: PRESERVED, never INVENTED — see save(). Fleet settings
  // sync picks a winner between two hubs' copies of a stack by comparing these,
  // so a stamp minted here would make merely READING the file look like an
  // edit, and this hub would beat the machine the user actually typed on.
  const updatedAt = Number(s.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) stack.updatedAt = Math.round(updatedAt);
  return stack;
}

/* ------------------------------------------------------------------ */
/* persistence — <dataDir>/stacks.json, atomic like state.json          */
/* ------------------------------------------------------------------ */

function storePath() {
  return path.join(cfg().dataDir(), "stacks.json");
}

function readStore() {
  const c = cfg();
  const raw = c.readJson(storePath(), null);
  const list = raw && Array.isArray(raw.stacks) ? raw.stacks : [];
  const seen = new Set();
  const stacks = [];
  for (const entry of list) {
    const stack = sanitizeStack(entry);
    if (!stack || seen.has(stack.id)) continue; // junk and duplicates never survive a read
    seen.add(stack.id);
    stacks.push(stack);
  }
  return { version: 1, stacks };
}

function writeStore(store) {
  const c = cfg();
  c.ensureDir(c.dataDir());
  c.writeJsonAtomic(storePath(), { version: 1, stacks: store.stacks });
  return store;
}

function list() {
  return readStore().stacks;
}

function get(id) {
  const wanted = slugify(id);
  return list().find((s) => s.id === wanted) || null;
}

/**
 * Create or replace a stack. Returns the sanitized record actually stored.
 *
 * v0.10 [fabric2]: every save stamps `updatedAt`, which is how fleet settings
 * sync tells two hubs' copies of the same stack apart. `{stamp:false}` is the
 * ONE exception — the sync applying a peer's stack, where the stamp already on
 * the record is the whole point and re-stamping it here would make this hub the
 * apparent author of somebody else's edit.
 */
function save(raw, { stamp = true } = {}) {
  const stack = sanitizeStack(raw);
  if (!stack) throw new Error("A stack needs an id or a name");
  if (!stack.steps.length) throw new Error("A stack needs at least one step");
  if (stamp) stack.updatedAt = Date.now();
  const store = readStore();
  const idx = store.stacks.findIndex((s) => s.id === stack.id);
  if (idx >= 0) store.stacks[idx] = stack;
  else store.stacks.push(stack);
  writeStore(store);
  log(`saved ${stack.id} (${stack.steps.length} steps)${stack.trigger ? `, trigger ${stack.trigger.type}` : ""}`);
  syncWatcher(); // the edit may have added or removed a trigger
  return stack;
}

function remove(id) {
  const wanted = slugify(id);
  const store = readStore();
  const before = store.stacks.length;
  store.stacks = store.stacks.filter((s) => s.id !== wanted);
  if (store.stacks.length === before) return false;
  writeStore(store);
  log(`removed ${wanted}`);
  cooldowns.delete(wanted);
  syncWatcher();
  return true;
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

/**
 * SPEC: {type:"stack-progress", stackId, stepIndex, appId, phase}.
 * The run's own terminal event carries stepIndex null (done | failed | stopped).
 */
function progress(stackId, stepIndex, appId, phase, extra = {}) {
  const evt = Object.assign(
    { type: "stack-progress", stackId, stepIndex: stepIndex == null ? null : stepIndex, appId: appId || null, phase },
    extra
  );
  if (current && current.stackId === stackId && stepIndex != null) {
    current.stepIndex = stepIndex;
    current.phase = phase;
  }
  try {
    deps.emit(evt);
  } catch (e) {
    log(`emit failed: ${e.message}`);
  }
  return evt;
}

/* ------------------------------------------------------------------ */
/* health gates                                                        */
/* ------------------------------------------------------------------ */

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (t.unref) t.unref();
    if (signal) signal.onAbort(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** A tiny abort token — stop() flips it and every gate gives up at once. */
function makeSignal() {
  const listeners = [];
  return {
    aborted: false,
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      for (const fn of listeners.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
    },
    onAbort(fn) {
      if (this.aborted) fn();
      else listeners.push(fn);
    },
  };
}

/** One TCP connect attempt to 127.0.0.1:port. Resolves true when it lands. */
function tryPort(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {
        /* already gone */
      }
      resolve(ok);
    };
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** What to tell the user when a gate ran out of time. Names WHERE it looked. */
function gateTimeoutReason(step) {
  const health = step.health;
  const peer = step.peer || null;
  // v0.10 [fabric2]: name WHOSE bus was watched — "on the bus" is a different
  // (and much more confusing) sentence when the bus is on another machine.
  if (health.type === "connector") {
    return peer
      ? `${step.appId} did not announce itself on ${peerLabel(peer)}'s bus`
      : `${step.appId} did not announce itself on the bus`;
  }
  if (health.type === "peer-online") return `${peerLabel(peer)} did not come online`;
  const where = peer ? peerLabel(peer) : "127.0.0.1";
  return `nothing is listening on ${where}:${health.port}`;
}

/**
 * SPEC v0.7: a port gate on a peered step is probed OVER THERE — the fleet asks
 * the remote to TCP-connect its own 127.0.0.1:port. A probe that cannot even be
 * sent is "not open yet", never a thrown run: the deadline is what decides.
 */
async function probeRemotePort(peerId, port) {
  const f = fleetMod();
  if (!f || typeof f.probePeerPort !== "function") return false;
  try {
    return Boolean(await f.probePeerPort(peerId, port, { timeoutMs: timing().probeTimeoutMs }));
  } catch (e) {
    warnOnce(`probe ${peerLabel(peerId)}:${port} failed: ${e.message}`);
    return false;
  }
}

/**
 * Wait for a step to be healthy.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function waitForHealth(step, signal) {
  const { pollMs } = timing();
  const health = step.health;
  const peer = step.peer || null;
  const deadline = Date.now() + clampTimeout(health.timeoutMs, DEFAULT_TIMEOUT_MS);

  if (health.type === "delay") {
    const ms = clampTimeout(health.timeoutMs, 0);
    if (ms > 0) await sleep(ms, signal);
    return signal.aborted ? { ok: false, reason: "stopped" } : { ok: true };
  }

  // v0.10 [fabric2]: only a LOCAL connector gate needs a local bus. A peered
  // one is answered from the fabric, so a hub with no bus of its own can still
  // wait for an app to come up on the other machine.
  if (health.type === "connector" && !peer && !connector()) {
    // Nothing can ever answer — say so now instead of burning the timeout.
    return { ok: false, reason: "the connector bus is not running" };
  }

  // Same courtesy for the fabric: with no fleet at all, a remote gate can only
  // ever time out, so it says the true thing immediately.
  if (peer && !fleetMod()) return { ok: false, reason: FLEET_MISSING };

  for (;;) {
    if (signal.aborted) return { ok: false, reason: "stopped" };
    if (health.type === "connector") {
      // v0.10 [fabric2]: peered → the peer's relayed roster, polled at the same
      // rate as everything else here (250ms by default, injected in tests).
      if (peer ? isPresentOnPeer(peer, step.appId) : isPresent(step.appId)) return { ok: true };
    } else if (health.type === "port") {
      // eslint-disable-next-line no-await-in-loop
      if (peer ? await probeRemotePort(peer, health.port) : await tryPort(health.port)) return { ok: true };
    } else if (health.type === "peer-online") {
      if (isPeerOnline(peer)) return { ok: true };
    }
    if (signal.aborted) return { ok: false, reason: "stopped" };
    if (Date.now() >= deadline) {
      return { ok: false, reason: gateTimeoutReason(step) };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function running() {
  if (!current) return null;
  return { stackId: current.stackId, stepIndex: current.stepIndex, phase: current.phase };
}

/**
 * SPEC: `artifactId` is optional in the model, and a step is resolved against
 * the discovery model at RUN time — never at save time, because what is
 * installed (and therefore launchable) changes under a stored stack.
 */
function resolveArtifact(appId) {
  let discovery = deps.discovery || null;
  if (!discovery) {
    try {
      // eslint-disable-next-line global-require
      discovery = require("./discovery");
    } catch (_) {
      return { artifactId: null };
    }
  }
  if (typeof discovery.findApp !== "function") return { artifactId: null };
  const app = discovery.findApp(appId);
  if (!app) {
    // An EMPTY model is not evidence that the app does not exist (a CLI process
    // starts with no cache, and jobs can be given its own resolver) — defer to
    // the launcher there, and only accuse the step when discovery really knows
    // the catalogue and this app is not in it.
    const known = typeof discovery.getCached === "function" ? (discovery.getCached() || {}).apps || [] : [];
    if (!known.length) return { artifactId: null };
    return { error: `"${appId}" is not an app the hub knows about` };
  }
  const name = app.name || appId;
  const launchable = (app.artifacts || []).filter((a) => a.installed && a.launchable !== false);
  if (launchable.length === 1) return { artifactId: launchable[0].id };
  if (!launchable.length) return { error: `${name} has nothing installed to launch` };
  return { error: `${name} has ${launchable.length} launchable downloads — name one in the step` };
}

/**
 * Everything a peered step adds to its progress events. Shape is unchanged —
 * these are extras — so a v0.6 renderer keeps working and a v0.7 one can say
 * "on Workshop PC" (and "waking" instead of "launching").
 */
function stepExtras(step) {
  if (!step || !step.peer) return {};
  return step.action === "wake" ? { peer: step.peer, action: "wake" } : { peer: step.peer };
}

/**
 * SPEC v0.7: a peered step is launched over the fabric. The artifact is NOT
 * resolved here — the remote hub validates against its own model (a stack must
 * not assume the same downloads are installed on both machines), so an absent
 * artifactId travels as absent and the peer picks.
 */
async function remoteLaunchStep(step) {
  const f = requireFleet();
  const peer = requirePeer(step.peer);
  if (typeof f.remoteLaunch !== "function") throw new Error(FLEET_MISSING);
  const label = peer.name || step.peer;
  const ack = await f.remoteLaunch(step.peer, step.appId, step.artifactId || undefined);
  if (!ack || !ack.ok) throw new Error(ackError(ack) || `${label} would not launch ${step.appId}`);
  return { pid: null, result: ack };
}

/**
 * SPEC v0.7: wake = magic packets at the peer's stored mac, then the implicit
 * peer-online gate. `wake()` returning false means the packet could not even be
 * sent (no mac on file, no socket) — that is a failed step, not a slow boot.
 */
async function wakeStep(step) {
  const f = requireFleet();
  const peer = requirePeer(step.peer);
  if (typeof f.wake !== "function") throw new Error(FLEET_MISSING);
  const label = peer.name || step.peer;
  const ok = await f.wake(step.peer);
  if (!ok) throw new Error(`could not send a wake packet to ${label}`);
  return { pid: null, result: { ok: true } };
}

async function launchStep(step) {
  if (step.action === "wake") return wakeStep(step);
  if (step.peer) return remoteLaunchStep(step);
  const jobs = deps.jobs;
  if (!jobs || typeof jobs.launch !== "function") throw new Error("No launcher wired up");
  let artifactId = step.artifactId || null;
  if (!artifactId) {
    const picked = resolveArtifact(step.appId);
    if (picked.error) throw new Error(picked.error);
    artifactId = picked.artifactId;
  }
  const result = await jobs.launch(step.appId, artifactId || undefined);
  const pid = result && Number.isInteger(Number(result.pid)) ? Number(result.pid) : null;
  return { pid, result: result || null };
}

/**
 * Run a stack, one step at a time. Resolves when the run finished — the caller
 * usually does NOT await it (IPC returns immediately); phases arrive as events.
 *
 * A required step that never becomes healthy aborts the run, but everything
 * already started keeps running: the user asked for those, and killing them
 * behind their back would lose work. `stop()` is the way back.
 */
async function run(id) {
  if (current) throw new Error(`A stack is already running (${current.stackId})`);
  const stack = get(id);
  if (!stack) throw new Error(`Unknown stack "${id}"`);
  if (!stack.steps.length) throw new Error(`Stack "${stack.id}" has no steps`);

  const signal = makeSignal();
  const record = { stackId: stack.id, name: stack.name, stepIndex: 0, phase: "launching", signal, started: [], ok: null };
  current = record;
  log(`run ${stack.id}: ${stack.steps.length} steps`);

  let failure = null;
  try {
    for (let i = 0; i < stack.steps.length; i += 1) {
      const step = stack.steps[i];
      if (signal.aborted) break;

      const extras = stepExtras(step);
      progress(stack.id, i, step.appId, "launching", Object.assign({ artifactId: step.artifactId || null }, extras));
      let launched = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        launched = await launchStep(step);
        record.started.push(
          Object.assign(
            {
              stepIndex: i,
              appId: step.appId,
              artifactId: step.artifactId || null,
              pid: launched.pid,
              reached: "launching",
            },
            extras
          )
        );
      } catch (e) {
        progress(stack.id, i, step.appId, "failed", Object.assign({ message: e.message, optional: step.optional }, extras));
        if (step.optional) continue;
        failure = { stepIndex: i, appId: step.appId, message: e.message, peer: step.peer || null };
        break;
      }

      if (signal.aborted) break;
      progress(stack.id, i, step.appId, "waiting", Object.assign({ health: step.health.type }, extras));
      // eslint-disable-next-line no-await-in-loop
      const gate = await waitForHealth(step, signal);
      const entry = record.started[record.started.length - 1];
      if (gate.ok) {
        if (entry) entry.reached = "healthy";
        progress(stack.id, i, step.appId, "healthy", extras);
        continue;
      }
      if (signal.aborted) break;
      progress(stack.id, i, step.appId, "failed", Object.assign({ message: gate.reason, optional: step.optional }, extras));
      if (step.optional) continue; // it is still running — just not waited on
      failure = { stepIndex: i, appId: step.appId, message: gate.reason, peer: step.peer || null };
      break;
    }
  } finally {
    record.ok = !failure && !signal.aborted;
    last = record;
    current = null;
  }

  if (signal.aborted) {
    // stop() emits its own terminal event — don't double-report.
    return { ok: false, stopped: true, stackId: stack.id, started: record.started };
  }
  if (failure) {
    // The run's own terminal event: stepIndex stays null (that is what marks it
    // as the RUN's verdict), the step that sank it travels as `failedStep`.
    progress(
      stack.id,
      null,
      failure.appId,
      "failed",
      Object.assign({ message: failure.message, failedStep: failure.stepIndex }, failure.peer ? { peer: failure.peer } : {})
    );
    log(`run ${stack.id} failed at step ${failure.stepIndex}: ${failure.message}`);
    return { ok: false, stackId: stack.id, failed: failure, started: record.started };
  }
  progress(stack.id, null, null, "done");
  log(`run ${stack.id} done`);
  return { ok: true, stackId: stack.id, started: record.started };
}

/* ------------------------------------------------------------------ */
/* stop                                                                */
/* ------------------------------------------------------------------ */

function sigterm(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // SPEC: never SIGKILL — a stack stop is polite by definition.
    try {
      // v0.8: tell the watchdog this exit is ours, then stop the whole group
      // (the sandbox supervisor alone dying would leave the app running).
      if (deps.jobs && typeof deps.jobs.noteHubStop === "function") deps.jobs.noteHubStop({ pid });
    } catch (_) {}
    require("./install/util").killTree(pid, "SIGTERM");
    return true;
  } catch (e) {
    return false; // already gone, or not ours
  }
}

/** Wait for an app to disappear from the bus, up to `ms`. */
async function waitForDeparture(appId, ms, signal) {
  const { pollMs } = timing();
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    if (!isPresent(appId)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
  return !isPresent(appId);
}

/**
 * SPEC v0.7: stopping a peered step is one message — the remote hub does its own
 * polite bus/SIGTERM dance over there. BEST EFFORT by definition: a peer that is
 * asleep, unpaired or simply rude must not strand the rest of the reverse walk,
 * so every failure is a log line and a `how`, never a throw.
 */
async function remoteStopEntry(entry) {
  const f = fleetMod();
  if (!f || typeof f.remoteStop !== "function") {
    log(`stop ${entry.appId} on ${peerLabel(entry.peer)}: ${FLEET_MISSING}`);
    return "remote-failed";
  }
  try {
    const ack = await f.remoteStop(entry.peer, entry.appId);
    if (!ack || !ack.ok) {
      log(`stop ${entry.appId} on ${peerLabel(entry.peer)}: ${ackError(ack) || "refused"}`);
      return "remote-failed";
    }
    return "remote-stop";
  } catch (e) {
    log(`stop ${entry.appId} on ${peerLabel(entry.peer)}: ${e.message}`);
    return "remote-failed";
  }
}

/**
 * Stop a stack: reverse order over the steps that actually started in the
 * current (or last) run — shutdown-request over the bus first, SIGTERM the
 * recorded launch pid as the fallback. Never SIGKILL. Peered steps go the one
 * way that can reach them, fleet.remoteStop; a wake step started nothing, so
 * there is nothing to stop (a machine is not un-woken).
 */
async function stop(id) {
  const wanted = slugify(id);
  const record =
    current && current.stackId === wanted ? current : last && last.stackId === wanted ? last : null;
  if (!record) return { ok: false, stackId: wanted, stopped: [], reason: "that stack is not running" };

  if (record.signal) record.signal.abort(); // let a run in flight fall out of its gate
  const { shutdownWaitMs } = timing();
  const stopped = [];

  // Entries are MARKED rather than dropped: a step that finished launching in
  // the same tick stop() ran stays reachable by a second stop() instead of
  // becoming an orphan.
  const pending = [...record.started].filter((e) => !e.stopped && e.action !== "wake").reverse();
  for (const entry of pending) {
    entry.stopped = true;
    const extras = entry.peer ? { peer: entry.peer } : {};
    progress(record.stackId, entry.stepIndex, entry.appId, "stopping", extras);
    let how = null;
    if (entry.peer) {
      // eslint-disable-next-line no-await-in-loop
      how = await remoteStopEntry(entry);
    } else {
      if (isPresent(entry.appId) && requestShutdown(entry.appId)) {
        // eslint-disable-next-line no-await-in-loop
        const gone = await waitForDeparture(entry.appId, shutdownWaitMs, null);
        how = gone ? "shutdown-request" : null;
      }
      if (!how) how = sigterm(entry.pid) ? "sigterm" : "gone";
    }
    stopped.push(Object.assign({ stepIndex: entry.stepIndex, appId: entry.appId, pid: entry.pid, how }, extras));
    progress(record.stackId, entry.stepIndex, entry.appId, "stopped", Object.assign({ how }, extras));
  }

  if (current === record) {
    last = record;
    current = null;
  }
  progress(record.stackId, null, null, "stopped", { count: stopped.length });
  log(`stop ${record.stackId}: ${stopped.map((s) => `${s.appId}=${s.how}`).join(", ") || "nothing to stop"}`);
  return { ok: true, stackId: record.stackId, stopped };
}

/* ------------------------------------------------------------------ */
/* triggers (v0.6) — arrival / departure watchers                      */
/* ------------------------------------------------------------------ */

/** The live watcher, or null. One at a time; every restart replaces it. */
let watcher = null;
/**
 * stackId → epoch ms of the last TRIGGERED run. In-memory only, on purpose:
 * a cooldown is about "the headset just bounced", not about hub restarts, and
 * writing it would mean a disk write on every plug-in event.
 */
const cooldowns = new Map();
/** init() has run, so save()/remove() are allowed to (re)arm the watcher. */
let watchEnabled = false;

/** The ctx the install engine wants for an adb call (same shape discovery builds). */
function adbCtx() {
  const c = cfg();
  let settings = {};
  try {
    settings = (typeof c.load === "function" ? c.load() : null) || {};
  } catch (_) {
    settings = {};
  }
  const ctx = { settings, log: (m) => log(`adb: ${m}`), emitProgress: () => {} };
  try {
    ctx.dataDir = c.dataDir();
    if (typeof c.installRoot === "function") ctx.installRoot = c.installRoot(settings);
  } catch (_) {
    /* a status poll is not worth failing over a path */
  }
  return ctx;
}

/**
 * One presence observation for a triggered stack.
 *
 * EDGE DISCIPLINE (SPEC v0.6): the FIRST observation only records the baseline
 * — it never fires. Whatever is already plugged in when the watcher starts was
 * there before the hub was, so restarting the hub (or saving any stack, which
 * restarts the watcher) must NOT re-run the stack. Only a real absent→present
 * transition observed by THIS watcher counts as an arrival.
 */
function edge(w, stack, present, reason) {
  if (watcher !== w) return; // a stale poll from a torn-down watcher
  const was = w.state.has(stack.id) ? w.state.get(stack.id) : null;
  w.state.set(stack.id, present);
  if (was === null || was === undefined) return; // baseline
  if (present === was) return;
  if (present) fireArrival(stack, reason);
  else if (stack.trigger.stopOnLeave) fireDeparture(stack, reason);
}

/** Absent → present. Runs the stack unless something says otherwise. */
function fireArrival(stack, reason) {
  // SPEC: one stack at a time. A trigger is never allowed to gatecrash a run
  // the user (or another trigger) started — it just says so in the log.
  if (current) {
    log(`trigger ${stack.id}: ${reason} arrived, skipped — ${current.stackId} is already running`);
    return;
  }
  const now = Date.now();
  const readyAt = (cooldowns.get(stack.id) || 0) + stack.trigger.cooldownMs;
  if (now < readyAt) {
    log(`trigger ${stack.id}: ${reason} arrived, skipped — cooldown, ${Math.ceil((readyAt - now) / 1000)}s left`);
    return;
  }
  cooldowns.set(stack.id, now);
  log(`trigger ${stack.id}: ${reason} arrived — running`);
  // The renderer learns WHY a run it did not ask for started, before any step
  // event arrives. stepIndex null: this is the run's news, not a step's.
  progress(stack.id, null, null, "triggered", { reason });
  // run() sets `current` synchronously, so a second trigger in the same tick
  // already sees a run in flight.
  Promise.resolve(run(stack.id)).catch((e) => log(`trigger ${stack.id}: run failed: ${e.message}`));
}

/** Present → absent, with stopOnLeave. */
function fireDeparture(stack, reason) {
  log(`trigger ${stack.id}: ${reason} left — stopping`);
  Promise.resolve(stop(stack.id)).catch((e) => log(`trigger ${stack.id}: stop failed: ${e.message}`));
}

/** One adb sweep: who is plugged in, and what does that mean per stack. */
async function pollAdb(w, engine, adbStacks) {
  if (watcher !== w || w.busy) return; // never let two polls overlap
  w.busy = true;
  let status = null;
  try {
    status = await engine.getAdbStatus(adbCtx());
  } catch (e) {
    log(`adb poll failed: ${e.message}`);
  } finally {
    w.busy = false;
  }
  // A poll that could not answer is UNKNOWN, not "everything unplugged" —
  // treating it as absence would fire a departure stop on a flaky adb server.
  if (!status || !Array.isArray(status.devices)) return;
  const online = status.devices.filter((d) => d && d.serial && (!d.state || d.state === "device"));
  for (const stack of adbStacks) {
    const serial = stack.trigger.serial;
    const present = serial ? online.some((d) => String(d.serial) === serial) : online.length > 0;
    edge(w, stack, present, "adb-device");
  }
}

/** Tear the watcher down: timers cleared, subscriptions dropped. Idempotent. */
function stopWatcher() {
  const w = watcher;
  watcher = null;
  if (!w) return false;
  if (w.timer) clearInterval(w.timer);
  w.timer = null;
  for (const off of w.unsubs.splice(0)) {
    try {
      off();
    } catch (_) {
      /* an unsubscribe that throws must not strand the rest */
    }
  }
  return true;
}

/**
 * (Re)start the watcher from what is on disk. Called by init() and after every
 * save/remove, because an edit is exactly how a trigger appears or disappears.
 * Returns the watcher, or null when no stored stack has a trigger.
 */
function startWatcher() {
  stopWatcher();
  let armed = [];
  try {
    armed = list().filter((s) => s.trigger);
  } catch (e) {
    log(`watcher: cannot read the stacks store: ${e.message}`);
    return null;
  }
  if (!armed.length) return null;

  const w = { stacks: armed, state: new Map(), unsubs: [], timer: null, busy: false };
  watcher = w;

  const appStacks = armed.filter((s) => s.trigger.type === "connector-app");
  if (appStacks.length) {
    const c = connector();
    if (c && typeof c.onChange === "function") {
      // Presence RIGHT NOW is the baseline (see edge()) — the bus tells us the
      // whole truth synchronously, so there is no "unknown" phase here.
      for (const stack of appStacks) w.state.set(stack.id, isPresent(stack.trigger.appId));
      try {
        const off = c.onChange(() => {
          if (watcher !== w) return;
          for (const stack of appStacks) edge(w, stack, isPresent(stack.trigger.appId), "connector-app");
        });
        if (typeof off === "function") w.unsubs.push(off);
      } catch (e) {
        log(`connector.onChange failed: ${e.message} — ${appStacks.length} app trigger(s) dormant`);
      }
    } else {
      log(`connector unavailable — ${appStacks.length} app trigger(s) dormant`);
    }
  }

  const adbStacks = armed.filter((s) => s.trigger.type === "adb-device");
  if (adbStacks.length) {
    const engine = engineMod();
    if (!engine || typeof engine.getAdbStatus !== "function") {
      // ONE line, then silence: a hub with no install engine wired is a normal
      // state (the CLI runs like that), not something to nag about every 10s.
      log(`adb unavailable — ${adbStacks.length} device trigger(s) dormant`);
    } else {
      // `null` = "not observed yet": the first poll writes the baseline.
      for (const stack of adbStacks) w.state.set(stack.id, null);
      const { adbPollMs } = timing();
      const tick = () => {
        pollAdb(w, engine, adbStacks);
      };
      w.timer = setInterval(tick, adbPollMs);
      if (w.timer.unref) w.timer.unref(); // a poll must never hold the CLI open
      tick(); // baseline NOW, so a device plugged in 3s later still counts
    }
  }

  log(`watcher: armed ${armed.map((s) => `${s.id}(${s.trigger.type})`).join(", ")}`);
  return w;
}

/** Restart the watcher if init() has wired us up. Never throws at the caller. */
function syncWatcher() {
  if (!watchEnabled) return null;
  try {
    return startWatcher();
  } catch (e) {
    log(`watcher restart failed: ${e.message}`);
    return null;
  }
}

/** Test/diagnostic helper: the armed stack ids, or null when nothing watches. */
function _watching() {
  return watcher ? watcher.stacks.map((s) => s.id) : null;
}

module.exports = {
  init,
  list,
  get,
  save,
  remove,
  run,
  stop,
  running,
  stopWatcher,
  // pure helpers the CLI / tests reuse
  sanitizeStack,
  sanitizeStep,
  sanitizeHealth,
  sanitizeTrigger,
  sanitizePeer,
  slugify,
  storePath,
  PHASES,
  HEALTH_TYPES,
  PEER_ONLY_HEALTH_TYPES,
  STEP_ACTIONS,
  WAKE_TIMEOUT_MS,
  TRIGGER_TYPES,
  DEFAULT_TIMEOUT_MS,
  TRIGGER_COOLDOWN_MS,
  TRIGGER_COOLDOWN_MIN_MS,
  TRIGGER_COOLDOWN_MAX_MS,
  ADB_POLL_MS,
  _reset,
  _watching,
};
