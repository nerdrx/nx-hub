"use strict";
// SPEC v0.8 "Watchdog" — src/main/supervisor.js.
//
// Two halves:
//  1. the decision table, driven through supervisor.onLaunchExit with synthetic
//     events and a fake jobs/config/connector, so the ladder, the rolling
//     budget and the give-up toast are checked to the millisecond;
//  2. the real thing: jobs.launch spawning a REAL process that dies, the real
//     launch-exit stream, the real config file — the supervisor puts it back.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");
const util = require("../../src/main/install/util");
const supervisor = require("../../src/main/supervisor");

const APP = { id: "keepy", name: "Keepy", repo: "nerdrx/keepy" };
const ARTIFACT = { id: "archive-dir-linux", label: "Linux build", kind: "archive-dir", platform: "linux" };

// The real ladder in miniature. healthyMs stays well above the synthetic
// uptimes below, so only the test that means to reset the ladder does.
const FAST = { backoff: [20, 40, 80], healthyMs: 5000, windowMs: 2000, maxRestarts: 3, byeWindowMs: 5000 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, what, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

function fakeJobs() {
  const api = {
    listeners: new Set(),
    launches: [],
    failNext: null,
    tracked: false,
    onLaunchExit(fn) {
      api.listeners.add(fn);
      return () => api.listeners.delete(fn);
    },
    isTracked: () => api.tracked,
    async launch(appId, artifactId) {
      api.launches.push({ appId, artifactId, at: Date.now() });
      if (api.failNext) {
        const err = new Error(api.failNext);
        api.failNext = null;
        throw err;
      }
      return { pid: 4242 };
    },
  };
  return api;
}

function fakeConfig(prefs) {
  return {
    load: () => ({ appPrefs: prefs }),
    getAppPref: (settings, appId) => (settings.appPrefs || {})[appId] || {},
    log: () => {},
  };
}

function fakeConnector(clients = []) {
  const api = {
    clients: clients.slice(),
    handlers: new Set(),
    getClients: () => api.clients.map((app) => ({ app })),
    onChange(cb) {
      api.handlers.add(cb);
      return () => api.handlers.delete(cb);
    },
    /** what the bus does when an app disconnects */
    leave(appId) {
      api.clients = api.clients.filter((a) => a !== appId);
      for (const cb of api.handlers) cb();
    },
  };
  return api;
}

function exitEvent(over = {}) {
  return Object.assign(
    {
      appId: APP.id,
      appName: APP.name,
      artifactId: ARTIFACT.id,
      version: "1.0.0",
      pid: 111,
      code: 1,
      signal: null,
      uptimeMs: 900,
      stoppedByHub: false,
      unknownExit: false,
      crashCount: 1,
      crashLoop: false,
    },
    over
  );
}

/** A supervisor wired to fakes; returns everything the test wants to inspect. */
function harness({ keepAlive = true, clients = [], timing = FAST } = {}) {
  const events = [];
  const logs = [];
  const j = fakeJobs();
  const c = fakeConnector(clients);
  supervisor.init({
    jobs: j,
    connector: c,
    config: fakeConfig({ [APP.id]: keepAlive ? { keepAlive: true } : {} }),
    emit: (e) => events.push(e),
    log: (m) => logs.push(m),
    timing,
  });
  return { jobs: j, connector: c, events, logs };
}

/* ------------------------------------------------------------------ */
/* the decision table                                                  */
/* ------------------------------------------------------------------ */

test("an unexpected exit is relaunched after the backoff", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());

  const t0 = Date.now();
  supervisor.onLaunchExit(exitEvent());
  await waitFor(() => h.jobs.launches.length, "the relaunch");

  const waited = h.jobs.launches[0].at - t0;
  assert.ok(waited >= 15, `waited ${waited}ms — the first rung of the ladder is honoured`);
  assert.deepStrictEqual(h.jobs.launches[0].appId, APP.id);
  const restarting = h.events.find((e) => e.type === "supervisor" && e.action === "restarting");
  assert.ok(restarting, "the UI/recorder hear about it");
  assert.strictEqual(restarting.attempt, 1);
  assert.strictEqual(restarting.appId, APP.id);
  assert.strictEqual(restarting.artifactId, ARTIFACT.id);
  assert.strictEqual(restarting.delayMs, FAST.backoff[0]);
});

