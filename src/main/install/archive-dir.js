"use strict";
// kind: "archive-dir" — plain zip / tar.gz that unpacks into its own folder and
// is launched from there (game builds, portable Linux apps).

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  installDirFor, exists, extractArchive, pickBinary, walkFiles, spawnDetached,
  stagedInstall, writeManifest, readManifest, throwIfAborted,
} = require("./util");
const { writeDesktopEntry, findIcon, updateDesktopDatabase, execArg } = require("./desktop");
const { standardUninstall, nameHints } = require("./common");

/**
 * Archives that wrap everything in a single top-level folder are flattened one
 * level so the install dir isn't `<installdir>/MyApp-1.2.3-linux/...`. Only done
 * when the archive root holds exactly one directory and nothing else.
 */
async function flattenSingleRoot(dir, ctx) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return false;
  const inner = path.join(dir, entries[0].name);
  const moved = await fsp.readdir(inner);
  for (const name of moved) {
    await fsp.rename(path.join(inner, name), path.join(dir, name));
  }
  await fsp.rmdir(inner).catch(() => {});
  ctx?.log?.(`flattened single top-level dir "${entries[0].name}"`);
  return true;
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);

  ctx.emitProgress("verify", 5, "Checking archive");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);

  let binary = null;

  await stagedInstall(installDir, async (stage) => {
    throwIfAborted(ctx);
    ctx.emitProgress("extract", 20, "Extracting archive");
    await extractArchive(filePath, stage, ctx);

    throwIfAborted(ctx);
    const count = (await walkFiles(stage)).length;
    if (count === 0) throw new Error("Archive extracted to nothing — download may be corrupt");
    ctx.emitProgress("extract", 60, `Extracted ${count} files`);

    await flattenSingleRoot(stage, ctx);

    ctx.emitProgress("install", 75, "Locating launch binary");
    binary = await pickBinary(stage, {
      hint: artifact.binHint,
      names: nameHints(app, artifact),
      ctx,
    });
    if (binary) ctx.log(`archive-dir: launch binary = ${binary}`);
    else ctx.log("archive-dir: no executable found — installed without a launch target");
  });

  const desktopEntries = [];
  let icon = null;
  if (binary) {
    ctx.emitProgress("install", 88, "Creating desktop entry");
    const abs = path.join(installDir, binary);
    await fsp.chmod(abs, 0o755).catch(() => {});
    icon =
      (await findIcon(installDir, nameHints(app, artifact))) || ctx.fallbackIcon || null;
    const entry = await writeDesktopEntry({
      app, artifact, exec: execArg(abs), icon, ctx,
      categories: artifact.categories,
    });
    if (entry) desktopEntries.push(entry);
    await updateDesktopDatabase(ctx).catch(() => {});
  }

  ctx.emitProgress("cleanup", 96, "Writing manifest");
  await writeManifest(installDir, {
    version: artifact.version,
    kind: "archive-dir",
    files: [],
    dirs: [],
    desktopEntries,
    binary,
    extra: { icon },
  });

  ctx.emitProgress("cleanup", 100, "Installed");
  return { version: artifact.version, path: installDir, launchable: Boolean(binary), iconPath: icon };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const rel = manifest?.binary || artifact.binHint;
  if (!rel) throw new Error("No launch binary recorded for this install");
  const abs = path.join(installDir, rel);
  if (!(await exists(abs))) throw new Error(`Launch binary missing at ${abs} — reinstall the app`);
  await fsp.chmod(abs, 0o755).catch(() => {});
  ctx.log(`launching ${abs}`);
  // cwd = the binary's own dir: game builds expect their assets relative to it
  const child = spawnDetached(abs, [], { cwd: path.dirname(abs) });
  return { pid: child.pid, command: abs };
}

module.exports = { install, uninstall, launch, flattenSingleRoot };
