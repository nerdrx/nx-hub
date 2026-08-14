"use strict";
// ipc.buildState() — the exact shape the renderer consumes. No electron needed:
// ipc only touches electron objects through init(deps).

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");
const ipc = require("../../src/main/ipc");

function clientFor(mock, env) {
  return github.createClient({
    baseUrl: mock.base,
    rawBaseUrl: `${mock.base}/raw`,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
}

test("getState() returns the frozen surface the UI expects", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  config.save({ owners: ["nerdrx"], extraRepos: [] });
  discovery.init({ github: clientFor(mock, env), emit: () => {} });
  await discovery.refresh({ force: true });

  const state = await ipc.buildState();
  for (const key of ["apps", "settings", "jobs", "adb", "hubVersion", "refreshing", "tokenSource", "rateLimit"]) {
    assert.ok(key in state, `getState().${key} missing`);
  }
  assert.ok(Array.isArray(state.apps) && state.apps.length > 0);
  assert.ok(Array.isArray(state.jobs));
  assert.strictEqual(state.refreshing, false);
  assert.strictEqual(typeof state.hubVersion, "string");

  // adb: { available, devices:[{serial,model,state}], versions:{pkg: version} }
  assert.strictEqual(typeof state.adb.available, "boolean");
  assert.ok(Array.isArray(state.adb.devices));
  assert.strictEqual(typeof state.adb.versions, "object");
  assert.ok(state.adb.versions !== null);

  // every artifact carries installed / updateAvailable / launchable
  for (const app of state.apps) {
    for (const artifact of app.artifacts) {
      assert.strictEqual(typeof artifact.launchable, "boolean", `${app.id}/${artifact.id}.launchable`);
      assert.strictEqual(typeof artifact.updateAvailable, "boolean");
      assert.ok(artifact.installed === null || typeof artifact.installed === "object");
    }
  }
});

test("tokenSource reports how the token was resolved ('' when anonymous)", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  config.clearTokenCache();

  // helpers set NX_HUB_NO_GH=1 → no gh fallback available
  assert.strictEqual((await ipc.buildState()).tokenSource, "");

  config.save({ token: "abc123" });
  const withToken = await ipc.buildState();
  assert.strictEqual(withToken.tokenSource, "settings");
  assert.strictEqual(withToken.settings.tokenSource, "settings", "also mirrored inside settings");
});

test("rateLimit is published while throttled and cleared once GitHub recovers", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  config.save({ owners: ["nerdrx"], extraRepos: [] });
  discovery.init({ github: clientFor(mock, env), emit: () => {} });

  mock.setRateLimited(true);
  await discovery.refresh({ force: true });
  const limited = await ipc.buildState();
  assert.ok(limited.rateLimit, "rateLimit set while throttled");
  assert.ok(Number(limited.rateLimit.resetAt) > 0, `resetAt should be epoch ms: ${limited.rateLimit.resetAt}`);

  mock.setRateLimited(false);
  await discovery.refresh({ force: true });
  assert.strictEqual((await ipc.buildState()).rateLimit, null, "cleared after a clean pass");
});

test("jobs are published as {jobId, appId, artifactId, phase, pct, message}", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const release = mock.data.releases["nerdrx/quadforge"];
  const app = {
    id: "quadforge",
    repo: "nerdrx/quadforge",
    name: "QuadForge",
    latest: { tag: release.tag_name, version: "1.3" },
    artifacts: discovery.buildArtifacts(release, {}),
  };
  jobs._reset();
  jobs.init({
    emit: () => {},
    github: clientFor(mock, env),
    engine: null,
    engineLoader() {
      throw new Error("Install engine unavailable");
    },
    relaunch: null,
    resolve: () => ({ app, artifact: app.artifacts[0] }),
  });

  const jobId = jobs.install("quadforge", app.artifacts[0].id);
  await new Promise((r) => setTimeout(r, 800));

  const published = (await ipc.buildState()).jobs;
  const job = published.find((j) => j.jobId === jobId);
  assert.ok(job, `job ${jobId} not published: ${JSON.stringify(published)}`);
  for (const key of ["jobId", "appId", "artifactId", "phase", "pct", "message"]) {
    assert.ok(key in job, `job.${key} missing`);
  }
  assert.strictEqual(job.appId, "quadforge");
  assert.strictEqual(typeof job.pct, "number");
});

test("launchables() feeds the tray only with installed, launchable artifacts", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  discovery._setCached({
    apps: [
      {
        id: "demo",
        name: "Demo",
        artifacts: [
          { id: "appimage-linux", label: "Linux app", kind: "appimage", platform: "linux", launchable: true },
          { id: "blender-addon-linux", label: "Addon", kind: "blender-addon", platform: "linux", launchable: false },
          { id: "generic-zip-linux", label: "Zip", kind: "generic-zip", platform: "linux", launchable: false },
        ],
      },
    ],
  });
  stateStore.recordInstall("demo", "appimage-linux", { version: "1", path: "/x" });
  stateStore.recordInstall("demo", "blender-addon-linux", { version: "1", path: "/y" });
  stateStore.recordInstall("demo", "generic-zip-linux", { version: "1", path: "/z" });

  const entries = ipc.launchables();
  assert.deepStrictEqual(
    entries.map((e) => e.artifactId),
    ["appimage-linux"]
  );
  assert.strictEqual(entries[0].appName, "Demo");

  discovery._setCached({ apps: [] });
});
