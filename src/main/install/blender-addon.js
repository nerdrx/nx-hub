"use strict";
// kind: "blender-addon" (overlay-only) — unzip into Blender's addons dir.
// No desktop entry, nothing to launch: Blender owns the runtime.

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  installDirFor, expandUser, exists, mkdirp, rmrf, extractArchive, walkFiles,
  withWorkDir, stagedInstall, writeManifest, readManifest, throwIfAborted,
} = require("./util");
const { standardUninstall } = require("./common");

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);
  const addonsDir = expandUser(
    artifact.addonsDir || "~/.config/blender/scripts/addons"
  );

  ctx.emitProgress("verify", 5, "Checking addon zip");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);
  if (!/\.zip$/i.test(filePath) && !/\.zip$/i.test(artifact.assetName || "")) {
    ctx.log("blender-addon: asset is not a .zip — extracting anyway");
  }

  const prevManifest = await readManifest(installDir);
  const installedTops = [];

  await withWorkDir(installDir, async (work) => {
    throwIfAborted(ctx);
    ctx.emitProgress("extract", 20, "Extracting addon");
    await extractArchive(filePath, work, ctx);

    const tops = await fsp.readdir(work, { withFileTypes: true });
    if (tops.length === 0) throw new Error("Addon archive is empty");

    // A well-formed Blender addon zip has one top-level package folder. A
    // single loose .py file is also valid (legacy single-file addons).
    ctx.emitProgress("install", 55, `Installing into ${addonsDir}`);
    await mkdirp(addonsDir);

    for (const t of tops) {
      throwIfAborted(ctx);
      const src = path.join(work, t.name);
      const dst = path.join(addonsDir, t.name);
      if (t.isDirectory()) {
        await rmrf(dst); // replace an older copy of the same addon folder
        await fsp.cp(src, dst, { recursive: true });
      } else if (t.isFile()) {
        await fsp.copyFile(src, dst);
      } else {
        continue;
      }
      installedTops.push(dst);
    }
    const fileCount = (await walkFiles(work)).length;
    ctx.log(`blender-addon: installed ${installedTops.length} top-level item(s), ${fileCount} files`);
  });

  // clean up folders from a previous version that this release dropped
  if (prevManifest && Array.isArray(prevManifest.files)) {
    const keep = new Set(installedTops);
    for (const old of prevManifest.files) {
      if (!keep.has(old)) await rmrf(old).catch(() => {});
    }
  }

  ctx.emitProgress("cleanup", 92, "Writing manifest");
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "blender-addon",
      files: installedTops, // the addon folder(s) we created — removed on uninstall
      dirs: [],
      desktopEntries: [],
      binary: null,
      extra: { addonsDir },
    });
  });

  ctx.emitProgress("cleanup", 100, "Installed");
  return { version: artifact.version, path: installDir, launchable: false };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch() {
  throw new Error("Blender addons are used from inside Blender — nothing to launch");
}

module.exports = { install, uninstall, launch };
