"use strict";
// Overlay merge, hidden list, ordering, installed/adb merge, live refresh.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const stateStore = require("../../src/main/state");

const OVERLAY = {
  hidden: ["petri", "CDRP-for-Claude"],
  apps: {
    "wivrn-nx": {
      name: "WiVRn NX",
      tagline: "OpenXR streaming to the Pico",
      order: 1,
      artifacts: [
        {
          assetPattern: "wivrn-nx-release*.apk",
          label: "Pico headset APK",
          kind: "apk-adb",
          platform: "android",
          packageId: "org.meumeu.wivrn.nx",
        },
        {
          assetPattern: "wivrn-nx-server-*-linux-x86_64.tar.gz",
          label: "Linux server + dashboard",
          kind: "tarball-prefix",
          platform: "linux",
          stripPrefix: "usr/",
          prefix: "~/.local",
          postInstallNote: "Re-run setcap",
        },
      ],
    },
    quadforge: {
      name: "QuadForge",
      order: 5,
      artifacts: [
        {
          assetPattern: "quadforge-*.zip",
          label: "Blender addon",
          kind: "blender-addon",
          platform: "linux",
          addonsDir: "~/.config/blender/5.2/scripts/addons",
        },
      ],
    },
    "OscGoesBrrr-NX-Patches": {
      name: "OGB NX-Patches",
      order: 4,
      artifacts: [
        { assetPattern: "*windows-setup*.exe", skip: true },
        { assetPattern: "*linux*.AppImage", label: "Linux app", kind: "appimage", platform: "linux" },
      ],
    },
  },
};

function repoFor(name, extra) {
  return helpers.repo("nerdrx", name, extra);
}

function buildOne(repo, release, opts = {}) {
  return discovery.buildApps({
    repos: [repo],
    releases: release ? { [repo.full_name.toLowerCase()]: release } : {},
    overlay: opts.overlay || OVERLAY,
    installedState: opts.installedState || { installed: {} },
    adb: opts.adb || { available: false, devices: [], apkVersions: {} },
    primaryOwner: "nerdrx",
  })[0];
}

test("overlay supplies name, tagline and order; repo values are the fallback", () => {
  const app = buildOne(repoFor("wivrn-nx", { description: "repo description" }), helpers.release("v1.4.0", []));
  assert.strictEqual(app.id, "wivrn-nx");
  assert.strictEqual(app.name, "WiVRn NX");
  assert.strictEqual(app.tagline, "OpenXR streaming to the Pico");
  assert.strictEqual(app.order, 1);

  const plain = buildOne(repoFor("lonely-repo", { description: "no overlay entry" }), helpers.release("v1", []));
  assert.strictEqual(plain.name, "lonely-repo");
  assert.strictEqual(plain.tagline, "no overlay entry");
  assert.strictEqual(plain.order, 100);
});

test("hidden repos stay listed but carry the overlayHidden flag (case-insensitive)", () => {
  const apps = discovery.buildApps({
    repos: [repoFor("petri"), repoFor("CDRP-for-Claude"), repoFor("quadforge")],
    releases: {},
    overlay: OVERLAY,
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  });
  const flags = Object.fromEntries(apps.map((a) => [a.id, a.overlayHidden]));
  assert.strictEqual(apps.length, 3, "nothing is dropped anymore — bottom section lists it");
  assert.strictEqual(flags["petri"], true);
  assert.strictEqual(flags["cdrp-for-claude"], true);
  assert.strictEqual(flags["quadforge"], false);
});

test("hidden is owner-scoped: another source's identically-named repo is NOT hidden", () => {
  const apps = discovery.buildApps({
    repos: [
      helpers.repo("nerdrx", "petri"),
      helpers.repo("Arikazei", "petri"),
      helpers.repo("Arikazei", "quadforge"),
    ],
    releases: {},
    overlay: { hidden: ["petri", "arikazei/quadforge"], apps: {} },
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  });
  const by = Object.fromEntries(apps.map((a) => [`${a.repo}`, a.overlayHidden]));
  assert.strictEqual(by["nerdrx/petri"], true, "bare name hides the primary owner's repo");
  assert.strictEqual(by["Arikazei/petri"], false, "…but never a foreign repo of the same name");
  assert.strictEqual(by["Arikazei/quadforge"], true, "owner/repo entries hide exactly that repo");
});

