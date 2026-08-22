"use strict";
// kind: "blender-theme" (overlay-only) — drop theme presets into every Blender
// installation's `scripts/presets/interface_theme/` directory.
//
// Blender keeps one config tree per MAJOR.MINOR version, so a machine with 4.2
// and 5.2 side by side needs the preset in both; a new Blender release gets it
// on the next install. That fan-out is why this is its own kind rather than a
// `tarball-prefix` into a hard-coded `~/.config/blender/5.2` — the version in
// the registry would go stale the day the user upgrades.
//
// Nothing to launch: Blender owns the runtime. Every written file is recorded
// absolutely, so uninstall removes exactly what we put there and nothing else.

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  installDirFor, expandUser, exists, isDir, mkdirp, extractArchive, walkFiles,
  withWorkDir, stagedInstall, writeManifest, readManifest, throwIfAborted,
} = require("./util");
const { standardUninstall } = require("./common");

const PRESET_REL = path.join("scripts", "presets", "interface_theme");
const VERSION_DIR = /^\d+\.\d+$/;
const ARCHIVE = /\.(zip|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tar\.zst|tar)$/i;

/** Every place Blender may keep its per-version configuration on this box. */
function configRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    roots.push(path.join(appData, "Blender Foundation", "Blender"));
  } else if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Application Support", "Blender"));
  } else {
    roots.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "blender"));
    // Flatpak relocates the whole config tree.
    roots.push(path.join(os.homedir(), ".var", "app", "org.blender.Blender", "config", "blender"));
  }
  return roots;
}

/**
 * Existing `<root>/<major.minor>` directories, newest last. An overlay may pin
 * the list with `blenderVersions` (useful for tests and odd installs).
 */
async function findVersionDirs(artifact) {
  const pinned = Array.isArray(artifact.blenderVersions) ? artifact.blenderVersions : null;
  const roots = artifact.blenderConfigRoot
    ? [expandUser(artifact.blenderConfigRoot)]
    : configRoots();

  const found = [];
  for (const root of roots) {
    if (pinned) {
      for (const v of pinned) found.push({ version: String(v), dir: path.join(root, String(v)) });
      continue;
    }
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue; // Blender not installed under this root
    }
    for (const e of entries) {
      if (!e.isDirectory() || !VERSION_DIR.test(e.name)) continue;
      found.push({ version: e.name, dir: path.join(root, e.name) });
    }
  }
  found.sort((a, b) => {
    const [am, an] = a.version.split(".").map(Number);
    const [bm, bn] = b.version.split(".").map(Number);
    return am - bm || an - bn;
  });
  return found;
}

/** The .xml presets inside the downloaded payload. */
async function collectThemes(filePath, work, ctx) {
  if (/\.xml$/i.test(filePath)) return [filePath];
  if (!ARCHIVE.test(filePath)) {
    throw new Error(`Not a theme payload: ${path.basename(filePath)} (expected .xml or an archive)`);
  }
  await extractArchive(filePath, work, ctx);
  const files = await walkFiles(work);
  return files.filter((f) => !f.isSymlink && /\.xml$/i.test(f.abs)).map((f) => f.abs);
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);

  ctx.emitProgress("verify", 5, "Checking theme payload");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);

  let targets = await findVersionDirs(artifact);
  if (targets.length === 0) {
    // Blender installed but never launched: its config tree does not exist yet.
    // The overlay names the version to create rather than us guessing one.
    const fallback = artifact.defaultBlenderVersion;
    if (!fallback) {
      throw new Error(
        "No Blender configuration found — start Blender once so it creates its config directory, then install again"
      );
    }
    const root = artifact.blenderConfigRoot ? expandUser(artifact.blenderConfigRoot) : configRoots()[0];
    targets = [{ version: String(fallback), dir: path.join(root, String(fallback)) }];
    ctx.log(`blender-theme: no config dir found, creating one for Blender ${fallback}`);
  }

  const prevManifest = await readManifest(installDir);
  const written = [];
  const createdDirs = [];

  await withWorkDir(installDir, async (work) => {
    throwIfAborted(ctx);
    ctx.emitProgress("extract", 20, "Reading theme");
    const themes = await collectThemes(filePath, work, ctx);
    if (themes.length === 0) throw new Error("No .xml theme found in the release asset");

    ctx.emitProgress("install", 55, `Installing into ${targets.length} Blender version(s)`);
    for (const target of targets) {
      throwIfAborted(ctx);
      const dest = path.join(target.dir, PRESET_REL);
      if (!(await isDir(dest))) {
        await mkdirp(dest);
        createdDirs.push(dest);
      }
      for (const theme of themes) {
        const out = path.join(dest, path.basename(theme));
        await fsp.copyFile(theme, out);
        await fsp.chmod(out, 0o644).catch(() => {});
        written.push(out);
      }
    }
    ctx.log(
      `blender-theme: ${themes.length} preset(s) -> ${targets.map((t) => t.version).join(", ")}`
    );
  });

  // A previous version may have shipped a preset this one dropped, or landed in
  // a Blender version that has since been removed.
  if (prevManifest && Array.isArray(prevManifest.files)) {
    const keep = new Set(written);
    for (const old of prevManifest.files) {
      if (!keep.has(old)) await fsp.rm(old, { force: true }).catch(() => {});
    }
  }

  ctx.emitProgress("cleanup", 92, "Writing manifest");
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "blender-theme",
      files: written,
      dirs: createdDirs,
      desktopEntries: [],
      binary: null,
      extra: { blenderVersions: targets.map((t) => t.version) },
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
  throw new Error("Blender themes are applied from inside Blender — nothing to launch");
}

module.exports = { install, uninstall, launch, findVersionDirs };
