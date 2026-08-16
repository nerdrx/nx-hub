"use strict";
// src/main/stacks.js — the stack orchestrator (SPEC "NX Connector → Stacks").
//
// Everything is injected: a fake `jobs` records the launches, a fake connector
// answers presence, and the port gate talks to a REAL ephemeral listener. The
// stop path signals a REAL child process, because "never SIGKILL, SIGTERM the
// recorded pid" is only worth anything if it actually reaches a process.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const stacks = require("../../src/main/stacks");

/* ---------------------------------------------------------------- fakes */

function fakeJobs({ pids = {}, fail = {} } = {}) {
  const launched = [];
  return {
    launched,
    async launch(appId, artifactId) {
      launched.push({ appId, artifactId: artifactId || null });
      if (fail[appId]) throw new Error(fail[appId]);
      return { pid: pids[appId] != null ? pids[appId] : 40000 + launched.length, command: `/bin/${appId}` };
    },
  };
}

/** A connector whose presence set the test can flip at will. */
function fakeConnector(present = []) {
  const set = new Set(present);
  const shutdowns = [];
  const listeners = new Set();
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    set,
    shutdowns,
    listeners,
    /** when true, requestShutdown is accepted but the app never leaves */
    stubborn: false,
    isPresent(appId) {
      return set.has(String(appId).toLowerCase());
    },
    requestShutdown(appId) {
      shutdowns.push(appId);
      if (!set.has(appId)) return false;
      if (!this.stubborn) set.delete(appId);
      return true;
    },
    getClients() {
      return [...set].map((app) => ({ app, version: "1.0.0", pid: 1, since: null, lastSeen: null, fields: {} }));
    },
    onChange(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /* the two bus-side events a trigger watcher reacts to */
    arrive(appId) {
      set.add(String(appId).toLowerCase());
      notify();
    },
    leave(appId) {
      set.delete(String(appId).toLowerCase());
      notify();
    },
  };
}

/**
 * The install engine as far as an adb trigger cares: a mutable device list the
 * test plugs and unplugs, and a call counter so a poll can be waited on.
 */
function fakeEngine({ devices = [], available = true } = {}) {
  const eng = {
    devices,
    available,
    calls: 0,
    fail: null,
    async getAdbStatus() {
      eng.calls += 1;
      if (eng.fail) throw new Error(eng.fail);
      return { available: eng.available, devices: eng.devices, apkVersions: {}, selected: null };
    },
    plug(serial, state = "device") {
      eng.devices = [...eng.devices, { serial, model: "quest3", state }];
    },
    unplug(serial) {
      eng.devices = eng.devices.filter((d) => d.serial !== serial);
    },
  };
  return eng;
}

/**
 * The fleet as far as a peered step cares (v0.7): a mutable peer list, a set of
 * ports that are open ON THE REMOTE, and a log of everything that was sent over
 * the fabric. Every verb can be made to nack (`launchAck` / `stopAck` /
 * `wakeResult`) or to throw (`throws.<verb>`) — a peer refusing and a peer being
 * unreachable are two different stories, and both have to reach the user.
 */
function fakeFleet({ peers = [{ id: "peer-1", name: "Workshop PC", online: true }] } = {}) {
  const calls = { launch: [], probe: [], stop: [], wake: [] };
  const open = new Set();
  const f = {
    calls,
    peers: peers.map((p) => Object.assign({ online: true, name: p.id }, p)),
    launchAck: { ok: true, pid: 4242 },
    stopAck: { ok: true },
    wakeResult: true,
    throws: {},
    getPeers() {
      if (f.throws.getPeers) throw new Error(f.throws.getPeers);
      return f.peers.map((p) => Object.assign({}, p));
    },
    async remoteLaunch(peerId, appId, artifactId) {
      calls.launch.push({ peerId, appId, artifactId });
      if (f.throws.remoteLaunch) throw new Error(f.throws.remoteLaunch);
      return f.launchAck;
    },
    async probePeerPort(peerId, port, opts) {
      calls.probe.push({ peerId, port, opts });
      if (f.throws.probePeerPort) throw new Error(f.throws.probePeerPort);
      return open.has(`${peerId}:${port}`);
    },
    async remoteStop(peerId, appId) {
      calls.stop.push({ peerId, appId });
      if (f.throws.remoteStop) throw new Error(f.throws.remoteStop);
      return f.stopAck;
    },
    async wake(peerId) {
      calls.wake.push(peerId);
      if (f.throws.wake) throw new Error(f.throws.wake);
      return f.wakeResult;
    },
    /* what the test does to the world on the other side */
    setOnline(id, online) {
      const peer = f.peers.find((p) => p.id === id);
      if (peer) peer.online = Boolean(online);
    },
    openPort(peerId, port) {
      open.add(`${peerId}:${port}`);
    },
  };
  return f;
}

function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e), phases: () => events.map((e) => `${e.stepIndex == null ? "*" : e.stepIndex}:${e.phase}`) };
}

const FAST = { pollMs: 15, shutdownWaitMs: 120 };

/** Just enough discovery for a step that names no artifact. */
function fakeDiscovery(apps = null) {
  return {
    findApp: (id) => (apps || []).find((a) => a.id === id) || null,
    // `null` = "this process has no model at all", which is not the same as
    // "the model is loaded and your app is not in it".
    getCached: () => (apps ? { apps } : {}),
  };
}

function setup(
  t,
  { jobs = fakeJobs(), connector = null, engine = null, fleet = null, timing = FAST, discovery = fakeDiscovery() } = {}
) {
  const env = helpers.useTempEnv();
  const bag = collector();
  const logs = [];
  // The config module, with its log line diverted into an array: the trigger
  // watcher reports "skipped — cooldown" and "adb unavailable" through it, and
  // those sentences are part of the contract.
  const cfg = Object.assign({}, config, { log: (m) => logs.push(String(m)) });
  stacks._reset();
  stacks.init({ jobs, connector, engine, fleet, config: cfg, emit: bag.emit, timing, discovery });
  t.after(() => {
    stacks._reset();
    env.cleanup();
  });
  return { env, jobs, connector, engine, fleet, logs, events: bag.events, phases: bag.phases };
}

/** Timing for the adb watcher: poll 40× faster than the 10s the hub ships. */
const FAST_ADB = Object.assign({}, FAST, { adbPollMs: 15 });

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function step(appId, health, extra = {}) {
  return Object.assign({ appId, health }, extra);
}

/** A listener on a free port; `port` is usable before `open()` is called. */
async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let server = null;
  return {
    port,
    open() {
      server = net.createServer((s) => s.end());
      return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    },
    close() {
      return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    },
  };
}

