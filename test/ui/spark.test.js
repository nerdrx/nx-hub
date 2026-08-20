// v0.10 [fabric2] — field history → sparklines.
//
// The geometry is pure arithmetic, so it is pinned exactly (coordinates, not
// "matches /polyline/"): a sparkline that is off by a pixel at the top of its
// own range is invisible in a screenshot and obvious in a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSample,
  normalizeHistory,
  normalizeHistories,
  sparkPoints,
  pointsAttr,
  sparkTitle,
  SPARK_W,
  SPARK_H,
  MAX_POINTS,
  REMOTE_MAX_POINTS,
} from '../../src/renderer/lib/sparkline.js';
import { renderSparkline } from '../../src/renderer/views/spark.js';
import { renderStatusStrip } from '../../src/renderer/views/status.js';
import { normalizeClient, normalizeConnector, historyFor, hasHistory } from '../../src/renderer/lib/connector.js';
import { createMock } from '../../src/renderer/mock.js';

/** The box the strip actually uses, so the numbers below mean something. */
const MID = 8; // (1.5 + 14.5) / 2
const LEFT = 1.5;
const RIGHT = 62.5; // 64 - 1.5

/* --------------------------------------------------------------- samples */

test('a sample survives every shape a hub could hand over', () => {
  assert.deepEqual(normalizeSample({ ts: 10, v: 3 }), { ts: 10, v: 3 });
  // The server module names it `value` internally; a hub that leaks that name
  // must not produce an empty chart.
  assert.deepEqual(normalizeSample({ ts: 10, value: 3 }), { ts: 10, v: 3 });
  // A flattened buffer of bare numbers still plots — it just has no time axis.
  assert.deepEqual(normalizeSample(7), { ts: 0, v: 7 });

  assert.equal(normalizeSample({ ts: 10, v: 'hot' }), null, 'a non-numeric value has nowhere to go');
  assert.equal(normalizeSample({ ts: 10, v: NaN }), null);
  assert.equal(normalizeSample(null), null);
  assert.equal(normalizeSample([1, 2]), null, 'an array is not a sample');
  assert.equal(normalizeSample('80'), null, 'a string is not a bare number');

  // A junk stamp keeps the sample and drops only the axis.
  assert.deepEqual(normalizeSample({ ts: 'yesterday', v: 5 }), { ts: 0, v: 5 });
  assert.deepEqual(normalizeSample({ ts: -4, v: 5 }), { ts: 0, v: 5 });
});

test('a series is cleaned, ordered and capped from the NEWEST end', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory('nope'), []);
  assert.deepEqual(normalizeHistory([{ v: 'x' }, null, 3]), [{ ts: 0, v: 3 }]);

  // Out of order but fully stamped → sorted.
  assert.deepEqual(
    normalizeHistory([
      { ts: 30, v: 3 },
      { ts: 10, v: 1 },
      { ts: 20, v: 2 },
    ]).map((s) => s.v),
    [1, 2, 3]
  );

  // A missing stamp anywhere means the order as sent is the only order we have.
  assert.deepEqual(
    normalizeHistory([
      { ts: 30, v: 3 },
      { v: 1 },
      { ts: 20, v: 2 },
    ]).map((s) => s.v),
    [3, 1, 2]
  );

  const long = Array.from({ length: 200 }, (_, i) => ({ ts: 1000 + i, v: i }));
  const capped = normalizeHistory(long);
  assert.equal(capped.length, MAX_POINTS);
  assert.equal(capped[capped.length - 1].v, 199, 'the newest sample survives');
  assert.equal(capped[0].v, 200 - MAX_POINTS, 'the oldest end is what gets dropped');

  assert.equal(normalizeHistory(long, { max: REMOTE_MAX_POINTS }).length, REMOTE_MAX_POINTS);
});

test('the history bag drops empty series and keeps app-supplied keys verbatim', () => {
  const out = normalizeHistories({
    hr: [{ ts: 1, v: 60 }],
    junk: [{ v: 'nope' }],
    '<b>x</b>': [{ ts: 1, v: 2 }],
    nope: 'not a series',
  });
  assert.deepEqual(Object.keys(out), ['hr', '<b>x</b>'], 'escaping is the renderer’s job, not this one’s');
  assert.deepEqual(normalizeHistories(null), {});
  assert.deepEqual(normalizeHistories([1, 2]), {}, 'an array is not a bag');
});

/* ------------------------------------------------------------- geometry */

