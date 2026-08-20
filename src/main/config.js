"use strict";
// NX Hub — settings + paths + token resolution.
// Pure node: must be require-able without electron (unit tests depend on it).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Reserved for the future NX Connector bus (SPEC "Future"). Unused in v1.
const NX_CONNECTOR_PORT = 9021;

const APP_NAME = "nx-hub";

let tokenCache; // undefined = not resolved yet, null = resolved to anonymous
let logStreamPath = null;

function expandHome(p) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function dataDir() {
  return process.env.NX_HUB_DATA_DIR || path.join(os.homedir(), ".local", "share", APP_NAME);
}
function cacheDir() {
  return path.join(dataDir(), "cache");
}
function logsDir() {
  return path.join(dataDir(), "logs");
}
function downloadsDir() {
  return path.join(dataDir(), "downloads");
}
function settingsPath() {
  return path.join(dataDir(), "settings.json");
}
function statePath() {
  return path.join(dataDir(), "state.json");
}

/** SPEC v0.2: the three update policies, in escalating order. */
const UPDATE_POLICIES = ["notify", "download", "install"];

/** Per-app preference keys we accept — anything else is dropped on merge. */
const APP_PREF_KEYS = [
  "updatePolicy",
  "includePrereleases",
  "skippedVersion",
  "favorite",
  "launchArgs",
  "launchEnv",
  "hidden",
  "releaseFallback",
  "autoRunCmd",
  // ---- v0.8 ----
  "keepAlive", // supervisor: relaunch this app when it dies unexpectedly
  "sandbox", // per-app override of the overlay's sandbox profile
];

/**
 * SPEC v0.8: the sandbox profiles an app may be launched under. "inherit" is
 * appPrefs-only ("use whatever the overlay says"), and is stored rather than
 * dropped so the UI can show an explicit "inherit" choice.
 */
const SANDBOX_PROFILES = ["inherit", "none", "confined", "offline"];

function defaults() {
  return {
    owners: ["nerdrx", "Arikazei"],
    extraRepos: [],
    checkIntervalHours: 6,
    installRoot: path.join(os.homedir(), "Applications"),
    adbPath: "adb",
    token: null,
    // ---- v0.2 ----
    appPrefs: {},
    updatePolicy: "notify",
    includePrereleases: false,
    notifications: true,
    autostart: false,
    startMinimized: false,
    createDesktopEntries: true,
    maxConcurrentDownloads: 2,
    preferredDeviceSerial: null,
    // CLI: keep ~/.local/bin/nx pointing at this install (src/cli/shim.js)
    cliShim: true,
    // Run an artifact's overlay postInstallCmd automatically after a
    // successful install/update (privileged cmds skip on background installs)
    autoRunPostInstallCmd: false,
    // v0.7: prefer fetching verified assets from LAN peers before GitHub
    lanSeeding: true,
    // v0.8: refuse to install an UNSIGNED asset from an owner whose signing
    // key is pinned (src/main/provenance.js). A signature that is present and
    // wrong is fatal regardless of this setting.
    requireSignatures: false,
    // v0.6: hub-to-hub on the LAN — gates the UDP beacon AND the :9023 server
    // (src/main/fleet). Off means this hub is neither discoverable nor
    // reachable; already-paired peers simply go offline.
    fleet: true,
    // v0.10: exchange appPrefs and stacks with paired hubs (SPEC "Fleet
    // settings sync"). Gates BOTH directions — off means this hub neither
    // sends its preferences nor accepts a peer's.
    fleetSync: true,
  };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function bool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function trimmedString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * v0.10 [fabric2]: the last-write stamp on one app's prefs, epoch ms.
 *
 * PRESERVED but never INVENTED. Fleet settings sync resolves two hubs' copies
 * of an entry by comparing these, so a stamp has to survive every read/write
 * cycle the entry goes through — but a stamp minted by the sanitiser would
 * claim that reading a file was an edit, and the entry would then beat the real
 * edit on the other machine. Only setAppPref (the actual writer) stamps.
 */
function prefStamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/**
 * Clean ONE app's prefs. Unknown keys are dropped, values are type-checked,
 * arrays are taken as-is (never merged element-wise).
 * @returns {object} may be empty
 */
function sanitizeAppPref(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  const ts = prefStamp(raw._ts); // v0.10 — see prefStamp
  if (ts != null) out._ts = ts;

  if (UPDATE_POLICIES.includes(raw.updatePolicy)) out.updatePolicy = raw.updatePolicy;
  if (typeof raw.includePrereleases === "boolean") out.includePrereleases = raw.includePrereleases;
  if (typeof raw.favorite === "boolean") out.favorite = raw.favorite;
  if (typeof raw.hidden === "boolean") out.hidden = raw.hidden;
  // false = latest-release-only (the pre-0.2.6 behavior), per user request
  if (typeof raw.releaseFallback === "boolean") out.releaseFallback = raw.releaseFallback;
  // absent = inherit the global autoRunPostInstallCmd setting
  if (typeof raw.autoRunCmd === "boolean") out.autoRunCmd = raw.autoRunCmd;
  // v0.8: absent/false = the supervisor leaves this app alone
  if (typeof raw.keepAlive === "boolean") out.keepAlive = raw.keepAlive;
  // v0.8: absent (or "inherit") = fall through to the overlay's profile
  if (typeof raw.sandbox === "string" && SANDBOX_PROFILES.includes(raw.sandbox.trim().toLowerCase())) {
    out.sandbox = raw.sandbox.trim().toLowerCase();
  }

  if (typeof raw.skippedVersion === "string" && raw.skippedVersion.trim()) {
    out.skippedVersion = raw.skippedVersion.trim();
  }

  if (Array.isArray(raw.launchArgs)) {
    out.launchArgs = raw.launchArgs.filter((a) => typeof a === "string" && a.length > 0).map((a) => String(a));
  }

  if (raw.launchEnv && typeof raw.launchEnv === "object" && !Array.isArray(raw.launchEnv)) {
    const env = {};
    for (const key of Object.keys(raw.launchEnv)) {
      const value = raw.launchEnv[key];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // not a usable env name
      if (value == null) continue; // null clears the key on merge
      if (typeof value === "object") continue;
      env[key] = String(value);
    }
    out.launchEnv = env;
  }

  return out;
}

/** Clean the whole appPrefs map; apps that end up with no usable keys are kept. */
function sanitizeAppPrefs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const appId of Object.keys(raw)) {
    const id = String(appId).toLowerCase();
    if (!id) continue;
    out[id] = sanitizeAppPref(raw[appId]);
  }
  return out;
}

