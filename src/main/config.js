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

function defaults() {
  return {
    owners: ["nerdrx"],
    extraRepos: [],
    checkIntervalHours: 6,
    installRoot: path.join(os.homedir(), "Applications"),
    adbPath: "adb",
    token: null,
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

function sanitize(raw) {
  const s = Object.assign(defaults(), raw && typeof raw === "object" ? raw : {});
  s.owners = Array.isArray(s.owners) ? s.owners.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim()) : defaults().owners;
  s.extraRepos = Array.isArray(s.extraRepos)
    ? s.extraRepos.filter((r) => typeof r === "string" && r.includes("/")).map((r) => r.trim())
    : [];
  const hours = Number(s.checkIntervalHours);
  s.checkIntervalHours = Number.isFinite(hours) && hours > 0 ? hours : defaults().checkIntervalHours;
  s.installRoot = expandHome(s.installRoot) || defaults().installRoot;
  s.adbPath = typeof s.adbPath === "string" && s.adbPath.trim() ? s.adbPath.trim() : "adb";
  s.token = typeof s.token === "string" && s.token.trim() ? s.token.trim() : null;
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
  installRoot,
  installPathFor,
  resolveToken,
  clearTokenCache,
  logFile,
  log,
};
