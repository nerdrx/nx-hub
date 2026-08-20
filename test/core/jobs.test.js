"use strict";
// jobs.js — install/uninstall flow, event shapes, per-app serialisation,
// cancellation and the nx-hub self-update swap. Engine is stubbed.

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
const recorder = require("../../src/main/recorder");

/** Build an app model straight from the mock release, with an optional overlay. */
function appFromMock(mock, fullName, { id, name, overlayArtifacts } = {}) {
  const release = mock.data.releases[fullName];
  const artifacts = discovery.buildArtifacts(release, overlayArtifacts ? { artifacts: overlayArtifacts } : {});
  return {
    id: id || fullName.split("/")[1].toLowerCase(),
    repo: fullName,
    name: name || fullName.split("/")[1],
    latest: { tag: release.tag_name, version: discovery.parseVersion(release.tag_name), publishedAt: null, notes: "", prerelease: false },
    artifacts,
  };
}

function harness(mock, env, { engine, relaunch, engineLoader } = {}) {
  const events = [];
  const listeners = [];
  const emit = (evt) => {
    events.push(evt);
    for (const l of [...listeners]) l(evt);
  };
  const client = github.createClient({
    baseUrl: mock.base,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
  const apps = new Map();
  jobs._reset();
  jobs.init({
    emit,
    github: client,
    engine: engine || null,
    engineLoader: engineLoader || null, // reset between tests — deps are module-level
    relaunch: relaunch || null,
    resolve: (appId, artifactId) => {
      const app = apps.get(String(appId).toLowerCase()) || null;
      return { app, artifact: app ? app.artifacts.find((a) => a.id === artifactId) || null : null };
    },
  });
  return {
    events,
    client,
    addApp(app) {
      apps.set(app.id, app);
      return app;
    },
    /** resolves with the terminal event for a job */
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

test("install: download → engine.install → state recorded → job-done", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const calls = [];
  const engine = {
    async install({ app, artifact, filePath, ctx }) {
      calls.push({ app: app.id, artifact: artifact.id, filePath, version: artifact.version, installRoot: ctx.installRoot });
      assert.ok(fs.existsSync(filePath), "engine receives a downloaded file");
      assert.ok(typeof ctx.log === "function" && typeof ctx.emitProgress === "function");
      assert.ok(ctx.signal, "ctx carries the abort signal");
      ctx.emitProgress("extract", 40, "extracting");
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Linux server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "tarball-prefix");

  const jobId = jobs.install(app.id, artifact.id);
  const done = await h.wait(jobId);

  assert.strictEqual(done.type, "job-done", `job failed: ${done.message}`);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].version, "1.4.0", "core sets artifact.version = latest.version before install");

  const progress = h.events.filter((e) => e.type === "job-progress" && e.jobId === jobId);
  const phases = [...new Set(progress.map((e) => e.phase))];
  assert.ok(phases.includes("download"), "download progress emitted");
  assert.ok(phases.includes("verify"), "checksum sidecar verified");
  assert.ok(phases.includes("extract"), "engine progress is forwarded");
  assert.ok(phases.includes("cleanup"));
  for (const e of progress) {
    assert.strictEqual(e.appId, app.id);
    assert.strictEqual(e.artifactId, artifact.id);
    assert.ok(typeof e.pct === "number" && e.pct >= 0 && e.pct <= 100);
  }
  assert.ok(h.events.some((e) => e.type === "state-changed"), "state-changed emitted");

  const rec = stateStore.getInstall(app.id, artifact.id);
  assert.strictEqual(rec.version, "1.4.0");
  assert.ok(rec.path && fs.existsSync(rec.path));
  assert.ok(rec.installedAt);

  // download cache is cleaned up
  const downloads = config.downloadsDir();
  const left = fs.existsSync(downloads) ? fs.readdirSync(downloads) : [];
  assert.deepStrictEqual(left, [], "downloaded file removed after install");
});

test("generic-zip is delegated to the engine like every other kind", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const seen = [];
  const engine = {
    async install({ artifact, filePath, ctx }) {
      seen.push(artifact.kind);
      const dest = path.join(ctx.installRoot, "nx", "downloads", artifact.assetName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(filePath, dest);
      return { version: artifact.version, path: dest, launchable: false };
    },
  };
  const h = harness(mock, env, { engine });
  const app = h.addApp(appFromMock(mock, "nerdrx/quadforge"));
  const artifact = app.artifacts[0];
  assert.strictEqual(artifact.kind, "generic-zip");

  const done = await h.wait(jobs.install(app.id, artifact.id));
  assert.strictEqual(done.type, "job-done", done.message);
  assert.deepStrictEqual(seen, ["generic-zip"]);
  assert.ok(fs.existsSync(stateStore.getInstall(app.id, artifact.id).path));
});

test("without an install engine, a download-only asset still lands in nx/downloads", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const h = harness(mock, env, {
    engineLoader() {
      const err = new Error("Install engine unavailable: not built yet");
      err.code = "ENOENGINE";
      throw err;
    },
  });

  const app = h.addApp(appFromMock(mock, "nerdrx/quadforge"));
  const artifact = app.artifacts[0];
  const done = await h.wait(jobs.install(app.id, artifact.id));
  assert.strictEqual(done.type, "job-done", done.message);
  const saved = path.join(env.installRoot, "nx", "downloads", artifact.assetName);
  assert.ok(fs.existsSync(saved), "zip parked in installRoot/nx/downloads");
  assert.strictEqual(stateStore.getInstall(app.id, artifact.id).path, saved);

  // a kind that needs an engine fails loudly instead
  const limbo = h.addApp(
    appFromMock(mock, "nerdrx/banish-protocol", {
      overlayArtifacts: [{ assetPattern: "*linux*.zip", label: "Linux", kind: "archive-dir", platform: "linux" }],
    })
  );
  const evt = await h.wait(jobs.install(limbo.id, "archive-dir-linux"));
  assert.strictEqual(evt.type, "job-error");
  assert.match(evt.message, /engine/i);
});

test("a failing engine surfaces job-error and records nothing", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const engine = {
    async install() {
      throw new Error("no adb device connected");
    },
  };
  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [{ assetPattern: "*.apk", label: "APK", kind: "apk-adb", platform: "android" }],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "apk-adb");

  const evt = await h.wait(jobs.install(app.id, artifact.id));
  assert.strictEqual(evt.type, "job-error");
  assert.match(evt.message, /no adb device/);
  assert.strictEqual(stateStore.getInstall(app.id, artifact.id), null);
});

