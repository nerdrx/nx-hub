// NX Hub renderer — controller. No framework, no bundler: the view layer is a
// set of pure string renderers (views/*) and this file is the one place that
// touches the DOM and window.nxhub.
//
// Every v0.2 bridge method is optional: `caps` is probed once at boot and a
// missing method quietly removes its UI instead of breaking the page.

import {
  normalizeState,
  filterApps,
  splitPublished,
  activeJobFor,
  notInstallableReason,
  githubUrl,
  visibleApps,
  hiddenApps,
  updateBadgeCount,
  clampConcurrency,
} from './lib/model.js';
import { renderSettingsPanel, validateRepoRef } from './views/settings.js';
import {
  renderAppCard,
  renderUnpublishedCard,
  renderSkeletonCard,
  renderTokenHint,
  renderRateLimitBanner,
  renderHiddenSection,
  renderEmpty,
  artifactKey,
} from './views/card.js';
import { detectPlatform } from './lib/actions.js';
import { launchTiles, orderTiles, defaultView } from './lib/launcher.js';
import { renderLaunchGrid, renderSkeletonTiles } from './views/tile.js';
import { renderAppOptions, renderArgsPreview } from './views/appoptions.js';
import { renderVersionsSheet } from './views/versions.js';
import { renderDeviceChip, renderDevicesSheet } from './views/devices.js';
import {
  normalizeAppPref,
  splitArgs,
  joinArgs,
  envRows,
  envFromRows,
  validateEnvKey,
} from './lib/prefs.js';
import { normalizeReleases, isDowngrade, downgradeConfirmText, rollbackConfirmText, rollbackTargets } from './lib/releases.js';
import { parseHostPort } from './lib/devices.js';
import { freedLabel, normalizeImportResult } from './lib/storage.js';
import { esc } from './lib/html.js';
import * as icons from './views/icons.js';

const LS_KEY = 'nxhub.ui.v1';
const RECENTS_MAX = 12;

/** Optional v0.2 bridge methods — probed at boot, never assumed. */
const V02_METHODS = [
  'getReleases',
  'installVersion',
  'rollback',
  'setAppPref',
  'adbConnect',
  'adbSelectDevice',
  'getDeviceInfo',
  'getDiskUsage',
  'clearDownloadCache',
  'getLogs',
  'exportSettings',
  'importSettings',
];

const ui = {
  loaded: false,
  view: 'manage', // 'launch' | 'manage'
  viewRemembered: false,
  filter: '',
  expandedNotes: new Set(),
  dismissedNotes: new Set(),
  dismissedHints: new Set(),
  openMenu: '',
  unpubOpen: false,
  settingsOpen: false,
  draft: null,
  repoError: '',
  toasts: [],
  liveJobs: new Map(), // key `${appId}::${artifactId}` → job (progress events)
  rateLimit: null,
  platform: detectPlatform(),
  busy: false,
  // v0.2
  caps: {},
  sheet: null, // { kind: 'options' | 'versions' | 'devices', appId }
  prefDraft: null,
  prefError: '',
  releases: new Map(), // appId → { loading, error, releases }
  expandedRelNotes: new Set(),
  deviceInfo: null,
  deviceInfoError: '',
  adbHost: '',
  adbError: '',
  adbOk: '',
  adbBusy: false,
  diskUsage: null,
  diskLoading: false,
  freed: '',
  logs: {},
  importResult: null,
  recents: [],
  showHidden: false,
};

let state = normalizeState(null);
let toastSeq = 0;
let rafPending = false;

/* ------------------------------------------------------------------ storage */

function loadUiPrefs() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LS_KEY) || '{}');
    if (Array.isArray(saved.dismissedNotes)) ui.dismissedNotes = new Set(saved.dismissedNotes);
    if (Array.isArray(saved.dismissedHints)) ui.dismissedHints = new Set(saved.dismissedHints);
    if (Array.isArray(saved.recents)) ui.recents = saved.recents.filter((x) => typeof x === 'string').slice(0, RECENTS_MAX);
    if (typeof saved.unpubOpen === 'boolean') ui.unpubOpen = saved.unpubOpen;
    if (typeof saved.showHidden === 'boolean') ui.showHidden = saved.showHidden;
    if (saved.view === 'launch' || saved.view === 'manage') {
      ui.view = saved.view;
      ui.viewRemembered = true;
    }
  } catch {
    /* first run / storage disabled — defaults are fine */
  }
}

function saveUiPrefs() {
  try {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        dismissedNotes: [...ui.dismissedNotes],
        dismissedHints: [...ui.dismissedHints],
        unpubOpen: ui.unpubOpen,
        showHidden: ui.showHidden,
        recents: ui.recents,
        view: ui.view,
      })
    );
  } catch {
    /* ignore */
  }
}

/** Remember a launch so the launcher can float it to the front. */
function noteLaunch(appId, artifactId) {
  if (!appId) return;
  const key = `${appId}::${artifactId || ''}`;
  ui.recents = [key, ...ui.recents.filter((k) => k !== key)].slice(0, RECENTS_MAX);
  saveUiPrefs();
}

/* --------------------------------------------------------------- api access */

function api() {
  return typeof window !== 'undefined' && window.nxhub ? window.nxhub : null;
}

function detectCaps() {
  const nx = api();
  const caps = {};
  for (const m of V02_METHODS) caps[m] = !!(nx && typeof nx[m] === 'function');
  return caps;
}

async function call(method, ...args) {
  const nx = api();
  if (!nx || typeof nx[method] !== 'function') {
    toast('warn', `${method}() is not available in this build`);
    return null;
  }
  try {
    return await nx[method](...args);
  } catch (err) {
    toast('error', `${method} failed: ${(err && err.message) || err}`);
    return null;
  }
}

