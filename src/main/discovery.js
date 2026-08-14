"use strict";
// NX Hub — sources + releases + overlay → App model (SPEC "App model").
// Pure node: no electron require anywhere in this file.

const fs = require("fs");
const path = require("path");

const config = require("./config");
const githubMod = require("./github");
const stateStore = require("./state");

const OVERLAY_REPO = "nerdrx/nx-hub";
const OVERLAY_REF = "main";
const OVERLAY_FILE = "registry/overrides.json";
const BUNDLED_OVERLAY = path.join(__dirname, "..", "..", "registry", "overrides.json");

// checksums / signatures / builder metadata — never artifacts
const IGNORE_RE = /\.(sha256|sha512|md5|sig|asc|yml|yaml|blockmap)$/i;

const DEFAULT_LABELS = {
  "apk-adb": "Android APK",
  appimage: "Linux AppImage",
  "archive-dir": "Linux archive",
  "windows-portable": "Windows portable",
  "windows-zip": "Windows zip",
  "generic-zip": "Download (zip)",
};

let deps = { github: null, emit: () => {} };
let cached = {
  apps: [],
  adb: { available: false, devices: [], apkVersions: {} },
  refreshing: false,
  lastRefresh: null,
  errors: [],
};
let inflight = null;

function init(d = {}) {
  deps = Object.assign(deps, d);
  return module.exports;
}

function gh() {
  return deps.github || githubMod.client();
}

/* ------------------------------------------------------------------ */
/* version + glob helpers                                              */
/* ------------------------------------------------------------------ */

/** "v1.2.3" → "1.2.3", "nx-1.3" → "1.3", "1.0" → "1.0" */
function parseVersion(tag) {
  if (!tag) return null;
  let v = String(tag).trim();
  // strip repeated leading v / V / nx- / NX- / release- prefixes
  let prev;
  do {
    prev = v;
    v = v.replace(/^(?:v|V|nx[-_]|NX[-_]|release[-_])/, "");
  } while (v !== prev);
  return v || String(tag);
}

