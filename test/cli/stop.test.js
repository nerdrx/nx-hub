"use strict";
// `nx stop <app> [artifact] [--peer <name>] [--json]` — SPEC v0.11 "stop".
//
// The verdicts are rendered against an injected running.js (every `how` in one
// table), and then the whole thing is run FOR REAL once: a temp dataDir, a
// hand-written connector snapshot naming a child this test spawned, and the
// real ladder ending that child with SIGTERM.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const stopCli = require("../../src/cli/stop");
const render = require("../../src/cli/render");
const fx = require("./fixtures");

function fakeStream({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns: 100,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

function runtimeFor(apps) {
  return {
    hubVersion: () => "0.11.0",
    on: () => () => {},
    apps: async () => apps,
    cached: () => ({ apps, lastRefresh: null, errors: [] }),
  };
}

async function runCli(argv, opts = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime: runtimeFor(opts.apps || fx.APPS),
    stdout,
    stderr,
    running: opts.running || null,
    stopOptions: opts.stopOptions || null,
    fleet: opts.fleet || null,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text };
}

/** A running.js stand-in that answers one canned verdict. */
function fakeRunning(verdict, calls = []) {
  return {
    list: () => [],
    stop: async (appId, artifactId, opts) => {
      calls.push({ appId, artifactId, opts });
      return Object.assign({ pid: null, appId, artifactId: artifactId || null, appName: "WiVRn NX" }, verdict);
    },
  };
}

/* ------------------------------------------------------------------ */
/* the verdict table                                                   */
/* ------------------------------------------------------------------ */

const CASES = [
  [{ ok: true, how: "shutdown-request" }, 0, /✓ WiVRn NX stopped \(asked politely\)/],
  [{ ok: true, how: "sigterm" }, 0, /✓ WiVRn NX stopped \(SIGTERM\)/],
  [{ ok: true, how: "gone" }, 0, /✓ WiVRn NX had already stopped/],
  [{ ok: false, how: "not-running" }, 0, /· WiVRn NX was not running/],
  [{ ok: false, how: "shutdown-request" }, 2, /✗ WiVRn NX is still running/],
  [{ ok: false, how: "sigterm" }, 2, /✗ WiVRn NX is still running/],
];

for (const [verdict, exit, pattern] of CASES) {
  test(`nx stop: ${verdict.how} (ok=${verdict.ok}) prints its line and exits ${exit}`, async () => {
    const { code, out } = await runCli(["stop", "wivrn"], { running: fakeRunning(verdict) });
    assert.match(out, pattern);
    assert.strictEqual(code, exit);
  });
}

test("nx stop: the app and artifact go through the ordinary matcher", async () => {
  const calls = [];
  const { code } = await runCli(["stop", "wiv", "tarball"], {
    running: fakeRunning({ ok: true, how: "sigterm" }, calls),
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls, [{ appId: "wivrn-nx", artifactId: "tarball-prefix-linux", opts: {} }]);
});

test("nx stop: an unknown app is a usage error, and nothing is stopped", async () => {
  const calls = [];
  const { code, err } = await runCli(["stop", "nosuchapp"], {
    running: fakeRunning({ ok: true, how: "sigterm" }, calls),
  });
  assert.strictEqual(code, 1);
  assert.match(err, /No app matches/);
  assert.deepStrictEqual(calls, []);
});

test("nx stop: an artifact the app does not have is a usage error", async () => {
  const { code, err } = await runCli(["stop", "wivrn", "nonsense"], {
    running: fakeRunning({ ok: true, how: "sigterm" }),
  });
  assert.strictEqual(code, 1);
  assert.match(err, /no download called "nonsense"/);
});

test("nx stop --json: the verdict, unpainted", async () => {
  const { code, out } = await runCli(["stop", "wivrn", "--json"], {
    running: fakeRunning({ ok: true, how: "sigterm", pid: 4242 }),
  });
  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(
    { ok: parsed.ok, how: parsed.how, pid: parsed.pid, appId: parsed.appId, peer: parsed.peer },
    { ok: true, how: "sigterm", pid: 4242, appId: "wivrn-nx", peer: null }
  );
});

test("nx stop --json: a survivor is still exit 2", async () => {
  const { code, out } = await runCli(["stop", "wivrn", "--json"], {
    running: fakeRunning({ ok: false, how: "shutdown-request" }),
  });
  assert.strictEqual(code, 2);
  assert.strictEqual(JSON.parse(out).ok, false);
});

/* ------------------------------------------------------------- --peer */

function fakeFleet(peers) {
  return { peers: () => peers, withPeer: async () => ({ ok: true }) };
}

test("nx stop --peer: the peer is resolved and the stop is routed to it", async () => {
  const calls = [];
  const { code, out } = await runCli(["stop", "wivrn", "--peer", "work"], {
    fleet: fakeFleet([{ id: "peer-1", name: "workshop", host: "192.168.1.20" }]),
    running: fakeRunning({ ok: true, how: "remote" }, calls),
  });
  assert.strictEqual(code, 0);
  assert.match(out, /✓ WiVRn NX stopped on workshop/);
  assert.deepStrictEqual(calls, [{ appId: "wivrn-nx", artifactId: null, opts: { peer: "peer-1" } }]);
});

test("nx stop --peer: a peer that refuses is exit 2 and says why", async () => {
  const { code, out } = await runCli(["stop", "wivrn", "--peer", "workshop"], {
    fleet: fakeFleet([{ id: "peer-1", name: "workshop", host: "h" }]),
    running: fakeRunning({ ok: false, how: "remote", error: "unknown app" }),
  });
  assert.strictEqual(code, 2);
  assert.match(out, /was not stopped on workshop — unknown app/);
});

test("nx stop --peer: an unknown peer, and an empty --peer, are usage errors", async () => {
  const unknown = await runCli(["stop", "wivrn", "--peer", "nowhere"], {
    fleet: fakeFleet([{ id: "peer-1", name: "workshop", host: "h" }]),
    running: fakeRunning({ ok: true, how: "remote" }),
  });
  assert.strictEqual(unknown.code, 1);
  assert.match(unknown.err, /No paired hub called "nowhere"/);

  const empty = await runCli(["stop", "wivrn", "--peer"], { running: fakeRunning({ ok: true, how: "remote" }) });
  assert.strictEqual(empty.code, 1);
  assert.match(empty.err, /--peer needs the name/);
});

/* ------------------------------------------------------------ helpers */

test("nx stop: stopLine falls back to the id when nothing named the app", () => {
  assert.deepStrictEqual(stopLineOf({ ok: true, how: "sigterm", appId: "pulsenx" }), "pulsenx stopped (SIGTERM)");
  assert.deepStrictEqual(stopLineOf({ ok: true, how: "remote" }), "that app stopped on the peer");
});

function stopLineOf(verdict) {
  return stopCli.stopLine(verdict, {}).text;
}

test("nx stop: the snapshot bus is read live, and a stale/missing one means no bus", () => {
  let snap = { stale: false, clients: [{ app: "WiVRn-NX", pid: 7 }] };
  const bus = stopCli.snapshotBus({ readSnapshot: () => snap });
  assert.strictEqual(bus.isPresent("wivrn-nx"), true, "matched case-insensitively");
  assert.strictEqual(bus.requestShutdown("wivrn-nx"), false, "the CLI is not the bus");

  snap = { stale: true, clients: [{ app: "wivrn-nx" }] };
  assert.deepStrictEqual(bus.getClients(), [], "a stale snapshot is not evidence of anything");

  const broken = stopCli.snapshotBus({
    readSnapshot: () => {
      throw new Error("no such file");
    },
  });
  assert.deepStrictEqual(broken.getClients(), []);
  assert.strictEqual(broken.isPresent("wivrn-nx"), false);
});

test("nx help lists stop", () => {
  const text = render.renderHelp({});
  assert.match(text, /stop <app> \[artifact\] \[--peer <name>\]/);
});

/* ------------------------------------------------------------------ */
/* the real thing                                                      */
/* ------------------------------------------------------------------ */

/** A real child in a temp cwd that stays up until it is signalled. */
function spawnSleeper(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-stopcli-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", cwd: dir });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* gone */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
  return { child, pid: child.pid, exited };
}

function writeSnapshot(dataDir, clients) {
  fs.writeFileSync(
    path.join(dataDir, "connector-clients.json"),
    JSON.stringify({ ts: new Date().toISOString(), clients })
  );
}

test("nx stop: really ends a real process named by the hub's connector snapshot", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const sleeper = spawnSleeper(t);
  writeSnapshot(env.dataDir, [{ app: "wivrn-nx", version: "1.4.0", pid: sleeper.pid, since: Date.now() - 5000, fields: {} }]);

  const { code, out } = await runCli(["stop", "wivrn"]);
  assert.strictEqual(code, 0);
  assert.match(out, /✓ WiVRn NX stopped \(SIGTERM\)/);

  const { signal } = await sleeper.exited;
  assert.strictEqual(signal, "SIGTERM", "polite, and never SIGKILL");
});

test("nx stop: an empty snapshot means the app was not running — still exit 0", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  writeSnapshot(env.dataDir, []);

  const { code, out } = await runCli(["stop", "wivrn"]);
  assert.strictEqual(code, 0);
  assert.match(out, /· WiVRn NX was not running/);
});
