"use strict";
// NX Hub — dev links (SPEC v0.7 "nx dev").
//
// A dev link points an app id at a WORKING TREE on this machine: the build you
// are hacking on right now, launched from where it lives, with no install, no
// download and no version tracking. The store is `<dataDir>/dev.json`:
//
//   { version: 1, links: [{ appId, path, launchCmd?, name? }] }
//
// Deliberately tiny in scope. Discovery only ever learns that a link EXISTS
// (`app.devLink = {path}` — a model flag), the launcher gets a badged tile, and
// `nx dev run` spawns it. Nothing here reads, builds or installs the tree.
//
// Pure node, no electron. `config` is the only hub collaborator (dataDir +
// atomic writes); the install engine's helpers are required LAZILY, so a plain
// `nx dev ls` never pulls child_process in.

const fs = require("fs");
const path = require("path");
const os = require("os");

const config = require("./config");

const STORE_NAME = "dev.json";
/** How deep `nx dev run` looks for a launch binary. A source tree is not an
 *  install dir: `build/bin/app` must be found, `node_modules/**` must not. */
const MAX_DEPTH = 3;
const MAX_FILES = 4000;

/** Never worth walking in a working tree — noise, and enormous. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".venv", "venv", ".cache", ".direnv", ".idea", ".vscode", ".gradle", ".tox",
]);

/** Extensions that are never a launch target (mirrors install/util's set). */
const NON_BINARY_EXT = new Set([
  ".so", ".dll", ".dylib", ".pak", ".dat", ".bin", ".json", ".txt", ".md",
  ".png", ".jpg", ".svg", ".ico", ".pdb", ".log", ".xml", ".html", ".css",
  ".pck", ".zip", ".gz", ".desktop", ".config", ".ttf", ".o", ".a", ".lock",
]);

function log(msg) {
  try {
    config.log(`[devlinks] ${msg}`);
  } catch (_) {
    /* logging must never break a link */
  }
}

/* ------------------------------------------------------------------ */
/* the model                                                           */
/* ------------------------------------------------------------------ */

/**
 * "My VR Stack!" → "my-vr-stack" — ordinal, locale-independent.
 *
 * Copied (not imported) from stacks.js on purpose: an app id has to slug the
 * same way everywhere, and this module must not depend on the stacks store.
 */
