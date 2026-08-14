"use strict";
// NX Hub — housekeeping: disk usage, download cache, log tail (SPEC v0.2).
// Pure node: no electron require anywhere in this file.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const config = require("./config");
const stateStore = require("./state");

const USAGE_TTL_MS = 30 * 1000;
const LOG_TAIL_BYTES = 1024 * 1024; // never read more than the last MB of the log

let usageCache = null; // { at, value }

/** Recursive size of one directory (bytes). Missing → 0, never throws. */
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSize(abs);
      } else if (entry.isFile()) {
        const st = await fsp.lstat(abs);
        total += st.size;
      }
      // symlinks are not followed and count as 0 — we never double-count targets
    } catch (_) {
      /* vanished mid-walk */
    }
  }
  return total;
}

/** The per-app install root: <installRoot>/nx (SPEC install layout). */
function nxRoot(settings) {
  return path.join(config.installRoot(settings), "nx");
}

/**
 * SPEC v0.2: getDiskUsage() → {perApp: {appId: bytes}, downloads: bytes, total}
 * `du -s` in plain node. Async and cached for 30s — the UI may poll it.
 */
async function getDiskUsage({ force = false, settings } = {}) {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value;

  const s = settings || config.load();
  const root = nxRoot(s);
  const perApp = {};
  let apps = [];
  try {
    apps = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch (_) {
    apps = [];
  }

  let installed = 0;
  for (const entry of apps) {
    if (entry.name === "downloads") continue; // parked generic-zip assets, counted below
    const bytes = await dirSize(path.join(root, entry.name));
    perApp[entry.name] = bytes;
    installed += bytes;
  }

  // download cache (dataDir/downloads) + the parked-asset folder under the install root
  const cacheBytes = await dirSize(config.downloadsDir());
  const parkedBytes = await dirSize(path.join(root, "downloads"));
  const downloads = cacheBytes + parkedBytes;

  const value = {
    perApp,
    downloads,
    downloadCache: cacheBytes,
    installed,
    total: installed + downloads,
    installRoot: root,
    at: new Date().toISOString(),
  };
  usageCache = { at: Date.now(), value };
  return value;
}

function invalidateUsageCache() {
  usageCache = null;
}

/**
 * SPEC v0.2: clearDownloadCache() — empty dataDir/downloads and forget the
 * pre-downloaded assets recorded by the "download" update policy.
 * @returns {{removed:number, bytes:number, dir:string}}
 */
async function clearDownloadCache() {
  const dir = config.downloadsDir();
  let removed = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        bytes += await dirSize(abs);
        await fsp.rm(abs, { recursive: true, force: true });
      } else {
        const st = await fsp.lstat(abs);
        bytes += st.size;
        await fsp.rm(abs, { force: true });
      }
      removed += 1;
    } catch (e) {
      config.log(`clearDownloadCache: could not remove ${abs} — ${e.message}`);
    }
  }
  stateStore.clearDownloads();
  invalidateUsageCache();
  config.log(`download cache cleared (${removed} entr(ies))`);
  return { removed, bytes, dir };
}

/**
 * SPEC v0.2: getLogs(tailLines) — the last N lines of logs/nx-hub.log.
 * Reads at most the final MB, so a huge log never blocks the UI.
 */
function getLogs(tailLines = 200) {
  const file = config.logFile();
  const lines = Math.max(1, Math.min(Number(tailLines) || 200, 5000));
  let fd = null;
  try {
    const st = fs.statSync(file);
    const length = Math.min(st.size, LOG_TAIL_BYTES);
    const start = st.size - length;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, length, start);
    const text = buf.toString("utf8");
    const all = text.split("\n").filter((l) => l.length > 0);
    if (start > 0 && all.length) all.shift(); // first line is probably truncated
    return { file, lines: all.slice(-lines), truncated: start > 0, size: st.size };
  } catch (e) {
    return { file, lines: [], truncated: false, size: 0, error: e.code === "ENOENT" ? null : e.message };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  getDiskUsage,
  clearDownloadCache,
  getLogs,
  dirSize,
  invalidateUsageCache,
  USAGE_TTL_MS,
};