/** A real, long-lived child process the stop path can signal. */
function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, pid: child.pid, exited };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------- sanitization */

test("stacks: the model is sanitized — ids slugified, junk steps dropped", (t) => {
  setup(t);

  const saved = stacks.save({
    id: "  My VR Stack! ",
    name: "  My VR Stack  ",
    steps: [
      { appId: "WiVRn NX", health: { type: "connector", timeoutMs: 5000 } },
      { appId: "", health: { type: "delay" } }, // no app → dropped
      { appId: "pulsenx", health: { type: "port" } }, // port gate with no port → dropped
      { appId: "ogb", health: { type: "nonsense" }, optional: "yes", artifactId: "  linux  " },
      { appId: "sidecar", health: { type: "port", port: "8080", timeoutMs: -5 } },
      "not an object",
    ],
  });

  assert.strictEqual(saved.id, "my-vr-stack");
  assert.strictEqual(saved.name, "My VR Stack");
  assert.deepStrictEqual(
    saved.steps.map((s) => s.appId),
    ["wivrn-nx", "ogb", "sidecar"]
  );
  // an unknown health type is "launch it and move on", never a silent 30s wait
  assert.deepStrictEqual(saved.steps[1].health, { type: "delay", timeoutMs: 0 });
  assert.strictEqual(saved.steps[1].optional, true);
  assert.strictEqual(saved.steps[1].artifactId, "ogb" === saved.steps[1].appId ? "linux" : null);
  assert.deepStrictEqual(saved.steps[2].health, { type: "port", timeoutMs: 30000, port: 8080 });
  assert.strictEqual(saved.steps[0].health.timeoutMs, 5000);
});

test("stacks: save refuses what cannot become a stack", (t) => {
  setup(t);
  assert.throws(() => stacks.save({ name: "   ", steps: [{ appId: "a", health: {} }] }), /id or a name/);
  assert.throws(() => stacks.save({ id: "empty", steps: [] }), /at least one step/);
  assert.throws(() => stacks.save({ id: "junk", steps: [{ appId: "", health: {} }] }), /at least one step/);
});

test("stacks: stacks.json survives a round trip and drops junk on read", (t) => {
  const { env } = setup(t);

  stacks.save({ id: "vr", name: "VR", steps: [step("wivrn-nx", { type: "delay", timeoutMs: 0 })] });
  stacks.save({ id: "audio", name: "Audio", steps: [step("ogb", { type: "connector" })] });
  assert.deepStrictEqual(stacks.list().map((s) => s.id), ["vr", "audio"]);

  const file = path.join(env.dataDir, "stacks.json");
  assert.ok(fs.existsSync(file), "stacks.json is written next to state.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(raw.version, 1);

  // a hand-edited file with rubbish in it must not break the hub
  raw.stacks.push({ nope: true }, { id: "vr", name: "duplicate", steps: [step("x", {})] }, null);
  fs.writeFileSync(file, JSON.stringify(raw));
  const list = stacks.list();
  assert.deepStrictEqual(list.map((s) => s.id), ["vr", "audio"], "junk and duplicates never survive a read");
  assert.strictEqual(list[0].name, "VR", "the FIRST entry of a duplicated id wins");

  assert.strictEqual(stacks.remove("audio"), true);
  assert.strictEqual(stacks.remove("audio"), false);
  assert.strictEqual(stacks.get("vr").id, "vr");
  assert.strictEqual(stacks.get("nope"), null);
});

/* ----------------------------------------------------------------- run */

test("stacks: a run walks the steps in order and reports every phase", async (t) => {
  const ctx = setup(t);
  stacks.save({
    id: "vr",
    name: "VR",
    steps: [step("wivrn-nx", { type: "delay", timeoutMs: 0 }), step("pulsenx", { type: "delay", timeoutMs: 20 }, { artifactId: "linux" })],
  });

  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(ctx.jobs.launched, [
    { appId: "wivrn-nx", artifactId: null },
    { appId: "pulsenx", artifactId: "linux" },
  ]);
  assert.deepStrictEqual(ctx.phases(), [
    "0:launching",
    "0:waiting",
    "0:healthy",
    "1:launching",
    "1:waiting",
    "1:healthy",
    "*:done",
  ]);
  for (const evt of ctx.events) assert.strictEqual(evt.type, "stack-progress");
  assert.strictEqual(ctx.events[0].stackId, "vr");
  assert.strictEqual(stacks.running(), null, "nothing is running once the run finished");
});

test("stacks: a connector gate waits for the app to show up on the bus", async (t) => {
  const connector = fakeConnector();
  const ctx = setup(t, { connector });
  stacks.save({ id: "vr", name: "VR", steps: [step("pulsenx", { type: "connector", timeoutMs: 2000 })] });

  const timer = setTimeout(() => connector.set.add("pulsenx"), 120);
  t.after(() => clearTimeout(timer));

  const started = Date.now();
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, true);
  assert.ok(Date.now() - started >= 100, "it really waited for the app");
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:healthy", "*:done"]);
});

test("stacks: a connector gate fails fast when there is no bus at all", async (t) => {
  const ctx = setup(t, { connector: null });
  stacks.save({ id: "vr", name: "VR", steps: [step("pulsenx", { type: "connector", timeoutMs: 30000 })] });

  const started = Date.now();
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, false);
  assert.ok(Date.now() - started < 2000, "no bus → no point burning the 30s timeout");
  assert.match(result.failed.message, /bus is not running/);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:failed", "*:failed"]);
});

test("stacks: a port gate waits for something to start listening", async (t) => {
  const ctx = setup(t);
  const listener = await reservePort();
  t.after(() => listener.close());

  stacks.save({ id: "srv", name: "Server", steps: [step("wivrn-nx", { type: "port", port: listener.port, timeoutMs: 3000 })] });
  const timer = setTimeout(() => listener.open(), 120);
  t.after(() => clearTimeout(timer));

  const result = await stacks.run("srv");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:healthy", "*:done"]);
});

test("stacks: an optional step that never comes up is reported and skipped", async (t) => {
  const ctx = setup(t);
  const listener = await reservePort(); // nothing ever listens there
  stacks.save({
    id: "mixed",
    name: "Mixed",
    steps: [
      step("flaky", { type: "port", port: listener.port, timeoutMs: 100 }, { optional: true }),
      step("wivrn-nx", { type: "delay", timeoutMs: 0 }),
    ],
  });

  const result = await stacks.run("mixed");
  assert.strictEqual(result.ok, true, "an optional gate timing out does not fail the run");
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:failed", "1:launching", "1:waiting", "1:healthy", "*:done"]);
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["flaky", "wivrn-nx"], "the next step still launched");
  const failed = ctx.events.find((e) => e.phase === "failed");
  assert.strictEqual(failed.optional, true);
  assert.match(failed.message, /nothing is listening/);
});