/** Like call(), but a missing method is simply "feature not present". */
async function maybeCall(method, ...args) {
  const nx = api();
  if (!nx || typeof nx[method] !== 'function') return null;
  try {
    return await nx[method](...args);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function pullState() {
  const nx = api();
  if (!nx) return;
  try {
    const raw = await nx.getState();
    state = normalizeState(raw);
    if (state.rateLimit) ui.rateLimit = state.rateLimit;
    ui.loaded = true;
    schedule();
  } catch (err) {
    ui.loaded = true;
    toast('error', `Could not read hub state: ${(err && err.message) || err}`);
    schedule();
  }
}

/* -------------------------------------------------------------------- jobs */

function jobsForRender() {
  const byKey = new Map();
  for (const j of state.jobs || []) byKey.set(`${j.appId}::${j.artifactId}`, j);
  for (const [k, j] of ui.liveJobs) byKey.set(k, { ...(byKey.get(k) || {}), ...j });
  return [...byKey.values()];
}

function jobForApp(jobs, appId) {
  return activeJobFor(jobs, appId);
}

/* ------------------------------------------------------------------ toasts */

function toast(level, message, opts = {}) {
  const id = `t${++toastSeq}`;
  const sticky = opts.sticky !== undefined ? opts.sticky : level === 'error';
  ui.toasts.push({ id, level, message: String(message || ''), sticky, action: opts.action || null });
  if (ui.toasts.length > 6) ui.toasts.splice(0, ui.toasts.length - 6);
  if (!sticky) {
    window.setTimeout(() => {
      ui.toasts = ui.toasts.filter((t) => t.id !== id);
      renderToasts();
    }, opts.timeout || 4200);
  }
  if (/rate limit/i.test(message)) {
    ui.rateLimit = ui.rateLimit || { resetAt: Date.now() + 60 * 60 * 1000 };
  }
  renderToasts();
  return id;
}

function renderToasts() {
  const host = document.getElementById('toasts');
  if (!host) return;
  host.innerHTML = ui.toasts
    .map(
      (t, i) => `<div class="toast toast-${esc(t.level)}" role="status" style="--i:${i}">
        <span>${esc(t.message)}</span>
        ${
          t.action
            ? `<button class="btn btn-violet btn-sm toast-act" data-act="${esc(t.action.act)}" data-app="${esc(
                t.action.appId || ''
              )}" data-art="${esc(t.action.artifactId || '')}" data-id="${esc(t.id)}">${esc(t.action.label)}</button>`
            : ''
        }
        <button class="btn btn-icon" data-act="close-toast" data-id="${esc(t.id)}" title="Dismiss">${icons.close}</button>
      </div>`
    )
    .join('');
}

/* ------------------------------------------------------------------ render */

function schedule() {
  if (rafPending) return;
  rafPending = true;
  const run = () => {
    rafPending = false;
    render();
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
  else window.setTimeout(run, 16);
}

function prefsMap() {
  return (state.settings && state.settings.appPrefs) || {};
}

/** Tiles for the launcher view, honouring the filter, prefs and recents. */
function currentTiles() {
  const tiles = launchTiles(filterApps(state.apps, ui.filter), {
    adb: state.adb,
    platform: state.platform || ui.platform,
    prefs: prefsMap(),
  });
  return orderTiles(tiles, { recents: ui.recents });
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  for (const tab of nav.querySelectorAll('[data-view]')) {
    const active = tab.getAttribute('data-view') === ui.view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const manage = document.getElementById('tab-manage');
  if (manage) {
    const n = ui.loaded ? updateBadgeCount(state.apps, state.settings) : 0;
    manage.innerHTML = `Manage${
      n ? `<span class="tab-badge" title="${n} app${n === 1 ? '' : 's'} with an update">${n}</span>` : ''
    }`;
  }
}

function renderDeviceSlot() {
  const host = document.getElementById('device-chip');
  if (!host) return;
  const devices = (state.adb && state.adb.devices) || [];
  const show = devices.length || ui.caps.adbConnect || ui.caps.getDeviceInfo;
  host.innerHTML = show ? renderDeviceChip(state.adb, ui.deviceInfo, { busy: ui.adbBusy }) : '';
}

function renderSheet() {
  const host = document.getElementById('sheet-root');
  if (!host) return;
  const sheet = ui.sheet;
  if (!sheet) {
    host.innerHTML = '';
    return;
  }
  if (sheet.kind === 'devices') {
    host.innerHTML = renderDevicesSheet(state, {
      info: ui.deviceInfo,
      infoError: ui.deviceInfoError,
      connecting: ui.adbBusy,
      error: ui.adbError,
      connected: ui.adbOk,
      host: ui.adbHost,
      caps: ui.caps,
    });
    return;
  }

  const app = (state.apps || []).find((a) => a.id === sheet.appId);
  if (!app) {
    host.innerHTML = '';
    return;
  }
  if (sheet.kind === 'options') {
    host.innerHTML = renderAppOptions(app, ui.prefDraft, {
      settings: state.settings,
      envError: ui.prefError,
      launchable: (app.artifacts || []).some((a) => a.launchable !== false),
    });
    return;
  }
  if (sheet.kind === 'versions') {
    const data = ui.releases.get(app.id) || { loading: true };
    host.innerHTML = renderVersionsSheet(app, data, {
      expanded: ui.expandedRelNotes,
      platform: state.platform || ui.platform,
      busy: !!jobForApp(jobsForRender(), app.id),
      now: Date.now(),
      caps: ui.caps.rollback === false ? false : ui.caps,
    });
  }
}

function render() {
  const grid = document.getElementById('grid');
  const unpubHost = document.getElementById('unpublished');
  const hiddenHost = document.getElementById('hidden-apps');
  const banner = document.getElementById('banner');
  const panelHost = document.getElementById('panel-root');
  const launchHost = document.getElementById('launch');
  const manageHost = document.getElementById('manage-view');
  if (!grid) return;

  renderTabs();
  renderDeviceSlot();
  renderSheet();
  const launchView = ui.view === 'launch';
  if (launchHost) launchHost.hidden = !launchView;
  if (manageHost) manageHost.hidden = launchView;

  const jobs = jobsForRender();
  const ctx = {
    settings: state.settings,
    prefs: prefsMap(),
    adb: state.adb,
    deviceInfo: ui.deviceInfo,
    caps: ui.caps,
    platform: state.platform || ui.platform,
    expandedNotes: ui.expandedNotes,
    dismissedNotes: ui.dismissedNotes,
    openMenu: ui.openMenu,
    now: Date.now(),
  };

  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.classList.toggle('spinning', !!state.refreshing || ui.busy);

  if (panelHost) {
    panelHost.innerHTML = ui.settingsOpen
      ? renderSettingsPanel(ui.draft, {
          hubVersion: state.hubVersion,
          tokenSource: state.tokenSource,
          repoError: ui.repoError,
          caps: ui.caps,
          apps: state.apps,
          diskUsage: ui.diskUsage,
          diskLoading: ui.diskLoading,
          freed: ui.freed,
          logs: ui.logs,
          importResult: ui.importResult,
        })
      : '';
  }

  if (!ui.loaded) {
    grid.innerHTML = new Array(4).fill(0).map(renderSkeletonCard).join('');
    if (unpubHost) unpubHost.innerHTML = '';
    if (hiddenHost) hiddenHost.innerHTML = '';
    if (launchHost) launchHost.innerHTML = launchView ? renderSkeletonTiles() : '';
    return;
  }

  if (launchHost && launchView) {
    launchHost.innerHTML = renderLaunchGrid(currentTiles(), {
      openMenu: ui.openMenu,
      filter: ui.filter,
      caps: ui.caps,
    });
  }

  const listed = visibleApps(state.apps, state.settings);
  const { published, unpublished } = splitPublished(listed);
  const shown = filterApps(published, ui.filter);
  const cards = shown.map((app) => renderAppCard(app, { ...ctx, job: jobForApp(jobs, app.id) }));

  const showTokenHint = !state.hasToken && !ui.dismissedHints.has('token') && !ui.filter;
  grid.innerHTML =
    (showTokenHint ? renderTokenHint() : '') + (cards.length ? cards.join('') : renderEmpty(ui.filter));

  if (banner) banner.innerHTML = ui.rateLimit ? renderRateLimitBanner(ui.rateLimit, Date.now()) : '';

  if (unpubHost) {
    const list = filterApps(unpublished, ui.filter);
    unpubHost.innerHTML = list.length
      ? `<button class="section-toggle ${ui.unpubOpen ? 'open' : ''}" data-act="toggle-unpub" aria-expanded="${ui.unpubOpen ? 'true' : 'false'}">
           ${icons.chevron}<span>Nothing to install — unreleased &amp; misc</span><span class="count">${list.length}</span>
         </button>
         ${ui.unpubOpen ? `<div class="grid grid-unpub">${list.map((a) => renderUnpublishedCard(a, notInstallableReason(a))).join('')}</div>` : ''}`
      : '';
  }

  if (hiddenHost) {
    const hidden = filterApps(hiddenApps(state.apps, state.settings), ui.filter);
    hiddenHost.innerHTML = renderHiddenSection(hidden, { open: ui.showHidden });
  }
}

/* ------------------------------------------------------------ settings glue */

function openSettings() {
  ui.draft = { ...state.settings, owners: [...state.settings.owners], extraRepos: [...state.settings.extraRepos] };
  ui.repoError = '';
  ui.importResult = null;
  ui.freed = '';
  ui.settingsOpen = true;
  schedule();
}

const SKIP_FIELDS = new Set(['ownerInput', 'repoInput', 'adbHost']);
const NUMBER_FIELDS = new Set(['checkIntervalHours', 'maxConcurrentDownloads']);

function readPanelInputs() {
  if (!ui.draft) return;
  const root = document.getElementById('panel-root');
  if (!root) return;
  for (const el of root.querySelectorAll('[data-field]')) {
    const field = el.getAttribute('data-field');
    if (SKIP_FIELDS.has(field)) continue;
    if (el.type === 'checkbox') {
      ui.draft[field] = !!el.checked;
    } else if (NUMBER_FIELDS.has(field)) {
      const n = Number(el.value);
      if (field === 'maxConcurrentDownloads') ui.draft[field] = clampConcurrency(n);
      else ui.draft[field] = Number.isFinite(n) && n >= 0 ? n : 6;
    } else {
      ui.draft[field] = el.value;
    }
  }
}

function panelInput(field) {
  const root = document.getElementById('panel-root');
  return root ? root.querySelector(`[data-field="${field}"]`) : null;
}

async function saveSettings() {
  if (!ui.draft) return;
  readPanelInputs();
  const d = ui.draft;
  const patch = {
    owners: d.owners,
    extraRepos: d.extraRepos,
    token: d.token || '',
    installRoot: d.installRoot || '',
    adbPath: d.adbPath || '',
    checkIntervalHours: Number(d.checkIntervalHours) || 0,
    updatePolicy: d.updatePolicy || 'notify',
    includePrereleases: !!d.includePrereleases,
    notifications: d.notifications !== false,
    autostart: !!d.autostart,
    startMinimized: !!d.startMinimized,
    createDesktopEntries: d.createDesktopEntries !== false,
    maxConcurrentDownloads: clampConcurrency(d.maxConcurrentDownloads),
  };
  const ok = await call('setSettings', patch);
  if (ok !== null) {
    toast('info', 'Settings saved');
    ui.settingsOpen = false;
    await pullState();
  }
  schedule();
}

/* -------------------------------------------------------------- app options */

function openOptions(appId) {
  const app = (state.apps || []).find((a) => a.id === appId);
  if (!app) return;
  const pref = normalizeAppPref(prefsMap()[appId]);
  ui.prefDraft = {
    ...pref,
    launchArgsText: joinArgs(pref.launchArgs),
    envRows: envRows(pref.launchEnv),
  };
  ui.prefError = '';
  ui.sheet = { kind: 'options', appId };
  ui.openMenu = '';
  schedule();
}

function readPrefDraft() {
  const root = document.getElementById('sheet-root');
  if (!root || !ui.prefDraft) return;
  for (const el of root.querySelectorAll('[data-pref]')) {
    const field = el.getAttribute('data-pref');
    if (el.type === 'checkbox') ui.prefDraft[field] = !!el.checked;
    else if (field === 'launchArgs') ui.prefDraft.launchArgsText = el.value;
    else ui.prefDraft[field] = el.value;
  }
  const rows = [];
  const at = (i) => (rows[i] = rows[i] || { key: '', value: '' });
  for (const el of root.querySelectorAll('[data-env-key]')) at(Number(el.getAttribute('data-env-key'))).key = el.value;
  for (const el of root.querySelectorAll('[data-env-val]')) at(Number(el.getAttribute('data-env-val'))).value = el.value;
  ui.prefDraft.envRows = rows.filter(Boolean);
}

async function saveAppPrefs(appId) {
  readPrefDraft();
  const d = ui.prefDraft;
  if (!d) return;
  for (const row of d.envRows || []) {
    if (!row.key && !row.value) continue;
    const err = validateEnvKey(row.key);
    if (err) {
      ui.prefError = `“${row.key || '(empty)'}”: ${err}`;
      schedule();
      return;
    }
  }
  const parsed = splitArgs(d.launchArgsText || '');
  if (parsed.error) {
    ui.prefError = parsed.error;
    schedule();
    return;
  }
  ui.prefError = '';
  const patch = {
    updatePolicy: d.updatePolicy,
    includePrereleases: !!d.includePrereleases,
    skippedVersion: d.skippedVersion || '',
    favorite: !!d.favorite,
    hidden: !!d.hidden,
    releaseFallback: d.releaseFallback !== false,
    launchArgs: parsed.args,
    launchEnv: envFromRows(d.envRows),
  };
  const ok = await call('setAppPref', appId, patch);
  if (ok !== null) {
    ui.sheet = null;
    ui.prefDraft = null;
    toast('info', 'App options saved');
    await pullState();
  }
  schedule();
}

/** One-field pref writes (favorite star, hide, skip) — no sheet needed. */
async function patchPref(appId, patch, message) {
  const current = normalizeAppPref(prefsMap()[appId]);
  const ok = await call('setAppPref', appId, { ...current, ...patch });
  if (ok === null) return;
  if (ui.prefDraft && ui.sheet && ui.sheet.appId === appId) Object.assign(ui.prefDraft, patch);
  if (message) toast('info', message);
  await pullState();
}

/* ------------------------------------------------------------ version sheet */

async function openVersions(appId) {
  const app = (state.apps || []).find((a) => a.id === appId);
  if (!app) return;
  ui.sheet = { kind: 'versions', appId };
  ui.openMenu = '';
  ui.expandedRelNotes = new Set();
  if (!ui.caps.getReleases) {
    ui.releases.set(appId, { loading: false, error: 'This build cannot read the release history.', releases: [] });
    schedule();
    return;
  }
  ui.releases.set(appId, { loading: true, releases: [] });
  schedule();
  try {
    const list = await maybeCall('getReleases', appId);
    ui.releases.set(appId, { loading: false, error: '', releases: normalizeReleases(list) });
  } catch (err) {
    ui.releases.set(appId, {
      loading: false,
      error: `Could not read releases: ${(err && err.message) || err}`,
      releases: [],
    });
  }
  schedule();
}

/* ---------------------------------------------------------------- devices */

async function refreshDeviceInfo() {
  if (!ui.caps.getDeviceInfo) return;
  try {
    const info = await maybeCall('getDeviceInfo');
    ui.deviceInfo = info || null;
    ui.deviceInfoError = info ? '' : 'No device details available.';
  } catch (err) {
    ui.deviceInfo = null;
    ui.deviceInfoError = `Could not read the device: ${(err && err.message) || err}`;
  }
  schedule();
}

async function connectDevice() {
  const root = document.getElementById('sheet-root');
  const input = root ? root.querySelector('[data-field="adbHost"]') : null;
  const value = input ? input.value : ui.adbHost;
  ui.adbHost = value;
  const parsed = parseHostPort(value);
  ui.adbOk = '';
  if (!parsed.ok) {
    ui.adbError = parsed.error;
    schedule();
    return;
  }
  ui.adbError = '';
  ui.adbBusy = true;
  schedule();
  try {
    const res = await maybeCall('adbConnect', parsed.hostPort);
    if (res && res.ok === false) {
      ui.adbError = String(res.error || res.message || `Could not connect to ${parsed.hostPort}.`);
    } else {
      ui.adbOk = `Connected to ${parsed.hostPort}.`;
      ui.adbHost = '';
    }
  } catch (err) {
    ui.adbError = `Could not connect: ${(err && err.message) || err}`;
  }
  ui.adbBusy = false;
  await pullState();
  await refreshDeviceInfo();
  schedule();
}

/* --------------------------------------------------------- storage & logs */

async function loadDiskUsage() {
  if (!ui.caps.getDiskUsage) return;
  ui.diskLoading = true;
  schedule();
  try {
    ui.diskUsage = await maybeCall('getDiskUsage');
  } catch (err) {
    ui.diskUsage = null;
    toast('error', `Could not measure disk usage: ${(err && err.message) || err}`);
  }
  ui.diskLoading = false;
  schedule();
}

async function loadLogs() {
  if (!ui.caps.getLogs) return;
  ui.logs = { loading: true };
  schedule();
  try {
    const out = await maybeCall('getLogs', 200);
    const text = Array.isArray(out) ? out.join('\n') : String(out || '');
    ui.logs = { loading: false, text: text || '(the log is empty)' };
  } catch (err) {
    ui.logs = { loading: false, error: `Could not read the log: ${(err && err.message) || err}` };
  }
  schedule();
}

async function exportSettingsFile() {
  try {
    const data = await maybeCall('exportSettings');
    if (data === null || data === undefined) {
      toast('warn', 'Nothing to export');
      return;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const blob = new window.Blob([text], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nx-hub-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 4000);
    toast('info', 'Settings exported as nx-hub-settings.json');
  } catch (err) {
    toast('error', `Export failed: ${(err && err.message) || err}`);
  }
}

async function importSettingsText(text) {
  try {
    const res = await maybeCall('importSettings', text);
    ui.importResult = normalizeImportResult(res);
  } catch (err) {
    ui.importResult = normalizeImportResult({ error: (err && err.message) || String(err) });
  }
  await pullState();
  if (ui.draft) {
    ui.draft = { ...state.settings, owners: [...state.settings.owners], extraRepos: [...state.settings.extraRepos] };
  }
  schedule();
}

/* ------------------------------------------------------------------ actions */

function findArtifact(appId, artifactId) {
  const app = (state.apps || []).find((a) => a.id === appId);
  if (!app) return { app: null, artifact: null };
  return { app, artifact: (app.artifacts || []).find((a) => a.id === artifactId) || null };
}

async function copyText(text, okMessage = 'Command copied to clipboard') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('info', okMessage);
  } catch {
    toast('warn', 'Could not access the clipboard — copy it by hand');
  }
}

function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** 180ms crossfade + slide on the view that just became visible. */
function animateView(view) {
  if (prefersReducedMotion()) return;
  const host = document.getElementById(view === 'launch' ? 'launch' : 'manage-view');
  if (!host || !host.classList) return;
  host.classList.remove('view-in');
  void host.offsetWidth; // restart the animation even when interrupted mid-flight
  host.classList.add('view-in');
  window.setTimeout(() => {
    try {
      host.classList.remove('view-in');
    } catch {
      /* element replaced */
    }
  }, 260);
}

function setView(view) {
  if (view !== 'launch' && view !== 'manage') return;
  if (ui.view === view) return;
  ui.view = view;
  ui.viewRemembered = true;
  ui.openMenu = '';
  saveUiPrefs();
  schedule();
  animateView(view);
}

/** Add a transient class to an element (pressed/launching, jump highlight). */
function flashTile(el, cls, ms) {
  if (!el || !el.classList) return;
  el.classList.add(cls);
  window.setTimeout(() => {
    try {
      el.classList.remove(cls);
    } catch {
      /* element already replaced by a re-render */
    }
  }, ms);
}

function scrollToCard(appId) {
  const run = () => {
    const card = document.querySelector(`[data-app-card="${CSS_ESCAPE(appId)}"]`);
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }
    flashTile(card, 'flash', 1400);
  };
  window.setTimeout(run, 60);
}

/** Minimal attribute-value escaper for the querySelector above. */
function CSS_ESCAPE(value) {
  return String(value || '').replace(/["\\]/g, '\\$&');
}

const DRAFT_ACTIONS = new Set(['add-owner', 'remove-owner', 'add-repo', 'remove-repo']);

async function onAction(act, el, ev) {
  const appId = el.getAttribute('data-app') || '';
  const artId = el.getAttribute('data-art') || '';
  // Settings actions are meaningless without an open draft.
  if (DRAFT_ACTIONS.has(act) && !ui.draft) return;

  switch (act) {
    case 'refresh':
      ui.busy = true;
      schedule();
      await call('refresh', true);
      ui.busy = false;
      ui.rateLimit = null;
      await pullState();
      break;
    case 'settings':
      openSettings();
      break;
    case 'close-settings':
      ui.settingsOpen = false;
      schedule();
      break;
    case 'save-settings':
      await saveSettings();
      break;
    case 'check-hub':
      toast('info', 'Checking for a hub update…');
      await call('refresh', true);
      await pullState();
      break;
    case 'step': {
      readPanelInputs();
      const field = el.getAttribute('data-field');
      const delta = Number(el.getAttribute('data-delta')) || 0;
      if (field === 'maxConcurrentDownloads' && ui.draft) {
        ui.draft[field] = clampConcurrency((Number(ui.draft[field]) || 2) + delta);
      }
      schedule();
      break;
    }
    case 'add-owner': {
      const input = panelInput('ownerInput');
      const value = input ? input.value.trim() : '';
      readPanelInputs();
      if (!value) break;
      if (!ui.draft.owners.includes(value)) ui.draft.owners.push(value);
      if (input) input.value = '';
      schedule();
      break;
    }
    case 'remove-owner':
      readPanelInputs();
      ui.draft.owners = ui.draft.owners.filter((o) => o !== el.getAttribute('data-value'));
      schedule();
      break;
    case 'add-repo': {
      const input = panelInput('repoInput');
      const value = input ? input.value.trim() : '';
      readPanelInputs();
      const error = validateRepoRef(value);
      ui.repoError = error;
      if (!error && !ui.draft.extraRepos.includes(value)) ui.draft.extraRepos.push(value);
      if (!error && input) input.value = '';
      schedule();
      break;
    }
    case 'remove-repo':
      readPanelInputs();
      ui.draft.extraRepos = ui.draft.extraRepos.filter((r) => r !== el.getAttribute('data-value'));
      schedule();
      break;
    case 'notes':
      if (ui.expandedNotes.has(appId)) ui.expandedNotes.delete(appId);
      else ui.expandedNotes.add(appId);
      schedule();
      break;
    case 'toggle-unpub':
      ui.unpubOpen = !ui.unpubOpen;
      saveUiPrefs();
      schedule();
      break;
    case 'toggle-hidden':
      ui.showHidden = !ui.showHidden;
      saveUiPrefs();
      schedule();
      break;
    case 'menu':
      ui.openMenu =
        ui.openMenu === artifactKey(appId, artId) ? '' : artifactKey(appId, artId);
      schedule();
      break;
    case 'install': {
      ui.openMenu = '';
      const key = `${appId}::${artId}`;
      const pending = {
        id: `pending-${appId}`,
        appId,
        artifactId: artId,
        phase: 'download',
        pct: -1,
        message: '',
      };
      ui.liveJobs.set(key, pending);
      schedule();
      // Safety net: if main never reports progress, drop the optimistic bar.
      window.setTimeout(() => {
        const cur = ui.liveJobs.get(key);
        if (cur && cur.id === pending.id) {
          ui.liveJobs.delete(key);
          schedule();
        }
      }, 8000);
      await call('install', appId, artId);
      break;
    }
    case 'launch':
      ui.openMenu = '';
      noteLaunch(appId, artId);
      await call('launch', appId, artId);
      break;
    case 'view':
      setView(el.getAttribute('data-view'));
      break;
    case 'tile-menu':
      ui.openMenu = ui.openMenu === el.getAttribute('data-tile') ? '' : el.getAttribute('data-tile');
      schedule();
      break;
    case 'tile-launch': {
      ui.openMenu = '';
      noteLaunch(appId, artId);
      flashTile(el.closest ? el.closest('.tile') : null, 'launching', 700);
      await call('launch', appId, artId);
      break;
    }
    case 'manage-jump':
      ui.openMenu = '';
      setView('manage');
      scrollToCard(appId);
      break;
    case 'uninstall': {
      ui.openMenu = '';
      const { app, artifact } = findArtifact(appId, artId);
      const label = artifact ? `${app.name} — ${artifact.label}` : appId;
      if (window.confirm(`Uninstall ${label}?`)) {
        await call('uninstall', appId, artId);
        await pullState();
      }
      break;
    }
    case 'folder': {
      ui.openMenu = '';
      const { artifact } = findArtifact(appId, artId);
      if (artifact && artifact.installed && artifact.installed.path) {
        await call('showInFolder', artifact.installed.path);
      } else {
        toast('warn', 'No install path recorded for this artifact');
      }
      schedule();
      break;
    }
    case 'github': {
      ui.openMenu = '';
      const { app } = findArtifact(appId, artId);
      await call('openExternal', githubUrl(app ? app.repo : ''));
      schedule();
      break;
    }
    case 'open': {
      const url = el.getAttribute('data-url') || el.getAttribute('href') || '';
      if (ev) ev.preventDefault();
      if (url && url !== '#') await call('openExternal', url);
      break;
    }
    case 'cancel': {
      const jobId = el.getAttribute('data-job');
      await call('cancelJob', jobId);
      for (const [k, j] of ui.liveJobs) if (j.id === jobId) ui.liveJobs.delete(k);
      schedule();
      break;
    }
    case 'copy':
      await copyText(el.getAttribute('data-copy') || '');
      break;
    case 'dismiss-note':
      ui.dismissedNotes.add(artifactKey(appId, artId));
      saveUiPrefs();
      schedule();
      break;
    case 'dismiss-hint':
      ui.dismissedHints.add(el.getAttribute('data-hint') || 'token');
      saveUiPrefs();
      schedule();
      break;
    case 'close-toast':
      ui.toasts = ui.toasts.filter((t) => t.id !== el.getAttribute('data-id'));
      renderToasts();
      break;
    case 'clear-filter': {
      ui.filter = '';
      const f = document.getElementById('filter');
      if (f) f.value = '';
      schedule();
      break;
    }

    /* ------------------------------------------------------------- v0.2 */

    case 'app-options':
      openOptions(appId);
      break;
    case 'close-sheet':
      ui.sheet = null;
      ui.prefDraft = null;
      ui.prefError = '';
      schedule();
      break;
    case 'save-app-prefs':
      await saveAppPrefs(appId);
      break;
    case 'env-add':
      readPrefDraft();
      if (ui.prefDraft) ui.prefDraft.envRows = [...(ui.prefDraft.envRows || []), { key: '', value: '' }];
      schedule();
      break;
    case 'env-remove': {
      readPrefDraft();
      const idx = Number(el.getAttribute('data-index'));
      if (ui.prefDraft && Number.isFinite(idx)) {
        ui.prefDraft.envRows = (ui.prefDraft.envRows || []).filter((_, i) => i !== idx);
      }
      schedule();
      break;
    }
    case 'toggle-fav': {
      ui.openMenu = '';
      const pref = normalizeAppPref(prefsMap()[appId]);
      const app = (state.apps || []).find((a) => a.id === appId);
      await patchPref(
        appId,
        { favorite: !pref.favorite },
        pref.favorite ? `${app ? app.name : appId} removed from favorites` : `${app ? app.name : appId} added to favorites`
      );
      break;
    }
    case 'hide-app': {
      ui.openMenu = '';
      const app = (state.apps || []).find((a) => a.id === appId);
      await patchPref(appId, { hidden: true }, `${app ? app.name : appId} hidden — reveal it under “Show hidden”`);
      break;
    }
    case 'unhide-app': {
      const app = (state.apps || []).find((a) => a.id === appId);
      await patchPref(appId, { hidden: false }, `${app ? app.name : appId} is visible again`);
      break;
    }
    case 'skip-version': {
      const version = el.getAttribute('data-version') || '';
      if (!version) break;
      await patchPref(appId, { skippedVersion: version }, `Skipping ${version}`);
      break;
    }
    case 'clear-skip':
      await patchPref(appId, { skippedVersion: '' }, 'No longer skipping that version');
      break;
    case 'versions':
      await openVersions(appId);
      break;
    case 'rel-notes': {
      const tag = el.getAttribute('data-tag') || '';
      if (ui.expandedRelNotes.has(tag)) ui.expandedRelNotes.delete(tag);
      else ui.expandedRelNotes.add(tag);
      schedule();
      break;
    }
    case 'install-version': {
      const tag = el.getAttribute('data-tag') || '';
      const { app, artifact } = findArtifact(appId, artId);
      if (!app || !artifact || !tag) break;
      const data = ui.releases.get(appId);
      const release = ((data && data.releases) || []).find((r) => r.tag === tag);
      const version = (release && release.version) || tag;
      const installed = artifact.installed && artifact.installed.version;
      if (isDowngrade(version, installed) && !window.confirm(downgradeConfirmText(app, artifact, version))) break;
      ui.sheet = null;
      schedule();
      toast('info', `Installing ${app.name} ${version}…`);
      await call('installVersion', appId, artId, tag);
      break;
    }
    case 'rollback': {
      ui.openMenu = '';
      const { app } = findArtifact(appId, artId);
      if (!app) break;
      const target = rollbackTargets(app).find((t) => t.artifactId === artId);
      if (!target) {
        toast('warn', 'No previous install kept for this artifact');
        break;
      }
      if (!window.confirm(rollbackConfirmText(app, target))) break;
      ui.sheet = null;
      schedule();
      await call('rollback', appId, artId);
      await pullState();
      break;
    }
    case 'devices':
      ui.sheet = { kind: 'devices' };
      ui.openMenu = '';
      ui.adbError = '';
      ui.adbOk = '';
      schedule();
      await refreshDeviceInfo();
      break;
    case 'select-device': {
      const serial = el.getAttribute('data-serial') || '';
      const ok = await call('adbSelectDevice', serial);
      if (ok !== null) {
        await pullState();
        await refreshDeviceInfo();
      }
      break;
    }
    case 'adb-connect':
      await connectDevice();
      break;
    case 'device-info':
      await refreshDeviceInfo();
      break;
    case 'disk-usage':
      await loadDiskUsage();
      break;
    case 'clear-cache': {
      const res = await call('clearDownloadCache');
      if (res !== null) {
        ui.freed = freedLabel(res);
        toast('info', ui.freed);
        await loadDiskUsage();
      }
      break;
    }
    case 'load-logs':
      await loadLogs();
      break;
    case 'copy-logs':
      await copyText((ui.logs && ui.logs.text) || '', 'Log copied to clipboard');
      break;
    case 'export-settings':
      await exportSettingsFile();
      break;
    case 'import-settings': {
      const input = document.getElementById('import-file');
      if (input && typeof input.click === 'function') input.click();
      break;
    }
    case 'update-app': {
      ui.toasts = ui.toasts.filter((t) => t.id !== el.getAttribute('data-id'));
      renderToasts();
      const app = (state.apps || []).find((a) => a.id === appId);
      if (!app) break;
      const targets = (app.artifacts || []).filter((a) => a.updateAvailable || a.readyToInstall);
      if (targets.length === 1) {
        await onAction('install', makeSynthetic({ 'data-app': appId, 'data-art': targets[0].id }), null);
      } else {
        setView('manage');
        scrollToCard(appId);
      }
      break;
    }
    default:
      break;
  }
}

/** Tiny stand-in element so one action can delegate to another. */
function makeSynthetic(attrs) {
  return {
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
    closest: () => null,
  };
}

/* ------------------------------------------------------------------- events */

function onHubEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'state-changed':
      pullState();
      break;
    case 'job-progress': {
      const key = `${ev.appId}::${ev.artifactId}`;
      ui.liveJobs.set(key, {
        id: ev.jobId,
        appId: ev.appId,
        artifactId: ev.artifactId,
        phase: ev.phase,
        pct: Number.isFinite(Number(ev.pct)) ? Number(ev.pct) : -1,
        message: ev.message || '',
      });
      schedule();
      break;
    }
    case 'job-done': {
      ui.liveJobs.delete(`${ev.appId}::${ev.artifactId}`);
      // A fresh install re-arms its post-install note.
      ui.dismissedNotes.delete(artifactKey(ev.appId, ev.artifactId));
      saveUiPrefs();
      if (ev.appId === 'nx-hub') toast('info', 'Hub updated — restarting…', { sticky: true });
      pullState();
      break;
    }
    case 'job-error':
      ui.liveJobs.delete(`${ev.appId}::${ev.artifactId}`);
      // Background-policy failures stay quiet — the update badge and the
      // card's own hints carry the state; only user-initiated jobs toast.
      if (!ev.silent) toast('error', ev.message || 'Job failed');
      pullState();
      break;
    case 'toast':
      toast(ev.level || 'info', ev.message || '');
      break;
    case 'update-available': {
      const app = (state.apps || []).find((a) => a.id === ev.appId);
      const name = (app && app.name) || ev.appId || 'An app';
      toast('info', `${name} ${ev.version || ''}`.trim() + ' is available', {
        timeout: 9000,
        action: { act: 'update-app', label: 'Update', appId: ev.appId },
      });
      pullState();
      break;
    }
    default:
      break;
  }
}

function wireDom() {
  document.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    const ext = target.closest('a[data-ext]');
    if (ext) {
      ev.preventDefault();
      const url = ext.getAttribute('href');
      if (url) call('openExternal', url);
      return;
    }

    const el = target.closest('[data-act]');
    if (!el) {
      if (ui.openMenu) {
        ui.openMenu = '';
        schedule();
      }
      return;
    }
    if (el.hasAttribute('disabled')) return;
    const act = el.getAttribute('data-act');
    if (act !== 'menu' && ui.openMenu && !el.closest('.menu')) ui.openMenu = '';
    onAction(act, el, ev);
  });

  // Right-click a launcher tile → its menu.
  document.addEventListener('contextmenu', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest('[data-tile]') : null;
    if (!target) return;
    ev.preventDefault();
    ui.openMenu = target.getAttribute('data-tile') || '';
    schedule();
  });

  // Icon files can disappear between installs — fall back to the monogram.
  document.addEventListener(
    'error',
    (ev) => {
      const img = ev.target;
      if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('tile-icon')) return;
      const span = document.createElement('span');
      span.className = 'tile-mono';
      span.textContent = img.getAttribute('data-fallback') || '?';
      if (img.parentNode && typeof img.parentNode.replaceChild === 'function') {
        img.parentNode.replaceChild(span, img);
      }
    },
    true
  );

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el) return;
    if (el.id === 'filter') {
      ui.filter = el.value;
      schedule();
      return;
    }
    // Live shell-split preview without re-rendering (keeps the caret put).
    if (el.getAttribute && el.getAttribute('data-pref') === 'launchArgs') {
      if (ui.prefDraft) ui.prefDraft.launchArgsText = el.value;
      const host = document.getElementById('args-preview');
      if (host) host.innerHTML = renderArgsPreview(el.value);
      return;
    }
    if (el.getAttribute && el.getAttribute('data-field') === 'adbHost') {
      ui.adbHost = el.value;
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el) return;
    if (el.id === 'import-file') {
      const file = el.files && el.files[0];
      if (!file) return;
      const done = (text) => {
        importSettingsText(text);
        try {
          el.value = '';
        } catch {
          /* ignore */
        }
      };
      if (typeof file.text === 'function') {
        file.text().then(done, (err) => toast('error', `Could not read the file: ${err && err.message}`));
      } else if (typeof window.FileReader === 'function') {
        const reader = new window.FileReader();
        reader.onload = () => done(String(reader.result || ''));
        reader.onerror = () => toast('error', 'Could not read the file');
        reader.readAsText(file);
      }
    }
  });

  document.addEventListener('keydown', (ev) => {
    const el = ev.target;
    const typing =
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    if (ev.key === '/' && !typing) {
      const f = document.getElementById('filter');
      if (f) {
        ev.preventDefault();
        f.focus();
        f.select();
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (ui.sheet) {
        ui.sheet = null;
        ui.prefDraft = null;
        ui.prefError = '';
        schedule();
      } else if (ui.settingsOpen) {
        ui.settingsOpen = false;
        schedule();
      } else if (ui.openMenu) {
        ui.openMenu = '';
        schedule();
      } else if (typing && el.id === 'filter') {
        ui.filter = '';
        el.value = '';
        el.blur();
        schedule();
      } else if (ui.toasts.length) {
        ui.toasts = [];
        renderToasts();
      }
      return;
    }
    if (ev.key === 'Enter' && typing && el.getAttribute) {
      const field = el.getAttribute('data-field');
      if (field === 'ownerInput') onAction('add-owner', el, ev);
      if (field === 'repoInput') onAction('add-repo', el, ev);
      if (field === 'adbHost') onAction('adb-connect', el, ev);
    }
  });
}

/* --------------------------------------------------------------- starfield */

// Two canvases drifting at different speeds. Both are drawn once and animated
// with transform only — no per-frame canvas work, nothing that can reflow.
const sky = { raf: 0, last: 0, far: null, near: null, width: 0, offFar: 0, offNear: 0, running: false };

function paintLayer(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 900;
  const h = canvas.clientHeight || 90;
  const tile = Math.max(200, Math.round(w / 2)); // the canvas is 200% wide: two identical tiles
  canvas.width = Math.round(tile * 2 * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return tile;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, tile * 2, h);

  // Deterministic PRNG so the sky is stable across re-renders/screenshots.
  let seed = opts.seed;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const count = Math.max(6, Math.round((tile / 7) * opts.density));
  for (let i = 0; i < count; i++) {
    const x = rnd() * tile;
    const y = rnd() * h;
    const r = (rnd() * 0.9 + 0.25) * opts.scale;
    const a = (0.12 + rnd() * 0.5) * opts.alpha;
    const cyan = rnd() > 0.88;
    for (const dx of [0, tile]) {
      ctx.beginPath();
      ctx.arc(x + dx, y, r, 0, Math.PI * 2);
      ctx.fillStyle = cyan ? `rgba(0,229,255,${a})` : `rgba(239,234,255,${a})`;
      ctx.fill();
    }
  }
  return tile;
}

function paintSky() {
  sky.far = document.getElementById('stars');
  sky.near = document.getElementById('stars-near');
  const tile = paintLayer(sky.far, { seed: 1337, density: 1, scale: 1, alpha: 1 });
  paintLayer(sky.near, { seed: 90210, density: 0.45, scale: 1.5, alpha: 1.15 });
  sky.width = tile || sky.width;
}

function skyFrame(ts) {
  sky.raf = 0;
  if (!sky.running) return;
  const dt = sky.last ? Math.min(64, ts - sky.last) : 16;
  sky.last = ts;
  const w = sky.width || 450;
  sky.offFar = (sky.offFar + dt * 0.0045) % w;
  sky.offNear = (sky.offNear + dt * 0.014) % w;
  if (sky.far && sky.far.style) sky.far.style.transform = `translate3d(${-sky.offFar.toFixed(2)}px,0,0)`;
  if (sky.near && sky.near.style) sky.near.style.transform = `translate3d(${-sky.offNear.toFixed(2)}px,0,0)`;
  requestSkyFrame();
}

function requestSkyFrame() {
  if (sky.raf || !sky.running) return;
  if (typeof window.requestAnimationFrame !== 'function') return;
  sky.raf = window.requestAnimationFrame(skyFrame);
}

function setSkyRunning(on) {
  const want = on && !prefersReducedMotion() && !document.hidden;
  // The nebula is pure CSS; park it on the same signal as the starfield so a
  // hidden window costs nothing.
  if (document.body && document.body.classList) document.body.classList.toggle('sky-parked', !want);
  if (want === sky.running) return;
  sky.running = want;
  sky.last = 0;
  if (want) requestSkyFrame();
  else if (sky.raf && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(sky.raf);
    sky.raf = 0;
  }
}

function startStarfield() {
  paintSky();
  setSkyRunning(true);
  window.addEventListener('resize', () => {
    paintSky();
  });
  document.addEventListener('visibilitychange', () => setSkyRunning(true));
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => setSkyRunning(true));
    }
  } catch {
    /* matchMedia unavailable — the static sky is fine */
  }
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  loadUiPrefs();
  const logoHost = document.getElementById('logo');
  if (logoHost) logoHost.innerHTML = icons.logo(34);
  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.innerHTML = icons.refresh;
  const gearBtn = document.getElementById('settings-btn');
  if (gearBtn) gearBtn.innerHTML = icons.gear;
  const searchIcon = document.getElementById('filter-icon');
  if (searchIcon) searchIcon.innerHTML = icons.search;

  startStarfield();
  wireDom();
  render();

  if (!api()) {
    try {
      const mock = await import('./mock.js');
      mock.installMock();
      document.body.classList.add('mock-mode');
    } catch (err) {
      toast('error', `No nxhub bridge and no mock available: ${(err && err.message) || err}`);
    }
  }

  ui.caps = detectCaps();

  const nx = api();
  if (nx && typeof nx.onEvent === 'function') {
    try {
      nx.onEvent(onHubEvent);
    } catch (err) {
      toast('warn', `Event stream unavailable: ${(err && err.message) || err}`);
    }
  }
  await pullState();
  // First run: open the launcher when there is anything to launch.
  if (!ui.viewRemembered) {
    ui.view = defaultView(currentTiles());
    schedule();
  }
  if (ui.caps.getDeviceInfo && state.adb && state.adb.connected) refreshDeviceInfo();
  window.__nxhubBooted = true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

// Exposed for the e2e hooks / dev toolbar.
export const __ui = ui;
export { toast, pullState, onHubEvent, boot };
