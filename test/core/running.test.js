"use strict";
// SPEC v0.11 "stop" — src/main/running.js ([stopper]).
//
// Two halves, the same shape stacks.test.js uses:
//   1. the union and the ladder against injected fakes, so every rung and every
//      `how` is checked exactly;
//   2. REAL processes for the two claims that are worthless when faked — that
//      SIGTERM actually ends a child, and that an app the user stopped is not
//      resurrected by the watchdog.
//
// Every pid signalled here belongs to a child THIS FILE spawned, in a temp cwd.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const jobs = require("../../src/main/jobs");
const running = require("../../src/main/running");
const supervisor = require("../../src/main/supervisor");

/* ---------------------------------------------------------------- fakes */

/** jobs launch tracking, as running.js reads it. */
function fakeJobs(rows = []) {
  const api = {
    rows: rows.slice(),
    stops: [],
    listTracked: () => api.rows.slice(),
    noteHubStop(o) {
      const at = Date.now();
      api.stops.push(Object.assign({ at }, o));
      return at;
    },
  };
  return api;
}

/** A bus whose roster the test can flip at will. */
function fakeConnector(clients = []) {
  const api = {
    clients: clients.slice(),
    shutdowns: [],
    /** accepts the request but the client never leaves */
    stubborn: false,
    /** requestShutdown refuses outright (no such client, dead socket) */
    refuse: false,
    getClients: () => api.clients.map((c) => Object.assign({}, c)),
    isPresent(appId) {
      const wanted = String(appId).toLowerCase();
      return api.clients.some((c) => String(c.app).toLowerCase() === wanted);
    },
    requestShutdown(appId) {
      api.shutdowns.push(appId);
      if (api.refuse) return false;
      if (!api.isPresent(appId)) return false;
      if (!api.stubborn) api.leave(appId);
      return true;
    },
    leave(appId) {
      const wanted = String(appId).toLowerCase();
      api.clients = api.clients.filter((c) => String(c.app).toLowerCase() !== wanted);
    },
  };
  return api;
}

function client(app, over = {}) {
  return Object.assign({ app, version: "1.0.0", pid: null, since: 1000, lastSeen: 2000, fields: {} }, over);
}

function launch(appId, over = {}) {
  return Object.assign(
    { appId, appName: null, artifactId: "archive-dir-linux", version: "1.4.0", pid: null, startedAt: 5000, mode: "child" },
    over
  );
}

function fakeDiscovery(apps = []) {
  return { findApp: (id) => apps.find((a) => a.id === String(id).toLowerCase()) || null };
}

/** Wire running.js up for one test and put it back afterwards. */
function setup(t, over = {}) {
  const kills = [];
  const deps = Object.assign(
    {
      connector: null,
      jobs: fakeJobs(),
      config: { log: () => {} },
      discovery: null,
      fleet: null,
      killTree: (pid, signal) => {
        kills.push({ pid, signal, at: Date.now() });
        return true;
      },
      timing: { shutdownWaitMs: 300, pollMs: 10 },
    },
    over
  );
  running.init(deps);
  t.after(() => {
    // Leave the singleton inert for whatever test runs next.
    running.init({ connector: null, jobs: null, config: null, discovery: null, fleet: null, killTree: null, timing: {} });
  });
  return Object.assign({ kills }, deps);
}

/* ------------------------------------------------------------ processes */

/** A real child in a temp cwd that stays up until it is signalled. */
function spawnSleeper(t) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "nxhub-running-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", cwd: dir });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
  return { child, pid: child.pid, exited, dir };
}

