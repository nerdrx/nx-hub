"use strict";
// src/cli/checkpoint.js — `nx checkpoint` (SPEC v0.10 "Ecosystem checkpoints").
//
// The reconstruction itself is tested in test/core/checkpoints.test.js. What is
// under test here is the terminal's side of the bargain: the plan table, the
// confirmation that has to name EVERY action before anything runs, the phase
// lines, and the exit codes (0 with skips, 2 when an action failed).

const test = require("node:test");
const assert = require("node:assert");

const cli = require("../../src/cli/index");
const checkpointCli = require("../../src/cli/checkpoint");
const checkpoints = require("../../src/main/checkpoints");
const fx = require("./fixtures");

const NOON = Date.parse("2026-08-15T12:00:00Z");
const DAY = 86400000;

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

function planRow(over = {}) {
  return Object.assign(
    {
      appId: "wivrn-nx",
      appName: "WiVRn NX",
      artifactId: "apk-adb-android",
      version: "1.3.0",
      currentVersion: "1.4.0",
      action: "install",
      tag: "v1.3.0",
      snapshot: null,
      snapshotAt: null,
      uncertain: false,
      why: null,
      skipReason: null,
    },
    over
  );
}

function plan(rows, over = {}) {
  const apps = rows || [];
  return Object.assign(
    {
      ts: NOON - 2 * DAY,
      iso: new Date(NOON - 2 * DAY).toISOString(),
      now: NOON,
      apps,
      uncertain: apps.some((a) => a.uncertain),
      actionable: apps.filter((a) => a.action !== "none" && !a.skipReason).length,
      skipped: apps.filter((a) => a.skipReason).length,
      horizon: NOON - 9 * DAY,
      truncated: false,
    },
    over
  );
}

/**
 * A checkpoints stand-in. parseWhen and reasonText are the REAL ones (the CLI
 * must speak the module's own grammar); the plan and the verdict are canned.
 */
function fakeCheckpoints(over = {}) {
  const calls = [];
  return {
    calls,
    parseWhen: (v) => checkpoints.parseWhen(v, { now: () => NOON }),
    reasonText: checkpoints.reasonText,
    checkpointAt: async (when, opts) => {
      calls.push(["checkpointAt", when, opts]);
      return over.plan || plan([planRow()]);
    },
    restore: async (when, opts) => {
      calls.push(["restore", when, opts]);
      if (opts && opts.emit) {
        opts.emit({ type: "checkpoint-progress", phase: "planning", appId: null });
        opts.emit({ type: "checkpoint-progress", phase: "installing", appId: "wivrn-nx", artifactId: "apk-adb-android", version: "1.3.0" });
        opts.emit({ type: "checkpoint-progress", phase: "done", appId: null });
      }
      return (
        over.result || {
          ok: true,
          ts: NOON - 2 * DAY,
          iso: new Date(NOON - 2 * DAY).toISOString(),
          configs: Boolean(opts && opts.configs),
          results: [{ appId: "wivrn-nx", artifactId: "apk-adb-android", action: "install", ok: true }],
          counts: { done: 1, failed: 0, skipped: 0 },
          plan: plan([planRow()]),
        }
      );
    },
  };
}

function fakeRuntime() {
  const calls = [];
  return {
    calls,
    hubVersion: () => "0.10.0",
    boot() {},
    on: () => () => {},
    apps: async () => fx.APPS,
    cached: () => ({ apps: fx.APPS, lastRefresh: null, errors: [] }),
    releases: async (id) => {
      calls.push(["releases", id]);
      return [{ tag: "v1.3.0", version: "1.3.0" }];
    },
    install: async (appId, artifactId, opts = {}) => {
      calls.push(["install", appId, artifactId, opts.tag || null]);
      return { ok: true, message: `Installed ${appId}` };
    },
    uninstall: async (appId, artifactId) => {
      calls.push(["uninstall", appId, artifactId]);
      return { ok: true, message: `Removed ${appId}` };
    },
  };
}

async function runCli(argv, { cp = fakeCheckpoints(), runtime = fakeRuntime(), confirm } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime,
    stdout,
    stderr,
    confirm,
    checkpoints: cp,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text, cp, runtime };
}

/* ---------------------------------------------------------------- dispatch */

test("cli checkpoint: it is in the help, with both subcommands", async () => {
  const r = await runCli(["help"]);
  assert.match(r.out, /checkpoint\s+show <when> \| restore <when>/);
});

