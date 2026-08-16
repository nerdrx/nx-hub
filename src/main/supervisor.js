"use strict";
// NX Hub — SPEC v0.8 "Watchdog". Keeps `appPrefs.keepAlive` apps alive.
//
// Pure node (no electron, no direct state/discovery imports): everything it
// needs arrives through init(). It listens to ONE stream — jobs.onLaunchExit —
// and its only action is jobs.launch.
//
// The decision, in order (SPEC):
//   keepAlive off                     → nothing
//   the hub stopped it                → nothing (a stack stop is not a crash)
//   crash loop at the installed build → nothing, keepAlive is suspended for
//                                       that version until it is rolled back
//   a clean connector `bye` ≤5s pre-exit → nothing (the app quit on purpose)
//   otherwise                          → relaunch after 2s·4s·8s…60s,
//                                        at most 5 times per rolling 10min,
//                                        then give up with an error toast.
// A run of ≥120s resets the ladder — the same "it was healthy" threshold the
// v0.6 crash counter uses.
//
// Why the `bye` check is what it is: the bus does not (yet) expose WHY a client
// left, so a departure alone cannot tell "sent bye, then exited" from "crashed,
// so the socket died with it". The supervisor therefore requires BOTH a
// departure around the exit AND a clean exit (code 0, no signal) before it
// calls something a polite goodbye. A crash keeps its restart, which is the
// entire point of the feature. The check is re-run just before the relaunch,
// because connector-changed is debounced (250ms) and the departure regularly
// lands after the exit event.

const DEFAULT_TIMING = {
  backoff: [2000, 4000, 8000, 16000, 32000, 60000], // ms, last value is the cap
  healthyMs: 120000, // a run this long resets the ladder
  windowMs: 600000, // rolling window for the restart budget
  maxRestarts: 5, // …restarts allowed inside it
  byeWindowMs: 5000, // a departure this close to the exit counts as "around it"
  byeLateMs: 1500, // …including this long AFTER (the bus debounces)
};

let deps = {
  jobs: null,
  connector: null,
  config: null,
  emit: () => {},
  log: null,
};
let timing = Object.assign({}, DEFAULT_TIMING);
let started = false;
let offExit = null;
let offChange = null;

/** key `${appId}::${artifactId}` → {attempt, restarts:[ts], timer, appName} */
const watched = new Map();
/** appId → epoch ms it was last seen leaving the connector bus */
const departures = new Map();
/** the last set of appIds observed on the bus (departure diffing) */
let presence = new Set();

function log(msg) {
  try {
    if (typeof deps.log === "function") deps.log(msg);
    else if (deps.config && typeof deps.config.log === "function") deps.config.log(`[supervisor] ${msg}`);
  } catch (_) {
    /* logging must never break the watchdog */
  }
}

function emit(evt) {
  try {
    deps.emit(evt);
  } catch (_) {
    /* a listener must never break the watchdog */
  }
}

function keyFor(appId, artifactId) {
  return `${appId}::${artifactId}`;
}

function entryFor(evt) {
  const key = keyFor(evt.appId, evt.artifactId);
  let entry = watched.get(key);
  if (!entry) {
    entry = { key, appId: evt.appId, artifactId: evt.artifactId, attempt: 0, restarts: [], timer: null };
    watched.set(key, entry);
  }
  entry.appName = evt.appName || entry.appName || evt.appId;
  return entry;
}

/* ------------------------------------------------------------------ */
/* preferences                                                         */
/* ------------------------------------------------------------------ */