test("stacks: a required step that never comes up aborts the run and leaves the rest alone", async (t) => {
  const ctx = setup(t);
  const listener = await reservePort();
  stacks.save({
    id: "strict",
    name: "Strict",
    steps: [
      step("wivrn-nx", { type: "delay", timeoutMs: 0 }),
      step("needed", { type: "port", port: listener.port, timeoutMs: 100 }),
      step("never", { type: "delay", timeoutMs: 0 }),
    ],
  });

  const result = await stacks.run("strict");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed.stepIndex, 1);
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx", "needed"], "step 2 never launched");
  assert.deepStrictEqual(ctx.phases(), [
    "0:launching",
    "0:waiting",
    "0:healthy",
    "1:launching",
    "1:waiting",
    "1:failed",
    "*:failed",
  ]);
  // SPEC: already-started steps keep running — the report says what is up
  assert.deepStrictEqual(result.started.map((s) => `${s.appId}:${s.reached}`), ["wivrn-nx:healthy", "needed:launching"]);
});

test("stacks: a step whose launch throws behaves like a failed gate", async (t) => {
  const jobs = fakeJobs({ fail: { broken: "no such artifact" } });
  const ctx = setup(t, { jobs });
  stacks.save({ id: "b", name: "B", steps: [step("broken", { type: "delay", timeoutMs: 0 }), step("after", { type: "delay", timeoutMs: 0 })] });

  const result = await stacks.run("b");
  assert.strictEqual(result.ok, false);
  assert.match(result.failed.message, /no such artifact/);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:failed", "*:failed"]);
});

test("stacks: a step with no artifactId is resolved against discovery AT RUN TIME", async (t) => {
  const artifact = (id, over = {}) => Object.assign({ id, installed: { version: "1" }, launchable: true }, over);
  const apps = [
    { id: "wivrn-nx", name: "WiVRn NX", artifacts: [artifact("server-linux"), artifact("apk", { installed: null })] },
    { id: "gone", name: "Gone", artifacts: [artifact("linux", { installed: null })] },
    { id: "many", name: "Many", artifacts: [artifact("a"), artifact("b")] },
  ];
  const ctx = setup(t, { discovery: fakeDiscovery(apps) });

  stacks.save({ id: "one", name: "One", steps: [step("wivrn-nx", { type: "delay", timeoutMs: 0 })] });
  assert.strictEqual((await stacks.run("one")).ok, true);
  assert.deepStrictEqual(ctx.jobs.launched, [{ appId: "wivrn-nx", artifactId: "server-linux" }], "the one installed, launchable artifact");

  // and the failure modes are named, not "Unknown artifact undefined"
  for (const [appId, pattern] of [
    ["gone", /nothing installed to launch/],
    ["many", /2 launchable downloads/],
    ["nope", /not an app the hub knows about/],
  ]) {
    stacks.save({ id: appId, name: appId, steps: [step(appId, { type: "delay", timeoutMs: 0 })] });
    // eslint-disable-next-line no-await-in-loop
    const result = await stacks.run(appId);
    assert.strictEqual(result.ok, false);
    assert.match(result.failed.message, pattern);
  }
});

