"use strict";
// src/cli/match.js — turning what the user typed into an app / artifact.

const test = require("node:test");
const assert = require("node:assert");

const { matchApp, pickArtifact, hostPlatform } = require("../../src/cli/match");
const fx = require("./fixtures");

const APPS = fx.APPS;

test("cli/match: exact id wins", () => {
  assert.equal(matchApp(APPS, "quadforge").app.id, "quadforge");
  assert.equal(matchApp(APPS, "banish-protocol").app.id, "banish-protocol");
});

test("cli/match: case-insensitive, by name as well as id", () => {
  assert.equal(matchApp(APPS, "QUADFORGE").app.id, "quadforge");
  assert.equal(matchApp(APPS, "limbo protocol").app.id, "banish-protocol");
  assert.equal(matchApp(APPS, "WiVRn NX").app.id, "wivrn-nx");
});

test("cli/match: unambiguous prefix", () => {
  assert.equal(matchApp(APPS, "quad").app.id, "quadforge");
  assert.equal(matchApp(APPS, "wiv").app.id, "wivrn-nx");
});

test("cli/match: repo name and owner/repo both resolve", () => {
  assert.equal(matchApp(APPS, "nerdrx/quadforge").app.id, "quadforge");
  assert.equal(matchApp(APPS, "cool-tool").app.id, "someone-else--cool-tool");
});

test("cli/match: ambiguity reports every candidate and no pick", () => {
  const r = matchApp(APPS, "l");
  assert.equal(r.app, null);
  assert.ok(r.candidates.length > 1, "several apps contain an l");
  assert.match(r.error, /matches \d+ apps/);
});

test("cli/match: an exact id is never ambiguous, even as a prefix of others", () => {
  const apps = [fx.app({ id: "nx", name: "NX" }), fx.app({ id: "nx-hub", name: "NX Hub" })];
  assert.equal(matchApp(apps, "nx").app.id, "nx");
});

test("cli/match: unknown app", () => {
  const r = matchApp(APPS, "definitely-not-here");
  assert.equal(r.app, null);
  assert.deepEqual(r.candidates, []);
  assert.match(r.error, /No app matches/);
});

test("cli/match: no query at all", () => {
  assert.match(matchApp(APPS, "").error, /Name an app/);
});

/* ---------------------------------------------------------------- artifacts */

test("cli/match: a single installable artifact needs no naming", () => {
  const r = pickArtifact(fx.quadforge, null, { mode: "install", platform: "linux" });
  assert.equal(r.artifact.id, "blender-addon-linux");
});

test("cli/match: several installable artifacts must be named", () => {
  const r = pickArtifact(fx.wivrn, null, { mode: "install", platform: "linux" });
  assert.equal(r.artifact, null);
  assert.equal(r.candidates.length, 2);
  assert.match(r.error, /2 downloads/);
});

test("cli/match: windows artifacts are not installable from linux", () => {
  const r = pickArtifact(fx.limbo, null, { mode: "install", platform: "linux" });
  assert.equal(r.artifact.id, "archive-dir-linux", "the windows build is filtered out, so one remains");
});

test("cli/match: android counts as installable from any desktop (adb sideload)", () => {
  const apk = fx.app({ artifacts: [fx.artifact({ id: "apk-adb-android", platform: "android", kind: "apk-adb" })] });
  assert.equal(pickArtifact(apk, null, { mode: "install", platform: "linux" }).artifact.id, "apk-adb-android");
  assert.equal(pickArtifact(apk, null, { mode: "install", platform: "win32" }).artifact.id, "apk-adb-android");
});

test("cli/match: artifact by id, label or prefix", () => {
  assert.equal(pickArtifact(fx.wivrn, "apk-adb-android", {}).artifact.id, "apk-adb-android");
  assert.equal(pickArtifact(fx.wivrn, "Headset APK", {}).artifact.id, "apk-adb-android");
  assert.equal(pickArtifact(fx.wivrn, "tarball", {}).artifact.id, "tarball-prefix-linux");
});

test("cli/match: an unknown artifact lists what exists", () => {
  const r = pickArtifact(fx.wivrn, "nope", {});
  assert.equal(r.artifact, null);
  assert.equal(r.candidates.length, 2);
  assert.match(r.error, /no download called "nope"/);
});

test("cli/match: modes filter by state", () => {
  // only the APK is installed
  assert.equal(pickArtifact(fx.wivrn, null, { mode: "installed" }).artifact.id, "apk-adb-android");
  // …and only it has an update
  assert.equal(pickArtifact(fx.wivrn, null, { mode: "update" }).artifact.id, "apk-adb-android");
  // nothing of limbo is installed
  const none = pickArtifact(fx.limbo, null, { mode: "installed" });
  assert.equal(none.artifact, null);
  assert.match(none.error, /is not installed/);
  // quadforge keeps a .prev
  assert.equal(pickArtifact(fx.quadforge, null, { mode: "rollback" }).artifact.id, "blender-addon-linux");
  // …but is not launchable (blender addon)
  assert.match(pickArtifact(fx.quadforge, null, { mode: "launch" }).error, /nothing installed to launch/);
});

test("cli/match: hostPlatform maps win32 → windows, everything else → linux", () => {
  assert.equal(hostPlatform("win32"), "windows");
  assert.equal(hostPlatform("linux"), "linux");
  assert.equal(hostPlatform("darwin"), "linux");
});
