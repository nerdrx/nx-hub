"use strict";
// kind: "apk-adb" — sideload an APK onto a connected headset/phone.
// Nothing lands on this machine except a small state dir holding the manifest;
// the real "installed version" is read live from the device (see adb.js).

const path = require("node:path");
const {
  installDirFor, exists, stagedInstall, writeManifest, readManifest, throwIfAborted,
} = require("./util");
const { standardUninstall } = require("./common");
const adb = require("./adb");

function packageIdOf(artifact, manifest) {
  return artifact?.packageId || manifest?.packageId || null;
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);

  ctx.emitProgress("verify", 5, "Looking for a connected device");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);
  const device = await adb.requireDevice(ctx);
  ctx.log(`adb: installing onto ${device.model || device.serial} (${device.serial})`);

  throwIfAborted(ctx);
  ctx.emitProgress("install", 30, `Installing APK on ${device.model || device.serial}`);
  await adb.installApk(ctx, device.serial, path.resolve(filePath));

  ctx.emitProgress("install", 85, "Reading installed version from device");
  const packageId = packageIdOf(artifact, null);
  let deviceVersion = null;
  if (packageId) {
    deviceVersion = await adb.getPackageVersion(ctx, device.serial, packageId).catch(() => null);
  }

  ctx.emitProgress("cleanup", 95, "Writing manifest");
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "apk-adb",
      files: [],
      dirs: [],
      desktopEntries: [],
      binary: null,
      extra: {
        packageId,
        deviceSerial: device.serial,
        deviceModel: device.model,
        deviceVersion,
      },
    });
  });

  ctx.emitProgress("cleanup", 100, "Installed on device");
  return { version: artifact.version, path: installDir, launchable: Boolean(packageId) };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const packageId = packageIdOf(artifact, manifest);

  ctx.emitProgress("cleanup", 10, "Looking for the device");
  const { available, devices } = await adb.listDevices(ctx);
  const online = adb.firstOnline(devices);
  if (available && online && packageId) {
    ctx.emitProgress("cleanup", 40, `Removing ${packageId} from ${online.model || online.serial}`);
    const ok = await adb.uninstallPackage(ctx, online.serial, packageId);
    ctx.log(
      ok
        ? `adb: uninstalled ${packageId} from ${online.serial}`
        : `adb: could not uninstall ${packageId} (already gone?) — clearing local state anyway`
    );
  } else {
    // No device: we cannot touch the headset, but the hub must still be able to
    // forget the install. Core clears its state from our normal return.
    ctx.log("adb: no device connected — clearing local state only");
  }
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const packageId = packageIdOf(artifact, manifest);
  if (!packageId) throw new Error("No packageId configured for this artifact — cannot launch it");
  const device = await adb.requireDevice(ctx);
  ctx.log(`adb: launching ${packageId} on ${device.serial}`);
  await adb.launchPackage(ctx, device.serial, packageId);
  return { command: `monkey -p ${packageId}`, device: device.serial };
}

module.exports = { install, uninstall, launch };
