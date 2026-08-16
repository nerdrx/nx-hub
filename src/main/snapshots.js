"use strict";
// NX Hub — the config time machine. SPEC v0.8 "Config time machine".
//
// An app's overlay may declare `configPaths: ["~/.config/foo", …]`. Before the
// hub replaces an install ("pre-update"), removes one ("pre-uninstall") or
// restores an older archive over it ("pre-restore"), those paths are packed
// into a zstd tarball under `<dataDir>/snapshots/<appId>/`.
//
// Two constraints worth knowing before you read further:
//
//   1. Archives store paths RELATIVE TO $HOME and are always extracted with
//      `-C $HOME`. That makes a snapshot portable between machines and users
//      (the point: restoring `.config/foo` onto another box just works). The
//      price, in v1, is that a configPath OUTSIDE $HOME cannot be captured —
//      it is skipped with a log line rather than silently mixed into a tree
//      that would restore to the wrong place. Overlays should keep configPaths
//      inside $HOME.
//   2. Nothing here may ever break its caller. `maybeSnapshot` catches
//      everything and answers `{ok:false, error}`; a hub without zstd, a
//      permission error, a full disk — an install still proceeds. Only the
//      user-driven verbs (`restore`, `remove`) throw, because there the
//      failure IS the answer.
//
// Retention: the newest RETENTION (5) archives per app survive a write; older
// ones are deleted right after a successful capture.
//
// This module is pure node (no electron) and requires neither jobs nor
// discovery at load time — jobs.js calls INTO it from its install/uninstall
// hooks, so importing jobs back would close a cycle.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const config = require("./config");
const stateStore = require("./state");

/** How many archives per app survive a capture. */
const RETENTION = 5;

/** Reasons this module itself writes. Others parse, but round-trip as-is. */
const REASONS = ["pre-update", "pre-uninstall", "pre-restore", "manual"];

const SUFFIX = ".tar.zst";

// `2026-08-16T10-04-05.123Z` — ISO 8601 with the time's colons swapped for
// dashes, which keeps the name sortable, readable AND legal on win32. The
// milliseconds are what make two captures in the same second distinct.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/;

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * $HOME as this process sees it — the archive root, and the only tree a
 * restore ever writes into. `os.homedir()` already prefers $HOME on POSIX;
 * reading the variable first keeps tests (which point HOME at a temp dir)
 * honest on every platform.
 */
function homeDir() {
  return process.env.HOME || os.homedir();
}

function snapshotsRoot() {
  return path.join(config.dataDir(), "snapshots");
}

/** `<dataDir>/snapshots/<appId>` — throws on an app id that is not one. */
function snapshotDir(appId) {
  const id = String(appId == null ? "" : appId).trim();
  if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(`Invalid app id "${appId}"`);
  }
  return path.join(snapshotsRoot(), id);
}

/**
 * Resolve one archive inside an app's snapshot directory.
 *
 * The whole point of this function is that `file` comes from a renderer, a
 * CLI argument or an IPC caller: it must be a plain basename that lands
 * directly in the app's own directory. "../../etc/passwd", "/etc/passwd" and
 * "sub/dir/x.tar.zst" are all rejected — a delete or an overwrite must never
 * be steerable out of the snapshot tree.
 */
function resolveFile(appId, file) {
  const dir = snapshotDir(appId);
  const name = String(file == null ? "" : file);
  if (!name || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0")) {
    throw new Error(`Invalid snapshot name "${file}"`);
  }
  if (!name.endsWith(SUFFIX)) throw new Error(`"${name}" is not a snapshot (${SUFFIX})`);
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) throw new Error(`Invalid snapshot name "${file}"`);
  return { dir, name, path: full };
}

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

/** Date → the filesystem-safe stamp used in every archive name. */
function formatStamp(date) {
  const iso = new Date(date == null ? Date.now() : date).toISOString(); // 2026-08-16T10:04:05.123Z
  return `${iso.slice(0, 11)}${iso.slice(11).replace(/:/g, "-")}`;
}