/** A pid that is certainly dead: a child we spawned and reaped. */
async function deadPid(t) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "nxhub-running-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", cwd: dir });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitFor(fn, what, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------------------------------------------ */
/* list — the union of two truths                                      */
/* ------------------------------------------------------------------ */

test("running: nothing running at all is an empty array, not a throw", (t) => {
  setup(t);
  assert.deepStrictEqual(running.list(), []);
});

test("running: a hub launch alone is one `hub` row", (t) => {
  const sleeper = spawnSleeper(t);
  setup(t, { jobs: fakeJobs([launch("wivrn-nx", { pid: sleeper.pid, appName: "WiVRn NX" })]) });

  const rows = running.list();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(
    { appId: rows[0].appId, appName: rows[0].appName, artifactId: rows[0].artifactId, source: rows[0].source },
    { appId: "wivrn-nx", appName: "WiVRn NX", artifactId: "archive-dir-linux", source: "hub" }
  );
  assert.strictEqual(rows[0].pid, sleeper.pid);
  assert.strictEqual(rows[0].version, "1.4.0");
  assert.strictEqual(rows[0].since, 5000);
  assert.strictEqual(rows[0].canStop, true, "a live pid can be stopped");
});

test("running: a bus client alone is one `bus` row with no artifact id", (t) => {
  setup(t, { connector: fakeConnector([client("pulsenx", { pid: 4242, version: "2.0.0", since: 700 })]) });

  const rows = running.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, "bus");
  assert.strictEqual(rows[0].artifactId, null, "the hub did not start it and cannot know the build");
  assert.strictEqual(rows[0].version, "2.0.0");
  assert.strictEqual(rows[0].pid, 4242);
  assert.strictEqual(rows[0].since, 700);
  assert.strictEqual(rows[0].canStop, true, "bus presence alone is enough to stop");
});

test("running: a bus `since` may arrive as epoch ms, an ISO string, or garbage", (t) => {
  // `since` crosses a wire from programs this hub does not own. Epoch ms is what
  // the bus sends today, but an ISO string is the likeliest thing a third-party
  // client gets "wrong", and Number() would turn it into NaN — silently costing
  // the row its start time, so the UI says "started by the hub" instead of "3
  // minutes ago". Both are accepted; anything else is refused outright.
  setup(t, {
    connector: fakeConnector([
      client("epoch-app", { since: 1787398159946 }),
      client("iso-app", { since: "2026-08-22T11:36:03.867Z" }),
      client("numeric-string-app", { since: "1787398159946" }),
      client("junk-app", { since: "whenever" }),
      client("negative-app", { since: -5 }),
    ]),
  });

  const by = Object.fromEntries(running.list().map((r) => [r.appId, r.since]));
  assert.strictEqual(by["epoch-app"], 1787398159946);
  assert.strictEqual(by["iso-app"], Date.parse("2026-08-22T11:36:03.867Z"));
  assert.strictEqual(by["numeric-string-app"], 1787398159946);
  assert.strictEqual(by["junk-app"], null, "an unparseable time is no time, never NaN");
  assert.strictEqual(by["negative-app"], null);
});

test("running: a hub launch that is also on the bus is ONE `both` row", (t) => {
  const connector = fakeConnector([client("WiVRn-NX", { pid: 999, version: "9.9.9", since: 1000 })]);
  setup(t, {
    connector,
    jobs: fakeJobs([launch("wivrn-nx", { pid: 321, startedAt: 5000 })]),
  });

  const rows = running.list();
  assert.strictEqual(rows.length, 1, "never two rows for the same app");
  const row = rows[0];
  assert.strictEqual(row.source, "both");
  assert.strictEqual(row.appId, "wivrn-nx", "the bus id is matched case-insensitively");
  assert.strictEqual(row.artifactId, "archive-dir-linux", "the hub knows which build it started");
  assert.strictEqual(row.version, "1.4.0", "the hub's version wins over the bus's");
  assert.strictEqual(row.pid, 321, "the hub's pid wins");
  assert.strictEqual(row.since, 1000, "the older `since` (the bus's) is kept");
});

test("running: a bus `since` NEWER than the launch does not overwrite it", (t) => {
  setup(t, {
    connector: fakeConnector([client("wivrn-nx", { since: 9000 })]),
    jobs: fakeJobs([launch("wivrn-nx", { startedAt: 5000, pid: null })]),
  });
  assert.strictEqual(running.list()[0].since, 5000);
});

