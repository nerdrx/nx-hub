// Pure string renderers for the app grid. Every function here takes data and
// returns HTML — no DOM access — so the whole view layer is unit-testable.

import { html, esc, raw, cx } from '../lib/html.js';
import { renderMarkdown } from '../lib/markdown.js';
import {
  formatBytes,
  formatDate,
  relativeTime,
  progressLabel,
  versionLabel,
} from '../lib/version.js';
import { artifactActions, platformLabel } from '../lib/actions.js';
import { showOwnerBadge, ownerOf, githubUrl, releaseUrl } from '../lib/model.js';
import { normalizeAppPref, isSkipped } from '../lib/prefs.js';
import { renderDeviceLine } from './devices.js';
import * as icons from './icons.js';

const HUB_ID = 'nx-hub';

/** Menu key for the card-level ⋮ (artifact menus use `${appId}::${artifactId}`). */
export function appMenuKey(appId) {
  return `${appId}::__app__`;
}

function has(coll, key) {
  if (!coll) return false;
  if (typeof coll.has === 'function') return coll.has(key);
  if (Array.isArray(coll)) return coll.includes(key);
  return !!coll[key];
}

export function artifactKey(appId, artifactId) {
  return `${appId}::${artifactId}`;
}

/** Pull the runnable command out of a postInstallNote for the copy button. */
export function extractCommand(note) {
  if (!note) return '';
  const text = String(note);
  const tick = /`([^`]+)`/.exec(text);
  if (tick) return tick[1].trim();
  const run = /(?:re-?run|run|execute)\s*:?\s*(.+?)(?:\s*\((?:required|needed|note)[^)]*\)\s*)?$/i.exec(text);
  if (run && run[1]) return run[1].trim();
  return text.trim();
}

function badge(cls, text, title) {
  return html`<span class="badge ${raw(cls)}"${raw(title ? ` title="${esc(title)}"` : '')}>${text}</span>`;
}

function button(a, appId, artifactId) {
  const attrs = [
    `class="btn btn-${esc(a.variant || 'ghost')}"`,
    `data-act="${esc(a.act)}"`,
    `data-app="${esc(appId)}"`,
    `data-art="${esc(artifactId)}"`,
    a.disabled ? 'disabled' : '',
    a.title ? `title="${esc(a.title)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<button ${attrs}>${esc(a.label)}</button>`;
}

function menuMarkup(menu, appId, artifactId, open) {
  if (!menu || !menu.length) return '';
  const items = menu
    .map(
      (m) =>
        `<button class="${cx('menu-item', m.danger && 'danger')}" data-act="${esc(m.act)}" data-app="${esc(appId)}" data-art="${esc(artifactId)}">${esc(m.label)}</button>`
    )
    .join('');
  return `
    <div class="menu-wrap">
      <button class="btn btn-icon menu-btn" data-act="menu" data-app="${esc(appId)}" data-art="${esc(artifactId)}" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" title="More actions">${icons.dots}</button>
      ${open ? `<div class="menu" role="menu">${items}</div>` : ''}
    </div>`;
}

/** Entries of the card-level ⋮ menu. Pure so the test can read the labels. */
export function appMenuItems(app, pref, caps = {}) {
  const items = [];
  if (caps.getReleases !== false) items.push({ act: 'versions', label: 'Version history…' });
  if (caps.setAppPref !== false) {
    items.push({ act: 'app-options', label: 'App options…' });
    items.push({ act: 'toggle-fav', label: pref && pref.favorite ? 'Remove from favorites' : 'Add to favorites' });
    items.push({ act: 'hide-app', label: 'Hide from list' });
  }
  items.push({ act: 'github', label: 'Open GitHub page' });
  return items;
}

function appMenuMarkup(app, pref, caps, open) {
  const items = appMenuItems(app, pref, caps)
    .map(
      (m) =>
        `<button class="menu-item" data-act="${esc(m.act)}" data-app="${esc(app.id)}">${esc(m.label)}</button>`
    )
    .join('');
  return `
    <div class="menu-wrap card-menu">
      <button class="btn btn-icon menu-btn" data-act="menu" data-app="${esc(app.id)}" data-art="__app__" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" title="App actions">${icons.dots}</button>
      ${open ? `<div class="menu" role="menu">${items}</div>` : ''}
    </div>`;
}

