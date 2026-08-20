"use strict";
// src/main/audit.js — the deep audit (SPEC v0.10 "Deep audit").
//
// Installs are fabricated in a temp root with the engines' OWN writeManifest,
// so the manifests under test are the manifests the hub really writes. Then
// each install is broken one way at a time and the typed problem is asserted.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const helpers = require("./helpers");
const util = require("../../src/main/install/util");
const stateStore = require("../../src/main/state");
const assetsMod = require("../../src/main/fleet/assets");
const audit = require("../../src/main/audit");

/* ------------------------------------------------------------------ */
/* scaffolding                                                         */
/* ------------------------------------------------------------------ */

function env(t) {
  const e = helpers.useTempEnv();
  t.after(() => e.cleanup());
  return e;
}

function dirFor(e, appId, artifactId) {
  return path.join(e.installRoot, "nx", appId, artifactId);
}

/**
 * One install on disk + in state.json. `manifest` is merged into what
 * util.writeManifest gets, so a test can shape any kind.
 */
async function makeInstall(e, appId, artifactId, manifest = {}, { version = "1.0.0", record = true } = {}) {
  const dir = dirFor(e, appId, artifactId);
  await util.mkdirp(dir);
  await util.writeManifest(dir, Object.assign({ version, kind: "archive-dir" }, manifest));
  if (record) stateStore.recordInstall(appId, artifactId, { version, path: dir });
  return dir;
}

/** A plain archive-dir install with a runnable binary. */
async function goodArchiveDir(e, appId = "demo", artifactId = "archive-dir-linux") {
  const dir = dirFor(e, appId, artifactId);
  await util.mkdirp(dir);
  await fsp.writeFile(path.join(dir, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await makeInstall(e, appId, artifactId, { kind: "archive-dir", binary: "run.sh" });
  return dir;
}

/** An appimage install: extracted tree + the kept original beside it. */
async function appImageInstall(e, bytes = "APPIMAGE-BYTES", appId = "demo", artifactId = "appimage-linux") {
  const dir = dirFor(e, appId, artifactId);
  await util.mkdirp(dir);
  await fsp.writeFile(path.join(dir, "AppRun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fsp.writeFile(path.join(dir, "demo.AppImage"), bytes, { mode: 0o755 });
  await makeInstall(e, appId, artifactId, {
    kind: "appimage",
    binary: "AppRun",
    extra: { appImageFile: "demo.AppImage", sandboxed: false },
  });
  return { dir, kept: path.join(dir, "demo.AppImage") };
}

function kinds(row) {
  return (row.problems || []).map((p) => p.kind);
}

function only(rows) {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* the healthy case                                                    */
/* ------------------------------------------------------------------ */

test("audit: a clean install has no problems", async (t) => {
  const e = env(t);
  await goodArchiveDir(e);

  const row = only(await audit.audit());
  assert.equal(row.ok, true, JSON.stringify(row.problems));
  assert.deepEqual(row.problems, []);
  assert.equal(row.appId, "demo");
  assert.equal(row.artifactId, "archive-dir-linux");
  assert.equal(row.kind, "archive-dir");
  assert.equal(row.version, "1.0.0");
  assert.equal(row.path, dirFor(e, "demo", "archive-dir-linux"));
});

test("audit: every install is walked, and appId narrows it to one app", async (t) => {
  const e = env(t);
  await goodArchiveDir(e, "demo");
  await goodArchiveDir(e, "other", "archive-dir-linux");

  assert.equal((await audit.audit()).length, 2);
  const mine = await audit.audit("other");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].appId, "other");
  assert.deepEqual(await audit.audit("no-such-app"), []);
  assert.deepEqual(await audit.audit(), await audit.audit(null));
});

test("audit: nothing installed → an empty report, not an error", async (t) => {
  env(t);
  assert.deepEqual(await audit.audit(), []);
  assert.deepEqual(audit.summarize([]), { total: 0, ok: 0, broken: 0, problems: 0 });
});

/* ------------------------------------------------------------------ */
/* one break at a time                                                 */
/* ------------------------------------------------------------------ */

test("audit: the install directory is gone → missing-dir", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.rm(dir, { recursive: true, force: true });

  const row = only(await audit.audit());
  assert.equal(row.ok, false);
  assert.deepEqual(kinds(row), ["missing-dir"]);
  assert.equal(row.problems[0].path, dir);
  assert.match(row.problems[0].detail, /not found/);
  // the walk stops there: no cascade of consequences
  assert.equal(row.problems.length, 1);
});

test("audit: a file where the install dir should be → missing-dir, not a crash", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.rm(dir, { recursive: true, force: true });
  await util.mkdirp(path.dirname(dir));
  await fsp.writeFile(dir, "not a directory");

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["missing-dir"]);
  assert.match(row.problems[0].detail, /not a directory/);
});

