"use strict";
// snapshots.js — the config time machine (SPEC v0.8 "Config time machine").
//
// These are real round trips: real `tar --zstd`, real archives, real temp
// $HOMEs. The point of the module is that bytes survive a capture/restore and
// that an archive written on one machine unpacks on another, and neither can
// be proven with a mock.

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
const snapshots = require("../../src/main/snapshots");

/* ---------------------------------------------------------------- setup */

/**
 * Temp data dir + a temp $HOME, both torn down afterwards. $HOME is what the
 * module archives relative to, so every test gets its own.
 */
function useHome(t, { name = "home" } = {}) {
  const env = helpers.useTempEnv();
  const home = path.join(env.root, name);
  fs.mkdirSync(home, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    env.cleanup();
  });
  return { env, home };
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function demoApp(over = {}) {
  return Object.assign({ id: "demo", name: "Demo", configPaths: ["~/.config/demo"], artifacts: [] }, over);
}

const HAVE_ZSTD = snapshots.hasZstd();

/* ------------------------------------------------------------- capture */

test("snapshots: capture → modify → restore puts the exact bytes back", async (t) => {
  const { home } = useHome(t);
  const cfg = path.join(home, ".config", "demo", "settings.json");
  const blob = path.join(home, ".config", "demo", "state.bin");
  const original = Buffer.from('{"theme":"space","bitrate":42}\n');
  const originalBlob = Buffer.from([0, 1, 2, 250, 251, 252, 0xff, 0x00]);
  writeFile(cfg, original);
  writeFile(blob, originalBlob);

  const app = demoApp();
  const res = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: "1.2.3" });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(res.path), "the archive is on disk");
  assert.deepEqual(res.paths, [path.join(".config", "demo")], "stored relative to $HOME");
  assert.match(res.file, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-1\.2\.3-pre-update\.tar\.zst$/);
  assert.ok(res.bytes > 0);

  // the user (or an update) mangles the config
  fs.writeFileSync(cfg, "corrupted");
  fs.writeFileSync(blob, Buffer.from([9, 9, 9]));

  const back = await snapshots.restore("demo", res.file, { app });
  assert.equal(back.ok, true);
  assert.deepEqual(fs.readFileSync(cfg), original, "text file restored byte for byte");
  assert.deepEqual(fs.readFileSync(blob), originalBlob, "binary file restored byte for byte");
  assert.ok(back.restored.some((p) => p.endsWith("settings.json")), "the entry list names what came back");
});

test("snapshots: a restore first snapshots the current config as pre-restore", async (t) => {
  const { home } = useHome(t);
  const cfg = writeFile(path.join(home, ".config", "demo", "settings.json"), "v1");
  const app = demoApp();

  const first = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: "1.0.0" });
  assert.equal(first.ok, true, first.error);
  fs.writeFileSync(cfg, "v2-current");

  const back = await snapshots.restore("demo", first.file, { app });
  assert.ok(back.preRestore, "the restore reports the safety archive it took");
  assert.equal(fs.readFileSync(cfg, "utf8"), "v1");

  const all = snapshots.list("demo");
  const pre = all.find((s) => s.reason === "pre-restore");
  assert.ok(pre, "a pre-restore archive exists");
  assert.equal(pre.file, back.preRestore);
  assert.equal(all[0].file, back.preRestore, "and it is the newest");

  // …and it really holds the config as it was a moment before
  await snapshots.restore("demo", pre.file, { app });
  assert.equal(fs.readFileSync(cfg, "utf8"), "v2-current", "the restore itself is undoable");
});

test("snapshots: archives are $HOME-relative, so they restore into a different $HOME", async (t) => {
  const { env, home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "portable");
  const app = demoApp();

  const res = await snapshots.maybeSnapshot(app, {}, "pre-uninstall", { version: "2.0.0" });
  assert.equal(res.ok, true, res.error);

  // a different machine / a different user: same data dir, brand new $HOME
  const other = path.join(env.root, "other-home");
  fs.mkdirSync(other, { recursive: true });
  process.env.HOME = other;

  const back = await snapshots.restore("demo", res.file, { app });
  assert.equal(back.home, other);
  assert.equal(fs.readFileSync(path.join(other, ".config", "demo", "settings.json"), "utf8"), "portable");
  // nothing was taken before this restore: the new $HOME has no config yet
  assert.equal(back.preRestore, null);
});

