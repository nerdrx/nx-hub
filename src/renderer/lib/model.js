// Defensive normalizers + selectors over the getState() payload.
//
// SPEC freezes the App model but leaves the exact shape of `jobs` and `adb`
// open; everything here tolerates the plausible variants (array or map, single
// device or list) so the UI can never crash on a shape surprise.

import { artifactHasUpdate } from './version.js';
import { normalizeAppPrefs, normalizeAppPref, isHiddenApp, isSkipped, GLOBAL_POLICIES } from './prefs.js';

export const DEFAULT_SETTINGS = {
  owners: ['nerdrx'],
  extraRepos: [],
  token: '',
  checkIntervalHours: 6,
  installRoot: '~/Applications',
  adbPath: 'adb',
  // v0.2
  appPrefs: {},
  updatePolicy: 'notify',
  includePrereleases: false,
  notifications: true,
  autostart: false,
  startMinimized: false,
  createDesktopEntries: true,
  maxConcurrentDownloads: 2,
  preferredDeviceSerial: '',
};

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/** 1–4 per SPEC; anything else falls back to the default. */
export function clampConcurrency(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.maxConcurrentDownloads;
  return Math.max(1, Math.min(4, v));
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

export function normalizeSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    owners: Array.isArray(s.owners) ? s.owners.filter(Boolean) : DEFAULT_SETTINGS.owners.slice(),
    extraRepos: Array.isArray(s.extraRepos) ? s.extraRepos.filter(Boolean) : [],
    token: typeof s.token === 'string' ? s.token : '',
    appPrefs: normalizeAppPrefs(s.appPrefs),
    updatePolicy: GLOBAL_POLICIES.includes(s.updatePolicy) ? s.updatePolicy : DEFAULT_SETTINGS.updatePolicy,
    includePrereleases: bool(s.includePrereleases, DEFAULT_SETTINGS.includePrereleases),
    notifications: bool(s.notifications, DEFAULT_SETTINGS.notifications),
    autostart: bool(s.autostart, DEFAULT_SETTINGS.autostart),
    startMinimized: bool(s.startMinimized, DEFAULT_SETTINGS.startMinimized),
    createDesktopEntries: bool(s.createDesktopEntries, DEFAULT_SETTINGS.createDesktopEntries),
    maxConcurrentDownloads: clampConcurrency(s.maxConcurrentDownloads),
    preferredDeviceSerial: typeof s.preferredDeviceSerial === 'string' ? s.preferredDeviceSerial : '',
  };
}

export function normalizeArtifact(artifact, latestVersion) {
  const a = artifact && typeof artifact === 'object' ? artifact : {};
  return {
    id: a.id || a.kind || 'artifact',
    label: a.label || a.assetName || a.kind || 'Artifact',
    platform: a.platform || 'linux',
    kind: a.kind || 'archive-dir',
    assetName: a.assetName || '',
    assetUrl: a.assetUrl || '',
    size: Number(a.size) || 0,
    packageId: a.packageId || '',
    postInstallNote: a.postInstallNote || '',
    postInstallCmd: a.postInstallCmd || '',
    installed: a.installed && typeof a.installed === 'object' ? a.installed : null,
    // A release may only ship some platforms; an artifact then survives from the
    // newest release that carried it, with its OWN version. sourceVersion is the
    // version this row should be compared and labelled against.
    sourceVersion: a.sourceVersion ? String(a.sourceVersion) : '',
    sourceTag: a.sourceTag ? String(a.sourceTag) : '',
    fromOlderRelease: !!a.fromOlderRelease,
    updateAvailable: artifactHasUpdate(a, a.sourceVersion || latestVersion),
    launchable: a.launchable !== false,
    // v0.2 — engines keep one previous install for rollback and may stage an
    // already-downloaded update that only needs applying.
    rollbackAvailable: !!(a.rollbackAvailable && a.installed),
    prevVersion: a.prevVersion ? String(a.prevVersion) : '',
    readyToInstall: !!a.readyToInstall,
  };
}

