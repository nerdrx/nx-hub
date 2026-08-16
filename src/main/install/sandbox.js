"use strict";
// SPEC v0.8 "Sandbox profiles" — bubblewrap wrappers for the two kinds that
// launch a plain executable out of their own install dir (appimage,
// archive-dir).
//
//   confined = fresh tmpfs $HOME; only the app's install dir and its overlay
//              `configPaths` bound rw; the read-only system (/usr /etc /lib*
//              /opt /sys); display sockets (wayland / X11 / pipewire / pulse)
//              and /dev/dri; network SHARED.
//   offline  = confined minus the network (--unshare-net).
//   none     = no wrapper at all (also what a missing bwrap degrades to).
//
// Design notes
// ------------
// * This module never spawns anything itself. It builds an argv PREFIX; the
//   engine still calls util.spawnDetached, so launch tracking (v0.6) keeps
//   seeing a real ChildProcess — the tracked pid is now bwrap's, which is
//   exactly what we want: `--die-with-parent` ties the app's life to it, and
//   a stack stop SIGTERMing that pid tears the sandbox down with it.
// * Everything the app's own launch spec produces (ELECTRON_DISABLE_SANDBOX,
//   appPrefs.launchArgs / launchEnv, cwd) is applied by the engine BEFORE we
//   wrap, so it lands INSIDE the sandbox: the env is inherited through bwrap
//   and the args stay attached to the command.
// * Nothing here is fatal. Any surprise (no bwrap, unreadable path, junk
//   profile) degrades to an unwrapped launch and one log line.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The values an overlay / appPrefs may carry. "inherit" only in appPrefs. */
const PROFILES = ["none", "confined", "offline"];
/** Only these kinds are ever wrapped (SPEC: never tarball-prefix/apk/windows). */
const SANDBOXABLE_KINDS = ["appimage", "archive-dir"];

/** Directories bound read-only when they exist (symlinks are recreated). */
const RO_PATHS = ["/usr", "/etc", "/opt", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/sys"];

/* ------------------------------------------------------------------ */
/* bwrap discovery (cached — a PATH scan per launch is silly)          */
/* ------------------------------------------------------------------ */

let bwrapCache; // undefined = not looked up yet, string = path, null = absent
let missingLogged = false;

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Absolute path to `bwrap`, or null. Result is cached for the process;
 * `_reset()` clears it (tests).
 */
function bwrapPath() {
  if (bwrapCache !== undefined) return bwrapCache;
  const override = process.env.NX_HUB_BWRAP;
  if (override) {
    bwrapCache = isExecutableFile(override) ? override : null;
    return bwrapCache;
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "bwrap");
    if (isExecutableFile(candidate)) {
      bwrapCache = candidate;
      return bwrapCache;
    }
  }
  bwrapCache = null;
  return bwrapCache;
}

function available() {
  return Boolean(bwrapPath());
}

/** Test hook: forget the cached lookup (and the "logged once" latch). */
function _reset() {
  bwrapCache = undefined;
  missingLogged = false;
}

/* ------------------------------------------------------------------ */
/* profile resolution                                                  */
/* ------------------------------------------------------------------ */

/** A usable profile name, or null when the value means nothing to us. */
function normalizeProfile(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "inherit" || v === "") return null; // "ask the next layer down"
  return PROFILES.includes(v) ? v : null;
}

/**
 * SPEC: appPrefs.sandbox → artifact overlay → app overlay → "none".
 * Only the kinds that launch a plain binary can be wrapped at all.
 * @returns {"none"|"confined"|"offline"}
 */
function resolveProfile({ appPrefs, app, artifact } = {}) {
  const kind = artifact && artifact.kind;
  if (kind && !SANDBOXABLE_KINDS.includes(kind)) return "none";
  return (
    normalizeProfile(appPrefs && appPrefs.sandbox) ||
    normalizeProfile(artifact && artifact.sandbox) ||
    normalizeProfile(app && app.sandbox) ||
    "none"
  );
}

/** The overlay's configPaths for this launch (artifact wins over app). */
function resolveConfigPaths({ app, artifact } = {}) {
  const pick = (v) => (Array.isArray(v) && v.length ? v : null);
  const list = pick(artifact && artifact.configPaths) || pick(app && app.configPaths) || [];
  return list.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
}

/* ------------------------------------------------------------------ */
/* argv construction                                                   */
/* ------------------------------------------------------------------ */

function expandHome(p, home) {
  if (!p) return null;
  let s = String(p);
  if (s === "~") return home;
  if (s.startsWith("~/")) s = path.join(home, s.slice(2));
  else if (s.startsWith("$HOME/")) s = path.join(home, s.slice(6));
  else if (s === "$HOME") return home;
  return path.isAbsolute(s) ? path.normalize(s) : null; // relative config paths are meaningless here
}

function statType(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    return "file";
  } catch (_) {
    return null;
  }
}

/** `--ro-bind` a real dir, or recreate the host's symlink (Arch's /lib → usr/lib). */
function roBindOrSymlink(argv, p) {
  const type = statType(p);
  if (!type) return;
  if (type === "symlink") {
    let target = null;
    try {
      target = fs.readlinkSync(p);
    } catch (_) {
      return;
    }
    if (target) argv.push("--symlink", target, p);
    return;
  }
  argv.push("--ro-bind", p, p);
}