/** SPEC: appPrefs.keepAlive, read fresh — the toggle takes effect immediately. */
function keepAliveFor(appId) {
  const config = deps.config;
  if (!config || typeof config.load !== "function") return false;
  try {
    const settings = config.load();
    const prefs = typeof config.getAppPref === "function" ? config.getAppPref(settings, appId) : null;
    return Boolean(prefs && prefs.keepAlive === true);
  } catch (e) {
    log(`could not read keepAlive for ${appId}: ${e.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* connector presence (departure tracking)                             */
/* ------------------------------------------------------------------ */

/**
 * The connector module. `deps.connector` may be the module itself or a getter
 * (index.js hands stacks a getter, because the bus is (re)started later than
 * the wiring) — both work, and both may legitimately be null.
 */
function bus() {
  const c = deps.connector;
  if (typeof c !== "function") return c || null;
  try {
    return c() || null;
  } catch (_) {
    return null;
  }
}

/** Subscribe to bus changes as soon as there IS a bus. Idempotent. */
function ensureChangeSubscription() {
  if (offChange || !started) return;
  const c = bus();
  if (!c || typeof c.onChange !== "function") return;
  try {
    offChange = c.onChange(sampleBus);
  } catch (e) {
    log(`connector.onChange failed: ${e.message} — bye detection is degraded`);
    offChange = null;
  }
}

function sampleBus() {
  const c = bus();
  if (!c || typeof c.getClients !== "function") return;
  let clients;
  try {
    clients = c.getClients() || [];
  } catch (e) {
    log(`connector.getClients failed: ${e.message}`);
    return;
  }
  const now = new Set();
  for (const client of clients) {
    const id = client && client.app ? String(client.app).toLowerCase() : null;
    if (id) now.add(id);
  }
  const at = Date.now();
  for (const id of presence) if (!now.has(id)) departures.set(id, at);
  presence = now;
}

/**
 * Did this app say a polite goodbye around its exit?
 * @param {object} evt   the launch-exit event
 * @param {number} exitAt  when the exit was observed
 */
function saidBye(evt, exitAt) {
  sampleBus(); // catch a departure that arrived after the exit
  const cleanExit = evt.code === 0 && !evt.signal && !evt.unknownExit;
  if (!cleanExit) return false;
  const at = departures.get(String(evt.appId).toLowerCase());
  if (at == null) return false;
  const delta = exitAt - at; // positive = the bus went first
  return delta <= timing.byeWindowMs && delta >= -timing.byeLateMs;
}

/* ------------------------------------------------------------------ */
/* the watchdog                                                        */
/* ------------------------------------------------------------------ */

function clearTimer(entry) {
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function pruneRestarts(entry, now) {
  entry.restarts = entry.restarts.filter((ts) => now - ts <= timing.windowMs);
  return entry.restarts;
}

function backoffFor(attempt) {
  const ladder = timing.backoff;
  return ladder[Math.min(attempt, ladder.length - 1)];
}

function giveUp(entry, reason, message) {
  clearTimer(entry);
  entry.gaveUpAt = Date.now();
  log(`gave up on ${entry.key}: ${reason}`);
  emit({
    type: "supervisor",
    appId: entry.appId,
    appName: entry.appName,
    artifactId: entry.artifactId,
    action: "gave-up",
    attempt: entry.attempt,
    reason,
  });
  emit({ type: "toast", level: "error", message });
}

/** One watched process ended. Never throws. */
function onLaunchExit(evt) {
  if (!evt || !evt.appId || !evt.artifactId) return;
  ensureChangeSubscription(); // the bus may have come up after init()
  const exitAt = Date.now();
  const entry = entryFor(evt);

  // SPEC: a healthy run (≥120s) resets the ladder AND the give-up state.
  if (evt.uptimeMs >= timing.healthyMs) {
    entry.attempt = 0;
    entry.gaveUpAt = null;
  }

  if (!keepAliveFor(evt.appId)) return;
  if (evt.stoppedByHub) {
    log(`${entry.key} was stopped on purpose — not restarting`);
    return;
  }
  if (evt.crashLoop) {
    log(`${entry.key} is crash-looping at ${evt.version || "?"} — keepAlive suspended for this version`);
    return;
  }
  if (saidBye(evt, exitAt)) {
    log(`${entry.key} left the bus cleanly before exiting — not restarting`);
    return;
  }

  const now = Date.now();
  if (pruneRestarts(entry, now).length >= timing.maxRestarts) {
    giveUp(
      entry,
      `${timing.maxRestarts} restarts in ${Math.round(timing.windowMs / 60000)} minutes`,
      `gave up keeping ${entry.appName} alive (${timing.maxRestarts} restarts in ` +
        `${Math.round(timing.windowMs / 60000)} minutes)`
    );
    return;
  }

  const delayMs = backoffFor(entry.attempt);
  clearTimer(entry);
  log(
    `${entry.key} exited ${evt.signal || `code ${evt.code}`} after ${Math.round(evt.uptimeMs / 1000)}s — ` +
      `restarting in ${Math.round(delayMs / 1000)}s`
  );
  entry.timer = setTimeout(() => {
    entry.timer = null;
    relaunch(entry, evt, delayMs);
  }, delayMs);
  if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
}

function relaunch(entry, evt, delayMs) {
  if (!started) return;
  const jobs = deps.jobs;
  if (!jobs || typeof jobs.launch !== "function") return;

  // The world may have moved while we waited out the backoff.
  if (!keepAliveFor(entry.appId)) {
    log(`keepAlive turned off for ${entry.appId} while waiting — dropping the restart`);
    return;
  }
  if (typeof jobs.isTracked === "function" && jobs.isTracked(entry.appId, entry.artifactId)) {
    log(`${entry.key} is running again already — dropping the restart`);
    return;
  }
  if (saidBye(evt, Date.now())) {
    // The departure can arrive after the exit (the bus debounces its change
    // notification); re-checking here is what makes that race harmless.
    log(`${entry.key} said bye after all — dropping the restart`);
    return;
  }

  const now = Date.now();
  if (pruneRestarts(entry, now).length >= timing.maxRestarts) {
    giveUp(
      entry,
      `${timing.maxRestarts} restarts in ${Math.round(timing.windowMs / 60000)} minutes`,
      `gave up keeping ${entry.appName} alive (${timing.maxRestarts} restarts in ` +
        `${Math.round(timing.windowMs / 60000)} minutes)`
    );
    return;
  }

  entry.restarts.push(now);
  entry.attempt += 1;
  emit({
    type: "supervisor",
    appId: entry.appId,
    appName: entry.appName,
    artifactId: entry.artifactId,
    action: "restarting",
    attempt: entry.attempt,
    delayMs,
  });
  log(`restarting ${entry.key} (attempt ${entry.attempt})`);

  let p;
  try {
    p = jobs.launch(entry.appId, entry.artifactId);
  } catch (e) {
    onRelaunchFailed(entry, e);
    return;
  }
  if (p && typeof p.catch === "function") p.catch((e) => onRelaunchFailed(entry, e));
}

function onRelaunchFailed(entry, err) {
  const message = (err && err.message) || String(err);
  // Nothing will exit now, so no further exit event will drive the ladder:
  // this branch is terminal for this app until the user launches it again.
  giveUp(entry, `relaunch failed: ${message}`, `could not restart ${entry.appName}: ${message}`);
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Wire the supervisor up. Idempotent: a second init() replaces the first.
 *
 * @param {object} o
 * @param {object} o.jobs        src/main/jobs (onLaunchExit, launch, isTracked)
 * @param {object} [o.connector] src/main/connector (getClients, onChange)
 * @param {object} o.config      src/main/config (load, getAppPref, log)
 * @param {function} [o.emit]    hub event sink
 * @param {function} [o.log]
 * @param {object} [o.timing]    TEST-ONLY: shrink the ladder/windows
 */
function init(o = {}) {
  stop();
  deps = Object.assign({ emit: () => {}, log: null }, deps, o);
  timing = Object.assign({}, DEFAULT_TIMING, o.timing || {});
  if (Array.isArray(timing.backoff) && timing.backoff.length === 0) timing.backoff = DEFAULT_TIMING.backoff;

  const jobs = deps.jobs;
  if (!jobs || typeof jobs.onLaunchExit !== "function") {
    log("jobs.onLaunchExit is missing — the watchdog is inert");
    return module.exports;
  }
  started = true;
  offExit = jobs.onLaunchExit(onLaunchExit);
  ensureChangeSubscription();
  sampleBus(); // seed the presence set
  log("watching launches");
  return module.exports;
}

/** Unsubscribe, drop every pending restart. Idempotent. */
function stop() {
  started = false;
  if (typeof offExit === "function") offExit();
  if (typeof offChange === "function") offChange();
  offExit = null;
  offChange = null;
  for (const entry of watched.values()) clearTimer(entry);
  watched.clear();
  departures.clear();
  presence = new Set();
  return module.exports;
}

/** Test/diagnostic view of the ladder state. */
function _state() {
  return {
    started,
    timing: Object.assign({}, timing),
    apps: [...watched.values()].map((e) => ({
      key: e.key,
      appId: e.appId,
      artifactId: e.artifactId,
      attempt: e.attempt,
      restarts: e.restarts.length,
      pending: Boolean(e.timer),
      gaveUpAt: e.gaveUpAt || null,
    })),
    departures: [...departures.keys()],
  };
}

module.exports = {
  init,
  stop,
  onLaunchExit,
  sampleBus,
  DEFAULT_TIMING,
  _state,
};