export function normalizeApp(app) {
  const a = app && typeof app === 'object' ? app : {};
  const repo = a.repo || (a.id ? `unknown/${a.id}` : 'unknown/unknown');
  const latest = a.latest && typeof a.latest === 'object' ? a.latest : null;
  const artifacts = asArray(a.artifacts).map((x) => normalizeArtifact(x, latest && latest.version));
  return {
    id: a.id || repo.split('/').pop().toLowerCase(),
    repo,
    name: a.name || repo.split('/').pop(),
    tagline: a.tagline || '',
    private: !!a.private,
    order: Number.isFinite(a.order) ? a.order : 100,
    unpublished: !!a.unpublished || (!latest && artifacts.length === 0),
    latest,
    artifacts,
    // v0.2 — main mirrors the per-app "hidden" pref here so a single flag can
    // hide an app even before appPrefs reach the renderer.
    localHidden: !!a.localHidden,
    // Bottom-section flags: overlay-hidden repos stay listed but out of the
    // main grid; installableHere=false means a release exists but nothing in
    // it installs from this machine. Absent field defaults to installable so
    // an older main process doesn't empty the grid.
    overlayHidden: !!a.overlayHidden,
    installableHere: a.installableHere !== false,
    hasAnyRelease: !!a.hasAnyRelease,
  };
}

export function normalizeJob(job) {
  const j = job && typeof job === 'object' ? job : {};
  return {
    id: j.id || j.jobId || '',
    appId: j.appId || '',
    artifactId: j.artifactId || '',
    phase: j.phase || 'download',
    pct: Number.isFinite(Number(j.pct)) ? Number(j.pct) : -1,
    message: j.message || '',
    // '' means "unknown" (live progress events carry no status) — treat as active.
    status: j.status || '',
    action: j.action || j.type || 'install',
  };
}

/**
 * adb can arrive as { connected, devices:[…] }, { device:{…} } or a bare array.
 * Normalized: { connected, devices:[{serial,model,state}], versions:{pkg:ver} }.
 */
export function normalizeAdb(adb) {
  const a = adb && typeof adb === 'object' ? adb : {};
  let devices = asArray(a.devices);
  if (!devices.length && a.device) devices = [a.device];
  if (!devices.length && Array.isArray(adb)) devices = adb;
  devices = devices
    .filter(Boolean)
    .map((d) =>
      typeof d === 'string'
        ? { serial: d, model: d, state: 'device' }
        : {
            serial: d.serial || d.id || '',
            model: d.model || d.product || d.serial || 'Android device',
            state: d.state || 'device',
          }
    );
  const online = devices.filter((d) => d.state === 'device');
  return {
    connected: typeof a.connected === 'boolean' ? a.connected && !!online.length : !!online.length,
    devices: online.length ? online : devices,
    versions: a.versions && typeof a.versions === 'object' ? a.versions : {},
    error: a.error || '',
  };
}

export function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const apps = asArray(s.apps).map(normalizeApp);
  apps.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name, 'en'));
  return {
    apps,
    settings: normalizeSettings(s.settings),
    jobs: asArray(s.jobs).map(normalizeJob),
    adb: normalizeAdb(s.adb),
    hubVersion: s.hubVersion || '',
    refreshing: !!s.refreshing,
    platform: s.platform || '',
    rateLimit: s.rateLimit && typeof s.rateLimit === 'object' ? s.rateLimit : null,
    tokenSource: s.tokenSource || '',
    hasToken: !!(s.hasToken || s.tokenSource || (s.settings && s.settings.token)),
  };
}

export function jobFor(jobs, appId, artifactId) {
  return (
    asArray(jobs).find(
      (j) => j && j.appId === appId && (!artifactId || !j.artifactId || j.artifactId === artifactId)
    ) || null
  );
}

export function ownerOf(repo) {
  const parts = String(repo || '').split('/');
  return parts.length > 1 ? parts[0] : '';
}