test("snapshots: nothing to snapshot when no configPath exists (and no archive is written)", async (t) => {
  useHome(t);
  const res = await snapshots.maybeSnapshot(demoApp(), {}, "pre-update");
  assert.equal(res.ok, true);
  assert.equal(res.skipped, "nothing to snapshot");
  assert.deepEqual(snapshots.list("demo"), []);
});

test("snapshots: an app without configPaths is a no-op", async (t) => {
  useHome(t);
  const res = await snapshots.maybeSnapshot({ id: "demo", name: "Demo" }, {}, "pre-uninstall");
  assert.equal(res.skipped, "nothing to snapshot");
});

test("snapshots: configPaths outside $HOME are skipped (v1: archives are $HOME-relative)", async (t) => {
  const { env, home } = useHome(t);
  const outside = writeFile(path.join(env.root, "etc", "demo.conf"), "system-wide");
  const inside = writeFile(path.join(home, ".config", "demo", "settings.json"), "mine");

  const res = await snapshots.maybeSnapshot(demoApp({ configPaths: [outside, "~/.config/demo"] }), {}, "pre-update", {
    version: "1.0.0",
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.paths, [path.join(".config", "demo")], "only the $HOME-relative path went in");

  // and the skipped one is genuinely absent from the archive
  fs.rmSync(inside);
  fs.rmSync(outside);
  await snapshots.restore("demo", res.file, { app: demoApp() });
  assert.ok(fs.existsSync(inside), "the $HOME path came back");
  assert.ok(!fs.existsSync(outside), "the outside path was never captured");
});

test("snapshots: an app whose only configPath is outside $HOME snapshots nothing", async (t) => {
  const { env } = useHome(t);
  const outside = writeFile(path.join(env.root, "etc", "demo.conf"), "x");
  const res = await snapshots.maybeSnapshot(demoApp({ configPaths: [outside] }), {}, "pre-update");
  assert.equal(res.skipped, "nothing to snapshot");
});

test("snapshots: planPaths splits existing / missing / outside", (t) => {
  const { env, home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "a.json"), "a");
  const outside = writeFile(path.join(env.root, "elsewhere", "b.json"), "b");
  const plan = snapshots.planPaths(
    demoApp({ configPaths: ["~/.config/demo", "~/.config/demo", outside, "~/.config/gone"] }),
    home
  );
  assert.deepEqual(plan.rel, [path.join(".config", "demo")], "duplicates collapse");
  assert.equal(plan.outside.length, 1);
  assert.equal(plan.missing.length, 1);
});

/* ----------------------------------------------------------- retention */

test("snapshots: retention keeps the newest 5 per app", async (t) => {
  const { home } = useHome(t);
  const cfg = path.join(home, ".config", "demo", "settings.json");
  const app = demoApp();

  const written = [];
  for (let i = 1; i <= 7; i += 1) {
    writeFile(cfg, `gen-${i}`);
    // eslint-disable-next-line no-await-in-loop
    const res = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: `1.0.${i}` });
    assert.equal(res.ok, true, res.error);
    written.push(res.file);
  }

  const kept = snapshots.list("demo");
  assert.equal(kept.length, snapshots.RETENTION);
  assert.equal(kept.length, 5);
  assert.deepEqual(
    kept.map((s) => s.file),
    written.slice(-5).reverse(),
    "the newest five survive, newest first"
  );
  for (const gone of written.slice(0, 2)) {
    assert.ok(!fs.existsSync(path.join(snapshots.snapshotDir("demo"), gone)), `${gone} was pruned`);
  }
  // the survivors are still valid archives
  const back = await snapshots.restore("demo", kept[0].file, { app });
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(cfg, "utf8"), "gen-7");
});

