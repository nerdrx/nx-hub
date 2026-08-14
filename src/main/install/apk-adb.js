"use strict";
// kind: "apk-adb" — sideload an APK onto a connected headset/phone.
// Nothing lands on this machine except a small state dir holding the manifest;
// the real "installed version" is read live from the device (see adb.js).

const path = require("node:path");
const fsp = require("node:fs/promises");
const {
  installDirFor, exists, stagedInstall, writeManifest, readManifest, throwIfAborted, run,
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

  ctx.emitProgress("cleanup", 92, "Extracting app icon");
  const iconPath = await extractApkIcon(ctx, filePath, packageId || app.id).catch(() => null);

  ctx.emitProgress("cleanup", 95, "Writing manifest");
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "apk-adb",
      files: iconPath ? [iconPath] : [],
      dirs: [],
      desktopEntries: [],
      binary: null,
      extra: {
        packageId,
        deviceSerial: device.serial,
        deviceModel: device.model,
        deviceVersion,
        icon: iconPath,
      },
    });
  });

  ctx.emitProgress("cleanup", 100, "Installed on device");
  return { version: artifact.version, path: installDir, launchable: Boolean(packageId), iconPath };
}

/**
 * Best-effort launcher-icon extraction from the APK itself, saved to
 * <dataDir>/icons/<packageId>.<ext>. Modern release APKs mangle resource
 * names, so `aapt dump badging` is the reliable route when aapt exists
 * (settings.aaptPath, PATH, or $ANDROID_HOME/build-tools). Fallback: classic
 * ic_launcher paths in the zip listing. Vector-only APKs yield null — the UI
 * renders its monogram tile then, which is the right look.
 */
async function extractApkIcon(ctx, apkPath, iconKey) {
  let entry = null;

  const aapt = await findAapt(ctx);
  if (aapt) {
    const res = await run(aapt, ["dump", "badging", apkPath], { timeout: 30000 });
    if (res.code === 0) {
      const best = [...String(res.stdout).matchAll(/application-icon-(\d+):'([^']+)'/g)]
        .map((m) => ({ density: Number(m[1]), file: m[2] }))
        .sort((a, b) => b.density - a.density)
        .find((c) => /\.(png|webp)$/i.test(c.file));
      if (best) entry = best.file;
    }
  }

  if (!entry) {
    const list = await run("unzip", ["-Z1", apkPath], { timeout: 30000 });
    if (list.code === 0) {
      const candidates = String(list.stdout)
        .split("\n")
        .filter((l) => /^res\/(mipmap|drawable)[^/]*\/ic_launcher[^/]*\.(png|webp)$/i.test(l.trim()))
        .map((l) => l.trim());
      const rank = (p) => {
        const m = /-(x{0,3}h|m|l)dpi/.exec(p);
        return m ? { xxxh: 5, xxh: 4, xh: 3, h: 2, m: 1, l: 0 }[m[1]] ?? 0 : 0;
      };
      candidates.sort((a, b) => rank(b) - rank(a));
      entry = candidates[0] || null;
    }
  }
  if (!entry) return null;

  const ext = /\.webp$/i.test(entry) ? "webp" : "png";
  const iconsDir = path.join(ctx.dataDir, "icons");
  const work = path.join(iconsDir, ".extract-tmp");
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  // -j junks the res/... path; binary-safe (run() pipes text, so no `unzip -p`)
  const out = await run("unzip", ["-o", "-j", apkPath, entry, "-d", work], { timeout: 30000 });
  const extracted = path.join(work, path.basename(entry));
  if (out.code !== 0 || !(await exists(extracted))) {
    await fsp.rm(work, { recursive: true, force: true });
    return null;
  }
  const dest = path.join(iconsDir, `${String(iconKey).replace(/[^\w.-]+/g, "_")}.${ext}`);
  await fsp.rename(extracted, dest);
  await fsp.rm(work, { recursive: true, force: true });
  ctx.log(`apk icon extracted: ${entry} → ${dest}`);
  return dest;
}

async function findAapt(ctx) {
  const candidates = [];
  if (ctx.settings && ctx.settings.aaptPath) candidates.push(ctx.settings.aaptPath);
  candidates.push("aapt");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const bt = path.join(sdk, "build-tools");
    const versions = await fsp.readdir(bt).catch(() => []);
    for (const v of versions.sort().reverse()) candidates.push(path.join(bt, v, "aapt"));
  }
  for (const c of candidates) {
    const res = await run(c, ["version"], { timeout: 5000 }).catch(() => ({ code: -1 }));
    if (res.code === 0 || (res.stdout || res.stderr || "").includes("Android Asset")) return c;
  }
  return null;
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const packageId = packageIdOf(artifact, manifest);

  ctx.emitProgress("cleanup", 10, "Looking for the device");
  const { available, devices } = await adb.listDevices(ctx);
  const online = adb.selectDevice(devices, ctx); // v0.2: preferred serial wins
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

module.exports = { install, uninstall, launch, extractApkIcon };
