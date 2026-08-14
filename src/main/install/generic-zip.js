"use strict";
// kind: "generic-zip" — download-only. We don't know how to install it, so we
// just park the asset in <installRoot>/nx/downloads/ and tell the user where it
// is (UI shows "Show in folder"). No desktop entry, nothing launchable.

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  installDirFor, mkdirp, exists, stagedInstall, writeManifest, readManifest,
} = require("./util");
const { standardUninstall } = require("./common");

function downloadsDir(ctx) {
  return path.join(ctx.installRoot, "nx", "downloads");
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);
  const assetName = artifact.assetName || path.basename(filePath);

  ctx.emitProgress("verify", 10, "Checking download");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);

  const dir = downloadsDir(ctx);
  await mkdirp(dir);
  const dest = path.join(dir, assetName);

  ctx.emitProgress("install", 50, `Saving ${assetName}`);
  const tmp = `${dest}.part-${process.pid}`;
  await fsp.copyFile(filePath, tmp);
  await fsp.rename(tmp, dest); // same dir → atomic
  ctx.log(`generic-zip: saved to ${dest}`);

  ctx.emitProgress("cleanup", 90, "Writing manifest");
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "generic-zip",
      files: [dest], // lives outside the install dir → recorded for uninstall
      dirs: [],
      desktopEntries: [],
      binary: null,
      extra: { downloadPath: dest, assetName },
    });
  });

  ctx.emitProgress("cleanup", 100, `Saved to ${dest}`);
  return { version: artifact.version, path: installDir, launchable: false, downloadPath: dest };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const where = manifest?.downloadPath || downloadsDir(ctx);
  throw new Error(`This asset is download-only — it was saved to ${where}`);
}

module.exports = { install, uninstall, launch, downloadsDir };
