"use strict";
// v0.2 jobs: installVersion(tag) targeting, rollback jobs, and reuse of an
// asset that the "download" policy already fetched.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");

/** wivrn-nx with three releases, all carrying the same two asset shapes. */
function versionedData(base) {
  const data = helpers.defaultData(base);
  const zip = helpers.makeZip({ "run.sh": "#!/bin/sh\n" });
  const mk = (tag, when, extra) =>
    helpers.release(
      tag,
      [
        helpers.asset(base, "nerdrx/wivrn-nx", `wivrn-nx-${tag.replace(/^v/, "")}-linux.zip`, zip),
        helpers.asset(base, "nerdrx/wivrn-nx", `wivrn-nx-release-${tag.replace(/^v/, "")}.apk`, Buffer.from("apk")),
      ],
      Object.assign({ published_at: when }, extra)
    );
  data.releases["nerdrx/wivrn-nx"] = [
    mk("v1.5.0-rc1", "2026-06-01T10:00:00Z", { prerelease: true }),
    mk("v1.4.0", "2026-05-01T10:00:00Z"),
    mk("v1.3.0", "2026-04-01T10:00:00Z"),
  ];
  return data;
}

function harness(mock, env, { engine } = {}) {
  const events = [];
  const listeners = [];
  const emit = (evt) => {
    events.push(evt);
    for (const l of [...listeners]) l(evt);
  };
  jobs._reset();
  jobs.init({
    emit,
    github: github.createClient({
      baseUrl: mock.base,
      cacheDir: path.join(env.dataDir, "cache"),
      getToken: async () => null,
    }),
    engine: engine || null,
    engineLoader: null,
    relaunch: null,
    resolve: null, // real discovery cache — installVersion needs the release list
  });
  return {
    events,
    wait(jobId) {
      return new Promise((resolve) => {
        const done = events.find((e) => (e.type === "job-done" || e.type === "job-error") && e.jobId === jobId);
        if (done) return resolve(done);
        const l = (evt) => {
          if ((evt.type === "job-done" || evt.type === "job-error") && evt.jobId === jobId) {
            listeners.splice(listeners.indexOf(l), 1);
            resolve(evt);
          }
        };
        listeners.push(l);
      });
    },
  };
}

async function discover(mock, env) {
  discovery.init({
    github: github.createClient({
      baseUrl: mock.base,
      cacheDir: path.join(env.dataDir, "cache"),
      getToken: async () => null,
    }),
    emit: () => {},
    afterRefresh: null,
  });
  config.save({ owners: ["nerdrx"], extraRepos: [] });
  await discovery.refresh({ force: true });
}

test("installVersion installs the asset of the chosen release, not the latest", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const seen = [];
  const engine = {
    async install({ app, artifact, filePath, ctx }) {
      seen.push({ version: artifact.version, assetName: artifact.assetName, kind: artifact.kind, id: artifact.id });
      assert.ok(fs.existsSync(filePath), "the engine gets a real file");
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  await discover(mock, env);
  const h = harness(mock, env, { engine });
  const app = discovery.findApp("wivrn-nx");
  assert.strictEqual(app.latest.version, "1.4.0", "latest is the newest stable");
  const artifact = app.artifacts.find((a) => a.kind === "archive-dir");

  // downgrade to 1.3.0
  const done = await h.wait(jobs.installVersion("wivrn-nx", artifact.id, "v1.3.0"));
  assert.strictEqual(done.type, "job-done", done.message);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].version, "1.3.0", "the engine is handed the chosen version");
  assert.match(seen[0].assetName, /1\.3\.0/, "the matching asset of THAT release was downloaded");
  assert.strictEqual(seen[0].id, artifact.id, "the artifact keeps its stable id");
  assert.strictEqual(seen[0].kind, artifact.kind, "and its kind/overlay identity");
  assert.strictEqual(stateStore.getInstall("wivrn-nx", artifact.id).version, "1.3.0");

  // upgrade to the prerelease by tag, even though it is not "latest"
  const pre = await h.wait(jobs.installVersion("wivrn-nx", artifact.id, "v1.5.0-rc1"));
  assert.strictEqual(pre.type, "job-done", pre.message);
  assert.strictEqual(stateStore.getInstall("wivrn-nx", artifact.id).version, "1.5.0-rc1");

  // no tag → the normal "latest" path
  const latest = await h.wait(jobs.installVersion("wivrn-nx", artifact.id, null));
  assert.strictEqual(latest.type, "job-done", latest.message);
  assert.strictEqual(stateStore.getInstall("wivrn-nx", artifact.id).version, "1.4.0");
});