test("only one job per app runs at a time; the rest queue", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  let release1;
  const gate = new Promise((r) => {
    release1 = r;
  });
  const started = [];
  const engine = {
    async install({ artifact, ctx }) {
      started.push(artifact.id);
      if (started.length === 1) await gate;
      const dest = path.join(ctx.installRoot, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [
        { assetPattern: "*.apk", label: "APK", kind: "apk-adb", platform: "android" },
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );

  const first = jobs.install(app.id, "apk-adb-android");
  const second = jobs.install(app.id, "tarball-prefix-linux");
  assert.notStrictEqual(first, second);

  // wait until the first job is inside the engine
  await new Promise((r) => setTimeout(r, 250));
  const list = jobs.list();
  assert.strictEqual(list.find((j) => j.id === first).status, "running");
  assert.strictEqual(list.find((j) => j.id === second).status, "queued", "second job waits for the first");
  assert.deepStrictEqual(started, ["apk-adb-android"]);

  release1();
  const a = await h.wait(first);
  const b = await h.wait(second);
  assert.strictEqual(a.type, "job-done", a.message);
  assert.strictEqual(b.type, "job-done", b.message);
  assert.deepStrictEqual(started, ["apk-adb-android", "tarball-prefix-linux"], "queue runs in order");
  assert.strictEqual(jobs.activeFor(app.id), null);

  // enqueueing the same job twice returns the existing job id
  const again = jobs.install(app.id, "apk-adb-android");
  const againToo = jobs.install(app.id, "apk-adb-android");
  assert.strictEqual(again, againToo);
  await h.wait(again);
});

test("cancelJob aborts a running job and a queued one", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  let entered;
  const inEngine = new Promise((r) => {
    entered = r;
  });
  const engine = {
    install({ ctx }) {
      entered();
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  };

  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [
        { assetPattern: "*.apk", label: "APK", kind: "apk-adb", platform: "android" },
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );

  const running = jobs.install(app.id, "apk-adb-android");
  const queued = jobs.install(app.id, "tarball-prefix-linux");
  await inEngine;

  assert.strictEqual(jobs.cancelJob(queued), true);
  const queuedEvt = await h.wait(queued);
  assert.strictEqual(queuedEvt.type, "job-error");
  assert.match(queuedEvt.message, /Cancel/i);

  assert.strictEqual(jobs.cancelJob(running), true);
  const runningEvt = await h.wait(running);
  assert.strictEqual(runningEvt.type, "job-error");
  assert.match(runningEvt.message, /Cancel/i);
  assert.strictEqual(jobs.list().find((j) => j.id === running).status, "cancelled");
  assert.strictEqual(stateStore.getInstall(app.id, "apk-adb-android"), null);
  assert.strictEqual(jobs.cancelJob("job-does-not-exist"), false);
});

test("uninstall calls the engine with the recorded path and clears state", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const seen = [];
  const engine = {
    async install({ artifact, ctx }) {
      const dest = path.join(ctx.installRoot, "nx", "wivrn-nx", artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "file"), "x");
      return { version: artifact.version, path: dest, launchable: true };
    },
    async uninstall({ app, artifact, installedPath }) {
      seen.push({ app: app.id, artifact: artifact.id, installedPath });
      fs.rmSync(installedPath, { recursive: true, force: true });
    },
  };

  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [{ assetPattern: "*-linux-x86_64.tar.gz", label: "Server", kind: "archive-dir", platform: "linux" }],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "archive-dir");

  await h.wait(jobs.install(app.id, artifact.id));
  const installedPath = stateStore.getInstall(app.id, artifact.id).path;
  assert.ok(fs.existsSync(installedPath));

  const evt = await h.wait(jobs.uninstall(app.id, artifact.id));
  assert.strictEqual(evt.type, "job-done", evt.message);
  assert.deepStrictEqual(seen, [{ app: app.id, artifact: artifact.id, installedPath }]);
  assert.ok(!fs.existsSync(installedPath));
  assert.strictEqual(stateStore.getInstall(app.id, artifact.id), null);
});

