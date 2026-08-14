// NX Hub renderer — controller. No framework, no bundler: the view layer is a
// set of pure string renderers (views/*) and this file is the one place that
// touches the DOM and window.nxhub.

import { normalizeState, filterApps, splitPublished, githubUrl } from './lib/model.js';
import { renderSettingsPanel, validateRepoRef } from './views/settings.js';
import {
  renderAppCard,
  renderUnpublishedCard,
  renderSkeletonCard,
  renderTokenHint,
  renderRateLimitBanner,
  renderEmpty,
  artifactKey,
} from './views/card.js';
import { detectPlatform } from './lib/actions.js';
import { esc } from './lib/html.js';
import * as icons from './views/icons.js';

const LS_KEY = 'nxhub.ui.v1';

const ui = {
  loaded: false,
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
    if (typeof saved.unpubOpen === 'boolean') ui.unpubOpen = saved.unpubOpen;
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
      })
    );
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- api access */

function api() {
  return typeof window !== 'undefined' && window.nxhub ? window.nxhub : null;
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
  return jobs.find((j) => j && j.appId === appId) || null;
}

/* ------------------------------------------------------------------ toasts */

function toast(level, message, opts = {}) {
  const id = `t${++toastSeq}`;
  const sticky = opts.sticky !== undefined ? opts.sticky : level === 'error';
  ui.toasts.push({ id, level, message: String(message || ''), sticky });
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
      (t) => `<div class="toast toast-${esc(t.level)}" role="status">
        <span>${esc(t.message)}</span>
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

function render() {
  const grid = document.getElementById('grid');
  const unpubHost = document.getElementById('unpublished');
  const banner = document.getElementById('banner');
  const panelHost = document.getElementById('panel-root');
  if (!grid) return;

  const jobs = jobsForRender();
  const ctx = {
    settings: state.settings,
    adb: state.adb,
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
        })
      : '';
  }

  if (!ui.loaded) {
    grid.innerHTML = new Array(4).fill(0).map(renderSkeletonCard).join('');
    if (unpubHost) unpubHost.innerHTML = '';
    return;
  }

  const { published, unpublished } = splitPublished(state.apps);
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
           ${icons.chevron}<span>Unpublished — no releases yet</span><span class="count">${list.length}</span>
         </button>
         ${ui.unpubOpen ? `<div class="grid grid-unpub">${list.map(renderUnpublishedCard).join('')}</div>` : ''}`
      : '';
  }
}

/* ------------------------------------------------------------ settings glue */

function openSettings() {
  ui.draft = { ...state.settings, owners: [...state.settings.owners], extraRepos: [...state.settings.extraRepos] };
  ui.repoError = '';
  ui.settingsOpen = true;
  schedule();
}

function readPanelInputs() {
  if (!ui.draft) return;
  const root = document.getElementById('panel-root');
  if (!root) return;
  for (const el of root.querySelectorAll('[data-field]')) {
    const field = el.getAttribute('data-field');
    if (field === 'ownerInput' || field === 'repoInput') continue;
    if (field === 'checkIntervalHours') {
      const n = Number(el.value);
      ui.draft.checkIntervalHours = Number.isFinite(n) && n >= 0 ? n : 6;
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
  const patch = {
    owners: ui.draft.owners,
    extraRepos: ui.draft.extraRepos,
    token: ui.draft.token || '',
    installRoot: ui.draft.installRoot || '',
    adbPath: ui.draft.adbPath || '',
    checkIntervalHours: Number(ui.draft.checkIntervalHours) || 0,
  };
  const ok = await call('setSettings', patch);
  if (ok !== null) {
    toast('info', 'Settings saved');
    ui.settingsOpen = false;
    await pullState();
  }
  schedule();
}

/* ------------------------------------------------------------------ actions */

function findArtifact(appId, artifactId) {
  const app = (state.apps || []).find((a) => a.id === appId);
  if (!app) return { app: null, artifact: null };
  return { app, artifact: (app.artifacts || []).find((a) => a.id === artifactId) || null };
}

async function copyText(text) {
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
    toast('info', 'Command copied to clipboard');
  } catch {
    toast('warn', 'Could not access the clipboard — copy it by hand');
  }
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
    case 'menu':
      ui.openMenu = ui.openMenu === artifactKey(appId, artId) ? '' : artifactKey(appId, artId);
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
      await call('launch', appId, artId);
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
    default:
      break;
  }
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
      toast('error', ev.message || 'Job failed');
      pullState();
      break;
    case 'toast':
      toast(ev.level || 'info', ev.message || '');
      break;
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

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el && el.id === 'filter') {
      ui.filter = el.value;
      schedule();
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
      if (ui.settingsOpen) {
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
    }
  });
}

/* --------------------------------------------------------------- starfield */

function drawStarfield() {
  const canvas = document.getElementById('stars');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 900;
  const h = canvas.clientHeight || 90;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Deterministic PRNG so the sky is stable across re-renders/screenshots.
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const count = Math.round(w / 7);
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = rnd() * 0.9 + 0.25;
    const a = 0.12 + rnd() * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rnd() > 0.88 ? `rgba(0,229,255,${a})` : `rgba(239,234,255,${a})`;
    ctx.fill();
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

  drawStarfield();
  window.addEventListener('resize', drawStarfield);
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

  const nx = api();
  if (nx && typeof nx.onEvent === 'function') {
    try {
      nx.onEvent(onHubEvent);
    } catch (err) {
      toast('warn', `Event stream unavailable: ${(err && err.message) || err}`);
    }
  }
  await pullState();
  window.__nxhubBooted = true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

// Exposed for the e2e hooks / dev toolbar.
export const __ui = ui;
export { toast, pullState, onHubEvent };