test("installableHere: false when a release only ships foreign-platform assets", () => {
  const apps = discovery.buildApps({
    repos: [repoFor("winonly"), repoFor("quadforge")],
    releases: {
      "nerdrx/winonly": helpers.release("v1", [{ name: "tool-windows-x86_64.zip", id: 9, size: 5, url: "u" }]),
      "nerdrx/quadforge": helpers.release("v1", [{ name: "quadforge-1.zip", id: 10, size: 5, url: "u" }]),
    },
    overlay: { hidden: [], apps: {} },
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  });
  const byId = Object.fromEntries(apps.map((a) => [a.id, a]));
  assert.strictEqual(byId["winonly"].installableHere, process.platform === "win32");
  assert.strictEqual(byId["quadforge"].installableHere, true, "generic zip installs anywhere");
  assert.strictEqual(byId["winonly"].unpublished, false, "it HAS a release — just not for here");
});

test("apps sort by overlay order, then name; unpublished sink to the end", () => {
  const rel = (tag) => helpers.release(tag, [{ name: "x-linux.zip", id: 1, size: 1, url: "u" }]);
  const apps = discovery.buildApps({
    repos: [repoFor("quadforge"), repoFor("wivrn-nx"), repoFor("OscGoesBrrr-NX-Patches"), repoFor("aaa-no-release")],
    releases: {
      "nerdrx/quadforge": rel("v1"),
      "nerdrx/wivrn-nx": rel("v1"),
      "nerdrx/oscgoesbrrr-nx-patches": rel("v1"),
    },
    overlay: OVERLAY,
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  });
  assert.deepStrictEqual(
    apps.map((a) => a.id),
    ["wivrn-nx", "oscgoesbrrr-nx-patches", "quadforge", "aaa-no-release"]
  );
  assert.strictEqual(apps[3].unpublished, true);
  assert.strictEqual(apps[3].latest, null);
});

test("overlay artifacts win over the default classification and carry engine hints", () => {
  const data = helpers.defaultData("http://mock");
  const app = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"]);
  assert.strictEqual(app.artifacts.length, 2);

  const apk = app.artifacts[0];
  assert.strictEqual(apk.label, "Pico headset APK");
  assert.strictEqual(apk.kind, "apk-adb");
  assert.strictEqual(apk.packageId, "org.meumeu.wivrn.nx");
  assert.strictEqual(apk.id, "apk-adb-android");

  const server = app.artifacts[1];
  assert.strictEqual(server.kind, "tarball-prefix"); // overlay-only kind, not a heuristic
  assert.strictEqual(server.stripPrefix, "usr/");
  assert.strictEqual(server.postInstallNote, "Re-run setcap");
  assert.strictEqual(server.id, "tarball-prefix-linux");
  // sibling checksum captured for verification
  assert.ok(server.checksumUrl, "sha256 sidecar should be recorded");
  // .sha256 and .yml never become artifacts
  assert.ok(!app.artifacts.some((a) => /\.(sha256|yml)$/.test(a.assetName)));
});

test("overlay skip:true drops an asset", () => {
  const data = helpers.defaultData("http://mock");
  const app = buildOne(repoFor("OscGoesBrrr-NX-Patches", { private: true }), data.releases["nerdrx/OscGoesBrrr-NX-Patches"]);
  const names = app.artifacts.map((a) => a.assetName);
  assert.ok(!names.some((n) => /setup/.test(n)), "setup exe must be skipped");
  assert.strictEqual(app.private, true);
  // overlay-listed AppImage sorts before the un-overlaid portable exe
  assert.strictEqual(app.artifacts[0].label, "Linux app");
});

test("artifact ids are stable and de-duplicated", () => {
  const rel = helpers.release("v1.0", [
    { name: "a-linux.zip", id: 1, size: 10, url: "u1" },
    { name: "b-linux.zip", id: 2, size: 10, url: "u2" },
  ]);
  const app = buildOne(repoFor("banish-protocol"), rel);
  assert.deepStrictEqual(
    app.artifacts.map((a) => a.id),
    ["archive-dir-linux", "archive-dir-linux-2"]
  );
});

test("unpublished when the release has no classifiable asset", () => {
  const app = buildOne(repoFor("docs-only"), helpers.release("v1", [{ name: "notes.txt", id: 9, size: 3, url: "u" }]));
  assert.strictEqual(app.unpublished, true);
  assert.deepStrictEqual(app.artifacts, []);
  assert.ok(app.latest, "latest is still reported");
});

