// v0.8 flight recorder — the event model (types, tones, day grouping, paging
// arithmetic) and the Activity sheet that renders it.
//
// Timestamps here are built from a fixed local anchor rather than from
// Date.now(), because every rule under test is about the LOCAL calendar day and
// the suite has to give the same answer in de_DE at 23:58 as in UTC at noon.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_FILTERS,
  PAGE_SIZE,
  SUMMARY_MAX,
  normalizeEvent,
  normalizeEvents,
  eventChip,
  eventTone,
  eventKey,
  mergeEvents,
  oldestTs,
  pageQuery,
  hasMore,
  eventsFor,
  filterTypes,
  isFilterId,
  formatClock,
  dayKey,
  dayLabel,
  groupByDay,
  emptyText,
} from '../../src/renderer/lib/events.js';
import {
  renderActivitySheet,
  renderEventRow,
  renderDayGroup,
  renderFilterBar,
} from '../../src/renderer/views/activity.js';
import { createMock } from '../../src/renderer/mock.js';

/** Local noon of "today", so nothing in this file can straddle midnight. */
const TODAY = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})();
const HOUR = 3600000;
const DAY = 86400000;

function ev(over = {}) {
  return { ts: TODAY, type: 'job-done', appId: 'wivrn-nx', summary: 'installed', ...over };
}

/* ------------------------------------------------------------ normalizing */

test('normalizeEvent fills every field and clamps the summary at 160 chars', () => {
  const e = normalizeEvent({ ts: '1700000000000', type: 'job-done', summary: 'x'.repeat(400), data: { a: 1 } });
  assert.equal(e.ts, 1700000000000, 'a numeric string still parses');
  assert.equal(e.summary.length, SUMMARY_MAX);
  assert.ok(e.summary.endsWith('…'), 'the clamp is visible, not silent');
  assert.deepEqual(e.data, { a: 1 });
  assert.equal(e.appId, '');

  const junk = normalizeEvent(null);
  assert.equal(junk.ts, 0);
  assert.equal(junk.type, '');
  assert.equal(junk.data, null, 'a non-object data is dropped rather than kept as junk');
});

test('normalizeEvents drops day dividers and untimestamped rows, newest first', () => {
  const list = normalizeEvents([
    { ts: TODAY - HOUR, type: 'job-done', summary: 'older' },
    { ts: TODAY, type: 'day', summary: 'a divider the recorder emitted' },
    { ts: TODAY, type: 'job-error', summary: 'newer' },
    { ts: 0, type: 'job-done', summary: 'no timestamp' },
    null,
    { type: 'job-done', summary: 'also no timestamp' },
  ]);
  assert.deepEqual(list.map((e) => e.summary), ['newer', 'older']);
  assert.ok(!list.some((e) => e.type === 'day'), 'dividers are the UI’s job, not the payload’s');
  assert.deepEqual(normalizeEvents(null), []);
  assert.deepEqual(normalizeEvents('nope'), []);
});

/* ------------------------------------------------------- chips and tones */

test('every recorded type gets a chip, and an unknown one still gets a chip', () => {
  assert.equal(eventChip(ev({ type: 'job-done' })), 'INSTALL');
  assert.equal(eventChip(ev({ type: 'job-error' })), 'ERROR');
  assert.equal(eventChip(ev({ type: 'update-available' })), 'UPDATE');
  assert.equal(eventChip(ev({ type: 'stack-progress' })), 'STACK');
  assert.equal(eventChip(ev({ type: 'connector-join' })), 'JOIN');
  assert.equal(eventChip(ev({ type: 'connector-leave' })), 'LEAVE');
  assert.equal(eventChip(ev({ type: 'fleet-progress' })), 'FLEET');
  assert.equal(eventChip(ev({ type: 'supervisor' })), 'WATCHDOG');
  // A newer main process must never render as a blank column.
  assert.equal(eventChip(ev({ type: 'quota-warning' })), 'QUOTA WARNING');
  assert.equal(eventChip(ev({ type: '' })), 'EVENT');
});

test('the tone map is exactly the brand rule — danger, amber, cyan, muted', () => {
  assert.equal(eventTone(ev({ type: 'job-error' })), 'danger');
  assert.equal(eventTone(ev({ type: 'update-available' })), 'amber');
  assert.equal(eventTone(ev({ type: 'connector-join' })), 'cyan');
  assert.equal(eventTone(ev({ type: 'connector-leave' })), 'cyan');
  assert.equal(eventTone(ev({ type: 'job-done' })), 'muted');
  assert.equal(eventTone(ev({ type: 'stack-progress' })), 'muted');
  assert.equal(eventTone(ev({ type: 'fleet-progress' })), 'muted');
});

