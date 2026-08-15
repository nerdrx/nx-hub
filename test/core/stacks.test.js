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
  return {
    set,
    shutdowns,
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
    onChange() {
      return () => {};
    },
  };
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

function setup(t, { jobs = fakeJobs(), connector = null, timing = FAST, discovery = fakeDiscovery() } = {}) {
  const env = helpers.useTempEnv();
  const bag = collector();
  stacks._reset();
  stacks.init({ jobs, connector, config, emit: bag.emit, timing, discovery });
  t.after(() => {
    stacks._reset();
    env.cleanup();
  });
  return { env, jobs, connector, events: bag.events, phases: bag.phases };
}

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
