// The Checkpoint sheet: "put this machine back the way it was at 14:32".
//
// SPEC v0.10 [replay] — reached from the Activity timeline, because that is
// where a user is already looking at the moment they want back. The sheet shows
// the reconstruction as a table (app · now → then · what happens), an optional
// config toggle, and — once confirmed — the same rows again as progress.
//
// Tier-2 sheet, DESIGN §4: the table inside it is a WELL, never a second frosted
// layer. Every app id and version in here came out of the flight recorder, which
// recorded what other programs said, so it all goes through esc().

import { esc } from '../lib/html.js';
import { renderSheet, renderSheetLoading, renderSheetError } from './sheet.js';
import { formatClock, dayLabel } from '../lib/events.js';
import {
  planRows,
  planSummary,
  hasWork,
  hasSnapshots,
  snapshotCount,
  versionMove,
  actionLabel,
  actionTone,
  uncertainNote,
  emptyPlanText,
  isRunning,
  isFinished,
  phaseLabel,
  rowTone,
  runResultText,
} from '../lib/checkpoint.js';
import * as icons from './icons.js';

/** "Today 14:32" / "3 Aug 2026 09:04" — hand-formatted, DESIGN §7. */
export function checkpointMoment(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const day = dayLabel(t, now);
  const clock = formatClock(t);
  return [day, clock].filter(Boolean).join(' ');
}

/**
 * The local catalogue's name wins (it is what the rest of the UI calls this
 * app), then the name [replay] reconstructed, then the bare id — which is still
 * better than a blank cell for an app nobody has heard of any more.
 */
function appName(row, apps) {
  const appId = (row && row.appId) || '';
  const app = (Array.isArray(apps) ? apps : []).find((a) => a && a.id === appId);
  return (app && app.name) || (row && row.appName) || appId;
}

/**
 * The artifact's human label ("Pico headset APK"), for the rows that need to say
 * WHICH build of an app they mean. Falls back to the bare id — an app can be in
 * a plan long after this hub stopped discovering it.
 */
function artifactName(row, apps) {
  const appId = (row && row.appId) || '';
  const artifactId = (row && row.artifactId) || '';
  if (!artifactId) return '';
  const app = (Array.isArray(apps) ? apps : []).find((a) => a && a.id === appId);
  const art = ((app && app.artifacts) || []).find((a) => a && a.id === artifactId);
  return (art && (art.label || art.name)) || artifactId;
}

/**
 * Which app ids appear more than once in this plan. Only those rows carry an
 * artifact label: naming the build on every row would be noise, and omitting it
 * where two rows share a name would be a riddle.
 */
function ambiguousApps(rows) {
  const count = new Map();
  for (const r of rows) count.set(r.appId, (count.get(r.appId) || 0) + 1);
  return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
}