test("cli checkpoint: a bare `nx checkpoint` asks for a time", async () => {
  const r = await runCli(["checkpoint"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /Name a point in time/);
});

test("cli checkpoint: an unreadable `when` is a user error, not a crash", async () => {
  const r = await runCli(["checkpoint", "show", "tuesday"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /cannot read "tuesday"/);
  assert.match(r.err, /24h, 2d, 90m/);
  assert.equal(r.cp.calls.length, 0); // the journal was never opened
});

test("cli checkpoint: `nx checkpoint 2d` is `nx checkpoint show 2d`", async () => {
  const r = await runCli(["checkpoint", "2d"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.equal(r.cp.calls[0][0], "checkpointAt");
  assert.match(r.out, /WiVRn NX/);
});

test("cli checkpoint: show renders the plan — now, then, action, uncertainty", async () => {
  const cp = fakeCheckpoints({
    plan: plan([
      planRow({ snapshot: "snap.tar.zst", snapshotAt: "2026-08-13T09:00:00.000Z" }),
      planRow({ appId: "limbo", appName: "LIMBO", artifactId: "linux", version: null, currentVersion: "2.0", action: "remove", tag: null }),
      planRow({
        appId: "ghost",
        appName: "Ghost",
        artifactId: "x",
        version: null,
        currentVersion: "2.0",
        action: "none",
        tag: null,
        uncertain: true,
        why: "the journal does not reach back that far",
        skipReason: "uncertain",
      }),
    ]),
  });
  const r = await runCli(["checkpoint", "show", "2d"], { cp });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /NOW\s+THEN\s+ACTION\s+CONFIG/);
  assert.match(r.out, /WiVRn NX .*1\.4\.0\s+1\.3\.0\s+install\s+2026-08-13 09:00/);
  assert.match(r.out, /LIMBO .*2\.0\s+—\s+remove/);
  assert.match(r.out, /Ghost .*\?\s+skip/); // never a guessed version
  assert.match(r.out, /skipped/);
  assert.match(r.out, /does not reach back that far/);
  assert.match(r.out, /2 actions, 1 skipped/);
});

test("cli checkpoint: a plan with nothing in it says so", async () => {
  const r = await runCli(["checkpoint", "show", "now"], { cp: fakeCheckpoints({ plan: plan([]) }) });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /Nothing to put back/);
});

test("cli checkpoint: --json prints the plan and nothing else", async () => {
  const r = await runCli(["checkpoint", "show", "2d", "--json"]);
  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
  assert.equal(data.apps.length, 1);
  assert.equal(data.apps[0].tag, "v1.3.0");
  assert.equal(data.ts, NOON - 2 * DAY);
});

/* ---------------------------------------------------------------- restore */

test("cli checkpoint: restore lists EVERY action before it asks", async () => {
  const asked = [];
  const cp = fakeCheckpoints({
    plan: plan([
      planRow({ snapshot: "snap.tar.zst", snapshotAt: "2026-08-13T09:00:00.000Z" }),
      planRow({ appId: "limbo", appName: "LIMBO", artifactId: "linux", version: null, currentVersion: "2.0", action: "remove", tag: null }),
      planRow({ appId: "ghost", appName: "Ghost", artifactId: "x", version: null, action: "none", uncertain: true, why: "no record", skipReason: "uncertain" }),
    ]),
  });
  const r = await runCli(["checkpoint", "restore", "2d", "--configs"], {
    cp,
    confirm: async (q) => {
      asked.push(q);
      return false;
    },
  });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.err, /install WiVRn NX .*1\.4\.0 → 1\.3\.0 \(v1\.3\.0\)/);
  assert.match(r.err, /remove\s+LIMBO/);
  assert.match(r.err, /config\s+WiVRn NX .*from 2026-08-13 09:00/);
  assert.match(r.err, /skip\s+Ghost/);
  assert.match(asked[0], /Apply this checkpoint\? 2 actions, configs included\./);
  assert.match(r.err, /Nothing changed/);
  assert.ok(!cp.calls.some((c) => c[0] === "restore")); // declined = untouched
});

test("cli checkpoint: -y skips the question, streams the phases and reports", async () => {
  const r = await runCli(["checkpoint", "restore", "2d", "-y"], {
    confirm: async () => {
      throw new Error("must not ask");
    },
  });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.err, /reading the journal…/);
  assert.match(r.err, /install wivrn-nx — apk-adb-android 1\.3\.0/);
  assert.match(r.err, /checkpoint applied/);
  assert.match(r.out, /Checkpoint 2026-08-13 12:00.*1 done, 0 failed, 0 skipped/);
  const call = r.cp.calls.find((c) => c[0] === "restore");
  assert.equal(call[1], NOON - 2 * DAY);
  assert.equal(call[2].configs, false);
  assert.equal(typeof call[2].runJob, "function"); // the jobs go through the CLI runtime
});

test("cli checkpoint: --configs reaches the module", async () => {
  const r = await runCli(["checkpoint", "restore", "2d", "-y", "--configs"]);
  assert.equal(r.cp.calls.find((c) => c[0] === "restore")[2].configs, true);
  assert.equal(r.code, cli.EXIT_OK);
});

