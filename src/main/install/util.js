"use strict";
// Shared helpers for the install engines.
// No Electron imports here on purpose: every engine module must be unit-testable
// with plain `node --test`.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const MANIFEST_NAME = ".nx-manifest.json";

/** Expand a leading `~` (and `$HOME`) to the user's home directory. */
function expandUser(p) {
  if (!p) return p;
  let s = String(p);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  else if (s.startsWith("$HOME/")) s = path.join(os.homedir(), s.slice(6));
  return s;
}

/** Normalize the ctx the core hands us so engines can rely on every field. */
function normCtx(ctx = {}) {
  return {
    dataDir: ctx.dataDir || path.join(os.homedir(), ".local/share/nx-hub"),
    installRoot: ctx.installRoot || path.join(os.homedir(), "Applications"),
    settings: ctx.settings || {},
    log: typeof ctx.log === "function" ? ctx.log : () => {},
    emitProgress:
      typeof ctx.emitProgress === "function" ? ctx.emitProgress : () => {},
    signal: ctx.signal || null,
    // Optional: absolute path to an icon core wants used when we can't extract
    // one from the artifact (e.g. assets/icon.png). Safe to omit.
    fallbackIcon: ctx.fallbackIcon || null,
    // v0.2: this app's user preferences ({launchArgs, launchEnv, …}); core
    // threads them through so launch() can honour them.
    appPrefs: ctx.appPrefs && typeof ctx.appPrefs === "object" ? ctx.appPrefs : {},
    // v0.8: the sandbox profile jobs.launch resolved (appPrefs → overlay) and
    // the overlay's configPaths. Only launch() reads them, and only the kinds
    // that start a plain binary act on them (see install/sandbox.js).
    sandboxProfile: typeof ctx.sandboxProfile === "string" ? ctx.sandboxProfile : "none",
    sandboxConfigPaths: Array.isArray(ctx.sandboxConfigPaths) ? ctx.sandboxConfigPaths : [],
    raw: ctx,
  };
}

/**
 * Merge the per-app launch preferences into a spawn spec (SPEC v0.2):
 * `launchArgs` are APPENDED to the engine's own args, `launchEnv` is layered
 * over the inherited environment.
 */
function launchExtras(ctx, base = {}) {
  const prefs = (ctx && ctx.appPrefs) || {};
  const extraArgs = Array.isArray(prefs.launchArgs)
    ? prefs.launchArgs.filter((a) => typeof a === "string" && a.length).map(String)
    : [];
  const args = [...(base.args || []), ...extraArgs];
  const env = Object.assign({}, base.env || process.env);
  if (prefs.launchEnv && typeof prefs.launchEnv === "object" && !Array.isArray(prefs.launchEnv)) {
    for (const [k, v] of Object.entries(prefs.launchEnv)) {
      if (v == null || typeof v === "object") continue;
      env[k] = String(v);
    }
  }
  return { args, env };
}

class AbortError extends Error {
  constructor(msg = "Operation cancelled") {
    super(msg);
    this.name = "AbortError";
    this.code = "ABORT_ERR";
  }
}

function throwIfAborted(ctx) {
  if (ctx && ctx.signal && ctx.signal.aborted) throw new AbortError();
}

/** `<installRoot>/nx/<appId>/<artifactId>/` */
function installDirFor(app, artifact, ctx) {
  return path.join(
    ctx.installRoot,
    "nx",
    String(app.id),
    String(artifact.id)
  );
}

async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function rand() {
  return crypto.randomBytes(5).toString("hex");
}

/**
 * Run a command, capturing stdout/stderr (never inherits the parent's stdio).
 * Resolves with {code, stdout, stderr, missing} — it does NOT reject on a
 * non-zero exit; callers decide. `missing` is true when the binary is absent.
 */
function run(cmd, args, opts = {}) {
  const { cwd, env, signal, timeout = 0, input } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env || process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err.message), missing: err.code === "ENOENT", error: err });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeout);
    }
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const done = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      resolve(res);
    };
    child.on("error", (err) => {
      done({
        code: -1,
        stdout,
        stderr: stderr || String(err.message),
        missing: err.code === "ENOENT",
        error: err,
      });
    });
    child.on("close", (code, sig) => {
      done({ code: code == null ? -1 : code, signal: sig, stdout, stderr, missing: false });
    });
    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** run() + throw a friendly Error when the command fails. */
