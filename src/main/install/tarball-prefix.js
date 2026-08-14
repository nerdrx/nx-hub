"use strict";
// kind: "tarball-prefix" (overlay-only)
//
// Extracts the entries under `stripPrefix` (e.g. "usr/") of a tarball into
// `prefix` (e.g. "~/.local"), i.e. a classic staged-tarball install into the
// user's prefix. Everything outside stripPrefix (README-NX.md at the archive
// root, LICENSE, …) is skipped.
//
// Because these files land OUTSIDE our install dir we record every single
// absolute path — plus the directories we had to create — in the manifest, so
// uninstall is exact and conservative: files get removed, directories only get
// `rmdir`'d (never rm -rf), so a shared prefix like ~/.local is never at risk.

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  installDirFor, expandUser, exists, isDir, mkdirp, extractArchive, walkFiles,
  copyEntry, spawnDetached, withWorkDir, writeManifest, readManifest,
  throwIfAborted, stagedInstall, launchExtras,
} = require("./util");
const { standardUninstall } = require("./common");

function normStrip(stripPrefix) {
  return String(stripPrefix || "")
    .replace(/^[./]+/, "")
    .replace(/\/+$/, "");
}

/**
 * Locate `<strip>` inside the extracted tree. Handles both flat tarballs
 * (`usr/bin/...`) and ones wrapped in a single versioned top-level dir
 * (`wivrn-nx-server-1.0/usr/bin/...`).
 */
async function findStripRoot(work, strip) {
  if (!strip) return work;
  const direct = path.join(work, strip);
  if (await isDir(direct)) return direct;
  const entries = await fsp.readdir(work, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  for (const d of dirs) {
    const nested = path.join(work, d.name, strip);
    if (await isDir(nested)) return nested;
  }
  return null;
}

/** Split a relative path into its ancestor dirs, shallowest first. */
function ancestors(relDir) {
  const parts = relDir.split(path.sep).filter((p) => p && p !== ".");
  const out = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join(path.sep));
  return out;
}

async function install({ app, artifact, filePath, ctx }) {
  const installDir = installDirFor(app, artifact, ctx);
  const strip = normStrip(artifact.stripPrefix);
  const prefix = expandUser(artifact.prefix || "~/.local");

  ctx.emitProgress("verify", 5, "Checking tarball");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);

  const prevManifest = await readManifest(installDir);

  const written = []; // absolute file paths we created
  const createdDirs = []; // absolute dirs we created (for conservative cleanup)

  try {
    await withWorkDir(installDir, async (work) => {
      throwIfAborted(ctx);
      ctx.emitProgress("extract", 15, "Extracting tarball");
      await extractArchive(filePath, work, ctx);

      const root = await findStripRoot(work, strip);
      if (!root) {
        throw new Error(
          `Archive does not contain "${strip || "."}" — it may not be the expected build`
        );
      }
      const allWork = await walkFiles(work);
      const entries = await walkFiles(root);
      const skipped = allWork.length - entries.length;
      if (skipped > 0) ctx.log(`tarball-prefix: skipping ${skipped} entr(ies) outside "${strip}/"`);
      if (entries.length === 0) throw new Error(`"${strip}" is empty in this archive`);

      ctx.emitProgress("install", 40, `Installing ${entries.length} files into ${prefix}`);
      await mkdirp(prefix);

      let done = 0;
      for (const e of entries) {
        throwIfAborted(ctx);
        const dest = path.join(prefix, e.rel);
        // record parent dirs that don't exist yet, before creating them
        for (const relDir of ancestors(path.dirname(e.rel))) {
          const absDir = path.join(prefix, relDir);
          if (!(await exists(absDir))) createdDirs.push(absDir);
        }
        await copyEntry(e.abs, dest);
        written.push(dest);
        done++;
        if (done % 10 === 0 || done === entries.length) {
          const pct = 40 + Math.round((done / entries.length) * 50);
          ctx.emitProgress("install", pct, `Installed ${done}/${entries.length} files`);
        }
      }
    });
  } catch (err) {
    // roll back: this kind writes outside our install dir, so a half-done
    // install has to be undone by hand.
    ctx.log(`tarball-prefix failed (${err.message}) — rolling back ${written.length} file(s)`);
    for (const f of written) await fsp.rm(f, { force: true }).catch(() => {});
    for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
      await fsp.rmdir(d).catch(() => {});
    }
    throw err;
  }

  // Drop files from a previous version that this release no longer ships.
  if (prevManifest && Array.isArray(prevManifest.files)) {
    const keep = new Set(written);
    const stale = prevManifest.files.filter((f) => !keep.has(f));
    for (const f of stale) await fsp.rm(f, { force: true }).catch(() => {});
    if (stale.length) ctx.log(`removed ${stale.length} stale file(s) from the previous version`);
    for (const d of [...(prevManifest.dirs || [])].sort((a, b) => b.length - a.length)) {
      await fsp.rmdir(d).catch(() => {});
    }
  }

  ctx.emitProgress("cleanup", 94, "Writing manifest");
  const uniqDirs = [...new Set(createdDirs)];
  await stagedInstall(installDir, async (stage) => {
    await writeManifest(stage, {
      version: artifact.version,
      kind: "tarball-prefix",
      files: written,
      dirs: uniqDirs,
      desktopEntries: [], // the tarball ships its own .desktop files under share/
      binary: null,
      extra: {
        prefix,
        stripPrefix: strip,
        launchCmd: artifact.launchCmd || null,
        postInstallNote: artifact.postInstallNote || null,
      },
    });
  });

  const launchTarget = resolveLaunch(artifact.launchCmd);
  const launchable = Boolean(launchTarget && (await exists(launchTarget.cmd)));
  if (artifact.launchCmd && !launchable) {
    ctx.log(`launchCmd "${artifact.launchCmd}" not present after install — marking not launchable`);
  }

  ctx.emitProgress("cleanup", 100, "Installed");
  return { version: artifact.version, path: installDir, launchable };
}

/** "~/.local/bin/wivrn-dashboard --flag" → {cmd, args} with ~ expanded. */
function resolveLaunch(launchCmd) {
  if (!launchCmd) return null;
  const raw = String(launchCmd).trim();
  const direct = expandUser(raw);
  // most launchCmds are a bare path; only split when that path doesn't exist
  const parts = raw.split(/\s+/);
  return { cmd: expandUser(parts[0]), args: parts.slice(1), direct };
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const spec = resolveLaunch(artifact.launchCmd || manifest?.launchCmd);
  if (!spec) throw new Error("This artifact has no launch command");
  if (!(await exists(spec.cmd))) {
    throw new Error(`Launch command not found: ${spec.cmd}`);
  }
  // v0.2: appPrefs.launchArgs are appended to the overlay's own args
  const { args, env } = launchExtras(ctx, { args: spec.args });
  ctx.log(`launching ${spec.cmd} ${args.join(" ")}`.trim());
  const child = spawnDetached(spec.cmd, args, { cwd: path.dirname(spec.cmd), env });
  return { pid: child.pid, command: spec.cmd, args };
}

module.exports = { install, uninstall, launch, findStripRoot, resolveLaunch, normStrip };