export function renderJobBar(job, opts = {}) {
  if (!job) return '';
  const pct = Number(job.pct);
  const known = Number.isFinite(pct) && pct >= 0;
  const width = known ? Math.max(2, Math.min(100, pct)) : 100;
  return `
    <div class="job" data-job="${esc(job.id)}">
      <div class="job-row">
        <span class="job-phase">${esc(progressLabel(job.phase, known ? pct : undefined, job.message))}</span>
        ${opts.label ? `<span class="job-target">${esc(opts.label)}</span>` : ''}
        <button class="btn btn-icon job-cancel" data-act="cancel" data-job="${esc(job.id)}" title="Cancel">${icons.close}</button>
      </div>
      <div class="bar ${known ? '' : 'bar-indeterminate'}"><span style="width:${width}%"></span></div>
    </div>`;
}

export function renderPostInstallNote(app, artifact) {
  const cmd = extractCommand(artifact.postInstallNote);
  return `
    <div class="pin-note" data-note="${esc(artifactKey(app.id, artifact.id))}">
      <div class="pin-head">
        <span class="pin-title">One more step — ${esc(artifact.label)}</span>
        <button class="btn btn-icon" data-act="dismiss-note" data-app="${esc(app.id)}" data-art="${esc(artifact.id)}" title="Dismiss">${icons.close}</button>
      </div>
      <p class="pin-body">${esc(artifact.postInstallNote)}</p>
      ${
        cmd
          ? `<div class="pin-cmd"><code>${esc(cmd)}</code>
        <button class="btn btn-ghost btn-sm" data-act="copy" data-copy="${esc(cmd)}">${icons.copy}<span>Copy</span></button></div>`
          : ''
      }
    </div>`;
}

export function renderArtifactRow(app, artifact, ctx = {}) {
  const latest = (app.latest && app.latest.version) || '';
  const job =
    ctx.job && (ctx.job.artifactId === artifact.id || !ctx.job.artifactId) ? ctx.job : null;
  const state = artifactActions(app, artifact, {
    platform: ctx.platform,
    adb: ctx.adb,
    caps: ctx.caps,
    job,
  });
  const open = ctx.openMenu === artifactKey(app.id, artifact.id);
  const deviceVersion =
    artifact.kind === 'apk-adb' && ctx.adb && ctx.adb.versions
      ? ctx.adb.versions[artifact.packageId]
      : '';
  const shown = deviceVersion
    ? { ...artifact, installed: { ...(artifact.installed || {}), version: deviceVersion } }
    : artifact;

  return `
    <div class="art ${esc(artifact.platform)}" data-art-row="${esc(artifact.id)}">
      <span class="chip chip-${esc(artifact.platform)}">${esc(platformLabel(artifact.platform))}</span>
      <div class="art-main">
        <div class="art-label">${esc(artifact.label)}${
          artifact.size ? `<span class="art-size">${esc(formatBytes(artifact.size))}</span>` : ''
        }</div>
        <div class="art-ver ${shown.updateAvailable ? 'has-update' : ''}">${esc(versionLabel(shown, latest))}${
          deviceVersion ? '<span class="art-live" title="read live from the device">on device</span>' : ''
        }</div>
        ${
          state.hint
            ? `<div class="art-hint ${ctx.adb && ctx.adb.connected ? 'ok' : 'warn'}">${icons.plug}<span>${esc(state.hint)}</span></div>`
            : ''
        }
        ${
          artifact.kind === 'apk-adb' && ctx.adb && ctx.adb.connected && ctx.deviceInfo
            ? renderDeviceLine(ctx.deviceInfo, { title: 'the APK is installed onto this device' })
            : ''
        }
        ${
          artifact.readyToInstall
            ? '<div class="art-ready">Update downloaded — ready to install</div>'
            : ''
        }
      </div>
      <div class="art-actions">
        ${state.buttons.map((b) => button(b, app.id, artifact.id)).join('')}
        ${menuMarkup(state.menu, app.id, artifact.id, open)}
      </div>
      ${job ? renderJobBar(job) : ''}
    </div>`;
}