test("audit: corrupt manifest JSON → bad-manifest (and nothing else)", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.writeFile(path.join(dir, util.MANIFEST_NAME), "{ this is not json");
  await fsp.rm(path.join(dir, "run.sh")); // would be a second problem if we got that far

  const row = only(await audit.audit());
  assert.equal(row.ok, false);
  assert.deepEqual(kinds(row), ["bad-manifest"]);
  assert.equal(row.problems[0].path, path.join(dir, util.MANIFEST_NAME));
});

test("audit: a missing manifest is a bad manifest", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.rm(path.join(dir, util.MANIFEST_NAME));

  assert.deepEqual(kinds(only(await audit.audit())), ["bad-manifest"]);
});

test("audit: a manifest that parses to a non-object is a bad manifest", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.writeFile(path.join(dir, util.MANIFEST_NAME), '"a string"');

  assert.deepEqual(kinds(only(await audit.audit())), ["bad-manifest"]);
});

test("audit: manifest.binary is gone → missing-binary", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.rm(path.join(dir, "run.sh"));

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["missing-binary"]);
  assert.equal(row.problems[0].path, path.join(dir, "run.sh"));
});

test("audit: the binary lost its exec bit → not-executable", async (t) => {
  const e = env(t);
  const dir = await goodArchiveDir(e);
  await fsp.chmod(path.join(dir, "run.sh"), 0o644);

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["not-executable"]);
  assert.match(row.problems[0].detail, /644/);
});

test("audit: no manifest.binary → no binary check at all", async (t) => {
  const e = env(t);
  await makeInstall(e, "demo", "generic-zip-linux", { kind: "generic-zip", binary: null });

  assert.equal(only(await audit.audit()).ok, true);
});

test("audit: a recorded file outside the install dir is gone → missing-file", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "home", ".local", "bin", "wivrn-server");
  await util.mkdirp(path.dirname(outside));
  await fsp.writeFile(outside, "#!/bin/sh\n", { mode: 0o755 });
  await makeInstall(e, "wivrn-nx", "tarball-prefix-linux", {
    kind: "tarball-prefix",
    files: [outside],
    dirs: [path.dirname(outside)],
    binary: null,
  });

  assert.equal(only(await audit.audit()).ok, true, "the file is still there");

  await fsp.rm(outside);
  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["missing-file"]);
  assert.equal(row.problems[0].path, outside);
});

test("audit: a blender addon folder that was deleted by hand → missing-file", async (t) => {
  const e = env(t);
  const addon = path.join(e.root, "blender", "addons", "quadforge");
  await util.mkdirp(addon);
  await makeInstall(e, "quadforge", "blender-addon-linux", {
    kind: "blender-addon",
    files: [addon],
    binary: null,
    extra: { addonsDir: path.dirname(addon) },
  });

  assert.equal(only(await audit.audit()).ok, true);
  await fsp.rm(addon, { recursive: true, force: true });
  assert.deepEqual(kinds(only(await audit.audit())), ["missing-file"]);
});

test("audit: a desktop entry that vanished → missing-desktop-entry", async (t) => {
  const e = env(t);
  const entry = path.join(e.root, "xdg", "applications", "nx-demo.desktop");
  await util.mkdirp(path.dirname(entry));
  await fsp.writeFile(entry, "[Desktop Entry]\n");
  const dir = dirFor(e, "demo", "archive-dir-linux");
  await util.mkdirp(dir);
  await makeInstall(e, "demo", "archive-dir-linux", { kind: "archive-dir", desktopEntries: [entry], binary: null });

  assert.equal(only(await audit.audit()).ok, true);
  await fsp.rm(entry);
  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["missing-desktop-entry"]);
  assert.equal(row.problems[0].path, entry);
});