/** The stamp back to a real ISO timestamp, or null when it is not one. */
function parseStamp(stamp) {
  const m = STAMP_RE.exec(String(stamp || ""));
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

/**
 * Anything that would fight the filesystem (a separator, a space, a quote).
 * Dashes SURVIVE — "1.4.0-rc1" is a version people read — because parseName
 * peels the reason off the end rather than splitting on every dash.
 */
function slug(value, fallback) {
  const s = String(value == null ? "" : value)
    .trim()
    .replace(/[^A-Za-z0-9._+~-]+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
  return s || fallback;
}

function fileNameFor(ts, version, reason) {
  return `${formatStamp(ts)}-${slug(version, "unknown")}-${reason}${SUFFIX}`;
}

/**
 * `<stamp>-<version>-<reason>.tar.zst` → {ts, version, reason}, or null.
 *
 * Reasons contain a dash ("pre-update"), and a version may too ("1.4.0-rc1"),
 * so the split is anchored on the known reasons first; an archive written by
 * some future version with a reason we do not know still parses through the
 * fallback, which simply takes the last dash-segment.
 */
function parseName(file) {
  const name = String(file || "");
  if (!name.endsWith(SUFFIX)) return null;
  const stem = name.slice(0, -SUFFIX.length);

  // The stamp is fixed-width, so it comes off first and the dashes inside it
  // never confuse the version/reason split that follows.
  const head = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)$/.exec(stem);
  if (!head) return null;
  const ts = parseStamp(head[1]);
  if (!ts) return null;

  // A known reason wins outright, longest first — including when it leaves no
  // version behind ("…Z-pre-update.tar.zst" is a malformed name, not a
  // snapshot of version "pre" for reason "update").
  const rest = head[2];
  for (const reason of [...REASONS].sort((a, b) => b.length - a.length)) {
    if (rest === reason) return null;
    if (!rest.endsWith(`-${reason}`)) continue;
    const version = rest.slice(0, -(reason.length + 1));
    return version ? { ts, stamp: head[1], version, reason } : null;
  }
  // Some future build's reason: the last dash-segment is all we can assume.
  const m = /^(.*)-([^-]+)$/.exec(rest);
  if (!m || !m[1] || !m[2]) return null;
  return { ts, stamp: head[1], version: m[1], reason: m[2] };
}

/* ------------------------------------------------------------------ */
/* the tar side                                                        */
/* ------------------------------------------------------------------ */

/** First executable `zstd` on PATH — GNU tar's `--zstd` shells out to it. */
function hasZstd() {
  const raw = process.env.PATH || "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, "zstd");
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch (_) {
      /* next */
    }
  }
  return false;
}

function runTar(args, { timeout = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    execFile("tar", args, { timeout, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout || "",
        stderr: stderr || (err && err.message) || "",
      });
    });
  });
}

function log(message) {
  try {
    config.log(`[snapshots] ${message}`);
  } catch (_) {
    /* logging must never be the thing that fails */
  }
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * The overlay's configPaths for an app, expanded, de-duplicated, split into
 * what can be archived and what cannot.
 *
 * @returns {{rel:string[], abs:string[], outside:string[], missing:string[]}}
 */
function planPaths(app, home = homeDir()) {
  const out = { rel: [], abs: [], outside: [], missing: [] };
  const raw = app && Array.isArray(app.configPaths) ? app.configPaths : [];
  const seen = new Set();
  const root = path.resolve(home);
  for (const entry of raw) {
    if (!entry || typeof entry !== "string") continue;
    const abs = path.resolve(config.expandHome(entry.trim()));
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!fs.existsSync(abs)) {
      out.missing.push(abs);
      continue;
    }
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      // v1 constraint: archives are $HOME-relative so they restore anywhere.
      out.outside.push(abs);
      continue;
    }
    out.rel.push(rel);
    out.abs.push(abs);
  }
  return out;
}

/** The version to stamp an archive with: whatever is installed right now. */
function installedVersion(app) {
  try {
    const records = stateStore.getApp(app.id) || {};
    for (const key of Object.keys(records)) {
      const rec = records[key];
      if (rec && rec.version) return String(rec.version);
    }
  } catch (_) {
    /* no state yet */
  }
  for (const artifact of (app && app.artifacts) || []) {
    if (artifact && artifact.installed && artifact.installed.version) return String(artifact.installed.version);
  }
  return "unknown";
}

/**
 * Capture the app's configPaths. Never throws.
 *
 * @param {object} app     the app model (overlay `configPaths` included)
 * @param {object} settings config.load() — accepted for the orchestrator's
 *                          one-line hooks and future policy; unused today
 * @param {string} reason  "pre-update" | "pre-uninstall" | "pre-restore" | …
 * @param {object} [opts]  {version} to stamp instead of the installed one
 * @returns {Promise<object>} {ok, file, path, bytes, ts, version, reason,
 *                             paths} · {ok:true, skipped} · {ok:false, error}
 */