/**
 * Deep-merge one patch into one app's prefs (SPEC v0.2 setAppPref semantics):
 * objects (launchEnv) merge key-wise — a null value removes a key — arrays
 * (launchArgs) are replaced wholesale, unknown keys are dropped.
 */
function mergeAppPref(current, patch) {
  const base = sanitizeAppPref(current);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const clean = sanitizeAppPref(patch);

  for (const key of APP_PREF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const rawValue = patch[key];

    // explicit null/undefined clears the preference (falls back to global)
    if (rawValue == null) {
      delete base[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(clean, key)) continue; // junk value → ignore

    if (key === "launchEnv") {
      const merged = Object.assign({}, base.launchEnv || {}, clean.launchEnv);
      for (const envKey of Object.keys(rawValue)) {
        if (rawValue[envKey] === null) delete merged[envKey];
      }
      base.launchEnv = merged;
      continue;
    }
    base[key] = clean[key]; // arrays are replaced, scalars overwritten
  }
  return base;
}

function sanitize(raw) {
  const s = Object.assign(defaults(), raw && typeof raw === "object" ? raw : {});
  s.owners = Array.isArray(s.owners) ? s.owners.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim()) : defaults().owners;
  // Default upgrade: installs still on the ORIGINAL default source list get the
  // new default (an explicit custom list — anything else — is left alone).
  if (s.owners.length === 1 && s.owners[0] === "nerdrx") s.owners = defaults().owners;
  s.extraRepos = Array.isArray(s.extraRepos)
    ? s.extraRepos.filter((r) => typeof r === "string" && r.includes("/")).map((r) => r.trim())
    : [];
  const hours = Number(s.checkIntervalHours);
  s.checkIntervalHours = Number.isFinite(hours) && hours > 0 ? hours : defaults().checkIntervalHours;
  s.installRoot = expandHome(s.installRoot) || defaults().installRoot;
  s.adbPath = typeof s.adbPath === "string" && s.adbPath.trim() ? s.adbPath.trim() : "adb";
  s.token = typeof s.token === "string" && s.token.trim() ? s.token.trim() : null;

  // ---- v0.2 ----
  s.appPrefs = sanitizeAppPrefs(s.appPrefs);
  s.updatePolicy = UPDATE_POLICIES.includes(s.updatePolicy) ? s.updatePolicy : defaults().updatePolicy;
  s.includePrereleases = bool(s.includePrereleases, false);
  s.notifications = bool(s.notifications, true);
  s.autostart = bool(s.autostart, false);
  s.startMinimized = bool(s.startMinimized, false);
  s.createDesktopEntries = bool(s.createDesktopEntries, true);
  s.cliShim = bool(s.cliShim, true);
  s.autoRunPostInstallCmd = bool(s.autoRunPostInstallCmd, false);
  s.lanSeeding = bool(s.lanSeeding, true);
  s.requireSignatures = bool(s.requireSignatures, false); // v0.8
  s.fleet = bool(s.fleet, true); // v0.6
  s.fleetSync = bool(s.fleetSync, true); // v0.10
  const maxDl = Math.floor(Number(s.maxConcurrentDownloads));
  s.maxConcurrentDownloads = Number.isFinite(maxDl) && maxDl >= 1 ? Math.min(maxDl, 8) : defaults().maxConcurrentDownloads;
  s.preferredDeviceSerial = trimmedString(s.preferredDeviceSerial);
  return s;
}

