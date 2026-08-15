"use strict";
// state.js round-trip + config.js settings/token behaviour.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const stateStore = require("../../src/main/state");

test("state round-trips installs and removes them exactly", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  assert.deepStrictEqual(stateStore.load().installed, {}, "missing state.json reads as empty");

  stateStore.recordInstall("wivrn-nx", "apk-adb-android", { version: "1.4.0", path: null });
  stateStore.recordInstall("wivrn-nx", "tarball-prefix-linux", { version: "1.4.0", path: "/home/x/.local" });
  stateStore.recordInstall("quadforge", "blender-addon-linux", { version: "1.3", path: "/addons/quadforge" });

  const onDisk = JSON.parse(fs.readFileSync(path.join(env.dataDir, "state.json"), "utf8"));
  assert.strictEqual(onDisk.installed["wivrn-nx"]["apk-adb-android"].version, "1.4.0");
  assert.ok(onDisk.installed["quadforge"]["blender-addon-linux"].installedAt, "installedAt stamped");

  const rec = stateStore.getInstall("quadforge", "blender-addon-linux");
  assert.strictEqual(rec.path, "/addons/quadforge");
  assert.strictEqual(stateStore.getInstall("quadforge", "nope"), null);
  assert.strictEqual(stateStore.getInstall("nope", "nope"), null);
  assert.strictEqual(stateStore.listInstalls().length, 3);

  stateStore.removeInstall("quadforge", "blender-addon-linux");
  assert.strictEqual(stateStore.getInstall("quadforge", "blender-addon-linux"), null);
  assert.ok(!stateStore.load().installed.quadforge, "empty app entry pruned");
  assert.strictEqual(stateStore.listInstalls().length, 2, "other installs untouched");
});

test("state writes are atomic (no .tmp left behind, corrupt file tolerated)", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  stateStore.recordInstall("a", "b", { version: "1" });
  const leftovers = fs.readdirSync(env.dataDir).filter((f) => f.includes(".tmp"));
  assert.deepStrictEqual(leftovers, []);

  fs.writeFileSync(path.join(env.dataDir, "state.json"), "{ this is not json");
  assert.deepStrictEqual(stateStore.load().installed, {}, "corrupt state falls back to empty");
});

test("settings defaults match the SPEC", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  delete process.env.NX_HUB_INSTALL_ROOT;

  const s = config.load();
  assert.deepStrictEqual(s.owners, ["nerdrx", "Arikazei"], "both accounts are standard sources");
  assert.deepStrictEqual(s.extraRepos, []);
  assert.strictEqual(s.checkIntervalHours, 6);
  assert.strictEqual(s.installRoot, path.join(os.homedir(), "Applications"));
  assert.strictEqual(s.adbPath, "adb");
  assert.strictEqual(s.token, null);
  assert.strictEqual(config.NX_CONNECTOR_PORT, 9021);

  process.env.NX_HUB_INSTALL_ROOT = env.installRoot;
  assert.strictEqual(config.load().installRoot, env.installRoot, "env override wins for tests");
});

test("settings save merges patches and sanitises junk", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  config.save({ owners: ["nerdrx", "someone-else"], checkIntervalHours: 12 });
  config.save({ extraRepos: ["a/b", "garbage-without-slash"] });

  const s = config.load();
  assert.deepStrictEqual(s.owners, ["nerdrx", "someone-else"], "earlier patch survives");
  assert.strictEqual(s.checkIntervalHours, 12);
  assert.deepStrictEqual(s.extraRepos, ["a/b"]);

  config.save({ checkIntervalHours: "not a number" });
  assert.strictEqual(config.load().checkIntervalHours, 6, "invalid interval falls back to the default");

  // the env override never leaks into the stored file
  const stored = JSON.parse(fs.readFileSync(path.join(env.dataDir, "settings.json"), "utf8"));
  assert.notStrictEqual(stored.installRoot, env.installRoot);
});

test("token resolution prefers settings.token, then gh, then anonymous", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  config.clearTokenCache();

  config.save({ token: "settings-token" });
  assert.strictEqual(await config.resolveToken(), "settings-token");

  config.save({ token: null });
  config.clearTokenCache();
  // NX_HUB_NO_GH=1 (set by helpers) stands in for "gh not available"
  assert.strictEqual(await config.resolveToken(), null);
});

test("installPathFor follows installRoot/nx/<appId>/<artifactId>", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const p = config.installPathFor(config.load(), "wivrn-nx", "appimage-linux");
  assert.strictEqual(p, path.join(env.installRoot, "nx", "wivrn-nx", "appimage-linux"));
});