async function maybeSnapshot(app, settings, reason, opts = {}) {
  const why = slug(reason, "manual").replace(/_/g, "-");
  try {
    if (!app || !app.id) return { ok: false, error: "no app" };
    const home = opts.home || homeDir();
    const plan = planPaths(app, home);

    for (const p of plan.outside) {
      log(`${app.id}: skipping ${p} — outside $HOME, and archives are $HOME-relative (v1)`);
    }
    if (!plan.rel.length) {
      return { ok: true, skipped: "nothing to snapshot", appId: app.id, reason: why };
    }
    if (!hasZstd()) {
      log(`${app.id}: zstd is not on PATH — no snapshot taken`);
      return { ok: false, error: "zstd is not installed", appId: app.id, reason: why };
    }

    const dir = snapshotDir(app.id);
    config.ensureDir(dir);
    const version = opts.version != null ? String(opts.version) : installedVersion(app);

    // Millisecond stamps collide only when two captures land in the same
    // millisecond; walking forward keeps every archive its own file.
    let when = Date.now();
    let name = fileNameFor(when, version, why);
    while (fs.existsSync(path.join(dir, name))) {
      when += 1;
      name = fileNameFor(when, version, why);
    }
    const dest = path.join(dir, name);

    const res = await runTar(["--zstd", "-cf", dest, "-C", home, ...plan.rel]);
    if (res.code !== 0) {
      try {
        fs.rmSync(dest, { force: true });
      } catch (_) {
        /* ignore */
      }
      const error = (res.stderr || "tar failed").trim().split("\n").pop();
      log(`${app.id}: capture failed — ${error}`);
      return { ok: false, error, appId: app.id, reason: why };
    }

    let bytes = 0;
    try {
      bytes = fs.statSync(dest).size;
    } catch (_) {
      /* ignore */
    }
    const pruned = prune(app.id);
    log(`${app.id}: ${why} snapshot ${name} (${plan.rel.length} path(s), ${bytes} bytes)`);
    return {
      ok: true,
      appId: app.id,
      file: name,
      path: dest,
      bytes,
      ts: parseStamp(formatStamp(when)),
      version,
      reason: why,
      paths: plan.rel,
      pruned,
    };
  } catch (e) {
    log(`${(app && app.id) || "?"}: capture failed — ${e.message}`);
    return { ok: false, error: e.message || String(e), reason: why };
  }
}

/**
 * The install hook (jobs.runInstall). Snapshots only when this artifact
 * ALREADY has an install record for a DIFFERENT version — a first install has
 * nothing to preserve, and a reinstall of the same version is not an update.
 * Never throws.
 */
async function maybeSnapshotForUpdate(app, artifactId, version, settings) {
  try {
    if (!app || !app.id) return { ok: true, skipped: "no app" };
    const rec = stateStore.getInstall(app.id, artifactId);
    if (!rec || !rec.version) return { ok: true, skipped: "not installed yet" };
    if (String(rec.version) === String(version)) return { ok: true, skipped: "same version" };
    // Stamped with the version being REPLACED — that is what findPreUpdate()
    // matches a rollback target against.
    return await maybeSnapshot(app, settings, "pre-update", { version: rec.version });
  } catch (e) {
    log(`${(app && app.id) || "?"}: pre-update check failed — ${e.message}`);
    return { ok: false, error: e.message || String(e) };
  }
}