test("snapshots: two captures in the same millisecond do not collide", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  const app = demoApp();
  const a = await snapshots.maybeSnapshot(app, {}, "manual", { version: "1.0.0" });
  const b = await snapshots.maybeSnapshot(app, {}, "manual", { version: "1.0.0" });
  assert.notEqual(a.file, b.file);
  assert.equal(snapshots.list("demo").length, 2);
});

/* -------------------------------------------------------------- naming */

test("snapshots: filename parsing matrix", () => {
  const cases = [
    ["2026-08-16T10-04-05.123Z-1.4.0-pre-update.tar.zst", { ts: "2026-08-16T10:04:05.123Z", version: "1.4.0", reason: "pre-update" }],
    ["2026-08-16T10-04-05.000Z-1.4.0-rc1-pre-update.tar.zst", { version: "1.4.0-rc1", reason: "pre-update" }],
    ["2026-01-02T03-04-05.006Z-2.0-pre-uninstall.tar.zst", { version: "2.0", reason: "pre-uninstall" }],
    ["2026-01-02T03-04-05.006Z-2.0-pre-restore.tar.zst", { version: "2.0", reason: "pre-restore" }],
    ["2026-01-02T03-04-05.006Z-unknown-manual.tar.zst", { version: "unknown", reason: "manual" }],
    // a reason this build does not know still round-trips through the fallback
    ["2026-01-02T03-04-05.006Z-1.0.0-experiment.tar.zst", { version: "1.0.0", reason: "experiment" }],
  ];
  for (const [name, expect] of cases) {
    const parsed = snapshots.parseName(name);
    assert.ok(parsed, `${name} should parse`);
    for (const key of Object.keys(expect)) assert.equal(parsed[key], expect[key], `${name} → ${key}`);
  }

  const junk = [
    "notes.txt",
    "backup.tar.gz",
    ".partial.tar.zst",
    "2026-08-16-1.0.0-pre-update.tar.zst", // no time part
    "nonsense.tar.zst",
    "2026-08-16T10-04-05.123Z-pre-update.tar.zst", // no version field
    "",
  ];
  for (const name of junk) assert.equal(snapshots.parseName(name), null, `${name} is not a snapshot`);

  // the stamp is the inverse of formatStamp
  const stamp = snapshots.formatStamp("2026-08-16T10:04:05.123Z");
  assert.equal(stamp, "2026-08-16T10-04-05.123Z");
  assert.equal(snapshots.parseStamp(stamp), "2026-08-16T10:04:05.123Z");
  // versions keep their dots and dashes; anything hostile is flattened
  assert.match(snapshots.fileNameFor(Date.now(), "1.4.0-rc1", "pre-update"), /-1\.4\.0-rc1-pre-update\.tar\.zst$/);
  assert.match(snapshots.fileNameFor(Date.now(), "../../evil", "manual"), /-\.\._\.\._evil-manual\.tar\.zst$/);
});

test("snapshots: list tolerates junk in the snapshot directory", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  const res = await snapshots.maybeSnapshot(demoApp(), {}, "pre-update", { version: "1.0.0" });
  assert.equal(res.ok, true, res.error);

  const dir = snapshots.snapshotDir("demo");
  fs.writeFileSync(path.join(dir, "README.txt"), "hand-written");
  fs.writeFileSync(path.join(dir, "half-written.tar.zst"), "not a name we wrote");
  fs.mkdirSync(path.join(dir, "2026-08-16T10-04-05.123Z-1.0.0-manual.tar.zst"), { recursive: true }); // a DIRECTORY

  const list = snapshots.list("demo");
  assert.equal(list.length, 1);
  assert.equal(list[0].file, res.file);
  assert.equal(list[0].version, "1.0.0");
  assert.equal(list[0].reason, "pre-update");
  assert.ok(list[0].bytes > 0);
  assert.equal(snapshots.list("no-such-app").length, 0, "an app with no directory lists empty");
});

/* -------------------------------------------------------------- guards */