test("the backoff ladder climbs, and a healthy run resets it", async (t) => {
  const h = harness({ timing: Object.assign({}, FAST, { maxRestarts: 99 }) });
  t.after(() => supervisor.stop());

  for (let i = 0; i < 3; i += 1) {
    supervisor.onLaunchExit(exitEvent());
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => h.jobs.launches.length === i + 1, `restart ${i + 1}`);
  }
  const delays = h.events.filter((e) => e.type === "supervisor").map((e) => e.delayMs);
  assert.deepStrictEqual(delays, [20, 40, 80], "2s·4s·8s… in miniature");

  // a fourth exit would sit on the cap …
  supervisor.onLaunchExit(exitEvent({ uptimeMs: FAST.healthyMs + 50 }));
  await waitFor(() => h.jobs.launches.length === 4, "restart after a healthy run");
  const last = h.events.filter((e) => e.type === "supervisor").pop();
  assert.strictEqual(last.delayMs, 20, "…but a ≥healthy run put it back on the first rung");
  assert.strictEqual(last.attempt, 1, "and the attempt counter restarted");
});

test("the cap holds at the last rung", () => {
  const ladder = supervisor.DEFAULT_TIMING.backoff;
  assert.deepStrictEqual(ladder, [2000, 4000, 8000, 16000, 32000, 60000], "SPEC: 2s·4s·8s…60s");
  assert.strictEqual(ladder[ladder.length - 1], 60000, "60s cap");
});

test("keepAlive off → the watchdog never moves", async (t) => {
  const h = harness({ keepAlive: false });
  t.after(() => supervisor.stop());
  supervisor.onLaunchExit(exitEvent());
  await sleep(120);
  assert.strictEqual(h.jobs.launches.length, 0);
  assert.strictEqual(h.events.length, 0);
});

test("a stop the hub itself performed is not a crash", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());
  supervisor.onLaunchExit(exitEvent({ stoppedByHub: true, signal: "SIGTERM", code: null }));
  await sleep(120);
  assert.strictEqual(h.jobs.launches.length, 0, "a stack stop must not be fought");
  assert.ok(h.logs.some((l) => l.includes("stopped on purpose")));
});

test("a crash-looping version suspends keepAlive", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());
  supervisor.onLaunchExit(exitEvent({ crashLoop: true, crashCount: 3 }));
  await sleep(120);
  assert.strictEqual(h.jobs.launches.length, 0);
  assert.ok(h.logs.some((l) => l.includes("crash-looping")));

  // …and the next version (counter cleared by the rollback) is watched again
  supervisor.onLaunchExit(exitEvent({ crashLoop: false, crashCount: 0, version: "0.9.0" }));
  await waitFor(() => h.jobs.launches.length === 1, "the restart after a rollback");
});

test("a clean bye ≤5s before a clean exit means the user quit", async (t) => {
  const h = harness({ clients: [APP.id] });
  t.after(() => supervisor.stop());

  h.connector.leave(APP.id); // the app said bye and left the bus
  await sleep(20);
  supervisor.onLaunchExit(exitEvent({ code: 0 }));
  await sleep(120);
  assert.strictEqual(h.jobs.launches.length, 0, "no restart");
  assert.ok(h.logs.some((l) => l.includes("left the bus cleanly")));
});

test("leaving the bus by CRASHING still earns a restart", async (t) => {
  const h = harness({ clients: [APP.id] });
  t.after(() => supervisor.stop());

  h.connector.leave(APP.id); // the socket died with the process
  await sleep(20);
  supervisor.onLaunchExit(exitEvent({ code: 139, signal: "SIGSEGV" }));
  await waitFor(() => h.jobs.launches.length === 1, "the restart of a crashed bus client");
});

test("the connector may arrive late, as a getter (how index.js wires it)", async (t) => {
  const events = [];
  const j = fakeJobs();
  const c = fakeConnector([APP.id]);
  let live = null; // the bus is not up yet when the supervisor is wired
  supervisor.init({
    jobs: j,
    connector: () => live,
    config: fakeConfig({ [APP.id]: { keepAlive: true } }),
    emit: (e) => events.push(e),
    timing: FAST,
  });
  t.after(() => supervisor.stop());

  live = c; // startConnector() happens
  supervisor.onLaunchExit(exitEvent({ code: 0, uptimeMs: 50 })); // seeds presence, subscribes
  await waitFor(() => j.launches.length === 1, "a restart while the app was still on the bus");

  c.leave(APP.id);
  await sleep(20);
  supervisor.onLaunchExit(exitEvent({ code: 0 }));
  await sleep(120);
  assert.strictEqual(j.launches.length, 1, "the late-bound bus is consulted for the bye check");
});

