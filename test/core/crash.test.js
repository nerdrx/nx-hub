"use strict";
// SPEC v0.6 — crash-aware rollback.
//
// The watchdog is exercised with REAL processes (sh -c 'exit 1' vs a sleeper),
// through the real jobs.launch → engine.launch → util.spawnDetached path, so
// the exit codes under test are the ones the kernel actually reports.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");
const util = require("../../src/main/install/util");

const APP = { id: "crashy", name: "Crashy", repo: "nerdrx/crashy" };
const ARTIFACT = { id: "appimage-linux", label: "Linux app", kind: "appimage", platform: "linux" };

/** jobs wired to a stub engine whose launch() really spawns `cmd`. */
function harness(cmd, args) {
  const events = [];
  jobs._reset();
  jobs.init({
    emit: (e) => events.push(e),
    github: null,
    relaunch: null,
    engine: {
      async launch() {
        const child = util.spawnDetached(cmd, args);
        return { pid: child.pid, command: cmd, args };
      },
    },
    resolve: () => ({ app: APP, artifact: ARTIFACT }),
  });
  return { events };
}

async function waitFor(fn, what, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function crashRec() {
  return stateStore.getCrashes(APP.id, ARTIFACT.id);
}

function installedAt(version) {
  stateStore.recordInstall(APP.id, ARTIFACT.id, { version, path: "/nowhere", launchable: true });
}

/* ------------------------------------------------------------------ */
/* the watchdog: real processes, real exit codes                       */
/* ------------------------------------------------------------------ */

test("a short-lived non-zero exit is counted as a crash at the installed version", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  const h = harness("sh", ["-c", "exit 1"]);

  const res = await jobs.launch(APP.id, ARTIFACT.id);
  assert.ok(res.pid > 0, "engine reported a pid");

  const rec = await waitFor(crashRec, "the crash to be recorded");
  assert.strictEqual(rec.count, 1);
  assert.strictEqual(rec.version, "2.0.0", "the counter is keyed on the INSTALLED version");
  assert.ok(rec.lastAt, "lastAt stamped");
  assert.ok(
    h.events.some((e) => e.type === "state-changed"),
    "the UI is told to re-read the model"
  );
  assert.strictEqual(jobs._tracked.size, 0, "the watch is released when the process ends");
});

test("a clean quick exit (code 0) is NOT a crash — we have the real exit code", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  harness("sh", ["-c", "exit 0"]);

  await jobs.launch(APP.id, ARTIFACT.id);
  await waitFor(() => jobs._tracked.size === 0, "the process to be reaped");
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(crashRec(), null, "quitting immediately is not crashing");
});

test("a signal death inside the crash window counts (SIGSEGV is not exit 0)", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  harness("sh", ["-c", "kill -SEGV $$"]);

  await jobs.launch(APP.id, ARTIFACT.id);
  const rec = await waitFor(crashRec, "the signal death to be recorded");
  assert.strictEqual(rec.count, 1);
});

test("a long-lived run resets the counter (SPEC: ≥120s, shrunk for the test)", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  // pretend the app already crashed twice at this version
  stateStore.recordCrash(APP.id, ARTIFACT.id, "2.0.0");
  stateStore.recordCrash(APP.id, ARTIFACT.id, "2.0.0");
  assert.strictEqual(crashRec().count, 2);

  harness("sh", ["-c", "sleep 0.35; exit 1"]);
  jobs._setCrashConfig({ crashMs: 200, healthyMs: 250 });

  await jobs.launch(APP.id, ARTIFACT.id);
  await waitFor(() => crashRec() === null, "the healthy run to clear the counter");
});

