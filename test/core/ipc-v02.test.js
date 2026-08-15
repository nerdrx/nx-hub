"use strict";
// The v0.2 half of the window.nxhub surface: every new channel is registered,
// preload exposes exactly the SPEC names, and update-available raises an OS
// notification only when the user wants one.

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
const ipc = require("../../src/main/ipc");

const V02_METHODS = [
  "getReleases",
  "installVersion",
  "rollback",
  "setAppPref",
  "adbConnect",
  "adbSelectDevice",
  "getDeviceInfo",
  "getDiskUsage",
  "clearDownloadCache",
  "getLogs",
  "exportSettings",
  "importSettings",
];

/** Minimal ipcMain double: records handlers so tests can invoke them. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

function clientFor(mock, env) {
  return github.createClient({
    baseUrl: mock.base,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
}

test("preload exposes exactly the v0.2 methods the SPEC lists", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "preload.js"), "utf8");
  for (const name of V02_METHODS) {
    assert.match(src, new RegExp(`\\b${name}:\\s*\\(`), `preload.${name} missing`);
    assert.match(src, new RegExp(`nxhub:${name}`), `preload.${name} must invoke nxhub:${name}`);
  }
  // the v1 surface is untouched
  for (const name of ["getState", "refresh", "install", "uninstall", "launch", "cancelJob", "setSettings", "onEvent"]) {
    assert.match(src, new RegExp(`\\b${name}:`), `preload.${name} disappeared`);
  }
});

test("every v0.2 channel is registered and answers", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const ipcMain = fakeIpcMain();
  const events = [];
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });
  discovery.init({ github: clientFor(mock, env), emit: (e) => events.push(e), afterRefresh: null });
  jobs._reset();
  jobs.init({ emit: (e) => events.push(e), github: clientFor(mock, env), engine: null, resolve: null });

  // Hermetic adb: a real phone on the developer's USB port must never leak
  // into this test (bit us once — the device list overrode PICO123 below).
  config.save({ owners: ["nerdrx"], extraRepos: [], adbPath: path.join(env.root, "no-such-adb") });
  await discovery.refresh({ force: true });

  for (const name of V02_METHODS) {
    assert.ok(ipcMain.handlers.has(`nxhub:${name}`), `channel nxhub:${name} not registered`);
  }

  // getReleases → the version picker's data
  const releases = await ipcMain.invoke("nxhub:getReleases", "wivrn-nx");
  assert.ok(Array.isArray(releases) && releases.length >= 1);
  assert.ok(releases[0].tag && releases[0].version);

  // setAppPref → merged, persisted, and reflected in getState()
  const state = await ipcMain.invoke("nxhub:setAppPref", "wivrn-nx", { favorite: true, launchArgs: ["--x"] });
  assert.strictEqual(state.settings.appPrefs["wivrn-nx"].favorite, true);
  assert.deepStrictEqual(state.settings.appPrefs["wivrn-nx"].launchArgs, ["--x"]);
  assert.strictEqual(state.apps.find((a) => a.id === "wivrn-nx").favorite, true);

  // disk usage + cache clearing + logs
  const usage = await ipcMain.invoke("nxhub:getDiskUsage", true);
  for (const key of ["perApp", "downloads", "total"]) assert.ok(key in usage, `getDiskUsage().${key} missing`);
  const cleared = await ipcMain.invoke("nxhub:clearDownloadCache");
  assert.strictEqual(typeof cleared.removed, "number");
  config.log("hello from the ipc test");
  const logs = await ipcMain.invoke("nxhub:getLogs", 5);
  assert.ok(logs.lines.some((l) => l.includes("hello from the ipc test")));

  // export / import
  config.save({ token: "ghp_secret" });
  const exported = await ipcMain.invoke("nxhub:exportSettings");
  assert.ok(!exported.includes("ghp_secret"));
  const imported = await ipcMain.invoke("nxhub:importSettings", JSON.stringify({ token: "nope", updatePolicy: "download" }));
  assert.ok(imported.skipped.includes("token"));
  assert.strictEqual(config.load().updatePolicy, "download");
  assert.strictEqual(config.load().token, "ghp_secret");

  // device selection is stored in settings and reported by getState()
  await ipcMain.invoke("nxhub:adbSelectDevice", "PICO123");
  assert.strictEqual(config.load().preferredDeviceSerial, "PICO123");
  assert.strictEqual((await ipcMain.invoke("nxhub:getState")).adb.selected, "PICO123");

  // getDeviceInfo never throws, even with no adb at all
  config.save({ adbPath: path.join(env.root, "no-such-adb") });
  const info = await ipcMain.invoke("nxhub:getDeviceInfo");
  for (const key of ["serial", "model", "batteryPct", "storageFreeBytes"]) {
    assert.ok(key in info, `getDeviceInfo().${key} missing`);
  }
  assert.strictEqual(info.serial, null);
});

test("installVersion / rollback are reachable over IPC", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });

  const release = mock.data.releases["nerdrx/quadforge"];
  const app = {
    id: "quadforge",
    repo: "nerdrx/quadforge",
    name: "QuadForge",
    latest: { tag: release.tag_name, version: "1.3" },
    artifacts: discovery.buildArtifacts(release, {}),
  };
  discovery._setCached({ apps: [app], releases: { quadforge: [release] }, overlay: { hidden: [], apps: {} } });

  jobs._reset();
  jobs.init({
    emit: () => {},
    github: clientFor(mock, env),
    engine: { async rollback() { return { version: "1.2", path: "/tmp/qf", launchable: false }; } },
    resolve: null,
  });
  stateStore.recordInstall("quadforge", app.artifacts[0].id, { version: "1.3", path: "/tmp/qf" });

  const installJobId = await ipcMain.invoke("nxhub:installVersion", "quadforge", app.artifacts[0].id, release.tag_name);
  assert.match(String(installJobId), /^job-\d+$/);
  const rollbackJobId = await ipcMain.invoke("nxhub:rollback", "quadforge", app.artifacts[0].id);
  assert.match(String(rollbackJobId), /^job-\d+$/);
  assert.ok(jobs.list().some((j) => j.type === "rollback"));

  jobs.cancelJob(installJobId);
  discovery._setCached({ apps: [] });
});

test("update-available raises an OS notification only when notifications are on", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  const shown = [];
  class FakeNotification {
    constructor(opts) {
      this.opts = opts;
    }
    show() {
      shown.push(this.opts);
    }
    static isSupported() {
      return true;
    }
  }

  ipc.init({
    ipcMain: fakeIpcMain(),
    BrowserWindow: null,
    shell: null,
    app: null,
    Notification: FakeNotification,
    onSettingsChanged: () => {},
  });

  config.save({ notifications: true });
  ipc.emit({ type: "update-available", appId: "wivrn-nx", appName: "WiVRn NX", version: "1.4.0" });
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0].title, /WiVRn NX 1\.4\.0/);
  assert.ok(shown[0].body);

  config.save({ notifications: false });
  ipc.emit({ type: "update-available", appId: "wivrn-nx", appName: "WiVRn NX", version: "1.5.0" });
  assert.strictEqual(shown.length, 1, "muted when the user turned notifications off");

  // unsupported platform → no throw, no notification
  config.save({ notifications: true });
  class Unsupported extends FakeNotification {
    static isSupported() {
      return false;
    }
  }
  ipc.init({ ipcMain: fakeIpcMain(), BrowserWindow: null, Notification: Unsupported, onSettingsChanged: () => {} });
  ipc.emit({ type: "update-available", appId: "x", version: "1" });
  assert.strictEqual(shown.length, 1);

  // and with no Notification injected at all (unit tests / headless)
  ipc.init({ ipcMain: fakeIpcMain(), BrowserWindow: null, Notification: null, onSettingsChanged: () => {} });
  ipc.emit({ type: "update-available", appId: "x", version: "1" });
});