/** Owner badge shows when the repo owner is not the primary configured owner. */
export function showOwnerBadge(app, settings) {
  const primary = (settings && settings.owners && settings.owners[0]) || '';
  const owner = ownerOf(app && app.repo);
  if (!owner || !primary) return false;
  return owner.toLowerCase() !== String(primary).toLowerCase();
}

/** Case-insensitive subsequence match; returns a score (lower = better) or -1. */
export function fuzzyScore(query, text) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  if (!t) return -1;
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    score += 100 + (idx - ti);
    ti = idx + 1;
  }
  return score;
}

export function filterApps(apps, query) {
  const q = String(query || '').trim();
  if (!q) return asArray(apps);
  return asArray(apps)
    .map((app) => {
      const hay = [app.name, app.tagline, app.repo, app.id].filter(Boolean);
      let best = -1;
      for (const h of hay) {
        const s = fuzzyScore(q, h);
        if (s >= 0 && (best < 0 || s < best)) best = s;
      }
      return { app, score: best };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.app);
}

export function splitPublished(apps) {
  const list = asArray(apps);
  const inMainGrid = (a) => !a.unpublished && !a.overlayHidden && a.installableHere !== false;
  return {
    published: list.filter(inMainGrid),
    // Everything else — unreleased repos, releases with nothing installable on
    // this machine, overlay-hidden noise — lands in the bottom section.
    unpublished: list.filter((a) => !inMainGrid(a)),
  };
}

/** Why an app sits in the bottom section, as a human label. */
export function notInstallableReason(app) {
  if (!app) return '';
  if (app.overlayHidden) return 'hidden by the overlay registry';
  if (app.unpublished) {
    return app.hasAnyRelease
      ? 'releases exist, but no files the hub can install'
      : 'no releases yet';
  }
  const v = app.latest && app.latest.version ? ` — latest is ${app.latest.version}` : '';
  return `nothing installable on this machine${v}`;
}

/**
 * The job whose progress a card should show: queued/running only. Finished
 * jobs stay in main's history list and must never render as an eternal bar;
 * '' status means a live progress event — always active.
 */
export function activeJobFor(jobs, appId) {
  const active = (j) => !j.status || j.status === 'queued' || j.status === 'running';
  return asArray(jobs).find((j) => j && j.appId === appId && active(j)) || null;
}

export function githubUrl(repo) {
  return `https://github.com/${String(repo || '').replace(/^\/+/, '')}`;
}

export function releaseUrl(app) {
  if (!app) return '';
  const base = githubUrl(app.repo);
  return app.latest && app.latest.tag ? `${base}/releases/tag/${encodeURIComponent(app.latest.tag)}` : `${base}/releases`;
}

/* ------------------------------------------------------------ v0.2 selectors */

/** Hidden = per-app pref, or main's mirrored `localHidden` flag. */
export function appHidden(app, settings) {
  return isHiddenApp(app, (settings && settings.appPrefs) || {});
}

export function visibleApps(apps, settings) {
  return asArray(apps).filter((a) => !appHidden(a, settings));
}

export function hiddenApps(apps, settings) {
  return asArray(apps).filter((a) => appHidden(a, settings));
}

/**
 * Does this app want attention? True when any artifact has an update (or a
 * staged, ready-to-apply one) and the user has not skipped that exact version.
 */
export function appHasUpdate(app, settings) {
  if (!app || app.unpublished) return false;
  const arts = app.artifacts || [];
  const wants = arts.some((a) => a && (a.updateAvailable || a.readyToInstall));
  if (!wants) return false;
  const pref = normalizeAppPref(((settings && settings.appPrefs) || {})[app.id]);
  return !isSkipped(pref, app.latest && app.latest.version);
}

/** Badge number on the Manage tab: visible apps waiting for an update. */
export function updateBadgeCount(apps, settings) {
  return visibleApps(apps, settings).filter((a) => appHasUpdate(a, settings)).length;
}

/** "owner/repo" validation for the extraRepos input. */
export function isValidRepoRef(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(String(value || '').trim());
}