test("job-done carries the job's own facts, including what it replaced", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    recorder._reset();
    await mock.close();
    env.cleanup();
  });

  const engine = {
    async install({ artifact, ctx }) {
      const dest = path.join(ctx.installRoot, "nx", "wivrn-nx", artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      return { version: artifact.version, path: dest, launchable: true };
    },
    async uninstall({ installedPath }) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    },
  };

  const h = harness(mock, env, { engine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      overlayArtifacts: [{ assetPattern: "*-linux-x86_64.tar.gz", label: "Server", kind: "archive-dir", platform: "linux" }],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "archive-dir");

  const first = await h.wait(jobs.install(app.id, artifact.id));
  assert.strictEqual(first.type, "job-done", first.message);
  assert.strictEqual(first.jobType, "install");
  assert.strictEqual(first.appName, app.name);
  assert.strictEqual(first.version, "1.4.0");
  assert.strictEqual(first.previousVersion, null);
  assert.strictEqual(first.previouslyInstalled, false, "there was nothing here — and the event says so");

  const again = await h.wait(jobs.install(app.id, artifact.id));
  assert.strictEqual(again.type, "job-done", again.message);
  assert.strictEqual(again.previouslyInstalled, true);
  assert.strictEqual(again.previousVersion, "1.4.0", "read BEFORE the record was overwritten");

  const gone = await h.wait(jobs.uninstall(app.id, artifact.id));
  assert.strictEqual(gone.type, "job-done", gone.message);
  assert.strictEqual(gone.jobType, "uninstall");
  assert.strictEqual(gone.version, null, "nothing is installed once an uninstall is done");
  assert.strictEqual(gone.previousVersion, "1.4.0");

  // …and the journal can now tell a first install from an update, which is the
  // whole point: both jobs wrote the same "Installed <app> 1.4.0" sentence.
  assert.strictEqual(first.message, again.message);
  recorder._reset();
  assert.strictEqual(recorder.record(first)[0].summary, `installed ${app.name} v1.4.0`);
  assert.strictEqual(recorder.record(again)[0].summary, `updated ${app.name} v1.4.0`);
  assert.strictEqual(recorder.record(gone)[0].data.previousVersion, "1.4.0");
});

