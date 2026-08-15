import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConnector,
  normalizeClient,
  normalizeFieldDefs,
  formatFields,
  formatNumber,
  formatText,
  truthy,
  clientsByApp,
  clientFor,
  isPresent,
  captionFor,
} from '../../src/renderer/lib/connector.js';
import { renderStatusStrip, tileCaption } from '../../src/renderer/views/status.js';
import { renderAppCard } from '../../src/renderer/views/card.js';
import { renderTile, renderLaunchGrid } from '../../src/renderer/views/tile.js';
import { launchTiles } from '../../src/renderer/lib/launcher.js';
import { normalizeApp, normalizeState } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const PULSE_DEFS = [
  { key: 'hr', label: 'Heart rate', unit: 'bpm', kind: 'number' },
  { key: 'connected', label: 'Watch', kind: 'bool' },
];

const CLIENT = {
  app: 'pulsenx',
  version: '2.2.0',
  pid: 4021,
  since: '2026-08-16T00:00:00Z',
  lastSeen: '2026-08-16T00:05:00Z',
  fields: { hr: 72, connected: true },
};

/* --------------------------------------------------------------- normalize */

test('the bus roster survives every shape main could hand over', () => {
  assert.deepEqual(normalizeConnector(null), { clients: [] });
  assert.deepEqual(normalizeConnector({ clients: 'nope' }), { clients: [] });

  const out = normalizeConnector({
    clients: [
      { app: 'PulseNX', version: 1.2, pid: '4021', fields: { hr: 72 } },
      { app: 'no-fields' },
      { nothing: true },
      // a duplicate hello — the latest one wins, exactly like the bus
      { app: 'pulsenx', version: '2.0.0', fields: { hr: 80 } },
    ],
  });
  assert.deepEqual(out.clients.map((c) => c.app), ['pulsenx', 'no-fields']);
  assert.equal(out.clients[0].version, '2.0.0');
  assert.deepEqual(out.clients[0].fields, { hr: 80 });
  assert.deepEqual(out.clients[1].fields, {}, 'a client with no status is still present');

  const junk = normalizeClient({ pid: 'x', fields: ['a'] });
  assert.equal(junk.pid, 0);
  assert.deepEqual(junk.fields, {}, 'an array is not a field bag');
});

test('presence lookups are case-insensitive and never throw', () => {
  const connector = normalizeConnector({ clients: [CLIENT] });
  assert.equal(isPresent(connector, 'PulseNX'), true);
  assert.equal(isPresent(connector, 'wivrn-nx'), false);
  assert.equal(isPresent(null, 'pulsenx'), false);
  assert.equal(isPresent(connector, ''), false);
  assert.equal(clientFor(connector, 'pulsenx').version, '2.2.0');
  assert.equal(clientsByApp(connector).get('pulsenx').pid, 4021);
});

/* ------------------------------------------------------------- formatting */

test('numbers format locale-independently and text is clipped', () => {
  assert.equal(formatNumber(72), '72');
  assert.equal(formatNumber(43.006), '43.01');
  assert.equal(formatNumber(-0.5), '-0.5');
  assert.equal(formatNumber(1234567), '1234567', 'never a thousands separator');
  assert.equal(formatNumber('nope'), 'nope');
  assert.equal(formatText(null), '—');
  assert.equal(formatText('  two   words '), 'two words');
  assert.equal(formatText({ a: 1 }), '{"a":1}');
  assert.equal(formatText('x'.repeat(80)).length, 42);
  assert.match(formatText('x'.repeat(80)), /…$/);
});

test('bool coercion follows what apps actually send', () => {
  for (const v of [true, 1, 'true', 'YES', 'on', 'anything']) assert.equal(truthy(v), true, String(v));
  for (const v of [false, 0, '', 'false', 'off', 'no', '0', null, undefined]) {
    assert.equal(truthy(v), false, String(v));
  }
});

test('declared fields lead, unknown fields follow generically', () => {
  const fields = formatFields({ latency_ms: 43, hr: 72, connected: true }, PULSE_DEFS);
  assert.deepEqual(fields.map((f) => f.key), ['hr', 'connected', 'latency_ms']);

  const [hr, watch, latency] = fields;
  assert.equal(hr.label, 'Heart rate');
  assert.equal(hr.kind, 'number');
  assert.equal(hr.text, '72');
  assert.equal(hr.unit, 'bpm');
  assert.equal(hr.display, '72 bpm');

  assert.equal(watch.kind, 'bool');
  assert.equal(watch.on, true);
  assert.equal(watch.label, 'Watch');

  assert.equal(latency.label, 'latency_ms', 'an undeclared key IS the label');
  assert.equal(latency.kind, 'number');
  assert.equal(latency.unit, '');
  assert.equal(latency.display, '43');
});

