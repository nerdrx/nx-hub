"use strict";
// v0.2 update policies (notify / download / install) + the download semaphore.

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

/** One app whose only artifact has an update pending (installed 1.0 < latest). */
function appWithUpdate(mock, { id = "wivrn-nx", fullName = "nerdrx/wivrn-nx", version = "1.4.0" } = {}) {
  const entry = mock.data.releases[fullName];
  const release = Array.isArray(entry) ? entry[0] : entry;
  const artifacts = discovery.buildArtifacts(release, {});
  const app = {
    id,
    repo: fullName,
    name: id,
    latest: { tag: release.tag_name, version, publishedAt: null, notes: "", prerelease: false },
    artifacts,
    localHidden: false,
  };
  for (const a of app.artifacts) {
    a.installed = { version: "1.0.0", path: `/tmp/${id}`, installedAt: "2026-01-01T00:00:00Z" };
    a.updateAvailable = true;
    a.updateSkipped = false;
  }
  return app;
}

function harness(mock, env, { engine } = {}) {
  const events = [];
  const apps = new Map();
  jobs._reset();
  discovery._setCached({ apps: [], releases: {}, overlay: { hidden: [], apps: {} } });
  jobs.init({
    emit: (e) => events.push(e),
    github: github.createClient({
      baseUrl: mock.base,
      cacheDir: path.join(env.dataDir, "cache"),
      getToken: async () => null,
    }),
    engine: engine || null,
    engineLoader: null,
    relaunch: null,
    resolve: (appId, artifactId) => {
      const app = apps.get(String(appId).toLowerCase()) || null;
      return { app, artifact: app ? app.artifacts.find((a) => a.id === artifactId) || null : null };
    },
  });
  return {
    events,
    addApp(app) {
      apps.set(app.id, app);
      return app;
    },
  };
}

/* ---------------- notify ---------------- */

test('policy "notify" emits update-available once per (app, version)', async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ updatePolicy: "notify" });
  const h = harness(mock, env);
  const app = h.addApp(appWithUpdate(mock));

  assert.ok(app.artifacts.length > 1, "fixture has several artifacts");
  const first = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.strictEqual(first.notified.length, 1, "one notification per app+version, not per artifact");
  const evt = h.events.find((e) => e.type === "update-available");
  assert.ok(evt, "update-available emitted");
  assert.strictEqual(evt.appId, "wivrn-nx");
  assert.strictEqual(evt.version, "1.4.0");
  assert.ok(evt.artifactId);

  // bookkeeping is persisted, so a second refresh stays quiet
  assert.strictEqual(stateStore.wasNotified("wivrn-nx", "1.4.0"), true);
  h.events.length = 0;
  const second = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.deepStrictEqual(second.notified, []);
  assert.strictEqual(h.events.filter((e) => e.type === "update-available").length, 0);

  // a NEW version notifies again
  app.latest.version = "1.5.0";
  const third = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.strictEqual(third.notified.length, 1);
  assert.strictEqual(stateStore.wasNotified("wivrn-nx", "1.5.0"), true);

  // and the record survives a fresh read of state.json
  const onDisk = JSON.parse(fs.readFileSync(path.join(env.dataDir, "state.json"), "utf8"));
  assert.strictEqual(onDisk.notified["wivrn-nx"].version, "1.5.0");
});

test("policies skip locally hidden apps and artifacts with no pending update", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ updatePolicy: "notify" });
  const h = harness(mock, env);

  const hidden = h.addApp(appWithUpdate(mock, { id: "hidden-app" }));
  hidden.localHidden = true;
  const skipped = h.addApp(appWithUpdate(mock, { id: "skipped-app" }));
  for (const a of skipped.artifacts) {
    a.updateAvailable = false; // e.g. suppressed by skippedVersion
    a.updateSkipped = true;
  }

  const result = await jobs.applyUpdatePolicies({ apps: [hidden, skipped] });
  assert.deepStrictEqual(result.notified, []);
  assert.strictEqual(h.events.filter((e) => e.type === "update-available").length, 0);
});

/* ---------------- download ---------------- */

test('policy "download" caches the asset and marks readyToInstall', async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ updatePolicy: "download" });
  const h = harness(mock, env);
  const app = h.addApp(appWithUpdate(mock));
  const artifact = app.artifacts[0];
  app.artifacts = [artifact]; // one asset is enough for this assertion

  const before = mock.stats.downloads;
  const result = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.strictEqual(result.downloaded.length, 1);
  assert.ok(mock.stats.downloads > before, "the asset was fetched");

  const expected = path.join(config.downloadsDir(), `wivrn-nx-${artifact.assetName}`);
  assert.ok(fs.existsSync(expected), "asset parked in the download cache");
  assert.strictEqual(artifact.readyToInstall, true);

  const record = stateStore.getDownload("wivrn-nx", artifact.id);
  assert.strictEqual(record.version, "1.4.0");
  assert.strictEqual(record.path, expected);

  // running the policy again reuses the cached file instead of re-downloading
  const downloadsBefore = mock.stats.downloads;
  const again = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.deepStrictEqual(again.downloaded, [], "nothing new was downloaded");
  assert.strictEqual(mock.stats.downloads, downloadsBefore);
});

/* ---------------- install ---------------- */

