"use strict";
// SPEC v0.10 [daemon] — src/main/daemon.js, the hub without electron.
//
// EVERY daemon in here is started on temp dirs with an EPHEMERAL connector port
// and the fleet switched off in settings. The ports in the SPEC (9021/9022/9023)
// belong to the real hub on this machine and are never bound by the suite.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const path = require("path");

const helpers = require("./helpers");

// The connector suite already owns a deliberately dumb raw WebSocket client;
// reusing it is what makes "a real app can hello the daemon's bus" a real test.
//
// It is normally loaded in its OWN process, where setting NX_HUB_NO_FILE_LOG on
// import is harmless. All of test/core shares ONE process, so importing it here
// would switch the hub's file log off for every test file loaded after this one
// (housekeeping's getLogs tail and ipc-v02's log channel both read that file).
// Take the flag back the moment the module is in.
const NO_FILE_LOG_BEFORE = process.env.NX_HUB_NO_FILE_LOG;
const ch = require("../connector/helpers");
if (NO_FILE_LOG_BEFORE === undefined) delete process.env.NX_HUB_NO_FILE_LOG;
else process.env.NX_HUB_NO_FILE_LOG = NO_FILE_LOG_BEFORE;

const config = require("../../src/main/config");
const daemon = require("../../src/main/daemon");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stacks = require("../../src/main/stacks");
const recorder = require("../../src/main/recorder");
const stateStore = require("../../src/main/state");
const supervisor = require("../../src/main/supervisor");
const connectorServer = require("../../src/main/connector/server");

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

/**
 * The hub's modules are singletons and the whole of test/core shares ONE
 * process, so a daemon test has to leave discovery/jobs/stacks exactly as it
 * found them. The sticky one is discovery's `afterRefresh` hook: `init()`
 * merges, so a leaked hook would silently run update policies inside every
 * later test's refresh.
 */
function resetHubModules() {
  try {
    supervisor.stop();
  } catch (_) {
    /* not started */
  }
  try {
    stacks._reset();
  } catch (_) {
    /* not started */
  }
  jobs._reset();
  jobs.init({ github: null, engine: null, engineLoader: null, relaunch: null, resolve: null });
  discovery.init({ afterRefresh: null, emit: () => {} });
  discovery._setCached({ apps: [], releases: {}, overlay: { hidden: [], apps: {} } });
  recorder._reset();
}

/** Settings a daemon test can actually run against: no LAN, no shim, no `gh`. */
function writeSettings(env, over = {}) {
  const file = path.join(env.dataDir, "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      Object.assign(
        {
          owners: ["nerdrx"],
          extraRepos: [],
          fleet: false, // never open a LAN listener from a unit test
          cliShim: false,
          autostart: false,
          checkIntervalHours: 6,
          notifications: true,
        },
        over
      )
    )
  );
  return file;
}

/** One daemon, on temp dirs, wired to the mock GitHub. */
async function startDaemon(t, { mock, env, over = {}, timers = null } = {}) {
  const logs = [];
  const previousBase = process.env.NX_HUB_GITHUB_BASE;
  if (mock) process.env.NX_HUB_GITHUB_BASE = mock.base;

  const handle = await daemon.start(
    Object.assign(
      {
        connectorPort: 0, // ephemeral — never the SPEC's 9021
        fleet: false,
        firstRunMs: 5,
        intervalMs: 60 * 60 * 1000,
        log: (m) => logs.push(String(m)),
        // The bus's documented test knobs: a 30s ping in a unit test is a
        // 30s-long unref'd interval hanging off the run.
        connectorOpts: { pingMs: 50, reapMs: 5000 },
      },
      over,
      timers ? { timers } : {}
    )
  );

  t.after(async () => {
    await handle.stop();
    if (previousBase === undefined) delete process.env.NX_HUB_GITHUB_BASE;
    else process.env.NX_HUB_GITHUB_BASE = previousBase;
    resetHubModules();
    if (env) env.cleanup();
    if (mock) await mock.close();
  });

  return { handle, logs };
}

