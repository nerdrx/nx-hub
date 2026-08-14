"use strict";
// kind: "appimage"
//
// This machine (and many modern distros) has no libfuse2, so we NEVER mount or
// run the AppImage as an application. We only ever invoke it once with
// `--appimage-extract`, which the AppImage runtime handles without FUSE, and
// then run the extracted tree directly via AppRun.
//
// The original .AppImage is kept alongside the extracted tree so a machine that
// *does* have FUSE (or the user) can still run the single file.

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  installDirFor, rmrf, exists, run, walkFiles, spawnDetached,
  stagedInstall, withWorkDir, writeManifest, readManifest, throwIfAborted,
} = require("./util");
const { writeDesktopEntry, findIcon, updateDesktopDatabase, execArg } = require("./desktop");
const { standardUninstall, nameHints } = require("./common");

const APPRUN = "AppRun";

/**
 * Electron apps ship a `chrome-sandbox` that needs root:root + setuid to work.
 * Inside an AppImage that's fine (the runtime keeps the bits), but after
 * `--appimage-extract` onto a normal filesystem the setuid bit is gone and
 * Chromium aborts with "The SUID sandbox helper binary was found, but is not
 * configured correctly". We cannot fix that without root, so when we detect a
 * chrome-sandbox in the tree we launch with ELECTRON_DISABLE_SANDBOX=1.
 * Non-Electron AppImages are launched plainly.
 */
async function hasChromeSandbox(root) {
  if (await exists(path.join(root, "chrome-sandbox"))) return true;
  const files = await walkFiles(root, { max: 20000 });
  return files.some((f) => path.basename(f.rel) === "chrome-sandbox");
}

function appRunPath(installDir) {
  return path.join(installDir, APPRUN);
}

async function launchSpec(installDir) {
  const appRun = appRunPath(installDir);
  const sandboxed = await hasChromeSandbox(installDir);
  return { appRun, sandboxed };
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);
  const assetName = artifact.assetName || path.basename(filePath);
  const keptName = assetName.toLowerCase().endsWith(".appimage") ? assetName : `${assetName}.AppImage`;

  ctx.emitProgress("verify", 5, "Checking AppImage");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);
  await fsp.chmod(filePath, 0o755);

  const desktopEntries = [];
  let sandboxed = false;

  await stagedInstall(installDir, async (stage) => {
    throwIfAborted(ctx);
    ctx.emitProgress("extract", 15, "Extracting AppImage (no FUSE needed)");

    await withWorkDir(installDir, async (work) => {
      const res = await run(path.resolve(filePath), ["--appimage-extract"], {
        cwd: work,
        signal: ctx.signal,
        timeout: 15 * 60 * 1000,
      });
      const squash = path.join(work, "squashfs-root");
      if (res.code !== 0 || !(await exists(squash))) {
        const detail = (res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" ");
        throw new Error(
          `AppImage extraction failed${detail ? `: ${detail}` : ""} (the file may be truncated or not an AppImage)`
        );
      }
      ctx.emitProgress("extract", 55, "Moving files into place");
      // Move the extracted tree so `stage` *is* squashfs-root.
      await rmrf(stage);
      await fsp.rename(squash, stage);
    });

    throwIfAborted(ctx);
    ctx.emitProgress("install", 70, "Installing");

    // keep the original single-file AppImage alongside the extracted tree
    await fsp.copyFile(filePath, path.join(stage, keptName));
    await fsp.chmod(path.join(stage, keptName), 0o755).catch(() => {});

    const appRun = path.join(stage, APPRUN);
    if (!(await exists(appRun))) {
      throw new Error("Extracted AppImage has no AppRun — cannot launch it");
    }
    await fsp.chmod(appRun, 0o755).catch(() => {});

    sandboxed = await hasChromeSandbox(stage);
    ctx.log(`appimage: chrome-sandbox ${sandboxed ? "present → ELECTRON_DISABLE_SANDBOX=1" : "absent"}`);
  });

  // Desktop entry points at the final location (after the swap).
  ctx.emitProgress("install", 88, "Creating desktop entry");
  // Icon: extracted .DirIcon / usr/share/icons when findable, else whatever
  // fallback the core hands us via ctx (assets/icon.png).
  const icon =
    (await findIcon(installDir, nameHints(app, artifact))) ||
    ctx.fallbackIcon ||
    null;
  const appRun = appRunPath(installDir);
  const exec = sandboxed
    ? `env ELECTRON_DISABLE_SANDBOX=1 ${execArg(appRun)}`
    : execArg(appRun);
  const entry = await writeDesktopEntry({ app, artifact, exec, icon, ctx });
  if (entry) desktopEntries.push(entry);
  await updateDesktopDatabase(ctx).catch(() => {});

  ctx.emitProgress("cleanup", 96, "Writing manifest");
  await writeManifest(installDir, {
    version: artifact.version,
    kind: "appimage",
    files: [],
    dirs: [],
    desktopEntries,
    binary: APPRUN,
    extra: { appImageFile: keptName, sandboxed },
  });

  ctx.emitProgress("cleanup", 100, "Installed");
  return { version: artifact.version, path: installDir, launchable: true };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const appRun = path.join(installDir, (manifest && manifest.binary) || APPRUN);
  if (!(await exists(appRun))) throw new Error(`AppRun missing at ${appRun} — reinstall the app`);
  await fsp.chmod(appRun, 0o755).catch(() => {});
  const sandboxed = manifest?.sandboxed ?? (await hasChromeSandbox(installDir));
  const env = { ...process.env };
  if (sandboxed) env.ELECTRON_DISABLE_SANDBOX = "1";
  ctx.log(`launching ${appRun}${sandboxed ? " (sandbox disabled)" : ""}`);
  const child = spawnDetached(appRun, [], { cwd: installDir, env });
  return { pid: child.pid, command: appRun };
}

module.exports = { install, uninstall, launch, hasChromeSandbox, launchSpec };