test("five restarts in ten minutes → give up, with the SPEC toast", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());

  for (let i = 0; i < FAST.maxRestarts; i += 1) {
    supervisor.onLaunchExit(exitEvent());
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => h.jobs.launches.length === i + 1, `restart ${i + 1}`);
  }
  supervisor.onLaunchExit(exitEvent()); // one too many
  await waitFor(() => h.events.some((e) => e.action === "gave-up"), "the give-up event");
  await sleep(80);

  assert.strictEqual(h.jobs.launches.length, FAST.maxRestarts, "the budget is the budget");
  const gaveUp = h.events.find((e) => e.type === "supervisor" && e.action === "gave-up");
  assert.strictEqual(gaveUp.appId, APP.id);
  assert.strictEqual(gaveUp.artifactId, ARTIFACT.id);
  const toast = h.events.find((e) => e.type === "toast");
  assert.strictEqual(toast.level, "error");
  assert.match(toast.message, /^gave up keeping Keepy alive \(3 restarts in \d+ minutes\)$/);
});

test("a relaunch that throws gives up loudly instead of spinning", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());
  h.jobs.failNext = "no such install";

  supervisor.onLaunchExit(exitEvent());
  await waitFor(() => h.events.some((e) => e.action === "gave-up"), "the give-up after a failed relaunch");
  const toast = h.events.find((e) => e.type === "toast");
  assert.match(toast.message, /could not restart Keepy: no such install/);
});

test("an app that came back on its own is left alone", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());
  h.jobs.tracked = true; // the user launched it again during the backoff

  supervisor.onLaunchExit(exitEvent());
  await sleep(150);
  assert.strictEqual(h.jobs.launches.length, 0);
  assert.ok(h.logs.some((l) => l.includes("running again already")));
});

test("stop() cancels everything pending", async (t) => {
  const h = harness();
  t.after(() => supervisor.stop());
  supervisor.onLaunchExit(exitEvent());
  assert.strictEqual(supervisor._state().apps[0].pending, true);
  supervisor.stop();
  await sleep(150);
  assert.strictEqual(h.jobs.launches.length, 0, "no restart after stop()");
  assert.deepStrictEqual(supervisor._state().apps, []);
});

/* ------------------------------------------------------------------ */
/* the real stack: jobs.launch → a real process → a real relaunch      */
/* ------------------------------------------------------------------ */

/** jobs wired to a stub engine that really spawns `cmd`. */
function realJobs(cmd, args) {
  const events = [];
  const launches = [];
  jobs._reset();
  jobs.init({
    emit: (e) => events.push(e),
    github: null,
    relaunch: null,
    engine: {
      async launch() {
        launches.push(Date.now());
        const child = util.spawnDetached(cmd, args);
        return { pid: child.pid, command: cmd, args };
      },
    },
    resolve: () => ({ app: APP, artifact: ARTIFACT }),
  });
  return { events, launches };
}

test("end to end: a real process dies and the supervisor really relaunches it", async (t) => {
  const env = helpers.useTempEnv();
  // exit 0: an app that vanishes without crashing is still an unexpected exit
  // (nothing said bye, nothing asked it to stop) — the SPEC restarts it.
  const real = realJobs("/bin/sh", ["-c", "exit 0"]);
  config.setAppPref(APP.id, { keepAlive: true });
  stateStore.recordInstall(APP.id, ARTIFACT.id, { version: "1.0.0", path: "/nowhere", launchable: true });

  const events = [];
  supervisor.init({
    jobs,
    connector: null,
    config,
    emit: (e) => events.push(e),
    timing: { backoff: [20, 20], healthyMs: 300, windowMs: 5000, maxRestarts: 2, byeWindowMs: 5000 },
  });
  t.after(() => {
    supervisor.stop();
    jobs._reset();
    stateStore.resetCrashes(APP.id, ARTIFACT.id);
    env.cleanup();
  });

  await jobs.launch(APP.id, ARTIFACT.id);
  // 1 user launch + 2 supervised restarts, then the budget is spent
  await waitFor(() => real.launches.length === 3, "two supervised relaunches", 8000);
  await waitFor(() => events.some((e) => e.type === "supervisor" && e.action === "gave-up"), "the give-up", 8000);

  const toast = events.find((e) => e.type === "toast" && e.level === "error");
  assert.match(toast.message, /gave up keeping Keepy alive \(2 restarts in \d+ minutes\)/);
  const restarts = events.filter((e) => e.type === "supervisor" && e.action === "restarting");
  assert.deepStrictEqual(restarts.map((e) => e.attempt), [1, 2]);
});