function globToRegExp(glob) {
  const src = String(glob)
    .split("")
    .map((c) => {
      if (c === "*") return ".*";
      if (c === "?") return ".";
      return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${src}$`, "i");
}

function globMatch(glob, name) {
  try {
    return globToRegExp(glob).test(String(name));
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* asset classification (SPEC table)                                   */
/* ------------------------------------------------------------------ */

/**
 * @returns {{kind:string,platform:string,label:string}|null} null → ignore asset
 */
function classifyAsset(asset, allAssets = []) {
  const name = String((asset && asset.name) || "");
  if (!name || IGNORE_RE.test(name)) return null;
  const lower = name.toLowerCase();
  const isWin = /win(dows|32|64)?[-_. ]|windows/.test(lower);
  const isLinux = /linux/.test(lower);

  if (lower.endsWith(".apk")) return mk("apk-adb", "android");
  if (lower.endsWith(".appimage")) return mk("appimage", "linux");

  if ((isLinux && lower.endsWith(".tar.gz")) || lower.endsWith(".tgz") || (isLinux && lower.endsWith(".zip"))) {
    return mk("archive-dir", "linux");
  }

  if (lower.endsWith(".exe")) {
    // *setup*.exe is skipped in favour of a portable exe when both are published
    if (/setup|install/.test(lower)) {
      const portable = allAssets.some((a) => {
        const n = String((a && a.name) || "").toLowerCase();
        return n !== lower && n.endsWith(".exe") && !/setup|install/.test(n);
      });
      if (portable) return null;
    }
    return mk("windows-portable", "windows");
  }

  if (lower.endsWith(".zip")) {
    if (isWin) return mk("windows-zip", "windows");
    return mk("generic-zip", "linux");
  }

  return null;
}

function mk(kind, platform) {
  return { kind, platform, label: DEFAULT_LABELS[kind] || kind };
}

/* ------------------------------------------------------------------ */
/* overlay                                                             */
/* ------------------------------------------------------------------ */

function readBundledOverlay() {
  try {
    return JSON.parse(fs.readFileSync(BUNDLED_OVERLAY, "utf8"));
  } catch (_) {
    return { hidden: [], apps: {} };
  }
}

function normalizeOverlay(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const hidden = Array.isArray(o.hidden) ? o.hidden.map((h) => String(h).toLowerCase()) : [];
  const apps = {};
  if (o.apps && typeof o.apps === "object") {
    for (const key of Object.keys(o.apps)) apps[key.toLowerCase()] = o.apps[key] || {};
  }
  return { hidden, apps };
}

/** Live overlay from the nx-hub repo (token-aware), bundled copy as fallback. */
async function loadOverlay({ force = false, signal } = {}) {
  const cacheFile = path.join(config.cacheDir(), "overlay.json");
  if (process.env.NX_HUB_OVERLAY_FILE) {
    try {
      return normalizeOverlay(JSON.parse(fs.readFileSync(process.env.NX_HUB_OVERLAY_FILE, "utf8")));
    } catch (_) {
      /* fall through */
    }
  }
  if (process.env.NX_HUB_NO_LIVE_OVERLAY !== "1") {
    try {
      const text = await gh().fetchRaw(OVERLAY_REPO, OVERLAY_REF, OVERLAY_FILE, { signal });
      if (text) {
        const parsed = JSON.parse(text);
        try {
          config.ensureDir(config.cacheDir());
          fs.writeFileSync(cacheFile, text);
        } catch (_) {
          /* ignore */
        }
        return normalizeOverlay(parsed);
      }
    } catch (e) {
      config.log(`overlay: live fetch failed (${e.message}), using cached/bundled copy`);
    }
  }
  if (!force) {
    const cachedOverlay = config.readJson(cacheFile, null);
    if (cachedOverlay) return normalizeOverlay(cachedOverlay);
  }
  return normalizeOverlay(readBundledOverlay());
}

/* ------------------------------------------------------------------ */
/* app model                                                           */
/* ------------------------------------------------------------------ */

function overlayFor(overlay, repoName) {
  return (overlay && overlay.apps && overlay.apps[String(repoName).toLowerCase()]) || {};
}

function isHidden(overlay, repoName) {
  return Boolean(overlay && overlay.hidden && overlay.hidden.includes(String(repoName).toLowerCase()));
}

/**
 * Build the artifacts array for one release.
 * Overlay entries match by assetPattern and win over the default classification.
 */
function buildArtifacts(release, ovl) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const ovlArtifacts = Array.isArray(ovl && ovl.artifacts) ? ovl.artifacts : [];
  const rows = [];

  assets.forEach((asset, assetIndex) => {
    const name = String((asset && asset.name) || "");
    if (!name || IGNORE_RE.test(name)) return;

    const ovlIndex = ovlArtifacts.findIndex((a) => a && a.assetPattern && globMatch(a.assetPattern, name));
    const entry = ovlIndex >= 0 ? ovlArtifacts[ovlIndex] : null;
    if (entry && entry.skip) return;

    const auto = classifyAsset(asset, assets);
    const kind = (entry && entry.kind) || (auto && auto.kind);
    if (!kind) return; // neither overlay nor heuristics know what this is
    const platform = (entry && entry.platform) || (auto && auto.platform) || "linux";
    const label = (entry && entry.label) || (auto && auto.label) || DEFAULT_LABELS[kind] || kind;

    const artifact = {
      id: null, // assigned below (kind-platform [+ -n])
      label,
      platform,
      kind,
      assetName: name,
      assetUrl: asset.url || asset.browser_download_url || null,
      assetId: asset.id != null ? asset.id : null,
      size: Number(asset.size || 0),
      installed: null,
      updateAvailable: false,
      postInstallNote: (entry && entry.postInstallNote) || null,
    };
    // sibling checksum asset, used by github.downloadAsset to verify
    const sidecar = assets.find((a) => a && a.name === `${name}.sha256`);
    if (sidecar) {
      artifact.checksumName = sidecar.name;
      artifact.checksumUrl = sidecar.url || sidecar.browser_download_url || null;
      artifact.checksumId = sidecar.id != null ? sidecar.id : null;
    }
    // overlay pass-through consumed by the install engines
    for (const key of ["packageId", "stripPrefix", "prefix", "binHint", "addonsDir", "launchCmd", "args"]) {
      if (entry && entry[key] != null) artifact[key] = entry[key];
    }
    rows.push({ artifact, ovlIndex: ovlIndex >= 0 ? ovlIndex : Number.MAX_SAFE_INTEGER, assetIndex, asset });
  });

  rows.sort((a, b) => a.ovlIndex - b.ovlIndex || a.assetIndex - b.assetIndex);

  const counts = new Map();
  return rows.map((r) => {
    const base = `${r.artifact.kind}-${r.artifact.platform}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    r.artifact.id = n === 1 ? base : `${base}-${n}`;
    return r.artifact;
  });
}

/**
 * @param {object} o
 * @param {object} o.repo      GitHub repo object (or {name, full_name, owner, private, description})
 * @param {object|null} o.release
 * @param {object} o.overlay   normalized overlay
 * @param {object} o.installedState  state.json contents
 * @param {object} o.adb       { available, devices, apkVersions }
 * @param {string} o.primaryOwner
 */