test('a series is normalized to its OWN min and max', () => {
  const spark = sparkPoints([
    { ts: 1, v: 10 },
    { ts: 2, v: 20 },
    { ts: 3, v: 30 },
  ]);
  assert.equal(spark.count, 3);
  assert.equal(spark.min, 10);
  assert.equal(spark.max, 30);
  assert.equal(spark.first, 10);
  assert.equal(spark.last, 30);
  assert.equal(spark.flat, false);

  // y is inverted (SVG grows downward): the max sits at the top pad, the min at
  // the bottom pad, and the midpoint lands exactly between them.
  assert.deepEqual(spark.points, [
    [LEFT, 14.5],
    [32, MID],
    [RIGHT, 1.5],
  ]);

  // A wildly different magnitude produces the SAME shape — the line says how it
  // moved, never how big it is.
  const big = sparkPoints([
    { ts: 1, v: 10_000 },
    { ts: 2, v: 20_000 },
    { ts: 3, v: 30_000 },
  ]);
  assert.deepEqual(big.points, spark.points);
});

test('a value that has not moved draws a flat mid-line, not nothing', () => {
  const spark = sparkPoints([
    { ts: 1, v: 42 },
    { ts: 2, v: 42 },
    { ts: 3, v: 42 },
  ]);
  assert.equal(spark.flat, true);
  assert.deepEqual(
    spark.points.map((p) => p[1]),
    [MID, MID, MID]
  );
  assert.equal(spark.min, 42);
  assert.equal(spark.max, 42);

  // Zero is a value, not an absence.
  const zeros = sparkPoints([
    { ts: 1, v: 0 },
    { ts: 2, v: 0 },
  ]);
  assert.equal(zeros.flat, true);
  assert.deepEqual(zeros.points, [
    [LEFT, MID],
    [RIGHT, MID],
  ]);
});

test('a single sample degrades to a flat line across the whole box', () => {
  const spark = sparkPoints([{ ts: 1, v: 7 }]);
  assert.equal(spark.count, 1);
  assert.equal(spark.flat, true);
  assert.equal(spark.first, 7);
  assert.equal(spark.last, 7);
  assert.deepEqual(spark.points, [
    [LEFT, MID],
    [RIGHT, MID],
  ]);
});

test('nothing to draw is null, never an empty chart', () => {
  assert.equal(sparkPoints([]), null);
  assert.equal(sparkPoints(null), null);
  assert.equal(sparkPoints([{ v: 'x' }, null]), null);
});

test('downsampled input keeps its gaps: x follows time when time is usable', () => {
  // A thinned buffer: the old end is sparse, the recent end is dense. Spacing
  // these evenly would move the spike to the wrong place on the line.
  const spark = sparkPoints([
    { ts: 1000, v: 0 },
    { ts: 2000, v: 10 },
    { ts: 5000, v: 5 },
  ]);
  assert.deepEqual(
    spark.points.map((p) => p[0]),
    [1.5, 16.75, 62.5],
    'the middle sample sits a quarter of the way across, where its stamp puts it'
  );

  // No stamps at all → even spacing is the honest fallback.
  const even = sparkPoints([{ v: 0 }, { v: 10 }, { v: 5 }]);
  assert.deepEqual(
    even.points.map((p) => p[0]),
    [1.5, 32, 62.5]
  );

  // Identical stamps have no span either, and must not divide by zero.
  const same = sparkPoints([
    { ts: 7, v: 0 },
    { ts: 7, v: 10 },
  ]);
  assert.deepEqual(
    same.points.map((p) => p[0]),
    [1.5, 62.5]
  );
});

test('the box is configurable and the padding scales with it', () => {
  const spark = sparkPoints(
    [
      { ts: 1, v: 0 },
      { ts: 2, v: 1 },
    ],
    { width: 100, height: 40, pad: 0 }
  );
  assert.deepEqual(spark.points, [
    [0, 40],
    [100, 0],
  ]);
});

test('the points attribute is a plain SVG string', () => {
  assert.equal(
    pointsAttr([
      [1.5, 8],
      [62.5, 1.5],
    ]),
    '1.5,8 62.5,1.5'
  );
  assert.equal(pointsAttr(null), '');
  assert.equal(pointsAttr([[1, NaN], [2, 3]]), '2,3', 'a broken pair is dropped, not rendered as NaN');
});

test('the title says what the line shows, locale-independently', () => {
  const rising = sparkPoints([
    { ts: 1, v: 1 },
    { ts: 2, v: 2.345 },
  ]);
  assert.equal(sparkTitle(rising, 'Bitrate'), 'Bitrate — 1 to 2.35 over the last 2 samples');
  assert.equal(sparkTitle(sparkPoints([{ ts: 1, v: 5 }]), 'Heart rate'), 'Heart rate — steady over the last 1 sample');
  assert.equal(sparkTitle(null), '');
});