test('a watchdog that gave up is danger; one that is retrying is not', () => {
  assert.equal(eventTone(ev({ type: 'supervisor', data: { action: 'gave-up' } })), 'danger');
  assert.equal(eventTone(ev({ type: 'supervisor', data: { action: 'restarting' } })), 'muted');
  // No action at all: a bare supervisor record is not an alarm.
  assert.equal(eventTone(ev({ type: 'supervisor' })), 'muted');
  // The action may also ride at the top level of a hand-built record.
  assert.equal(eventTone(ev({ type: 'supervisor', action: 'gave-up' })), 'danger');
});

/* --------------------------------------------------------------- filters */

test('the chip set is the documented one and every id resolves to its types', () => {
  assert.deepEqual(EVENT_FILTERS.map((f) => f.id), [
    'all',
    'installs',
    'errors',
    'bus',
    'fleet',
    'stacks',
    'watchdog',
  ]);
  assert.equal(filterTypes('all'), null, 'All is "no filter", never an empty set');
  assert.deepEqual(filterTypes('installs'), ['job-done', 'update-available']);
  assert.deepEqual(filterTypes('errors'), ['job-error']);
  assert.deepEqual(filterTypes('bus'), ['connector-join', 'connector-leave']);
  assert.deepEqual(filterTypes('fleet'), ['fleet-progress']);
  assert.deepEqual(filterTypes('stacks'), ['stack-progress']);
  assert.deepEqual(filterTypes('watchdog'), ['supervisor']);
  assert.equal(filterTypes('nonsense'), null, 'an unknown id shows everything rather than nothing');
  assert.equal(isFilterId('bus'), true);
  assert.equal(isFilterId('bus '), false);
});

test('eventsFor slices by the chip’s type set, and All keeps the lot', () => {
  const list = [
    ev({ type: 'job-done' }),
    ev({ type: 'job-error' }),
    ev({ type: 'update-available' }),
    ev({ type: 'connector-join' }),
    ev({ type: 'supervisor' }),
  ];
  assert.equal(eventsFor(list, 'all').length, 5);
  assert.deepEqual(eventsFor(list, 'installs').map((e) => e.type), ['job-done', 'update-available']);
  assert.deepEqual(eventsFor(list, 'errors').map((e) => e.type), ['job-error']);
  assert.deepEqual(eventsFor(list, 'watchdog').map((e) => e.type), ['supervisor']);
  assert.deepEqual(eventsFor(list, 'fleet'), []);
});

/* ---------------------------------------------------------------- paging */

test('mergeEvents dedupes overlapping pages and re-sorts newest first', () => {
  const a = normalizeEvents([ev({ ts: TODAY, summary: 'new' }), ev({ ts: TODAY - HOUR, summary: 'old' })]);
  // The next page overlaps by one (a bridge that answers `until` inclusively).
  const b = [ev({ ts: TODAY - HOUR, summary: 'old' }), ev({ ts: TODAY - 2 * HOUR, summary: 'older' })];
  const merged = mergeEvents(a, b);
  assert.deepEqual(merged.map((e) => e.summary), ['new', 'old', 'older']);

  // …and a newer page merges at the top, which is what the live tail does.
  const live = mergeEvents(merged, [ev({ ts: TODAY + HOUR, summary: 'newest' })]);
  assert.deepEqual(live.map((e) => e.summary), ['newest', 'new', 'old', 'older']);
});

test('two records differing only in type are two records', () => {
  const join = ev({ type: 'connector-join', summary: 'same' });
  const leave = ev({ type: 'connector-leave', summary: 'same' });
  assert.notEqual(eventKey(join), eventKey(leave));
  assert.equal(mergeEvents([], [join, leave]).length, 2);
});

test('the paging cursor is the oldest ts held, and it always advances', () => {
  const list = normalizeEvents([ev({ ts: TODAY }), ev({ ts: TODAY - 3 * HOUR }), ev({ ts: TODAY - HOUR })]);
  assert.equal(oldestTs(list), TODAY - 3 * HOUR);
  assert.deepEqual(pageQuery(list), { until: TODAY - 3 * HOUR, limit: PAGE_SIZE });
  // The first page has no cursor to lower — it must not send `until: 0`.
  assert.deepEqual(pageQuery([]), { limit: PAGE_SIZE });
  assert.equal(oldestTs(null), 0);
});

