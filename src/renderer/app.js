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
  crashKey,
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
  autoRunChoice,
  autoRunFromChoice,
} from './lib/prefs.js';
import { normalizeReleases, isDowngrade, downgradeConfirmText, rollbackConfirmText, rollbackTargets } from './lib/releases.js';
import { clientsByApp, remoteByApp } from './lib/connector.js';
import {
  runningMap,
  stopKey,
  prunePending,
  stopOutcome,
} from './lib/running.js';
import {
  normalizeStacks,
  stackTiles,
  applyStackProgress,
  isFinished,
  blankDraft,
  blankStep,
  draftFromStack,
  validateDraft,
  moveStep,
  newRun,
  coerceStepFields,
  CLEAR_AFTER_MS,
} from './lib/stacks.js';
import { normalizeDevLinks, devTiles, devIds, devUnlinkConfirm } from './lib/dev.js';
import { renderStacksSheet } from './views/stacks.js';
import {
  normalizeFleet,
  fleetCounts,
  peerById,
  blankPairState,
  pairShowStart,
  pairCodeArrived,
  pairEnterStart,
  pairSubmitStart,
  pairResult,
  pairCancel,
  validatePairForm,
  foldFleetProgress,
  pruneFleetJobs,
  isCodeLive,
} from './lib/fleet.js';
import { renderPeerChip, renderFleetSheet } from './views/fleet.js';
import { parseHostPort } from './lib/devices.js';
import { freedLabel, normalizeImportResult } from './lib/storage.js';
import { esc } from './lib/html.js';
import {
  isFilterId,
  mergeEvents,
  normalizeEvents,
  pageQuery,
  hasMore,
  PAGE_SIZE,
  LIVE_DEBOUNCE_MS,
} from './lib/events.js';
import { renderActivitySheet } from './views/activity.js';
import { renderCheckpointSheet } from './views/checkpoint.js';
import {
  normalizePlan,
  hasWork,
  hasSnapshots,
  // v0.8's snapshot sheet already owns the name `restoreConfirmText`; the two
  // confirmations are different sentences about different scopes.
  restoreConfirmText as checkpointConfirmText,
  blankRun,
  startRun,
  foldCheckpointProgress,
  isRunning,
  isFinished as checkpointFinished,
} from './lib/checkpoint.js';
import { normalizeAudit, auditKey, auditSummary } from './lib/audit.js';
import {
  normalizeSnapshots,
  rollbackSnapshot,
  restoreConfirmText,
  deleteConfirmText,
  restoreResultText,
} from './lib/snapshots.js';
import { renderRollbackSheet } from './views/snapshots.js';
import {
  sandboxChoice,
  sandboxFromChoice,
  foldSupervisor,
  pruneSupervisor,
  dismissSupervisor,
} from './lib/guardian.js';
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
  'runPostInstallCmd',
];

/** Optional v0.5 (connector + stacks) bridge methods — same probe, same rule. */
const V05_METHODS = ['getConnector', 'getStacks', 'saveStack', 'deleteStack', 'runStack', 'stopStack'];

/** Optional v0.6 (fleet) bridge methods. No getFleet → no fleet UI at all. */
const V06_METHODS = [
  'getFleet',
  'fleetShowCode',
  'fleetPair',
  'fleetUnpair',
  'fleetInstall',
  'fleetLaunch',
  'fleetUpdateAll',
];

/**
 * Optional v0.7 (fabric) bridge methods. Cross-hub stacks need nothing new on
 * the bridge — they ride runStack — so this list is only the surfaces that do:
 * the dev links and wake-on-LAN.
 */
const V07_METHODS = ['getDevLinks', 'devRun', 'devUnlink', 'fleetWake'];

/**
 * Optional v0.8 bridge methods. The watchdog and the sandbox need nothing new —
 * they ride setAppPref — and signatures ride the app model plus one setting, so
 * this list is only the two surfaces that added IPC: the flight recorder and
 * the config time machine. No getEvents → no Activity button at all.
 */
const V08_METHODS = ['getEvents', 'getSnapshots', 'restoreSnapshot', 'deleteSnapshot'];

/**
 * Optional v0.10 bridge methods.
 *
 * The rest of v0.10 needs none: the federated roster and the field histories
 * ride getState().connector, and fleet settings sync is a setting. So this is
 * only [replay]'s two calls and [audit]'s two — and each surface is gated on
 * its OWN method, not on the group: a hub with the audit but no checkpoints
 * (or the reverse) must show exactly the half it has.
 */
const V10_METHODS = ['getCheckpoint', 'restoreCheckpoint', 'getAudit', 'repairInstall'];

/**
 * Optional v0.11 bridge method. The roster itself rides getState().running, so
 * ending an app is the only new call — and a build without it simply shows no
 * Stop control anywhere rather than offering a button that cannot work.
 */
const V11_METHODS = ['stopApp'];

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
  // v0.5 — the connector bus and stacks
  stacks: [],
  runs: {}, // stackId → run state folded from stack-progress events
  runTimers: new Map(), // stackId → the timer that clears a finished run
  stackDraft: null,
  stackErrors: {},
  stackBusy: false,
  // v0.6 — the fleet, the pairing flow and remote job progress
  fleet: { peers: [] },
  fleetSeen: false, // a peer was in the list at least once this session
  fleetBusy: false,
  fleetJobs: {}, // peerId → { key → job } folded from fleet-progress
  pair: blankPairState(),
  pairTimer: 0,
  dismissedCrashes: new Set(),
  // v0.7 — `nx dev link` checkouts. Empty until getDevLinks() answers, and
  // permanently empty in a build that has no such method.
  devLinks: [],
  // v0.8 — the flight recorder. One flat newest-first list plus the paging
  // cursor state; the chips slice it locally (see lib/events.js).
  activity: { filter: 'all', events: [], loading: false, paging: false, error: '', more: false },
  activityTimer: 0, // debounce for the live re-pull while the sheet is open
  // v0.8 — config snapshots, per app: appId → { loading, error, snapshots }.
  snapshots: new Map(),
  snapBusy: '', // the snapshot file a restore/delete is currently working on
  // v0.8 — watchdog news, keyed `${appId}::${artifactId}`.
  supervisor: {},
  // v0.8 — a rollback that has a matching pre-update snapshot to offer.
  rollbackDraft: null,
  // v0.10 — the checkpoint sheet: the moment asked for, the reconstructed plan
  // and, once confirmed, the folded checkpoint-progress run.
  checkpoint: { ts: 0, plan: null, loading: false, error: '', configs: false, busy: false, run: blankRun() },
  // v0.10 — the deep audit, run on demand from Settings → Storage. `ran` is
  // what separates "no problems" from "not checked yet".
  audit: { loading: false, error: '', rows: [], ran: false, repairing: '' },
  // v0.11 — stops the ladder is still walking: key → {appId, artifactId, peer,
  // at}. A key in here is a control reading "Stopping…" and refusing clicks;
  // prunePending() takes it back out when presence drops (see render()).
  stopping: new Map(),
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
    if (Array.isArray(saved.dismissedCrashes)) ui.dismissedCrashes = new Set(saved.dismissedCrashes);
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
        // Keyed by app + artifact + version, so a new install re-arms the banner.
        dismissedCrashes: [...ui.dismissedCrashes],
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
  for (const m of [
    ...V02_METHODS,
    ...V05_METHODS,
    ...V06_METHODS,
    ...V07_METHODS,
    ...V08_METHODS,
    ...V10_METHODS,
    ...V11_METHODS,
  ]) {
    caps[m] = !!(nx && typeof nx[m] === 'function');
  }
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

