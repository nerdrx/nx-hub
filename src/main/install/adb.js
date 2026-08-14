"use strict";
// Low-level adb helpers: device detection, package version probing, install /
// uninstall / launch. Nothing here ever throws for "adb is not installed" — the
// hub must render fine on a machine with no Android tooling at all.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { run, expandUser } = require("./util");

const DEFAULT_TIMEOUT = 30000;

function adbBin(ctx) {
  const p = ctx?.settings?.adbPath;
  return p && String(p).trim() ? expandUser(String(p).trim()) : "adb";
}

async function adb(ctx, args, opts = {}) {
  const res = await run(adbBin(ctx), args, {
    signal: ctx?.signal,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
  });
  return res;
}

/**
 * Parse `adb devices -l` output.
 *   List of devices attached
 *   1WMHH8xxxxx  device product:phhgsi_arm64_ab model:Pico_4 device:generic
 *   emulator-5554  offline
 */
function parseDevices(stdout) {
  const out = [];
  for (const rawLine of String(stdout || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^list of devices/i.test(line)) continue;
    if (/^\*/.test(line)) continue; // "* daemon started successfully *"
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    if (!/^(device|offline|unauthorized|bootloader|recovery|sideload|host|no permissions.*)$/i.test(state)) {
      continue;
    }
    let model = null;
    for (const kv of parts.slice(2)) {
      const m = kv.match(/^model:(.+)$/);
      if (m) model = m[1].replace(/_/g, " ");
    }
    out.push({ serial, state, model: model || null });
  }
  return out;
}

async function listDevices(ctx) {
  const res = await adb(ctx, ["devices", "-l"], { timeout: 15000 });
  if (res.missing) return { available: false, devices: [] };
  if (res.code !== 0) {
    ctx?.log?.(`adb devices failed: ${(res.stderr || "").trim()}`);
    return { available: true, devices: [] };
  }
  return { available: true, devices: parseDevices(res.stdout) };
}

/** First device that is actually usable (state === "device"). */
function firstOnline(devices) {
  return (devices || []).find((d) => d.state === "device") || null;
}

/** `dumpsys package <pkg>` → versionName, or null when not installed. */
function parseVersionName(stdout) {
  const m = String(stdout || "").match(/versionName=([^\s]+)/);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v === "null") return null;
  return v;
}

async function getPackageVersion(ctx, serial, packageId) {
  const res = await adb(ctx, ["-s", serial, "shell", "dumpsys", "package", packageId], {
    timeout: 20000,
  });
  if (res.missing || res.code !== 0) return null;
  return parseVersionName(res.stdout);
}

/** Every packageId the bundled overlay knows about. */
async function overridePackageIds() {
  const candidates = [
    process.env.NX_HUB_OVERRIDES_PATH,
    path.resolve(__dirname, "..", "..", "..", "registry", "overrides.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const json = JSON.parse(await fsp.readFile(file, "utf8"));
      const ids = new Set();
      for (const appCfg of Object.values(json.apps || {})) {
        for (const art of appCfg.artifacts || []) {
          if (art.packageId) ids.add(art.packageId);
        }
      }
      return [...ids];
    } catch {
      /* try next */
    }
  }
  return [];
}

/**
 * {available, devices:[{serial,model,state}], apkVersions:{<pkgId>:<versionName>}}
 * Never throws.
 */
async function getAdbStatus(ctx) {
  try {
    const { available, devices } = await listDevices(ctx);
    const apkVersions = {};
    const online = firstOnline(devices);
    if (available && online) {
      const ids = await overridePackageIds();
      for (const pkg of ids) {
        try {
          const v = await getPackageVersion(ctx, online.serial, pkg);
          if (v) apkVersions[pkg] = v;
        } catch {
          /* per-package failure must not kill the whole status */
        }
      }
    }
    return { available, devices, apkVersions };
  } catch (err) {
    ctx?.log?.(`adb status failed: ${err.message}`);
    return { available: false, devices: [], apkVersions: {} };
  }
}

const NO_DEVICE_MSG =
  "No Android device connected — plug in the headset over USB, enable USB debugging and accept the \"Allow USB debugging\" prompt";

/** Resolve the device to act on, with a friendly error when there is none. */
async function requireDevice(ctx) {
  const { available, devices } = await listDevices(ctx);
  if (!available) {
    throw new Error(
      "adb not found — install android-tools (or set the adb path in Settings) to install APKs"
    );
  }
  const online = firstOnline(devices);
  if (!online) {
    const unauth = devices.find((d) => d.state === "unauthorized");
    if (unauth) {
      throw new Error(
        `Device ${unauth.serial} is unauthorized — accept the "Allow USB debugging" prompt on the headset`
      );
    }
    throw new Error(NO_DEVICE_MSG);
  }
  return online;
}

async function installApk(ctx, serial, filePath) {
  const res = await adb(ctx, ["-s", serial, "install", "-r", filePath], {
    timeout: 15 * 60 * 1000,
  });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  if (res.missing) throw new Error("adb not found — cannot install the APK");
  if (/^\s*Success\s*$/m.test(out) || /\bSuccess\b/.test(out)) return true;
  const fail = out.match(/Failure\s*\[([^\]]+)\]/);
  if (fail) throw new Error(`APK install failed: ${friendlyFailure(fail[1])}`);
  const detail = out.trim().split("\n").filter(Boolean).slice(-2).join(" ");
  throw new Error(`APK install failed${detail ? `: ${detail}` : ""}`);
}

function friendlyFailure(code) {
  const map = {
    INSTALL_FAILED_UPDATE_INCOMPATIBLE:
      "signature mismatch — uninstall the existing app on the headset first",
    INSTALL_FAILED_VERSION_DOWNGRADE: "the device has a newer version installed",
    INSTALL_FAILED_INSUFFICIENT_STORAGE: "not enough storage on the device",
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: "the APK is not signed",
  };
  for (const [k, v] of Object.entries(map)) if (code.includes(k)) return `${v} (${k})`;
  return code;
}

async function uninstallPackage(ctx, serial, packageId) {
  const res = await adb(ctx, ["-s", serial, "uninstall", packageId], { timeout: 120000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  return /Success/.test(out);
}

async function launchPackage(ctx, serial, packageId) {
  const res = await adb(
    ctx,
    ["-s", serial, "shell", "monkey", "-p", packageId, "-c", "android.intent.category.LAUNCHER", "1"],
    { timeout: 30000 }
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  if (res.missing) throw new Error("adb not found — cannot launch on the device");
  if (res.code !== 0 || /No activities found|Error:/.test(out)) {
    throw new Error(
      `Could not launch ${packageId} on the device${out.trim() ? `: ${out.trim().split("\n").slice(-1)[0]}` : ""}`
    );
  }
  return true;
}

module.exports = {
  adbBin,
  adb,
  parseDevices,
  listDevices,
  firstOnline,
  parseVersionName,
  getPackageVersion,
  overridePackageIds,
  getAdbStatus,
  requireDevice,
  installApk,
  uninstallPackage,
  launchPackage,
  NO_DEVICE_MSG,
};
