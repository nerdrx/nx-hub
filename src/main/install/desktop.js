"use strict";
// Desktop-entry + icon helpers (freedesktop.org). Linux only; the windows kinds
// use Start-menu shortcuts instead (see windows.js).

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mkdirp, exists, walkFiles, run } = require("./util");

/** ~/.local/share/applications, honouring XDG_DATA_HOME (tests override it). */
function applicationsDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "applications");
}

function desktopFileName(app, artifact) {
  return `nx-${app.id}-${artifact.id}.desktop`;
}

function desktopFilePath(app, artifact) {
  return path.join(applicationsDir(), desktopFileName(app, artifact));
}

/** Escape a value for the Exec= key (spaces → quoted, backslashes doubled). */
function execArg(p) {
  if (!p) return "";
  if (/^[A-Za-z0-9_\-./=:@+]+$/.test(p)) return p;
  return `"${String(p).replace(/(["`$\\])/g, "\\$1")}"`;
}

function escapeValue(v) {
  return String(v == null ? "" : v).replace(/\n/g, " ").trim();
}

/**
 * Find an icon inside an extracted tree.
 * Priority: AppImage `.DirIcon` → usr/share/icons (biggest png) → root-level
 * png/svg named like the app → any root-level png/svg.
 */
async function findIcon(root, names = []) {
  if (!root) return null;
  const dirIcon = path.join(root, ".DirIcon");
  if (await exists(dirIcon)) {
    try {
      const st = await fsp.lstat(dirIcon);
      if (st.isSymbolicLink()) {
        const target = path.resolve(root, await fsp.readlink(dirIcon));
        if (await exists(target)) return target;
      } else {
        return dirIcon;
      }
    } catch {
      /* fall through */
    }
  }
  const files = await walkFiles(root);
  const images = files.filter((f) => /\.(png|svg)$/i.test(f.rel));
  if (!images.length) return null;

  const wanted = names.map((n) => String(n || "").toLowerCase()).filter(Boolean);
  const sizeOf = (rel) => {
    const m = rel.match(/(\d+)x\1/);
    return m ? Number(m[1]) : 0;
  };
  const score = (f) => {
    const base = path.basename(f.rel).toLowerCase();
    const relLower = f.rel.toLowerCase();
    let s = 0;
    if (wanted.some((w) => base.startsWith(w))) s += 500;
    if (relLower.includes("share/icons") || relLower.includes("share/pixmaps")) s += 200;
    if (relLower.includes("hicolor")) s += 50;
    if (base.endsWith(".svg")) s += 120; // scalable beats a small raster
    s += Math.min(300, sizeOf(f.rel));
    s -= f.rel.split(path.sep).length * 5;
    return s;
  };
  images.sort((a, b) => score(b) - score(a) || b.size - a.size);
  return images[0].abs;
}

/**
 * Write ~/.local/share/applications/nx-<appId>-<artifactId>.desktop.
 * Returns the absolute path, or null when we deliberately skipped it.
 */
async function writeDesktopEntry({ app, artifact, exec, icon, ctx, terminal = false, categories, comment }) {
  if (process.platform === "win32") return null;
  if (!exec) return null;
  const dir = applicationsDir();
  await mkdirp(dir);
  const file = path.join(dir, desktopFileName(app, artifact));
  const name = escapeValue(app.name || app.id);
  const label = escapeValue(artifact.label || "");
  const title = label && !/^(linux|pc)/i.test(label) && artifact.showLabel ? `${name} (${label})` : name;
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${title}`,
    `Comment=${escapeValue(comment || app.tagline || "")}`,
    `Exec=${exec}`,
    icon ? `Icon=${icon}` : null,
    `Terminal=${terminal ? "true" : "false"}`,
    `Categories=${escapeValue(categories || "Utility;")}`,
    `StartupWMClass=${escapeValue(app.id)}`,
    `X-NX-Hub=${escapeValue(app.id)}/${escapeValue(artifact.id)}`,
    "",
  ].filter((l) => l !== null);
  await fsp.writeFile(file, lines.join("\n"), { mode: 0o644 });
  ctx?.log?.(`desktop entry written: ${file}`);
  return file;
}

async function removeDesktopEntry(file, ctx) {
  if (!file) return false;
  try {
    await fsp.rm(file, { force: true });
    ctx?.log?.(`desktop entry removed: ${file}`);
    return true;
  } catch (err) {
    ctx?.log?.(`could not remove desktop entry ${file}: ${err.message}`);
    return false;
  }
}

/** Best-effort desktop DB refresh — never fails an install. */
async function updateDesktopDatabase(ctx) {
  if (process.platform === "win32") return;
  const res = await run("update-desktop-database", [applicationsDir()], {
    timeout: 8000,
    signal: ctx?.signal,
  });
  if (res.missing) ctx?.log?.("update-desktop-database not present — skipped");
}

module.exports = {
  applicationsDir,
  desktopFileName,
  desktopFilePath,
  findIcon,
  writeDesktopEntry,
  removeDesktopEntry,
  updateDesktopDatabase,
  execArg,
};