test("snapshots: path traversal is refused by restore and remove", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  const good = await snapshots.maybeSnapshot(demoApp(), {}, "manual", { version: "1.0.0" });
  assert.equal(good.ok, true, good.error);

  // a file the guard must never let anyone reach
  const outside = writeFile(path.join(home, "secret.tar.zst"), "do not touch");

  const evil = [
    "../../etc/passwd",
    "../secret.tar.zst",
    "../../secret.tar.zst",
    "/etc/passwd",
    "sub/dir.tar.zst",
    `${path.sep}absolute.tar.zst`,
    "..",
    ".",
    "",
    null,
  ];
  for (const name of evil) {
    assert.throws(() => snapshots.remove("demo", name), /Invalid snapshot name|is not a snapshot/, `remove ${name}`);
    await assert.rejects(
      () => snapshots.restore("demo", name, { app: demoApp() }),
      /Invalid snapshot name|is not a snapshot/,
      `restore ${name}`
    );
  }
  assert.ok(fs.existsSync(outside), "the file outside the snapshot dir is untouched");
  assert.equal(snapshots.list("demo").length, 1, "and the real archive is still there");

  // a hostile app id cannot walk out of the snapshots root either
  assert.throws(() => snapshots.snapshotDir("../../etc"), /Invalid app id/);
  assert.throws(() => snapshots.snapshotDir(""), /Invalid app id/);
  assert.equal(snapshots.list("../../etc").length, 0, "list swallows it rather than reading elsewhere");

  // a name that is shaped right but absent is a plain "not found"
  assert.throws(() => snapshots.remove("demo", "2026-01-02T03-04-05.006Z-1.0.0-manual.tar.zst"), /No snapshot called/);
});

test("snapshots: remove deletes exactly the archive it was given", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  const a = await snapshots.maybeSnapshot(demoApp(), {}, "manual", { version: "1.0.0" });
  const b = await snapshots.maybeSnapshot(demoApp(), {}, "manual", { version: "1.0.1" });
  assert.equal(snapshots.list("demo").length, 2);
  const res = snapshots.remove("demo", a.file);
  assert.equal(res.ok, true);
  assert.deepEqual(snapshots.list("demo").map((s) => s.file), [b.file]);
});

test("snapshots: a capture failure is reported, never thrown", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(home, "empty-bin"); // no zstd, no tar
  t.after(() => {
    process.env.PATH = prevPath;
  });
  const res = await snapshots.maybeSnapshot(demoApp(), {}, "pre-update", { version: "1.0.0" });
  assert.equal(res.ok, false);
  assert.match(res.error, /zstd/);
  assert.equal(snapshots.list("demo").length, 0, "no half-written archive is left behind");
});

/* ------------------------------------------------------ rollback affinity */

test("snapshots: findPreUpdate matches the version a rollback would restore", async (t) => {
  const { home } = useHome(t);
  const cfg = path.join(home, ".config", "demo", "settings.json");
  const app = demoApp();

  writeFile(cfg, "config for 1.0.0");
  const preUpdate = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: "1.0.0" });
  writeFile(cfg, "config for 1.1.0");
  await snapshots.maybeSnapshot(app, {}, "pre-uninstall", { version: "1.1.0" });

  const found = snapshots.findPreUpdate("demo", "1.0.0");
  assert.ok(found, "the pre-update archive taken while 1.0.0 was installed");
  assert.equal(found.file, preUpdate.file);
  assert.equal(found.reason, "pre-update");

  assert.equal(snapshots.findPreUpdate("demo", "1.1.0"), null, "a pre-uninstall archive is not a rollback offer");
  assert.equal(snapshots.findPreUpdate("demo", "9.9.9"), null);
  assert.equal(snapshots.findPreUpdate("demo", null), null);
  assert.equal(snapshots.findPreUpdate("no-such-app", "1.0.0"), null);

  // newest wins when the same version was replaced twice
  const again = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: "1.0.0" });
  assert.equal(snapshots.findPreUpdate("demo", "1.0.0").file, again.file);
});

test("snapshots: the version comes from the install record when none is passed", async (t) => {
  const { home } = useHome(t);
  writeFile(path.join(home, ".config", "demo", "settings.json"), "x");
  stateStore.recordInstall("demo", "linux", { version: "3.1.4", path: null });
  const res = await snapshots.maybeSnapshot(demoApp(), {}, "pre-uninstall");
  assert.equal(res.version, "3.1.4");
  assert.equal(snapshots.list("demo")[0].version, "3.1.4");
});

