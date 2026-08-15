"use strict";
// The CLI end to end on the REAL stack — discovery, jobs, state and the install
// engine — against the mock GitHub server, in temp dirs. No fakes below
// src/cli, no network beyond 127.0.0.1, nothing outside the sandbox.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const { createRuntime } = require("../../src/cli/runtime");
const config = require("../../src/main/config");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");

function fakeStream() {
  const chunks = [];
  return {
    isTTY: false,
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

test("cli e2e: refresh → list → install → list → uninstall against the mock GitHub", async (t) => {
  const mock = await helpers.startMockGitHub();
  const env = helpers.useTempEnv();
  const xdg = path.join(env.root, "xdg");
  const previous = {
    base: process.env.NX_HUB_GITHUB_BASE,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.NX_HUB_GITHUB_BASE = mock.base;
  process.env.XDG_DATA_HOME = xdg;
  fs.mkdirSync(xdg, { recursive: true });

  // fresh module state — other suites in this process may have left some
  jobs._reset();
  discovery._setCached({ apps: [], releases: {}, repos: [], releasesByRepo: {}, errors: [], lastRefresh: null });
  const runtime = createRuntime();

  const runs = [];
  const nx = async (...argv) => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await cli.run(argv, {
      runtime,
      stdout,
      stderr,
      env: process.env,
      platform: "linux",
      color: false,
      confirm: async () => true,
    });
    const result = { argv, code, out: stdout.text, err: stderr.text };
    runs.push(result);
    return result;
  };

  t.after(async () => {
    process.env.NX_HUB_GITHUB_BASE = previous.base;
    if (previous.xdg == null) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous.xdg;
    await mock.close();
    env.cleanup();
    jobs._reset();
  });

  /* ---- discovery ---- */

  const refreshed = await nx("refresh");
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.match(refreshed.out, /apps/);

  const listed = await nx("list", "--json");
  assert.equal(listed.code, 0, listed.err);
  const doc = JSON.parse(listed.out);
  const ids = doc.apps.map((a) => a.id);
  assert.ok(ids.includes("banish-protocol"), `discovered: ${ids.join(", ")}`);
  assert.ok(ids.includes("quadforge"));
  const limbo = doc.apps.find((a) => a.id === "banish-protocol");
  assert.equal(limbo.status, "available");
  assert.equal(limbo.installedVersions.length, 0);
  assert.ok(
    limbo.artifacts.some((a) => a.id === "archive-dir-linux"),
    "the linux zip is classified as archive-dir"
  );

  /* ---- install ---- */

  const installed = await nx("install", "banish", "archive-dir-linux");
  assert.equal(installed.code, 0, installed.err);
  assert.match(installed.err, /Installed/);
  // the plain (non-TTY) progress path prints a line per phase
  assert.match(installed.err, /download \d+%/);
  assert.match(installed.err, /install \d+%/);

  const record = stateStore.getInstall("banish-protocol", "archive-dir-linux");
  assert.ok(record, "state.json carries the install");
  assert.equal(record.version, "2.0");
  assert.ok(fs.existsSync(record.path), `install dir ${record.path}`);
  assert.equal(
    record.path,
    path.join(config.installRoot(), "nx", "banish-protocol", "archive-dir-linux"),
    "installed under the sandboxed install root, per SPEC layout"
  );
  assert.ok(fs.existsSync(path.join(record.path, ".nx-manifest.json")), "engine wrote its manifest");

  /* ---- the model sees it ---- */

  const afterInstall = JSON.parse((await nx("list", "--json")).out);
  const limboAfter = afterInstall.apps.find((a) => a.id === "banish-protocol");
  assert.equal(limboAfter.status, "installed");
  assert.deepEqual(limboAfter.installedVersions, ["2.0"]);
  assert.equal(afterInstall.summary.installed, 1);

  const listText = await nx("list");
  assert.match(listText.out, /✓\s+LIMBO PROTOCOL\s+2\.0/);

  const info = await nx("info", "banish");
  assert.equal(info.code, 0);
  assert.match(info.out, /archive-dir-linux\s+Linux build\s+linux/);
  assert.match(info.out, /up to date/);

  /* ---- doctor sees the sandbox, not the real hub ---- */

  const doctor = await nx("doctor", "--json");
  const health = JSON.parse(doctor.out);
  assert.equal(health.dataDir, env.dataDir);
  assert.equal(health.installRoot, env.installRoot);
  assert.equal(health.engine, true);
  assert.equal(health.installedCount, 1);
  assert.ok(health.appCount >= 3);

  /* ---- uninstall ---- */

  const removed = await nx("uninstall", "banish", "--yes");
  assert.equal(removed.code, 0, removed.err);
  assert.equal(stateStore.getInstall("banish-protocol", "archive-dir-linux"), null);
  assert.equal(fs.existsSync(record.path), false, "install dir is gone");

  /* ---- user errors keep their exit code on the real stack too ---- */

  assert.equal((await nx("install", "no-such-app")).code, cli.EXIT_USER);
  assert.equal((await nx("frobnicate")).code, cli.EXIT_USER);
});

test("cli e2e: a rate-limited GitHub is reported, never crashed on", async (t) => {
  const mock = await helpers.startMockGitHub({ rateLimited: true });
  const env = helpers.useTempEnv();
  const previousBase = process.env.NX_HUB_GITHUB_BASE;
  process.env.NX_HUB_GITHUB_BASE = mock.base;

  jobs._reset();
  discovery._setCached({ apps: [], releases: {}, repos: [], releasesByRepo: {}, errors: [], lastRefresh: null, rateLimit: null });
  const runtime = createRuntime();

  t.after(async () => {
    process.env.NX_HUB_GITHUB_BASE = previousBase;
    await mock.close();
    env.cleanup();
  });

  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(["list"], { runtime, stdout, stderr, env: process.env, platform: "linux", color: false });
  assert.equal(code, 0, "a throttled GitHub still lists what we know");
  assert.match(stdout.text, /Nothing discovered yet|A P P S/);
  assert.match(stderr.text, /rate limit/i);
});