test("a crash at a NEW version starts the count over", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("1.0.0");
  stateStore.recordCrash(APP.id, ARTIFACT.id, "1.0.0");
  stateStore.recordCrash(APP.id, ARTIFACT.id, "1.0.0");
  assert.strictEqual(crashRec().count, 2);

  installedAt("2.0.0"); // the update landed
  harness("sh", ["-c", "exit 3"]);
  await jobs.launch(APP.id, ARTIFACT.id);

  const rec = await waitFor(() => {
    const r = crashRec();
    return r && r.version === "2.0.0" ? r : null;
  }, "the crash at the new version");
  assert.strictEqual(rec.count, 1, "a different version never inherits the old count");
});

test("three crashes in a row raise the counter to the crashLoop threshold", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  harness("sh", ["-c", "exit 9"]);

  for (let i = 1; i <= 3; i += 1) {
    await jobs.launch(APP.id, ARTIFACT.id);
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => {
      const r = crashRec();
      return r && r.count === i ? r : null;
    }, `crash #${i}`);
  }
  assert.strictEqual(crashRec().count, 3);
});

test("at most 10 processes are watched at once — the oldest watch is dropped", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  jobs._reset();
  for (let i = 1; i <= 14; i += 1) {
    jobs.trackLaunch({ appId: APP.id, artifactId: ARTIFACT.id, version: "1", pid: 900000 + i });
  }
  assert.strictEqual(jobs._tracked.size, 10);
  assert.ok(!jobs._tracked.has(900001), "the first launch was evicted");
  assert.ok(jobs._tracked.has(900014), "the newest launch is watched");
  assert.ok([...jobs._tracked.values()].every((e) => e.mode === "poll"), "no child object → liveness polling");
});

test("the poll fallback scores a vanished pid as a crash (no exit code available)", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    jobs._reset();
    env.cleanup();
  });
  installedAt("2.0.0");
  jobs._reset();
  jobs.init({ emit: () => {} });
  jobs._setCrashConfig({ pollMs: 20 });

  // a real, live process whose ChildProcess the tracker is deliberately not
  // given — the only thing it can do is watch the pid disappear
  const proc = spawn("sh", ["-c", "sleep 0.15"], { detached: true, stdio: "ignore" });
  proc.unref();
  const entry = jobs.trackLaunch({ appId: APP.id, artifactId: ARTIFACT.id, version: "2.0.0", pid: proc.pid });
  assert.strictEqual(entry.mode, "poll");
  t.after(() => {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  const rec = await waitFor(crashRec, "the polled disappearance to be recorded");
  assert.strictEqual(rec.count, 1);
});

/* ------------------------------------------------------------------ */
/* the model                                                           */
/* ------------------------------------------------------------------ */

test("mergeInstalled surfaces crashCount + crashLoop for the installed version only", () => {
  const state = {
    installed: { crashy: { "appimage-linux": { version: "2.0.0", path: "/x", installedAt: "now" } } },
    crashes: {},
  };
  const app = () => ({
    id: "crashy",
    name: "Crashy",
    latest: { version: "2.0.0" },
    artifacts: [Object.assign({}, ARTIFACT, { sourceVersion: "2.0.0" })],
  });

  // no crashes at all
  let merged = discovery.mergeInstalled(app(), state);
  assert.strictEqual(merged.artifacts[0].crashCount, 0);
  assert.strictEqual(merged.artifacts[0].crashLoop, false);

  // two crashes: counted, but not a loop yet
  state.crashes["crashy::appimage-linux"] = { version: "2.0.0", count: 2, lastAt: "2026-08-16T00:00:00Z" };
  merged = discovery.mergeInstalled(app(), state);
  assert.strictEqual(merged.artifacts[0].crashCount, 2);
  assert.strictEqual(merged.artifacts[0].crashLoop, false);
  assert.strictEqual(merged.artifacts[0].lastCrashAt, "2026-08-16T00:00:00Z");

  // three: crash loop
  state.crashes["crashy::appimage-linux"].count = 3;
  merged = discovery.mergeInstalled(app(), state);
  assert.strictEqual(merged.artifacts[0].crashLoop, true);

  // the record belongs to an older build → invisible
  state.crashes["crashy::appimage-linux"] = { version: "1.0.0", count: 7, lastAt: "x" };
  merged = discovery.mergeInstalled(app(), state);
  assert.strictEqual(merged.artifacts[0].crashCount, 0);
  assert.strictEqual(merged.artifacts[0].crashLoop, false);

  // nothing installed → nothing to warn about
  state.installed = {};
  state.crashes["crashy::appimage-linux"] = { version: "2.0.0", count: 9, lastAt: "x" };
  merged = discovery.mergeInstalled(app(), state);
  assert.strictEqual(merged.artifacts[0].crashCount, 0);
});

