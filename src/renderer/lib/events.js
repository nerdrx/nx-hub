// The flight recorder, as the UI sees it (SPEC v0.8 [recorder]).
//
// getEvents({since, until, type, appId, limit}) answers newest-first with
// {ts (epoch ms), type, appId?, artifactId?, peerId?, stackId?, summary, data?}.
// Everything in this file is pure: normalizing that payload, mapping types to
// the brand palette, grouping by day and doing the paging arithmetic. No DOM,
// no bridge — so every rule below is unit-testable on its own.
//
// Two deliberate decisions live here:
//
//  1. `day` entries are dividers, not rows. The recorder may emit them; the UI
//     drops them and derives its own separators from `ts`, so a page that
//     starts mid-day still gets a header and a build whose recorder emits none
//     looks identical.
//  2. Filtering is done HERE, not on the bridge. The frozen query takes a
//     single `type`, while every chip but "Errors" is a type *set* — asking
//     the bridge per chip would need N round trips and would make the paging
//     cursor mean something different per chip. One unfiltered stream, sliced
//     locally, keeps `until` honest.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** SPEC caps a summary at 160 characters; a buggy recorder does not get to. */
export const SUMMARY_MAX = 160;

/** How many events one page asks for. */
export const PAGE_SIZE = 25;

/** Live re-pull debounce while the sheet is open. */
export const LIVE_DEBOUNCE_MS = 2000;

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * The filter chips, in bar order. `types: null` means "everything" — an empty
 * array would read as "nothing" and is never what All wants.
 *
 * Installs deliberately holds both job-done and update-available: from the
 * user's side those are one story ("something wanted to change on disk"), and
 * an update notice with no matching install is exactly the interesting case.
 */
export const EVENT_FILTERS = [
  { id: 'all', label: 'All', types: null },
  { id: 'installs', label: 'Installs', types: ['job-done', 'update-available'] },
  { id: 'errors', label: 'Errors', types: ['job-error'] },
  { id: 'bus', label: 'Bus', types: ['connector-join', 'connector-leave'] },
  { id: 'fleet', label: 'Fleet', types: ['fleet-progress'] },
  { id: 'stacks', label: 'Stacks', types: ['stack-progress'] },
  { id: 'watchdog', label: 'Watchdog', types: ['supervisor'] },
];

/** The type set behind one chip id; null = no filtering at all. */
export function filterTypes(id) {
  const f = EVENT_FILTERS.find((x) => x.id === id);
  return f ? f.types : null;
}

export function isFilterId(id) {
  return EVENT_FILTERS.some((f) => f.id === id);
}

/** Uppercase micro-label per type — the chip text, never the tone. */
const TYPE_CHIP = {
  'job-done': 'INSTALL',
  'job-error': 'ERROR',
  'update-available': 'UPDATE',
  'stack-progress': 'STACK',
  'connector-join': 'JOIN',
  'connector-leave': 'LEAVE',
  'fleet-progress': 'FLEET',
  supervisor: 'WATCHDOG',
};

/**
 * The chip label. An unknown type still gets a chip (uppercased, clipped)
 * rather than a blank column — a newer main process must not render as a hole.
 */
export function eventChip(event) {
  const type = str(event && event.type);
  if (TYPE_CHIP[type]) return TYPE_CHIP[type];
  return type.replace(/[-_]+/g, ' ').trim().toUpperCase().slice(0, 14) || 'EVENT';
}

/**
 * Tone, in the brand palette. DESIGN §1: red is danger only, amber means
 * "attention", cyan is a live property of the system, everything else is
 * inert. A watchdog that gave up is a failure; a watchdog that is retrying is
 * not, so the two supervisor actions land in different tones.
 */
export function eventTone(event) {
  const type = str(event && event.type);
  if (type === 'job-error') return 'danger';
  if (type === 'supervisor') {
    return supervisorAction(event) === 'gave-up' ? 'danger' : 'muted';
  }
  if (type === 'update-available') return 'amber';
  if (type === 'connector-join' || type === 'connector-leave') return 'cyan';
  return 'muted';
}

/** The supervisor action rides in `data` (frozen shape) — read it defensively. */
export function supervisorAction(event) {
  const d = (event && event.data) || {};
  const action = str(d.action || (event && event.action));
  return action === 'gave-up' || action === 'restarting' ? action : '';
}