test('hasMore ends the road when a page adds nothing new', () => {
  // A full page that grew the list: there may well be more.
  assert.equal(hasMore(25, 50, 25, 25), true);
  // A full page that added nothing (the bridge re-served the same tail).
  assert.equal(hasMore(25, 25, 25, 25), false);
  // A short page: this was the end even though it did add rows.
  assert.equal(hasMore(25, 30, 5, 25), false);
});

/* ----------------------------------------------------------- day + clock */

test('the clock is hand-formatted from the local wall clock, zero-padded', () => {
  const d = new Date(TODAY);
  d.setHours(9, 5, 0, 0);
  assert.equal(formatClock(d.getTime()), '09:05');
  d.setHours(23, 59, 0, 0);
  assert.equal(formatClock(d.getTime()), '23:59');
  d.setHours(0, 0, 0, 0);
  assert.equal(formatClock(d.getTime()), '00:00');
  assert.equal(formatClock(0), '');
  assert.equal(formatClock('nope'), '');
});

test('day labels read Today / Yesterday / an explicit English date', () => {
  assert.equal(dayLabel(TODAY, TODAY), 'Today');
  assert.equal(dayLabel(TODAY - DAY, TODAY), 'Yesterday');
  const older = dayLabel(TODAY - 5 * DAY, TODAY);
  assert.match(older, /^\d{1,2} [A-Z][a-z]{2} \d{4}$/, older);
  assert.ok(!/undefined|NaN/.test(older));
  assert.equal(dayLabel(0, TODAY), '');
  // Two moments on the same local day share a key; a day apart do not.
  assert.equal(dayKey(TODAY), dayKey(TODAY + 3 * HOUR));
  assert.notEqual(dayKey(TODAY), dayKey(TODAY - DAY));
});

test('groupByDay buckets a newest-first list without reordering it', () => {
  const list = normalizeEvents([
    ev({ ts: TODAY, summary: 'a' }),
    ev({ ts: TODAY - HOUR, summary: 'b' }),
    ev({ ts: TODAY - DAY, summary: 'c' }),
    ev({ ts: TODAY - 2 * DAY, summary: 'd' }),
    ev({ ts: TODAY - 2 * DAY - HOUR, summary: 'e' }),
  ]);
  const groups = groupByDay(list, TODAY);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.label.replace(/^\d.*/, 'date')), ['Today', 'Yesterday', 'date']);
  assert.deepEqual(groups.map((g) => g.events.map((e) => e.summary)), [['a', 'b'], ['c'], ['d', 'e']]);
  assert.deepEqual(groupByDay([], TODAY), []);
});

/* ------------------------------------------------------------- rendering */

test('an event row carries its clock, its chip and its tone class', () => {
  const d = new Date(TODAY);
  d.setHours(14, 32, 0, 0);
  const html = renderEventRow(normalizeEvent(ev({ ts: d.getTime(), type: 'job-error', summary: 'it broke' })));
  assert.match(html, /class="act-row act-danger"/);
  assert.match(html, /class="act-time">14:32</);
  assert.match(html, /class="act-chip">ERROR</);
  assert.match(html, /it broke/);
  assert.match(html, /data-ev-type="job-error"/);
});

test('a day group prints one header above its rows', () => {
  const group = groupByDay(normalizeEvents([ev({ ts: TODAY }), ev({ ts: TODAY - HOUR })]), TODAY)[0];
  const html = renderDayGroup(group);
  assert.equal((html.match(/act-day-head/g) || []).length, 1);
  assert.equal((html.match(/act-row/g) || []).length, 2);
  assert.match(html, /<span>Today<\/span>/);
});