/* ----------------------------------------------------------- job hooks */

function appFromMock(mock, fullName, { id, overlayArtifacts, configPaths } = {}) {
  const release = mock.data.releases[fullName];
  const artifacts = discovery.buildArtifacts(release, overlayArtifacts ? { artifacts: overlayArtifacts } : {});
  return {
    id: id || fullName.split("/")[1].toLowerCase(),
    repo: fullName,
    name: fullName.split("/")[1],
    configPaths: configPaths || null,
    latest: {
      tag: release.tag_name,
      version: discovery.parseVersion(release.tag_name),
      publishedAt: null,
      notes: "",
      prerelease: false,
    },
    artifacts,
  };
}

/** The jobs harness from jobs.test.js, trimmed to what these hooks need. */
function harness(mock, env, { engine } = {}) {
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

const fakeEngine = {
  async install({ app, artifact, ctx }) {
    const dest = path.join(ctx.installRoot, "nx", app.id, artifact.id);
    fs.mkdirSync(dest, { recursive: true });
    return { version: artifact.version, path: dest, launchable: true };
  },
  async uninstall({ installedPath }) {
    if (installedPath) fs.rmSync(installedPath, { recursive: true, force: true });
    return { ok: true };
  },
};

test("jobs: an install that REPLACES another version snapshots the config first", async (t) => {
  const { env, home } = useHome(t);
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
  });
  const cfg = writeFile(path.join(home, ".config", "wivrn-nx", "config.json"), "before the update");

  const h = harness(mock, env, { engine: fakeEngine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      configPaths: ["~/.config/wivrn-nx"],
      overlayArtifacts: [
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Linux server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "tarball-prefix");

  // nothing installed yet → no snapshot, this is a first install
  const first = await h.wait(jobs.install(app.id, artifact.id));
  assert.equal(first.type, "job-done", first.message);
  assert.deepEqual(snapshots.list(app.id), [], "a first install has nothing to preserve");

  // now pretend an older build is installed and update over it
  stateStore.recordInstall(app.id, artifact.id, { version: "0.9.0", path: null });
  fs.writeFileSync(cfg, "state while 0.9.0 was installed");
  const second = await h.wait(jobs.install(app.id, artifact.id));
  assert.equal(second.type, "job-done", second.message);

  const list = snapshots.list(app.id);
  assert.equal(list.length, 1, "exactly one snapshot for the update");
  assert.equal(list[0].reason, "pre-update");
  assert.equal(list[0].version, "0.9.0", "stamped with the version being REPLACED");

  // reinstalling the same version is not an update
  stateStore.recordInstall(app.id, artifact.id, { version: app.latest.version, path: null });
  const third = await h.wait(jobs.install(app.id, artifact.id));
  assert.equal(third.type, "job-done", third.message);
  assert.equal(snapshots.list(app.id).length, 1, "a reinstall of the same version adds nothing");

  // and the archive is the pre-update config, ready for a rollback offer
  fs.writeFileSync(cfg, "post-update");
  const offer = snapshots.findPreUpdate(app.id, "0.9.0");
  assert.ok(offer, "findPreUpdate finds it for the rollback CTA");
  await snapshots.restore(app.id, offer.file, { app });
  assert.equal(fs.readFileSync(cfg, "utf8"), "state while 0.9.0 was installed");
});

test("jobs: an uninstall snapshots the config before the app goes away", async (t) => {
  const { env, home } = useHome(t);
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
  });
  const cfg = writeFile(path.join(home, ".config", "wivrn-nx", "config.json"), "the last known config");

  const h = harness(mock, env, { engine: fakeEngine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      configPaths: ["~/.config/wivrn-nx"],
      overlayArtifacts: [
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Linux server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "tarball-prefix");

  const installed = await h.wait(jobs.install(app.id, artifact.id));
  assert.equal(installed.type, "job-done", installed.message);

  const removed = await h.wait(jobs.uninstall(app.id, artifact.id));
  assert.equal(removed.type, "job-done", removed.message);

  const list = snapshots.list(app.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "pre-uninstall");
  assert.equal(list[0].version, app.latest.version);

  // the config survives the app, which is the whole point
  fs.rmSync(path.dirname(cfg), { recursive: true, force: true });
  await snapshots.restore(app.id, list[0].file, { app });
  assert.equal(fs.readFileSync(cfg, "utf8"), "the last known config");
});

test("jobs: a hub without zstd still installs and uninstalls", async (t) => {
  const { env, home } = useHome(t);
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
  });
  writeFile(path.join(home, ".config", "wivrn-nx", "config.json"), "x");

  const h = harness(mock, env, { engine: fakeEngine });
  const app = h.addApp(
    appFromMock(mock, "nerdrx/wivrn-nx", {
      configPaths: ["~/.config/wivrn-nx"],
      overlayArtifacts: [
        { assetPattern: "*-linux-x86_64.tar.gz", label: "Linux server", kind: "tarball-prefix", platform: "linux" },
      ],
    })
  );
  const artifact = app.artifacts.find((a) => a.kind === "tarball-prefix");
  stateStore.recordInstall(app.id, artifact.id, { version: "0.9.0", path: null });

  const prevPath = process.env.PATH;
  const bin = path.join(home, "empty-bin");
  fs.mkdirSync(bin, { recursive: true });
  process.env.PATH = bin;
  let done;
  try {
    done = await h.wait(jobs.install(app.id, artifact.id));
  } finally {
    process.env.PATH = prevPath;
  }
  assert.equal(done.type, "job-done", "a failed snapshot never fails the job");
  assert.equal(snapshots.list(app.id).length, 0);
});

