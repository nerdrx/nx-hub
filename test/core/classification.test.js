"use strict";
// SPEC "Asset classification" — every rule in the table.

const test = require("node:test");
const assert = require("node:assert");

require("./helpers"); // sets quiet/no-gh env before config loads
const discovery = require("../../src/main/discovery");

function classify(name, others = []) {
  const all = [{ name }, ...others.map((n) => ({ name: n }))];
  return discovery.classifyAsset({ name }, all);
}

test("*.apk → android / apk-adb", () => {
  assert.deepStrictEqual(classify("wivrn-nx-release-1.4.0.apk"), {
    kind: "apk-adb",
    platform: "android",
    label: "Android APK",
  });
});

test("*.AppImage → linux / appimage (case insensitive)", () => {
  assert.strictEqual(classify("OGB-3.1.0-linux.AppImage").kind, "appimage");
  assert.strictEqual(classify("thing.appimage").platform, "linux");
});

test("*linux*.tar.gz → linux / archive-dir", () => {
  const c = classify("wivrn-nx-server-1.4.0-linux-x86_64.tar.gz");
  assert.strictEqual(c.kind, "archive-dir");
  assert.strictEqual(c.platform, "linux");
});

test("*.tgz → linux / archive-dir even without 'linux' in the name", () => {
  assert.strictEqual(classify("bundle-2.0.tgz").kind, "archive-dir");
});

test("*linux*.zip → linux / archive-dir", () => {
  assert.strictEqual(classify("limbo-linux.zip").kind, "archive-dir");
});

test("a tar.gz without 'linux' is not classified", () => {
  assert.strictEqual(classify("sources-1.0.tar.gz"), null);
});

test("*windows*.exe → windows / windows-portable", () => {
  const c = classify("OGB-3.1.0-windows-portable.exe");
  assert.strictEqual(c.kind, "windows-portable");
  assert.strictEqual(c.platform, "windows");
});

test("*setup*.exe is skipped when a portable exe is also published", () => {
  assert.strictEqual(classify("OGB-3.1.0-windows-setup.exe", ["OGB-3.1.0-windows-portable.exe"]), null);
});

test("*setup*.exe is kept when it is the only exe", () => {
  assert.strictEqual(classify("OGB-3.1.0-windows-setup.exe").kind, "windows-portable");
});

test("*windows*.zip → windows / windows-zip", () => {
  const c = classify("limbo-windows.zip");
  assert.strictEqual(c.kind, "windows-zip");
  assert.strictEqual(c.platform, "windows");
});

test("other *.zip → linux / generic-zip", () => {
  const c = classify("quadforge-1.3.zip");
  assert.strictEqual(c.kind, "generic-zip");
  assert.strictEqual(c.platform, "linux");
});

test("checksums, signatures and builder metadata are ignored", () => {
  for (const name of [
    "server.tar.gz.sha256",
    "app.AppImage.sig",
    "latest-linux.yml",
    "latest.yaml",
    "App-1.0.AppImage.blockmap",
    "hashes.md5",
  ]) {
    assert.strictEqual(classify(name), null, `${name} should be ignored`);
  }
});

test("unknown extensions are ignored", () => {
  assert.strictEqual(classify("notes.txt"), null);
  assert.strictEqual(classify("package.rpm"), null);
  assert.strictEqual(classify("package.deb"), null);
});

test("version parsing strips v / nx- prefixes", () => {
  assert.strictEqual(discovery.parseVersion("v1.2.3"), "1.2.3");
  assert.strictEqual(discovery.parseVersion("V2.0"), "2.0");
  assert.strictEqual(discovery.parseVersion("nx-1.3"), "1.3");
  assert.strictEqual(discovery.parseVersion("NX-1.3"), "1.3");
  assert.strictEqual(discovery.parseVersion("nx-v1.3"), "1.3");
  assert.strictEqual(discovery.parseVersion("1.0.0"), "1.0.0");
  assert.strictEqual(discovery.parseVersion("release-4.5"), "4.5");
  assert.strictEqual(discovery.parseVersion(null), null);
});

test("glob matching is case-insensitive and anchored", () => {
  assert.ok(discovery.globMatch("*windows*.zip", "Limbo-Windows-x64.zip"));
  assert.ok(discovery.globMatch("quadforge-*.zip", "quadforge-1.3.zip"));
  assert.ok(!discovery.globMatch("quadforge-*.zip", "other-quadforge-1.3.zip"));
});