function buildApp({ repo, release, overlay, installedState, adb, primaryOwner }) {
  const repoName = repo.name;
  const owner = (repo.owner && repo.owner.login) || String(repo.full_name || "").split("/")[0] || primaryOwner;
  const ovl = overlayFor(overlay, repoName);
  const id = String(repoName).toLowerCase();

  const artifacts = release ? buildArtifacts(release, ovl) : [];

  const latest = release
    ? {
        tag: release.tag_name || null,
        version: parseVersion(release.tag_name),
        publishedAt: release.published_at || release.created_at || null,
        notes: release.body || "",
        prerelease: Boolean(release.prerelease),
      }
    : null;

  const app = {
    id,
    repo: repo.full_name || `${owner}/${repoName}`,
    owner,
    name: ovl.name || repoName,
    tagline: ovl.tagline || repo.description || "",
    private: Boolean(repo.private),
    order: Number.isFinite(Number(ovl.order)) ? Number(ovl.order) : 100,
    unpublished: !release || artifacts.length === 0,
    latest,
    artifacts,
  };
  if (primaryOwner && String(owner).toLowerCase() !== String(primaryOwner).toLowerCase()) app.foreignOwner = true;

  mergeInstalled(app, installedState, adb);
  return app;
}

/** Merge state.json + live adb versions into an app's artifacts. */
function mergeInstalled(app, installedState, adb) {
  const st = installedState && installedState.installed ? installedState.installed : {};
  const forApp = st[app.id] || {};
  const adbInfo = adb || { available: false, devices: [], apkVersions: {} };
  const deviceOnline = Boolean(adbInfo.available && (adbInfo.devices || []).some((d) => d && d.state === "device"));

  for (const artifact of app.artifacts) {
    const rec = forApp[artifact.id] || null;
    let installed = rec
      ? { version: rec.version, path: rec.path, installedAt: rec.installedAt }
      : null;

    if (artifact.kind === "apk-adb") {
      if (deviceOnline && artifact.packageId) {
        const live = (adbInfo.apkVersions || {})[artifact.packageId];
        installed = live
          ? { version: String(live), path: null, installedAt: (rec && rec.installedAt) || null }
          : null;
      } else if (!deviceOnline) {
        artifact.deviceOffline = true;
      }
    }

    artifact.installed = installed;
    artifact.updateAvailable = Boolean(
      installed && app.latest && installed.version && String(installed.version) !== String(app.latest.version)
    );
  }
  return app;
}

function sortApps(apps) {
  return apps.sort((a, b) => {
    if (a.unpublished !== b.unpublished) return a.unpublished ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return String(a.name).localeCompare(String(b.name));
  });
}

/**
 * Pure assembly step — used directly by unit tests.
 */
function buildApps({ repos, releases, overlay, installedState, adb, primaryOwner }) {
  const ovl = normalizeOverlay(overlay); // idempotent

  const out = [];
  for (const repo of repos) {
    if (!repo || !repo.name) continue;
    if (isHidden(ovl, repo.name)) continue;
    const release = releases ? releases[String(repo.full_name || repo.name).toLowerCase()] || null : null;
    out.push(buildApp({ repo, release, overlay: ovl, installedState, adb, primaryOwner }));
  }
  return sortApps(out);
}

/* ------------------------------------------------------------------ */
/* live refresh                                                        */
/* ------------------------------------------------------------------ */

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const idx = i;
      i += 1;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function getAdbStatus(settings) {
  const ctx = {
    dataDir: config.dataDir(),
    installRoot: config.installRoot(settings),
    settings,
    log: (m) => config.log(`[adb] ${m}`),
    emitProgress: () => {},
  };
  try {
    // engines agent owns this file — it may not exist yet
    const engine = require("./install/engine");
    if (engine && typeof engine.getAdbStatus === "function") {
      const st = await engine.getAdbStatus(ctx);
      if (st && typeof st === "object") {
        return {
          available: Boolean(st.available),
          devices: Array.isArray(st.devices) ? st.devices : [],
          apkVersions: st.apkVersions && typeof st.apkVersions === "object" ? st.apkVersions : {},
        };
      }
    }
  } catch (_) {
    /* engine not present / adb missing */
  }
  return { available: false, devices: [], apkVersions: {} };
}