test("audit: several breaks in one install are all reported", async (t) => {
  const e = env(t);
  const entry = path.join(e.root, "xdg", "applications", "nx-demo.desktop");
  const outside = path.join(e.root, "home", "bin", "demo");
  const dir = dirFor(e, "demo", "archive-dir-linux");
  await util.mkdirp(dir);
  await makeInstall(e, "demo", "archive-dir-linux", {
    kind: "archive-dir",
    binary: "run.sh",
    files: [outside],
    desktopEntries: [entry],
  });

  const row = only(await audit.audit());
  assert.equal(row.ok, false);
  assert.deepEqual(kinds(row).sort(), ["missing-binary", "missing-desktop-entry", "missing-file"]);
});

/* ------------------------------------------------------------------ */
/* appimage: the kept original and its hash                            */
/* ------------------------------------------------------------------ */

test("audit: the kept AppImage is gone → missing-file", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e);
  await fsp.rm(kept);

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["missing-file"]);
  assert.equal(row.problems[0].path, kept);
  assert.match(row.problems[0].detail, /kept AppImage/);
});

test("audit: no expected sha256 anywhere → the hash check is skipped silently", async (t) => {
  const e = env(t);
  await appImageInstall(e);

  const row = only(await audit.audit());
  assert.equal(row.ok, true);
  assert.deepEqual(row.problems, []);
  assert.ok(
    row.notes.some((n) => /not checked/.test(n)),
    "the skip is a note, never a problem"
  );
});

test("audit: the asset index knows the sha256 → matching bytes verify", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e, "THE-REAL-BYTES");
  const index = assetsMod.createAssetIndex(e.dataDir);
  assert.ok(await index.recordFile(kept), "the index took the kept file");

  const row = only(await audit.audit());
  assert.equal(row.ok, true, JSON.stringify(row.problems));
  assert.equal(row.sha256, await assetsMod.sha256File(kept));
  assert.ok(row.notes.some((n) => /asset index/.test(n)));
});

test("audit: the bytes were swapped under a known sha256 → hash-mismatch", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e, "THE-REAL-BYTES");
  const index = assetsMod.createAssetIndex(e.dataDir);
  await index.recordFile(kept);

  // same length, different content — the size short-circuit must not hide this
  await fsp.writeFile(kept, "the-fake-bytes".toUpperCase().padEnd("THE-REAL-BYTES".length, "X"));
  assert.equal(fs.statSync(kept).size, "THE-REAL-BYTES".length);

  const row = only(await audit.audit());
  assert.equal(row.ok, false);
  assert.deepEqual(kinds(row), ["hash-mismatch"]);
  assert.equal(row.problems[0].path, kept);
  assert.match(row.problems[0].detail, /expected [0-9a-f]{12}…, found [0-9a-f]{12}…/);
});

test("audit: a truncated kept AppImage is caught by size, without re-hashing", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e, "THE-REAL-BYTES");
  await assetsMod.createAssetIndex(e.dataDir).recordFile(kept);
  await fsp.writeFile(kept, "THE-REAL");

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["hash-mismatch"]);
  assert.match(row.problems[0].detail, /bytes/);
});

test("audit: a sha256 stamped into the manifest is honoured too", async (t) => {
  const e = env(t);
  const dir = dirFor(e, "demo", "appimage-linux");
  await util.mkdirp(dir);
  await fsp.writeFile(path.join(dir, "AppRun"), "#!/bin/sh\n", { mode: 0o755 });
  await fsp.writeFile(path.join(dir, "demo.AppImage"), "SOMETHING ELSE");
  await makeInstall(e, "demo", "appimage-linux", {
    kind: "appimage",
    binary: "AppRun",
    extra: { appImageFile: "demo.AppImage", sha256: "0".repeat(64) },
  });

  const row = only(await audit.audit());
  assert.deepEqual(kinds(row), ["hash-mismatch"]);
  assert.match(row.problems[0].detail, /expected 000000000000…/);
});

test("audit: an index entry for a DIFFERENT file teaches us nothing", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e, "THE-REAL-BYTES");
  const other = path.join(e.root, "elsewhere.AppImage");
  await fsp.writeFile(other, "UNRELATED");
  await assetsMod.createAssetIndex(e.dataDir).recordFile(other);

  const row = only(await audit.audit());
  assert.equal(row.ok, true);
  assert.ok(row.notes.some((n) => /not checked/.test(n)));
  assert.ok(fs.existsSync(kept));
});