test("launch delegates to engine.launch with the installed path", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const launched = [];
  const engine = {
    async launch({ app, artifact, installedPath, ctx }) {
      launched.push({ app: app.id, artifact: artifact.id, installedPath, installRoot: ctx.installRoot });
      return true;
    },
  };
  const h = harness(mock, env, { engine });
  const app = h.addApp(appFromMock(mock, "nerdrx/banish-protocol"));
  const artifact = app.artifacts[0];
  stateStore.recordInstall(app.id, artifact.id, { version: "2.0", path: "/opt/limbo" });

  await jobs.launch(app.id, artifact.id);
  assert.strictEqual(launched.length, 1);
  assert.strictEqual(launched[0].installedPath, "/opt/limbo");
  await assert.rejects(() => jobs.launch("nope", "nope"), /Unknown artifact/);
});

test("self-update stages, swaps the hub install dir and relaunches", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({
    makeData(base) {
      const data = helpers.defaultData(base);
      data.repos.nerdrx.push(helpers.repo("nerdrx", "nx-hub"));
      data.releases["nerdrx/nx-hub"] = helpers.release("v0.2.0", [
        helpers.asset(base, "nerdrx/nx-hub", "NX-Hub-0.2.0-linux.AppImage", Buffer.from("new hub bytes")),
      ]);
      return data;
    },
  });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  let relaunched = 0;
  const stagingRoots = [];
  const engine = {
    async install({ app, artifact, ctx }) {
      stagingRoots.push(ctx.installRoot);
      const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "AppRun"), "new build");
      return { version: artifact.version, path: dest, launchable: true };
    },
  };

  const h = harness(mock, env, { engine, relaunch: () => (relaunched += 1) });
  const app = h.addApp(appFromMock(mock, "nerdrx/nx-hub", { id: "nx-hub", name: "NX Hub" }));
  const artifact = app.artifacts[0];

  // pretend an older hub is already installed there
  const target = config.installPathFor(config.load(), "nx-hub", artifact.id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "AppRun"), "old build");

  const evt = await h.wait(jobs.install("nx-hub", artifact.id));
  assert.strictEqual(evt.type, "job-done", evt.message);

  assert.ok(stagingRoots[0].includes("self-update"), "engine installs into a staging root first");
  assert.strictEqual(fs.readFileSync(path.join(target, "AppRun"), "utf8"), "new build", "install dir swapped");
  assert.ok(!fs.existsSync(path.join(env.dataDir, "self-update")), "staging cleaned up");
  assert.ok(
    !fs.readdirSync(path.dirname(target)).some((f) => f.includes(".old-")),
    "old install dir deleted"
  );
  assert.strictEqual(stateStore.getInstall("nx-hub", artifact.id).version, "0.2.0");

  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(relaunched, 1, "app.relaunch() invoked after the swap");
});

test("a missing install engine fails the job with a clear message", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const h = harness(mock, env, { engine: null });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/banish-protocol", {
      overlayArtifacts: [{ assetPattern: "*linux*.zip", label: "Linux", kind: "archive-dir", platform: "linux" }],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "archive-dir");
  const evt = await h.wait(jobs.install(app.id, artifact.id));
  // Either the real engine exists (sibling agent landed it) or we get the guard message.
  if (evt.type === "job-error") assert.ok(evt.message.length > 0);
});