test("installed state merges in and drives updateAvailable", () => {
  const data = helpers.defaultData("http://mock");
  const installedState = {
    installed: {
      "wivrn-nx": {
        "tarball-prefix-linux": { version: "1.3.0", path: "/tmp/x", installedAt: "2026-01-01T00:00:00Z" },
      },
    },
  };
  const app = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"], { installedState });
  const server = app.artifacts.find((a) => a.id === "tarball-prefix-linux");
  assert.strictEqual(server.installed.version, "1.3.0");
  assert.strictEqual(server.updateAvailable, true);

  installedState.installed["wivrn-nx"]["tarball-prefix-linux"].version = "1.4.0";
  const app2 = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"], { installedState });
  assert.strictEqual(app2.artifacts.find((a) => a.id === "tarball-prefix-linux").updateAvailable, false);
});

test("apk artifacts use the live device version when a device is connected", () => {
  const data = helpers.defaultData("http://mock");
  const installedState = {
    installed: { "wivrn-nx": { "apk-adb-android": { version: "1.0.0", path: null, installedAt: "2026-01-01T00:00:00Z" } } },
  };
  const adb = {
    available: true,
    devices: [{ serial: "PICO123", model: "Pico4", state: "device" }],
    apkVersions: { "org.meumeu.wivrn.nx": "1.4.0" },
  };
  const app = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"], { installedState, adb });
  const apk = app.artifacts.find((a) => a.id === "apk-adb-android");
  assert.strictEqual(apk.installed.version, "1.4.0");
  assert.strictEqual(apk.updateAvailable, false);
  assert.ok(!apk.deviceOffline);

  // device offline → fall back to recorded state with a hint
  const offline = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"], { installedState });
  const apkOff = offline.artifacts.find((a) => a.id === "apk-adb-android");
  assert.strictEqual(apkOff.installed.version, "1.0.0");
  assert.strictEqual(apkOff.deviceOffline, true);
});

test("every artifact carries a launchable flag the UI can trust", () => {
  const rel = helpers.release("v1.0", [
    { name: "app-linux.AppImage", id: 1, size: 1, url: "u1" },
    { name: "addon-1.0.zip", id: 2, size: 1, url: "u2" },
    { name: "game-windows.zip", id: 3, size: 1, url: "u3" },
    { name: "thing.apk", id: 4, size: 1, url: "u4" },
    { name: "server-linux.tar.gz", id: 5, size: 1, url: "u5" },
  ]);
  const overlay = {
    apps: {
      mixed: {
        artifacts: [
          { assetPattern: "addon-*.zip", label: "Addon", kind: "blender-addon", platform: "linux", addonsDir: "~/a" },
          { assetPattern: "server-linux.tar.gz", label: "Server", kind: "tarball-prefix", platform: "linux", prefix: "~/.local" },
        ],
      },
    },
  };
  const app = discovery.buildApps({
    repos: [repoFor("mixed")],
    releases: { "nerdrx/mixed": rel },
    overlay,
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  })[0];
  const by = (kind) => app.artifacts.find((a) => a.kind === kind);

  assert.strictEqual(by("appimage").launchable, true);
  assert.strictEqual(by("blender-addon").launchable, false, "blender addons never launch");
  assert.strictEqual(by("windows-zip").launchable, process.platform === "win32");
  assert.strictEqual(by("apk-adb").launchable, false, "apk without a packageId cannot be launched");
  assert.strictEqual(by("tarball-prefix").launchable, false, "no launchCmd in the overlay");

  // overlay launchCmd flips tarball-prefix on
  overlay.apps.mixed.artifacts[1].launchCmd = "~/.local/bin/wivrn-dashboard";
  const app2 = discovery.buildApps({
    repos: [repoFor("mixed")],
    releases: { "nerdrx/mixed": rel },
    overlay,
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  })[0];
  assert.strictEqual(app2.artifacts.find((a) => a.kind === "tarball-prefix").launchable, true);

  // the engine's recorded result wins after an install
  const installedState = {
    installed: { mixed: { "appimage-linux": { version: "1.0", path: "/x", installedAt: "now", launchable: false } } },
  };
  const app3 = discovery.buildApps({
    repos: [repoFor("mixed")],
    releases: { "nerdrx/mixed": rel },
    overlay,
    installedState,
    adb: {},
    primaryOwner: "nerdrx",
  })[0];
  assert.strictEqual(app3.artifacts.find((a) => a.kind === "appimage").launchable, false);
});

