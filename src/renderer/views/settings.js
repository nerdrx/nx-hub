// Settings slide-over. Pure renderer over a local draft of the settings object;
// app.js owns the draft and only calls setSettings() on save.

import { esc } from '../lib/html.js';
import { isValidRepoRef } from '../lib/model.js';
import * as icons from './icons.js';

function chip(value, kind) {
  return `<span class="chip-edit">${esc(value)}<button class="chip-x" data-act="remove-${esc(kind)}" data-value="${esc(value)}" title="Remove">${icons.close}</button></span>`;
}

export function renderSettingsPanel(draft, ctx = {}) {
  const d = draft || {};
  const owners = Array.isArray(d.owners) ? d.owners : [];
  const extra = Array.isArray(d.extraRepos) ? d.extraRepos : [];
  const tokenPlaceholder = ctx.tokenSource === 'gh' ? 'using gh CLI token' : 'ghp_… (optional)';

  return `
  <div class="panel-backdrop" data-act="close-settings"></div>
  <aside class="panel" role="dialog" aria-label="Settings" aria-modal="true">
    <header class="panel-head">
      <h2>Settings</h2>
      <button class="btn btn-icon" data-act="close-settings" title="Close (Esc)">${icons.close}</button>
    </header>

    <div class="panel-body">
      <section class="fieldset">
        <h3>Sources</h3>
        <label class="lbl" for="set-owner">GitHub owners — every repo of these accounts is scanned</label>
        <div class="chips">${owners.map((o) => chip(o, 'owner')).join('') || '<span class="muted">none — add one below</span>'}</div>
        <div class="row">
          <input id="set-owner" class="input" type="text" placeholder="github username or org" autocomplete="off" data-field="ownerInput">
          <button class="btn btn-violet btn-sm" data-act="add-owner">Add</button>
        </div>

        <label class="lbl" for="set-repo">Extra repositories — hand-pinned <code>owner/repo</code></label>
        <div class="chips">${extra.map((r) => chip(r, 'repo')).join('') || '<span class="muted">none</span>'}</div>
        <div class="row">
          <input id="set-repo" class="input ${ctx.repoError ? 'invalid' : ''}" type="text" placeholder="owner/repo" autocomplete="off" data-field="repoInput">
          <button class="btn btn-violet btn-sm" data-act="add-repo">Add</button>
        </div>
        ${ctx.repoError ? `<p class="field-error">${esc(ctx.repoError)}</p>` : ''}
      </section>

      <section class="fieldset">
        <h3>Access</h3>
        <label class="lbl" for="set-token">GitHub token — needed for private repos and higher rate limits</label>
        <input id="set-token" class="input" type="password" data-field="token" value="${esc(d.token || '')}" placeholder="${esc(tokenPlaceholder)}" autocomplete="off" spellcheck="false">
        ${
          !d.token && ctx.tokenSource === 'gh'
            ? '<p class="field-note">Leave empty to keep using the token from the <code>gh</code> CLI.</p>'
            : ''
        }
      </section>

      <section class="fieldset">
        <h3>Locations</h3>
        <label class="lbl" for="set-root">Install root</label>
        <input id="set-root" class="input" type="text" data-field="installRoot" value="${esc(d.installRoot || '')}" placeholder="~/Applications" spellcheck="false">
        <label class="lbl" for="set-adb">adb path</label>
        <input id="set-adb" class="input" type="text" data-field="adbPath" value="${esc(d.adbPath || '')}" placeholder="adb" spellcheck="false">
        <label class="lbl" for="set-interval">Check for updates every (hours)</label>
        <input id="set-interval" class="input input-num" type="number" min="0" max="168" step="1" data-field="checkIntervalHours" value="${esc(d.checkIntervalHours ?? 6)}">
      </section>

      <section class="fieldset">
        <h3>About</h3>
        <p class="about-row">NX Hub <strong>${esc(ctx.hubVersion || 'dev')}</strong></p>
        <button class="btn btn-ghost btn-sm" data-act="check-hub">Check for hub update</button>
        <p class="field-note">The hub appears in the grid as a card labelled “this app” — updates install like any other app.</p>
      </section>
    </div>

    <footer class="panel-foot">
      <button class="btn btn-ghost" data-act="close-settings">Cancel</button>
      <button class="btn btn-violet" data-act="save-settings">Save</button>
    </footer>
  </aside>`;
}

/** Validation used by both the panel and the tests. */
export function validateRepoRef(value) {
  const v = String(value || '').trim();
  if (!v) return 'Enter a repository as owner/repo.';
  if (!isValidRepoRef(v)) return `“${v}” is not a valid owner/repo reference.`;
  return '';
}
