// Per-app options sheet: update policy, prereleases, skipped version, favorite,
// hidden, launch args (with a live shell-split preview) and launch env rows.
//
// Renders a *draft* — app.js owns it and only calls setAppPref() on save.

import { esc } from '../lib/html.js';
import { APP_POLICIES, policyLabel, splitArgs } from '../lib/prefs.js';
import { renderSheet } from './sheet.js';
import * as icons from './icons.js';

function checkbox(field, label, checked, note) {
  return `
    <label class="check">
      <input type="checkbox" data-pref="${esc(field)}"${checked ? ' checked' : ''}>
      <span class="check-box" aria-hidden="true"></span>
      <span class="check-text">${esc(label)}${note ? `<span class="check-note">${esc(note)}</span>` : ''}</span>
    </label>`;
}

/** The live preview under the launch-args input: one chip per parsed word. */
export function renderArgsPreview(value) {
  const { args, error } = splitArgs(value);
  if (error) return `<p class="field-error">${esc(error)}</p>`;
  if (!args.length) return '<p class="field-note">No extra arguments — the app starts as usual.</p>';
  return `<div class="arg-chips">${args
    .map((a, i) => `<span class="arg-chip"><span class="arg-i">${i + 1}</span>${esc(a)}</span>`)
    .join('')}</div>`;
}

function envRowMarkup(row, index) {
  return `
    <div class="env-row" data-env-row="${index}">
      <input class="input input-env-key" type="text" spellcheck="false" autocomplete="off"
             data-env-key="${index}" value="${esc(row.key)}" placeholder="NAME" aria-label="Variable name">
      <span class="env-eq">=</span>
      <input class="input input-env-val" type="text" spellcheck="false" autocomplete="off"
             data-env-val="${index}" value="${esc(row.value)}" placeholder="value" aria-label="Variable value">
      <button class="btn btn-icon" data-act="env-remove" data-index="${index}" title="Remove variable" aria-label="Remove variable">${icons.close}</button>
    </div>`;
}

/**
 * @param {object} app    normalized app
 * @param {object} draft  { updatePolicy, includePrereleases, skippedVersion,
 *                          favorite, hidden, launchArgsText, envRows }
 * @param {object} ctx    { settings, launchable, envError }
 */
export function renderAppOptions(app, draft, ctx = {}) {
  const d = draft || {};
  const settings = ctx.settings || {};
  const latest = (app && app.latest && app.latest.version) || '';
  const rows = Array.isArray(d.envRows) ? d.envRows : [];
  const skipped = String(d.skippedVersion || '');

  const body = `
    <section class="fieldset">
      <h3>Updates</h3>
      <label class="lbl" for="opt-policy">When a new release appears</label>
      <select id="opt-policy" class="input" data-pref="updatePolicy">
        ${APP_POLICIES.map(
          (p) =>
            `<option value="${esc(p)}"${d.updatePolicy === p ? ' selected' : ''}>${esc(policyLabel(p, settings))}</option>`
        ).join('')}
      </select>
      ${checkbox('includePrereleases', 'Include pre-releases', !!d.includePrereleases, 'alpha/beta tags count as updates')}

      <label class="lbl">Skipped version</label>
      ${
        skipped
          ? `<div class="skip-row">
               <span class="skip-chip">${esc(skipped)}</span>
               <span class="muted">is ignored until a newer release arrives</span>
               <button class="btn btn-ghost btn-sm" data-act="clear-skip" data-app="${esc(app.id)}">Clear</button>
             </div>`
          : latest
            ? `<div class="skip-row">
                 <span class="muted">Nothing skipped.</span>
                 <button class="btn btn-ghost btn-sm" data-act="skip-version" data-app="${esc(app.id)}" data-version="${esc(latest)}">Skip ${esc(latest)}</button>
               </div>`
            : '<p class="field-note">No release to skip yet.</p>'
      }
    </section>

    <section class="fieldset">
      <h3>In the hub</h3>
      ${checkbox('favorite', 'Favorite', !!d.favorite, 'pinned to the front of the launcher')}
      ${checkbox('hidden', 'Hide from the list', !!d.hidden, 'stays installed — reveal it again under “Show hidden”')}
    </section>

    <section class="fieldset">
      <h3>Launch</h3>
      ${
        ctx.launchable === false
          ? '<p class="field-note">This app has nothing launchable — arguments and variables are stored but unused.</p>'
          : ''
      }
      <label class="lbl" for="opt-args">Extra arguments</label>
      <input id="opt-args" class="input mono" type="text" spellcheck="false" autocomplete="off"
             data-pref="launchArgs" value="${esc(d.launchArgsText || '')}" placeholder="--no-gpu --profile &quot;my room&quot;">
      <div id="args-preview" class="args-preview">${renderArgsPreview(d.launchArgsText || '')}</div>

      <label class="lbl">Environment variables</label>
      <div class="env-rows">
        ${rows.map((row, i) => envRowMarkup(row, i)).join('') || '<p class="field-note">None.</p>'}
      </div>
      ${ctx.envError ? `<p class="field-error">${esc(ctx.envError)}</p>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="env-add">Add variable</button>
    </section>`;

  const foot = `
    <button class="btn btn-ghost" data-act="close-sheet">Cancel</button>
    <button class="btn btn-violet" data-act="save-app-prefs" data-app="${esc(app.id)}">Save</button>`;

  return renderSheet({
    title: app.name,
    subtitle: 'App options',
    label: `${app.name} options`,
    body,
    foot,
  });
}