export function renderAppCard(app, ctx = {}) {
  const settings = ctx.settings || {};
  const notesOpen = has(ctx.expandedNotes, app.id);
  const notes = (app.latest && app.latest.notes) || '';
  const isHub = app.id === HUB_ID;
  const owner = ownerOf(app.repo);
  const job = ctx.job || null;
  const caps = ctx.caps || {};
  const pref = normalizeAppPref((ctx.prefs || {})[app.id]);
  const latestVersion = (app.latest && app.latest.version) || '';
  const skipped = isSkipped(pref, latestVersion);

  const pinNotes = (app.artifacts || [])
    .filter(
      (a) =>
        a.postInstallNote &&
        a.installed &&
        !has(ctx.dismissedNotes, artifactKey(app.id, a.id))
    )
    .map((a) => renderPostInstallNote(app, a))
    .join('');

  const orphanJob = job && !(app.artifacts || []).some((a) => a.id === job.artifactId);

  return `
  <article class="card ${isHub ? 'card-self' : ''}${pref.favorite ? ' card-fav' : ''}" data-app-card="${esc(app.id)}">
    <div class="card-head">
      <div class="card-title">
        ${pref.favorite ? `<span class="fav-star" title="favorite">${icons.starFilled}</span>` : ''}
        <h2>${esc(app.name)}</h2>
        ${isHub ? badge('badge-self', 'this app') : ''}
        ${showOwnerBadge(app, settings) ? badge('badge-owner', owner, `from ${app.repo}`) : ''}
        ${app.private ? `<span class="lock" title="private repository">${icons.lock}</span>` : ''}
        <span class="card-tools">
          ${
            caps.getReleases === false
              ? ''
              : `<button class="btn btn-ghost btn-sm btn-versions" data-act="versions" data-app="${esc(app.id)}" title="Every release of this repository">${icons.history}<span>Versions</span></button>`
          }
          ${appMenuMarkup(app, pref, caps, ctx.openMenu === appMenuKey(app.id))}
        </span>
      </div>
      ${app.tagline ? `<p class="tagline">${esc(app.tagline)}</p>` : ''}
      <div class="meta">
        ${
          app.latest
            ? `<span class="ver">${esc(app.latest.version || app.latest.tag || '')}</span>
               <span class="sep">·</span>
               <span title="${esc(formatDate(app.latest.publishedAt))}">${esc(relativeTime(app.latest.publishedAt, ctx.now))}</span>
               ${app.latest.prerelease ? '<span class="tag-pre">pre-release</span>' : ''}`
            : '<span class="muted">no release</span>'
        }
        ${
          skipped
            ? `<span class="skip-chip" title="this version is ignored">skipped
                 <button class="chip-x" data-act="clear-skip" data-app="${esc(app.id)}" title="Stop skipping">${icons.close}</button>
               </span>`
            : ''
        }
        <a class="repo-link" href="#" data-act="open" data-url="${esc(githubUrl(app.repo))}" title="${esc(app.repo)}">${icons.external}<span>${esc(app.repo)}</span></a>
      </div>
    </div>

    ${
      notes
        ? `<button class="notes-toggle ${notesOpen ? 'open' : ''}" data-act="notes" data-app="${esc(app.id)}" aria-expanded="${notesOpen ? 'true' : 'false'}">
             ${icons.chevron}<span>Release notes</span>
           </button>
           ${notesOpen ? `<div class="notes markdown">${renderMarkdown(notes)}<a class="notes-link" href="#" data-act="open" data-url="${esc(releaseUrl(app))}">view on GitHub</a></div>` : ''}`
        : ''
    }

    <div class="arts">
      ${(app.artifacts || [])
        .map((a) => renderArtifactRow(app, a, { ...ctx, job }))
        .join('')}
      ${!app.artifacts || !app.artifacts.length ? '<div class="art-empty">No installable assets in the latest release.</div>' : ''}
    </div>
    ${orphanJob ? renderJobBar(job) : ''}
    ${pinNotes}
  </article>`;
}

