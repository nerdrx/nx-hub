"use strict";
// No real adb is ever invoked: every test installs a fake `adb` shell script
// into the sandbox and points settings.adbPath at it.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const adbMod = require("../../src/main/install/adb");
const H = require("./helpers");

const app = { id: "wivrn-nx", name: "WiVRn NX", tagline: "Streaming", repo: "nerdrx/wivrn-nx" };
const artifact = {
  id: "apk-adb-android",
  label: "Pico headset APK",
  kind: "apk-adb",
  platform: "android",
  packageId: "org.meumeu.wivrn.nx",
  assetName: "wivrn-nx-release-1.2.0.apk",
  version: "1.2.0",
};

const DEVICES = H.DEVICES_OUTPUT;
const DUMPSYS = H.dumpsysOutput("org.meumeu.wivrn.nx", "1.2.0");

/**
 * Fake adb: online Pico + offline emulator + unauthorized phone.
 * `extra` cases are matched FIRST so a test can override one behaviour.
 */
function happyAdb(extra = "") {
  return `
case "$*" in
${extra}
  "devices -l")
    cat <<'DEVEOF'
${DEVICES}DEVEOF
    ;;
  *"shell dumpsys package org.meumeu.wivrn.nx")
    cat <<'DUMPEOF'
${DUMPSYS}DUMPEOF
    ;;
  *"shell dumpsys package "*)
    echo "  Unable to find package: unknown"
    ;;
  *"install -r "*)
    echo "Performing Streamed Install"
    echo "Success"
    ;;
  *"uninstall "*)
    echo "Success"
    ;;
  *"shell monkey -p "*)
    echo "Events injected: 1"
    ;;
  *)
    echo "unknown adb command: $*" >&2
    exit 1
    ;;
esac
exit 0
`;
}

async function ctxWithAdb(box, body) {
  const fake = await H.writeFakeAdb(box, body);
  const ctx = H.makeCtx(box, { settings: { adbPath: fake.path } });
  return { ctx, fake };
}

test("adb: parses `adb devices -l` into serial/state/model", () => {
  const devices = adbMod.parseDevices(DEVICES);
  assert.deepStrictEqual(devices, [
    { serial: "1WMHH8K1234567", state: "device", model: "Pico 4" },
    { serial: "emulator-5554", state: "offline", model: null },
    { serial: "9ABCD", state: "unauthorized", model: null },
  ]);
  assert.strictEqual(adbMod.firstOnline(devices).serial, "1WMHH8K1234567");
  assert.deepStrictEqual(adbMod.parseDevices(""), []);
  assert.deepStrictEqual(adbMod.parseDevices("List of devices attached\n\n"), []);
});

test("adb: parses versionName out of dumpsys", () => {
  assert.strictEqual(adbMod.parseVersionName(DUMPSYS), "1.2.0");
  assert.strictEqual(adbMod.parseVersionName("versionName=null"), null);
  assert.strictEqual(adbMod.parseVersionName("Unable to find package: x"), null);
});

test("getAdbStatus: devices + live apk versions for every overlay packageId", async (t) => {
  const box = await H.makeSandbox("adb-status");
  t.after(() => H.cleanup(box));
  const { ctx, fake } = await ctxWithAdb(box, happyAdb());

  const status = await engine.getAdbStatus(ctx);

  assert.strictEqual(status.available, true);
  assert.strictEqual(status.devices.length, 3);
  assert.deepStrictEqual(status.devices[0], {
    serial: "1WMHH8K1234567",
    state: "device",
    model: "Pico 4",
  });
  assert.deepStrictEqual(status.apkVersions, { "org.meumeu.wivrn.nx": "1.2.0" });

  // package ids come from the bundled overlay, and only the online device is probed
  const calls = fake.calls();
  assert.ok(calls.includes("devices -l"));
  assert.ok(
    calls.some((c) => c === "-s 1WMHH8K1234567 shell dumpsys package org.meumeu.wivrn.nx"),
    calls.join(" | ")
  );
  assert.ok(
    calls.some((c) => c.includes("dumpsys package com.pulsenx.bridge")),
    "probes every packageId in registry/overrides.json"
  );
  assert.ok(!calls.some((c) => c.includes("emulator-5554")), "offline devices are not probed");
});