test("stacks: only one stack runs at a time, and running() describes it", async (t) => {
  const ctx = setup(t);
  stacks.save({ id: "slow", name: "Slow", steps: [step("wivrn-nx", { type: "delay", timeoutMs: 200 })] });
  stacks.save({ id: "other", name: "Other", steps: [step("ogb", { type: "delay", timeoutMs: 0 })] });

  const inFlight = stacks.run("slow");
  assert.deepStrictEqual(stacks.running(), { stackId: "slow", stepIndex: 0, phase: "launching" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(stacks.running(), { stackId: "slow", stepIndex: 0, phase: "waiting" }, "phase follows the step");

  await assert.rejects(() => stacks.run("other"), /already running/);
  await assert.rejects(() => stacks.run("slow"), /already running/);
  assert.ok(await inFlight.then((r) => r.ok));
  assert.strictEqual(stacks.running(), null);
  assert.strictEqual(ctx.jobs.launched.length, 1, "the rejected run never launched anything");

  await assert.rejects(() => stacks.run("nope"), /Unknown stack/);
});

/* ---------------------------------------------------------------- stop */

test("stacks: stop asks the bus first, in reverse order, and never signals what left politely", async (t) => {
  const connector = fakeConnector();
  const first = spawnSleeper();
  const second = spawnSleeper();
  t.after(() => {
    try {
      first.child.kill("SIGKILL");
      second.child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  const jobs = fakeJobs({ pids: { wivrn: first.pid, pulsenx: second.pid } });
  const ctx = setup(t, { jobs, connector });
  connector.set.add("wivrn");
  connector.set.add("pulsenx");
  stacks.save({
    id: "vr",
    name: "VR",
    steps: [step("wivrn", { type: "connector", timeoutMs: 1000 }), step("pulsenx", { type: "connector", timeoutMs: 1000 })],
  });

  await stacks.run("vr");
  ctx.events.length = 0;

  const result = await stacks.stop("vr");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.stopped.map((s) => s.appId), ["pulsenx", "wivrn"], "reverse order");
  assert.deepStrictEqual(result.stopped.map((s) => s.how), ["shutdown-request", "shutdown-request"]);
  assert.deepStrictEqual(connector.shutdowns, ["pulsenx", "wivrn"]);
  assert.deepStrictEqual(ctx.phases(), ["1:stopping", "1:stopped", "0:stopping", "0:stopped", "*:stopped"]);

  // a client that left the bus on request was never signalled
  assert.ok(alive(first.pid) && alive(second.pid), "polite exits are the app's own business");
  assert.deepStrictEqual(await stacks.stop("vr"), { ok: true, stackId: "vr", stopped: [] });
});

test("stacks: stop falls back to SIGTERM (never SIGKILL) when the bus cannot help", async (t) => {
  const connector = fakeConnector();
  connector.stubborn = true; // accepts shutdown-request, never leaves
  const stubborn = spawnSleeper();
  const noBus = spawnSleeper();
  t.after(() => {
    for (const c of [stubborn.child, noBus.child]) {
      try {
        c.kill("SIGKILL");
      } catch (_) {
        /* gone */
      }
    }
  });

  const jobs = fakeJobs({ pids: { stubborn: stubborn.pid, quiet: noBus.pid } });
  setup(t, { jobs, connector });
  connector.set.add("stubborn"); // "quiet" is not on the bus at all
  stacks.save({
    id: "mix",
    name: "Mix",
    steps: [step("stubborn", { type: "delay", timeoutMs: 0 }), step("quiet", { type: "delay", timeoutMs: 0 })],
  });

  await stacks.run("mix");
  const result = await stacks.stop("mix");
  assert.deepStrictEqual(result.stopped.map((s) => `${s.appId}=${s.how}`), ["quiet=sigterm", "stubborn=sigterm"]);
  assert.ok(connector.shutdowns.includes("stubborn"), "the polite route was tried first");

  const ends = await Promise.all([stubborn.exited, noBus.exited]);
  for (const end of ends) assert.strictEqual(end.signal, "SIGTERM", "SIGTERM only — a stack stop is never a kill");
});

test("stacks: stop aborts a run in flight and reports honestly about unknown stacks", async (t) => {
  const ctx = setup(t);
  stacks.save({
    id: "slow",
    name: "Slow",
    steps: [step("wivrn-nx", { type: "delay", timeoutMs: 5000 }), step("never", { type: "delay", timeoutMs: 0 })],
  });

  const inFlight = stacks.run("slow");
  await new Promise((r) => setTimeout(r, 30));
  const stopped = await stacks.stop("slow");
  const result = await inFlight;

  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(stacks.running(), null);
  assert.deepStrictEqual(stopped.stopped.map((s) => s.appId), ["wivrn-nx"]);
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx"], "the second step never started");
  assert.ok(ctx.phases().includes("*:stopped"));

  const nothing = await stacks.stop("no-such-stack");
  assert.strictEqual(nothing.ok, false);
  assert.match(nothing.reason, /not running/);
});

/* ------------------------------------------------------ v0.6 triggers */

const triggered = (id, trigger, extra = {}) =>
  Object.assign({ id, name: id, steps: [step("wivrn-nx", { type: "delay", timeoutMs: 0 })], trigger }, extra);

test("stacks: a trigger is sanitized — type whitelist, trimmed ids, clamped cooldown", (t) => {
  setup(t);
  const s = stacks.sanitizeTrigger;

  // nothing usable → no trigger at all (the stack stays manual)
  for (const junk of [
    undefined,
    null,
    "adb-device", // a string is not a trigger object
    [],
    {},
    { type: "" },
    { type: "cron", at: "09:00" },
    { type: "connector-app" }, // an app trigger with no app watches nothing
    { type: "connector-app", appId: "   " },
  ]) {
    assert.strictEqual(s(junk), null, `junk trigger: ${JSON.stringify(junk)}`);
  }

  // the type is matched case/space-insensitively, everything else defaults
  assert.deepStrictEqual(s({ type: "  ADB-Device " }), {
    type: "adb-device",
    stopOnLeave: false,
    cooldownMs: 60000,
    serial: null, // absent serial = any device
  });
  assert.deepStrictEqual(s({ type: "adb-device", serial: "  1WMHH8154Z0K7T  ", stopOnLeave: 1, cooldownMs: "120000" }), {
    type: "adb-device",
    stopOnLeave: true,
    cooldownMs: 120000,
    serial: "1WMHH8154Z0K7T", // trimmed but NOT slugified — serials are case-sensitive
  });
  assert.deepStrictEqual(s({ type: "connector-app", appId: "  WiVRn NX  ", stopOnLeave: "" }), {
    type: "connector-app",
    stopOnLeave: false,
    cooldownMs: 60000,
    appId: "WiVRn NX", // verbatim: the connector normalizes app ids on its side
  });

  // cooldown: finite → clamped to [5s, 1h]; junk/absent → the 60s default
  const cooldown = (v) => s({ type: "adb-device", cooldownMs: v }).cooldownMs;
  assert.strictEqual(cooldown(0), 5000);
  assert.strictEqual(cooldown(-90000), 5000);
  assert.strictEqual(cooldown(4999), 5000);
  assert.strictEqual(cooldown(5000), 5000);
  assert.strictEqual(cooldown(90000.6), 90001);
  assert.strictEqual(cooldown(24 * 60 * 60 * 1000), 3600000);
  for (const junk of [undefined, null, "soon", NaN, Infinity, {}]) assert.strictEqual(cooldown(junk), 60000);
});

test("stacks: a junk trigger is dropped and the stack stays manual — nothing watches", (t) => {
  const ctx = setup(t);

  const saved = stacks.save(triggered("vr", { type: "when-i-say-so", appId: "wivrn-nx" }));
  assert.ok(!("trigger" in saved), "an unusable trigger never reaches the store");
  assert.strictEqual(stacks._watching(), null, "a manual stack arms no watcher");

  // and the same is true of a hand-edited stacks.json
  const file = path.join(ctx.env.dataDir, "stacks.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.stacks[0].trigger = { type: "connector-app" }; // no appId
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.ok(!("trigger" in stacks.get("vr")), "junk never survives a read either");
  assert.strictEqual(stacks._watching(), null);

  // a usable one, by contrast, survives the round trip intact
  stacks.save(triggered("vr", { type: "connector-app", appId: "pulsenx", stopOnLeave: true }));
  assert.deepStrictEqual(stacks.get("vr").trigger, {
    type: "connector-app",
    appId: "pulsenx",
    stopOnLeave: true,
    cooldownMs: 60000,
  });
});

test("stacks: saving a trigger arms the watcher, removing it disarms — both restart it", (t) => {
  const connector = fakeConnector();
  setup(t, { connector });

  assert.strictEqual(stacks._watching(), null, "init with an empty store watches nothing");

  stacks.save(triggered("manual", null));
  assert.strictEqual(stacks._watching(), null);

  stacks.save(triggered("vr", { type: "connector-app", appId: "pulsenx" }));
  assert.deepStrictEqual(stacks._watching(), ["vr"], "save() restarts the watcher — a trigger appeared");
  assert.strictEqual(connector.listeners.size, 1, "and it subscribed to the bus exactly once");

  stacks.save(triggered("audio", { type: "adb-device" }));
  assert.deepStrictEqual(stacks._watching(), ["vr", "audio"]);
  assert.strictEqual(connector.listeners.size, 1, "the old subscription is dropped on restart, never stacked");

  stacks.save(triggered("vr", null)); // the same stack, trigger taken away
  assert.deepStrictEqual(stacks._watching(), ["audio"]);
  assert.strictEqual(connector.listeners.size, 0);

  assert.strictEqual(stacks.remove("audio"), true);
  assert.strictEqual(stacks._watching(), null, "remove() disarms the last trigger");

  stacks.save(triggered("vr", { type: "connector-app", appId: "pulsenx" }));
  assert.strictEqual(stacks.stopWatcher(), true);
  assert.strictEqual(stacks._watching(), null, "stopWatcher() tears it down for good");
  assert.strictEqual(connector.listeners.size, 0);
  assert.strictEqual(stacks.stopWatcher(), false, "and is idempotent");
});

test("stacks: a connector arrival runs the stack once, and the cooldown suppresses the rest", async (t) => {
  const connector = fakeConnector();
  const ctx = setup(t, { connector });
  stacks.save(triggered("vr", { type: "connector-app", appId: "headset" }));

  connector.arrive("headset");
  await tick();

  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx"], "the arrival ran the stack");
  assert.deepStrictEqual(ctx.phases(), ["*:triggered", "0:launching", "0:waiting", "0:healthy", "*:done"]);
  const evt = ctx.events[0];
  assert.deepStrictEqual(evt, {
    type: "stack-progress",
    stackId: "vr",
    stepIndex: null,
    appId: null,
    phase: "triggered",
    reason: "connector-app",
  });

  // a bus change that is not an EDGE is not an arrival
  connector.arrive("headset");
  connector.arrive("something-else");
  await tick();
  assert.strictEqual(ctx.jobs.launched.length, 1, "still present ≠ arrived again");

  // a real edge, but inside the 60s cooldown
  connector.leave("headset");
  connector.arrive("headset");
  await tick();
  assert.strictEqual(ctx.jobs.launched.length, 1, "the cooldown holds the second run back");
  const skipped = ctx.logs.filter((l) => /cooldown/.test(l));
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0], /trigger vr: connector-app arrived, skipped — cooldown, 6[0-9]s left/);
});

test("stacks: whatever is already there when the watcher starts is the BASELINE, not an arrival", async (t) => {
  const connector = fakeConnector(["headset"]); // plugged in before the hub came up
  const ctx = setup(t, { connector });

  stacks.save(triggered("vr", { type: "connector-app", appId: "headset" }));
  await tick();
  assert.strictEqual(ctx.jobs.launched.length, 0, "a hub restart must not re-run the stack");

  // any bus traffic while it stays present is still not an arrival
  connector.arrive("other-app");
  await tick();
  assert.strictEqual(ctx.jobs.launched.length, 0);

  // …but the watcher is alive: unplug, plug back in, and it fires
  connector.leave("headset");
  connector.arrive("headset");
  await tick();
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx"]);
});

test("stacks: departure with stopOnLeave stops the stack (and without it, nothing happens)", async (t) => {
  const connector = fakeConnector();
  const sleeper = spawnSleeper();
  t.after(() => {
    try {
      sleeper.child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  const jobs = fakeJobs({ pids: { "wivrn-nx": sleeper.pid } });
  const ctx = setup(t, { jobs, connector });
  stacks.save(triggered("vr", { type: "connector-app", appId: "headset", stopOnLeave: true }));

  connector.arrive("headset");
  await tick();
  assert.strictEqual(ctx.jobs.launched.length, 1);
  assert.ok(alive(sleeper.pid), "the launched app is up");

  connector.leave("headset");
  await tick();
  const end = await sleeper.exited;
  assert.strictEqual(end.signal, "SIGTERM", "the headset left, so the stack was stopped");
  assert.deepStrictEqual(ctx.phases(), [
    "*:triggered",
    "0:launching",
    "0:waiting",
    "0:healthy",
    "*:done",
    "0:stopping",
    "0:stopped",
    "*:stopped",
  ]);

  // the same departure on a stack without stopOnLeave is a non-event
  ctx.events.length = 0;
  stacks.save(triggered("keep", { type: "connector-app", appId: "other" }));
  connector.arrive("other");
  await tick();
  ctx.events.length = 0;
  connector.leave("other");
  await tick();
  assert.deepStrictEqual(ctx.phases(), [], "no stopOnLeave, no stop");
});

test("stacks: an adb device arriving fires the trigger, and the serial has to match", async (t) => {
  const engine = fakeEngine();
  const ctx = setup(t, { engine, timing: FAST_ADB });
  stacks.save(triggered("vr", { type: "adb-device", serial: "1WMHH8154Z0K7T" }));

  await tick(60);
  assert.ok(engine.calls >= 2, "the watcher polls on its own interval");
  assert.strictEqual(ctx.jobs.launched.length, 0, "no device, no run");

  engine.plug("SOMEONE-ELSE");
  await tick(60);
  assert.strictEqual(ctx.jobs.launched.length, 0, "a different headset is not this stack's trigger");

  engine.plug("1WMHH8154Z0K7T", "unauthorized");
  await tick(60);
  assert.strictEqual(ctx.jobs.launched.length, 0, "a device that has not accepted the debugging prompt is not usable");

  engine.unplug("1WMHH8154Z0K7T");
  engine.plug("1WMHH8154Z0K7T");
  await tick(60);
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx"]);
  assert.strictEqual(ctx.events[0].phase, "triggered");
  assert.strictEqual(ctx.events[0].reason, "adb-device");

  // a poll that cannot answer is UNKNOWN, not "everything unplugged"
  ctx.events.length = 0;
  engine.fail = "adb server died";
  await tick(60);
  assert.ok(!ctx.phases().includes("*:stopped"), "a failed poll never fakes a departure");
});

test("stacks: an adb device already plugged in when the watcher starts never fires", async (t) => {
  const engine = fakeEngine({ devices: [{ serial: "QUEST", model: "quest3", state: "device" }] });
  const ctx = setup(t, { engine, timing: FAST_ADB });
  stacks.save(triggered("vr", { type: "adb-device" })); // no serial → any device

  await tick(80);
  assert.ok(engine.calls >= 3, "it really polled");
  assert.strictEqual(ctx.jobs.launched.length, 0, "the first poll is the baseline, not an arrival");

  engine.unplug("QUEST");
  await tick(40);
  engine.plug("QUEST");
  await tick(40);
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["wivrn-nx"], "a real re-plug does fire");
});

test("stacks: with no engine wired, adb triggers say so ONCE and stay dormant", async (t) => {
  const ctx = setup(t, { engine: null, timing: FAST_ADB });
  stacks.save(triggered("vr", { type: "adb-device" }));

  await tick(80);
  const said = ctx.logs.filter((l) => /adb unavailable/.test(l));
  assert.strictEqual(said.length, 1, "one line, not one every poll");
  assert.match(said[0], /adb unavailable — 1 device trigger\(s\) dormant/);
  assert.deepStrictEqual(stacks._watching(), ["vr"], "the stack is still armed — it just cannot see a device");
  assert.strictEqual(ctx.jobs.launched.length, 0);
  assert.deepStrictEqual(ctx.phases(), []);

  // running it by hand is unaffected — a dormant trigger is not a broken stack
  assert.strictEqual((await stacks.run("vr")).ok, true);
});

test("stacks: a trigger never gatecrashes a run that is already in flight", async (t) => {
  const connector = fakeConnector();
  const ctx = setup(t, { connector });
  stacks.save({ id: "slow", name: "Slow", steps: [step("ogb", { type: "delay", timeoutMs: 300 })] });
  stacks.save(triggered("vr", { type: "connector-app", appId: "headset" }));

  const inFlight = stacks.run("slow");
  connector.arrive("headset");
  await tick();

  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["ogb"], "the trigger did not launch anything");
  const skipped = ctx.logs.filter((l) => /skipped/.test(l));
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0], /trigger vr: connector-app arrived, skipped — slow is already running/);
  assert.ok(!ctx.phases().includes("*:triggered"), "a skipped trigger is not announced as a run");

  assert.strictEqual((await inFlight).ok, true);
  // the skipped fire did NOT burn the cooldown: the next arrival edge runs it
  connector.leave("headset");
  connector.arrive("headset");
  await tick();
  assert.deepStrictEqual(ctx.jobs.launched.map((l) => l.appId), ["ogb", "wivrn-nx"]);
});

/* -------------------------------------------------- v0.7 cross-hub stacks */

test("stacks: a peered step is sanitized — peer verbatim, and only gates that can reach it", (t) => {
  const ctx = setup(t);
  const s = stacks.sanitizeStep;

  // a peer id is trimmed but NEVER slugified: it is opaque identity, and
  // "A1b2-C3" → "a1b2-c3" would quietly point the step at nobody
  assert.deepStrictEqual(s({ appId: "  WiVRn NX ", peer: "  A1b2-C3 ", health: { type: "port", port: "9100" } }), {
    appId: "wivrn-nx",
    artifactId: null,
    health: { type: "port", timeoutMs: 30000, port: 9100 },
    optional: false,
    peer: "A1b2-C3",
  });

  // nothing usable in `peer` = an ordinary local step, and the key stays absent
  for (const junk of [undefined, null, "", "   ", {}, [], true, false]) {
    const step = s({ appId: "wivrn-nx", peer: junk, health: { type: "delay" } });
    assert.ok(!("peer" in step), `junk peer: ${JSON.stringify(junk)}`);
  }

  // SPEC: a connector gate on a peered step is INVALID — the remote's bus is not
  // visible from here — so it drops to delay, and the hub says so exactly once
  const dropped = s({ appId: "pulsenx", peer: "peer-1", health: { type: "connector", timeoutMs: 5000 } });
  assert.deepStrictEqual(dropped.health, { type: "delay", timeoutMs: 0 });
  assert.strictEqual(dropped.peer, "peer-1", "the step still runs over there — it is just not waited on");
  s({ appId: "ogb", peer: "peer-2", health: { type: "connector" } }); // a second offender
  const said = ctx.logs.filter((l) => /connector gate cannot see a peer's bus/.test(l));
  assert.strictEqual(said.length, 1, "sanitizing happens on every read — the complaint is said once");

  // peer-online is the mirror image: it only means something WITH a peer
  assert.deepStrictEqual(s({ appId: "pulsenx", peer: "peer-1", health: { type: "peer-online" } }).health, {
    type: "peer-online",
    timeoutMs: 30000,
  });
  assert.deepStrictEqual(s({ appId: "pulsenx", health: { type: "peer-online", timeoutMs: 5000 } }).health, {
    type: "delay",
    timeoutMs: 0,
  });
  assert.ok(stacks.HEALTH_TYPES.includes("peer-online"));

  // …and a peered step still round-trips through the store untouched
  const saved = stacks.save({
    id: "vr",
    name: "VR",
    steps: [step("pulsenx", { type: "port", port: 9100 }, { peer: "peer-1", artifactId: " linux " })],
  });
  assert.deepStrictEqual(stacks.get("vr").steps, saved.steps);
  assert.strictEqual(saved.steps[0].artifactId, "linux");
});

test("stacks: a wake step is its own shape — no app, always a peer-online gate", (t) => {
  setup(t);
  const s = stacks.sanitizeStep;

  // whatever else was asked for is dropped: a wake starts nothing
  assert.deepStrictEqual(
    s({ action: "  WAKE ", peer: "peer-1", appId: "wivrn-nx", artifactId: "linux", health: { type: "port", port: 9100 }, optional: 1 }),
    {
      appId: null,
      artifactId: null,
      health: { type: "peer-online", timeoutMs: 120000 },
      optional: true,
      peer: "peer-1",
      action: "wake",
    }
  );
  assert.strictEqual(stacks.WAKE_TIMEOUT_MS, 120000, "SPEC: a cold boot gets two minutes by default");
  // …but "how long do I give this machine" is exactly the knob a user needs
  assert.strictEqual(s({ action: "wake", peer: "peer-1", health: { timeoutMs: 45000 } }).health.timeoutMs, 45000);
  assert.strictEqual(s({ action: "wake", peer: "peer-1", health: { timeoutMs: 99 * 60 * 1000 } }).health.timeoutMs, 600000);

  // a wake with no peer wakes nothing → dropped like any other junk step
  assert.strictEqual(s({ action: "wake", appId: "wivrn-nx", health: {} }), null);
  assert.throws(() => stacks.save({ id: "w", steps: [{ action: "wake" }] }), /at least one step/);

  // every other action is the default, and `action` never appears on it
  for (const action of ["launch", "  LAUNCH ", "", null, undefined, "boot", 7, {}]) {
    const step = s({ appId: "wivrn-nx", action, peer: "peer-1", health: {} });
    assert.ok(!("action" in step), `action: ${JSON.stringify(action)}`);
  }
  assert.deepStrictEqual(stacks.STEP_ACTIONS, ["launch", "wake"]);

  const saved = stacks.save({
    id: "vr",
    name: "VR",
    steps: [{ action: "wake", peer: "peer-1" }, step("pulsenx", { type: "peer-online" }, { peer: "peer-1" })],
  });
  assert.deepStrictEqual(stacks.get("vr").steps, saved.steps, "a wake step survives the store");
});

test("stacks: a peered step launches over the fleet and gates on a REMOTE port", async (t) => {
  const fleet = fakeFleet();
  const ctx = setup(t, { fleet });
  stacks.save({
    id: "vr",
    name: "VR",
    steps: [step("pulsenx", { type: "port", port: 9100, timeoutMs: 3000 }, { peer: "peer-1", artifactId: "linux" })],
  });

  const timer = setTimeout(() => fleet.openPort("peer-1", 9100), 120);
  t.after(() => clearTimeout(timer));

  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.jobs.launched.length, 0, "nothing was started on THIS hub");
  assert.deepStrictEqual(fleet.calls.launch, [{ peerId: "peer-1", appId: "pulsenx", artifactId: "linux" }]);
  assert.ok(fleet.calls.probe.length >= 2, "the port was really polled, over there");
  assert.deepStrictEqual(fleet.calls.probe[0], { peerId: "peer-1", port: 9100, opts: { timeoutMs: 1000 } });
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:healthy", "*:done"]);

  // the event shape is unchanged — the peer travels as an extra
  for (const evt of ctx.events.filter((e) => e.stepIndex != null)) {
    assert.strictEqual(evt.type, "stack-progress");
    assert.strictEqual(evt.peer, "peer-1");
    assert.ok(!("action" in evt), "a peered launch is still a launch");
  }
  assert.deepStrictEqual(result.started, [
    { stepIndex: 0, appId: "pulsenx", artifactId: "linux", pid: null, reached: "healthy", peer: "peer-1" },
  ]);
});

test("stacks: a peered step is resolved by the PEER, not by this hub's model", async (t) => {
  const fleet = fakeFleet();
  const ctx = setup(t, { fleet, discovery: fakeDiscovery([{ id: "something-else", name: "Else", artifacts: [] }]) });
  stacks.save({ id: "vr", name: "VR", steps: [step("only-over-there", { type: "delay", timeoutMs: 0 }, { peer: "peer-1" })] });

  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, true, "an app this hub never heard of is the peer's business");
  assert.deepStrictEqual(fleet.calls.launch, [{ peerId: "peer-1", appId: "only-over-there", artifactId: undefined }]);
  assert.strictEqual(ctx.jobs.launched.length, 0);
});

test("stacks: a peer that refuses — or cannot be reached — says so in its own words", async (t) => {
  const fleet = fakeFleet();
  const ctx = setup(t, { fleet });
  fleet.launchAck = { ok: false, error: 'No app called "pulsenx" on this hub.' };
  stacks.save({ id: "vr", name: "VR", steps: [step("pulsenx", { type: "delay", timeoutMs: 0 }, { peer: "peer-1" })] });

  const nacked = await stacks.run("vr");
  assert.strictEqual(nacked.ok, false);
  assert.match(nacked.failed.message, /No app called "pulsenx"/);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:failed", "*:failed"]);
  assert.strictEqual(ctx.events[0].peer, "peer-1", "even the failure names where it was going");
  assert.strictEqual(ctx.events[1].peer, "peer-1");

  // a nack with nothing to say still gets a sentence with the peer's NAME in it
  ctx.events.length = 0;
  fleet.launchAck = { ok: false };
  assert.match((await stacks.run("vr")).failed.message, /Workshop PC would not launch pulsenx/);

  // and a transport failure travels exactly the same way
  fleet.throws.remoteLaunch = "Workshop PC did not answer in time.";
  assert.match((await stacks.run("vr")).failed.message, /did not answer in time/);
});

test("stacks: a wake step sends the packet, then waits for the peer to come online", async (t) => {
  const fleet = fakeFleet({ peers: [{ id: "peer-1", name: "Workshop PC", online: false }] });
  const ctx = setup(t, { fleet });
  stacks.save({
    id: "vr",
    name: "VR",
    steps: [{ action: "wake", peer: "peer-1", health: { timeoutMs: 3000 } }, step("pulsenx", { type: "delay", timeoutMs: 0 }, { peer: "peer-1" })],
  });

  const timer = setTimeout(() => fleet.setOnline("peer-1", true), 120);
  t.after(() => clearTimeout(timer));

  const started = Date.now();
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, true);
  assert.ok(Date.now() - started >= 100, "it really waited for the machine to boot");
  assert.deepStrictEqual(fleet.calls.wake, ["peer-1"]);
  assert.strictEqual(ctx.jobs.launched.length, 0);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:healthy", "1:launching", "1:waiting", "1:healthy", "*:done"]);

  const woke = ctx.events.filter((e) => e.stepIndex === 0);
  for (const evt of woke) {
    assert.strictEqual(evt.appId, null, "a wake step names no app");
    assert.strictEqual(evt.peer, "peer-1");
    assert.strictEqual(evt.action, "wake", "so the UI can say waking, not launching");
  }
  assert.strictEqual(woke[1].health, "peer-online");
  // the launch that followed only went out once the peer was up
  assert.deepStrictEqual(fleet.calls.launch, [{ peerId: "peer-1", appId: "pulsenx", artifactId: undefined }]);
});