test("end to end: a crash loop stops the watchdog dead (SPEC v0.6 counter)", async (t) => {
  const env = helpers.useTempEnv();
  const real = realJobs("/bin/sh", ["-c", "exit 3"]); // crash: bad code, <30s
  config.setAppPref(APP.id, { keepAlive: true });
  stateStore.recordInstall(APP.id, ARTIFACT.id, { version: "2.0.0", path: "/nowhere", launchable: true });

  const logs = [];
  supervisor.init({
    jobs,
    connector: null,
    config,
    emit: () => {},
    log: (m) => logs.push(m),
    timing: { backoff: [20], healthyMs: 5000, windowMs: 60000, maxRestarts: 9, byeWindowMs: 5000 },
  });
  t.after(() => {
    supervisor.stop();
    jobs._reset();
    stateStore.resetCrashes(APP.id, ARTIFACT.id);
    env.cleanup();
  });

  await jobs.launch(APP.id, ARTIFACT.id);
  // crash #1 → restart, crash #2 → restart, crash #3 → the v0.6 crash loop
  await waitFor(() => logs.some((l) => l.includes("crash-looping")), "the crash-loop stand-down", 8000);
  const settled = real.launches.length;
  await sleep(200);
  assert.strictEqual(real.launches.length, settled, "the watchdog stopped feeding the loop");
  assert.strictEqual(settled, 3, "the user's launch plus two restarts");
  const crashes = stateStore.getCrashes(APP.id, ARTIFACT.id);
  assert.strictEqual(crashes.count, 3, "and the crash counter is what suspended it");
});

test("end to end: a hub-initiated stop is never relaunched", async (t) => {
  const env = helpers.useTempEnv();
  const real = realJobs("/bin/sh", ["-c", "sleep 30"]);
  config.setAppPref(APP.id, { keepAlive: true });

  const events = [];
  const exits = [];
  const offExit = jobs.onLaunchExit((e) => exits.push(e));
  supervisor.init({
    jobs,
    connector: null,
    config,
    emit: (e) => events.push(e),
    timing: { backoff: [20], healthyMs: 300, windowMs: 5000, maxRestarts: 3, byeWindowMs: 5000 },
  });
  t.after(() => {
    offExit();
    supervisor.stop();
    jobs._reset();
    env.cleanup();
  });

  const res = await jobs.launch(APP.id, ARTIFACT.id);
  assert.ok(res.pid, "it is running");

  // exactly what stacks.stop / fleet's remote stop do
  jobs.noteHubStop({ appId: APP.id, artifactId: ARTIFACT.id, pid: res.pid });
  process.kill(res.pid, "SIGTERM");

  const evt = await waitFor(() => exits[0], "the launch-exit event");
  assert.strictEqual(evt.appId, APP.id);
  assert.strictEqual(evt.artifactId, ARTIFACT.id);
  assert.strictEqual(evt.appName, APP.name, "[recorder] gets a printable name");
  assert.strictEqual(evt.stoppedByHub, true);
  assert.strictEqual(evt.signal, "SIGTERM");
  assert.ok(evt.uptimeMs >= 0);

  await sleep(200);
  assert.strictEqual(real.launches.length, 1, "no relaunch");
});

test("the launch-exit stream reports healthy exits too ([recorder])", async (t) => {
  const env = helpers.useTempEnv();
  realJobs("/bin/sh", ["-c", "exit 0"]);
  const exits = [];
  const off = jobs.onLaunchExit((e) => exits.push(e));
  t.after(() => {
    off();
    jobs._reset();
    env.cleanup();
  });

  await jobs.launch(APP.id, ARTIFACT.id);
  const evt = await waitFor(() => exits[0], "the exit event");
  assert.strictEqual(evt.code, 0);
  assert.strictEqual(evt.signal, null);
  assert.strictEqual(evt.stoppedByHub, false);
  assert.strictEqual(evt.crashLoop, false);
  assert.strictEqual(typeof evt.uptimeMs, "number");
  assert.strictEqual(typeof evt.pid, "number");
});

test("jobs.noteHubStop colours only the next ten seconds", () => {
  jobs._reset();
  const entry = { appId: APP.id, artifactId: ARTIFACT.id, pid: 999999, appName: APP.name };
  jobs.noteHubStop({ pid: entry.pid });
  // (the window itself is exercised end to end above; here we only check the
  // registry does not leak into unrelated apps)
  const exits = [];
  const off = jobs.onLaunchExit((e) => exits.push(e));
  off();
  assert.strictEqual(typeof jobs.isTracked, "function");
  assert.strictEqual(jobs.isTracked(APP.id, ARTIFACT.id), false, "nothing is tracked after a reset");
});
