"use strict";
// NX Hub install engine — the single entry point core/jobs talks to.
//
//   install({app, artifact, filePath, ctx})   → {version, path, launchable}
//   uninstall({app, artifact, installedPath, ctx})
//   launch({app, artifact, installedPath, ctx})
//   getAdbStatus(ctx) → {available, devices:[{serial,model,state}], apkVersions:{}}
//
// ctx = {dataDir, installRoot, settings, log(msg), emitProgress(phase,pct,message), signal}
// Phases emitted here: "verify" | "extract" | "install" | "cleanup"
// (the "download" phase belongs to core — filePath is already on disk).

const util = require("./util");
const { normCtx, installDirFor, readManifest } = util;
const adb = require("./adb");
const desktop = require("./desktop");

const appimage = require("./appimage");
const archiveDir = require("./archive-dir");
const tarballPrefix = require("./tarball-prefix");
const apkAdb = require("./apk-adb");
const blenderAddon = require("./blender-addon");
const genericZip = require("./generic-zip");
const windows = require("./windows");

const KINDS = {
  appimage,
  "archive-dir": archiveDir,
  "tarball-prefix": tarballPrefix,
  "apk-adb": apkAdb,
  "blender-addon": blenderAddon,
  "generic-zip": genericZip,
  "windows-portable": windows,
  "windows-zip": windows,
};

function moduleFor(artifact) {
  const kind = artifact && artifact.kind;
  const mod = KINDS[kind];
  if (!mod) {
    throw new Error(`Unknown install kind "${kind}" — nothing to do for this asset`);
  }
  return mod;
}

function describe(app, artifact) {
  return `${app?.id || "?"}/${artifact?.id || "?"} (${artifact?.kind || "?"})`;
}

async function install({ app, artifact, filePath, ctx }) {
  const c = normCtx(ctx);
  const mod = moduleFor(artifact);
  c.log(`install ${describe(app, artifact)} from ${filePath}`);
  const started = Date.now();
  const result = await mod.install({ app, artifact, filePath, ctx: c });
  c.log(`install ${describe(app, artifact)} done in ${Date.now() - started}ms → ${result.path}`);
  return {
    version: result.version ?? artifact.version ?? null,
    path: result.path,
    launchable: Boolean(result.launchable),
    ...(result.downloadPath ? { downloadPath: result.downloadPath } : {}),
  };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const c = normCtx(ctx);
  // Prefer the kind recorded in the manifest: an artifact may have been
  // reclassified by an overlay update since it was installed.
  const dir = installedPath || installDirFor(app, artifact, c);
  const manifest = await readManifest(dir);
  const effective = manifest?.kind && KINDS[manifest.kind] ? { ...artifact, kind: manifest.kind } : artifact;
  const mod = moduleFor(effective);
  c.log(`uninstall ${describe(app, effective)} at ${dir}`);
  return mod.uninstall({ app, artifact: effective, installedPath: dir, ctx: c });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const c = normCtx(ctx);
  const dir = installedPath || installDirFor(app, artifact, c);
  const manifest = await readManifest(dir);
  const effective = manifest?.kind && KINDS[manifest.kind] ? { ...artifact, kind: manifest.kind } : artifact;
  const mod = moduleFor(effective);
  if (typeof mod.launch !== "function") {
    throw new Error(`"${effective.kind}" artifacts cannot be launched`);
  }
  c.log(`launch ${describe(app, effective)}`);
  return mod.launch({ app, artifact: effective, installedPath: dir, ctx: c });
}

/**
 * SPEC v0.2: restore the `<installdir>.prev` copy the last install kept.
 * Only dir-based kinds support it; everything else refuses with a clear message.
 */
async function rollback({ app, artifact, installedPath, ctx }) {
  const c = normCtx(ctx);
  const dir = installedPath || installDirFor(app, artifact, c);
  const manifest = await readManifest(dir);
  const effective = manifest?.kind && KINDS[manifest.kind] ? { ...artifact, kind: manifest.kind } : artifact;
  const mod = moduleFor(effective);
  if (typeof mod.rollback !== "function") {
    throw new Error(`"${effective.kind}" installs cannot be rolled back`);
  }
  c.log(`rollback ${describe(app, effective)} at ${dir}`);
  return mod.rollback({ app, artifact: effective, installedPath: dir, ctx: c });
}

/** Does this kind keep a previous version at all? (core/UI ask before offering it) */
function canRollback(kind) {
  const mod = KINDS[kind];
  return Boolean(mod && typeof mod.rollback === "function");
}

/** Never throws — a machine without adb still gets a valid status object. */
async function getAdbStatus(ctx) {
  return adb.getAdbStatus(normCtx(ctx));
}

/** SPEC v0.2: `adb connect <host:port>`. Throws a friendly error on failure. */
async function adbConnect(ctx, hostPort) {
  return adb.adbConnect(normCtx(ctx), hostPort);
}

/** SPEC v0.2: {serial, model, batteryPct, storageFreeBytes}. Never throws. */
async function getDeviceInfo(ctx, serial) {
  return adb.getDeviceInfo(normCtx(ctx), serial);
}

module.exports = {
  install,
  uninstall,
  launch,
  rollback,
  getAdbStatus,
  adbConnect,
  getDeviceInfo,
  // ---- extras (not part of the frozen four, handy for core/tests) ----
  canRollback,
  KINDS: Object.keys(KINDS),
  installDirFor: (app, artifact, ctx) => installDirFor(app, artifact, normCtx(ctx)),
  readManifest,
  supports: (kind) => Object.prototype.hasOwnProperty.call(KINDS, kind),
  desktopFilePath: desktop.desktopFilePath,
  util,
};