/** Sockets under $XDG_RUNTIME_DIR that a GUI app legitimately needs. */
function runtimeSockets(runtimeDir) {
  const out = [];
  if (!runtimeDir || statType(runtimeDir) !== "dir") return out;
  let entries = [];
  try {
    entries = fs.readdirSync(runtimeDir);
  } catch (_) {
    return out;
  }
  for (const name of entries) {
    const keep =
      /^wayland-\d+$/.test(name) ||
      /^pipewire-\d+$/.test(name) ||
      name === "pulse" ||
      name === "pipewire-0.lock" ||
      // D-Bus session bus: tray icons (SNI) and desktop portals need it, and a
      // sandbox that silently breaks the tray just gets switched off.
      name === "bus";
    if (!keep) continue;
    out.push(path.join(runtimeDir, name));
  }
  return out;
}

/**
 * Build the bwrap argv prefix for one launch.
 *
 * @param {string} profile              "confined" | "offline" | anything else
 * @param {object} o
 * @param {string} o.installDir         bound rw (the app writes next to itself)
 * @param {string[]} [o.configPaths]    overlay configPaths, `~` allowed; bound rw when they exist
 * @param {string} [o.home]             defaults to os.homedir()
 * @param {string} [o.cwd]              --chdir target (must be visible inside)
 * @param {object} [o.env]              the env the app will run with (read for XDG_RUNTIME_DIR)
 * @returns {string[]|null} argv AFTER the bwrap binary, or null when this
 *                          profile means "do not wrap"
 */
function buildBwrapArgs(profile, o = {}) {
  const p = normalizeProfile(profile);
  if (!p || p === "none") return null;

  const env = o.env && typeof o.env === "object" ? o.env : process.env;
  const home = o.home || env.HOME || os.homedir();
  const runtimeDir = env.XDG_RUNTIME_DIR || null;
  const installDir = o.installDir ? path.resolve(o.installDir) : null;

  // NO --die-with-parent: quitting the launcher must never take a running app
  // down with it — sandboxed launches outlive the hub like every other launch.
  // (Killing the tracked bwrap pid still stops the app: bwrap parents the pid
  // namespace, so its death tears the sandbox down.)
  const argv = ["--unshare-all"];
  if (p === "confined") argv.push("--share-net"); // offline keeps --unshare-net

  argv.push("--proc", "/proc", "--dev", "/dev");

  // read-only system
  for (const ro of RO_PATHS) roBindOrSymlink(argv, ro);

  // writable, ephemeral: everything the app is allowed to scribble on
  argv.push("--tmpfs", "/tmp");
  argv.push("--tmpfs", home, "--setenv", "HOME", home);
  if (runtimeDir) argv.push("--tmpfs", runtimeDir);

  // display / audio / gpu — bound AFTER the tmpfs that would otherwise hide them
  if (statType("/dev/dri") === "dir") argv.push("--dev-bind", "/dev/dri", "/dev/dri");
  for (const sock of runtimeSockets(runtimeDir)) argv.push("--bind", sock, sock);
  if (statType("/tmp/.X11-unix")) argv.push("--ro-bind", "/tmp/.X11-unix", "/tmp/.X11-unix");

  // the app itself
  if (installDir && statType(installDir)) argv.push("--bind", installDir, installDir);

  // its config (SPEC: overlay configPaths — the same list the time machine
  // snapshots, so "what survives an update" and "what the app may write" agree)
  const seen = new Set(installDir ? [installDir] : []);
  for (const raw of o.configPaths || []) {
    const abs = expandHome(raw, home);
    if (!abs || seen.has(abs) || !statType(abs)) continue;
    seen.add(abs);
    argv.push("--bind", abs, abs);
  }

  if (o.cwd) argv.push("--chdir", path.resolve(o.cwd));
  return argv;
}

/**
 * Wrap one launch. The engines call exactly this.
 *
 * @param {object} ctx   the launch ctx (ctx.sandboxProfile / ctx.sandboxConfigPaths come from jobs.launch)
 * @param {object} spec  {cmd, args, installDir, cwd, env}
 * @returns {{cmd: string, args: string[], wrapped: boolean, profile: string}}
 */
function wrapLaunch(ctx = {}, spec = {}) {
  const cmd = spec.cmd;
  const args = Array.isArray(spec.args) ? spec.args : [];
  const plain = { cmd, args, wrapped: false, profile: "none" };
  const log = typeof ctx.log === "function" ? ctx.log : () => {};

  const profile = normalizeProfile(ctx.sandboxProfile);
  if (!profile || profile === "none") return plain;

  const bwrap = bwrapPath();
  if (!bwrap) {
    // SPEC: no bwrap → log once, launch unwrapped.
    if (!missingLogged) {
      missingLogged = true;
      log(`sandbox: bwrap is not on PATH — launching unconfined (profile "${profile}")`);
    } else {
      log(`sandbox: bwrap missing, unconfined (profile "${profile}")`);
    }
    return plain;
  }

  let prefix = null;
  try {
    prefix = buildBwrapArgs(profile, {
      installDir: spec.installDir,
      configPaths: spec.configPaths || ctx.sandboxConfigPaths || [],
      cwd: spec.cwd,
      env: spec.env,
      home: spec.home,
    });
  } catch (e) {
    log(`sandbox: could not build a ${profile} sandbox (${e.message}) — launching unconfined`);
    return plain;
  }
  if (!prefix) return plain;

  log(`sandbox: ${profile} (bwrap ${prefix.length} args, network ${profile === "offline" ? "off" : "on"})`);
  return { cmd: bwrap, args: [...prefix, cmd, ...args], wrapped: true, profile };
}

module.exports = {
  PROFILES,
  SANDBOXABLE_KINDS,
  bwrapPath,
  available,
  normalizeProfile,
  resolveProfile,
  resolveConfigPaths,
  buildBwrapArgs,
  wrapLaunch,
  _reset,
};
