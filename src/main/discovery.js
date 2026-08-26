"use strict";
// NX Hub — sources + releases + overlay → App model (SPEC "App model").
// Pure node: no electron require anywhere in this file.

const fs = require("fs");
const path = require("path");

const config = require("./config");
const githubMod = require("./github");
const stateStore = require("./state");
// v0.12 [manifest]: what an app repo is allowed to say about itself.
const manifestMod = require("./manifest");

const OVERLAY_REPO = "nerdrx/nx-hub";
const OVERLAY_REF = "main";
const OVERLAY_FILE = "registry/overrides.json";
const BUNDLED_OVERLAY = path.join(__dirname, "..", "..", "registry", "overrides.json");

// checksums / signatures / builder metadata / v0.6 delta patches — never artifacts
const IGNORE_RE = /\.(sha256|sha512|md5|sig|asc|yml|yaml|blockmap|zpatch)$/i;

/**
 * v0.12 [manifest]: everything the classifier must never turn into an
 * installable row. IGNORE_RE is EXTENSION-based and `.json` is not in it, so
 * the `nx-app.json` release asset needs its own rule — otherwise the file that
 * describes the app would show up as a download the user could "install".
 */
function ignoredAsset(name) {
  const n = String(name || "");
  return !n || IGNORE_RE.test(n) || manifestMod.isManifestAsset(n);
}

const DEFAULT_LABELS = {
  "apk-adb": "Android APK",
  appimage: "Linux AppImage",
  "archive-dir": "Linux archive",
  "windows-portable": "Windows portable",
  "windows-zip": "Windows zip",
  "generic-zip": "Download (zip)",
};

// Kinds whose install is a self-contained directory we can keep a `.prev` copy
// of (SPEC v0.2 rollback). tarball-prefix writes into a shared prefix and
// apk-adb lives on the device — neither can be rolled back locally.
const ROLLBACK_KINDS = new Set(["appimage", "archive-dir", "windows-portable", "windows-zip"]);

// v0.8: the sandbox profiles an OVERLAY may name ("inherit" is appPrefs-only).
const SANDBOX_PROFILE_VALUES = ["none", "confined", "offline"];