async function runOk(cmd, args, opts = {}, what) {
  const res = await run(cmd, args, opts);
  if (res.missing) {
    throw new Error(`${cmd} not found — install it and try again`);
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim().split("\n").slice(-4).join("\n");
    throw new Error(
      `${what || `${cmd} ${args.join(" ")}`} failed (exit ${res.code})${detail ? `: ${detail}` : ""}`
    );
  }
  return res;
}

/**
 * v0.6 crash tracking: every detached spawn is announced to whoever asked to
 * listen (jobs.launch does, around engine.launch) so the core can watch the
 * process WITHOUT the engines having to hand their ChildProcess back through
 * every launch() return value.
 *
 * Why this is safe: `unref()` only removes the handle from the event loop's
 * ref count — it does NOT sever the parent/child relationship. An unref'd,
 * detached child still emits 'exit' with its real exit code as long as the
 * hub's loop is alive, and still outlives the hub when it is not. So the
 * listener gets SPEC-exact exit codes with zero change to detachment.
 */
const spawnListeners = new Set();

/** Subscribe to detached spawns. @returns {function} unsubscribe */
function onSpawn(fn) {
  if (typeof fn !== "function") return () => {};
  spawnListeners.add(fn);
  return () => spawnListeners.delete(fn);
}

/**
 * Spawn a program for the user, fully detached: no stdio inherited from the
 * hub, survives the hub quitting.
 */
function spawnDetached(cmd, args = [], opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (const fn of [...spawnListeners]) {
    try {
      fn(child, { cmd, args, opts });
    } catch (_) {
      /* a broken listener must never break a launch */
    }
  }
  return child;
}

// ---------------------------------------------------------------------------
// manifests

function manifestPath(installDir) {
  return path.join(installDir, MANIFEST_NAME);
}