test("stacks: a wake that cannot be sent fails the step; one that never lands times out by name", async (t) => {
  const fleet = fakeFleet({ peers: [{ id: "peer-1", name: "Workshop PC", online: false }] });
  const ctx = setup(t, { fleet });
  fleet.wakeResult = false; // no mac on file, no socket — the packet never left
  stacks.save({ id: "vr", name: "VR", steps: [{ action: "wake", peer: "peer-1", health: { timeoutMs: 100 } }] });

  const failed = await stacks.run("vr");
  assert.strictEqual(failed.ok, false);
  assert.match(failed.failed.message, /could not send a wake packet to Workshop PC/);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:failed", "*:failed"], "a failed wake never reaches its gate");

  // the packet going out is not the machine coming up: that is the gate's job
  ctx.events.length = 0;
  fleet.wakeResult = true;
  const timedOut = await stacks.run("vr");
  assert.strictEqual(timedOut.ok, false);
  assert.match(timedOut.failed.message, /Workshop PC did not come online/);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:failed", "*:failed"]);
  assert.strictEqual(ctx.events[ctx.events.length - 1].peer, "peer-1", "the run's verdict names the peer too");
});

test("stacks: with no fleet wired, peered and wake steps fail fast", async (t) => {
  const ctx = setup(t, { fleet: null });
  stacks.save({
    id: "vr",
    name: "VR",
    steps: [step("pulsenx", { type: "port", port: 9100, timeoutMs: 30000 }, { peer: "peer-1" }), step("after", { type: "delay", timeoutMs: 0 })],
  });

  const started = Date.now();
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, false);
  assert.match(result.failed.message, /the fleet is not available/);
  assert.ok(Date.now() - started < 2000, "no fabric → no point burning the 30s timeout");
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:failed", "*:failed"]);
  assert.strictEqual(ctx.jobs.launched.length, 0, "and it never fell back to launching it HERE");

  stacks.save({ id: "w", name: "W", steps: [{ action: "wake", peer: "peer-1" }] });
  assert.match((await stacks.run("w")).failed.message, /the fleet is not available/);

  // a local stack is completely unaffected — no fleet is a normal hub
  stacks.save({ id: "local", name: "Local", steps: [step("wivrn-nx", { type: "delay", timeoutMs: 0 })] });
  assert.strictEqual((await stacks.run("local")).ok, true);
});