/** One row of the plan table. */
export function renderPlanRow(row, ctx = {}) {
  const move = versionMove(row);
  const tone = actionTone(row);
  return `
    <tr class="cp-row cp-${esc(tone)}${row.uncertain ? ' is-uncertain' : ''}" data-cp-app="${esc(row.appId)}" data-cp-artifact="${esc(row.artifactId || '')}">
      <td class="cp-name">
        <span class="cp-title">${esc(appName(row, ctx.apps))}</span>
        ${
          ctx.ambiguous && ctx.ambiguous.has(row.appId)
            ? `<span class="cp-art">${esc(artifactName(row, ctx.apps))}</span>`
            : ''
        }
        ${row.snapshot ? `<span class="cp-snap" title="${esc(`a config snapshot from that time exists: ${row.snapshot}`)}">config</span>` : ''}
      </td>
      <td class="cp-ver mono">
        <span class="cp-from">${esc(move.from)}</span>
        <span class="cp-arrow" aria-hidden="true">→</span>
        <span class="cp-to">${esc(move.to)}</span>
      </td>
      <td class="cp-act">
        ${
          row.uncertain
            ? `<span class="cp-chip cp-chip-amber" title="${esc(
                row.reason || 'the release this needs is no longer published'
              )}">skipped</span>`
            : `<span class="cp-chip cp-chip-${esc(tone)}">${esc(actionLabel(row.action))}</span>`
        }
      </td>
    </tr>`;
}

export function renderPlanTable(plan, ctx = {}) {
  const rows = planRows(plan);
  if (!rows.length) return '';
  const inner = { ...ctx, ambiguous: ambiguousApps(rows) };
  return `
    <table class="cp-table">
      <thead><tr><th>App</th><th>Now → then</th><th>What happens</th></tr></thead>
      <tbody>${rows.map((r) => renderPlanRow(r, inner)).join('')}</tbody>
    </table>`;
}

/** The progress list, one row per app the restore has reached. */
export function renderProgress(run, plan, ctx = {}) {
  const rows = (run && run.rows) || [];
  const ambiguous = ambiguousApps(rows);
  const result = isFinished(run)
    ? `<p class="${run.phase === 'failed' ? 'field-error' : 'field-ok'}">${esc(runResultText(run, plan))}</p>`
    : '';
  // A run can end before any row exists — main refusing at the door. The reason
  // still has to reach the screen, so the result line is never gated on rows.
  if (!rows.length) {
    return result || '<p class="field-note">Starting the restore…</p>';
  }
  return `
    <ul class="cp-progress">
      ${rows
        .map(
          (r) => `<li class="cp-prow cp-${esc(rowTone(r))}" data-cp-progress="${esc(r.appId)}" data-cp-artifact="${esc(r.artifactId || '')}">
            <span class="cp-phase">${esc(phaseLabel(r.phase))}</span>
            <span class="cp-papp">${esc(
              ambiguous.has(r.appId) && artifactName(r, ctx.apps)
                ? `${appName(r, ctx.apps)} · ${artifactName(r, ctx.apps)}`
                : appName(r, ctx.apps)
            )}</span>
            ${r.message ? `<span class="cp-pmsg">${esc(r.message)}</span>` : ''}
          </li>`
        )
        .join('')}
    </ul>
    ${result}`;
}

/**
 * @param {{plan?:object, loading?:boolean, error?:string, ts?:number,
 *          now?:number, apps?:Array, configs?:boolean, busy?:boolean,
 *          run?:object, caps?:object}} ctx
 */
export function renderCheckpointSheet(ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const plan = ctx.plan || null;
  const run = ctx.run || null;
  const moment = checkpointMoment((plan && plan.ts) || ctx.ts, now);
  const summary = planSummary(plan);

  let body;
  if (ctx.error) {
    body = renderSheetError(ctx.error, { act: 'checkpoint-retry', label: 'Try again' });
  } else if (ctx.loading || !plan) {
    body = renderSheetLoading('Reconstructing that moment…');
  } else if (isRunning(run) || isFinished(run)) {
    body = `
      <section class="fieldset">
        <h3>Restoring</h3>
        ${renderProgress(run, plan, { apps: ctx.apps })}
      </section>`;
  } else {
    const empty = emptyPlanText(plan);
    const note = uncertainNote(plan);
    const configs = hasSnapshots(plan);
    const n = snapshotCount(plan);
    body = `
      <section class="fieldset">
        <h3>The plan</h3>
        ${renderPlanTable(plan, { apps: ctx.apps })}
        ${empty ? `<p class="field-note">${esc(empty)}</p>` : ''}
        ${note ? `<p class="cp-note">${icons.warn}<span>${esc(note)}</span></p>` : ''}
        ${
          configs
            ? `<label class="check cp-configs">
                 <input type="checkbox" data-act="checkpoint-configs"${ctx.configs ? ' checked' : ''}>
                 <span class="check-box" aria-hidden="true"></span>
                 <span class="check-text">Also restore saved configs<span class="check-note">${esc(
                   `${n} app${n === 1 ? '' : 's'} kept a config snapshot from around that time`
                 )}</span></span>
               </label>`
            : ''
        }
      </section>`;
  }

  const foot =
    plan && !ctx.error && !isRunning(run) && !isFinished(run) && hasWork(plan)
      ? `<button class="btn btn-ghost" data-act="close-sheet">Cancel</button>
         <button class="btn btn-violet" data-act="checkpoint-confirm"${ctx.busy ? ' disabled' : ''}>${
           ctx.busy ? 'Restoring…' : 'Restore to here'
         }</button>`
      : isFinished(run)
        ? '<button class="btn btn-violet" data-act="close-sheet">Close</button>'
        : '';

  const counts = [];
  if (summary.install) counts.push(`${summary.install} to install`);
  if (summary.remove) counts.push(`${summary.remove} to remove`);
  if (summary.uncertain) counts.push(`${summary.uncertain} skipped`);

  return renderSheet({
    title: moment ? `Restore to ${moment}` : 'Restore to a checkpoint',
    subtitle: plan && !ctx.loading ? counts.join(' · ') || 'Everything already matches that point' : 'Reading the recording',
    label: 'Checkpoint',
    wide: true,
    body,
    foot,
  });
}

/**
 * The affordance in the Activity timeline. A quiet ghost control — restoring the
 * whole machine is not something to invite with a primary button.
 */
export function renderRestoreControl(ts, opts = {}) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const label = opts.label || 'restore to here…';
  return `<button class="act-restore" data-act="checkpoint" data-ts="${esc(String(Math.round(t)))}"
      title="${esc('Put every app back the way it was at this point')}">${icons.rollback}<span>${esc(label)}</span></button>`;
}