test("running: two artifacts of one app stay two rows; the client folds into the newest", (t) => {
  setup(t, {
    connector: fakeConnector([client("wivrn-nx", { pid: 77, since: 9000 })]),
    jobs: fakeJobs([
      launch("wivrn-nx", { artifactId: "apk-adb-android", startedAt: 1000 }),
      launch("wivrn-nx", { artifactId: "tarball-prefix-linux", startedAt: 8000 }),
    ]),
  });

  const rows = running.list();
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.artifactId), ["tarball-prefix-linux", "apk-adb-android"], "newest first");
  assert.deepStrictEqual(rows.map((r) => r.source), ["both", "hub"]);
});

test("running: appName comes from discovery, and falls back to the id", (t) => {
  setup(t, {
    connector: fakeConnector([client("pulsenx"), client("mystery-app")]),
    discovery: fakeDiscovery([{ id: "pulsenx", name: "PulseNX" }]),
  });
  const byId = Object.fromEntries(running.list().map((r) => [r.appId, r.appName]));
  assert.deepStrictEqual(byId, { pulsenx: "PulseNX", "mystery-app": "mystery-app" });
});

test("running: canStop is false only with neither a live pid nor bus presence", async (t) => {
  const dead = await deadPid(t);
  setup(t, { jobs: fakeJobs([launch("zombie", { pid: dead })]) });
  const rows = running.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].canStop, false);
});

test("running: a dead connector or a broken jobs module still gives []", (t) => {
  setup(t, {
    connector: () => {
      throw new Error("the bus is on fire");
    },
    jobs: {
      listTracked() {
        throw new Error("no tracking here");
      },
    },
  });
  assert.deepStrictEqual(running.list(), []);
});

test("running: `_tracked` is read when a jobs module predates listTracked", (t) => {
  const map = new Map([[11, launch("legacy", { pid: 11 })]]);
  setup(t, { jobs: { _tracked: map, noteHubStop: () => 0 } });
  assert.deepStrictEqual(running.list().map((r) => r.appId), ["legacy"]);
});

/* ------------------------------------------------------------------ */
/* stop — the ladder                                                   */
/* ------------------------------------------------------------------ */

test("running: stop asks the bus first and never signals a client that left", async (t) => {
  const sleeper = spawnSleeper(t);
  const connector = fakeConnector([client("wivrn-nx", { pid: sleeper.pid })]);
  const ctx = setup(t, { connector, jobs: fakeJobs([launch("wivrn-nx", { pid: sleeper.pid })]) });

  const result = await running.stop("wivrn-nx");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.how, "shutdown-request");
  assert.strictEqual(result.pid, sleeper.pid);
  assert.strictEqual(result.appId, "wivrn-nx");
  assert.strictEqual(result.artifactId, "archive-dir-linux");
  assert.deepStrictEqual(connector.shutdowns, ["wivrn-nx"]);
  assert.deepStrictEqual(ctx.kills, [], "a polite exit is the app's own business");
});

test("running: a stubborn client falls through to SIGTERM — and never SIGKILL", async (t) => {
  const connector = fakeConnector([client("stubborn", { pid: 5150 })]);
  connector.stubborn = true;
  const ctx = setup(t, { connector, jobs: fakeJobs([launch("stubborn", { pid: 5150 })]) });
  // `alive` must say yes for the ladder to reach the signal: this process is.
  const self = process.pid;
  ctx.jobs.rows = [launch("stubborn", { pid: self })];
  connector.clients = [client("stubborn", { pid: self })];

  const started = Date.now();
  const result = await running.stop("stubborn");
  assert.ok(Date.now() - started >= 250, "it really waited out shutdownWaitMs");
  assert.strictEqual(result.how, "sigterm");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(ctx.kills.map((k) => k.signal), ["SIGTERM"]);
});