/** Delete everything past the newest RETENTION archives. Returns the names. */
function prune(appId, keep = RETENTION) {
  const removed = [];
  try {
    const dir = snapshotDir(appId);
    const all = list(appId);
    for (const entry of all.slice(keep)) {
      try {
        fs.rmSync(path.join(dir, entry.file), { force: true });
        removed.push(entry.file);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* read                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every archive for an app, newest first. Junk (stray files, half-written
 * names, anything unparseable) is skipped, never thrown over.
 *
 * @returns {{file:string, ts:string, version:string, reason:string, bytes:number}[]}
 */
function list(appId) {
  let dir;
  try {
    dir = snapshotDir(appId);
  } catch (_) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return []; // no snapshots yet
  }
  const out = [];
  for (const name of names) {
    const parsed = parseName(name);
    if (!parsed) continue;
    let bytes = 0;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch (_) {
      continue;
    }
    out.push({ file: name, ts: parsed.ts, version: parsed.version, reason: parsed.reason, bytes });
  }
  out.sort((a, b) => (a.ts === b.ts ? (a.file < b.file ? 1 : -1) : a.ts < b.ts ? 1 : -1));
  return out;
}

/** One archive's metadata (or null) — the same shape `list` returns. */
function get(appId, file) {
  const name = String(file || "");
  return list(appId).find((s) => s.file === name) || null;
}

/**
 * SPEC v0.8 rollback affinity: the archive a rollback CTA should offer to
 * restore alongside the older build.
 *
 * `version` is the version the rollback RESTORES (the one that was replaced),
 * which is exactly what the pre-update archive taken just before that
 * replacement is stamped with. Newest match wins; null when there is none.
 */
function findPreUpdate(appId, version) {
  if (version == null || version === "") return null;
  const want = String(version);
  const wantSlug = slug(want, "unknown");
  return (
    list(appId).find((s) => s.reason === "pre-update" && (s.version === want || s.version === wantSlug)) || null
  );
}

/** The paths inside an archive, as stored (relative to $HOME). */
async function entries(appId, file) {
  const target = resolveFile(appId, file);
  if (!fs.existsSync(target.path)) throw new Error(`No snapshot called "${target.name}"`);
  const res = await runTar(["--zstd", "-tf", target.path]);
  if (res.code !== 0) throw new Error((res.stderr || "tar failed").trim().split("\n").pop());
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */

/**
 * Unpack an archive over $HOME, in place.
 *
 * The current config is captured first ("pre-restore") so a restore is itself
 * undoable — that capture is best-effort and never blocks the restore. The
 * app model is needed for it: pass `opts.app` (tests and the CLI do), else it
 * is looked up in discovery's cache.
 *
 * Throws on a bad name, a missing archive or a tar failure: here the user
 * asked for exactly this, so a silent no-op would be a lie.
 */
async function restore(appId, file, opts = {}) {
  const target = resolveFile(appId, file);
  if (!fs.existsSync(target.path)) throw new Error(`No snapshot called "${target.name}"`);
  const home = opts.home || homeDir();
  const app = opts.app || findAppModel(appId);
  const settings = opts.settings || safeSettings();

  const before = app ? await maybeSnapshot(app, settings, "pre-restore") : { ok: false, error: "app not found" };

  const res = await runTar(["--zstd", "-xf", target.path, "-C", home]);
  if (res.code !== 0) throw new Error((res.stderr || "tar failed").trim().split("\n").pop());

  let restored = [];
  try {
    restored = await entries(appId, target.name);
  } catch (_) {
    /* the extract already succeeded — the listing is a nicety */
  }
  log(`${appId}: restored ${target.name} into ${home} (${restored.length} entr(y|ies))`);
  return {
    ok: true,
    appId,
    file: target.name,
    home,
    restored,
    preRestore: before && before.ok && before.file ? before.file : null,
  };
}

/** Delete one archive. Same guards as restore. */
function remove(appId, file) {
  const target = resolveFile(appId, file);
  if (!fs.existsSync(target.path)) throw new Error(`No snapshot called "${target.name}"`);
  fs.rmSync(target.path, { force: true });
  log(`${appId}: deleted ${target.name}`);
  return { ok: true, appId, file: target.name };
}

/* ------------------------------------------------------------------ */
/* lazy hub lookups (kept out of the module graph on purpose)          */
/* ------------------------------------------------------------------ */

function findAppModel(appId) {
  try {
    // eslint-disable-next-line global-require
    const discovery = require("./discovery");
    return discovery.findApp(appId) || null;
  } catch (_) {
    return null;
  }
}

function safeSettings() {
  try {
    return config.load();
  } catch (_) {
    return {};
  }
}

module.exports = {
  RETENTION,
  REASONS,
  SUFFIX,
  maybeSnapshot,
  maybeSnapshotForUpdate,
  list,
  get,
  findPreUpdate,
  entries,
  restore,
  remove,
  prune,
  // helpers worth testing / reusing
  planPaths,
  parseName,
  formatStamp,
  parseStamp,
  fileNameFor,
  snapshotDir,
  snapshotsRoot,
  resolveFile,
  homeDir,
  hasZstd,
  installedVersion,
};
