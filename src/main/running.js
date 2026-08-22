"use strict";
// NX Hub — what is running, and how to end it. SPEC v0.11 "stop" ([stopper]).
//
// Launching used to be one-way: the hub started an app, tracked its pid,
// watched it for crashes, and offered no way back. The only stop in the product
// belonged to stacks. This module makes that same ladder reachable for ONE app,
// without touching stacks.js (whose version is entangled with run records).
//
// Pure node. Everything arrives through init():
//
//   connector  the bus module or a getter for it (getClients / isPresent /
//              requestShutdown) — null on every build/run without a bus
//   jobs       src/main/jobs.js (listTracked, noteHubStop)
//   config     for log() only
//   discovery  for app NAMES (optional: an unknown id is its own label)
//   fleet      the fleet module or a getter (remoteStop) — {peer} only
//   killTree   injected in tests; defaults to install/util.killTree
//   timing     {shutdownWaitMs = 2500, pollMs = 100}
//
// Two entry points, and neither ever throws: `list()` answers [] when the world
// is empty or broken, `stop()` answers a verdict object for every outcome.

const DEFAULT_TIMING = {
  // SPEC: wait this long for a client to leave the bus after a polite request.
  shutdownWaitMs: 2500,
  // …asking connector.isPresent this often while we wait.
  pollMs: 100,
};

const FLEET_MISSING = "the fleet is not available on this hub";

let deps = {
  connector: null,
  jobs: null,
  config: null,
  discovery: null,
  fleet: null,
  killTree: null,
  log: null,
  timing: {},
};

/** Wire the module up. Idempotent; later calls patch the earlier ones. */
function init(d = {}) {
  deps = Object.assign({}, deps, d || {});
  return module.exports;
}

/* ------------------------------------------------------------------ */
/* plumbing — every hop through a sibling module is failure-tolerant    */
/* ------------------------------------------------------------------ */

function log(msg) {
  try {
    if (typeof deps.log === "function") deps.log(msg);
    else if (deps.config && typeof deps.config.log === "function") deps.config.log(`[running] ${msg}`);
  } catch (_) {
    /* logging must never break a stop */
  }
}

function timing() {
  const t = deps.timing || {};
  return {
    shutdownWaitMs:
      Number(t.shutdownWaitMs) >= 0 ? Number(t.shutdownWaitMs) : DEFAULT_TIMING.shutdownWaitMs,
    pollMs: Number(t.pollMs) > 0 ? Number(t.pollMs) : DEFAULT_TIMING.pollMs,
  };
}

/** The bus, however it was injected: a module, a getter, or nothing at all. */
function bus() {
  try {
    const c = deps.connector;
    return (typeof c === "function" ? c() : c) || null;
  } catch (e) {
    log(`connector unavailable: ${e.message}`);
    return null;
  }
}

/** The fleet, same three cases. */
function fleetMod() {
  try {
    const f = deps.fleet;
    return (typeof f === "function" ? f() : f) || null;
  } catch (e) {
    log(`fleet unavailable: ${e.message}`);
    return null;
  }
}

function busClients() {
  const c = bus();
  if (!c || typeof c.getClients !== "function") return [];
  try {
    const list = c.getClients();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    log(`connector.getClients failed: ${e.message}`);
    return [];
  }
}

function isPresent(appId) {
  const c = bus();
  if (!c || typeof c.isPresent !== "function") return false;
  try {
    return Boolean(c.isPresent(appId));
  } catch (e) {
    log(`connector.isPresent(${appId}) failed: ${e.message}`);
    return false;
  }
}

function requestShutdown(appId) {
  const c = bus();
  if (!c || typeof c.requestShutdown !== "function") return false;
  try {
    return Boolean(c.requestShutdown(appId));
  } catch (e) {
    log(`connector.requestShutdown(${appId}) failed: ${e.message}`);
    return false;
  }
}