test("getAdbStatus: missing adb binary reports unavailable instead of throwing", async (t) => {
  const box = await H.makeSandbox("adb-missing");
  t.after(() => H.cleanup(box));
  const ctx = H.makeCtx(box, {
    settings: { adbPath: path.join(box.bin, "definitely-not-adb") },
  });
  const status = await engine.getAdbStatus(ctx);
  // v0.2 adds `selected` (the device the hub would act on)
  assert.deepStrictEqual(status, { available: false, devices: [], apkVersions: {}, selected: null });
});

test("getAdbStatus: adb present but no device → available, empty versions", async (t) => {
  const box = await H.makeSandbox("adb-nodevice");
  t.after(() => H.cleanup(box));
  const { ctx } = await ctxWithAdb(
    box,
    `
case "$*" in
  "devices -l") echo "List of devices attached"; echo "";;
  *) exit 1;;
esac
exit 0
`
  );
  const status = await engine.getAdbStatus(ctx);
  assert.strictEqual(status.available, true);
  assert.deepStrictEqual(status.devices, []);
  assert.deepStrictEqual(status.apkVersions, {});
});

test("apk-adb: install pushes the APK to the first online device and records state", async (t) => {
  const box = await H.makeSandbox("adb-install");
  t.after(() => H.cleanup(box));
  const { ctx, fake } = await ctxWithAdb(box, happyAdb());

  const apk = path.join(box.downloads, artifact.assetName);
  await fsp.writeFile(apk, "PKfake apk");

  const res = await engine.install({ app, artifact, filePath: apk, ctx });

  const installDir = path.join(box.installRoot, "nx", "wivrn-nx", "apk-adb-android");
  assert.strictEqual(res.path, installDir);
  assert.strictEqual(res.version, "1.2.0");
  assert.strictEqual(res.launchable, true);

  const calls = fake.calls();
  assert.ok(
    calls.some((c) => c === `-s 1WMHH8K1234567 install -r ${path.resolve(apk)}`),
    `install call: ${calls.join(" | ")}`
  );

  const m = H.readManifestSync(installDir);
  assert.strictEqual(m.kind, "apk-adb");
  assert.strictEqual(m.packageId, "org.meumeu.wivrn.nx");
  assert.strictEqual(m.deviceSerial, "1WMHH8K1234567");
  assert.strictEqual(m.deviceModel, "Pico 4");
  assert.strictEqual(m.deviceVersion, "1.2.0", "version read back off the device");
  assert.deepStrictEqual(m.files, []);
  assert.deepStrictEqual(m.desktopEntries, [], "no desktop entry for an on-device app");
});

test("apk-adb: no device → friendly error, nothing written", async (t) => {
  const box = await H.makeSandbox("adb-nodev-install");
  t.after(() => H.cleanup(box));
  const { ctx } = await ctxWithAdb(
    box,
    `
case "$*" in
  "devices -l") echo "List of devices attached";;
  *) exit 1;;
esac
exit 0
`
  );
  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");

  await assert.rejects(
    () => engine.install({ app, artifact, filePath: apk, ctx }),
    /No Android device connected/
  );
  assert.strictEqual(
    await H.exists(path.join(box.installRoot, "nx", "wivrn-nx", "apk-adb-android")),
    false
  );
});

test("apk-adb: unauthorized device gets its own hint", async (t) => {
  const box = await H.makeSandbox("adb-unauth");
  t.after(() => H.cleanup(box));
  const { ctx } = await ctxWithAdb(
    box,
    `
case "$*" in
  "devices -l") printf 'List of devices attached\\n9ABCD\\tunauthorized\\n';;
  *) exit 1;;
esac
exit 0
`
  );
  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");
  await assert.rejects(
    () => engine.install({ app, artifact, filePath: apk, ctx }),
    /unauthorized — accept the "Allow USB debugging" prompt/
  );
});