test('the formatting matrix covers every value an app can send', () => {
  const fields = formatFields(
    { n: 3.14159, i: 12, b: false, s: 'streaming', nil: null, obj: { x: 1 }, arr: [1, 2] },
    [{ key: 'b', label: 'Bridge', kind: 'bool' }, { key: 'missing', label: 'Missing' }]
  );
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.ok(!byKey.missing, 'a declared field the client never sent is not invented');
  assert.equal(byKey.b.kind, 'bool');
  assert.equal(byKey.b.on, false);
  assert.equal(byKey.n.text, '3.14');
  assert.equal(byKey.i.kind, 'number');
  assert.equal(byKey.s.kind, 'text');
  assert.equal(byKey.nil.text, '—');
  assert.equal(byKey.obj.text, '{"x":1}');
  assert.equal(byKey.arr.text, '[1,2]');

  assert.equal(formatFields({ a: 1, b: 2, c: 3 }, [], { limit: 2 }).length, 2);
  assert.deepEqual(formatFields(null, null), []);
  assert.deepEqual(formatFields('nope', 'nope'), []);
});

test('a declared kind wins over the value it arrives as', () => {
  const [f] = formatFields({ connected: 1 }, [{ key: 'connected', label: 'Watch', kind: 'bool' }]);
  assert.equal(f.kind, 'bool');
  assert.equal(f.on, true);
  assert.deepEqual(normalizeFieldDefs([{ key: 'a', kind: 'nonsense' }, { key: 'a' }, {}]), [
    { key: 'a', label: 'a', unit: '', kind: '' },
  ]);
});

/* ------------------------------------------------------------- the strip */