test("running: a client that refuses the request is not an error, just the next rung", async (t) => {
  const connector = fakeConnector([client("rude", { pid: process.pid })]);
  connector.refuse = true;
  const ctx = setup(t, { connector, jobs: fakeJobs() });

  const result = await running.stop("rude");
  assert.strictEqual(result.how, "sigterm");
  assert.strictEqual(result.pid, process.pid, "the pid came from the bus hello");
  assert.deepStrictEqual(ctx.kills.map((k) => k.pid), [process.pid]);
});

test("running: SIGTERM really ends a real child", async (t) => {
  const sleeper = spawnSleeper(t);
  setup(t, {
    jobs: fakeJobs([launch("realtest", { pid: sleeper.pid })]),
    killTree: null, // the REAL install/util.killTree
  });
  assert.ok(alive(sleeper.pid), "precondition: it is running");

  const result = await running.stop("realtest");
  assert.strictEqual(result.how, "sigterm");
  assert.strictEqual(result.ok, true);
  const { signal } = await sleeper.exited;
  assert.strictEqual(signal, "SIGTERM", "polite, and never SIGKILL");
  assert.strictEqual(alive(sleeper.pid), false);
});

test("running: a pid that is already dead is `gone`, and a success", async (t) => {
  const dead = await deadPid(t);
  const ctx = setup(t, { jobs: fakeJobs([launch("ghost", { pid: dead })]) });

  const result = await running.stop("ghost");
  assert.deepStrictEqual(
    { ok: result.ok, how: result.how, pid: result.pid },
    { ok: true, how: "gone", pid: dead }
  );
  assert.deepStrictEqual(ctx.kills, [], "nothing to signal");
});

test("running: an app nobody is running is `not-running`, and nothing is noted", async (t) => {
  const ctx = setup(t, { connector: fakeConnector([client("someone-else")]), jobs: fakeJobs() });

  const result = await running.stop("wivrn-nx");
  assert.deepStrictEqual(
    { ok: result.ok, how: result.how, pid: result.pid, appId: result.appId },
    { ok: false, how: "not-running", pid: null, appId: "wivrn-nx" }
  );
  assert.deepStrictEqual(ctx.jobs.stops, [], "a stop that did not happen is not attributed");
  assert.deepStrictEqual(ctx.kills, []);
  assert.deepStrictEqual((await running.stop("")).how, "not-running");
});

test("running: on the bus, ignoring the request, with no pid → still running, not ok", async (t) => {
  const connector = fakeConnector([client("headless", { pid: null })]);
  connector.stubborn = true;
  const ctx = setup(t, { connector, jobs: fakeJobs() });

  const result = await running.stop("headless");
  assert.strictEqual(result.ok, false, "the process is still there — the CLI exits 2 on this");
  assert.strictEqual(result.how, "shutdown-request");
  assert.strictEqual(result.pid, null);
  assert.deepStrictEqual(ctx.kills, []);
});

test("running: an artifact id that is not running is not-running, even when the app is", async (t) => {
  const ctx = setup(t, { jobs: fakeJobs([launch("wivrn-nx", { artifactId: "apk-adb-android", pid: process.pid })]) });
  const result = await running.stop("wivrn-nx", "tarball-prefix-linux");
  assert.strictEqual(result.how, "not-running");
  assert.deepStrictEqual(ctx.kills, []);
});

/* --------------------------------------------------- the ordering rule */

