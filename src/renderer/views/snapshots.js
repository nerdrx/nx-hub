// Config snapshots: the section inside the app-options sheet, and the rollback
// confirm that offers to bring the old config back with the old binary.
//
// SPEC v0.8 [timemachine]. Snapshot filenames are generated from an app id and
// a timestamp, but they are still strings off disk — every one goes through
// esc() before it reaches markup, including inside data- attributes.

import { esc } from '../lib/html.js';
import { formatBytes, formatDate, relativeTime } from '../lib/version.js';
import {
  normalizeSnapshots,
  reasonLabel,
  AFFINITY_LABEL,
  affinityNote,
  EMPTY_TEXT,
} from '../lib/snapshots.js';
import { renderSheet } from './sheet.js';
import * as icons from './icons.js';

function snapshotRow(app, snapshot, ctx = {}) {
  const when = formatDate(snapshot.ts);
  const rel = relativeTime(snapshot.ts, ctx.now || Date.now());
  const busy = ctx.busy === snapshot.file;
  return `
    <div class="snap-row" data-snap="${esc(snapshot.file)}">
      <div class="snap-main">
        <div class="snap-top">
          <span class="snap-when" title="${esc(when)}">${esc(rel || when)}</span>
          ${snapshot.version ? `<span class="snap-ver">${esc(snapshot.version)}</span>` : ''}
          <span class="snap-reason">${esc(reasonLabel(snapshot.reason))}</span>
        </div>
        ${snapshot.bytes ? `<div class="snap-size">${esc(formatBytes(snapshot.bytes))}</div>` : ''}
      </div>
      <div class="snap-acts">
        <button class="btn btn-ghost btn-sm" data-act="snap-restore" data-app="${esc(app.id)}" data-snap="${esc(snapshot.file)}"${busy ? ' disabled' : ''}
          title="write these files back over the current config">${icons.rollback}<span>Restore</span></button>
        <button class="btn btn-icon" data-act="snap-delete" data-app="${esc(app.id)}" data-snap="${esc(snapshot.file)}"${busy ? ' disabled' : ''}
          title="Delete this snapshot" aria-label="Delete this snapshot">${icons.trash}</button>
      </div>
    </div>`;
}

/**
 * @param {object} app  normalized app
 * @param {object} data { loading, error, snapshots }
 * @param {object} ctx  { now, busy }
 */
export function renderSnapshotsSection(app, data = {}, ctx = {}) {
  const list = normalizeSnapshots(data.snapshots);
  let body;
  if (data.loading) {
    body = '<p class="field-note">Reading the snapshots…</p>';
  } else if (data.error) {
    body = `<p class="field-error">${esc(data.error)}</p>`;
  } else if (!list.length) {
    body = `<p class="field-note">${esc(EMPTY_TEXT)}</p>`;
  } else {
    body = `<div class="snap-list">${list.map((s) => snapshotRow(app, s, ctx)).join('')}</div>`;
  }

  return `
    <section class="fieldset">
      <h3>${icons.archive}<span>Config snapshots</span></h3>
      ${body}
      <p class="field-note">A restore writes the archived files back over the current ones and snapshots
        what is there first. Files created since the snapshot are left alone.</p>
    </section>`;
}

/**
 * The rollback confirm — a sheet rather than a window.confirm() for exactly one
 * reason: the affinity checkbox. Without a matching pre-update snapshot there
 * is nothing to tick and app.js keeps using the plain confirm, so this surface
 * only ever appears when it has something to offer.
 *
 * @param {object} app     normalized app
 * @param {object} target  {artifactId, label, prevVersion, currentVersion}
 * @param {object} hit     the matching pre-update snapshot
 * @param {object} ctx     { restoreConfig, busy }
 */
export function renderRollbackSheet(app, target, hit, ctx = {}) {
  const checked = ctx.restoreConfig !== false;
  const body = `
    <section class="fieldset">
      <h3>${icons.rollback}<span>Roll back ${esc(target.label)}</span></h3>
      <div class="rollback-row">
        <span class="rollback-ver">${esc(target.currentVersion)} → ${esc(target.prevVersion)}</span>
      </div>
      <p class="field-note">The kept previous install is restored. Settings and data are untouched by
        the rollback itself.</p>
    </section>

    <section class="fieldset">
      <h3>${icons.archive}<span>Config</span></h3>
      <label class="check">
        <input type="checkbox" data-rollback-config${checked ? ' checked' : ''}>
        <span class="check-box" aria-hidden="true"></span>
        <span class="check-text">${esc(AFFINITY_LABEL)}<span class="check-note">${esc(affinityNote(hit))}</span></span>
      </label>
    </section>`;

  const foot = `
    <button class="btn btn-ghost" data-act="close-sheet">Cancel</button>
    <button class="btn btn-amber" data-act="rollback-confirm" data-app="${esc(app.id)}" data-art="${esc(target.artifactId)}"
      data-snap="${esc(hit.file)}"${ctx.busy ? ' disabled' : ''}>Roll back to ${esc(target.prevVersion)}</button>`;

  return renderSheet({
    title: app.name,
    subtitle: 'Roll back',
    label: `Roll back ${app.name}`,
    body,
    foot,
  });
}
