"use strict";
// App models for the CLI tests — the same shape discovery.buildApps produces
// (SPEC "App model"), hand-written so rendering/matching tests need no network.

function artifact(over = {}) {
  return Object.assign(
    {
      id: "archive-dir-linux",
      label: "Linux build",
      platform: "linux",
      kind: "archive-dir",
      assetName: "app-linux.zip",
      assetUrl: "http://example.invalid/a.zip",
      size: 1024 * 1024 * 3,
      installed: null,
      updateAvailable: false,
      launchable: true,
      rollbackAvailable: false,
      prevVersion: null,
      sourceTag: "v1.0.0",
      sourceVersion: "1.0.0",
      fromOlderRelease: false,
      postInstallNote: null,
    },
    over
  );
}

function app(over = {}) {
  return Object.assign(
    {
      id: "demo",
      repo: "nerdrx/demo",
      owner: "nerdrx",
      name: "Demo",
      tagline: "a demo app",
      private: false,
      order: 100,
      unpublished: false,
      hasAnyRelease: true,
      installableHere: true,
      overlayHidden: false,
      localHidden: false,
      updatePolicy: "notify",
      includePrereleases: false,
      latest: { tag: "v1.0.0", version: "1.0.0", publishedAt: "2026-05-01T10:00:00Z", notes: "", prerelease: false },
      artifacts: [artifact()],
    },
    over
  );
}

/** wivrn: two artifacts, one installed with an update pending. */
const wivrn = app({
  id: "wivrn-nx",
  repo: "nerdrx/wivrn-nx",
  name: "WiVRn NX",
  tagline: "OpenXR streaming",
  latest: { tag: "v1.4.0", version: "1.4.0", publishedAt: "2026-05-01T10:00:00Z", notes: "", prerelease: false },
  artifacts: [
    artifact({
      id: "apk-adb-android",
      label: "Headset APK",
      platform: "android",
      kind: "apk-adb",
      assetName: "wivrn-nx-1.4.0.apk",
      sourceTag: "v1.4.0",
      sourceVersion: "1.4.0",
      installed: { version: "1.3.2", path: null, installedAt: "2026-04-02T00:00:00Z" },
      updateAvailable: true,
    }),
    artifact({
      id: "tarball-prefix-linux",
      label: "Linux server",
      platform: "linux",
      kind: "tarball-prefix",
      assetName: "wivrn-nx-server-1.4.0-linux.tar.gz",
      sourceTag: "v1.3.0",
      sourceVersion: "1.3.0",
      fromOlderRelease: true,
      postInstallNote: "Re-run: sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server",
    }),
  ],
});

/** quadforge: single artifact, installed and current. */
const quadforge = app({
  id: "quadforge",
  repo: "nerdrx/quadforge",
  name: "QuadForge",
  tagline: "Auto-retopology for Blender",
  latest: { tag: "nx-1.3", version: "1.3", publishedAt: "2026-04-20T09:00:00Z", notes: "", prerelease: false },
  artifacts: [
    artifact({
      id: "blender-addon-linux",
      label: "Blender addon",
      kind: "blender-addon",
      assetName: "quadforge-1.3.zip",
      sourceTag: "nx-1.3",
      sourceVersion: "1.3",
      launchable: false,
      installed: { version: "1.3", path: "/home/u/.config/blender/addons/quadforge", installedAt: "2026-04-21T00:00:00Z" },
      rollbackAvailable: true,
      prevVersion: "1.2",
    }),
  ],
});

/** limbo: two platforms, nothing installed. */
const limbo = app({
  id: "banish-protocol",
  repo: "nerdrx/banish-protocol",
  name: "LIMBO PROTOCOL",
  tagline: "Co-op roguelite",
  latest: { tag: "2.0", version: "2.0", publishedAt: "2026-03-11T08:00:00Z", notes: "", prerelease: false },
  artifacts: [
    artifact({ id: "archive-dir-linux", label: "Linux build", sourceTag: "2.0", sourceVersion: "2.0" }),
    artifact({
      id: "windows-zip-windows",
      label: "Windows build",
      platform: "windows",
      kind: "windows-zip",
      launchable: false,
      sourceTag: "2.0",
      sourceVersion: "2.0",
    }),
  ],
});

/** a repo from a second source (owner-prefixed id) */
const coolTool = app({
  id: "someone-else--cool-tool",
  repo: "someone-else/cool-tool",
  owner: "someone-else",
  name: "cool-tool",
  foreignOwner: true,
  latest: { tag: "v0.9", version: "0.9", publishedAt: "2026-01-05T08:00:00Z", notes: "", prerelease: false },
});

/** bottom-section citizens */
const lonely = app({
  id: "lonely-repo",
  repo: "nerdrx/lonely-repo",
  name: "lonely-repo",
  tagline: "no releases here",
  unpublished: true,
  hasAnyRelease: false,
  installableHere: false,
  latest: null,
  artifacts: [],
});

const petri = app({
  id: "petri",
  repo: "nerdrx/petri",
  name: "petri",
  overlayHidden: true,
  artifacts: [artifact({ id: "archive-dir-linux" })],
});

const APPS = [wivrn, quadforge, limbo, coolTool, lonely, petri];

const RELEASES = [
  { tag: "v1.4.0", version: "1.4.0", publishedAt: "2026-05-01T10:00:00Z", notes: "", prerelease: false, assets: [{ name: "a" }, { name: "b" }] },
  { tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-04-01T10:00:00Z", notes: "", prerelease: false, assets: [{ name: "a" }] },
  { tag: "v1.5.0-rc1", version: "1.5.0-rc1", publishedAt: "2026-05-10T10:00:00Z", notes: "", prerelease: true, assets: [] },
];

const DOCTOR = {
  hubVersion: "0.3.6",
  runtime: "node 20.18.0 (electron 31.7.7, run-as-node)",
  dataDir: "/tmp/nx/data",
  installRoot: "/tmp/nx/apps",
  settingsPath: "/tmp/nx/data/settings.json",
  settingsExists: true,
  logFile: "/tmp/nx/data/logs/nx-hub.log",
  tokenSource: "gh",
  owners: ["nerdrx"],
  extraRepos: ["someone-else/cool-tool"],
  adbPath: "adb",
  adb: { available: true, devices: [{ serial: "PA7X", model: "Pico 4 Ultra", state: "device" }] },
  engine: true,
  engineError: null,
  rateLimit: null,
  errors: [],
  lastRefresh: "2026-08-15T22:01:20.006Z",
  appCount: 6,
  installedCount: 2,
  updateCount: 1,
  shimPath: "/home/u/.local/bin/nx",
  shimState: "current",
  shimOnPath: true,
  cliShimSetting: true,
};

module.exports = { app, artifact, APPS, wivrn, quadforge, limbo, coolTool, lonely, petri, RELEASES, DOCTOR };
