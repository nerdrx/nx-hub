"use strict";
// src/cli/index.js — command dispatch, argument handling and exit codes.
// The runtime (discovery/jobs/engine) is faked: this is about the CLI's own
// decisions, not about the hub's logic.

const test = require("node:test");
const assert = require("node:assert");

const cli = require("../../src/cli/index");
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

/** A runtime stand-in that records what the CLI asked it to do. */
function fakeRuntime(over = {}) {
  const calls = [];
  const base = {
    calls,
    hubVersion: () => "0.3.6",
    boot() {},
    on: () => () => {},
    apps: async (opts) => {
      calls.push(["apps", opts || {}]);
      return fx.APPS;
    },
    cached: () => ({ apps: fx.APPS, lastRefresh: "2026-08-15T22:01:20.006Z", errors: [], rateLimit: null }),
    refresh: async (opts) => {
      calls.push(["refresh", opts]);
      return { apps: fx.APPS, lastRefresh: "2026-08-15T22:01:20.006Z", errors: [] };
    },
    releases: async (id) => {
      calls.push(["releases", id]);
      return fx.RELEASES;
    },
    install: async (appId, artifactId, opts = {}) => {
      calls.push(["install", appId, artifactId, opts.tag || null]);
      if (opts.onProgress) opts.onProgress({ phase: "download", pct: 50, message: "half" });
      return { ok: true, message: `Installed ${appId}` };
    },
    uninstall: async (appId, artifactId) => {
      calls.push(["uninstall", appId, artifactId]);
      return { ok: true, message: `Removed ${appId}` };
    },
    rollback: async (appId, artifactId) => {
      calls.push(["rollback", appId, artifactId]);
      return { ok: true, message: `Restored ${appId}` };
    },
    launch: async (appId, artifactId) => {
      calls.push(["launch", appId, artifactId]);
      return true;
    },
    doctor: async () => fx.DOCTOR,
  };
  return Object.assign(base, over);
}

/** Run the CLI with everything faked. Returns {code, out, err, runtime}. */
async function runCli(argv, { runtime = fakeRuntime(), confirm, env } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime,
    stdout,
    stderr,
    confirm,
    env: Object.assign({ NO_COLOR: "1" }, env),
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text, runtime };
}

/* ---------------------------------------------------------------- basics */

test("cli: bare `nx` prints help and exits 1 (nothing was asked)", async () => {
  const r = await runCli([]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.out, /nx <command>/);
});