test('the status strip carries a dot, a LIVE chip and formatted fields', () => {
  const out = renderStatusStrip(normalizeClient(CLIENT), PULSE_DEFS, { now: Date.parse('2026-08-16T00:05:00Z') });
  assert.match(out, /class="live"/);
  assert.match(out, /live-dot/);
  assert.match(out, />LIVE</);
  assert.match(out, /live-k">Heart rate</);
  assert.match(out, /live-v live-num">72<span class="live-u">bpm<\/span>/, out);
  assert.match(out, /live-b is-on/);
  assert.match(out, /pulsenx 2\.2\.0 · connected 5 min ago/);
  assert.equal(renderStatusStrip(null, PULSE_DEFS), '', 'no client → no strip');
});

test('a client with nothing to say still reads as connected', () => {
  const out = renderStatusStrip(normalizeClient({ app: 'x' }), null);
  assert.match(out, /live-none/);
  assert.match(out, /no status yet/);
});

test('bus data cannot inject markup — keys and values are both escaped', () => {
  const evil = normalizeClient({
    app: '<img src=x onerror=alert(1)>',
    version: '"><script>a</script>',
    fields: {
      '<script>k</script>': '<script>v</script>',
      ok: '"><img src=x onerror=alert(2)>',
    },
  });
  const out = renderStatusStrip(evil, [{ key: 'ok', label: '<b>label</b>', unit: '<i>u</i>' }]);
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img src=x'), out);
  assert.ok(!out.includes('<b>label</b>'));
  assert.match(out, /&lt;script&gt;k&lt;\/script&gt;/);

  // the same hostile payload through the card
  const app = normalizeApp({ id: 'evil', repo: 'o/evil', name: 'Evil', latest: { version: '1' }, artifacts: [] });
  const card = renderAppCard(app, { settings: {}, prefs: {}, clients: new Map([['evil', evil]]) });
  assert.ok(!card.includes('<script'));
  assert.ok(!card.includes('<img src=x'));
  assert.match(card, /&lt;img src=x/, 'the payload is visible as text, not as a tag');
  assert.ok(!/title="[^"]*"[^>]*onerror/.test(card), 'no attribute break-out either');
});

/* ------------------------------------------------------------ integration */

test('the card grows a strip only while the app is on the bus', () => {
  const app = normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    connectorFields: PULSE_DEFS,
    latest: { version: '2.3.0' },
    artifacts: [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage' }],
  });
  assert.deepEqual(app.connectorFields[0], { key: 'hr', label: 'Heart rate', unit: 'bpm', kind: 'number' });

  const off = renderAppCard(app, { settings: {}, prefs: {} });
  assert.ok(!off.includes('class="live"'));

  const on = renderAppCard(app, {
    settings: {},
    prefs: {},
    clients: new Map([['pulsenx', normalizeClient(CLIENT)]]),
  });
  assert.match(on, /class="live"/);
  assert.match(on, /Heart rate/);
});

test('a launcher tile gains a presence dot and the first field as a caption', () => {
  const apps = [
    normalizeApp({
      id: 'pulsenx',
      repo: 'nerdrx/pulsenx',
      name: 'PulseNX',
      connectorFields: PULSE_DEFS,
      latest: { version: '2.3.0' },
      artifacts: [
        { id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.2.0', path: '/x' } },
      ],
    }),
  ];
  const dark = launchTiles(apps, {});
  assert.equal(dark[0].live, false);
  assert.equal(renderTile(dark[0], {}).includes('tile-live'), false);

  const lit = launchTiles(apps, { clients: new Map([['pulsenx', normalizeClient(CLIENT)]]) });
  assert.equal(lit[0].live, true);
  assert.equal(lit[0].liveCaption, '72 bpm');
  const html = renderTile(lit[0], {});
  assert.match(html, /class="tile-live"/);
  assert.match(html, /tile-cap">72 bpm</);
  assert.match(html, /is live on the bus/);
});

test('the tile caption is the first field, bools included', () => {
  assert.equal(captionFor(null, PULSE_DEFS), '');
  assert.equal(tileCaption(normalizeClient(CLIENT), PULSE_DEFS), '72 bpm');
  assert.equal(
    tileCaption(normalizeClient({ app: 'x', fields: { connected: false } }), [
      { key: 'connected', label: 'Watch', kind: 'bool' },
    ]),
    'Watch off'
  );
  assert.equal(tileCaption(normalizeClient({ app: 'x', fields: {} }), []), '');
});

/* -------------------------------------------------------------- the mock */

test('normalizeState carries the bus roster through untouched', async () => {
  const { nxhub } = createMock();
  const state = normalizeState(await nxhub.getState());
  assert.equal(state.connector.clients.length, 2);
  const ids = state.connector.clients.map((c) => c.app).sort();
  assert.deepEqual(ids, ['pulsenx', 'wivrn-nx']);
  assert.deepEqual(state.connector.clients.find((c) => c.app === 'pulsenx').fields, { hr: 72, connected: true });
  assert.deepEqual(state.connector.clients.find((c) => c.app === 'wivrn-nx').fields, {
    bitrate: 98,
    latency_ms: 43,
  });

  // wivrn-nx declares one field and streams two — both paths in one card.
  const wivrn = state.apps.find((a) => a.id === 'wivrn-nx');
  assert.deepEqual(wivrn.connectorFields.map((f) => f.key), ['bitrate']);
  const strip = renderStatusStrip(
    state.connector.clients.find((c) => c.app === 'wivrn-nx'),
    wivrn.connectorFields
  );
  assert.match(strip, /live-k">Bitrate</);
  assert.match(strip, /live-v live-num">98<span class="live-u">Mbit\/s<\/span>/);
  assert.match(strip, /live-k">latency_ms</, 'the undeclared field renders generically');
  assert.match(strip, /live-v live-num">43<\/span>/, 'and without an invented unit');

  assert.deepEqual(await nxhub.getConnector(), await nxhub.getConnector());
});

test('the bus dev button drops a client and brings it back', async () => {
  const { nxhub, dev } = createMock();
  const seen = [];
  nxhub.onEvent((ev) => seen.push(ev.type));

  assert.equal(dev.toggleBusClient('pulsenx'), false, 'first toggle takes it off the bus');
  let connector = await nxhub.getConnector();
  assert.ok(!connector.clients.some((c) => c.app === 'pulsenx'));
  assert.ok(seen.includes('connector-changed'), 'the renderer is told to re-pull');

  assert.equal(dev.toggleBusClient('pulsenx'), true);
  connector = await nxhub.getConnector();
  assert.ok(connector.clients.some((c) => c.app === 'pulsenx'));

  // The values drift on a timer; every tick keeps them inside sane bounds.
  for (let i = 0; i < 40; i++) dev.tickBus();
  const wivrn = dev.tickBus().clients.find((c) => c.app === 'wivrn-nx');
  assert.ok(wivrn.fields.bitrate >= 12 && wivrn.fields.bitrate <= 150, String(wivrn.fields.bitrate));
  assert.ok(wivrn.fields.latency_ms >= 14 && wivrn.fields.latency_ms <= 120);
  assert.ok(Number.isInteger(wivrn.fields.bitrate), 'no fractional drift');
  assert.ok(!Number.isNaN(Date.parse(wivrn.lastSeen)));
  dev.stop();
});

test('the launch grid keeps working when the bridge has no stacks at all', () => {
  const out = renderLaunchGrid([], { canEditStacks: false });
  assert.match(out, /empty-launch/);
  assert.ok(!out.includes('tile-stack'));
});
