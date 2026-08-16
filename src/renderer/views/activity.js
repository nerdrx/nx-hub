// The Activity sheet: the flight recorder as a timeline (SPEC v0.8 [recorder]).
//
// Tier-2 sheet, DESIGN §4. Inside it the list is a WELL, not a second frosted
// layer — glass inside glass reads as fog, and this is the densest surface in
// the app. Every string that reaches this file came from another program's
// output (a job message, an app name, a peer's hostname), so nothing is
// interpolated without esc().

import { esc } from '../lib/html.js';
import {
  EVENT_FILTERS,
  eventChip,
  eventTone,
  eventsFor,
  formatClock,
  groupByDay,
  emptyText,
} from '../lib/events.js';
import { renderSheet, renderSheetLoading, renderSheetError } from './sheet.js';
import * as icons from './icons.js';

/** One filter chip. Sharp-cut, uppercase micro-label — DESIGN §5. */
function filterChip(f, active) {
  return `<button class="act-filter${active ? ' active' : ''}" data-act="activity-filter" data-filter="${esc(f.id)}"
    aria-pressed="${active ? 'true' : 'false'}">${esc(f.label)}</button>`;
}

export function renderFilterBar(current) {
  return `<div class="act-filters" role="group" aria-label="Filter activity">${EVENT_FILTERS.map((f) =>
    filterChip(f, f.id === (current || 'all'))
  ).join('')}</div>`;
}

/**
 * One row: clock, type chip, summary. The clock is hand-formatted (never
 * toLocaleTimeString) and the tone class carries the palette — the chip's own
 * text never repeats the summary.
 */
export function renderEventRow(event) {
  const tone = eventTone(event);
  const app = event && event.appId ? ` <span class="act-app">${esc(event.appId)}</span>` : '';
  return `<li class="act-row act-${esc(tone)}" data-ev-type="${esc(event.type)}">
      <span class="act-time">${esc(formatClock(event.ts))}</span>
      <span class="act-chip">${esc(eventChip(event))}</span>
      <span class="act-sum">${esc(event.summary)}${app}</span>
    </li>`;
}

/** A day separator plus its rows. */
export function renderDayGroup(group) {
  return `<section class="act-day" data-day="${esc(group.key)}">
      <h4 class="act-day-head"><span>${esc(group.label)}</span></h4>
      <ul class="act-list">${group.events.map(renderEventRow).join('')}</ul>
    </section>`;
}

/**
 * @param {object} ctx { events, filter, loading, error, more, paging, now }
 */
export function renderActivitySheet(ctx = {}) {
  const filter = ctx.filter || 'all';
  const events = eventsFor(ctx.events, filter);
  const bar = renderFilterBar(filter);

  let list;
  if (ctx.error) {
    list = renderSheetError(ctx.error, { act: 'activity', label: 'Try again' });
  } else if (ctx.loading && !(ctx.events || []).length) {
    list = renderSheetLoading('Reading the flight recorder…');
  } else if (!events.length) {
    list = `<p class="sheet-empty">${esc(emptyText(filter))}</p>`;
  } else {
    list =
      groupByDay(events, ctx.now || Date.now()).map(renderDayGroup).join('') +
      (ctx.more
        ? `<div class="act-more"><button class="btn btn-ghost btn-sm" data-act="activity-more"${
            ctx.paging ? ' disabled' : ''
          }>${ctx.paging ? 'Loading…' : 'Load more'}</button></div>`
        : '<p class="act-end">That is the whole recording.</p>');
  }

  return renderSheet({
    title: 'Activity',
    subtitle: 'What this hub has been doing',
    label: 'Activity',
    wide: true,
    body: `${bar}<div class="act-body">${list}</div>`,
  });
}

/** The header entry point. Hidden entirely when the bridge has no recorder. */
export function renderActivityButton() {
  return icons.history;
}