/* --------------------------------------------------------------- markup */

test('the sparkline renders as one small inline SVG and nothing else', () => {
  const out = renderSparkline(
    [
      { ts: 1, v: 10 },
      { ts: 2, v: 30 },
    ],
    { key: 'bitrate', label: 'Bitrate' }
  );
  assert.match(out, /<svg class="spark"/);
  assert.match(out, new RegExp(`width="${SPARK_W}"`));
  assert.match(out, new RegExp(`height="${SPARK_H}"`));
  assert.match(out, /viewBox="0 0 64 16"/);
  assert.match(out, /data-spark="bitrate"/);
  assert.match(out, /<polyline points="1\.5,14\.5 62\.5,1\.5" \/>/);
  assert.ok(!out.includes('<text'), 'no axes, no labels — the strip carries those');
  assert.ok(!out.includes('animate'), 'a chart that redraws twice a second must never animate');

  assert.match(renderSparkline([{ ts: 1, v: 4 }]), /class="spark spark-flat"/);
  assert.equal(renderSparkline([]), '', 'no history → no element at all');
  assert.equal(renderSparkline(null), '');
});

test('a field name full of markup cannot escape the sparkline', () => {
  const out = renderSparkline([{ ts: 1, v: 1 }], {
    key: '"><script>alert(1)</script>',
    label: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.match(out, /&lt;script&gt;/);
});

/* ---------------------------------------------------------- on the strip */

test('the status strip puts a sparkline beside every NUMERIC field only', () => {
  const client = normalizeClient({
    app: 'pulsenx',
    fields: { hr: 72, mode: 'resting', connected: true },
    history: {
      hr: [
        { ts: 1, v: 60 },
        { ts: 2, v: 72 },
      ],
      // A hub that sent a series for a text field does not get a chart for it.
      mode: [{ ts: 1, v: 3 }],
    },
  });
  const out = renderStatusStrip(client, [
    { key: 'hr', label: 'Heart rate', unit: 'bpm', kind: 'number' },
    { key: 'mode', label: 'Mode', kind: 'text' },
    { key: 'connected', label: 'Watch', kind: 'bool' },
  ]);

  assert.match(out, /data-spark="hr"/);
  assert.ok(!out.includes('data-spark="mode"'), 'text fields get no line');
  assert.equal(out.match(/<svg class="spark/g).length, 1, 'exactly one chart on this strip');
  // The reading itself is untouched — the number still leads.
  assert.match(out, /class="live-v live-num">72/);
  assert.match(out, /class="live-f has-spark"/);
});

test('a numeric field with no history renders exactly as it did before v0.10', () => {
  const client = normalizeClient({ app: 'x', fields: { hr: 72 } });
  const out = renderStatusStrip(client, [{ key: 'hr', label: 'HR', kind: 'number' }]);
  assert.ok(!out.includes('spark'), out);
  assert.match(out, />72</);
});

test('history rides through the whole normalize path, defensively', () => {
  const conn = normalizeConnector({
    clients: [{ app: 'pulsenx', fields: { hr: 1 }, history: { hr: [{ ts: 1, v: 1 }], junk: 'nope' } }, { app: 'bare' }],
  });
  assert.deepEqual(historyFor(conn.clients[0], 'hr'), [{ ts: 1, v: 1 }]);
  assert.deepEqual(historyFor(conn.clients[0], 'junk'), []);
  assert.deepEqual(historyFor(conn.clients[1], 'hr'), [], 'a client with no history is still a client');
  assert.deepEqual(historyFor(null, 'hr'), []);
  assert.equal(hasHistory(conn.clients[0]), true);
  assert.equal(hasHistory(conn.clients[1]), false);
});

/* ----------------------------------------------------------- mock bridge */

test('the mock streams histories that actually move', async () => {
  const { nxhub, dev } = createMock();
  const before = await nxhub.getState();
  const pulse = before.connector.clients.find((c) => c.app === 'pulsenx');
  assert.ok(pulse.history && Array.isArray(pulse.history.hr), 'the seeded client has a series');
  assert.ok(pulse.history.hr.length > 5, 'and enough of it to draw');
  assert.ok(!pulse.history.connected, 'booleans get no ring buffer');

  const seeded = pulse.history.hr.length;
  dev.tickBus();
  const after = await nxhub.getState();
  const grown = after.connector.clients.find((c) => c.app === 'pulsenx').history.hr;
  assert.equal(grown.length, seeded + 1, 'a tick appends exactly one sample');
  assert.ok(grown[grown.length - 1].ts >= grown[0].ts);
  dev.stop();
});