/** Collect repo objects from settings.owners + settings.extraRepos. */
async function collectRepos(settings, { force, signal } = {}) {
  const client = gh();
  const errors = [];
  const map = new Map();

  for (const owner of settings.owners || []) {
    try {
      const repos = await client.listOwnerRepos(owner, { force, signal });
      for (const r of repos) map.set(String(r.full_name || `${owner}/${r.name}`).toLowerCase(), r);
    } catch (e) {
      errors.push({ source: owner, message: e.message, rateLimited: Boolean(e.rateLimited) });
      config.log(`discovery: owner ${owner} failed — ${e.message}`);
    }
  }

  for (const entry of settings.extraRepos || []) {
    const [owner, name] = String(entry).split("/");
    if (!owner || !name) continue;
    const key = `${owner}/${name}`.toLowerCase();
    if (map.has(key)) continue;
    try {
      const repo = await client.getRepo(owner, name, { force, signal });
      if (repo && repo.name) map.set(String(repo.full_name).toLowerCase(), repo);
    } catch (e) {
      errors.push({ source: entry, message: e.message, rateLimited: Boolean(e.rateLimited) });
      config.log(`discovery: repo ${entry} failed — ${e.message}`);
    }
  }

  return { repos: [...map.values()], errors };
}

/** Full discovery pass. Result is cached; `getCached()` serves the UI. */
async function refresh({ force = false, signal } = {}) {
  if (inflight) return inflight;
  const settings = config.load();
  cached.refreshing = true;
  deps.emit({ type: "state-changed" });

  inflight = (async () => {
    const errors = [];
    try {
      const overlay = await loadOverlay({ force, signal });
      const { repos, errors: repoErrors } = await collectRepos(settings, { force, signal });
      errors.push(...repoErrors);

      const visible = repos.filter((r) => !isHidden(overlay, r.name));
      const releases = {};
      await mapLimit(visible, 6, async (repo) => {
        const [owner, name] = String(repo.full_name || `${repo.owner && repo.owner.login}/${repo.name}`).split("/");
        try {
          const rel = await gh().latestRelease(owner, name, { force, signal });
          if (rel) releases[String(repo.full_name).toLowerCase()] = rel;
        } catch (e) {
          errors.push({ source: repo.full_name, message: e.message, rateLimited: Boolean(e.rateLimited) });
          config.log(`discovery: release ${repo.full_name} failed — ${e.message}`);
        }
      });

      const adb = await getAdbStatus(settings);
      const apps = buildApps({
        repos: visible,
        releases,
        overlay,
        installedState: stateStore.load(),
        adb,
        primaryOwner: (settings.owners || [])[0] || null,
      });

      cached.apps = apps;
      cached.adb = adb;
      cached.errors = errors;
      cached.lastRefresh = new Date().toISOString();
      config.log(`discovery: ${apps.length} apps (${apps.filter((a) => !a.unpublished).length} published)`);
      const limited = errors.find((e) => e.rateLimited);
      if (limited) deps.emit({ type: "toast", level: "warn", message: limited.message });
    } catch (e) {
      cached.errors = [{ source: "discovery", message: e.message }];
      config.log(`discovery failed: ${e.stack || e.message}`);
      deps.emit({ type: "toast", level: "error", message: `Discovery failed: ${e.message}` });
    } finally {
      cached.refreshing = false;
      inflight = null;
      deps.emit({ type: "state-changed" });
    }
    return cached.apps;
  })();

  return inflight;
}

/** Re-merge installed state into the cached apps (no network) — after install/uninstall. */
function remerge() {
  const st = stateStore.load();
  for (const app of cached.apps) mergeInstalled(app, st, cached.adb);
  return cached.apps;
}

/** Refresh only the adb-derived data (cheap, no GitHub calls). */
async function refreshAdb() {
  cached.adb = await getAdbStatus(config.load());
  remerge();
  return cached.adb;
}

function getCached() {
  return cached;
}

function findApp(appId) {
  return cached.apps.find((a) => a.id === String(appId).toLowerCase()) || null;
}

function findArtifact(appId, artifactId) {
  const app = findApp(appId);
  if (!app) return { app: null, artifact: null };
  return { app, artifact: app.artifacts.find((a) => a.id === artifactId) || null };
}

/** test hook */
function _setCached(next) {
  cached = Object.assign(cached, next);
  return cached;
}

module.exports = {
  init,
  refresh,
  refreshAdb,
  remerge,
  getCached,
  findApp,
  findArtifact,
  buildApps,
  buildApp,
  buildArtifacts,
  mergeInstalled,
  classifyAsset,
  parseVersion,
  globMatch,
  loadOverlay,
  normalizeOverlay,
  sortApps,
  collectRepos,
  _setCached,
  IGNORE_RE,
  DEFAULT_LABELS,
};