/* --------------------------------------------------------------- ipc */

/** Minimal ipcMain double, same shape as test/core/devlinks.test.js uses. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

test("ipc: getSnapshots / restoreSnapshot / deleteSnapshot are on the surface", async (t) => {
  const { home } = useHome(t);
  const ipc = require("../../src/main/ipc");
  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });
  for (const name of ["getSnapshots", "restoreSnapshot", "deleteSnapshot"]) {
    assert.ok(ipcMain.handlers.has(`nxhub:${name}`), `channel nxhub:${name} not registered`);
  }

  const cfg = writeFile(path.join(home, ".config", "demo", "settings.json"), "as it was");
  const app = demoApp();
  const taken = await snapshots.maybeSnapshot(app, {}, "pre-update", { version: "1.0.0" });
  assert.equal(taken.ok, true, taken.error);

  const rows = await ipcMain.invoke("nxhub:getSnapshots", "demo");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["bytes", "file", "reason", "ts", "version"]);

  fs.writeFileSync(cfg, "changed since");
  const restored = await ipcMain.invoke("nxhub:restoreSnapshot", "demo", rows[0].file);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(cfg, "utf8"), "as it was");

  const gone = await ipcMain.invoke("nxhub:deleteSnapshot", "demo", rows[0].file);
  assert.equal(gone.ok, true);
  assert.ok(Array.isArray(gone.snapshots), "the fresh list rides back with the delete");
  assert.ok(!gone.snapshots.some((s) => s.file === rows[0].file));

  // the guards hold across the IPC boundary too
  await assert.rejects(() => ipcMain.invoke("nxhub:restoreSnapshot", "demo", "../../etc/passwd"), /Invalid snapshot name/);
  await assert.rejects(() => ipcMain.invoke("nxhub:deleteSnapshot", "demo", "/etc/passwd"), /Invalid snapshot name/);
  assert.deepEqual(await ipcMain.invoke("nxhub:getSnapshots", "no-such-app"), []);
});

test("snapshots: zstd is available in this environment", () => {
  // The round trips above are meaningless without it — fail loudly, not quietly.
  assert.equal(HAVE_ZSTD, true, "install zstd to run the snapshot suite");
});

test("snapshots: config.dataDir is where archives live", (t) => {
  const { env } = useHome(t);
  assert.equal(snapshots.snapshotsRoot(), path.join(env.dataDir, "snapshots"));
  assert.equal(snapshots.snapshotDir("demo"), path.join(env.dataDir, "snapshots", "demo"));
  assert.equal(config.dataDir(), env.dataDir);
});