async function writeManifest(installDir, data) {
  const manifest = {
    version: data.version ?? null,
    kind: data.kind,
    files: data.files || [], // absolute paths written OUTSIDE the install dir
    dirs: data.dirs || [], // absolute dirs we created outside the install dir
    desktopEntries: data.desktopEntries || [],
    binary: data.binary ?? null, // launch target, relative to the install dir
    installedAt: data.installedAt || new Date().toISOString(),
    ...(data.extra || {}),
  };
  await mkdirp(installDir);
  await fsp.writeFile(manifestPath(installDir), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readManifest(installDir) {
  try {
    const txt = await fsp.readFile(manifestPath(installDir), "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// staged (atomic-ish) installs

/** `<installDir>.prev` — the version kept for one-click rollback (SPEC v0.2). */
function prevDirFor(installDir) {
  return `${installDir}.prev`;
}

async function hasPrev(installDir) {
  return isDir(prevDirFor(installDir));
}

/**
 * Swap `<installDir>.prev` back into place (SPEC v0.2 rollback).
 *
 * The current install is first renamed to a staging name; only then does .prev
 * move in. If that second rename fails, the current install is put straight
 * back — so a failure can never destroy BOTH copies. On success the replaced
 * version becomes the new .prev, so the user can roll forward again.
 */
async function rollbackDir(installDir) {
  const prev = prevDirFor(installDir);
  if (!(await isDir(prev))) {
    throw new Error("No previous version kept for this install — nothing to roll back to");
  }
  const parent = path.dirname(installDir);
  const stash = path.join(parent, `.${path.basename(installDir)}.rollback-${rand()}`);

  let stashed = false;
  if (await exists(installDir)) {
    await fsp.rename(installDir, stash);
    stashed = true;
  }
  try {
    await fsp.rename(prev, installDir);
  } catch (err) {
    if (stashed) await fsp.rename(stash, installDir).catch(() => {});
    throw new Error(`Rollback failed: ${err.message}`);
  }
  if (stashed) {
    // keep what we just replaced as the new .prev (roll forward)
    try {
      await fsp.rename(stash, prev);
    } catch {
      await rmrf(stash).catch(() => {});
    }
  }
  return { path: installDir, prev };
}

/**
 * Run `fn(stageDir)` against a fresh sibling directory, then swap it into place
 * as `installDir`. A failure anywhere leaves the previous install untouched and
 * no partial install dir behind — which is the whole point.
 *
 * With `{keepPrev: true}` the replaced install is retained as `<installDir>.prev`
 * (replacing any older one) instead of being deleted — that is what rollback
 * restores. Only dir-based kinds ask for it.
 */
async function stagedInstall(installDir, fn, { keepPrev = false } = {}) {
  const parent = path.dirname(installDir);
  const base = path.basename(installDir);
  await mkdirp(parent);
  const stage = path.join(parent, `.${base}.new-${rand()}`);
  const backup = path.join(parent, `.${base}.old-${rand()}`);
  await rmrf(stage);
  await mkdirp(stage);
  let result;
  try {
    result = await fn(stage);
  } catch (err) {
    await rmrf(stage).catch(() => {});
    throw err;
  }
  // swap
  let hadOld = false;
  try {
    if (await exists(installDir)) {
      await fsp.rename(installDir, backup);
      hadOld = true;
    }
    await fsp.rename(stage, installDir);
  } catch (err) {
    // put the old one back, drop the stage
    if (hadOld && !(await exists(installDir))) {
      await fsp.rename(backup, installDir).catch(() => {});
    }
    await rmrf(stage).catch(() => {});
    throw err;
  }
  if (hadOld && keepPrev) {
    const prev = prevDirFor(installDir);
    await rmrf(prev).catch(() => {});
    try {
      await fsp.rename(backup, prev);
      return result;
    } catch {
      /* keeping .prev is best-effort — never fail an install over it */
    }
  }
  await rmrf(backup).catch(() => {});
  return result;
}

/** A scratch dir on the SAME filesystem as the install root (rename-safe). */
async function withWorkDir(nearDir, fn) {
  const parent = path.dirname(nearDir);
  await mkdirp(parent);
  const work = path.join(parent, `.nxwork-${rand()}`);
  await mkdirp(work);
  try {
    return await fn(work);
  } finally {
    await rmrf(work).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// filesystem walking / binary heuristics

/** Recursively list regular files (returns {abs, rel, size, mode, isSymlink}). */
async function walkFiles(root, opts = {}) {
  const out = [];
  const maxEntries = opts.max || 200000;
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(abs);
      } else if (e.isFile() || e.isSymbolicLink()) {
        let st = null;
        try {
          st = await fsp.lstat(abs);
        } catch {
          continue;
        }
        out.push({
          abs,
          rel: path.relative(root, abs),
          size: st.size,
          mode: st.mode,
          isSymlink: st.isSymbolicLink(),
        });
      }
    }
  }
  await rec(root);
  return out;
}

function isExecMode(mode) {
  return (mode & 0o111) !== 0;
}

/** Cheap magic sniff: ELF binary or shebang script. */
async function looksExecutable(file) {
  let fh;
  try {
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return "elf";
    }
    if (bytesRead >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return "script";
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NON_BINARY_EXT = new Set([
  ".so", ".dll", ".dylib", ".pak", ".dat", ".bin", ".json", ".txt", ".md",
  ".png", ".jpg", ".svg", ".ico", ".pdb", ".log", ".xml", ".html", ".css",
  ".js", ".pck", ".zip", ".gz", ".desktop", ".config", ".ttf",
]);

function looksLikeLibrary(rel) {
  const base = path.basename(rel).toLowerCase();
  if (/\.so(\.\d+)*$/.test(base)) return true;
  const ext = path.extname(base);
  if (NON_BINARY_EXT.has(ext)) return true;
  const parts = rel.split(path.sep).map((p) => p.toLowerCase());
  if (parts.some((p) => p === "lib" || p === "lib64" || p === "locales" || p === "resources")) {
    // still allow the very top-level launcher inside such a dir to lose, not vanish
    return true;
  }
  return false;
}

/**
 * Pick the launch binary inside an extracted tree.
 * Order: binHint → name match (app id / repo / asset) → shallowest+largest
 * executable that doesn't look like a library. Restores exec bits when the
 * archive dropped them (zip) using ELF/shebang magic.
 */
async function pickBinary(root, { hint, names = [], ctx } = {}) {
  const log = ctx?.log || (() => {});
  if (hint) {
    const direct = path.join(root, hint);
    if (await exists(direct)) {
      await fsp.chmod(direct, 0o755).catch(() => {});
      return path.relative(root, direct);
    }
    // hint may be just a basename somewhere in the tree
    const all = await walkFiles(root);
    const byBase = all.find((f) => path.basename(f.rel) === path.basename(hint));
    if (byBase) {
      await fsp.chmod(byBase.abs, 0o755).catch(() => {});
      return byBase.rel;
    }
    log(`binHint "${hint}" not found in archive — falling back to heuristic`);
  }

  const all = (await walkFiles(root)).filter((f) => !f.isSymlink);
  let candidates = all.filter((f) => isExecMode(f.mode));
  if (candidates.length === 0) {
    // zip archives lose the exec bit — recover it from file magic
    const recovered = [];
    for (const f of all) {
      if (f.size < 64) continue;
      if (path.extname(f.rel).toLowerCase() === ".so") continue;
      const kind = await looksExecutable(f.abs);
      if (kind) {
        await fsp.chmod(f.abs, 0o755).catch(() => {});
        recovered.push(f);
      }
    }
    candidates = recovered;
    if (recovered.length) log(`restored exec bit on ${recovered.length} file(s)`);
  }
  if (candidates.length === 0) return null;

  const wanted = names.map(normalizeName).filter(Boolean);
  const score = (f) => {
    const base = normalizeName(path.basename(f.rel, path.extname(f.rel)));
    let s = 0;
    if (wanted.includes(base)) s += 1000;
    else if (wanted.some((w) => w && (base.startsWith(w) || w.startsWith(base)))) s += 500;
    if (path.basename(f.rel) === "AppRun") s += 400;
    if (!looksLikeLibrary(f.rel)) s += 200;
    s -= f.rel.split(path.sep).length * 20; // prefer shallow
    s += Math.min(100, Math.log10(Math.max(f.size, 1)) * 10);
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a) || b.size - a.size);
  const chosen = candidates[0];
  await fsp.chmod(chosen.abs, 0o755).catch(() => {});
  return chosen.rel;
}

/** Extract a zip / tarball into `dest` using system tools. */
async function extractArchive(filePath, dest, ctx) {
  await mkdirp(dest);
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    // unzip everywhere it exists (it restores unix modes); on Windows (and any
    // box without unzip) bsdtar/tar handles zip too.
    const res = await run("unzip", ["-q", "-o", filePath, "-d", dest], { signal: ctx?.signal });
    if (res.missing) {
      await runOk("tar", ["-xf", filePath, "-C", dest], { signal: ctx?.signal }, "tar (zip)");
    } else if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || "").trim().split("\n").slice(-3).join("\n");
      throw new Error(`unzip failed (exit ${res.code})${detail ? `: ${detail}` : ""}`);
    }
  } else if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tar\.zst|tar)$/.test(lower)) {
    // GNU tar auto-detects the compression with -f
    await runOk("tar", ["-xf", filePath, "-C", dest], { signal: ctx?.signal }, "tar");
  } else {
    throw new Error(`Unsupported archive format: ${path.basename(filePath)}`);
  }
}