/** A timer pair the test drives by hand. */
function fakeTimers() {
  let scheduled = null;
  let seq = 0;
  return {
    setTimeout(fn, ms) {
      seq += 1;
      scheduled = { fn, ms, id: seq };
      return { id: seq, unref() {} };
    },
    clearTimeout() {
      scheduled = null;
    },
    get pending() {
      return scheduled;
    },
    /** Run whatever is armed right now. */
    fire() {
      const entry = scheduled;
      assert.ok(entry, "nothing was scheduled");
      scheduled = null;
      entry.fn();
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

test("the daemon composes a working hub: refresh, bus, clean teardown", async (t) => {
  resetHubModules();
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  writeSettings(env);

  const { handle, logs } = await startDaemon(t, { mock, env });

  const port = handle.ports.connector;
  assert.ok(port > 0, "the bus took an ephemeral port");
  assert.notStrictEqual(port, config.NX_CONNECTOR_PORT, "a test never binds the real connector port");

  // --- the scheduler ran a discovery pass on its own -----------------
  await ch.waitUntil(() => (discovery.getCached().apps || []).length > 0, 6000, "the first scheduled refresh");
  const apps = discovery.getCached().apps;
  assert.ok(
    apps.some((a) => a.id === "wivrn-nx"),
    "the mock's apps came through the daemon's own discovery"
  );
  assert.ok(mock.stats.requests.length > 0, "the pass really talked to (mock) GitHub");

  // --- an app can join the bus the daemon opened ---------------------
  const token = fs.readFileSync(path.join(env.dataDir, "connector.token"), "utf8").trim();
  const client = await ch.rawConnect(port, { hello: { app: "PulseNX", version: "1.2.1", token } });
  t.after(() => client.close());
  const welcome = await client.next();
  assert.strictEqual(welcome.type, "welcome", "the daemon's bus completes the handshake");
  await ch.waitUntil(() => connectorServer.isPresent("pulsenx"), 3000, "presence");

  // --- and the roster reaches the out-of-process readers -------------
  const snapshotFile = path.join(env.dataDir, "connector-clients.json");
  await ch.waitUntil(() => fs.existsSync(snapshotFile), 3000, "connector-clients.json");
  await ch.waitUntil(() => {
    const snap = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    return (snap.clients || []).some((c) => c.app === "pulsenx");
  }, 4000, "the client in the snapshot");

  // --- the flight recorder was wired into the same event stream ------
  // `connector-changed` carries no roster on the wire, so the daemon has to
  // attach one before recording (the GUI does it in ipc.recordEvent). Without
  // that the journal would never learn that anything ever connected.
  const journal = path.join(env.dataDir, "events.jsonl");
  recorder.flush();
  assert.ok(fs.existsSync(journal), "the daemon's emit feeds the flight recorder");
  const entries = fs
    .readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(
    entries.some((e) => e.type === "connector-join" && e.appId === "pulsenx"),
    `the join reached the journal — got ${JSON.stringify(entries.map((e) => e.type))}`
  );

  assert.ok(
    logs.some((l) => /connector listening on 127\.0\.0\.1:/.test(l)),
    "it says where the bus is"
  );

  // --- stop() gives the port back ------------------------------------
  await handle.stop();
  assert.strictEqual(await daemon.portBusy(port), false, "stop() released the listening socket");
  assert.strictEqual(await handle.stop(), undefined, "stop() is idempotent");
});

test("stop() is safe to call twice and unwires the singletons", async (t) => {
  resetHubModules();
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  writeSettings(env);

  const { handle } = await startDaemon(t, { mock, env, over: { firstRunMs: 60000 } });
  const port = handle.ports.connector;

  await handle.stop();
  await handle.stop(); // must not throw, must not re-close anything

  assert.strictEqual(await daemon.portBusy(port), false);
  assert.strictEqual(connectorServer.isPresent("pulsenx"), false, "the bus is gone with the daemon");
});

/* ------------------------------------------------------------------ */
/* the refusal                                                         */
/* ------------------------------------------------------------------ */

test("it refuses to start when the connector port is already bound", async (t) => {
  resetHubModules();
  const env = helpers.useTempEnv();
  t.after(() => {
    resetHubModules();
    env.cleanup();
  });
  writeSettings(env);

  const port = await freePort();
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const logs = [];
  await assert.rejects(
    () => daemon.start({ connectorPort: port, fleet: false, firstRunMs: 60000, log: (m) => logs.push(m) }),
    (e) => {
      assert.match(e.message, /connector port \d+ is already in use/);
      assert.match(e.message, /NX Hub is already running/);
      assert.match(e.message, /systemctl --user stop nx-hub-daemon/);
      assert.strictEqual(e.operational, true, "an operational refusal, not a crash");
      return true;
    }
  );

  // The pre-flight runs BEFORE anything is initialised: no log line, no bus,
  // no timer, nothing to unwind.
  assert.deepStrictEqual(logs, [], "it gave up before it started composing");
  assert.strictEqual(await daemon.portBusy(port), true, "the squatter still owns the port");
});

test("portBusyMessage names the port and the way out", () => {
  const msg = daemon.portBusyMessage("fleet", 9023);
  assert.match(msg, /fleet port 9023/);
  assert.match(msg, /Quit the GUI hub/);
});

/* ------------------------------------------------------------------ */
/* the scheduler + the update policies                                 */
/* ------------------------------------------------------------------ */

test("checkIntervalHours drives the loop, with a 0.1h floor", () => {
  assert.strictEqual(daemon.intervalFrom({ checkIntervalHours: 6 }), 6 * 3600 * 1000);
  assert.strictEqual(daemon.intervalFrom({ checkIntervalHours: 0.5 }), 0.5 * 3600 * 1000);
  // Anything sillier than six minutes is clamped up to it.
  assert.strictEqual(daemon.intervalFrom({ checkIntervalHours: 0.001 }), 0.1 * 3600 * 1000);
  assert.strictEqual(daemon.intervalFrom({ checkIntervalHours: 0 }), 6 * 3600 * 1000);
  assert.strictEqual(daemon.intervalFrom({ checkIntervalHours: "nonsense" }), 6 * 3600 * 1000);
});

test("the refresh loop re-arms itself and runs the update policies", async (t) => {
  resetHubModules();
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  writeSettings(env, { updatePolicy: "notify" });

  const timers = fakeTimers();
  const { handle, logs } = await startDaemon(t, {
    mock,
    env,
    timers,
    over: { firstRunMs: 1234, intervalMs: 7 * 60 * 1000 },
  });

  assert.strictEqual(timers.pending.ms, 1234, "the first pass is jittered, not immediate");

  // ---- pass one: populate the model --------------------------------
  timers.fire();
  await handle.settled();
  const apps = discovery.getCached().apps || [];
  assert.ok(apps.length > 0, "the first tick refreshed");
  assert.strictEqual(timers.pending.ms, 7 * 60 * 1000, "the loop re-armed at the interval");

  // ---- make one artifact look out of date --------------------------
  const app = apps.find((a) => a.latest && (a.artifacts || []).length);
  assert.ok(app, "the fixture has at least one released app");
  const artifact = app.artifacts[0];
  stateStore.recordInstall(app.id, artifact.id, {
    version: "0.0.1",
    path: path.join(env.installRoot, app.id),
  });

  // ---- pass two: discovery sees the update, the policy speaks ------
  timers.fire();
  await handle.settled();

  const fresh = (discovery.getCached().apps || []).find((a) => a.id === app.id);
  assert.ok(
    (fresh.artifacts || []).some((a) => a.updateAvailable),
    "the second pass noticed the stale install"
  );
  // SPEC: "Notifications/toasts become log lines." This IS the daemon's
  // notification — proof that discovery.afterRefresh reached
  // jobs.applyUpdatePolicies through the daemon's own wiring.
  assert.ok(
    logs.some((l) => l.startsWith("update available:")),
    `the notify policy fired through the daemon loop — logs: ${JSON.stringify(logs.slice(-6))}`
  );
});

test("toasts and job errors become log lines (no tray, no renderer)", () => {
  const lines = [];
  const log = (m) => lines.push(m);
  daemon.logEvent(log, { type: "toast", level: "warn", message: "rate limited" });
  daemon.logEvent(log, { type: "update-available", appId: "quadforge", appName: "QuadForge", version: "1.3" });
  daemon.logEvent(log, { type: "job-error", message: "download failed" });
  daemon.logEvent(log, { type: "state-changed" }); // noise the recorder already has
  assert.deepStrictEqual(lines, ["[warn] rate limited", "update available: QuadForge 1.3", "job failed: download failed"]);
});

/* ------------------------------------------------------------------ */
/* the probe                                                           */
/* ------------------------------------------------------------------ */

test("portBusy answers true only for a port something is really listening on", async (t) => {
  const port = await freePort();
  assert.strictEqual(await daemon.portBusy(port), false, "a free port is free");

  const server = net.createServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.strictEqual(await daemon.portBusy(port), true, "a bound port is busy");
});

test.after(() => ch.cleanupTempDirs());