test('the filter bar marks exactly one chip active', () => {
  const bar = renderFilterBar('errors');
  assert.equal((bar.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(bar, /data-filter="errors"[^>]*\n?[^>]*aria-pressed="true"|data-filter="errors"/);
  assert.match(bar, /class="act-filter active" data-act="activity-filter" data-filter="errors"/);
  // An unknown current selection falls back to All rather than to nothing.
  assert.match(renderFilterBar('nonsense'), /data-filter="all"\s*\n?\s*aria-pressed="false"/);
  assert.match(renderFilterBar(''), /class="act-filter active" data-act="activity-filter" data-filter="all"/);
});

test('the sheet shows loading, error, empty and populated states', () => {
  assert.match(renderActivitySheet({ loading: true, events: [] }), /Reading the flight recorder/);
  assert.match(renderActivitySheet({ error: 'nope', events: [] }), /sheet-error/);
  assert.match(renderActivitySheet({ error: 'nope', events: [] }), /data-act="activity"/, 'and offers a retry');

  const empty = renderActivitySheet({ events: [], filter: 'all' });
  assert.match(empty, /Nothing recorded yet/);
  const emptyFiltered = renderActivitySheet({ events: [ev()], filter: 'errors' });
  assert.match(emptyFiltered, /Nothing under “Errors” yet/, 'a chip hiding everything says so in its own words');
  assert.match(emptyText('all'), /Nothing recorded yet/);

  const full = renderActivitySheet({ events: normalizeEvents([ev(), ev({ ts: TODAY - DAY })]), now: TODAY });
  assert.match(full, /aria-label="Activity"/);
  assert.match(full, /act-filters/);
  assert.equal((full.match(/act-day-head/g) || []).length, 2, 'two days, two headers');
});

test('“Load more” appears only while there is more, and disables while paging', () => {
  const events = normalizeEvents([ev()]);
  assert.match(renderActivitySheet({ events, more: true, now: TODAY }), /data-act="activity-more"/);
  assert.match(renderActivitySheet({ events, more: true, paging: true, now: TODAY }), /disabled/);
  assert.match(renderActivitySheet({ events, more: true, paging: true, now: TODAY }), /Loading…/);
  const done = renderActivitySheet({ events, more: false, now: TODAY });
  assert.ok(!done.includes('activity-more'));
  assert.match(done, /That is the whole recording/);
});

/* -------------------------------------------------------------- escaping */

test('a hostile summary is escaped, not rendered', () => {
  const nasty = '<img src=x onerror=alert(1)> "quoted" & <b>bold</b>';
  const row = renderEventRow(normalizeEvent(ev({ summary: nasty })));
  assert.ok(!row.includes('<img'), row);
  assert.ok(!row.includes('<b>'), row);
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(row, /&quot;quoted&quot;/);
  assert.match(row, /&amp; /);

  // …and so is an appId, which is the other string a recorder copies verbatim.
  const evil = renderEventRow(normalizeEvent(ev({ appId: '"><script>x</script>' })));
  assert.ok(!evil.includes('<script>'), evil);

  // A type that reaches a data- attribute cannot break out of it either.
  const badType = renderEventRow(normalizeEvent(ev({ type: '"><b>x' })));
  assert.ok(!badType.includes('><b>x'), badType);
});

/* ------------------------------------------------------------- the mock */

test('the mock recorder answers newest-first, pages by `until`, and covers every type', async () => {
  const { nxhub, dev } = createMock();
  const page = await nxhub.getEvents({ limit: 100 });
  const real = page.filter((e) => e.type !== 'day');
  assert.ok(real.length >= 40, `expected 40+ seeded events, got ${real.length}`);
  assert.ok(page.some((e) => e.type === 'day'), 'the recorder emits its own dividers');

  for (const type of [
    'job-done',
    'job-error',
    'update-available',
    'stack-progress',
    'connector-join',
    'connector-leave',
    'fleet-progress',
    'supervisor',
  ]) {
    assert.ok(real.some((e) => e.type === type), `no seeded ${type} event`);
  }

  // Three local days of history, so the separators have something to separate.
  const days = new Set(real.map((e) => dayKey(e.ts)));
  assert.ok(days.size >= 3, `expected 3 days, got ${[...days].join()}`);

  // Newest first, and the cursor strictly advances.
  const first = await nxhub.getEvents({ limit: 10 });
  const firstReal = normalizeEvents(first);
  assert.deepEqual(firstReal.map((e) => e.ts), [...firstReal.map((e) => e.ts)].sort((a, b) => b - a));
  const second = normalizeEvents(await nxhub.getEvents(pageQuery(firstReal, 10)));
  assert.ok(second.length, 'a second page exists');
  assert.ok(second[0].ts < oldestTs(firstReal), 'and it is strictly older');
  assert.equal(mergeEvents(firstReal, second).length, firstReal.length + second.length, 'no overlap');

  // The seed deliberately contains a markup-shaped summary.
  assert.ok(real.some((e) => /<img src=x/.test(e.summary)), 'the XSS row is seeded');
  dev.stop();
});