test("cli: `nx help` exits 0", async () => {
  const r = await runCli(["help"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /install <app>/);
});

test("cli: `nx --version` prints the hub version", async () => {
  const r = await runCli(["--version"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.equal(r.out.trim(), "0.3.6");
});

test("cli: an unknown command is a user error", async () => {
  const r = await runCli(["frobnicate"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /unknown command "frobnicate"/);
  assert.match(r.err, /nx help/);
});

test("cli: an unknown flag is a user error and nothing runs", async () => {
  const r = await runCli(["list", "--jsonn"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /unknown option --jsonn/);
  assert.deepEqual(r.runtime.calls, []);
});

test("cli: aliases resolve to real commands", async () => {
  const r = await runCli(["ls"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /A P P S/);
});

/* ---------------------------------------------------------------- list/info */

test("cli: list renders the table, --json emits parseable output only", async () => {
  const plainRun = await runCli(["list"]);
  assert.equal(plainRun.code, cli.EXIT_OK);
  assert.match(plainRun.out, /WiVRn NX/);

  const jsonRun = await runCli(["list", "--json"]);
  const doc = JSON.parse(jsonRun.out);
  assert.equal(doc.hubVersion, "0.3.6");
  assert.equal(doc.platform, "linux");
  assert.equal(doc.apps.length, fx.APPS.length);
  assert.equal(jsonRun.err, "", "no decoration on stderr in json mode");
});

test("cli: info resolves a prefix; ambiguity exits 1 with the candidates", async () => {
  const ok = await runCli(["info", "wiv"]);
  assert.equal(ok.code, cli.EXIT_OK);
  assert.match(ok.out, /nerdrx\/wivrn-nx/);

  const ambiguous = await runCli(["info", "l"]);
  assert.equal(ambiguous.code, cli.EXIT_USER);
  assert.match(ambiguous.err, /matches \d+ apps/);
  assert.match(ambiguous.err, /did you mean:/);

  const missing = await runCli(["info", "nope"]);
  assert.equal(missing.code, cli.EXIT_USER);
  assert.match(missing.err, /No app matches "nope"/);
});

test("cli: errors are JSON too when --json was asked for", async () => {
  const r = await runCli(["info", "nope", "--json"]);
  assert.equal(r.code, cli.EXIT_USER);
  const doc = JSON.parse(r.out);
  assert.equal(doc.ok, false);
  assert.match(doc.error, /No app matches/);
});

/* ---------------------------------------------------------------- install */

test("cli: install picks the only installable artifact by itself", async () => {
  const r = await runCli(["install", "quadforge"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(r.runtime.calls.at(-1), ["install", "quadforge", "blender-addon-linux", null]);
  assert.match(r.err, /Installed quadforge/);
});

test("cli: install refuses to guess between two artifacts", async () => {
  const r = await runCli(["install", "wivrn-nx"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /has 2 downloads — name one/);
  assert.match(r.err, /apk-adb-android \(android\), tarball-prefix-linux \(linux\)/);
  assert.ok(!r.runtime.calls.some((c) => c[0] === "install"));
});

test("cli: install takes an artifact and a --tag", async () => {
  const r = await runCli(["install", "wivrn", "apk", "--tag", "v1.3.0"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(r.runtime.calls.at(-1), ["install", "wivrn-nx", "apk-adb-android", "v1.3.0"]);
});

test("cli: an app with no installable release is a user error", async () => {
  const r = await runCli(["install", "lonely-repo"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /no release the hub can install/);
});

test("cli: a failed job exits 2, not 1", async () => {
  const runtime = fakeRuntime({
    install: async () => {
      const err = new Error("Checksum mismatch for quadforge-1.3.zip");
      err.operational = true;
      throw err;
    },
  });
  const r = await runCli(["install", "quadforge"], { runtime });
  assert.equal(r.code, cli.EXIT_FAIL);
  assert.match(r.err, /Checksum mismatch/);
});

/* ---------------------------------------------------------------- uninstall */

test("cli: uninstall confirms first, and does nothing when refused", async () => {
  const asked = [];
  const r = await runCli(["uninstall", "quadforge"], {
    confirm: async (q) => {
      asked.push(q);
      return false;
    },
  });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(asked[0], /Remove QuadForge — Blender addon/);
  assert.ok(!r.runtime.calls.some((c) => c[0] === "uninstall"));
  assert.match(r.err, /Nothing removed/);
});

test("cli: uninstall --yes skips the question", async () => {
  const r = await runCli(["uninstall", "quadforge", "--yes"], {
    confirm: async () => {
      throw new Error("must not ask");
    },
  });
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(r.runtime.calls.at(-1), ["uninstall", "quadforge", "blender-addon-linux"]);
});

test("cli: uninstalling something that is not installed is a user error", async () => {
  const r = await runCli(["uninstall", "banish", "-y"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.match(r.err, /is not installed/);
});

/* ---------------------------------------------------------------- update */

test("cli: bare update lists what is pending without installing anything", async () => {
  const r = await runCli(["update"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /1 update pending: wivrn-nx\/apk-adb-android/);
  assert.match(r.out, /nx update --all/);
  assert.ok(!r.runtime.calls.some((c) => c[0] === "install"));
});

test("cli: update --all installs every pending artifact", async () => {
  const r = await runCli(["update", "--all"]);
  assert.equal(r.code, cli.EXIT_OK);
  const installs = r.runtime.calls.filter((c) => c[0] === "install");
  assert.deepEqual(installs, [["install", "wivrn-nx", "apk-adb-android", null]]);
});

test("cli: update <app> installs that app's pending artifacts straight away", async () => {
  const r = await runCli(["update", "wivrn"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(r.runtime.calls.at(-1), ["install", "wivrn-nx", "apk-adb-android", null]);
});

test("cli: update <app> with nothing pending says so and exits 0", async () => {
  const r = await runCli(["update", "quadforge"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /QuadForge is up to date/);
});

test("cli: a failed update reports the app and exits 2, after trying them all", async () => {
  const apps = [
    fx.app({ id: "a", name: "A", artifacts: [fx.artifact({ updateAvailable: true, installed: { version: "0.9" } })] }),
    fx.app({ id: "b", name: "B", artifacts: [fx.artifact({ updateAvailable: true, installed: { version: "0.9" } })] }),
  ];
  const runtime = fakeRuntime({
    apps: async () => apps,
    install: async (appId) => {
      runtime.calls.push(["install", appId]);
      if (appId === "a") throw Object.assign(new Error("boom"), { operational: true });
      return { ok: true, message: `Installed ${appId}` };
    },
  });
  const r = await runCli(["update", "--all"], { runtime });
  assert.equal(r.code, cli.EXIT_FAIL);
  assert.match(r.err, /A — Linux build: boom/);
  assert.ok(
    runtime.calls.some((c) => c[0] === "install" && c[1] === "b"),
    "one failure does not stop the rest"
  );
});

/* ---------------------------------------------------------------- rest */

test("cli: launch only offers what is installed and launchable", async () => {
  const ok = await runCli(["launch", "wivrn"]);
  assert.equal(ok.code, cli.EXIT_OK);
  assert.deepEqual(ok.runtime.calls.at(-1), ["launch", "wivrn-nx", "apk-adb-android"]);
  assert.match(ok.out, /Launched WiVRn NX/);

  const notLaunchable = await runCli(["launch", "quadforge"]);
  assert.equal(notLaunchable.code, cli.EXIT_USER);
  assert.match(notLaunchable.err, /nothing installed to launch/);
});

test("cli: rollback asks before restoring", async () => {
  const r = await runCli(["rollback", "quadforge", "-y"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(r.runtime.calls.at(-1), ["rollback", "quadforge", "blender-addon-linux"]);

  const none = await runCli(["rollback", "wivrn", "-y"]);
  assert.equal(none.code, cli.EXIT_USER);
  assert.match(none.err, /no kept previous version/);
});

test("cli: versions lists releases, --json carries them raw", async () => {
  const r = await runCli(["versions", "wivrn"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /v1\.5\.0-rc1/);

  const j = await runCli(["versions", "wivrn", "--json"]);
  const doc = JSON.parse(j.out);
  assert.equal(doc.id, "wivrn-nx");
  assert.equal(doc.releases.length, fx.RELEASES.length);
});

test("cli: refresh forces discovery only when asked", async () => {
  const soft = await runCli(["refresh"]);
  assert.equal(soft.code, cli.EXIT_OK);
  assert.deepEqual(soft.runtime.calls[0], ["refresh", { force: false }]);
  assert.match(soft.out, /6 apps/);

  const hard = await runCli(["refresh", "--force", "--json"]);
  assert.deepEqual(hard.runtime.calls[0], ["refresh", { force: true }]);
  const doc = JSON.parse(hard.out);
  assert.equal(doc.ok, true);
  assert.equal(doc.summary.total, 6);
});

test("cli: doctor runs a discovery pass first, unless --offline", async () => {
  const online = await runCli(["doctor"]);
  assert.equal(online.code, cli.EXIT_OK);
  assert.ok(online.runtime.calls.some((c) => c[0] === "apps"), "doctor refreshed");
  assert.match(online.out, /D O C T O R/);

  const offline = await runCli(["doctor", "--offline", "--json"]);
  assert.ok(!offline.runtime.calls.some((c) => c[0] === "apps"), "--offline touches no network");
  assert.equal(JSON.parse(offline.out).hubVersion, "0.3.6");
});

test("cli: --plain strips every escape from a styled stream", async () => {
  const stdout = fakeStream({ isTTY: true });
  const stderr = fakeStream({ isTTY: true });
  const code = await cli.run(["list", "--plain"], {
    runtime: fakeRuntime(),
    stdout,
    stderr,
    env: {},
    platform: "linux",
  });
  assert.equal(code, cli.EXIT_OK);
  assert.ok(!stdout.text.includes("\u001b["), "no ANSI at all");
});

test("cli: NO_COLOR is honoured on a TTY", async () => {
  const stdout = fakeStream({ isTTY: true });
  await cli.run(["list"], { runtime: fakeRuntime(), stdout, stderr: fakeStream(), env: { NO_COLOR: "1" }, platform: "linux" });
  assert.ok(!stdout.text.includes("\u001b["));
});

test("cli: a TTY without NO_COLOR gets the violet treatment", async () => {
  const stdout = fakeStream({ isTTY: true });
  await cli.run(["list"], { runtime: fakeRuntime(), stdout, stderr: fakeStream(), env: {}, platform: "linux" });
  assert.ok(stdout.text.includes("\u001b[38;2;119;0;255m"), "NX violet");
});

test("cli: --verbose is the only way the hub's log reaches the terminal", async () => {
  const quiet = { NO_COLOR: "1" };
  await cli.run(["list"], { runtime: fakeRuntime(), stdout: fakeStream(), stderr: fakeStream(), env: quiet, platform: "linux" });
  assert.equal(quiet.NX_HUB_QUIET, "1", "the hub's console log is muted by default");

  const loud = { NO_COLOR: "1" };
  await cli.run(["list", "--verbose"], { runtime: fakeRuntime(), stdout: fakeStream(), stderr: fakeStream(), env: loud, platform: "linux" });
  assert.equal(loud.NX_HUB_QUIET, undefined, "--verbose lets it through");
});