/** Apps currently announced on the LOCAL connector bus, keyed by app id. */
function busClients() {
  return clientsByApp(state.connector);
}

/**
 * v0.10 — apps announced on a PEER's bus, keyed by app id. Empty in a build
 * whose main process never sends `connector.remote`, which is what keeps every
 * remote surface off the screen rather than half-drawn.
 */
function remoteClients() {
  return remoteByApp(state.connector);
}

/**
 * v0.11 — appId → the running row that speaks for it. Cards index into this to
 * decide whether to offer Stop, and which artifact id to hand `stopApp`.
 */
function runningApps() {
  return runningMap(state.running);
}

/** peerId → the clients that peer relayed, for the fleet sheet's own rosters. */
function remoteByPeer() {
  const map = new Map();
  for (const peer of (state.connector && state.connector.remote) || []) {
    map.set(peer.peerId, peer.clients || []);
  }
  return map;
}

/**
 * Tiles for the launcher view, honouring the filter, prefs and recents.
 *
 * Dev tiles come last and stay out of the favorites/recents rotation: a linked
 * checkout is a tool you go looking for, and letting it shuffle the installed
 * apps around every time it runs would cost more than it gives.
 */
function currentTiles() {
  const tiles = launchTiles(filterApps(state.apps, ui.filter), {
    adb: state.adb,
    platform: state.platform || ui.platform,
    prefs: prefsMap(),
    clients: busClients(),
    // v0.11 — a hub-launched app that never joined the bus still gets a Stop.
    running: state.running,
  });
  return [...orderTiles(tiles, { recents: ui.recents }), ...devTiles(ui.devLinks, { filter: ui.filter })];
}

/** Wide stack tiles, with whatever a live run has reported so far. */
function currentStackTiles() {
  return stackTiles(ui.stacks, { apps: state.apps, runs: ui.runs, peers: ui.fleet.peers });
}

/**
 * Peers the stacks editor may point a step at. A build with no getFleet() has
 * no peers at all, which is what keeps the whole cross-hub half of the editor
 * off the screen.
 */