test("tag-shaped versions still match (v2.0.0 record vs 2.0.0 install)", () => {
  const state = {
    installed: { crashy: { "appimage-linux": { version: "2.0.0", path: "/x", installedAt: "now" } } },
    crashes: { "crashy::appimage-linux": { version: "v2.0.0", count: 4, lastAt: "x" } },
  };
  const app = {
    id: "crashy",
    name: "Crashy",
    latest: { version: "2.0.0" },
    artifacts: [Object.assign({}, ARTIFACT, { sourceVersion: "2.0.0" })],
  };
  assert.strictEqual(discovery.mergeInstalled(app, state).artifacts[0].crashLoop, true);
});

/* ------------------------------------------------------------------ */
/* the state store                                                     */
/* ------------------------------------------------------------------ */

test("recordCrash increments per version, resetCrashes forgets", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(stateStore.recordCrash("a", "b", "1.0").count, 1);
  assert.strictEqual(stateStore.recordCrash("a", "b", "1.0").count, 2);
  assert.strictEqual(stateStore.recordCrash("a", "b", "1.1").count, 1, "version change restarts the count");
  assert.strictEqual(stateStore.getCrashes("a", "b").version, "1.1");
  assert.ok(stateStore.resetCrashes("a", "b"));
  assert.strictEqual(stateStore.getCrashes("a", "b"), null);
  assert.strictEqual(stateStore.resetCrashes("a", "b"), null, "resetting nothing writes nothing");

  // survives a round-trip through the file
  stateStore.recordCrash("a", "b", "2.0");
  assert.strictEqual(stateStore.load().crashes["a::b"].count, 1);
  assert.ok(fs.existsSync(config.statePath()));
});

/* ------------------------------------------------------------------ */
/* hub independence                                                    */
/* ------------------------------------------------------------------ */

test("watching a launch does not tie the child to the hub (or the hub to the child)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-detach-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const marker = path.join(dir, "child.pid");
  const helper = path.join(dir, "helper.js");
  // A stand-in hub: spawns through the real spawnDetached, registers the watch
  // exactly like jobs.launch does, then exits. If the tracking kept a live
  // handle referenced, this process would hang until the child ended.
  fs.writeFileSync(
    helper,
    `const util = require(${JSON.stringify(path.resolve(__dirname, "../../src/main/install/util.js"))});
const fs = require("fs");
let seen = null;
const off = util.onSpawn((c) => { seen = c; });
const child = util.spawnDetached("sh", ["-c", "sleep 30"]);
off();
if (!seen || seen.pid !== child.pid) { console.error("hook missed the spawn"); process.exit(2); }
seen.on("exit", () => {});           // the watchdog's listener
fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
`
  );

  const started = Date.now();
  execFileSync(process.execPath, [helper], { timeout: 8000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `the parent exited on its own (${elapsed}ms), it did not wait for the child`);

  const pid = Number(fs.readFileSync(marker, "utf8"));
  assert.ok(pid > 0);
  let aliveAfter = true;
  try {
    process.kill(pid, 0);
  } catch (_) {
    aliveAfter = false;
  }
  assert.ok(aliveAfter, "the launched app outlives the hub");
  try {
    process.kill(pid, "SIGKILL");
  } catch (_) {
    /* already gone */
  }
});