test("running: noteHubStop is written BEFORE the signal leaves", async (t) => {
  const order = [];
  const stops = [];
  const kills = [];
  running.init({
    connector: null,
    config: { log: () => {} },
    discovery: null,
    fleet: null,
    timing: { shutdownWaitMs: 50, pollMs: 10 },
    jobs: {
      listTracked: () => [launch("attributed", { pid: process.pid })],
      noteHubStop(o) {
        const at = process.hrtime.bigint();
        order.push("noteHubStop");
        stops.push({ at, o });
        return Date.now();
      },
    },
    killTree(pid, signal) {
      kills.push({ at: process.hrtime.bigint(), pid, signal });
      order.push("killTree");
      return true;
    },
  });
  t.after(() => running.init({ jobs: null, killTree: null, timing: {} }));

  const result = await running.stop("attributed", "archive-dir-linux");
  assert.strictEqual(result.how, "sigterm");
  assert.deepStrictEqual(order, ["noteHubStop", "killTree"], "flip these and keepAlive fights the user");
  assert.ok(stops[0].at < kills[0].at, "the attribution is timestamped before the signal");
  assert.deepStrictEqual(stops[0].o, { appId: "attributed", artifactId: "archive-dir-linux", pid: process.pid });
});

test("running: the polite rung is attributed too — the app exits itself", async (t) => {
  const connector = fakeConnector([client("polite", { pid: 1234 })]);
  const ctx = setup(t, { connector, jobs: fakeJobs([launch("polite", { pid: 1234 })]) });

  await running.stop("polite");
  assert.strictEqual(ctx.jobs.stops.length, 1, "without this the watchdog restarts a clean exit");
  assert.strictEqual(ctx.jobs.stops[0].appId, "polite");
});

/* ------------------------------------------------------------- remote */

test("running: {peer} goes to fleet.remoteStop and nowhere near a local pid", async (t) => {
  const calls = [];
  const ctx = setup(t, {
    connector: fakeConnector([client("wivrn-nx", { pid: process.pid })]),
    jobs: fakeJobs([launch("wivrn-nx", { pid: process.pid })]),
    fleet: {
      remoteStop: async (peerId, appId) => {
        calls.push({ peerId, appId });
        return { ok: true, how: "shutdown-request", pids: [77] };
      },
    },
  });

  const result = await running.stop("wivrn-nx", null, { peer: "workshop" });
  assert.deepStrictEqual({ ok: result.ok, how: result.how, pid: result.pid }, { ok: true, how: "remote", pid: null });
  assert.strictEqual(result.remoteHow, "shutdown-request");
  assert.deepStrictEqual(calls, [{ peerId: "workshop", appId: "wivrn-nx" }]);
  assert.deepStrictEqual(ctx.kills, [], "a peer stop never touches this machine");
  assert.deepStrictEqual(ctx.jobs.stops, [], "…and never attributes a local stop");
});

test("running: a peer that refuses, throws, or is not there comes back ok:false", async (t) => {
  setup(t, { fleet: { remoteStop: async () => ({ ok: false, error: "unknown app" }) } });
  const refused = await running.stop("wivrn-nx", null, { peer: "workshop" });
  assert.deepStrictEqual({ ok: refused.ok, how: refused.how, error: refused.error }, { ok: false, how: "remote", error: "unknown app" });

  setup(t, {
    fleet: {
      remoteStop: async () => {
        throw new Error("workshop did not answer in time.");
      },
    },
  });
  const thrown = await running.stop("wivrn-nx", null, { peer: "workshop" });
  assert.strictEqual(thrown.ok, false);
  assert.match(thrown.error, /did not answer/);

  setup(t, { fleet: null });
  const noFleet = await running.stop("wivrn-nx", null, { peer: "workshop" });
  assert.strictEqual(noFleet.ok, false);
  assert.strictEqual(noFleet.error, running.FLEET_MISSING);
});

/* ------------------------------------------------------------------ */
/* the watchdog must not undo the user                                 */
/* ------------------------------------------------------------------ */

const KEEPY = { id: "keepy", name: "Keepy", repo: "nerdrx/keepy" };
const KEEPY_ARTIFACT = "archive-dir-linux";
const FAST = { backoff: [20, 40, 80], healthyMs: 5000, windowMs: 2000, maxRestarts: 3, byeWindowMs: 5000 };