function editorPeers() {
  if (!ui.caps.getFleet) return [];
  return (ui.fleet.peers || []).map((p) => ({ id: p.id, name: p.name, online: !!p.online }));
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

/**
 * The header peer chip. It only exists once the bridge HAS a fleet and that
 * fleet has ever contained a peer — an unpaired hub shows nothing at all.
 */
function renderFleetSlot() {
  const host = document.getElementById('fleet-chip');
  if (!host) return;
  const peers = ui.fleet.peers || [];
  const show = !!ui.caps.getFleet && (peers.length > 0 || ui.fleetSeen);
  // v0.10 — how many apps the fleet is relaying right now, for the chip's title.
  const remoteLive = ((state.connector && state.connector.remote) || []).reduce(
    (n, r) => n + ((r.clients && r.clients.length) || 0),
    0
  );
  host.innerHTML = show ? renderPeerChip(peers, { busy: ui.fleetBusy, remoteLive }) : '';
}

/**
 * Replace a host's markup while keeping the reader where they were.
 *
 * These surfaces re-render wholesale on every state change — a checkbox, an
 * arriving event, a job's progress — and a fresh innerHTML always starts at
 * scroll 0. Without this, asking a long panel a question throws you away from
 * the answer: "Verify installs" sits at the bottom of Settings and renders its
 * results there, and the Activity timeline jumps every time the hub records
 * anything. The scroll only carries over while `key` is unchanged, so opening a
 * DIFFERENT sheet (or the same one for another app) still starts at the top.
 */
const scrollKeys = new WeakMap();

/** The scrolling element inside a sheet or the settings panel, if it has one. */
function scrollBodyOf(host) {
  if (!host || typeof host.querySelector !== 'function') return null;
  // Queried one class at a time rather than as a selector list: that is what the
  // renderer's own stub DOM understands, so the behaviour below is testable.
  return host.querySelector('.sheet-body') || host.querySelector('.panel-body');
}

function paint(host, html, key) {
  const prev = scrollBodyOf(host);
  const top = prev && scrollKeys.get(host) === key ? Number(prev.scrollTop) || 0 : 0;
  host.innerHTML = html;
  scrollKeys.set(host, key);
  if (!top) return;
  const next = scrollBodyOf(host);
  if (next) next.scrollTop = top;
}

function renderSheet() {
  const host = document.getElementById('sheet-root');
  if (!host) return;
  const sheet = ui.sheet;
  if (!sheet) {
    host.innerHTML = '';
    scrollKeys.set(host, '');
    return;
  }
  if (sheet.kind === 'activity') {
    paint(host, renderActivitySheet({
      ...ui.activity,
      now: Date.now(),
      // No getCheckpoint() → no "restore to here…" anywhere in the timeline.
      canRestore: !!ui.caps.getCheckpoint,
    }), 'activity');
    return;
  }
  if (sheet.kind === 'checkpoint') {
    paint(host, renderCheckpointSheet({
      ...ui.checkpoint,
      apps: state.apps,
      now: Date.now(),
      caps: ui.caps,
    }), 'checkpoint');
    return;
  }
  if (sheet.kind === 'fleet') {
    paint(host, renderFleetSheet({
      peers: ui.fleet.peers,
      apps: state.apps,
      pair: ui.pair,
      jobs: ui.fleetJobs,
      now: Date.now(),
      caps: ui.caps,
      settings: state.settings,
      remote: remoteByPeer(),
      // v0.11 — the sheet's "Live there" strips carry the same Stop as a card's.
      stopping: ui.stopping,
    }), 'fleet');
    return;
  }
  if (sheet.kind === 'stacks') {
    paint(host, renderStacksSheet({
      stacks: ui.stacks,
      apps: state.apps,
      peers: editorPeers(),
      draft: ui.stackDraft,
      errors: ui.stackErrors,
      runs: ui.runs,
      saving: ui.stackBusy,
    }), 'stacks');
    return;
  }
  if (sheet.kind === 'devices') {
    paint(host, renderDevicesSheet(state, {
      info: ui.deviceInfo,
      infoError: ui.deviceInfoError,
      connecting: ui.adbBusy,
      error: ui.adbError,
      connected: ui.adbOk,
      host: ui.adbHost,
      caps: ui.caps,
    }), 'devices');
    return;
  }

  const app = (state.apps || []).find((a) => a.id === sheet.appId);
  if (!app) {
    host.innerHTML = '';
    return;
  }
  if (sheet.kind === 'options') {
    paint(host, renderAppOptions(app, ui.prefDraft, {
      settings: state.settings,
      envError: ui.prefError,
      launchable: (app.artifacts || []).some((a) => a.launchable !== false),
      caps: ui.caps,
      snapshots: ui.snapshots.get(app.id) || { loading: true },
      snapBusy: ui.snapBusy,
      now: Date.now(),
    }), `options:${app.id}`);
    return;
  }
  if (sheet.kind === 'rollback') {
    const draft = ui.rollbackDraft;
    if (!draft || draft.appId !== app.id) {
      host.innerHTML = '';
      return;
    }
    paint(host, renderRollbackSheet(app, draft.target, draft.snapshot, {
      restoreConfig: draft.restoreConfig,
      busy: draft.busy,
    }), `rollback:${app.id}`);
    return;
  }
  if (sheet.kind === 'versions') {
    const data = ui.releases.get(app.id) || { loading: true };
    paint(host, renderVersionsSheet(app, data, {
      expanded: ui.expandedRelNotes,
      platform: state.platform || ui.platform,
      busy: !!jobForApp(jobsForRender(), app.id),
      now: Date.now(),
      caps: ui.caps.rollback === false ? false : ui.caps,
    }), `versions:${app.id}`);
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
  renderFleetSlot();
  renderSheet();
  const launchView = ui.view === 'launch';
  if (launchHost) launchHost.hidden = !launchView;
  if (manageHost) manageHost.hidden = launchView;

  const jobs = jobsForRender();
  // v0.8 — a "restarting" line dies the moment its app turns up on the bus (the
  // relaunch worked) or after it has simply aged out. Pruning at render time
  // means no timer has to exist for it.
  ui.supervisor = pruneSupervisor(ui.supervisor, { now: Date.now(), live: busClients() });
  // v0.11 — the same idea for stops in flight: SPEC says the control resolves
  // when presence drops, so the state that arrives IS the resolution. Pruning
  // here means no per-click timer has to exist for it.
  ui.stopping = prunePending(ui.stopping, {
    running: state.running,
    clients: busClients(),
    remote: remoteClients(),
    now: Date.now(),
  });
  const ctx = {
    settings: state.settings,
    prefs: prefsMap(),
    adb: state.adb,
    deviceInfo: ui.deviceInfo,
    caps: ui.caps,
    platform: state.platform || ui.platform,
    expandedNotes: ui.expandedNotes,
    dismissedNotes: ui.dismissedNotes,
    dismissedCrashes: ui.dismissedCrashes,
    openMenu: ui.openMenu,
    clients: busClients(),
    // v0.10 — the same app, seen on another hub's bus.
    remote: remoteClients(),
    // v0.11 — what is running here, and which stops are still walking the ladder.
    running: runningApps(),
    stopping: ui.stopping,
    // v0.7 — cards of apps that also have a checkout linked wear a DEV mark.
    devIds: devIds(ui.devLinks),
    // v0.8 — the watchdog's restarting lines and give-up banners.
    supervisor: ui.supervisor,
    now: Date.now(),
  };

  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.classList.toggle('spinning', !!state.refreshing || ui.busy);

  if (panelHost) {
    paint(
      panelHost,
      ui.settingsOpen
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
            // v0.10 — the deep audit lives inside the Storage section.
            audit: ui.audit,
            repairing: ui.audit.repairing,
          })
        : '',
      ui.settingsOpen ? 'settings' : ''
    );
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
      // v0.11 — so a tile whose stop is in flight reads "Stopping…" too.
      stopping: ui.stopping,
      stacks: currentStackTiles(),
      canEditStacks: !!ui.caps.saveStack,
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
    cliShim: d.cliShim !== false,
    autoRunPostInstallCmd: !!d.autoRunPostInstallCmd,
    requireSignatures: !!d.requireSignatures,
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
    // The tri-state lives in the draft as the select's own value.
    autoRunCmd: autoRunChoice(pref),
    launchArgsText: joinArgs(pref.launchArgs),
    envRows: envRows(pref.launchEnv),
    // v0.8 — the APP MODEL is authoritative for these two: main mirrors the
    // resolved pref onto the app, and the overlay is only visible there. Fall
    // back to the raw pref so a build that mirrors nothing still round-trips.
    keepAlive: app.keepAlive || !!pref.keepAlive,
    sandbox: sandboxChoice({ sandboxPref: app.sandboxPref || pref.sandbox }),
  };
  ui.prefError = '';
  ui.sheet = { kind: 'options', appId };
  ui.openMenu = '';
  schedule();
  loadSnapshots(appId);
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
    // null = inherit the global setting (an explicit "no per-app choice").
    autoRunCmd: autoRunFromChoice(d.autoRunCmd),
    launchArgs: parsed.args,
    launchEnv: envFromRows(d.envRows),
    // v0.8 — same tri-state trick for the sandbox: null clears the override.
    keepAlive: !!d.keepAlive,
    sandbox: sandboxFromChoice(d.sandbox),
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

/* ------------------------------------------------ v0.8 the flight recorder */

/**
 * Load one page. `append` lowers `until` to the oldest event already held; the
 * live re-pull and the first open both ask for the newest page instead.
 *
 * Nothing is filtered on the bridge — see lib/events.js for why — so the same
 * cursor is valid no matter which chip is active.
 */
async function loadActivity(opts = {}) {
  if (!ui.caps.getEvents) {
    ui.activity = { ...ui.activity, loading: false, error: 'This build has no flight recorder.' };
    schedule();
    return;
  }
  const append = !!opts.append;
  if (append) ui.activity.paging = true;
  else if (!opts.quiet) ui.activity.loading = true;
  if (!opts.quiet) schedule();

  const query = append ? pageQuery(ui.activity.events, PAGE_SIZE) : { limit: PAGE_SIZE };
  try {
    const page = normalizeEvents(await maybeCall('getEvents', query));
    const before = ui.activity.events.length;
    const merged = mergeEvents(ui.activity.events, page);
    ui.activity = {
      ...ui.activity,
      events: merged,
      error: '',
      loading: false,
      paging: false,
      // The first page decides whether a "Load more" exists at all; a page that
      // added nothing new ends the road either way.
      more: append ? hasMore(before, merged.length, page.length, PAGE_SIZE) : page.length >= PAGE_SIZE,
    };
  } catch (err) {
    ui.activity = {
      ...ui.activity,
      loading: false,
      paging: false,
      error: `Could not read the activity log: ${(err && err.message) || err}`,
    };
  }
  schedule();
}

function openActivity() {
  ui.sheet = { kind: 'activity' };
  ui.openMenu = '';
  ui.activity = { ...ui.activity, events: [], error: '', more: false, loading: true, paging: false };
  schedule();
  return loadActivity();
}

/**
 * Live tail. The recorder writes on every job, so a naive re-pull per event
 * would re-render the sheet several times a second during an install — hence
 * one trailing 2s debounce, and only while the sheet is actually open.
 */
function bumpActivity() {
  if (!ui.sheet || ui.sheet.kind !== 'activity' || !ui.caps.getEvents) return;
  if (ui.activityTimer) return;
  ui.activityTimer = window.setTimeout(() => {
    ui.activityTimer = 0;
    if (ui.sheet && ui.sheet.kind === 'activity') loadActivity({ quiet: true });
  }, LIVE_DEBOUNCE_MS);
}

function clearActivityTimer() {
  if (ui.activityTimer) window.clearTimeout(ui.activityTimer);
  ui.activityTimer = 0;
}

/* ------------------------------------------------ v0.10 checkpoint restore */

/**
 * Open the Checkpoint sheet for one moment and reconstruct its plan.
 *
 * The Activity sheet is REPLACED rather than stacked: two modal sheets at once
 * would fight for Escape, and coming back to a timeline that has meanwhile
 * tailed three new events is not "back" anyway. Cancelling closes out entirely.
 */
async function openCheckpoint(ts) {
  const when = Math.round(Number(ts) || 0);
  if (!when) return;
  ui.sheet = { kind: 'checkpoint' };
  ui.openMenu = '';
  // The tail belongs to the timeline we just left.
  clearActivityTimer();
  ui.checkpoint = { ts: when, plan: null, loading: true, error: '', configs: false, busy: false, run: blankRun() };
  schedule();
  await loadCheckpoint();
}

async function loadCheckpoint() {
  const when = ui.checkpoint.ts;
  if (!when) return;
  if (!ui.caps.getCheckpoint) {
    ui.checkpoint = { ...ui.checkpoint, loading: false, error: 'This build cannot reconstruct checkpoints.' };
    schedule();
    return;
  }
  ui.checkpoint = { ...ui.checkpoint, loading: true, error: '' };
  schedule();
  try {
    const plan = normalizePlan(await maybeCall('getCheckpoint', when), { ts: when });
    ui.checkpoint = {
      ...ui.checkpoint,
      plan,
      loading: false,
      error: '',
      // Restoring configs is opt-IN: it overwrites files the user may have
      // edited since, and SPEC makes it an explicit option for that reason.
      configs: false,
    };
  } catch (err) {
    ui.checkpoint = {
      ...ui.checkpoint,
      loading: false,
      error: `Could not reconstruct that point: ${(err && err.message) || err}`,
    };
  }
  schedule();
}

async function confirmCheckpoint() {
  const { plan, ts, configs } = ui.checkpoint;
  if (!plan || !hasWork(plan) || ui.checkpoint.busy) return;
  if (!window.confirm(checkpointConfirmText(plan, { configs }))) return;
  ui.checkpoint = { ...ui.checkpoint, busy: true, run: startRun(Date.now()) };
  schedule();
  // The progress rows arrive as events; the call itself only resolves at the
  // end (or throws), so the answer is the FALLBACK ending, never the only one.
  const res = await call('restoreCheckpoint', ts, { configs: !!configs && hasSnapshots(plan) });
  ui.checkpoint = { ...ui.checkpoint, busy: false };
  if (res === null) {
    // call() already toasted. Mark the run failed so the sheet stops spinning.
    ui.checkpoint = {
      ...ui.checkpoint,
      run: { ...ui.checkpoint.run, phase: 'failed', error: ui.checkpoint.run.error || 'the restore could not be started' },
    };
  } else if (!checkpointFinished(ui.checkpoint.run)) {
    // A main process that answers without ever emitting a terminal event still
    // has to end the sheet's "restoring" state.
    const failed = res && res.ok === false;
    ui.checkpoint = {
      ...ui.checkpoint,
      run: {
        ...ui.checkpoint.run,
        phase: failed ? 'failed' : 'done',
        error: failed ? String((res && res.error) || '') : '',
      },
    };
  }
  await pullState();
  schedule();
}

/* ----------------------------------------------------------- v0.10 audit */

async function runAudit() {
  if (!ui.caps.getAudit) {
    ui.audit = { ...ui.audit, loading: false, ran: true, error: 'This build cannot verify installs.' };
    schedule();
    return;
  }
  ui.audit = { ...ui.audit, loading: true, error: '' };
  schedule();
  try {
    const rows = normalizeAudit(await maybeCall('getAudit'));
    ui.audit = { ...ui.audit, rows, loading: false, error: '', ran: true };
    const s = auditSummary(rows);
    toast(
      s.broken ? 'warn' : 'info',
      s.broken
        ? `${s.broken} install${s.broken === 1 ? '' : 's'} need${s.broken === 1 ? 's' : ''} attention`
        : `Checked ${s.total} install${s.total === 1 ? '' : 's'} — everything is intact`
    );
  } catch (err) {
    ui.audit = {
      ...ui.audit,
      loading: false,
      ran: true,
      error: `Could not verify the installs: ${(err && err.message) || err}`,
    };
  }
  schedule();
}

/**
 * Repair = reinstall through the normal pipeline, so the JOB events take over
 * from here: the app's own card grows its progress bar, the toast says where to
 * look, and the audit row is left alone until the next verify. Inventing a
 * second progress surface for the same bytes is exactly how two of them drift.
 */
async function repairInstall(appId, artifactId) {
  const key = auditKey(appId, artifactId);
  ui.audit = { ...ui.audit, repairing: key };
  schedule();
  const res = await call('repairInstall', appId, artifactId);
  ui.audit = { ...ui.audit, repairing: '' };
  if (res !== null) {
    const app = (state.apps || []).find((a) => a.id === appId);
    toast('info', `Reinstalling ${(app && app.name) || appId} — follow it on its card`);
  }
  schedule();
  return res;
}

/* --------------------------------------------------- v0.8 config snapshots */

async function loadSnapshots(appId, opts = {}) {
  if (!appId) return null;
  if (!ui.caps.getSnapshots) {
    ui.snapshots.set(appId, { loading: false, error: '', snapshots: [] });
    return [];
  }
  if (!opts.quiet) {
    ui.snapshots.set(appId, { ...(ui.snapshots.get(appId) || {}), loading: true, error: '' });
    schedule();
  }
  try {
    const list = normalizeSnapshots(await maybeCall('getSnapshots', appId));
    ui.snapshots.set(appId, { loading: false, error: '', snapshots: list });
    schedule();
    return list;
  } catch (err) {
    ui.snapshots.set(appId, {
      loading: false,
      error: `Could not read the snapshots: ${(err && err.message) || err}`,
      snapshots: [],
    });
    schedule();
    return null;
  }
}

/**
 * restoreSnapshot() toasts on its own success (frozen surface), so the renderer
 * only speaks up when the answer says otherwise — saying it twice is exactly
 * the bug the devRun path already taught us to avoid.
 */
async function restoreSnapshotFile(appId, file, opts = {}) {
  const app = (state.apps || []).find((a) => a.id === appId);
  const res = await call('restoreSnapshot', appId, file);
  if (res === null) return false;
  if (res && res.ok === false) {
    toast('error', restoreResultText(app, res));
    return false;
  }
  // The restore snapshots the current config first, so the list grew.
  await loadSnapshots(appId, { quiet: opts.quiet });
  return true;
}

/* -------------------------------------------------------------- dev links */

async function loadDevLinks() {
  if (!ui.caps.getDevLinks) return;
  try {
    ui.devLinks = normalizeDevLinks(await maybeCall('getDevLinks'));
  } catch (err) {
    ui.devLinks = [];
    toast('error', `Could not read the dev links: ${(err && err.message) || err}`);
  }
  schedule();
}

/* ----------------------------------------------------------------- stacks */

async function loadStacks() {
  if (!ui.caps.getStacks) return;
  try {
    ui.stacks = normalizeStacks(await maybeCall('getStacks'));
  } catch (err) {
    ui.stacks = [];
    toast('error', `Could not read the stacks: ${(err && err.message) || err}`);
  }
  schedule();
}

function openStacks() {
  ui.sheet = { kind: 'stacks' };
  ui.stackDraft = null;
  ui.stackErrors = {};
  ui.openMenu = '';
  schedule();
  return loadStacks();
}

function editStack(stackId) {
  const stack = ui.stacks.find((s) => s.id === stackId);
  ui.sheet = { kind: 'stacks' };
  ui.stackDraft = stack ? draftFromStack(stack) : blankDraft();
  ui.stackErrors = {};
  ui.openMenu = '';
  schedule();
}

/**
 * Read the editor inputs back into the draft. Same contract as readPrefDraft():
 * the DOM is the source of truth between renders so nothing a user typed is
 * lost when a step is added, moved or removed.
 */
function readStackDraft() {
  const root = document.getElementById('sheet-root');
  if (!root || !ui.stackDraft) return;
  // Stack-level fields: the name and everything in the Automation section.
  for (const el of root.querySelectorAll('[data-stack-field]')) {
    const field = el.getAttribute('data-stack-field');
    if (!field) continue;
    if (el.type === 'checkbox') ui.stackDraft[field] = !!el.checked;
    else ui.stackDraft[field] = el.value;
  }

  const steps = (ui.stackDraft.steps || []).map((s) => ({ ...s }));
  const wasApp = steps.map((s) => s.appId);
  for (const el of root.querySelectorAll('[data-step-field]')) {
    const i = Number(el.getAttribute('data-index'));
    const field = el.getAttribute('data-step-field');
    if (!Number.isInteger(i) || !steps[i] || !field) continue;
    if (field === 'optional') steps[i].optional = !!el.checked;
    else steps[i][field] = el.value;
  }
  // A step that now points at another app cannot keep the old app's artifact.
  steps.forEach((s, i) => {
    if (s.appId !== wasApp[i]) s.artifactId = '';
  });
  // v0.7 — a wake needs a peer, and a peered step cannot gate on this hub's bus.
  // Coercing on every read means the inputs can never disagree with each other,
  // whatever order the user touched them in.
  ui.stackDraft.steps = steps.map((s) => coerceStepFields(s));
}

function patchSteps(fn) {
  readStackDraft();
  if (!ui.stackDraft) return;
  ui.stackDraft.steps = fn((ui.stackDraft.steps || []).map((s) => ({ ...s })));
  schedule();
}

async function saveStackDraft() {
  readStackDraft();
  const draft = ui.stackDraft;
  if (!draft) return;
  const { ok, errors, stack } = validateDraft(draft, ui.stacks);
  ui.stackErrors = errors;
  if (!ok) {
    schedule();
    return;
  }
  // The id is slugified from the name, so a rename mints a new id — the old
  // entry has to go or the same stack would show up twice.
  const renamedFrom = draft.originalId && draft.originalId !== stack.id ? draft.originalId : '';
  ui.stackBusy = true;
  schedule();
  const res = await call('saveStack', stack);
  ui.stackBusy = false;
  if (res === null) {
    schedule();
    return;
  }
  if (renamedFrom && ui.caps.deleteStack) {
    try {
      await maybeCall('deleteStack', renamedFrom);
    } catch {
      /* the rename still saved — a stale entry is not worth a scary toast */
    }
  }
  ui.stackDraft = null;
  ui.stackErrors = {};
  toast('info', `Stack “${stack.name}” saved`);
  await loadStacks();
}

async function deleteStack(stackId) {
  const stack = ui.stacks.find((s) => s.id === stackId);
  if (!stack) return;
  if (!window.confirm(`Delete the stack “${stack.name}”? The apps in it stay installed.`)) return;
  const res = await call('deleteStack', stackId);
  if (res === null) return;
  toast('info', `Stack “${stack.name}” deleted`);
  await loadStacks();
}

function clearRunTimer(stackId) {
  const timer = ui.runTimers.get(stackId);
  if (timer) {
    window.clearTimeout(timer);
    ui.runTimers.delete(stackId);
  }
}

function setRun(stackId, run) {
  const next = { ...ui.runs };
  if (run) next[stackId] = run;
  else delete next[stackId];
  ui.runs = next;
}

async function startStack(stackId) {
  if (!stackId) return;
  clearRunTimer(stackId);
  // Optimistic: the tile reads as running before the first event arrives.
  setRun(stackId, newRun(stackId));
  schedule();
  const res = await call('runStack', stackId);
  // null = the method is missing or threw; false = main refused (already
  // running). Either way the optimistic run has to go, or the tile would sit
  // there claiming to run with no events ever arriving.
  if (res === null || res === false) {
    setRun(stackId, null);
    if (res === false) toast('warn', 'That stack is already running');
    schedule();
  }
}

async function stopStackRun(stackId) {
  if (!stackId) return;
  const run = ui.runs[stackId];
  if (run) setRun(stackId, { ...run, phase: 'stopping' });
  schedule();
  await call('stopStack', stackId);
}

/** Fold one stack-progress event in; a finished run fades off the tile. */
function onStackProgress(ev) {
  const stackId = String((ev && ev.stackId) || '');
  if (!stackId) return;
  const stack = ui.stacks.find((s) => s.id === stackId) || null;
  const next = applyStackProgress(ui.runs[stackId] || null, ev, { stack });
  if (!next) return;
  clearRunTimer(stackId);
  setRun(stackId, next);
  if (isFinished(next)) {
    const timer = window.setTimeout(() => {
      ui.runTimers.delete(stackId);
      if (isFinished(ui.runs[stackId])) {
        setRun(stackId, null);
        schedule();
      }
    }, CLEAR_AFTER_MS);
    ui.runTimers.set(stackId, timer);
  }
  schedule();
}

/* ------------------------------------------------------------------ fleet */

async function loadFleet() {
  if (!ui.caps.getFleet) return;
  try {
    ui.fleet = normalizeFleet(await maybeCall('getFleet'));
    if (ui.fleet.peers.length) ui.fleetSeen = true;
  } catch (err) {
    ui.fleet = { peers: [] };
    toast('error', `Could not read the fleet: ${(err && err.message) || err}`);
  }
  // A peer that vanished takes its job rows with it.
  ui.fleetJobs = pruneFleetJobs(ui.fleetJobs, Date.now());
  schedule();
}

function openFleet() {
  ui.sheet = { kind: 'fleet' };
  ui.openMenu = '';
  ui.pair = blankPairState();
  clearPairTimer();
  schedule();
  return loadFleet();
}

function clearPairTimer() {
  if (ui.pairTimer) {
    window.clearInterval(ui.pairTimer);
    ui.pairTimer = 0;
  }
}

/** While a code is on screen its countdown has to move — one timer, no more. */
function armPairTimer() {
  clearPairTimer();
  ui.pairTimer = window.setInterval(() => {
    if (!ui.sheet || ui.sheet.kind !== 'fleet' || !isCodeLive(ui.pair, Date.now())) {
      clearPairTimer();
      // One last render so "expired" replaces the last tick.
      schedule();
      return;
    }
    schedule();
  }, 1000);
}

/** Read the pairing form back out of the DOM (same contract as readPrefDraft). */
function readPairInputs() {
  const root = document.getElementById('sheet-root');
  if (!root) return;
  for (const el of root.querySelectorAll('[data-fleet-field]')) {
    const field = el.getAttribute('data-fleet-field');
    if (field === 'host') ui.pair = { ...ui.pair, host: el.value };
    else if (field === 'code') ui.pair = { ...ui.pair, input: el.value };
  }
}

async function showPairCode() {
  ui.pair = pairShowStart(ui.pair);
  schedule();
  if (!ui.caps.fleetShowCode) {
    ui.pair = { ...ui.pair, busy: false, error: 'This build cannot show a pairing code.' };
    schedule();
    return;
  }
  try {
    const res = await maybeCall('fleetShowCode');
    ui.pair = pairCodeArrived(ui.pair, res, Date.now());
  } catch (err) {
    ui.pair = { ...ui.pair, busy: false, error: `Could not arm pairing: ${(err && err.message) || err}` };
  }
  if (isCodeLive(ui.pair, Date.now())) armPairTimer();
  schedule();
}

async function submitPair() {
  readPairInputs();
  const { ok, errors, host, code } = validatePairForm(ui.pair.host, ui.pair.input);
  if (!ok) {
    ui.pair = { ...ui.pair, errors, error: '' };
    schedule();
    return;
  }
  ui.pair = { ...pairSubmitStart(ui.pair, host, ui.pair.input), errors: {} };
  schedule();
  let res = null;
  try {
    res = await maybeCall('fleetPair', host, code);
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  ui.pair = pairResult(ui.pair, res, { host });
  if (!ui.pair.error) {
    toast('info', ui.pair.ok || 'Paired');
    await loadFleet();
  }
  schedule();
}

/** The artifact a fleet row asks for: the compact picker wins, else the row's. */
function fleetArtifact(el, peerId, appId) {
  const root = document.getElementById('sheet-root');
  const pick = root ? root.querySelector(`[data-fleet-art="${CSS_ESCAPE(`${peerId}::${appId}`)}"]`) : null;
  if (pick && pick.value) return pick.value;
  return el.getAttribute('data-art') || '';
}

async function fleetAction(method, el, verb) {
  const peerId = el.getAttribute('data-peer') || '';
  const appId = el.getAttribute('data-app') || '';
  if (!peerId || !appId) return;
  const peer = peerById(ui.fleet.peers, peerId);
  const artifactId = fleetArtifact(el, peerId, appId);
  const res = await call(method, peerId, appId, artifactId);
  if (res === null) return;
  toast('info', `${verb} ${appId} on ${peer ? peer.name : 'that hub'}…`);
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
    /* ------------------------------------------------------------ v0.11 */
    case 'stop-app': {
      ui.openMenu = '';
      if (!appId) break;
      const peer = el.getAttribute('data-peer') || '';
      const key = stopKey(appId, artId, peer);
      // A second click while the ladder runs is not a second stop. The control
      // is disabled, but Enter on a focused button can still land mid-render.
      if (ui.stopping.has(key)) break;
      ui.stopping.set(key, { appId, artifactId: artId, peer, at: Date.now() });
      schedule();

      // SPEC's signature: the artifact is optional, and passing '' for "I do not
      // know which build" would be a lie the backend has to unpick.
      const res = await call('stopApp', appId, artId || undefined, peer ? { peer } : undefined);
      const name = (state.apps.find((a) => a.id === appId) || {}).name || appId;
      const outcome = stopOutcome(res, name);
      if (!outcome.quiet) toast(outcome.level, outcome.message);
      // Pull the truth back: the roster is what makes the strip, the tile dot
      // and this control disappear together. Whatever survives that (an app
      // that ignored the request and outlived SIGTERM) gets its button back.
      await pullState();
      ui.stopping.delete(key);
      schedule();
      break;
    }
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
    case 'run-cmd': {
      // Ids only — main resolves and executes the artifact's own command.
      el.disabled = true;
      const label = el.querySelector('span');
      if (label) label.textContent = 'Running…';
      try {
        await call('runPostInstallCmd', appId, artId);
      } finally {
        el.disabled = false;
        if (label) label.textContent = 'Run';
      }
      break;
    }
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
      closeSheet();
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
      // v0.8 rollback affinity: a pre-update snapshot taken at the version we
      // are rolling BACK to holds the config as it stood before the update
      // being undone. When one exists the confirm becomes a sheet, because a
      // window.confirm() cannot carry a checkbox; when none does, nothing about
      // this flow changes.
      const snaps = ui.caps.getSnapshots ? await loadSnapshots(appId, { quiet: true }) : null;
      const hit = rollbackSnapshot(snaps, target.prevVersion);
      if (hit) {
        ui.rollbackDraft = { appId, target, snapshot: hit, restoreConfig: true, busy: false };
        ui.sheet = { kind: 'rollback', appId };
        schedule();
        break;
      }
      if (!window.confirm(rollbackConfirmText(app, target))) break;
      ui.sheet = null;
      schedule();
      await call('rollback', appId, artId);
      await pullState();
      break;
    }
    case 'rollback-confirm': {
      const draft = ui.rollbackDraft;
      if (!draft) break;
      const file = el.getAttribute('data-snap') || '';
      // The checkbox is the user's last word; the draft is only the default.
      const box = document.querySelector('[data-rollback-config]');
      const alsoConfig = box ? !!box.checked : draft.restoreConfig !== false;
      draft.busy = true;
      ui.sheet = null;
      ui.rollbackDraft = null;
      schedule();
      const ok = await call('rollback', appId, artId);
      // Order matters: the binary goes back first, then its config. A restore
      // over a still-new install would be read by the new version and possibly
      // rewritten before the rollback ever landed.
      if (ok !== null && alsoConfig && file) await restoreSnapshotFile(appId, file, { quiet: true });
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
    /* ------------------------------------------------------------- v0.5 */

    case 'stacks':
      await openStacks();
      break;
    case 'stack-new':
      ui.sheet = { kind: 'stacks' };
      ui.stackDraft = blankDraft();
      ui.stackErrors = {};
      schedule();
      break;
    case 'stack-edit':
      editStack(el.getAttribute('data-stack') || '');
      break;
    case 'stack-cancel':
      ui.stackDraft = null;
      ui.stackErrors = {};
      schedule();
      break;
    case 'stack-save':
      await saveStackDraft();
      break;
    case 'stack-delete':
      await deleteStack(el.getAttribute('data-stack') || '');
      break;
    case 'stack-run':
      await startStack(el.getAttribute('data-stack') || '');
      break;
    case 'stack-stop':
      await stopStackRun(el.getAttribute('data-stack') || '');
      break;
    case 'stack-step-add':
      patchSteps((steps) => [...steps, blankStep()]);
      break;
    case 'stack-step-remove': {
      const i = Number(el.getAttribute('data-index'));
      patchSteps((steps) => (steps.length > 1 ? steps.filter((_, n) => n !== i) : [blankStep()]));
      break;
    }
    case 'stack-step-up': {
      const i = Number(el.getAttribute('data-index'));
      patchSteps((steps) => moveStep(steps, i, i - 1));
      break;
    }
    case 'stack-step-down': {
      const i = Number(el.getAttribute('data-index'));
      patchSteps((steps) => moveStep(steps, i, i + 1));
      break;
    }

    /* ------------------------------------------------------------- v0.7 */

    case 'dev-run': {
      ui.openMenu = '';
      const id = el.getAttribute('data-dev') || el.getAttribute('data-app') || '';
      if (!id) break;
      flashTile(el.closest ? el.closest('.tile') : null, 'launching', 700);
      // devRun() announces its own success — a second toast from here would say
      // the same thing twice. It rejects with a message meant to be read, so
      // the failure path shows that message rather than wrapping it.
      try {
        const res = await maybeCall('devRun', id);
        if (res && res.ok === false) toast('error', res.error || `Could not start ${id}`);
      } catch (err) {
        toast('error', (err && err.message) || `Could not start ${id}`);
      }
      break;
    }
    case 'dev-folder': {
      ui.openMenu = '';
      const path = el.getAttribute('data-path') || '';
      if (path) await call('showInFolder', path);
      else toast('warn', 'That dev link has no folder recorded');
      schedule();
      break;
    }
    case 'dev-unlink': {
      ui.openMenu = '';
      const id = el.getAttribute('data-dev') || el.getAttribute('data-app') || '';
      const link = ui.devLinks.find((l) => l.appId === id);
      if (!link) break;
      if (!window.confirm(devUnlinkConfirm(link))) break;
      const res = await call('devUnlink', id);
      if (res === null) break;
      if (res && res.ok === false) {
        toast('warn', `Could not unlink ${link.name}`);
        break;
      }
      toast('info', `${link.name} unlinked — the folder is untouched`);
      // The call hands back the fresh list, so the tiles update from the answer
      // rather than from another round trip.
      if (res && Array.isArray(res.links)) {
        ui.devLinks = normalizeDevLinks(res.links);
        schedule();
      } else {
        await loadDevLinks();
      }
      break;
    }
    case 'fleet-wake': {
      const peerId = el.getAttribute('data-peer') || '';
      const peer = peerById(ui.fleet.peers, peerId);
      if (!peer) break;
      const res = await call('fleetWake', peerId);
      if (res === null) break;
      if (res === false) {
        toast('warn', `Could not send a magic packet to ${peer.name}`);
        break;
      }
      toast('info', `Magic packet sent to ${peer.name} — it can take a minute to answer`);
      break;
    }

    /* ------------------------------------------------------------- v0.6 */

    case 'fleet':
      await openFleet();
      break;
    case 'fleet-show-code':
      await showPairCode();
      break;
    case 'fleet-pair-open':
      clearPairTimer();
      ui.pair = pairEnterStart(ui.pair);
      schedule();
      break;
    case 'fleet-pair-cancel':
      clearPairTimer();
      ui.pair = pairCancel();
      schedule();
      break;
    case 'fleet-pair-submit':
      await submitPair();
      break;
    case 'fleet-install':
      await fleetAction('fleetInstall', el, 'Installing');
      break;
    case 'fleet-launch':
      await fleetAction('fleetLaunch', el, 'Launching');
      break;
    case 'fleet-update-all': {
      const peerId = el.getAttribute('data-peer') || '';
      const peer = peerById(ui.fleet.peers, peerId);
      if (!peer) break;
      const counts = fleetCounts([peer]);
      if (
        !window.confirm(
          `Install ${counts.updates} update${counts.updates === 1 ? '' : 's'} on ${peer.name}?\n\n` +
            'The other hub downloads and installs them on its own machine.'
        )
      ) {
        break;
      }
      const res = await call('fleetUpdateAll', peerId);
      if (res !== null) toast('info', `${peer.name} is updating…`);
      break;
    }
    case 'fleet-unpair': {
      const peerId = el.getAttribute('data-peer') || '';
      const peer = peerById(ui.fleet.peers, peerId);
      if (!peer) break;
      if (
        !window.confirm(
          `Unpair ${peer.name}?\n\nThe shared secret is deleted on this side. ` +
            'Pairing again needs a fresh six-digit code.'
        )
      ) {
        break;
      }
      const res = await call('fleetUnpair', peerId);
      if (res === null) break;
      toast('info', `${peer.name} unpaired`);
      await loadFleet();
      break;
    }
    case 'dismiss-crash': {
      const version = el.getAttribute('data-version') || '';
      ui.dismissedCrashes.add(crashKey(appId, artId, version));
      saveUiPrefs();
      schedule();
      break;
    }

    /* ------------------------------------------------------------- v0.8 */

    case 'activity':
      await openActivity();
      break;
    case 'activity-filter': {
      const next = el.getAttribute('data-filter') || 'all';
      if (!isFilterId(next)) break;
      ui.activity = { ...ui.activity, filter: next };
      schedule();
      break;
    }
    case 'activity-more':
      await loadActivity({ append: true });
      break;
    case 'snap-restore': {
      const file = el.getAttribute('data-snap') || '';
      const app = (state.apps || []).find((a) => a.id === appId);
      const data = ui.snapshots.get(appId) || {};
      const snap = (data.snapshots || []).find((s) => s.file === file);
      if (!snap) break;
      if (!window.confirm(restoreConfirmText(app, snap))) break;
      ui.snapBusy = file;
      schedule();
      await restoreSnapshotFile(appId, file);
      ui.snapBusy = '';
      schedule();
      break;
    }
    case 'snap-delete': {
      const file = el.getAttribute('data-snap') || '';
      const app = (state.apps || []).find((a) => a.id === appId);
      const data = ui.snapshots.get(appId) || {};
      const snap = (data.snapshots || []).find((s) => s.file === file);
      if (!snap) break;
      if (!window.confirm(deleteConfirmText(app, snap))) break;
      ui.snapBusy = file;
      schedule();
      const res = await call('deleteSnapshot', appId, file);
      ui.snapBusy = '';
      if (res !== null) {
        // The call hands back the fresh list, so the section redraws from the
        // answer rather than from another round trip.
        if (res && Array.isArray(res.snapshots)) {
          ui.snapshots.set(appId, { loading: false, error: '', snapshots: normalizeSnapshots(res.snapshots) });
        } else {
          await loadSnapshots(appId);
        }
        toast('info', 'Snapshot deleted');
      }
      schedule();
      break;
    }
    /* ------------------------------------------------------------ v0.10 */

    case 'checkpoint':
      await openCheckpoint(el.getAttribute('data-ts'));
      break;
    case 'checkpoint-retry':
      await loadCheckpoint();
      break;
    case 'checkpoint-configs':
      // The checkbox's own state is the source of truth when we have it; a
      // synthetic click (tests, keyboard) just flips the flag.
      ui.checkpoint = {
        ...ui.checkpoint,
        configs: typeof el.checked === 'boolean' ? !!el.checked : !ui.checkpoint.configs,
      };
      schedule();
      break;
    case 'checkpoint-confirm':
      await confirmCheckpoint();
      break;
    case 'verify-installs':
      await runAudit();
      break;
    case 'repair-install':
      await repairInstall(appId, artId);
      break;

    case 'dismiss-supervisor':
      ui.supervisor = dismissSupervisor(ui.supervisor, el.getAttribute('data-sup') || '');
      schedule();
      break;

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

function closeSheet() {
  ui.sheet = null;
  ui.prefDraft = null;
  ui.prefError = '';
  ui.stackDraft = null;
  ui.stackErrors = {};
  ui.rollbackDraft = null;
  // The pairing countdown must never outlive the sheet that shows it.
  clearPairTimer();
  // …and neither may the activity tail: a debounce that fires after the sheet
  // is gone would re-render a surface nobody is looking at.
  clearActivityTimer();
  ui.pair = blankPairState();
  // v0.10 — a checkpoint restore that is still walking the plan keeps its run:
  // the events go on arriving and the toast at the end still means something.
  // An idle (or finished) sheet is cleared so the next one starts blank.
  if (!isRunning(ui.checkpoint.run)) {
    ui.checkpoint = { ts: 0, plan: null, loading: false, error: '', configs: false, busy: false, run: blankRun() };
  }
  schedule();
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
      bumpActivity();
      pullState();
      break;
    }
    case 'job-error':
      ui.liveJobs.delete(`${ev.appId}::${ev.artifactId}`);
      // Background-policy failures stay quiet — the update badge and the
      // card's own hints carry the state; only user-initiated jobs toast.
      if (!ev.silent) toast('error', ev.message || 'Job failed');
      bumpActivity();
      pullState();
      break;
    case 'toast':
      toast(ev.level || 'info', ev.message || '');
      break;
    case 'connector-changed':
      // The bus roster lives in getState(); the event is only the nudge.
      pullState();
      break;
    case 'stack-progress':
      onStackProgress(ev);
      break;

    /* ------------------------------------------------------------- v0.6 */

    case 'fleet-changed':
      loadFleet();
      break;
    // v0.7 — `nx dev link/unlink` from the CLI reaches a running hub this way.
    case 'dev-links-changed':
      loadDevLinks();
      break;
    case 'fleet-pair-code':
      // The target hub armed its window — show the code even if this side did
      // not ask for it (the other hub may have started the flow).
      ui.pair = pairCodeArrived(ui.pair, ev, Date.now());
      if (isCodeLive(ui.pair, Date.now()) && ui.sheet && ui.sheet.kind === 'fleet') armPairTimer();
      schedule();
      break;
    case 'fleet-progress':
      ui.fleetJobs = foldFleetProgress(ui.fleetJobs, ev, Date.now());
      schedule();
      break;
    /* ------------------------------------------------------------- v0.8 */

    // The watchdog. A give-up ALSO arrives as an error toast from main, so this
    // handler is deliberately silent — it only parks the standing copy on the
    // card. Toasting here would say the same thing twice.
    case 'supervisor':
      ui.supervisor = foldSupervisor(ui.supervisor, ev, Date.now());
      bumpActivity();
      schedule();
      break;

    /* ------------------------------------------------------------ v0.10 */

    // The checkpoint restore narrates itself. Folding happens whether or not the
    // sheet is open — a restore started here and then dismissed still finishes,
    // and re-opening must not show a run frozen halfway through.
    case 'checkpoint-progress': {
      ui.checkpoint = {
        ...ui.checkpoint,
        run: foldCheckpointProgress(ui.checkpoint.run, ev, Date.now()),
      };
      // A terminal phase means the disk changed under us.
      if (checkpointFinished(ui.checkpoint.run)) pullState();
      bumpActivity();
      schedule();
      break;
    }

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
  // DESIGN v1.3 "light rides motion": one rAF-throttled pointermove for the
  // whole document writes a normalized --mx onto the hovered card/tile, and
  // the sheen's background-position derives from it — the highlight tracks
  // the cursor instead of sweeping once on hover. Off under reduced motion.
  if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let sheenRaf = 0;
    let sheenEl = null;
    document.addEventListener(
      'pointermove',
      (ev) => {
        if (sheenRaf) return;
        const x = ev.clientX;
        const t = ev.target instanceof Element ? ev.target : null;
        sheenRaf = window.requestAnimationFrame(() => {
          sheenRaf = 0;
          const surface = t && t.closest ? t.closest('.card, .tile-hit') : null;
          if (sheenEl && sheenEl !== surface) {
            sheenEl.style.removeProperty('--mx');
            sheenEl = null;
          }
          if (!surface) return;
          const r = surface.getBoundingClientRect();
          if (!r.width) return;
          surface.style.setProperty('--mx', String(Math.min(1, Math.max(0, (x - r.left) / r.width))));
          sheenEl = surface;
        });
      },
      { passive: true }
    );
  }

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
    // Switching a step's app or health rule swaps the inputs under it
    // (the artifact picker, port ⇄ wait).
    const stepField = el.getAttribute ? el.getAttribute('data-step-field') : '';
    if ((stepField === 'healthType' || stepField === 'appId') && ui.stackDraft) {
      readStackDraft();
      schedule();
      return;
    }
    // v0.7 — moving a step to another hub, or turning it into a wake, swaps the
    // controls under it. Only THIS moment fills the wake timeout default: doing
    // it on every read would refill a box the user is trying to clear.
    if ((stepField === 'peer' || stepField === 'action') && ui.stackDraft) {
      readStackDraft();
      const i = Number(el.getAttribute('data-index'));
      const steps = ui.stackDraft.steps || [];
      if (Number.isInteger(i) && steps[i]) steps[i] = coerceStepFields(steps[i], { fillDefaults: true });
      schedule();
      return;
    }
    // Switching the trigger type swaps the serial box for the app picker.
    if (el.getAttribute && el.getAttribute('data-stack-field') === 'triggerType' && ui.stackDraft) {
      readStackDraft();
      schedule();
      return;
    }
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
        // Inside the stacks editor, Escape backs out to the list first.
        if (ui.stackDraft) {
          ui.stackDraft = null;
          ui.stackErrors = {};
          schedule();
        } else if (ui.sheet.kind === 'fleet' && ui.pair && ui.pair.mode !== 'idle') {
          // …and inside the fleet sheet it backs out of the pairing flow first.
          clearPairTimer();
          ui.pair = pairCancel();
          schedule();
        } else {
          closeSheet();
        }
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
      const fleetField = el.getAttribute('data-fleet-field');
      if (fleetField === 'host' || fleetField === 'code') onAction('fleet-pair-submit', el, ev);
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
  const stacksBtn = document.getElementById('stacks-btn');
  if (stacksBtn) {
    stacksBtn.innerHTML = icons.stack;
    stacksBtn.hidden = true; // until the caps probe says the bridge has stacks
  }
  const activityBtn = document.getElementById('activity-btn');
  if (activityBtn) {
    activityBtn.innerHTML = icons.history;
    activityBtn.hidden = true; // until the caps probe says the bridge records
  }
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
  if (stacksBtn) stacksBtn.hidden = !ui.caps.getStacks;
  if (activityBtn) activityBtn.hidden = !ui.caps.getEvents;

  const nx = api();
  if (nx && typeof nx.onEvent === 'function') {
    try {
      nx.onEvent(onHubEvent);
    } catch (err) {
      toast('warn', `Event stream unavailable: ${(err && err.message) || err}`);
    }
  }
  await pullState();
  await loadStacks();
  await loadFleet();
  await loadDevLinks();
  // First run: open the launcher when there is anything to launch.
  if (!ui.viewRemembered) {
    ui.view = ui.stacks.length ? 'launch' : defaultView(currentTiles());
    schedule();
  }
  if (ui.caps.getDeviceInfo && state.adb && state.adb.connected) refreshDeviceInfo();

  // Safety heartbeat: a state-changed emitted in the gap between the hub's
  // first refresh and onEvent attaching is simply missed — with no re-pull the
  // grid would sit on skeletons forever (seen as an e2e flake). A slow poll
  // heals every missed-event class; skipped while hidden.
  window.setInterval(() => {
    if (!document.hidden) pullState();
  }, 10000);

  window.__nxhubBooted = true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

// Exposed for the e2e hooks / dev toolbar.
export const __ui = ui;
export { toast, pullState, onHubEvent, boot, paint };