/** Settings as stored on disk (no env overrides applied). */
function loadRaw() {
  return sanitize(readJson(settingsPath(), {}));
}

/** Effective settings — NX_HUB_INSTALL_ROOT overrides installRoot for tests/e2e. */
function load() {
  const s = loadRaw();
  if (process.env.NX_HUB_INSTALL_ROOT) s.installRoot = expandHome(process.env.NX_HUB_INSTALL_ROOT);
  return s;
}

/** Merge `patch` into stored settings, persist, return effective settings. */
function save(patch) {
  const next = sanitize(Object.assign(loadRaw(), patch && typeof patch === "object" ? patch : {}));
  writeJsonAtomic(settingsPath(), next);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "token")) tokenCache = undefined;
  return load();
}

/**
 * Merge `patch` into ONE app's prefs and persist (SPEC v0.2 `setAppPref`).
 * @returns {object} effective settings
 */
function setAppPref(appId, patch) {
  const id = String(appId || "").trim().toLowerCase();
  if (!id) throw new Error("setAppPref needs an app id");
  const stored = loadRaw();
  const prefs = Object.assign({}, stored.appPrefs);
  const merged = mergeAppPref(prefs[id], patch);
  // v0.10 [fabric2]: this is the WRITE, so this is where the stamp is minted.
  // `_ts` is not in APP_PREF_KEYS, so a caller cannot smuggle one in through
  // the patch and win a merge on another machine by claiming the future.
  merged._ts = Date.now();
  prefs[id] = merged;
  return save({ appPrefs: prefs });
}

/** One app's stored prefs ({} when it has none). */
function getAppPref(settings, appId) {
  const s = settings || load();
  const id = String(appId || "").toLowerCase();
  return (s.appPrefs && s.appPrefs[id]) || {};
}

/** Per-app override → global default. */
function effectiveUpdatePolicy(settings, appId) {
  const pref = getAppPref(settings, appId);
  if (UPDATE_POLICIES.includes(pref.updatePolicy)) return pref.updatePolicy;
  const s = settings || load();
  return UPDATE_POLICIES.includes(s.updatePolicy) ? s.updatePolicy : "notify";
}

/** Per-app autoRunCmd overrides the global autoRunPostInstallCmd. */
function effectiveAutoRunCmd(settings, appId) {
  const pref = getAppPref(settings, appId);
  if (typeof pref.autoRunCmd === "boolean") return pref.autoRunCmd;
  return Boolean(settings.autoRunPostInstallCmd);
}

function effectiveIncludePrereleases(settings, appId) {
  const pref = getAppPref(settings, appId);
  if (typeof pref.includePrereleases === "boolean") return pref.includePrereleases;
  const s = settings || load();
  return Boolean(s.includePrereleases);
}

/* ------------------------------------------------------------------ */
/* export / import                                                     */
/* ------------------------------------------------------------------ */

/** Settings as portable JSON — never carries the token (SPEC v0.2). */
function exportSettings(settings) {
  const s = Object.assign({}, settings || loadRaw());
  delete s.token;
  delete s.tokenSource;
  return `${JSON.stringify(s, null, 2)}\n`;
}

/**
 * Import a settings JSON string. The token is never taken from an import, and
 * every value goes through the normal sanitiser.
 * @returns {{settings:object, applied:string[], skipped:string[]}}
 */