let deps = { github: null, emit: () => {} };
let cached = {
  apps: [],
  adb: { available: false, devices: [], versions: {}, apkVersions: {} },
  refreshing: false,
  lastRefresh: null,
  errors: [],
  rateLimit: null, // { resetAt } while GitHub is throttling us
  releases: {}, // appId → full release list (v0.2 getReleases/installVersion)
  overlay: { hidden: [], apps: {} }, // last overlay, so artifacts can be rebuilt per release
  manifests: {}, // v0.12 [manifest]: repo full_name (lower) → validated nx-app.json
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
/* release selection (v0.2)                                            */
/* ------------------------------------------------------------------ */

function releaseTime(release) {
  const raw = (release && (release.published_at || release.created_at)) || "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/** Newest first. Ties break on the numeric release id so sorting is stable. */
function byRecency(a, b) {
  return releaseTime(b) - releaseTime(a) || Number(b.id || 0) - Number(a.id || 0);
}

/**
 * Pick the release an app should present as "latest".
 *
 * - drafts are never eligible
 * - prereleases only when `includePrereleases` (global setting, overridden per
 *   app via appPrefs[appId].includePrereleases)
 * - a repo that has ONLY prereleases still shows its newest one, otherwise the
 *   app would look unpublished; `latest.prerelease` tells the UI.
 *
 * Accepts a single release object too, so the older callers keep working.
 */
function selectRelease(entry, { includePrereleases = false } = {}) {
  if (!entry) return null;
  const list = (Array.isArray(entry) ? entry : [entry]).filter((r) => r && !r.draft);
  if (!list.length) return null;
  const sorted = [...list].sort(byRecency);
  if (includePrereleases) return sorted[0];
  const stable = sorted.filter((r) => !r.prerelease);
  return stable.length ? stable[0] : sorted[0];
}

/**
 * The ordered candidate list artifact-fallback walks: newest first, honoring
 * the prerelease preference the same way selectRelease does (stable releases
 * only, unless prereleases are opted in or nothing stable exists).
 */
function eligibleReleases(entry, includePrereleases) {
  if (!entry) return [];
  const list = (Array.isArray(entry) ? entry : [entry]).filter((r) => r && !r.draft);
  if (!list.length) return [];
  const sorted = [...list].sort(byRecency);
  if (includePrereleases) return sorted;
  const stable = sorted.filter((r) => !r.prerelease);
  return stable.length ? stable : sorted;
}

/** Release list → the UI-facing shape (SPEC: getReleases). */
function releaseSummary(release) {
  if (!release) return null;
  return {
    tag: release.tag_name || null,
    version: parseVersion(release.tag_name),
    publishedAt: release.published_at || release.created_at || null,
    notes: release.body || "",
    prerelease: Boolean(release.prerelease),
    assets: (Array.isArray(release.assets) ? release.assets : []).map((a) => ({
      name: a.name,
      size: Number(a.size || 0),
      id: a.id != null ? a.id : null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* asset classification (SPEC table)                                   */
/* ------------------------------------------------------------------ */

/**
 * @returns {{kind:string,platform:string,label:string}|null} null → ignore asset
 */
function classifyAsset(asset, allAssets = []) {
  const name = String((asset && asset.name) || "");
  if (ignoredAsset(name)) return null; // v0.12 [manifest]: incl. nx-app.json
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

/**
 * Stable app id. The primary owner's repos keep the bare name (existing
 * installs/prefs stay keyed as before); any other source's repo is
 * owner-prefixed so two same-named repos can never collide in state,
 * preferences, jobs, or the release cache.
 */
function appIdFor(repo, primaryOwner) {
  const name = String(repo.name || repo).toLowerCase();
  const owner = String((repo.owner && repo.owner.login) || String(repo.full_name || "").split("/")[0] || "").toLowerCase();
  const primary = String(primaryOwner || "").toLowerCase();
  if (!owner || !primary || owner === primary) return name;
  return `${owner}--${name}`;
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

/**
 * Overlay `hidden` entries are scoped: `owner/repo` matches exactly that repo;
 * a bare `repo` name matches ONLY the primary owner's repo of that name.
 * (Learned the hard way: a second source's identically-named repo — e.g. the
 * upstream of a hidden fork — must not inherit the hiding.)
 */
function isHidden(overlay, repo, primaryOwner) {
  if (!overlay || !Array.isArray(overlay.hidden) || !overlay.hidden.length) return false;
  const name = String(repo && repo.name ? repo.name : repo).toLowerCase();
  const full = String((repo && repo.full_name) || "").toLowerCase();
  const owner = full.includes("/") ? full.split("/")[0] : "";
  const primary = String(primaryOwner || "").toLowerCase();
  return overlay.hidden.some((h) =>
    h.includes("/") ? h === full : h === name && (!owner || owner === primary)
  );
}

/**
 * Build the artifacts array for one release.
 * Overlay entries match by assetPattern and win over the default classification.
 *
 * v0.12 [manifest]: `man` is the app's VALIDATED manifest (already trust
 * filtered — an untrusted repo's executable fields are gone before they get
 * here). Precedence is PER FIELD, overlay > manifest > derived default: an
 * overlay entry that only sets `label` must not discard the manifest's note.
 */
function buildArtifacts(release, ovl, man) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const ovlArtifacts = Array.isArray(ovl && ovl.artifacts) ? ovl.artifacts : [];
  const manArtifacts = Array.isArray(man && man.artifacts) ? man.artifacts : [];
  const rows = [];

  assets.forEach((asset, assetIndex) => {
    const name = String((asset && asset.name) || "");
    if (ignoredAsset(name)) return;

    const ovlIndex = ovlArtifacts.findIndex((a) => a && a.assetPattern && globMatch(a.assetPattern, name));
    const entry = ovlIndex >= 0 ? ovlArtifacts[ovlIndex] : null;
    if (entry && entry.skip) return;

    // v0.12 [manifest]
    const manIndex = manArtifacts.findIndex((a) => a && a.assetPattern && globMatch(a.assetPattern, name));
    const manEntry = manIndex >= 0 ? manArtifacts[manIndex] : null;

    const auto = classifyAsset(asset, assets);
    const kind = (entry && entry.kind) || (manEntry && manEntry.kind) || (auto && auto.kind);
    if (!kind) return; // neither overlay, manifest nor heuristics know what this is
    const platform = (entry && entry.platform) || (manEntry && manEntry.platform) || (auto && auto.platform) || "linux";
    const label = (entry && entry.label) || (manEntry && manEntry.label) || (auto && auto.label) || DEFAULT_LABELS[kind] || kind;

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
      postInstallNote: null, // v0.12 [manifest]: resolved just below
      postInstallNoteFrom: null, // "overlay" | "manifest" | null
    };
    // v0.12 [manifest]: the overlay's note is the escape hatch and wins; the
    // manifest's own note (per artifact, else the app-level one) is the
    // fallback. `postInstallNoteFrom` is what lets the UI mark a sentence that
    // came out of a foreign repo instead of out of this one.
    const overlayNote = (entry && entry.postInstallNote) || null;
    const manifestNote = (manEntry && manEntry.postInstallNote) || (man && man.postInstallNote) || null;
    artifact.postInstallNote = overlayNote || manifestNote || null;
    artifact.postInstallNoteFrom = overlayNote ? "overlay" : artifact.postInstallNote ? "manifest" : null;
    // sibling checksum asset, used by github.downloadAsset to verify
    const sidecar = assets.find((a) => a && a.name === `${name}.sha256`);
    if (sidecar) {
      artifact.checksumName = sidecar.name;
      artifact.checksumUrl = sidecar.url || sidecar.browser_download_url || null;
      artifact.checksumId = sidecar.id != null ? sidecar.id : null;
    }
    // v0.8: sibling ed25519 signature, verified in the download path against
    // the owner's pinned key (src/main/provenance.js). Captured exactly like
    // the checksum trio above; `.sig` is classifier-ignored, so it can never
    // show up as an installable artifact of its own.
    const sig = assets.find((a) => a && a.name === `${name}.sig`);
    artifact.hasSignature = Boolean(sig);
    if (sig) {
      artifact.signatureName = sig.name;
      artifact.signatureUrl = sig.url || sig.browser_download_url || null;
      artifact.signatureId = sig.id != null ? sig.id : null;
    }
    // v0.6 delta updates: sibling `<assetName>.from-<version>.zpatch` assets.
    // The classifier ignores them (they are not installable on their own); the
    // download path in jobs.js picks the one matching the INSTALLED version.
    const patchPrefix = `${name}.from-`;
    const patches = [];
    for (const a of assets) {
      const an = String((a && a.name) || "");
      if (!an.startsWith(patchPrefix) || !/\.zpatch$/i.test(an)) continue;
      const fromVersion = an.slice(patchPrefix.length, -".zpatch".length);
      if (!fromVersion) continue;
      patches.push({
        name: an,
        fromVersion,
        url: a.url || a.browser_download_url || null,
        id: a.id != null ? a.id : null,
        size: Number(a.size || 0),
      });
    }
    if (patches.length) artifact.deltaPatches = patches;
    // overlay pass-through consumed by the install engines
    // v0.8: `sandbox` (bwrap profile) and `configPaths` may also be pinned per
    // artifact; the app-level values below are the fallback.
    for (const key of ["packageId", "stripPrefix", "prefix", "binHint", "addonsDir", "launchCmd", "postInstallCmd", "args", "sandbox", "configPaths",
      // v0.10.1: blender-theme fan-out controls
      "blenderVersions", "blenderConfigRoot", "defaultBlenderVersion"]) {
      // v0.12 [manifest]: per-key fallback, so an overlay that pins one value
      // keeps the manifest's answer for every other key.
      if (entry && entry[key] != null) artifact[key] = entry[key];
      else if (manEntry && manEntry[key] != null) artifact[key] = manEntry[key];
    }
    rows.push({
      artifact,
      ovlIndex: ovlIndex >= 0 ? ovlIndex : Number.MAX_SAFE_INTEGER,
      manIndex: manIndex >= 0 ? manIndex : Number.MAX_SAFE_INTEGER,
      assetIndex,
      asset,
    });
  });

  rows.sort((a, b) => a.ovlIndex - b.ovlIndex || a.manIndex - b.manIndex || a.assetIndex - b.assetIndex);

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
 * @param {object|null} [o.manifestEntry] v0.12 [manifest]: the repo's validated
 *        nx-app.json — {present, source, trusted, manifest} — or null.
 */
function buildApp({ repo, release, overlay, installedState, adb, primaryOwner, settings, manifestEntry }) {
  const repoName = repo.name;
  const owner = (repo.owner && repo.owner.login) || String(repo.full_name || "").split("/")[0] || primaryOwner;
  const ovl = overlayFor(overlay, repoName);
  const id = appIdFor(repo, primaryOwner);
  // v0.12 [manifest]: already trust-filtered by src/main/manifest.js.
  const man = (manifestEntry && manifestEntry.manifest) || null;

  const s = settings || config.load();
  const prefs = config.getAppPref(s, id);
  const includePre = config.effectiveIncludePrereleases(s, id);
  const chosen = selectRelease(release, { includePrereleases: includePre });

  // Artifacts come from the newest release that SHIPS each artifact type — a
  // release that only patches one platform (e.g. an Android-only fix) must not
  // make the other platforms' artifacts vanish from the card. Every artifact
  // carries the version/tag of the release it actually came from.
  const hadAnyRelease = Array.isArray(release) ? release.length > 0 : Boolean(release);
  const eligible = eligibleReleases(release, includePre);
  // Per-app opt-out back to strict latest-release-only behavior.
  const fallbackOn = prefs.releaseFallback !== false;
  const artifacts = [];
  const seenBases = new Set(); // `${kind}-${platform}` — coarse identity across releases
  const tagArtifacts = (rel, isLatest) => {
    const relVersion = parseVersion(rel.tag_name);
    for (const artifact of buildArtifacts(rel, ovl, man)) {
      const base = `${artifact.kind}-${artifact.platform}`;
      // An older release may only FILL A GAP: contribute a kind+platform the
      // newer releases don't ship at all. Matching exact ids instead would let
      // every old release smuggle its extra same-platform flavors in as new
      // rows (seen in the field: a card with eleven "Linux app" rows).
      if (!isLatest && seenBases.has(base)) continue;
      seenBases.add(base);
      artifact.sourceTag = rel.tag_name || null;
      artifact.sourceVersion = relVersion;
      artifact.sourcePublishedAt = rel.published_at || rel.created_at || null;
      artifact.fromOlderRelease = !isLatest;
      artifacts.push(artifact);
    }
  };
  if (chosen) tagArtifacts(chosen, true);
  if (fallbackOn) {
    for (const rel of eligible) {
      if (rel === chosen) continue;
      tagArtifacts(rel, false);
    }
  }
  release = chosen;

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
    // v0.12 [manifest]: overlay > manifest > derived default, per field.
    name: ovl.name || (man && man.name) || repoName,
    tagline: ovl.tagline || (man && man.tagline) || repo.description || "",
    private: Boolean(repo.private),
    order: Number.isFinite(Number(ovl.order)) ? Number(ovl.order) : 100,
    unpublished: !release || artifacts.length === 0,
    // Distinguishes "repo has never released" from "released, but nothing the
    // hub can classify" (e.g. only .mcpb files) — the UI words them differently.
    hasAnyRelease: hadAnyRelease,
    latest,
    artifacts,
  };
  if (primaryOwner && String(owner).toLowerCase() !== String(primaryOwner).toLowerCase()) app.foreignOwner = true;

  // ---- v0.12 [manifest]: provenance, for the UI's quiet marker ----
  // Always present (null when the repo ships none), so a renderer never has to
  // ask whether this build knows about manifests.
  app.manifest = manifestEntry
    ? { present: true, source: manifestEntry.source, trusted: Boolean(manifestEntry.trusted) }
    : null;
  const manHomepage = ovl.homepage || (man && man.homepage) || null;
  if (manHomepage) app.homepage = manHomepage;

  // v0.5: how the UI labels this app's connector status fields (SPEC "Status
  // rendering"). Absent → the UI renders fields generically.
  // v0.12 [manifest]: the manifest's fields are the fallback — presentation
  // only, so they need no trust.
  if (ovl.connector && Array.isArray(ovl.connector.fields)) {
    app.connectorFields = ovl.connector.fields
      .filter((f) => f && typeof f.key === "string")
      .map((f) => ({ key: f.key, label: f.label || f.key, unit: f.unit || "", kind: f.kind || "text" }));
  } else if (man && man.connector && Array.isArray(man.connector.fields) && man.connector.fields.length) {
    app.connectorFields = man.connector.fields.map((f) => ({ key: f.key, label: f.label || f.key, unit: f.unit || "", kind: f.kind || "text" }));
  }

  // ---- v0.8 overlay pass-through: sandbox profile + config locations ----
  // Both are plain MODEL fields: discovery neither sandboxes nor snapshots
  // anything. `sandbox` is read by jobs.launch ([guardian]) and `configPaths`
  // by the sandbox binds AND by src/main/snapshots.js ([timemachine]).
  // v0.12 [manifest]: both are trusted-only manifest fields (they were dropped
  // upstream for an untrusted owner), and the overlay still wins.
  const sandboxSource = typeof ovl.sandbox === "string" ? ovl.sandbox : man && man.sandbox;
  if (typeof sandboxSource === "string" && SANDBOX_PROFILE_VALUES.includes(sandboxSource.trim().toLowerCase())) {
    app.sandbox = sandboxSource.trim().toLowerCase();
  }
  const configPathsSource = Array.isArray(ovl.configPaths) ? ovl.configPaths : (man && man.configPaths) || null;
  if (Array.isArray(configPathsSource)) {
    const paths = configPathsSource.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
    if (paths.length) app.configPaths = paths;
  }

  // ---- v0.2 per-app preferences (the app is still discovered when hidden) ----
  app.localHidden = prefs.hidden === true;
  app.favorite = prefs.favorite === true;
  app.updatePolicy = config.effectiveUpdatePolicy(s, id);
  app.includePrereleases = config.effectiveIncludePrereleases(s, id);
  app.skippedVersion = prefs.skippedVersion || null;
  app.launchArgs = Array.isArray(prefs.launchArgs) ? prefs.launchArgs : [];
  app.launchEnv = prefs.launchEnv && typeof prefs.launchEnv === "object" ? prefs.launchEnv : {};
  // v0.8 [guardian]: what the options sheet shows — the watchdog toggle and the
  // user's sandbox choice ("inherit" / absent means app.sandbox above wins).
  app.keepAlive = prefs.keepAlive === true;
  app.sandboxPref = typeof prefs.sandbox === "string" ? prefs.sandbox : null;

  // ---- v0.7 [dev-tools]: a working tree linked to this id (SPEC "nx dev") ----
  // A MODEL FLAG and nothing more: discovery never reads, builds or launches
  // the linked tree. Lazily required and wrapped, so a hub whose dev.json is
  // missing, unreadable or junk discovers apps exactly as it always did.
  try {
    // eslint-disable-next-line global-require
    const link = require("./devlinks").linkFor(id);
    if (link) app.devLink = { path: link.path };
  } catch (_) {
    /* dev links are strictly optional */
  }

  mergeInstalled(app, installedState, adb, s);

  // Can anything in the latest release actually be installed from THIS machine?
  // (android counts: the hub sideloads APKs over adb from any desktop.)
  const hostPlatform = process.platform === "win32" ? "windows" : "linux";
  app.installableHere =
    !app.unpublished &&
    app.artifacts.some((a) => a.platform === hostPlatform || a.platform === "android");
  return app;
}

/**
 * Version kept as `<installDir>.prev` by the staged swap, or null.
 * Sync on purpose: mergeInstalled() is a hot, synchronous path.
 */
function prevInstallInfo(installPath) {
  if (!installPath) return null;
  const prevDir = `${installPath}.prev`;
  try {
    if (!fs.statSync(prevDir).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  let version = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(prevDir, ".nx-manifest.json"), "utf8"));
    version = manifest && manifest.version != null ? String(manifest.version) : null;
  } catch (_) {
    /* a .prev without a readable manifest is still restorable */
  }
  return { path: prevDir, version };
}

/**
 * Can this artifact ever be launched? (UI hides the Launch button when false.)
 * The engine's recorded `launchable` still overrides this after an install.
 */
function kindLaunchable(artifact) {
  switch (artifact.kind) {
    case "blender-addon":
    case "blender-theme":
    case "generic-zip":
      return false;
    case "tarball-prefix":
      return Boolean(artifact.launchCmd); // SPEC: hidden when the overlay names no launchCmd
    case "apk-adb":
      return Boolean(artifact.packageId); // needs a package to monkey-launch
    case "windows-portable":
    case "windows-zip":
      return process.platform === "win32";
    default:
      return true;
  }
}

/** Merge state.json + live adb versions into an app's artifacts. */
function mergeInstalled(app, installedState, adb, settings) {
  const state = installedState && typeof installedState === "object" ? installedState : {};
  const st = state.installed ? state.installed : {};
  const downloadsFor = (state.downloads && state.downloads[app.id]) || {};
  const crashesAll = (state.crashes && typeof state.crashes === "object" && state.crashes) || {};
  const forApp = st[app.id] || {};
  const skippedVersion = app.skippedVersion || null;
  const adbInfo = adb || { available: false, devices: [], apkVersions: {} };
  const liveVersions = adbInfo.versions || adbInfo.apkVersions || {};
  const deviceOnline = Boolean(adbInfo.available && (adbInfo.devices || []).some((d) => d && d.state === "device"));

  for (const artifact of app.artifacts) {
    const rec = forApp[artifact.id] || null;
    let installed = rec
      ? { version: rec.version, path: rec.path, installedAt: rec.installedAt, iconPath: rec.iconPath || null }
      : null;

    if (artifact.kind === "apk-adb") {
      if (deviceOnline && artifact.packageId) {
        const live = liveVersions[artifact.packageId];
        installed = live
          ? { version: String(live), path: null, installedAt: (rec && rec.installedAt) || null }
          : null;
      } else if (!deviceOnline) {
        artifact.deviceOffline = true;
      }
    }

    artifact.installed = installed;
    // Per-artifact comparison: the artifact's OWN source release version, not
    // the app's newest tag — an Android-only patch must not flag the desktop
    // build as updatable (or vice versa).
    const target = artifact.sourceVersion || (app.latest && app.latest.version) || null;
    // Normalize BOTH sides through parseVersion — a device may report the raw
    // versionName "nx-1.3" while the release tag normalizes to "1.3"; raw
    // string compare produced a phantom "nx-1.3 → 1.3" update.
    const norm = (v) => String(parseVersion(v) ?? v);
    const newer = Boolean(installed && target && installed.version && norm(installed.version) !== norm(target));
    // SPEC v0.2: skippedVersion suppresses the update for EXACTLY that version
    const skipped = Boolean(newer && skippedVersion && norm(skippedVersion) === norm(target));
    artifact.updateAvailable = newer && !skipped;
    artifact.updateSkipped = skipped;
    artifact.launchable = kindLaunchable(artifact) && (!rec || rec.launchable !== false);

    // ---- v0.2: rollback + pre-downloaded asset ----
    const prev = ROLLBACK_KINDS.has(artifact.kind) && installed ? prevInstallInfo(installed.path) : null;
    artifact.rollbackAvailable = Boolean(prev);
    artifact.prevVersion = (prev && prev.version) || null;

    const download = downloadsFor[artifact.id] || null;
    const ready = Boolean(
      download &&
        download.path &&
        target &&
        download.version &&
        String(download.version) === String(target) &&
        fileExists(download.path)
    );
    artifact.readyToInstall = ready;
    artifact.readyPath = ready ? download.path : null;

    // ---- v0.6: crash-aware rollback ----
    // The counter only speaks for the version that is installed RIGHT NOW: a
    // record left over from an older build (or from before an uninstall) reads
    // as zero and is never shown.
    const crash = crashesAll[`${app.id}::${artifact.id}`] || null;
    const crashesThisVersion = Boolean(
      crash && installed && installed.version != null && crash.version != null && norm(crash.version) === norm(installed.version)
    );
    artifact.crashCount = crashesThisVersion ? Number(crash.count || 0) : 0;
    artifact.crashLoop = artifact.crashCount >= 3;
    artifact.lastCrashAt = crashesThisVersion ? crash.lastAt || null : null;
  }
  return app;
}

function fileExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/**
 * Case-insensitive ordinal comparison — deliberately NOT localeCompare: the
 * host may run any locale (de_DE here) and the app order must not depend on it.
 */
function compareNames(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  const rawA = String(a);
  const rawB = String(b);
  if (rawA === rawB) return 0;
  return rawA < rawB ? -1 : 1;
}

function sortApps(apps) {
  return apps.sort((a, b) => {
    if (a.unpublished !== b.unpublished) return a.unpublished ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return compareNames(a.name, b.name);
  });
}

/**
 * Pure assembly step — used directly by unit tests.
 */
function buildApps({ repos, releases, overlay, installedState, adb, primaryOwner, settings, manifests }) {
  const ovl = normalizeOverlay(overlay); // idempotent
  const s = settings || config.load(); // read once, not per app

  const out = [];
  for (const repo of repos) {
    if (!repo || !repo.name) continue;
    const key = String(repo.full_name || repo.name).toLowerCase();
    const release = releases ? releases[key] || null : null;
    // v0.12 [manifest]: keyed by lowercased repo full_name, exactly like releases.
    const manifestEntry = (manifests && manifests[key]) || null;
    const app = buildApp({ repo, release, overlay: ovl, installedState, adb, primaryOwner, settings: s, manifestEntry });
    // Overlay-hidden repos are still listed (bottom section), just flagged —
    // the user asked to SEE everything that exists, installable or not.
    app.overlayHidden = isHidden(ovl, repo, primaryOwner);
    out.push(app);
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
        const versions = st.apkVersions && typeof st.apkVersions === "object" ? st.apkVersions : {};
        // UI reads `versions`; `apkVersions` stays for the engine-side contract
        return {
          available: Boolean(st.available),
          devices: Array.isArray(st.devices) ? st.devices : [],
          versions,
          apkVersions: versions,
          selected: st.selected || null, // v0.2: the device the hub acts on
        };
      }
    }
  } catch (_) {
    /* engine not present / adb missing */
  }
  return { available: false, devices: [], versions: {}, apkVersions: {} };
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
      errors.push({ source: owner, message: e.message, rateLimited: Boolean(e.rateLimited), resetAt: e.resetAt || null });
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
      errors.push({ source: entry, message: e.message, rateLimited: Boolean(e.rateLimited), resetAt: e.resetAt || null });
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

      const visible = repos.filter((r) => !isHidden(overlay, r, (settings.owners || [])[0]));
      const releases = {};
      const releasesByApp = {};
      await mapLimit(visible, 6, async (repo) => {
        const [owner, name] = String(repo.full_name || `${repo.owner && repo.owner.login}/${repo.name}`).split("/");
        const key = String(repo.full_name).toLowerCase();
        try {
          // v0.2: the whole release list, so prereleases and older versions are
          // selectable. Servers/mocks without the list endpoint fall back to
          // /releases/latest so discovery never goes blind.
          let list = await gh().listReleases(owner, name, { force, signal });
          if (!Array.isArray(list) || list.length === 0) {
            const single = await gh().latestRelease(owner, name, { force, signal });
            list = single ? [single] : [];
          }
          if (list.length) {
            releases[key] = list;
            releasesByApp[appIdFor(repo, (settings.owners || [])[0])] = list;
          }
        } catch (e) {
          errors.push({ source: repo.full_name, message: e.message, rateLimited: Boolean(e.rateLimited), resetAt: e.resetAt || null });
          config.log(`discovery: release ${repo.full_name} failed — ${e.message}`);
        }
      });

      // ---- v0.12 [manifest]: what the apps say about themselves ----
      // A release ASSET named nx-app.json is always read (the asset list is
      // already in hand). The repo-root fetchRaw is a per-repo request, so it
      // is skipped outright when the hub is anonymous or already throttled —
      // discovery scans every repo, and that is exactly how a working hub
      // turns into a rate-limited one.
      let manifests = {};
      try {
        const token = await config.resolveToken(settings);
        const tight = Boolean(cached.rateLimit) || errors.some((e) => e.rateLimited);
        const disabled = process.env.NX_HUB_NO_MANIFEST_FETCH === "1";
        const allowRepoFetch = Boolean(token) && !tight && !disabled;
        if (!allowRepoFetch) {
          const why = !token ? "hub is anonymous" : tight ? "rate limit is tight" : "disabled by NX_HUB_NO_MANIFEST_FETCH";
          config.log(`manifest: repo-root ${manifestMod.MANIFEST_FILE} lookups skipped this pass (${why}) — release assets still read`);
        }
        const collected = await manifestMod.collect({
          repos: visible,
          releases,
          github: gh(),
          settings,
          allowRepoFetch,
          force,
          signal,
        });
        manifests = collected.manifests;
        const found = Object.keys(manifests).length;
        if (found) {
          config.log(
            `manifest: ${found} app(s) ship ${manifestMod.MANIFEST_FILE} (${collected.stats.asset} from a release asset, ${collected.stats.repo} from the repo root)`
          );
        }
      } catch (e) {
        // SPEC: a manifest NEVER breaks discovery.
        config.log(`manifest: pass failed (${e.message}) — continuing without manifests`);
      }

      const adb = await getAdbStatus(settings);
      const apps = buildApps({
        // ALL repos — hidden ones skip the release fetch above but must still
        // reach the app list so the UI's bottom section can show them.
        repos,
        releases,
        overlay,
        installedState: stateStore.load(),
        adb,
        primaryOwner: (settings.owners || [])[0] || null,
        settings,
        manifests, // v0.12 [manifest]
      });

      cached.releases = releasesByApp;
      cached.overlay = overlay;
      cached.manifests = manifests; // v0.12 [manifest]: rebuild() needs them
      cached.repos = visible;
      cached.releasesByRepo = releases;
      cached.apps = apps;
      cached.adb = adb;
      cached.errors = errors;
      cached.lastRefresh = new Date().toISOString();
      config.log(`discovery: ${apps.length} apps (${apps.filter((a) => !a.unpublished).length} published)`);
      const limited = errors.find((e) => e.rateLimited);
      // set while throttled, cleared as soon as a pass comes back clean
      cached.rateLimit = limited ? { resetAt: limited.resetAt || Date.now() + 60 * 60 * 1000, message: limited.message } : null;
      if (limited) deps.emit({ type: "toast", level: "warn", message: limited.message });
    } catch (e) {
      cached.errors = [{ source: "discovery", message: e.message }];
      config.log(`discovery failed: ${e.stack || e.message}`);
      deps.emit({ type: "toast", level: "error", message: `Discovery failed: ${e.message}` });
    } finally {
      cached.refreshing = false;
      inflight = null;
      deps.emit({ type: "state-changed" });
      // SPEC v0.2: update policies run after EVERY refresh (scheduled or
      // manual). Not awaited — a "download"/"install" policy must not hold the
      // refresh open; `policyPromise` lets callers/tests wait for it.
      if (typeof deps.afterRefresh === "function") {
        cached.policyPromise = Promise.resolve()
          .then(() => deps.afterRefresh(cached.apps))
          .catch((e) => config.log(`post-refresh update policies failed: ${e.message}`));
      }
    }
    return cached.apps;
  })();

  return inflight;
}

/** Re-merge installed state into the cached apps (no network) — after install/uninstall. */
function remerge() {
  const st = stateStore.load();
  const settings = config.load();
  for (const app of cached.apps) {
    // per-app prefs can change without a refresh (setAppPref) — re-read them
    const prefs = config.getAppPref(settings, app.id);
    app.localHidden = prefs.hidden === true;
    app.favorite = prefs.favorite === true;
    app.updatePolicy = config.effectiveUpdatePolicy(settings, app.id);
    app.includePrereleases = config.effectiveIncludePrereleases(settings, app.id);
    app.skippedVersion = prefs.skippedVersion || null;
    app.launchArgs = Array.isArray(prefs.launchArgs) ? prefs.launchArgs : [];
    app.launchEnv = prefs.launchEnv && typeof prefs.launchEnv === "object" ? prefs.launchEnv : {};
    mergeInstalled(app, st, cached.adb, settings);
  }
  return cached.apps;
}

/**
 * Rebuild the app models from the cached repos/releases with the CURRENT
 * settings — no network. Needed when a pref that changes release selection
 * (includePrereleases) or visibility flips.
 */
function rebuild() {
  if (!Array.isArray(cached.repos) || cached.repos.length === 0) return remerge();
  const settings = config.load();
  cached.apps = buildApps({
    repos: cached.repos,
    releases: cached.releasesByRepo || {},
    overlay: cached.overlay,
    installedState: stateStore.load(),
    adb: cached.adb,
    primaryOwner: (settings.owners || [])[0] || null,
    settings,
    manifests: cached.manifests || {}, // v0.12 [manifest]: no network on a rebuild
  });
  return cached.apps;
}

/* ------------------------------------------------------------------ */
/* v0.2: release list + per-release artifacts                          */
/* ------------------------------------------------------------------ */

/** Fetch (and cache) the full release list for one app — used by getReleases. */
async function fetchReleases(appId, { force = false, signal } = {}) {
  const app = findApp(appId);
  if (!app) return [];
  const [owner, name] = String(app.repo || "").split("/");
  if (!owner || !name) return [];
  const list = await gh().listReleases(owner, name, { force, signal });
  if (Array.isArray(list) && list.length) cached.releases[app.id] = list;
  return getReleases(app.id);
}

/** Raw release objects for an app (cached from the last refresh). */
function releasesFor(appId) {
  const list = cached.releases ? cached.releases[String(appId).toLowerCase()] : null;
  return Array.isArray(list) ? list : [];
}

/** SPEC: getReleases(appId) → [{tag, version, notes, publishedAt, prerelease, assets}] */
function getReleases(appId) {
  return releasesFor(appId).slice().sort(byRecency).map(releaseSummary);
}

/** Raw release with this tag (exact, then version-insensitive). */
function findRelease(appId, tag) {
  const wanted = String(tag || "");
  const list = releasesFor(appId);
  return (
    list.find((r) => String(r.tag_name) === wanted) ||
    list.find((r) => parseVersion(r.tag_name) === parseVersion(wanted)) ||
    null
  );
}

/**
 * Artifacts of ONE specific release, built with the same overlay rules as the
 * live model — so ids line up and `installVersion` can match by artifact id.
 */
function artifactsForRelease(appId, release) {
  const ovl = overlayFor(cached.overlay, appId);
  // v0.12 [manifest]: the same manifest the live model used, so ids, kinds and
  // notes line up with what `installVersion` is asked to match.
  const entry = manifestFor(appId);
  return buildArtifacts(release, ovl, entry && entry.manifest);
}

/**
 * v0.12 [manifest]: the cached manifest entry for an app — {present, source,
 * trusted, manifest, problems, dropped} — or null.
 */
function manifestFor(appId) {
  const app = findApp(appId);
  if (!app || !cached.manifests) return null;
  return cached.manifests[String(app.repo || "").toLowerCase()] || null;
}

/**
 * Find the artifact in `release` that corresponds to `artifactId` (SPEC v0.2
 * installVersion): same id first, then same kind+platform, then the same
 * overlay assetPattern / asset name shape.
 */
function matchArtifactInRelease(appId, artifactId, release, reference) {
  const rows = artifactsForRelease(appId, release);
  if (!rows.length) return null;
  const byId = rows.find((a) => a.id === artifactId);
  if (byId) return byId;
  if (reference) {
    const byKind = rows.find((a) => a.kind === reference.kind && a.platform === reference.platform);
    if (byKind) return byKind;
    const stem = String(reference.assetName || "")
      .toLowerCase()
      .replace(/[0-9]+(\.[0-9]+)*/g, "");
    const byName = rows.find(
      (a) =>
        String(a.assetName || "")
          .toLowerCase()
          .replace(/[0-9]+(\.[0-9]+)*/g, "") === stem
    );
    if (byName) return byName;
  }
  return null;
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
  const want = String(appId == null ? "" : appId).trim().toLowerCase();
  if (!want) return null;
  const exact = cached.apps.find((a) => a.id === want);
  if (exact) return exact;

  // v0.12: a repo from a non-primary source is keyed "<owner>--<name>" so two
  // owners' same-named repos cannot collide. Anything that only knows the bare
  // repo name — a connector client saying hello as itself, a person typing it —
  // would otherwise never find it.
  //
  // The fallback is deliberately refused when it is AMBIGUOUS: if two owners
  // both ship a "vrcx-mods", answering with either one defeats the entire point
  // of owner-scoping. Better to find nothing than to find the wrong app and
  // then stop, gate or attribute against it.
  if (want.includes("--")) return null;
  const matches = cached.apps.filter((a) => a.id === want || a.id.endsWith(`--${want}`));
  return matches.length === 1 ? matches[0] : null;
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
  rebuild,
  getReleases,
  fetchReleases,
  releasesFor,
  findRelease,
  artifactsForRelease,
  manifestFor, // v0.12 [manifest]
  matchArtifactInRelease,
  selectRelease,
  releaseSummary,
  prevInstallInfo,
  ROLLBACK_KINDS,
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