test("adb status is exposed as versions{} keyed by packageId", () => {
  const data = helpers.defaultData("http://mock");
  const adb = {
    available: true,
    devices: [{ serial: "PICO123", model: "Pico4", state: "device" }],
    versions: { "org.meumeu.wivrn.nx": "1.4.0" }, // UI-facing shape
  };
  const app = buildOne(repoFor("wivrn-nx"), data.releases["nerdrx/wivrn-nx"], { adb });
  assert.strictEqual(app.artifacts.find((a) => a.kind === "apk-adb").installed.version, "1.4.0");
});

test("apps from a non-primary owner are flagged for the owner badge", () => {
  const app = discovery.buildApps({
    repos: [helpers.repo("someone-else", "cool-tool")],
    releases: {},
    overlay: OVERLAY,
    installedState: { installed: {} },
    adb: {},
    primaryOwner: "nerdrx",
  })[0];
  assert.strictEqual(app.foreignOwner, true);
  assert.strictEqual(app.repo, "someone-else/cool-tool");
  assert.strictEqual(app.owner, "someone-else");
});

/* ---------------- live refresh against the mock API ---------------- */

test("refresh() discovers owners + extraRepos and applies the live overlay", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ token: "test-token", overlay: OVERLAY });
  t.after(async () => {
    await mock.close();
    env.cleanup();
    delete process.env.NX_HUB_NO_LIVE_OVERLAY;
  });

  delete process.env.NX_HUB_NO_LIVE_OVERLAY; // exercise the live raw fetch
  config.save({ owners: ["nerdrx"], extraRepos: ["someone-else/cool-tool"], token: "test-token" });

  const client = github.createClient({
    baseUrl: mock.base,
    rawBaseUrl: `${mock.base}/raw`,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => "test-token",
  });
  discovery.init({ github: client, emit: () => {} });

  const apps = await discovery.refresh({ force: true });
  const ids = apps.map((a) => a.id);

  assert.ok(ids.includes("wivrn-nx"));
  assert.ok(ids.includes("cool-tool"), "extraRepos entry is discovered");
  assert.ok(ids.includes("petri"), "hidden repo is listed for the bottom section");
  assert.strictEqual(apps.find((a) => a.id === "petri").overlayHidden, true, "…flagged overlayHidden");
  assert.ok(ids.includes("oscgoesbrrr-nx-patches"), "private repo listed via /user/repos when authed");

  const lonely = apps.find((a) => a.id === "lonely-repo");
  assert.strictEqual(lonely.unpublished, true, "repo with no release is unpublished");

  const wivrn = apps.find((a) => a.id === "wivrn-nx");
  assert.strictEqual(wivrn.name, "WiVRn NX");
  assert.strictEqual(wivrn.latest.version, "1.4.0");
  assert.strictEqual(wivrn.latest.tag, "v1.4.0");

  const qf = apps.find((a) => a.id === "quadforge");
  assert.strictEqual(qf.latest.version, "1.3", "nx-1.3 tag parses to 1.3");
  assert.strictEqual(qf.artifacts[0].kind, "blender-addon");

  // cached copy of the live overlay is written
  assert.ok(fs.existsSync(path.join(env.dataDir, "cache", "overlay.json")));

  // remerge picks up newly recorded installs without touching the network
  stateStore.recordInstall("quadforge", "blender-addon-linux", { version: "1.3", path: "/tmp/qf" });
  discovery.remerge();
  const after = discovery.getCached().apps.find((a) => a.id === "quadforge");
  assert.strictEqual(after.artifacts[0].installed.version, "1.3");
  assert.strictEqual(after.artifacts[0].updateAvailable, false);
});

test("refresh() survives a failing source and reports it", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  config.save({ owners: ["nerdrx", "ghost-owner"], extraRepos: [] });
  const client = github.createClient({
    baseUrl: mock.base,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
  discovery.init({ github: client, emit: () => {} });

  const apps = await discovery.refresh({ force: true });
  assert.ok(apps.length > 0, "known owner still resolves");
  const errors = discovery.getCached().errors;
  assert.ok(errors.some((e) => e.source === "ghost-owner"), "missing owner is reported");
  assert.ok(
    !apps.some((a) => a.id === "oscgoesbrrr-nx-patches"),
    "private repos stay hidden when anonymous"
  );
});