function importSettings(json) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error(`Could not read the settings file — it is not valid JSON (${e.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Could not read the settings file — expected a JSON object");
  }

  const known = Object.keys(defaults());
  const base = defaults();
  const applied = [];
  const skipped = [];
  const patch = {};

  for (const key of Object.keys(parsed)) {
    if (key === "token") {
      skipped.push("token"); // deliberate: tokens are never imported silently
      continue;
    }
    if (!known.includes(key)) {
      skipped.push(key);
      continue;
    }
    // a value that only survives as the default was junk — report it as skipped
    const wanted = sanitize({ [key]: parsed[key] })[key];
    const fellBackToDefault =
      JSON.stringify(wanted) === JSON.stringify(base[key]) && JSON.stringify(parsed[key]) !== JSON.stringify(wanted);
    if (fellBackToDefault) {
      skipped.push(key);
      continue;
    }
    patch[key] = parsed[key];
    applied.push(key);
  }

  save(patch);
  return { settings: load(), applied: [...new Set(applied)], skipped: [...new Set(skipped)] };
}

/* ------------------------------------------------------------------ */
/* XDG autostart                                                       */
/* ------------------------------------------------------------------ */

function autostartDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "autostart");
}

function autostartPath() {
  return path.join(autostartDir(), `${APP_NAME}.desktop`);
}

/** Quote a path for a .desktop Exec= line. */
function execQuote(p) {
  const s = String(p || "");
  if (/^[A-Za-z0-9_\-./=:@+]+$/.test(s)) return s;
  return `"${s.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * Write ~/.config/autostart/nx-hub.desktop. `exePath` is resolved by the caller
 * (index.js: process.env.APPIMAGE || app.getPath("exe")) so this stays pure.
 */
function writeAutostart(exePath, { startMinimized = false } = {}) {
  if (!exePath) throw new Error("writeAutostart needs the path of the running binary");
  const exec = `${execQuote(exePath)}${startMinimized ? " --minimized" : ""}`;
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=NX Hub",
    "Comment=Installer, updater and launcher for the NX app family",
    `Exec=${exec}`,
    "Terminal=false",
    "Categories=Utility;",
    "X-GNOME-Autostart-enabled=true",
    "",
  ];
  ensureDir(autostartDir());
  const file = autostartPath();
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o644 });
  return file;
}

/** @returns {boolean} true when an entry was there and is now gone */
function removeAutostart() {
  const file = autostartPath();
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** settings.autostart → write/remove the entry. Never throws. */
function applyAutostart(settings, exePath) {
  const s = settings || load();
  try {
    if (s.autostart) {
      if (!exePath) return { enabled: false, path: null, error: "no executable path" };
      return { enabled: true, path: writeAutostart(exePath, { startMinimized: s.startMinimized }) };
    }
    removeAutostart();
    return { enabled: false, path: null };
  } catch (e) {
    log(`autostart: ${e.message}`);
    return { enabled: false, path: null, error: e.message };
  }
}

function installRoot(settings) {
  const s = settings || load();
  return expandHome(s.installRoot) || defaults().installRoot;
}

/** installRoot/nx/<appId>/<artifactId> per SPEC. */
function installPathFor(settings, appId, artifactId) {
  return path.join(installRoot(settings), "nx", String(appId), String(artifactId));
}

function ghToken() {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const t = String(stdout || "").trim();
      resolve(t || null);
    });
  });
}

/**
 * Token resolution order (SPEC): settings.token → `gh auth token` (cached) → null.
 */
async function resolveToken(settings) {
  const s = settings || load();
  if (s.token) return s.token;
  if (process.env.NX_HUB_TOKEN) return process.env.NX_HUB_TOKEN;
  if (process.env.NX_HUB_NO_GH === "1") return null;
  if (tokenCache !== undefined) return tokenCache;
  tokenCache = await ghToken();
  return tokenCache;
}

function clearTokenCache() {
  tokenCache = undefined;
}

function logFile() {
  return path.join(logsDir(), "nx-hub.log");
}

function log(...parts) {
  const msg = parts
    .map((p) => (typeof p === "string" ? p : p instanceof Error ? p.stack || p.message : JSON.stringify(p)))
    .join(" ");
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (process.env.NX_HUB_QUIET !== "1") {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (process.env.NX_HUB_NO_FILE_LOG === "1") return;
  try {
    if (logStreamPath !== logFile()) {
      ensureDir(logsDir());
      logStreamPath = logFile();
    }
    fs.appendFileSync(logStreamPath, `${line}\n`);
  } catch (_) {
    /* logging must never throw */
  }
}

module.exports = {
  NX_CONNECTOR_PORT,
  APP_NAME,
  UPDATE_POLICIES,
  APP_PREF_KEYS,
  SANDBOX_PROFILES,
  defaults,
  expandHome,
  dataDir,
  cacheDir,
  logsDir,
  downloadsDir,
  settingsPath,
  statePath,
  ensureDir,
  readJson,
  writeJsonAtomic,
  loadRaw,
  load,
  save,
  sanitize,
  sanitizeAppPref,
  sanitizeAppPrefs,
  mergeAppPref,
  setAppPref,
  getAppPref,
  effectiveUpdatePolicy,
  effectiveIncludePrereleases,
  effectiveAutoRunCmd,
  exportSettings,
  importSettings,
  autostartDir,
  autostartPath,
  writeAutostart,
  removeAutostart,
  applyAutostart,
  installRoot,
  installPathFor,
  resolveToken,
  clearTokenCache,
  logFile,
  log,
};