test("installVersion fails clearly for an unknown tag or a missing asset", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  await discover(mock, env);
  const h = harness(mock, env, { engine: { async install() { throw new Error("should not be reached"); } } });
  const artifact = discovery.findApp("wivrn-nx").artifacts[0];

  const missing = await h.wait(jobs.installVersion("wivrn-nx", artifact.id, "v9.9.9"));
  assert.strictEqual(missing.type, "job-error");
  assert.match(missing.message, /no release tagged v9\.9\.9/i);

  // a release that does not carry this artifact at all
  discovery.getCached().releases["wivrn-nx"].push(
    helpers.release("v2.0.0", [helpers.asset(mock.base, "nerdrx/wivrn-nx", "notes.txt", Buffer.from("x"))], {
      published_at: "2026-07-01T10:00:00Z",
    })
  );
  const noAsset = await h.wait(jobs.installVersion("wivrn-nx", artifact.id, "v2.0.0"));
  assert.strictEqual(noAsset.type, "job-error");
  assert.match(noAsset.message, /no download matching/i);
});

test("an already-downloaded asset is reused instead of fetched again", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const engine = {
    async install({ app, artifact, ctx }) {
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  await discover(mock, env);
  const h = harness(mock, env, { engine });
  const artifact = discovery.findApp("wivrn-nx").artifacts.find((a) => a.kind === "archive-dir");

  // pretend the "download" policy already fetched it
  const cachedFile = path.join(config.downloadsDir(), `wivrn-nx-${artifact.assetName}`);
  fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
  fs.writeFileSync(cachedFile, "already here");
  stateStore.recordDownload("wivrn-nx", artifact.id, { version: "1.4.0", path: cachedFile });

  const before = mock.stats.downloads;
  const done = await h.wait(jobs.install("wivrn-nx", artifact.id));
  assert.strictEqual(done.type, "job-done", done.message);
  assert.strictEqual(mock.stats.downloads, before, "no second download");
  assert.strictEqual(stateStore.getDownload("wivrn-nx", artifact.id), null, "the cached asset was consumed");
  assert.ok(!fs.existsSync(cachedFile), "and cleaned up afterwards");
});

test("rollback runs through the queue and records the restored version", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const calls = [];
  const engine = {
    async install({ app, artifact, ctx }) {
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
    async rollback({ app, artifact, installedPath, ctx }) {
      calls.push({ app: app.id, artifact: artifact.id, installedPath, hasPrefs: Boolean(ctx.appPrefs) });
      return { version: "1.3.0", path: installedPath, launchable: true };
    },
  };

  await discover(mock, env);
  const h = harness(mock, env, { engine });
  const artifact = discovery.findApp("wivrn-nx").artifacts.find((a) => a.kind === "archive-dir");

  await h.wait(jobs.install("wivrn-nx", artifact.id));
  const installedPath = stateStore.getInstall("wivrn-nx", artifact.id).path;
  assert.strictEqual(stateStore.getInstall("wivrn-nx", artifact.id).version, "1.4.0");

  const evt = await h.wait(jobs.rollback("wivrn-nx", artifact.id));
  assert.strictEqual(evt.type, "job-done", evt.message);
  assert.deepStrictEqual(calls, [
    { app: "wivrn-nx", artifact: artifact.id, installedPath, hasPrefs: true },
  ]);
  assert.strictEqual(stateStore.getInstall("wivrn-nx", artifact.id).version, "1.3.0", "state follows the rollback");

  const job = jobs.list().find((j) => j.id === evt.jobId);
  assert.strictEqual(job.type, "rollback");
  assert.match(job.message, /Restored/);
});

test("rollback reports clearly when the engine cannot roll this kind back", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  await discover(mock, env);
  const h = harness(mock, env, {
    engine: {
      async rollback() {
        throw new Error('"apk-adb" installs cannot be rolled back');
      },
    },
  });
  const artifact = discovery.findApp("wivrn-nx").artifacts.find((a) => a.kind === "apk-adb");
  stateStore.recordInstall("wivrn-nx", artifact.id, { version: "1.4.0", path: "/tmp/apk" });

  const evt = await h.wait(jobs.rollback("wivrn-nx", artifact.id));
  assert.strictEqual(evt.type, "job-error");
  assert.match(evt.message, /cannot be rolled back/i);
});

test("per-app launch prefs reach the engine through ctx.appPrefs", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: versionedData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const seen = [];
  const engine = {
    async launch({ ctx }) {
      seen.push(ctx.appPrefs);
      return true;
    },
  };
  await discover(mock, env);
  const h = harness(mock, env, { engine });
  const artifact = discovery.findApp("wivrn-nx").artifacts[0];
  stateStore.recordInstall("wivrn-nx", artifact.id, { version: "1.4.0", path: "/tmp/x" });
  config.setAppPref("wivrn-nx", { launchArgs: ["--fullscreen"], launchEnv: { NX_TEST: "1" } });

  await jobs.launch("wivrn-nx", artifact.id);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0].launchArgs, ["--fullscreen"]);
  assert.deepStrictEqual(seen[0].launchEnv, { NX_TEST: "1" });
  assert.ok(h.events.length >= 0);
});