/** `process.kill(pid, 0)` — sends nothing, only asks whether it would land. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM"); // running, just not ours to signal
  }
}

function killTree(pid, signal) {
  const fn =
    typeof deps.killTree === "function"
      ? deps.killTree
      : // eslint-disable-next-line global-require
        require("./install/util").killTree;
  try {
    return Boolean(fn(pid, signal));
  } catch (e) {
    log(`killTree(${pid}) failed: ${e.message}`);
    return false;
  }
}

/**
 * SPEC step 2: "jobs.noteHubStop(...) BEFORE killTree". The attribution is not
 * optional — without it a user pressing Stop three times trips the crash-loop
 * banner and suspends keepAlive for a perfectly healthy app. It is written once
 * at the TOP of the ladder rather than beside the signal, so the polite path
 * (the app exits by itself, code 0) is attributed too: that is the exact case
 * the watchdog would otherwise treat as an unexplained exit worth restarting.
 */
function noteHubStop(o) {
  const jobs = deps.jobs;
  if (!jobs || typeof jobs.noteHubStop !== "function") return null;
  try {
    return jobs.noteHubStop(o);
  } catch (e) {
    log(`noteHubStop failed: ${e.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (t && typeof t.unref === "function") t.unref();
  });
}

/** Wait for an app to disappear from the bus, up to `ms`. */
async function waitForDeparture(appId, ms) {
  const { pollMs } = timing();
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    if (!isPresent(appId)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  return !isPresent(appId);
}

function lower(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

function appNameFor(appId, fallback) {
  const d = deps.discovery;
  if (d && typeof d.findApp === "function") {
    try {
      const app = d.findApp(appId);
      if (app && app.name) return String(app.name);
    } catch (e) {
      log(`discovery.findApp(${appId}) failed: ${e.message}`);
    }
  }
  return fallback || String(appId);
}

/** The canonical (discovery) id for whatever the bus called an app. */
function canonicalId(appId) {
  const d = deps.discovery;
  if (d && typeof d.findApp === "function") {
    try {
      const app = d.findApp(appId);
      if (app && app.id) return String(app.id);
    } catch (_) {
      /* fall through to the id as reported */
    }
  }
  return String(appId);
}

function keyOf(appId, artifactId) {
  return `${lower(appId)}::${artifactId || ""}`;
}

/* ------------------------------------------------------------------ */
/* list — the union of two truths                                      */
/* ------------------------------------------------------------------ */

/** Launches this hub started and is still watching (jobs launch tracking). */
function hubRows() {
  const jobs = deps.jobs;
  if (!jobs) return [];
  let entries = [];
  try {
    if (typeof jobs.listTracked === "function") entries = jobs.listTracked();
    else if (jobs._tracked && typeof jobs._tracked.values === "function") entries = [...jobs._tracked.values()];
  } catch (e) {
    log(`launch tracking unreadable: ${e.message}`);
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && e.appId)
    .map((e) => ({
      appId: String(e.appId),
      appName: e.appName || null,
      artifactId: e.artifactId || null,
      version: e.version == null ? null : String(e.version),
      pid: Number.isInteger(e.pid) && e.pid > 0 ? e.pid : null,
      since: epochMs(e.startedAt),
      source: "hub",
    }));
}

/**
 * A start time as epoch ms, from whatever a client felt like sending.
 *
 * The bus carries `since` as epoch ms today, but the value crosses a wire from
 * programs this hub does not own — and one of them sending an ISO string is far
 * likelier than one sending nonsense. `Number("2026-08-22T…")` is NaN, which
 * would silently drop the row's start time and make the UI say "started by the
 * hub" instead of "3 minutes ago". Accept both; refuse anything else.
 */
function epochMs(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n; // "1787398159946"
    const t = Date.parse(v); // "2026-08-22T11:36:03.867Z"
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

/** Whoever said hello to the connector bus. `artifactId` is unknowable here. */
function busRowsOf(clients) {
  return clients
    .filter((c) => c && c.app)
    .map((c) => ({
      appId: canonicalId(c.app),
      appName: null,
      artifactId: null,
      version: c.version == null ? null : String(c.version),
      pid: Number.isInteger(c.pid) && c.pid > 0 ? c.pid : null,
      since: epochMs(c.since),
      source: "bus",
    }));
}

/**
 * Everything running right now, newest first:
 *
 *   {appId, appName, artifactId|null, version, pid|null, since,
 *    source: "hub"|"bus"|"both", canStop}
 *
 * One entry per (appId, artifactId): a hub launch that is ALSO on the bus is
 * "both", never two rows. Bus app ids are matched case-insensitively against
 * hub app ids — the wire carries whatever the app typed at hello.
 *
 * When one app has several hub-launched artifacts and one bus client, the bus
 * client is folded into the NEWEST launch: the hello almost certainly belongs
 * to the process the user just started, and the wire carries no artifact id to
 * do better with.
 *
 * Never throws. A dead connector, an empty hub, no deps at all → [].
 */
function list() {
  let rows = [];
  try {
    rows = hubRows();
  } catch (e) {
    log(`list() could not read hub launches: ${e.message}`);
    rows = [];
  }

  // Two launches of the same app+artifact (a recycled pid, a re-launch the
  // watcher has not scored yet) collapse onto the newest.
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.appId, row.artifactId);
    const seen = byKey.get(key);
    if (!seen || (row.since || 0) > (seen.since || 0)) byKey.set(key, row);
  }
  const merged = [...byKey.values()];

  let clients = [];
  try {
    clients = busRowsOf(busClients());
  } catch (e) {
    log(`list() could not read the bus: ${e.message}`);
    clients = [];
  }

  for (const client of clients) {
    const candidates = merged
      .filter((r) => r.source === "hub" && lower(r.appId) === lower(client.appId))
      .sort((a, b) => (b.since || 0) - (a.since || 0));
    const host = candidates[0];
    if (host) {
      host.source = "both";
      // The hub knows WHICH build it started; the bus does not. Its version is
      // only a fallback for a launch that never recorded one.
      if (host.version == null) host.version = client.version;
      if (host.pid == null) host.pid = client.pid;
      // Keep the older `since`: presence that predates the launch record (the
      // hub restarted under a still-running app) is the truer start time.
      if (client.since != null && (host.since == null || client.since < host.since)) host.since = client.since;
      continue;
    }
    merged.push(client);
  }

  const out = merged.map((row) => {
    const onBus = row.source !== "hub";
    return {
      appId: row.appId,
      appName: appNameFor(row.appId, row.appName),
      artifactId: row.artifactId || null,
      version: row.version == null ? null : row.version,
      pid: row.pid == null ? null : row.pid,
      since: row.since == null ? null : row.since,
      source: row.source,
      // SPEC: false only when there is neither a live pid nor bus presence.
      canStop: Boolean(onBus || alive(row.pid)),
    };
  });

  // Newest first. Ordinal tie-break on the id — the host may run any locale.
  out.sort((a, b) => (b.since || 0) - (a.since || 0) || (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0));
  return out;
}

/** The row `stop()` would act on, or null. */
function targetFor(appId, artifactId) {
  const rows = list();
  const wanted = lower(appId);
  const matches = rows.filter((r) => lower(r.appId) === wanted);
  if (!matches.length) return null;
  if (artifactId) return matches.find((r) => r.artifactId === artifactId) || null;
  // No artifact named: prefer a row we can actually act on, newest first.
  return matches.find((r) => r.canStop) || matches[0];
}

/* ------------------------------------------------------------------ */
/* stop — the ladder                                                   */
/* ------------------------------------------------------------------ */

function ackError(ack) {
  if (!ack || typeof ack !== "object") return null;
  const msg = ack.error || ack.message || ack.reason;
  return msg ? String(msg) : null;
}

/**
 * SPEC step 3: the ONLY thing that reaches another machine. Taken first on
 * purpose — a {peer} stop is ABOUT that machine, so running the local ladder
 * ahead of it would end the local copy of the app instead.
 */
async function remoteStop(appId, artifactId, peer) {
  const base = { pid: null, appId, artifactId: artifactId || null, appName: appNameFor(appId, null), peer };
  const f = fleetMod();
  if (!f || typeof f.remoteStop !== "function") {
    log(`stop ${appId} on ${peer}: ${FLEET_MISSING}`);
    return Object.assign({ ok: false, how: "remote", error: FLEET_MISSING }, base);
  }
  try {
    const ack = await f.remoteStop(peer, appId);
    if (!ack || ack.ok === false) {
      const error = ackError(ack) || "the peer refused the stop";
      log(`stop ${appId} on ${peer}: ${error}`);
      return Object.assign({ ok: false, how: "remote", error }, base);
    }
    return Object.assign({ ok: true, how: "remote", remoteHow: ack.how || null }, base);
  } catch (e) {
    log(`stop ${appId} on ${peer}: ${e.message}`);
    return Object.assign({ ok: false, how: "remote", error: e.message }, base);
  }
}

/**
 * End one app. → {ok, how, pid, appId, artifactId, appName}
 * `how` ∈ shutdown-request | sigterm | remote | gone | not-running.
 *
 *   1. on the bus  → requestShutdown, then wait up to shutdownWaitMs for the
 *      client to leave. A client that ignores the request is not an error; it
 *      falls through to (2).
 *   2. still there and a pid is known → noteHubStop BEFORE killTree(SIGTERM).
 *   3. {peer} → fleet.remoteStop.
 *   4. nothing running → {ok: false, how: "not-running"}.
 *
 * Never SIGKILL. Never throws.
 */
async function stop(appId, artifactId, opts = {}) {
  const id = String(appId == null ? "" : appId).trim();
  const wanted = artifactId == null || artifactId === "" ? null : String(artifactId);
  const peer = opts && opts.peer ? opts.peer : null;

  if (!id) return { ok: false, how: "not-running", pid: null, appId: id, artifactId: wanted, appName: id };
  if (peer) return remoteStop(id, wanted, peer);

  let target = null;
  try {
    target = targetFor(id, wanted);
  } catch (e) {
    log(`stop(${id}) could not read the world: ${e.message}`);
    target = null;
  }

  const onBus = isPresent(id);
  const pid = target && Number.isInteger(target.pid) && target.pid > 0 ? target.pid : null;
  const artifact = target ? target.artifactId : wanted;
  const verdict = (ok, how) => ({
    ok,
    how,
    pid,
    appId: target ? target.appId : id,
    artifactId: artifact || null,
    appName: target ? target.appName : appNameFor(id, null),
  });

  if (!onBus && pid == null) return verdict(false, "not-running");

  // BEFORE anything that could make the process exit — see noteHubStop above.
  // Attributed under the id the LAUNCH RECORD uses (jobs keys its hub-stop
  // window on that), not necessarily the one the caller typed.
  noteHubStop({ appId: target ? target.appId : id, artifactId: artifact || null, pid });

  const { shutdownWaitMs } = timing();
  if (onBus && requestShutdown(id)) {
    const gone = await waitForDeparture(id, shutdownWaitMs);
    if (gone) {
      log(`stop ${id}: left the bus on request`);
      return verdict(true, "shutdown-request");
    }
  }

  if (pid == null) {
    // We asked, it stayed, and the hub never learned a pid to signal (a
    // bus-only client that reported none). Still running → not a success.
    log(`stop ${id}: still on the bus and no pid to signal`);
    return verdict(false, "shutdown-request");
  }

  if (!alive(pid)) {
    log(`stop ${id}: pid ${pid} was already gone`);
    return verdict(true, "gone");
  }

  // SPEC: never SIGKILL — stopping an app is polite by definition.
  const signalled = killTree(pid, "SIGTERM");
  log(`stop ${id}: ${signalled ? `SIGTERM → ${pid}` : `pid ${pid} vanished`}`);
  return verdict(true, signalled ? "sigterm" : "gone");
}

module.exports = {
  init,
  list,
  stop,
  // exposed for tests / callers that want the same tolerant helpers
  targetFor,
  waitForDeparture,
  DEFAULT_TIMING,
  FLEET_MISSING,
};