/** Copy a file/symlink preserving mode; creates parent dirs. */
async function copyEntry(src, dst) {
  await mkdirp(path.dirname(dst));
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    const target = await fsp.readlink(src);
    await fsp.rm(dst, { force: true });
    await fsp.symlink(target, dst);
    return;
  }
  await fsp.copyFile(src, dst);
  await fsp.chmod(dst, st.mode & 0o7777).catch(() => {});
}

/**
 * Stop a launched app: every spawnDetached child leads its own process group,
 * so the NEGATIVE pid reaches the app plus everything it spawned — including
 * the app inside a bwrap sandbox, whose supervisor would otherwise die alone.
 * Falls back to the plain pid when the group is already gone.
 */
function killTree(pid, signal = "SIGTERM") {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(-n, signal);
    return true;
  } catch (_) {
    try {
      process.kill(n, signal);
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = {
  killTree,
  MANIFEST_NAME,
  AbortError,
  expandUser,
  normCtx,
  throwIfAborted,
  installDirFor,
  mkdirp,
  rmrf,
  exists,
  existsSync,
  isDir,
  rand,
  run,
  runOk,
  spawnDetached,
  onSpawn,
  manifestPath,
  writeManifest,
  readManifest,
  stagedInstall,
  prevDirFor,
  hasPrev,
  rollbackDir,
  launchExtras,
  withWorkDir,
  walkFiles,
  isExecMode,
  looksExecutable,
  pickBinary,
  extractArchive,
  copyEntry,
  normalizeName,
};