export function renderUnpublishedCard(app) {
  return `
  <article class="card card-unpub" data-app-card="${esc(app.id)}">
    <div class="card-head">
      <div class="card-title">
        <h2>${esc(app.name)}</h2>
        ${app.private ? `<span class="lock" title="private repository">${icons.lock}</span>` : ''}
      </div>
      ${app.tagline ? `<p class="tagline">${esc(app.tagline)}</p>` : ''}
      <div class="meta"><span class="muted">no releases yet</span></div>
    </div>
    <div class="art-actions">
      <button class="btn btn-ghost" data-act="open" data-url="${esc(githubUrl(app.repo))}">Open GitHub</button>
    </div>
  </article>`;
}

export function renderSkeletonCard() {
  return `
  <article class="card card-skel" aria-hidden="true">
    <div class="sk sk-title"></div>
    <div class="sk sk-line"></div>
    <div class="sk sk-row"></div>
    <div class="sk sk-row"></div>
  </article>`;
}

export function renderTokenHint() {
  return `
  <article class="card card-hint" data-hint="token">
    <div class="card-head">
      <div class="card-title"><h2>Private repos are hidden</h2></div>
      <p class="tagline">No GitHub token found. Public repos still work; private ones need a token
        (or the <code>gh</code> CLI logged in).</p>
    </div>
    <div class="art-actions">
      <button class="btn btn-violet" data-act="settings">Open settings</button>
      <button class="btn btn-ghost" data-act="dismiss-hint" data-hint="token">Dismiss</button>
    </div>
  </article>`;
}

export function renderRateLimitBanner(rateLimit, now = Date.now()) {
  if (!rateLimit) return '';
  const reset = rateLimit.resetAt || rateLimit.reset || 0;
  const ms = (typeof reset === 'number' && reset < 1e12 ? reset * 1000 : Number(reset)) - now;
  const mins = ms > 0 ? Math.ceil(ms / 60000) : 0;
  return `
  <div class="banner banner-warn" role="status">
    <span>GitHub rate limit reached${mins ? ` — retry in about ${mins} minute${mins === 1 ? '' : 's'}` : ''}.
      Adding a token in settings raises the limit.</span>
    <span class="banner-actions">
      <button class="btn btn-ghost btn-sm" data-act="settings">Settings</button>
      <button class="btn btn-ghost btn-sm" data-act="refresh">Retry now</button>
    </span>
  </div>`;
}

/**
 * The "Show hidden (n)" row at the bottom of Manage. Hidden apps are greyed and
 * only offer an unhide action — everything else about them stays out of sight.
 */
export function renderHiddenSection(apps, ctx = {}) {
  const list = Array.isArray(apps) ? apps : [];
  if (!list.length) return '';
  const open = !!ctx.open;
  return `
    <button class="section-toggle${open ? ' open' : ''}" data-act="toggle-hidden" aria-expanded="${open ? 'true' : 'false'}">
      ${icons.chevron}<span>Show hidden</span><span class="count">${list.length}</span>
    </button>
    ${
      open
        ? `<div class="hidden-list">${list
            .map(
              (app) => `<div class="hidden-row" data-app-card="${esc(app.id)}">
                <span class="hidden-name">${esc(app.name)}</span>
                <span class="hidden-repo">${esc(app.repo)}</span>
                <button class="btn btn-ghost btn-sm" data-act="unhide-app" data-app="${esc(app.id)}">${icons.eye}<span>Unhide</span></button>
              </div>`
            )
            .join('')}</div>`
        : ''
    }`;
}

export function renderEmpty(query) {
  return query
    ? `<div class="empty">Nothing matches “${esc(query)}”. <button class="btn btn-ghost btn-sm" data-act="clear-filter">Clear filter</button></div>`
    : `<div class="empty">No apps discovered yet. Check your sources in settings, then refresh.</div>`;
}
