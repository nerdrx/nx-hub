// Sparkline geometry (SPEC v0.10 [fabric2] — field history → sparklines).
//
// connector/server.js keeps a ring buffer per client per NUMERIC field and hands
// it over on getClients() as `history: {field: [{ts, v}, ...]}` — downsampled to
// ≤60 points locally, ≤20 over the bus. This file turns one such series into
// coordinates and nothing else: no DOM, no markup, no colour. views/spark.js
// wraps the numbers in an <svg>; the two are split so every rule below is
// unit-testable without a renderer.
//
// Three decisions worth stating, because they are what the tests pin:
//
//  1. **Each sparkline normalizes to its OWN min/max.** A bitrate that lives at
//     98 and a latency that lives at 43 are not comparable, and a shared scale
//     would flatten one of them into the baseline. The sparkline says "how this
//     value is moving", never "how big it is" — the tabular label beside it is
//     what carries magnitude.
//  2. **A flat series is drawn, not skipped.** A value that has not moved is
//     information. It renders as a mid-height line, which is also what a single
//     sample degrades to — a lone dot would read as a rendering bug.
//  3. **X follows TIME when time is usable, index otherwise.** A downsampled
//     buffer is unevenly spaced on purpose (the old end is thinned); spacing the
//     points evenly would lie about when the spike happened. When the stamps are
//     missing, identical or junk, even spacing is the honest fallback.

/** The strip sparkline's box. Small enough to sit inside a 12px label line. */
export const SPARK_W = 64;
export const SPARK_H = 16;

/** Breathing room so a 1.5px stroke at the extremes is not clipped by the box. */
export const SPARK_PAD = 1.5;

/** SPEC's local cap. A longer series is thinned from the OLD end (newest wins). */
export const MAX_POINTS = 60;

/** SPEC's bus cap — what a peer's relayed roster may carry per field. */
export const REMOTE_MAX_POINTS = 20;

function round(n) {
  // Two decimals keeps the points attribute short without visible stair-stepping.
  return Math.round(n * 100) / 100;
}

/**
 * One raw sample → {ts, v} or null. Accepts the frozen `{ts, v}` shape, the
 * `{ts, value}` the server module names internally, and a bare number (a hub
 * that flattened its buffer). A non-finite VALUE is dropped: there is no honest
 * place to put a NaN on a line. A non-finite TS is kept as 0 — the sample is
 * still real, it just cannot carry the x axis.
 */
export function normalizeSample(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { ts: 0, v: raw } : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = Number(Object.prototype.hasOwnProperty.call(raw, 'v') ? raw.v : raw.value);
  if (!Number.isFinite(v)) return null;
  const ts = Number(raw.ts);
  return { ts: Number.isFinite(ts) && ts > 0 ? ts : 0, v };
}

/**
 * A field's series, defensively. Order is preserved as sent (the ring buffer is
 * chronological) unless every stamp is usable, in which case it is sorted —
 * a merged buffer from two sessions may arrive out of order.
 *
 * @param {*} raw the value under `history[field]`
 * @param {{max?:number}} opts
 * @returns {{ts:number, v:number}[]} oldest first, capped to `max` NEWEST points
 */
export function normalizeHistory(raw, opts = {}) {
  const max = Number.isFinite(Number(opts.max)) && Number(opts.max) > 0 ? Math.floor(Number(opts.max)) : MAX_POINTS;
  const list = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const s = normalizeSample(entry);
    if (s) list.push(s);
  }
  if (list.length > 1 && list.every((s) => s.ts > 0)) list.sort((a, b) => a.ts - b.ts);
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * The whole `history` bag of one client: `{field: [{ts, v}, ...]}` with every
 * key kept as sent (field names are app-supplied and are escaped at render
 * time, never here) and every empty series dropped.
 */
export function normalizeHistories(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const series = normalizeHistory(value, opts);
    if (series.length) out[key] = series;
  }
  return out;
}

/**
 * Coordinates for one series inside a `width × height` box.
 *
 * @param {Array} history already-normalized or raw samples
 * @param {{width?:number, height?:number, pad?:number, max?:number}} opts
 * @returns {null|{points:number[][], min:number, max:number, first:number,
 *                 last:number, flat:boolean, count:number}}
 *   null when there is nothing to draw at all.
 */
export function sparkPoints(history, opts = {}) {
  const width = Number(opts.width) > 0 ? Number(opts.width) : SPARK_W;
  const height = Number(opts.height) > 0 ? Number(opts.height) : SPARK_H;
  const pad = Number.isFinite(Number(opts.pad)) ? Number(opts.pad) : SPARK_PAD;
  const series = normalizeHistory(history, { max: opts.max });
  if (!series.length) return null;

  const values = series.map((s) => s.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = !(max > min);

  const x0 = pad;
  const x1 = Math.max(pad, width - pad);
  const y0 = pad;
  const y1 = Math.max(pad, height - pad);
  const mid = round((y0 + y1) / 2);
  const yFor = (v) => (flat ? mid : round(y1 - ((v - min) / (max - min)) * (y1 - y0)));

  // A single sample has no span in either axis: draw the flat line the pair of
  // edges gives, so the field reads as "steady" rather than as a missing chart.
  if (series.length === 1) {
    return {
      points: [
        [round(x0), mid],
        [round(x1), mid],
      ],
      min,
      max,
      first: values[0],
      last: values[0],
      flat: true,
      count: 1,
    };
  }

  const stamps = series.map((s) => s.ts);
  const tsUsable = stamps.every((t) => t > 0);
  const span = tsUsable ? stamps[stamps.length - 1] - stamps[0] : 0;
  const useTime = tsUsable && span > 0;
  const xFor = (i) =>
    useTime ? round(x0 + ((stamps[i] - stamps[0]) / span) * (x1 - x0)) : round(x0 + (i / (series.length - 1)) * (x1 - x0));

  return {
    points: series.map((s, i) => [xFor(i), yFor(s.v)]),
    min,
    max,
    first: values[0],
    last: values[values.length - 1],
    flat,
    count: series.length,
  };
}

/** `"1.5,8 33,2 62.5,14"` — the SVG polyline attribute. */
export function pointsAttr(points) {
  return (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => `${p[0]},${p[1]}`)
    .join(' ');
}

/**
 * The sparkline's accessible description. Locale-independent by construction —
 * DESIGN §7 bans toLocaleString in any logic path.
 */
export function sparkTitle(spark, label = '') {
  if (!spark) return '';
  const head = label ? `${label} — ` : '';
  if (spark.flat) return `${head}steady over the last ${spark.count} sample${spark.count === 1 ? '' : 's'}`;
  return `${head}${formatValue(spark.min)} to ${formatValue(spark.max)} over the last ${spark.count} samples`;
}

/** Shared with lib/connector.js's rule: integers bare, everything else 2dp. */
function formatValue(n) {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