export function normalizeEvent(event) {
  const e = event && typeof event === 'object' ? event : {};
  const ts = Number(e.ts);
  const summary = str(e.summary);
  return {
    ts: Number.isFinite(ts) ? ts : 0,
    type: str(e.type),
    appId: str(e.appId),
    artifactId: str(e.artifactId),
    peerId: str(e.peerId),
    stackId: str(e.stackId),
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    data: e.data && typeof e.data === 'object' ? e.data : null,
  };
}

/**
 * Normalize a page: junk dropped, `day` dividers dropped (we derive our own),
 * newest first. Entries without a usable timestamp are dropped too — they
 * cannot be placed on a timeline, and a 1970 divider is worse than a gap.
 */
export function normalizeEvents(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .filter(Boolean)
    .map(normalizeEvent)
    .filter((e) => e.type && e.type !== 'day' && e.ts > 0)
    .sort((a, b) => b.ts - a.ts);
}

/** Stable identity for de-duplication across overlapping pages. */
export function eventKey(event) {
  const e = event || {};
  return `${e.ts}|${e.type}|${e.appId || ''}|${e.artifactId || ''}|${e.summary || ''}`;
}

/**
 * Merge a freshly loaded page into what is already on screen. Used by both
 * paging (older events arrive at the bottom) and the live re-pull (newer ones
 * at the top), so it must be order-agnostic: dedupe, then re-sort.
 */
export function mergeEvents(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const e of [...(Array.isArray(existing) ? existing : []), ...normalizeEvents(incoming)]) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Oldest timestamp on screen — the cursor the next page lowers `until` to. */
export function oldestTs(events) {
  const list = Array.isArray(events) ? events : [];
  let min = 0;
  for (const e of list) {
    if (!e || !Number.isFinite(e.ts) || e.ts <= 0) continue;
    if (!min || e.ts < min) min = e.ts;
  }
  return min;
}

/**
 * The query for the next older page. `until` is the oldest ts already held —
 * the bridge may answer inclusively, and mergeEvents() absorbs the overlap.
 */
export function pageQuery(events, limit = PAGE_SIZE) {
  const until = oldestTs(events);
  return until ? { until, limit } : { limit };
}

/**
 * Is there more history behind this page? A page that added nothing new is the
 * end of the road no matter what it contained — that single rule survives a
 * bridge that answers inclusively, one that pads with dividers, and one that
 * returns fewer than `limit` while more remain.
 */
export function hasMore(beforeCount, afterCount, pageLength, limit = PAGE_SIZE) {
  if (afterCount <= beforeCount) return false;
  return pageLength >= limit;
}

export function eventsFor(events, filterId) {
  const types = filterTypes(filterId);
  const list = Array.isArray(events) ? events : [];
  if (!types) return list;
  const set = new Set(types);
  return list.filter((e) => e && set.has(e.type));
}

/* ------------------------------------------------------------------ clock */

function two(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * "14:32" — hand-formatted from the LOCAL clock. DESIGN §7: no
 * toLocaleTimeString anywhere in a logic path, because the host may be de_DE
 * and the UI language is English either way.
 */
export function formatClock(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Local calendar day, as a sortable key. */
export function dayKey(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** "Today" / "Yesterday" / "14 Aug 2026" — locale-independent, local clock. */
export function dayLabel(ts, now = Date.now()) {
  const key = dayKey(ts);
  if (!key) return '';
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(Number(now) - 86400000)) return 'Yesterday';
  const d = new Date(Number(ts));
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Group a newest-first list into day buckets, order preserved.
 * @returns {{key:string, label:string, events:object[]}[]}
 */
export function groupByDay(events, now = Date.now()) {
  const out = [];
  let current = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e) continue;
    const key = dayKey(e.ts);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(e.ts, now), events: [] };
      out.push(current);
    }
    current.events.push(e);
  }
  return out;
}

/** Empty-state copy — different when a chip is hiding everything. */
export function emptyText(filterId) {
  if (filterId && filterId !== 'all') {
    const f = EVENT_FILTERS.find((x) => x.id === filterId);
    return `Nothing under “${(f && f.label) || filterId}” yet.`;
  }
  return 'Nothing recorded yet. Installs, updates, errors and stack runs land here as they happen.';
}