test("apk-adb: install Failure is surfaced with the parsed reason", async (t) => {
  const box = await H.makeSandbox("adb-fail");
  t.after(() => H.cleanup(box));
  const { ctx } = await ctxWithAdb(
    box,
    `
case "$*" in
  "devices -l")
    cat <<'DEVEOF'
${DEVICES}DEVEOF
    ;;
  *"install -r "*)
    echo "Performing Streamed Install"
    echo "adb: failed to install /tmp/x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]"
    exit 1
    ;;
  *) exit 1;;
esac
exit 0
`
  );
  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");

  await assert.rejects(
    () => engine.install({ app, artifact, filePath: apk, ctx }),
    /signature mismatch.*INSTALL_FAILED_UPDATE_INCOMPATIBLE/s
  );
  assert.strictEqual(
    await H.exists(path.join(box.installRoot, "nx", "wivrn-nx", "apk-adb-android")),
    false,
    "failed install writes no manifest"
  );
});

test("apk-adb: launch uses monkey with the LAUNCHER category", async (t) => {
  const box = await H.makeSandbox("adb-launch");
  t.after(() => H.cleanup(box));
  const { ctx, fake } = await ctxWithAdb(box, happyAdb());

  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");
  const res = await engine.install({ app, artifact, filePath: apk, ctx });

  await engine.launch({ app, artifact, installedPath: res.path, ctx });
  assert.ok(
    fake
      .calls()
      .some(
        (c) =>
          c ===
          "-s 1WMHH8K1234567 shell monkey -p org.meumeu.wivrn.nx -c android.intent.category.LAUNCHER 1"
      ),
    fake.calls().join(" | ")
  );
});

test("apk-adb: launch with no activity reports a useful error", async (t) => {
  const box = await H.makeSandbox("adb-launch-fail");
  t.after(() => H.cleanup(box));
  const { ctx } = await ctxWithAdb(
    box,
    happyAdb(`  *"shell monkey -p "*)
    echo "** No activities found to run, monkey aborted."
    exit 1
    ;;`)
  );
  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");
  const res = await engine.install({ app, artifact, filePath: apk, ctx });
  await assert.rejects(
    () => engine.launch({ app, artifact, installedPath: res.path, ctx }),
    /Could not launch org\.meumeu\.wivrn\.nx/
  );
});

test("apk-adb: uninstall removes the package when a device is connected", async (t) => {
  const box = await H.makeSandbox("adb-uninstall");
  t.after(() => H.cleanup(box));
  const { ctx, fake } = await ctxWithAdb(box, happyAdb());

  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");
  const res = await engine.install({ app, artifact, filePath: apk, ctx });

  await engine.uninstall({ app, artifact, installedPath: res.path, ctx });

  assert.ok(
    fake.calls().some((c) => c === "-s 1WMHH8K1234567 uninstall org.meumeu.wivrn.nx"),
    fake.calls().join(" | ")
  );
  assert.strictEqual(await H.exists(res.path), false, "local state cleared");
});

test("apk-adb: uninstall without a device still clears local state", async (t) => {
  const box = await H.makeSandbox("adb-uninstall-nodev");
  t.after(() => H.cleanup(box));

  // install with a device present…
  const { ctx, fake } = await ctxWithAdb(box, happyAdb());
  const apk = path.join(box.downloads, "x.apk");
  await fsp.writeFile(apk, "apk");
  const res = await engine.install({ app, artifact, filePath: apk, ctx });

  // …then the headset is unplugged
  await fsp.writeFile(
    fake.path,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(fake.logFile)}
case "$*" in
  "devices -l") echo "List of devices attached";;
  *) echo "error: no devices/emulators found" >&2; exit 1;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  await fsp.chmod(fake.path, 0o755);

  await engine.uninstall({ app, artifact, installedPath: res.path, ctx });

  assert.strictEqual(await H.exists(res.path), false, "state cleared even with no device");
  assert.ok(
    ctx.logs.some((l) => /no device connected — clearing local state only/.test(l)),
    ctx.logs.join(" | ")
  );
  assert.ok(
    !fake.calls().some((c) => / uninstall org\.meumeu\.wivrn\.nx$/.test(c)),
    `no uninstall attempted offline: ${fake.calls().join(" | ")}`
  );
});

test("adb: overridePackageIds reads the bundled registry overlay", async () => {
  const ids = await adbMod.overridePackageIds();
  assert.ok(ids.includes("org.meumeu.wivrn.nx"), ids.join(","));
  assert.ok(ids.includes("com.pulsenx.bridge"), ids.join(","));
});
