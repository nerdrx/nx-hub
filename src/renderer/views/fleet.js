// The Fleet surface: the header peer chip and the Fleet sheet (peers, their app
// summaries, the two pairing directions, and live remote job rows).
//
// EVERY string in here that came off the wire — peer names, hostnames, app ids
// and app names inside a peer's summary — is network input from another machine.
// It all goes through esc(); nothing is ever interpolated raw.

import { esc } from '../lib/html.js';
import { renderSheet } from './sheet.js';
import { renderPhaseLabel } from './card.js';
import { relativeTime } from '../lib/version.js';
import {
  fleetCounts,
  peerAppTable,
  peerAppActions,
  peerJobs,
  peerSince,
  canWake,
  wakeTitle,
  codeGroups,
  codeMsLeft,
  formatCountdown,
} from '../lib/fleet.js';
import * as icons from './icons.js';

/**
 * Header chip — online peer count with a violet dot. app.js keeps it out of the
 * DOM entirely when the bridge has no fleet or no peer was ever seen.
 */
export function renderPeerChip(peers, ctx = {}) {
  const counts = fleetCounts(peers);
  const state = counts.online ? 'on' : 'off';
  const label = counts.online
    ? `${counts.online} hub${counts.online === 1 ? '' : 's'}`
    : `${counts.peers} offline`;
  const title = counts.online
    ? `${counts.online} of ${counts.peers} paired hub${counts.peers === 1 ? '' : 's'} online — click to manage`
    : 'No paired hub is answering — click to manage';
  return `<button class="peer-chip peer-${esc(state)}" data-act="fleet" title="${esc(title)}" aria-label="Fleet">
      <span class="peer-dot" aria-hidden="true"></span>
      ${icons.fleet}<span class="peer-chip-text">${esc(label)}</span>
      ${counts.updates ? `<span class="peer-updates" title="${esc(`${counts.updates} update${counts.updates === 1 ? '' : 's'} waiting across the fleet`)}">${esc(String(counts.updates))}</span>` : ''}
      ${ctx.busy ? '<span class="spinner spinner-sm" aria-hidden="true"></span>' : ''}
    </button>`;
}

/* ------------------------------------------------------------- pairing */

function pairPanel(pair, now) {
  const state = pair || { mode: 'idle' };
  const buttons = `
    <div class="row pair-actions">
      <button class="btn btn-violet btn-sm" data-act="fleet-show-code"${state.busy && state.mode === 'show' ? ' disabled' : ''}>${
        state.mode === 'show' && state.busy ? 'Asking…' : 'Show pairing code'
      }</button>
      <button class="btn btn-outline btn-sm" data-act="fleet-pair-open">Pair with hub…</button>
    </div>`;

  if (state.mode === 'show') {
    const left = codeMsLeft(state.expiresAt, now);
    const groups = codeGroups(state.code);
    const body = state.code
      ? `<div class="pair-code${left ? '' : ' is-expired'}">
           <span class="pair-digits" aria-label="${esc(`Pairing code ${String(state.code).split('').join(' ')}`)}">${groups
             .map((g) => `<span class="pair-group">${esc(g)}</span>`)
             .join('<span class="pair-gap" aria-hidden="true"></span>')}</span>
           <span class="pair-count${left && left < 30000 ? ' is-soon' : ''}">${
             left ? `expires in ${esc(formatCountdown(left))}` : 'expired — show a fresh one'
           }</span>
         </div>
         <p class="field-note">Type these six digits into the other hub’s “Pair with hub…” box while it lasts.</p>`
      : `<p class="field-note">${
          state.busy ? 'Arming the pairing window…' : 'No code yet — press “Show pairing code”.'
        }</p>`;
    return `${buttons}${state.error ? `<p class="field-error">${esc(state.error)}</p>` : ''}${body}`;
  }

  if (state.mode === 'enter') {
    const errors = state.errors || {};
    return `${buttons}
      <div class="pair-form">
        <label class="lbl" for="fleet-host">Other hub’s address</label>
        <input id="fleet-host" class="input mono${errors.host ? ' invalid' : ''}" type="text" spellcheck="false"
               autocomplete="off" placeholder="192.168.1.50" data-fleet-field="host" value="${esc(state.host || '')}">
        ${errors.host ? `<p class="field-error">${esc(errors.host)}</p>` : ''}
        <label class="lbl" for="fleet-code">Pairing code</label>
        <input id="fleet-code" class="input mono pair-input${errors.code ? ' invalid' : ''}" type="text" inputmode="numeric"
               spellcheck="false" autocomplete="off" maxlength="7" placeholder="123456"
               data-fleet-field="code" value="${esc(state.input || '')}">
        ${errors.code ? `<p class="field-error">${esc(errors.code)}</p>` : ''}
        ${state.error ? `<p class="field-error">${esc(state.error)}</p>` : ''}
        <div class="row">
          <button class="btn btn-violet btn-sm" data-act="fleet-pair-submit"${state.busy ? ' disabled' : ''}>${
            state.busy ? 'Pairing…' : 'Pair'
          }</button>
          <button class="btn btn-ghost btn-sm" data-act="fleet-pair-cancel">Cancel</button>
        </div>
      </div>`;
  }

  return `${buttons}
    ${state.ok ? `<p class="field-ok">${esc(state.ok)}</p>` : ''}
    ${state.error ? `<p class="field-error">${esc(state.error)}</p>` : ''}
    <p class="field-note">Pairing works in both directions — one hub shows a six-digit code, the other types it in.</p>`;
}