test("cli checkpoint: a failed action exits 2 and names it", async () => {
  const cp = fakeCheckpoints({
    result: {
      ok: false,
      ts: NOON - 2 * DAY,
      configs: false,
      results: [
        { appId: "wivrn-nx", artifactId: "apk-adb-android", action: "install", ok: true },
        { appId: "limbo", artifactId: "linux", action: "remove", ok: false, error: "adb is not connected" },
      ],
      counts: { done: 1, failed: 1, skipped: 0 },
    },
  });
  const r = await runCli(["checkpoint", "restore", "2d", "-y"], { cp });
  assert.equal(r.code, cli.EXIT_FAIL);
  assert.match(r.out, /1 done, 1 failed/);
  assert.match(r.out, /limbo — linux.*adb is not connected/);
});

test("cli checkpoint: skips alone still exit 0, and are reported", async () => {
  const cp = fakeCheckpoints({
    result: {
      ok: true,
      ts: NOON - 2 * DAY,
      configs: false,
      results: [{ appId: "ghost", artifactId: "x", action: "none", ok: false, skipped: true, reason: "uncertain" }],
      counts: { done: 0, failed: 0, skipped: 1 },
    },
  });
  const r = await runCli(["checkpoint", "restore", "2d", "-y"], { cp });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /ghost — x.*skipped \(uncertain\)/);
});

test("cli checkpoint: a plan with only skips never runs the executor", async () => {
  const cp = fakeCheckpoints({
    plan: plan([planRow({ action: "none", uncertain: true, version: null, why: "no record", skipReason: "uncertain" })]),
  });
  const r = await runCli(["checkpoint", "restore", "2d", "-y"], { cp });
  assert.equal(r.code, cli.EXIT_OK);
  assert.ok(!cp.calls.some((c) => c[0] === "restore"));
  assert.match(r.out, /skipped/);
});

test("cli checkpoint: restore --json puts the verdict on stdout and the events with it", async () => {
  const r = await runCli(["checkpoint", "restore", "2d", "-y", "--json"]);
  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
  assert.equal(data.counts.done, 1);
  assert.deepEqual(data.events.map((e) => e.phase), ["planning", "installing", "done"]);
  assert.equal(r.err.includes("reading the journal"), false); // json mode keeps stderr quiet
});

/* ---------------------------------------------------------------- rendering */

test("cli checkpoint: renderPhase paints every phase the module can raise", () => {
  const lines = checkpoints.PHASES.map((phase) =>
    checkpointCli.renderPhase({ type: "checkpoint-progress", phase, appId: phase === "done" ? null : "a", artifactId: "x" })
  );
  assert.equal(lines.length, 6);
  for (const line of lines) assert.ok(line.trim().length, "every phase renders something");
  assert.match(checkpointCli.renderPhase({ phase: "failed", appId: "a", error: "boom" }), /a — x|a/);
  assert.match(checkpointCli.renderPhase({ phase: "failed", appId: null }), /did not fully apply/);
});

test("cli checkpoint: times are formatted from the ISO string, never by locale", () => {
  assert.equal(checkpointCli.whenText(Date.parse("2026-08-13T09:04:05Z")), "2026-08-13 09:04");
  assert.equal(checkpointCli.whenText(null), "—");
  assert.equal(checkpointCli.stampText("2026-08-13T09:04:05.123Z"), "2026-08-13 09:04");
  assert.equal(checkpointCli.stampText("nonsense"), "—");
});

test("cli checkpoint: an uncertain row never shows a version, and a removal shows a dash", () => {
  assert.equal(checkpointCli.thenText(planRow({ uncertain: true, version: null })), "?");
  assert.equal(checkpointCli.thenText(planRow({ version: null })), "—");
  assert.equal(checkpointCli.thenText(planRow()), "1.3.0");
});

test("cli checkpoint: only the apps being put back get their config offered", () => {
  const p = plan([
    planRow({ snapshot: "a.tar.zst", snapshotAt: "2026-08-13T09:00:00.000Z" }),
    planRow({ appId: "wivrn-nx", artifactId: "tarball-prefix-linux", snapshot: "a.tar.zst", snapshotAt: "2026-08-13T09:00:00.000Z" }),
    planRow({ appId: "limbo", artifactId: "linux", action: "remove", version: null, snapshot: "b.tar.zst", snapshotAt: "2026-08-13T09:00:00.000Z" }),
  ]);
  const actions = p.apps.filter((e) => e.action !== "none" && !e.skipReason);
  const rows = checkpointCli.configsIn(p, actions);
  assert.deepEqual(rows.map((r) => r.appId), ["wivrn-nx"]); // once per app, installs only
});
