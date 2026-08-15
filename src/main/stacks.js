"use strict";
// NX Hub — stacks: "launch these apps, in this order, waiting for each to come
// up before starting the next" (SPEC "NX Connector → Stacks").
//
// Pure node, no electron. Every collaborator is injected through init():
//   jobs       — jobs.launch(appId, artifactId) → {pid, …} (the install engine's)
//   connector  — the bus module (isPresent / requestShutdown), or null/absent
//   config     — the hub's config module (dataDir + atomic writes)
//   emit       — the event fan-out; every phase change goes through it
//
// The connector is deliberately OPTIONAL: the hub has to work with no bus at
// all (the module may not even exist), so a `connector` health gate simply
// fails fast instead of hanging for its whole timeout.

const net = require("net");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 250;
const SHUTDOWN_WAIT_MS = 5000;

const HEALTH_TYPES = ["connector", "port", "delay"];
/** SPEC: phase ∈ launching|waiting|healthy|failed|done|stopping|stopped */
const PHASES = ["launching", "waiting", "healthy", "failed", "done", "stopping", "stopped"];

let deps = {
  jobs: null,
  connector: null,
  config: null,
  emit: () => {},
  // optional: the discovery model, for resolving a step that names no artifact
  // (lazily required when not injected — tests hand over a fake)
  discovery: null,
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
  return module.exports;
}

/** For tests: forget every run (the store on disk is untouched). */
function _reset() {
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

function timing() {
  const t = deps.timing || {};
  return {
    pollMs: Number(t.pollMs) > 0 ? Number(t.pollMs) : POLL_MS,
    shutdownWaitMs: Number(t.shutdownWaitMs) >= 0 ? Number(t.shutdownWaitMs) : SHUTDOWN_WAIT_MS,
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
 */
function sanitizeHealth(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  const type = HEALTH_TYPES.includes(String(h.type)) ? String(h.type) : null;
  if (!type) return { type: "delay", timeoutMs: 0 };
  const out = { type, timeoutMs: clampTimeout(h.timeoutMs, type === "delay" ? 0 : DEFAULT_TIMEOUT_MS) };
  if (type === "port") {
    const port = sanitizePort(h.port);
    if (port == null) return null; // unusable — the step gets dropped
    out.port = port;
  }
  return out;
}

function sanitizeStep(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const appId = slugify(s.appId);
  if (!appId) return null;
  const health = sanitizeHealth(s.health);
  if (!health) return null;
  const step = { appId, artifactId: null, health, optional: Boolean(s.optional) };
  if (s.artifactId != null && String(s.artifactId).trim()) step.artifactId = String(s.artifactId).trim();
  return step;
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
  return { id, name, steps };
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

/** Create or replace a stack. Returns the sanitized record actually stored. */
function save(raw) {
  const stack = sanitizeStack(raw);
  if (!stack) throw new Error("A stack needs an id or a name");
  if (!stack.steps.length) throw new Error("A stack needs at least one step");
  const store = readStore();
  const idx = store.stacks.findIndex((s) => s.id === stack.id);
  if (idx >= 0) store.stacks[idx] = stack;
  else store.stacks.push(stack);
  writeStore(store);
  log(`saved ${stack.id} (${stack.steps.length} steps)`);
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

/**
 * Wait for a step to be healthy.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function waitForHealth(step, signal) {
  const { pollMs } = timing();
  const health = step.health;
  const deadline = Date.now() + clampTimeout(health.timeoutMs, DEFAULT_TIMEOUT_MS);

  if (health.type === "delay") {
    const ms = clampTimeout(health.timeoutMs, 0);
    if (ms > 0) await sleep(ms, signal);
    return signal.aborted ? { ok: false, reason: "stopped" } : { ok: true };
  }

  if (health.type === "connector" && !connector()) {
    // Nothing can ever answer — say so now instead of burning the timeout.
    return { ok: false, reason: "the connector bus is not running" };
  }

  for (;;) {
    if (signal.aborted) return { ok: false, reason: "stopped" };
    if (health.type === "connector") {
      if (isPresent(step.appId)) return { ok: true };
    } else if (health.type === "port") {
      // eslint-disable-next-line no-await-in-loop
      if (await tryPort(health.port)) return { ok: true };
    }
    if (signal.aborted) return { ok: false, reason: "stopped" };
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason:
          health.type === "connector"
            ? `${step.appId} did not announce itself on the bus`
            : `nothing is listening on 127.0.0.1:${health.port}`,
      };
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

async function launchStep(step) {
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

      progress(stack.id, i, step.appId, "launching", { artifactId: step.artifactId || null });
      let launched = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        launched = await launchStep(step);
        record.started.push({
          stepIndex: i,
          appId: step.appId,
          artifactId: step.artifactId || null,
          pid: launched.pid,
          reached: "launching",
        });
      } catch (e) {
        progress(stack.id, i, step.appId, "failed", { message: e.message, optional: step.optional });
        if (step.optional) continue;
        failure = { stepIndex: i, appId: step.appId, message: e.message };
        break;
      }

      if (signal.aborted) break;
      progress(stack.id, i, step.appId, "waiting", { health: step.health.type });
      // eslint-disable-next-line no-await-in-loop
      const gate = await waitForHealth(step, signal);
      const entry = record.started[record.started.length - 1];
      if (gate.ok) {
        if (entry) entry.reached = "healthy";
        progress(stack.id, i, step.appId, "healthy");
        continue;
      }
      if (signal.aborted) break;
      progress(stack.id, i, step.appId, "failed", { message: gate.reason, optional: step.optional });
      if (step.optional) continue; // it is still running — just not waited on
      failure = { stepIndex: i, appId: step.appId, message: gate.reason };
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
    progress(stack.id, null, failure.appId, "failed", { message: failure.message, failedStep: failure.stepIndex });
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
    process.kill(pid, "SIGTERM");
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
 * Stop a stack: reverse order over the steps that actually started in the
 * current (or last) run — shutdown-request over the bus first, SIGTERM the
 * recorded launch pid as the fallback. Never SIGKILL.
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
  const pending = [...record.started].filter((e) => !e.stopped).reverse();
  for (const entry of pending) {
    entry.stopped = true;
    progress(record.stackId, entry.stepIndex, entry.appId, "stopping");
    let how = null;
    if (isPresent(entry.appId) && requestShutdown(entry.appId)) {
      // eslint-disable-next-line no-await-in-loop
      const gone = await waitForDeparture(entry.appId, shutdownWaitMs, null);
      how = gone ? "shutdown-request" : null;
    }
    if (!how) how = sigterm(entry.pid) ? "sigterm" : "gone";
    stopped.push({ stepIndex: entry.stepIndex, appId: entry.appId, pid: entry.pid, how });
    progress(record.stackId, entry.stepIndex, entry.appId, "stopped", { how });
  }

  if (current === record) {
    last = record;
    current = null;
  }
  progress(record.stackId, null, null, "stopped", { count: stopped.length });
  log(`stop ${record.stackId}: ${stopped.map((s) => `${s.appId}=${s.how}`).join(", ") || "nothing to stop"}`);
  return { ok: true, stackId: record.stackId, stopped };
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
  // pure helpers the CLI / tests reuse
  sanitizeStack,
  sanitizeStep,
  sanitizeHealth,
  slugify,
  storePath,
  PHASES,
  HEALTH_TYPES,
  DEFAULT_TIMEOUT_MS,
  _reset,
};