test("audit: reading the index never mutates it (validate() would)", async (t) => {
  const e = env(t);
  const { kept } = await appImageInstall(e, "THE-REAL-BYTES");
  const index = assetsMod.createAssetIndex(e.dataDir);
  await index.recordFile(kept);
  await fsp.writeFile(kept, "SWAPPED-BYTES!");
  const before = fs.readFileSync(index.path, "utf8");

  await audit.audit();
  assert.equal(fs.readFileSync(index.path, "utf8"), before, "the audit is read-only");
});

/* ------------------------------------------------------------------ */
/* device-resident installs                                            */
/* ------------------------------------------------------------------ */

test("audit: apk-adb installs skip every file check and report ok with a note", async (t) => {
  const e = env(t);
  await makeInstall(e, "wivrn-nx", "apk-adb-android", {
    kind: "apk-adb",
    // an icon that is long gone, and a binary that never existed on this box
    files: [path.join(e.root, "icons", "wivrn.png")],
    binary: "nope",
    extra: { packageId: "org.wivrn.nx", deviceSerial: "PA7X" },
  });

  const row = only(await audit.audit());
  assert.equal(row.ok, true);
  assert.deepEqual(row.problems, []);
  assert.equal(row.kind, "apk-adb");
  assert.equal(row.deviceResident, true, "the UI badges these without parsing prose");
  assert.ok(row.notes.some((n) => /device/.test(n)), row.notes.join(" | "));
});

test("audit: an apk-adb install whose manifest is gone is still reported", async (t) => {
  const e = env(t);
  const dir = await makeInstall(e, "wivrn-nx", "apk-adb-android", { kind: "apk-adb", binary: null });
  await fsp.rm(path.join(dir, util.MANIFEST_NAME));

  // without a manifest there is no kind to skip on — the hub genuinely does
  // not know what this install is any more, and says so.
  assert.deepEqual(kinds(only(await audit.audit())), ["bad-manifest"]);
});

/* ------------------------------------------------------------------ */
/* contract                                                            */
/* ------------------------------------------------------------------ */

test("audit: every kind it can emit is in PROBLEM_KINDS", async (t) => {
  const e = env(t);
  // one of each, spread over four installs
  await goodArchiveDir(e, "a");
  await fsp.rm(dirFor(e, "a", "archive-dir-linux"), { recursive: true, force: true }); // missing-dir
  const b = await goodArchiveDir(e, "b");
  await fsp.writeFile(path.join(b, util.MANIFEST_NAME), "nope{"); // bad-manifest
  const c = await goodArchiveDir(e, "c");
  await fsp.rm(path.join(c, "run.sh")); // missing-binary
  const d = await goodArchiveDir(e, "d");
  await fsp.chmod(path.join(d, "run.sh"), 0o600); // not-executable
  await makeInstall(e, "f", "x", { files: [path.join(e.root, "gone")], desktopEntries: [path.join(e.root, "gone.desktop")] });
  const { kept } = await appImageInstall(e, "BYTES", "g");
  await assetsMod.createAssetIndex(e.dataDir).recordFile(kept);
  await fsp.writeFile(kept, "OTHER"); // hash-mismatch

  const rows = await audit.audit();
  const seen = new Set(rows.flatMap((r) => kinds(r)));
  for (const kind of seen) assert.ok(audit.PROBLEM_KINDS.includes(kind), `${kind} is not a declared kind`);
  for (const kind of ["missing-dir", "bad-manifest", "missing-binary", "not-executable", "missing-file", "missing-desktop-entry", "hash-mismatch"]) {
    assert.ok(seen.has(kind), `this test no longer produces a ${kind}`);
  }

  const sum = audit.summarize(rows);
  assert.equal(sum.total, rows.length);
  assert.equal(sum.broken, rows.filter((r) => !r.ok).length);
  assert.equal(sum.ok + sum.broken, sum.total);
});

