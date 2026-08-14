"use strict";
// Uninstall logic shared by every kind: manifest-driven and deliberately
// conservative — we only delete what we recorded writing.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { readManifest, rmrf, exists } = require("./util");
const { removeDesktopEntry, updateDesktopDatabase } = require("./desktop");

/**
 * Remove manifest-listed outside files, then any dirs we created that are now
 * empty (deepest first), then the desktop entries, then the install dir itself.
 * Missing pieces are not an error — uninstall must always converge.
 */
async function standardUninstall({ installDir, ctx, keepInstallDir = false }) {
  const ctxSafe = ctx || {};
  const manifest = (await readManifest(installDir)) || {};
  const removed = { files: 0, dirs: 0, desktop: 0 };

  ctxSafe.emitProgress?.("cleanup", 10, "Removing installed files");

  for (const f of manifest.files || []) {
    try {
      const st = await fsp.lstat(f);
      if (st.isDirectory()) await rmrf(f);
      else await fsp.rm(f, { force: true });
      removed.files++;
    } catch {
      /* already gone */
    }
  }

  // Deepest first so parents can become empty. We only rmdir — never rm -rf —
  // so a prefix like ~/.local can never be blown away.
  const dirs = [...new Set(manifest.dirs || [])].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length || b.localeCompare(a)
  );
  for (const d of dirs) {
    try {
      await fsp.rmdir(d);
      removed.dirs++;
    } catch {
      /* not empty or not ours — leave it alone */
    }
  }

  for (const entry of manifest.desktopEntries || []) {
    if (await removeDesktopEntry(entry, ctxSafe)) removed.desktop++;
  }
  if (removed.desktop) await updateDesktopDatabase(ctxSafe).catch(() => {});

  ctxSafe.emitProgress?.("cleanup", 80, "Removing install directory");
  if (!keepInstallDir && (await exists(installDir))) await rmrf(installDir);

  ctxSafe.emitProgress?.("cleanup", 100, "Uninstalled");
  ctxSafe.log?.(
    `uninstalled ${installDir} (files: ${removed.files}, dirs: ${removed.dirs}, entries: ${removed.desktop})`
  );
  return removed;
}

/** Candidate names used by the binary/icon heuristics. */
function nameHints(app, artifact) {
  const out = [];
  if (app?.id) out.push(app.id);
  if (app?.name) out.push(app.name);
  if (app?.repo) out.push(String(app.repo).split("/").pop());
  if (artifact?.assetName) {
    const base = String(artifact.assetName).replace(
      /(\.tar\.gz|\.tgz|\.zip|\.AppImage|\.exe|\.apk)$/i,
      ""
    );
    out.push(base.replace(/[-_]?v?\d+[\d.]*.*$/i, ""));
    out.push(base);
  }
  return out.filter(Boolean);
}

module.exports = { standardUninstall, nameHints };