function slugify(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function expandUser(p) {
  const s = String(p == null ? "" : p);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** A path the way we store it: ~ expanded, absolute, no trailing slash. */
function normalizePath(p) {
  const raw = expandUser(p).trim();
  if (!raw) return "";
  const abs = path.resolve(raw);
  return abs.length > 1 ? abs.replace(/[/\\]+$/, "") : abs;
}

/** Does this path exist AND is it a directory? */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Whatever a hand-edited dev.json (or an IPC caller) says → a record we trust,
 * or null. Never throws: a junk entry is dropped, the rest of the file lives.
 */
function sanitizeLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = normalizePath(raw.path);
  if (!p) return null;
  const appId = slugify(raw.appId) || slugify(path.basename(p));
  if (!appId) return null;
  const link = { appId, path: p };
  const cmd = typeof raw.launchCmd === "string" ? raw.launchCmd.trim() : "";
  if (cmd) link.launchCmd = cmd;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (name) link.name = name;
  return link;
}

/** What the UI/CLI calls this link when it has no `name`. */
function displayName(link) {
  return (link && (link.name || link.appId)) || "";
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

function storePath() {
  return path.join(config.dataDir(), STORE_NAME);
}

/** mtime-keyed memo — discovery asks per app on every rebuild. */
let memo = { key: null, store: null };

function parseStore(raw) {
  const list = raw && Array.isArray(raw.links) ? raw.links : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const links = [];
  for (const entry of list) {
    const link = sanitizeLink(entry);
    if (!link || seen.has(link.appId)) continue; // junk and duplicates never survive a read
    seen.add(link.appId);
    links.push(link);
  }
  return { version: 1, links };
}

/**
 * @param {{cached?:boolean}} [opts] `cached` reuses the last parse while the
 *        file's (path, mtime, size) is unchanged — for discovery's hot path.
 */
function readStore({ cached = false } = {}) {
  const file = storePath();
  if (!cached) return parseStore(config.readJson(file, null));
  let key;
  try {
    const st = fs.statSync(file);
    key = `${file}:${st.mtimeMs}:${st.size}`;
  } catch (_) {
    key = `${file}:none`;
  }
  if (memo.key === key && memo.store) return memo.store;
  const store = parseStore(config.readJson(file, null));
  memo = { key, store };
  return store;
}

function writeStore(store) {
  config.ensureDir(config.dataDir());
  config.writeJsonAtomic(storePath(), { version: 1, links: store.links });
  memo = { key: null, store: null };
  return store;
}

/** Every link, in insertion order. */
function list() {
  return readStore().links;
}

/** One link by app id (exact, slugged). Fresh read — CRUD must never be stale. */
function get(appId) {
  const wanted = slugify(appId);
  if (!wanted) return null;
  return list().find((l) => l.appId === wanted) || null;
}

/**
 * The same lookup discovery uses, off the memo. Callers must treat the result
 * as READ-ONLY (it is the cached record itself).
 */
function linkFor(appId) {
  const wanted = slugify(appId);
  if (!wanted) return null;
  return readStore({ cached: true }).links.find((l) => l.appId === wanted) || null;
}

/**
 * Create or replace a link.
 * @param {{path:string, appId?:string, launchCmd?:string, name?:string}} raw
 * @returns {object} the record actually stored
 * @throws when the path is missing, is not a directory, or the id is empty
 */
function link(raw) {
  const requested = raw && raw.path;
  if (!requested) throw new Error("A dev link needs a path");
  const p = normalizePath(requested);
  if (!fs.existsSync(p)) throw new Error(`No such directory: ${p}`);
  if (!isDir(p)) throw new Error(`Not a directory: ${p}`);

  const record = sanitizeLink(Object.assign({}, raw, { path: p }));
  if (!record) throw new Error(`Cannot derive an app id from ${p} — pass --app <id>`);

  const store = readStore();
  const idx = store.links.findIndex((l) => l.appId === record.appId);
  const replaced = idx >= 0 ? store.links[idx] : null;
  if (idx >= 0) store.links[idx] = record;
  else store.links.push(record);
  writeStore(store);
  log(`${replaced ? "relinked" : "linked"} ${record.appId} → ${record.path}`);
  return record;
}

/** @returns {boolean} was there anything to remove? */
function unlink(appId) {
  const wanted = slugify(appId);
  const store = readStore();
  const before = store.links.length;
  store.links = store.links.filter((l) => l.appId !== wanted);
  if (store.links.length === before) return false;
  writeStore(store);
  log(`unlinked ${wanted}`);
  return true;
}

/** Test hook: forget the memo (the file on disk is untouched). */
function _reset() {
  memo = { key: null, store: null };
}

/* ------------------------------------------------------------------ */
/* resolving what to run                                               */
/* ------------------------------------------------------------------ */

/**
 * "./build/app --dev" → {cmd, args}. Same convention as the install engine's
 * tarball-prefix launchCmd: whitespace split, `~` expanded, NO SHELL — the
 * string never reaches `sh -c`.
 *
 * A command that names a path (contains a separator) is resolved against the
 * link's directory, so `./run.sh` means the tree's run.sh whatever the caller's
 * cwd is; a bare name (`npm`) is left for PATH lookup.
 */
function parseCommand(launchCmd, cwd) {
  const raw = String(launchCmd == null ? "" : launchCmd).trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  let cmd = expandUser(parts[0]);
  if (!path.isAbsolute(cmd) && /[/\\]/.test(cmd) && cwd) cmd = path.resolve(cwd, cmd);
  return { cmd, args: parts.slice(1) };
}

function looksLikeLibrary(rel) {
  const base = path.basename(rel).toLowerCase();
  if (/\.so(\.\d+)*$/.test(base)) return true;
  return NON_BINARY_EXT.has(path.extname(base));
}

/**
 * Executable regular files in a working tree, shallow first.
 *
 * NOT install/util.pickBinary: that one walks an install dir with no depth
 * limit and CHMODs what it finds. Both are wrong for a live source checkout
 * (node_modules alone can be six figures of files, and the hub must never
 * flip permission bits inside the user's repo). The scoring below is the same
 * shape as pickBinary's, minus the recovery pass.
 *
 * @returns {{abs:string, rel:string, size:number, depth:number}[]}
 */
function candidates(dir, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // symlinks and sockets are never the target
      let st;
      try {
        st = fs.statSync(abs);
      } catch (_) {
        continue;
      }
      if (!st.isFile() || (st.mode & 0o111) === 0) continue;
      const rel = path.relative(dir, abs);
      if (looksLikeLibrary(rel)) continue;
      out.push({ abs, rel, size: st.size, depth });
    }
  };
  walk(dir, 0);
  return out;
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The most launch-looking executable in the tree, or null.
 * Order: name match (app id / directory name) → shallow → large.
 */
function pickDevBinary(dir, { names = [], list: files = null } = {}) {
  const rows = files || candidates(dir);
  if (!rows.length) return null;
  const wanted = names.map(normalizeName).filter(Boolean);
  const score = (f) => {
    const base = normalizeName(path.basename(f.rel, path.extname(f.rel)));
    let s = 0;
    if (wanted.includes(base)) s += 1000;
    else if (wanted.some((w) => w && (base.startsWith(w) || w.startsWith(base)))) s += 500;
    if (path.basename(f.rel) === "AppRun") s += 400;
    s -= f.depth * 20; // prefer shallow
    s += Math.min(100, Math.log10(Math.max(f.size, 1)) * 10);
    return s;
  };
  // ordinal tiebreak on rel — never localeCompare, the host locale must not
  // decide which binary a dev link launches.
  const sorted = rows
    .slice()
    .sort((a, b) => score(b) - score(a) || b.size - a.size || (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1));
  return sorted[0];
}

/**
 * What `nx dev run <id>` (and IPC devRun) will execute.
 *
 * Order per SPEC v0.7: explicit launchCmd → the binary heuristic → an error
 * that names what WAS found, so the user can pick one with --cmd.
 *
 * @returns {{cmd:string, args:string[], cwd:string, source:"launchCmd"|"heuristic"}}
 * @throws {Error} with `.candidates` (relative paths) when nothing resolves
 */
function resolveLaunch(link, { names = [] } = {}) {
  if (!link) throw new Error("Unknown dev link");
  const cwd = link.path;
  if (!isDir(cwd)) {
    const e = new Error(`The linked directory is gone: ${cwd}`);
    e.candidates = [];
    throw e;
  }

  const explicit = parseCommand(link.launchCmd, cwd);
  if (explicit) return { cmd: explicit.cmd, args: explicit.args, cwd, source: "launchCmd" };

  const rows = candidates(cwd);
  const hints = [link.appId, link.name, path.basename(cwd), ...names].filter(Boolean);
  const chosen = pickDevBinary(cwd, { names: hints, list: rows });
  if (chosen) return { cmd: chosen.abs, args: [], cwd, source: "heuristic" };

  const e = new Error(`Nothing executable found in ${cwd}`);
  e.candidates = rows.map((f) => f.rel);
  throw e;
}

/**
 * Spawn a dev link, fully detached: cwd = the linked tree, no stdio inherited,
 * survives the hub (or the `nx` process) quitting.
 *
 * @returns {{pid:number, cmd:string, args:string[], cwd:string, source:string}}
 */
function run(appId, { names = [], env } = {}) {
  const link = get(appId);
  if (!link) throw new Error(`No dev link called "${appId}"`);
  const spec = resolveLaunch(link, { names });
  // lazily required: `nx dev ls` has no business loading the install engine
  // eslint-disable-next-line global-require
  const { spawnDetached } = require("./install/util");
  log(`run ${link.appId}: ${spec.cmd} ${spec.args.join(" ")}`.trim());
  const child = spawnDetached(spec.cmd, spec.args, { cwd: spec.cwd, env: env || process.env });
  return { pid: child.pid, cmd: spec.cmd, args: spec.args, cwd: spec.cwd, source: spec.source };
}

module.exports = {
  STORE_NAME,
  MAX_DEPTH,
  SKIP_DIRS,
  storePath,
  slugify,
  expandUser,
  normalizePath,
  isDir,
  sanitizeLink,
  displayName,
  parseStore,
  readStore,
  writeStore,
  list,
  get,
  linkFor,
  link,
  unlink,
  parseCommand,
  candidates,
  pickDevBinary,
  resolveLaunch,
  run,
  _reset,
};