/* --------------------------------------------------------------- peers */

function appRow(row, peer) {
  const picker =
    row.artifacts.length > 1
      ? `<select class="input input-sm fleet-pick" data-fleet-art="${esc(peer.id)}::${esc(row.id)}"
                aria-label="${esc(`Which build of ${row.name}`)}">
           ${row.artifacts
             .map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`)
             .join('')}
         </select>`
      : '';
  const artifactId = row.artifacts.length === 1 ? row.artifacts[0].id : '';
  const actions = peerAppActions(row)
    .map(
      (a) =>
        `<button class="btn btn-${esc(a.variant || 'ghost')} btn-sm" data-act="${esc(a.act)}" data-peer="${esc(
          peer.id
        )}" data-app="${esc(row.id)}" data-art="${esc(artifactId)}"${a.disabled ? ' disabled' : ''}${
          a.title ? ` title="${esc(a.title)}"` : ''
        }>${esc(a.label)}</button>`
    )
    .join('');

  return `
    <tr class="peer-app${row.updates ? ' has-update' : ''}" data-peer-app="${esc(row.id)}">
      <td class="pa-name">
        <span class="pa-title">${esc(row.name)}</span>
        ${row.known ? '' : '<span class="pa-unknown" title="this hub does not track that app">not here</span>'}
      </td>
      <td class="pa-ver mono">${esc(row.installed || 'not installed')}</td>
      <td class="pa-upd">${
        row.updates
          ? `<span class="pa-badge" title="${esc(`${row.updates} update${row.updates === 1 ? '' : 's'} available there`)}">${esc(
              String(row.updates)
            )}</span>`
          : '<span class="pa-none">—</span>'
      }</td>
      <td class="pa-act">${picker}${actions}</td>
    </tr>`;
}

function jobRow(job) {
  const pct = Number(job.pct);
  const known = Number.isFinite(pct) && pct >= 0;
  const width = known ? Math.max(2, Math.min(100, pct)) : 100;
  return `
    <div class="fleet-job" data-fleet-job="${esc(job.key)}">
      <div class="job-row">
        ${renderPhaseLabel(job)}
        <span class="job-target">${esc(job.appId || '')}</span>
      </div>
      <div class="bar ${known ? '' : 'bar-indeterminate'}"><span style="width:${width}%"></span></div>
    </div>`;
}

function peerBlock(peer, ctx) {
  const rows = peerAppTable(peer, { apps: ctx.apps });
  const jobs = peerJobs(ctx.jobs, peer.id);
  const updates = rows.reduce((n, r) => n + r.updates, 0);
  const seen = relativeTime(peerSince(peer), ctx.now);

  return `
    <section class="peer${peer.online ? ' is-online' : ' is-offline'}" data-peer="${esc(peer.id)}">
      <header class="peer-head">
        <span class="peer-state" aria-hidden="true"></span>
        <div class="peer-ident">
          <span class="peer-name">${esc(peer.name)}</span>
          <span class="peer-host mono">${esc(peer.host || 'unknown address')}</span>
        </div>
        <span class="peer-seen">${esc(peer.online ? 'online' : seen ? `last seen ${seen}` : 'never seen')}</span>
        <span class="peer-tools">
          ${
            ctx.canWake && canWake(peer)
              ? `<button class="btn btn-outline btn-sm peer-wake" data-act="fleet-wake" data-peer="${esc(
                  peer.id
                )}" title="${esc(wakeTitle(peer))}">${icons.power}<span>Wake</span></button>`
              : ''
          }
          ${
            updates
              ? `<button class="btn btn-amber btn-sm" data-act="fleet-update-all" data-peer="${esc(peer.id)}"${
                  peer.online ? '' : ' disabled'
                } title="${esc(`Install every waiting update on ${peer.name}`)}">Update all<span class="pa-badge">${esc(
                  String(updates)
                )}</span></button>`
              : ''
          }
          <button class="btn btn-icon" data-act="fleet-unpair" data-peer="${esc(peer.id)}" title="${esc(
            `Unpair ${peer.name}`
          )}" aria-label="${esc(`Unpair ${peer.name}`)}">${icons.trash}</button>
        </span>
      </header>
      ${
        rows.length
          ? `<table class="peer-apps">
               <thead><tr><th>App</th><th>Installed</th><th>Updates</th><th></th></tr></thead>
               <tbody>${rows.map((r) => appRow(r, peer)).join('')}</tbody>
             </table>`
          : `<p class="field-note">${
              peer.online ? 'That hub has not sent its app summary yet.' : 'No summary — the hub is offline.'
            }</p>`
      }
      ${jobs.length ? `<div class="fleet-jobs">${jobs.map(jobRow).join('')}</div>` : ''}
    </section>`;
}

/**
 * @param {{peers?:Array, apps?:Array, pair?:object, jobs?:object, now?:number,
 *          busy?:boolean, caps?:object}} ctx
 */
export function renderFleetSheet(ctx = {}) {
  const peers = Array.isArray(ctx.peers) ? ctx.peers : [];
  const now = Number(ctx.now) || Date.now();
  const counts = fleetCounts(peers);

  const body = `
    <section class="fieldset">
      <h3>Pairing</h3>
      ${pairPanel(ctx.pair, now)}
    </section>
    <section class="fieldset">
      <h3>Hubs</h3>
      ${
        peers.length
          ? `<div class="peer-list">${peers
              .map((p) =>
                peerBlock(p, {
                  apps: ctx.apps,
                  jobs: ctx.jobs,
                  now,
                  // No fleetWake() in this build → no button, whatever the peer says.
                  canWake: !ctx.caps || ctx.caps.fleetWake !== false,
                })
              )
              .join('')}</div>`
          : `<div class="stack-empty">
               <p class="empty-title">No other hub paired</p>
               <p class="muted">Pair a second machine and you can install, update and launch on it from here.</p>
             </div>`
      }
    </section>`;

  return renderSheet({
    title: 'Fleet',
    subtitle: peers.length
      ? `${counts.online} of ${counts.peers} hub${counts.peers === 1 ? '' : 's'} online${
          counts.updates ? ` · ${counts.updates} update${counts.updates === 1 ? '' : 's'} waiting` : ''
        }`
      : 'Other NX Hubs on this network',
    label: 'Fleet',
    body,
    wide: true,
  });
}