/** The real jobs launch-exit stream, with a supervisor whose launches are recorded. */
function watchdogHarness(t) {
  const env = helpers.useTempEnv();
  jobs._reset();
  jobs.init({ emit: () => {} });
  const launches = [];
  const supJobs = {
    onLaunchExit: (fn) => jobs.onLaunchExit(fn),
    isTracked: (a, b) => jobs.isTracked(a, b),
    async launch(appId, artifactId) {
      launches.push({ appId, artifactId });
      return { pid: 1 };
    },
  };
  supervisor.init({
    jobs: supJobs,
    connector: null,
    config: {
      load: () => ({ appPrefs: { keepy: { keepAlive: true } } }),
      getAppPref: (settings, appId) => (settings.appPrefs || {})[appId] || {},
      log: () => {},
    },
    emit: () => {},
    log: () => {},
    timing: FAST,
  });
  t.after(() => {
    supervisor.stop();
    jobs._reset();
    env.cleanup();
  });
  return { launches, env };
}

test("running: a crash under keepAlive IS restarted (the control for the next test)", async (t) => {
  const h = watchdogHarness(t);
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "nxhub-running-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore", cwd: dir });
  jobs.trackLaunch({ appId: KEEPY.id, appName: KEEPY.name, artifactId: KEEPY_ARTIFACT, version: "1.0.0", pid: child.pid, child });

  await waitFor(() => h.launches.length, "the watchdog to put it back");
  assert.deepStrictEqual(h.launches[0], { appId: KEEPY.id, artifactId: KEEPY_ARTIFACT });
});

test("running: an app the USER stopped stays stopped — keepAlive does not undo it", async (t) => {
  const h = watchdogHarness(t);
  const sleeper = spawnSleeper(t);
  jobs.trackLaunch({
    appId: KEEPY.id,
    appName: KEEPY.name,
    artifactId: KEEPY_ARTIFACT,
    version: "1.0.0",
    pid: sleeper.pid,
    child: sleeper.child,
  });

  running.init({ connector: null, jobs, config, discovery: null, fleet: null, killTree: null, timing: {} });
  t.after(() => running.init({ jobs: null, killTree: null, timing: {} }));

  const rows = running.list();
  assert.deepStrictEqual(rows.map((r) => `${r.appId}/${r.artifactId}/${r.source}`), [`keepy/${KEEPY_ARTIFACT}/hub`]);

  const result = await running.stop(KEEPY.id, KEEPY_ARTIFACT);
  assert.strictEqual(result.how, "sigterm");
  const { signal } = await sleeper.exited;
  assert.strictEqual(signal, "SIGTERM");

  // Well past the fast ladder's first two rungs (20ms + 40ms).
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(h.launches, [], "the user pressed Stop — it must stay stopped");
  assert.deepStrictEqual(running.list(), [], "and it is gone from the running list");
});

/* ------------------------------------------------------------------ */
/* the IPC surface [stop-ui] reads                                     */
/* ------------------------------------------------------------------ */

// LAST in the file on purpose: ipc.js wires the running singleton to the REAL
// modules the first time it is asked, which would outlive a fake above it.
test("running: getState().running is always an array, and stopApp answers a verdict", async (t) => {
  const env = helpers.useTempEnv();
  // eslint-disable-next-line global-require
  const ipc = require("../../src/main/ipc");
  // eslint-disable-next-line global-require
  const discovery = require("../../src/main/discovery");
  jobs._reset();
  discovery._setCached({ apps: [], adb: {}, errors: [], refreshing: false, lastRefresh: null });
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });

  const state = await ipc.buildState();
  assert.ok(Array.isArray(state.running), "a renderer never has to ask whether this build can stop things");
  assert.deepStrictEqual(state.running, []);

  const verdict = await ipc.stopApp("nothing-here");
  assert.deepStrictEqual(
    { ok: verdict.ok, how: verdict.how, pid: verdict.pid, appId: verdict.appId },
    { ok: false, how: "not-running", pid: null, appId: "nothing-here" }
  );
});