test('policy "install" queues a real install job, per-app override included', async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const installed = [];
  const engine = {
    async install({ app, artifact, ctx }) {
      installed.push(`${app.id}/${artifact.id}`);
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  config.save({ updatePolicy: "notify" }); // global stays quiet…
  config.setAppPref("wivrn-nx", { updatePolicy: "install" }); // …this app installs

  const h = harness(mock, env, { engine });
  const app = h.addApp(appWithUpdate(mock));
  app.artifacts = [app.artifacts.find((a) => a.kind === "archive-dir") || app.artifacts[0]];

  const result = await jobs.applyUpdatePolicies({ apps: [app] });
  assert.strictEqual(result.installing.length, 1, "an install job was queued");
  assert.ok(result.installing[0].jobId);
  assert.deepStrictEqual(result.notified, [], "install policy does not also notify");

  // let the queued job run
  for (let i = 0; i < 100 && installed.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(installed, [`wivrn-nx/${app.artifacts[0].id}`]);
  assert.strictEqual(stateStore.getInstall("wivrn-nx", app.artifacts[0].id).version, "1.4.0");
});

test("a failing policy for one app never stops the others", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ updatePolicy: "download" });
  const h = harness(mock, env);
  const broken = h.addApp(appWithUpdate(mock, { id: "broken-app" }));
  broken.artifacts = [Object.assign({}, broken.artifacts[0], { assetUrl: null, assetId: null })];
  const fine = h.addApp(appWithUpdate(mock, { id: "fine-app" }));
  fine.artifacts = [fine.artifacts[0]];

  const result = await jobs.applyUpdatePolicies({ apps: [broken, fine] });
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0].appId, "broken-app");
  assert.strictEqual(result.downloaded.length, 1);
  assert.strictEqual(result.downloaded[0].appId, "fine-app");
});

/* ---------------- semaphore ---------------- */

test("maxConcurrentDownloads caps parallel transfers", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  jobs._reset();
  jobs.setDownloadLimit(2);

  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const runs = [1, 2, 3, 4, 5].map(() =>
    jobs.withDownloadSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
    })
  );

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(jobs.downloadStats().active, 2, "only two slots are handed out");
  assert.strictEqual(jobs.downloadStats().waiting, 3);
  assert.strictEqual(peak, 2);

  release();
  await Promise.all(runs);
  assert.strictEqual(peak, 2, "never more than the configured limit ran at once");
  assert.strictEqual(jobs.downloadStats().active, 0);
  assert.strictEqual(jobs.downloadStats().waiting, 0);

  // a raised limit lets more through
  jobs.setDownloadLimit(4);
  let active2 = 0;
  let peak2 = 0;
  let release2;
  const gate2 = new Promise((r) => {
    release2 = r;
  });
  const runs2 = [1, 2, 3, 4, 5].map(() =>
    jobs.withDownloadSlot(async () => {
      active2 += 1;
      peak2 = Math.max(peak2, active2);
      await gate2;
      active2 -= 1;
    })
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(peak2, 4);
  release2();
  await Promise.all(runs2);
});

test("the semaphore picks up settings.maxConcurrentDownloads on first use", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  jobs._reset();
  config.save({ maxConcurrentDownloads: 1 });
  const order = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const first = jobs.withDownloadSlot(async () => {
    order.push("first");
    await gate;
  });
  const second = jobs.withDownloadSlot(async () => {
    order.push("second");
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(order, ["first"], "the second transfer waits for the only slot");
  assert.strictEqual(jobs.downloadStats().limit, 1);
  release();
  await Promise.all([first, second]);
  assert.deepStrictEqual(order, ["first", "second"]);
});

test("install policy: offline-device APKs are skipped, failures never auto-retry, and errors are silent", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  jobs._reset();

  const events = [];
  let installCalls = 0;
  const failingEngine = {
    install: async () => {
      installCalls += 1;
      throw new Error("no device");
    },
    uninstall: async () => {},
    launch: async () => {},
    getAdbStatus: async () => ({ available: false, devices: [], apkVersions: {} }),
  };

  const apkOffline = {
    id: "apk-adb-android", kind: "apk-adb", platform: "android", label: "APK",
    assetName: "a.apk", assetUrl: "u", updateAvailable: true, deviceOffline: true,
  };
  const zipArt = {
    id: "archive-dir-linux", kind: "archive-dir", platform: "linux", label: "Zip",
    assetName: "a.zip", assetUrl: "u", updateAvailable: true, sourceVersion: "2.0",
  };
  const app = { id: "demo", name: "Demo", latest: { version: "2.0" }, artifacts: [apkOffline, zipArt] };

  jobs.init({
    emit: (e) => events.push(e),
    engine: failingEngine,
    github: { downloadAsset: async () => ({ sha256: "x", verified: false }) },
    resolve: (appId, artId) => ({ app, artifact: app.artifacts.find((a) => a.id === artId) }),
  });
  config.save({ updatePolicy: "install" });

  const r1 = await jobs.applyUpdatePolicies({ apps: [app], settings: config.load() });
  assert.strictEqual(r1.installing.length, 1, "only the non-APK artifact was attempted");
  assert.ok(!r1.installing.some((x) => x.artifactId === "apk-adb-android"), "offline APK skipped");

  await new Promise((res) => setTimeout(res, 150)); // let the queued job fail
  const err = events.find((e) => e.type === "job-error");
  assert.ok(err, "the failing install emitted job-error");
  assert.strictEqual(err.silent, true, "policy-origin failures are silent");

  const before = installCalls;
  const r2 = await jobs.applyUpdatePolicies({ apps: [app], settings: config.load() });
  assert.strictEqual(r2.installing.length, 0, "failed version is not re-attempted");
  assert.strictEqual(installCalls, before, "no second engine call");
});