test("stacks: a fleet switched off mid-run is a named failure, not a 30s hang", async (t) => {
  const fleet = fakeFleet();
  let live = fleet; // injected as a FACTORY, exactly like the connector
  const ctx = setup(t, { fleet: () => live });
  stacks.save({ id: "vr", name: "VR", steps: [step("pulsenx", { type: "port", port: 9100, timeoutMs: 30000 }, { peer: "peer-1" })] });

  fleet.remoteLaunch = async () => {
    live = null; // the user turns the fabric off in Settings while the app boots
    return { ok: true };
  };

  const started = Date.now();
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, false);
  assert.match(result.failed.message, /the fleet is not available/);
  assert.ok(Date.now() - started < 2000);
  assert.deepStrictEqual(ctx.phases(), ["0:launching", "0:waiting", "0:failed", "*:failed"]);
});

test("stacks: a peer the fleet does not know is named, at RUN time", async (t) => {
  const fleet = fakeFleet();
  const ctx = setup(t, { fleet });
  stacks.save({ id: "vr", name: "VR", steps: [step("pulsenx", { type: "delay", timeoutMs: 0 }, { peer: "ghost" })] });

  // saving it was fine: pairing (and un-pairing) happens under a stored stack
  assert.strictEqual(stacks.get("vr").steps[0].peer, "ghost");
  const result = await stacks.run("vr");
  assert.strictEqual(result.ok, false);
  assert.match(result.failed.message, /Unknown fleet peer "ghost"/);
  assert.strictEqual(fleet.calls.launch.length, 0, "nothing was sent anywhere");
  assert.strictEqual(ctx.events[0].peer, "ghost");

  // a fleet that cannot answer who it knows is not evidence that it knows them
  stacks.save({ id: "known", name: "Known", steps: [{ action: "wake", peer: "peer-1" }] });
  fleet.throws.getPeers = "fleet is closing";
  assert.match((await stacks.run("known")).failed.message, /Unknown fleet peer "peer-1"/);
  assert.strictEqual(fleet.calls.wake.length, 0);
});