test("audit: `ok` is exactly `problems is empty`, and rows keep the frozen shape", async (t) => {
  const e = env(t);
  await goodArchiveDir(e, "a");
  const b = await goodArchiveDir(e, "b");
  await fsp.rm(path.join(b, "run.sh"));

  for (const row of await audit.audit()) {
    assert.equal(row.ok, (row.problems || []).length === 0);
    for (const key of ["appId", "artifactId", "ok", "kind", "version", "path", "deviceResident", "problems", "notes"]) {
      assert.ok(key in row, `getAudit() row is missing ${key}`);
    }
    for (const p of row.problems) {
      assert.equal(typeof p.kind, "string");
      assert.equal(typeof p.detail, "string");
    }
  }
});

test("audit: an install with no recorded path falls back to installRoot/nx/<app>/<artifact>", async (t) => {
  const e = env(t);
  await goodArchiveDir(e, "demo");
  // simulate an older state.json that never stored the path
  const raw = stateStore.load();
  raw.installed.demo["archive-dir-linux"].path = null;
  stateStore.save(raw);

  const row = only(await audit.audit());
  assert.equal(row.path, dirFor(e, "demo", "archive-dir-linux"));
  assert.equal(row.ok, true);
});

test("audit: a state.json full of nonsense audits as empty rather than throwing", async (t) => {
  const e = env(t);
  fs.writeFileSync(path.join(e.dataDir, "state.json"), "{{{not json");
  assert.deepEqual(await audit.audit(), []);
});

/* ------------------------------------------------------------------ */
/* repair                                                              */
/* ------------------------------------------------------------------ */

test("audit: repair() queues the ordinary install job and hands back its id", (t) => {
  env(t);
  const calls = [];
  const fakeJobs = {
    install(appId, artifactId) {
      calls.push([appId, artifactId]);
      return "job-42";
    },
  };

  assert.equal(audit.repair("demo", "archive-dir-linux", { jobs: fakeJobs }), "job-42");
  assert.deepEqual(calls, [["demo", "archive-dir-linux"]]);
});

test("audit: repair() refuses a half-named target instead of guessing", (t) => {
  env(t);
  assert.throws(() => audit.repair("demo", null, { jobs: { install: () => "x" } }), /needs an app and an artifact/);
  assert.throws(() => audit.repair(null, "a", { jobs: { install: () => "x" } }), /needs an app and an artifact/);
});

test("audit: repair() reinstalls the CURRENT version — no tag, no version pinning", (t) => {
  env(t);
  const seen = [];
  audit.repair("demo", "a", { jobs: { install: (...args) => seen.push(args) || "id" } });
  assert.deepEqual(seen, [["demo", "a"]], "no third argument: the pipeline picks the current version");
});

/* ------------------------------------------------------------------ */
/* ipc surface                                                         */
/* ------------------------------------------------------------------ */

/** Minimal ipcMain double, same shape as the other ipc tests use. */
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

test("ipc: getAudit / repairInstall are on the surface", async (t) => {
  const e = env(t);
  const ipc = require("../../src/main/ipc");
  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });
  for (const name of ["getAudit", "repairInstall"]) {
    assert.ok(ipcMain.handlers.has(`nxhub:${name}`), `channel nxhub:${name} not registered`);
  }

  const clean = await goodArchiveDir(e, "demo");
  const rows = await ipcMain.invoke("nxhub:getAudit");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);

  await fsp.rm(path.join(clean, "run.sh"));
  const broken = await ipcMain.invoke("nxhub:getAudit", "demo");
  assert.deepEqual(kinds(broken[0]), ["missing-binary"]);
  assert.deepEqual(await ipcMain.invoke("nxhub:getAudit", "no-such-app"), []);

  // repairInstall goes through jobs.install, which resolves against discovery —
  // with an empty model that is an honest "unknown app", not a silent no-op.
  await assert.rejects(() => ipcMain.invoke("nxhub:repairInstall", "demo", "archive-dir-linux"), /Unknown app/);
});

test("ipc: getAudit never rejects, however broken the tree is", async (t) => {
  const e = env(t);
  const ipc = require("../../src/main/ipc");
  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });

  const dir = await goodArchiveDir(e, "demo");
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.writeFile(path.join(e.dataDir, "asset-index.json"), "{ not json");

  const rows = await ipcMain.invoke("nxhub:getAudit");
  assert.equal(rows[0].ok, false);
  assert.deepEqual(kinds(rows[0]), ["missing-dir"]);
});