test("stacks: stop walks a mixed stack back with the right transport for every step", async (t) => {
  const connector = fakeConnector();
  const sleeper = spawnSleeper();
  t.after(() => {
    try {
      sleeper.child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });
  const fleet = fakeFleet({
    peers: [{ id: "peer-1", name: "Workshop PC", online: true }, { id: "peer-2", name: "Loft", online: true }],
  });
  const jobs = fakeJobs({ pids: { "wivrn-nx": sleeper.pid } });
  const ctx = setup(t, { jobs, connector, fleet });

  stacks.save({
    id: "vr",
    name: "VR",
    steps: [
      { action: "wake", peer: "peer-1" }, // 0 — started nothing
      step("wivrn-nx", { type: "delay", timeoutMs: 0 }), // 1 — here
      step("pulsenx", { type: "delay", timeoutMs: 0 }, { peer: "peer-1" }), // 2 — over there
      step("ogb", { type: "delay", timeoutMs: 0 }, { peer: "peer-2" }), // 3 — somewhere else again
    ],
  });
  assert.strictEqual((await stacks.run("vr")).ok, true);
  ctx.events.length = 0;

  const result = await stacks.stop("vr");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    result.stopped.map((s) => `${s.appId}=${s.how}`),
    ["ogb=remote-stop", "pulsenx=remote-stop", "wivrn-nx=sigterm"],
    "reverse order, and a wake is never un-woken"
  );
  assert.deepStrictEqual(fleet.calls.stop, [
    { peerId: "peer-2", appId: "ogb" },
    { peerId: "peer-1", appId: "pulsenx" },
  ]);
  assert.deepStrictEqual(ctx.phases(), ["3:stopping", "3:stopped", "2:stopping", "2:stopped", "1:stopping", "1:stopped", "*:stopped"]);
  assert.strictEqual(ctx.events.find((e) => e.stepIndex === 3).peer, "peer-2");
  assert.ok(!("peer" in ctx.events.find((e) => e.stepIndex === 1)), "a local step carries no peer");
  assert.deepStrictEqual(connector.shutdowns, [], "the local bus was never asked about a remote app");

  const end = await sleeper.exited;
  assert.strictEqual(end.signal, "SIGTERM", "the local step is stopped the local way");
  assert.deepStrictEqual(await stacks.stop("vr"), { ok: true, stackId: "vr", stopped: [] });
});

test("stacks: a peer that will not stop is logged, and never strands the rest of the walk", async (t) => {
  const sleeper = spawnSleeper();
  t.after(() => {
    try {
      sleeper.child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });
  const fleet = fakeFleet();
  let live = fleet;
  const jobs = fakeJobs({ pids: { "wivrn-nx": sleeper.pid } });
  const ctx = setup(t, { jobs, fleet: () => live });

  stacks.save({
    id: "vr",
    name: "VR",
    steps: [
      step("wivrn-nx", { type: "delay", timeoutMs: 0 }),
      step("pulsenx", { type: "delay", timeoutMs: 0 }, { peer: "peer-1" }),
    ],
  });

  await stacks.run("vr");
  fleet.stopAck = { ok: false, error: "nothing called pulsenx is running here" };
  const nacked = await stacks.stop("vr");
  assert.deepStrictEqual(nacked.stopped.map((s) => `${s.appId}=${s.how}`), ["pulsenx=remote-failed", "wivrn-nx=sigterm"]);
  assert.match(ctx.logs.find((l) => /nothing called pulsenx/.test(l)), /stop pulsenx on Workshop PC/);
  assert.strictEqual((await sleeper.exited).signal, "SIGTERM", "the local step was still stopped");

  // a peer that is simply unreachable is the same story
  await stacks.run("vr");
  fleet.throws.remoteStop = "Could not reach Workshop PC.";
  const threw = await stacks.stop("vr");
  assert.strictEqual(threw.stopped.find((s) => s.appId === "pulsenx").how, "remote-failed");
  assert.ok(ctx.logs.some((l) => /Could not reach Workshop PC/.test(l)));

  // …and so is a fabric that went away between the run and the stop
  await stacks.run("vr");
  live = null;
  const gone = await stacks.stop("vr");
  assert.strictEqual(gone.ok, true);
  assert.strictEqual(gone.stopped.find((s) => s.appId === "pulsenx").how, "remote-failed");
  assert.ok(ctx.logs.some((l) => /stop pulsenx on peer-1: the fleet is not available/.test(l)));
});
