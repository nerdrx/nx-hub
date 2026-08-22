// v0.11 "stop" — the button, as the UI sees it.
//
// The rule under test is one sentence from SPEC: wherever the UI says an app is
// live it must also offer to end it. That means four surfaces, not one — the
// card's LIVE strip, a peer-tagged remote strip, a launcher tile, and the case
// a bus-only design forgets: an app the hub LAUNCHED that never joined the bus.
// It has a pid and no strip, and without an affordance of its own there is no
// way back from pressing Launch.
//
// Everything named here is somebody else's string. An app id and an app name
// come off the bus or out of a peer's roster; a peer name is a hostname another
// person typed. The escaping tests are the threat model, not decoration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRunning,
  normalizeRunningRow,
  runningFor,
  runningMap,
  runningByApp,
  stopKey,
  isStopping,
  prunePending,
  stopOutcome,
  stopOptions,
  STOP_TIMEOUT_MS,
} from '../../src/renderer/lib/running.js';
import { renderStopControl, renderStripStop, stopTitle } from '../../src/renderer/views/stop.js';
import { renderStatusStrip, renderRemoteStrips, renderRunningStrip } from '../../src/renderer/views/status.js';
import { renderAppCard } from '../../src/renderer/views/card.js';
import { renderTile, renderLaunchGrid } from '../../src/renderer/views/tile.js';
import { launchTiles } from '../../src/renderer/lib/launcher.js';
import { renderFleetSheet } from '../../src/renderer/views/fleet.js';
import { normalizeState } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const since = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();

const APP = {
  id: 'wivrn-nx',
  name: 'WiVRn NX',
  repo: 'nerdrx/wivrn-nx',
  connectorFields: [{ key: 'bitrate', label: 'Bitrate', unit: 'Mbit/s', kind: 'number' }],
  latest: { version: '1.9.2', tag: 'v1.9.2', publishedAt: since(4000) },
  artifacts: [
    {
      id: 'tarball-prefix-linux',
      label: 'Linux server',
      platform: 'linux',
      kind: 'tarball-prefix',
      launchable: true,
      installed: { version: '1.9.2', path: '/home/x/.local', installedAt: since(4000) },
    },
  ],
};

const CLIENT = {
  app: 'wivrn-nx',
  version: '1.9.2',
  pid: 40877,
  since: since(8),
  fields: { bitrate: 98 },
  history: {},
};

const ROW = {
  appId: 'wivrn-nx',
  appName: 'WiVRn NX',
  artifactId: 'tarball-prefix-linux',
  version: '1.9.2',
  pid: 40877,
  since: since(8),
  source: 'both',
  canStop: true,
};

const cardCtx = (over = {}) => ({
  now: NOW,
  settings: {},
  clients: new Map([['wivrn-nx', CLIENT]]),
  running: new Map([['wivrn-nx', ROW]]),
  stopping: new Map(),
  caps: {},
  ...over,
});

/* ------------------------------------------------------------- the roster */

test('a running row survives every shape a hub could send', () => {
  const rows = normalizeRunning([
    { appId: 'WiVRn-NX', appName: 'WiVRn NX', artifactId: 'tarball-prefix-linux', pid: '40877', since: since(8), source: 'both' },
    { app: 'pulsenx', pid: 40211, source: 'bus' },
    // Junk that must not become a row with a Stop button on it.
    null,
    'nope',
    {},
    { appId: '   ' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].appId, 'wivrn-nx', 'ids are lowercased like the bus does');
  assert.equal(rows[0].pid, 40877, 'a string pid is still a pid');
  assert.equal(rows[1].appId, 'pulsenx', '`app` is accepted as well as `appId`');
  assert.equal(rows[1].appName, 'pulsenx', 'a nameless row falls back to its id');
  assert.equal(rows[1].artifactId, null, 'null, not "" — the hub genuinely does not know');
});

test('canStop is the backend’s verdict, and derived the same way when absent', () => {
  assert.equal(normalizeRunningRow({ appId: 'a', pid: 5, canStop: false }).canStop, false, 'an explicit no wins');
  assert.equal(normalizeRunningRow({ appId: 'a', pid: 5 }).canStop, true, 'a live pid is a handle');
  assert.equal(normalizeRunningRow({ appId: 'a', source: 'bus' }).canStop, true, 'so is bus presence');
  assert.equal(
    normalizeRunningRow({ appId: 'a', source: 'hub' }).canStop,
    false,
    'neither pid nor bus → nothing to signal'
  );
  assert.equal(normalizeRunningRow({ appId: 'a', pid: -3 }).canStop, false, 'a nonsense pid is no pid');
  assert.equal(normalizeRunningRow({ appId: 'a', source: 'sideways' }).source, 'hub', 'an unknown source is not trusted');
});

test('one row per app+artifact, and the row a card should speak for', () => {
  const rows = normalizeRunning([
    { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', pid: 1 },
    { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', pid: 2 },
    { appId: 'wivrn-nx', artifactId: 'apk-adb-android', pid: 3 },
    { appId: 'pulsenx', pid: 4 },
  ]);
  assert.equal(rows.length, 3, 'the duplicate collapsed');
  assert.equal(runningFor(rows, 'wivrn-nx', 'apk-adb-android').pid, 3, 'an exact artifact match wins');
  assert.equal(runningFor(rows, 'pulsenx', 'appimage-linux').pid, 4, 'a row with no artifact stands in');
  assert.equal(runningFor(rows, 'nothing', 'x'), null);
  assert.equal(runningFor(rows, '', ''), null);
  assert.equal(runningByApp(rows).get('wivrn-nx').length, 2);
  assert.equal(runningMap(rows).get('pulsenx').pid, 4);
});

test('getState().running reaches the renderer, and its absence is an empty array', () => {
  assert.deepEqual(normalizeState({}).running, [], 'a hub one version behind knows of no processes');
  assert.deepEqual(normalizeState(null).running, []);
  assert.equal(normalizeState({ running: [{ appId: 'pulsenx', pid: 9 }] }).running[0].appId, 'pulsenx');
  assert.equal(normalizeState({ running: 'nonsense' }).running.length, 0);
});

/* -------------------------------------------------------- the control itself */

test('the control is a ghost button carrying app, artifact and an accessible name', () => {
  const html = renderStopControl({ appId: 'wivrn-nx', appName: 'WiVRn NX', artifactId: 'tarball-prefix-linux' });
  assert.match(html, /data-act="stop-app"/);
  assert.match(html, /data-app="wivrn-nx"/);
  assert.match(html, /data-art="tarball-prefix-linux"/);
  assert.match(html, /aria-label="Stop WiVRn NX"/, 'a screen reader hears which app');
  assert.match(html, /class="[^"]*btn-ghost[^"]*"/, 'ghost — stopping is a normal action');
  assert.ok(!/btn-danger|danger|--danger|btn-violet|btn-amber/.test(html), `never red, never loud: ${html}`);
  assert.ok(!html.includes('disabled'), 'and clickable');
  assert.equal(renderStopControl({ appName: 'x' }), '', 'no app id, no button');
});

test('a peer-tagged control says where it acts and stops through that peer', () => {
  const html = renderStopControl({
    appId: 'wivrn-nx-windows',
    appName: 'WiVRn NX for SteamVR',
    artifactId: 'windows-zip-windows',
    peerName: 'NX-WIN',
    peerId: 'c0ffee11deadbeef',
  });
  assert.match(html, /data-peer="c0ffee11deadbeef"/);
  assert.match(html, /title="Stop WiVRn NX for SteamVR on NX-WIN"/, 'the tooltip names the machine');
  assert.match(html, /data-art=""/, 'this hub’s artifact id means nothing over there');
  assert.equal(stopTitle('App', 'NX-WIN', true), 'Stopping App on NX-WIN…');
  assert.equal(stopTitle('', '', false), 'Stop this app');
});

test('a pending control says "Stopping…", disables itself and refuses to be red', () => {
  const html = renderStopControl({ appId: 'pulsenx', appName: 'PulseNX' }, { pending: true });
  assert.match(html, /Stopping…/, 'the ladder can take 2.5s — the button says so');
  assert.match(html, /\bdisabled\b/, 'and takes no second click');
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Stopping PulseNX…"/);
  assert.match(html, /is-stopping/);
});

test('every name that reaches the control is escaped', () => {
  const html = renderStopControl({
    appId: '"><img src=x onerror=alert(1)>',
    appName: '<b>Hostile</b>',
    artifactId: '"><script>alert(2)</script>',
    peerName: '<i>peer</i>',
    peerId: '" onmouseover="alert(3)',
  });
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('<b>'), html);
  assert.match(html, /&lt;b&gt;Hostile&lt;\/b&gt;/, 'the hostile name renders as text');
  // The payloads DO still read as "…onerror=…" — as escaped text inside a
  // quoted attribute, which is the point. What must not survive is the quote
  // that would end the attribute and start a new one.
  assert.match(html, /data-app="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/, html);
  assert.match(html, /data-peer="&quot; onmouseover=&quot;alert\(3\)"/, html);
  // Every attribute in the tag closes where it should: no stray bare quote.
  const tag = html.slice(0, html.indexOf('>') + 1);
  assert.equal(
    (tag.match(/"/g) || []).length % 2,
    0,
    `the payload never broke out of its attribute: ${tag}`
  );
});

/* ------------------------------------------------------ the rendering matrix */

test('the card’s LIVE strip ends in a Stop', () => {
  const html = renderAppCard(APP, cardCtx());
  assert.match(html, /class="live"/, 'the strip is there');
  const strip = html.slice(html.indexOf('class="live"'), html.indexOf('</div>', html.indexOf('class="live"')));
  assert.match(strip, /class="live-stop"/, 'and the control sits inside it, pushed right');
  assert.match(strip, /data-act="stop-app"/);
  assert.match(strip, /data-app="wivrn-nx"/);
  assert.match(strip, /data-art="tarball-prefix-linux"/, 'with the artifact the hub actually launched');
});

test('a remote strip stops through its peer, and only through its peer', () => {
  const html = renderAppCard(APP, {
    ...cardCtx({ clients: new Map(), running: new Map() }),
    remote: new Map([
      ['wivrn-nx', [{ peerId: 'c0ffee11deadbeef', peerName: 'NX-WIN', client: CLIENT }]],
    ]),
  });
  assert.match(html, /class="live live-remote"/);
  assert.match(html, /data-peer="c0ffee11deadbeef"/, 'the stop is addressed to that hub');
  assert.match(html, /Stop WiVRn NX on NX-WIN/);
  assert.ok(!/data-act="stop-app"[^>]*data-art="tarball/.test(html), 'and carries no local artifact id');
});

test('an app the hub launched but that never joined the bus is still stoppable', () => {
  const row = { ...ROW, source: 'hub', pid: 41522 };
  const html = renderAppCard(APP, cardCtx({ clients: new Map(), running: new Map([['wivrn-nx', row]]) }));
  assert.ok(!html.includes('class="live"'), 'no LIVE strip — it is streaming nothing');
  assert.match(html, /class="run"/, 'but it does not go unmentioned');
  assert.match(html, /data-running="wivrn-nx"/);
  assert.match(html, />RUNNING</, 'a muted chip, not a cyan one');
  assert.match(html, /started 8 min ago/, 'and how long it has been up');
  assert.match(html, /data-act="stop-app"/, 'carrying the same Stop');
  assert.match(html, /pid 41522/, 'the tooltip says what the hub is holding');
});

test('a card that is live keeps ONE strip — the quiet one is for silence only', () => {
  const html = renderAppCard(APP, cardCtx());
  assert.ok(!html.includes('class="run"'), 'no doubled-up running strip under a LIVE one');
  assert.equal((html.match(/data-act="stop-app"/g) || []).length, 1, 'and exactly one Stop');
});

test('a launcher tile gets its own Stop, and the tile’s main click stays launch', () => {
  const [tile] = launchTiles([APP], { clients: new Map([['wivrn-nx', CLIENT]]) });
  const html = renderTile(tile, { caps: {}, stopping: new Map() });
  assert.match(html, /class="tile-hit" data-act="tile-launch"/, 'the hit target still launches');
  assert.match(html, /class="[^"]*tile-stop[^"]*"[^>]*data-act="stop-app"/, 'and the stop is its own control');
  // The stop must be a SIBLING of the hit target: nested, every stop would be a
  // mis-click away from a relaunch (and invalid HTML besides).
  const hit = html.indexOf('class="tile-hit"');
  const hitEnd = html.indexOf('</button>', hit);
  assert.ok(html.indexOf('data-act="stop-app"') > hitEnd, 'the stop is outside the launch button');
});

test('a tile’s Stop is reachable from the keyboard — unlike the ⋮ beside it', () => {
  const [tile] = launchTiles([APP], { clients: new Map([['wivrn-nx', CLIENT]]) });
  const html = renderTile(tile, { caps: {} });
  const stop = html.slice(html.indexOf('data-act="stop-app"'));
  const button = stop.slice(0, stop.indexOf('</button>'));
  assert.ok(!button.includes('tabindex'), `the stop stays in the tab order: ${button}`);
  assert.match(button, /aria-label="Stop WiVRn NX"/, 'and announces itself');
  assert.match(html, /class="btn btn-icon tile-dots"[^>]*tabindex="-1"/, 'the ⋮ is still skipped, as before');
});

test('a hub-launched tile shows a muted dot and a Stop without ever claiming LIVE', () => {
  const running = [{ appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', pid: 41522, source: 'hub', canStop: true }];
  const [tile] = launchTiles([APP], { clients: new Map(), running });
  assert.equal(tile.live, false, 'nothing is on the bus');
  assert.equal(tile.running, true, 'but something is running');
  const html = renderTile(tile, { caps: {} });
  assert.ok(!html.includes('class="tile-live"'), 'the cyan presence dot is for bus values');
  assert.match(html, /class="tile-running"/, 'the muted one says the rest');
  assert.match(html, /data-act="stop-app"/);
  assert.match(html, /not reporting on the bus/, 'and the tooltip is honest about why it is quiet');
});

test('a row the backend cannot stop is a stale launch record, not a running app', () => {
  // canStop:false means neither a live pid nor bus presence — SPEC's own
  // definition of "not running". Drawing RUNNING for it would be a lie, and a
  // Stop button on it would be one the hub cannot honour.
  const row = { ...ROW, canStop: false, pid: null, source: 'hub' };
  const card = renderAppCard(APP, cardCtx({ clients: new Map(), running: new Map([['wivrn-nx', row]]) }));
  assert.ok(!card.includes('data-act="stop-app"'), 'the hub has no handle on that process');
  assert.ok(!card.includes('class="run"'), 'and does not claim it is up');

  const [tile] = launchTiles([APP], { clients: new Map(), running: [row] });
  assert.equal(tile.running, false);
  const html = renderTile(tile, { caps: {} });
  assert.ok(!html.includes('data-act="stop-app"'));
  assert.ok(!html.includes('class="tile-running"'));
});

test('a since off the real bridge is an epoch number, and still reads as a time', () => {
  const row = normalizeRunningRow({ appId: 'wivrn-nx', pid: 4, since: NOW - 3 * 60000, source: 'hub' });
  assert.equal(typeof row.since, 'number', 'a launch record times in epoch ms — keep it that way');
  assert.match(renderRunningStrip(row, { now: NOW, appName: 'WiVRn NX' }), /started 3 min ago/);
  // …and an ISO string off the bus reads the same.
  const iso = normalizeRunningRow({ appId: 'wivrn-nx', pid: 4, since: since(3), source: 'hub' });
  assert.match(renderRunningStrip(iso, { now: NOW }), /started 3 min ago/);
  // A row with no start time at all still says what it is.
  const none = normalizeRunningRow({ appId: 'wivrn-nx', pid: 4, since: null, version: null, source: 'hub' });
  assert.equal(none.version, '', 'a null version is no version');
  assert.match(renderRunningStrip(none, { now: NOW }), /started by the hub/);
});

test('a build whose bridge has no stopApp renders no stop control at all', () => {
  // This is exactly what the caps probe writes for a missing method.
  const caps = { stopApp: false };
  const card = renderAppCard(APP, cardCtx({ caps }));
  assert.match(card, /class="live"/, 'the strip is untouched');
  assert.ok(!card.includes('data-act="stop-app"'), 'and carries no button that could not work');
  assert.ok(!card.includes('live-stop'));

  const silent = renderAppCard(APP, cardCtx({ caps, clients: new Map() }));
  assert.match(silent, /class="run"/, 'the quiet strip still reports the truth');
  assert.ok(!silent.includes('data-act="stop-app"'), 'it just cannot offer an ending');

  const [tile] = launchTiles([APP], { clients: new Map([['wivrn-nx', CLIENT]]) });
  const grid = renderLaunchGrid([tile], { caps });
  assert.match(grid, /class="tile-live"/, 'presence is still shown');
  assert.ok(!grid.includes('data-act="stop-app"'));

  assert.equal(stopOptions(APP, null, { caps }), null, 'and the bundle itself is absent');
});

test('the fleet sheet’s "Live there" strips offer the ending too', () => {
  const peers = [{ id: 'c0ffee11deadbeef', name: 'NX-WIN', online: true, host: '192.168.1.50', apps: [] }];
  const remote = new Map([['c0ffee11deadbeef', [CLIENT]]]);
  const sheet = renderFleetSheet({ peers, apps: [APP], remote, now: NOW, caps: {}, stopping: new Map() });
  assert.match(sheet, /class="peer-bus"/, 'the relayed roster is there');
  assert.match(sheet, /data-act="stop-app"[^>]*data-peer="c0ffee11deadbeef"/, 'and says LIVE, so it says Stop');
  assert.match(sheet, /Stop WiVRn NX on NX-WIN/);

  const capless = renderFleetSheet({ peers, apps: [APP], remote, now: NOW, caps: { stopApp: false } });
  assert.match(capless, /class="peer-bus"/, 'the roster still renders');
  assert.ok(!capless.includes('data-act="stop-app"'), 'without a button this build cannot honour');

  // An app relayed from a hub that this one has never heard of still gets a
  // usable label rather than "undefined".
  const stranger = renderFleetSheet({
    peers,
    apps: [],
    remote: new Map([['c0ffee11deadbeef', [{ ...CLIENT, app: 'never-seen' }]]]),
    now: NOW,
    caps: {},
  });
  assert.match(stranger, /Stop never-seen on NX-WIN/);
});

test('a dev tile has no Stop — devRun starts a checkout, not a tracked app', () => {
  const tile = {
    key: 'dev::nx-sandbox',
    appId: 'nx-sandbox',
    artifactId: '',
    name: 'NX Sandbox',
    monogram: 'NS',
    dev: true,
    live: true,
    path: '/home/x/code/nx-sandbox',
    title: 'Run NX Sandbox',
  };
  assert.ok(!renderTile(tile, { caps: {} }).includes('data-act="stop-app"'));
});

/* ---------------------------------------------------------- pending / resolve */

test('the pending set is keyed per app, artifact AND peer', () => {
  const local = stopKey('wivrn-nx', 'tarball-prefix-linux', '');
  const remote = stopKey('wivrn-nx', '', 'c0ffee11deadbeef');
  assert.notEqual(local, remote, 'stopping it here must not grey out the button over there');
  assert.equal(isStopping(new Set([local]), local), true);
  assert.equal(isStopping([remote], remote), true, 'an array works too');
  assert.equal(isStopping({ [local]: true }, local), true, 'and a plain object');
  assert.equal(isStopping(null, local), false);
  assert.equal(isStopping(new Set([local]), ''), false);
});

test('a strip whose stop is in flight disables its own control only', () => {
  const pending = new Set([stopKey('wivrn-nx', 'tarball-prefix-linux', '')]);
  const html = renderStatusStrip(CLIENT, APP.connectorFields, {
    now: NOW,
    stop: { appName: 'WiVRn NX', artifactId: 'tarball-prefix-linux', pending },
  });
  assert.match(html, /Stopping…/);
  assert.match(html, /\bdisabled\b/);

  // The same app on a peer is a different process and a different button.
  const remote = renderRemoteStrips([{ peerId: 'c0ffee11deadbeef', peerName: 'NX-WIN', client: CLIENT }], APP.connectorFields, {
    now: NOW,
    stop: { appName: 'WiVRn NX', artifactId: 'tarball-prefix-linux', pending },
  });
  assert.ok(!remote.includes('Stopping…'), 'the peer’s button is untouched');
  assert.match(remote, />Stop</);
});

test('presence dropping is what ends the pending state', () => {
  const key = stopKey('wivrn-nx', 'tarball-prefix-linux', '');
  const entry = { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', peer: '', at: NOW };
  const pending = new Map([[key, entry]]);

  const stillThere = prunePending(pending, {
    running: [ROW],
    clients: new Map([['wivrn-nx', CLIENT]]),
    now: NOW + 500,
  });
  assert.equal(stillThere.size, 1, 'the ladder is still walking');

  const gone = prunePending(pending, { running: [], clients: new Map(), now: NOW + 500 });
  assert.equal(gone.size, 0, 'the app left — the control resolves');

  // A pid-only app resolves off the roster alone: it was never on the bus.
  const silent = prunePending(pending, {
    running: [{ ...ROW, source: 'hub' }],
    clients: new Map(),
    now: NOW + 500,
  });
  assert.equal(silent.size, 1, 'still in the roster, still stopping');

  // The age cap is a floor, not the mechanism: a bridge that never answers must
  // not wedge a control at "Stopping…" forever.
  const stale = prunePending(pending, {
    running: [ROW],
    clients: new Map([['wivrn-nx', CLIENT]]),
    now: NOW + STOP_TIMEOUT_MS + 1,
  });
  assert.equal(stale.size, 0, 'the button comes back');

  assert.equal(prunePending(null, {}).size, 0, 'and junk in is an empty map out');
  assert.equal(prunePending(new Map([['k', 'nonsense']]), { now: NOW }).size, 0);
});

test('a remote pending stop resolves when that peer stops relaying it', () => {
  const key = stopKey('wivrn-nx', '', 'c0ffee11deadbeef');
  const pending = new Map([[key, { appId: 'wivrn-nx', artifactId: '', peer: 'c0ffee11deadbeef', at: NOW }]]);
  const relaying = new Map([['wivrn-nx', [{ peerId: 'c0ffee11deadbeef', peerName: 'NX-WIN', client: CLIENT }]]]);
  assert.equal(prunePending(pending, { remote: relaying, now: NOW + 100 }).size, 1);
  // Another hub relaying the same app is NOT this one answering.
  const elsewhere = new Map([['wivrn-nx', [{ peerId: 'a1b2c3d4e5f60718', peerName: 'workshop-pc', client: CLIENT }]]]);
  assert.equal(prunePending(pending, { remote: elsewhere, now: NOW + 100 }).size, 0);
  assert.equal(prunePending(pending, { remote: new Map(), now: NOW + 100 }).size, 0);
});

/* ------------------------------------------------------------ what to say */

test('"gone" and "not-running" fold quietly — the app died on its own', () => {
  for (const how of ['gone', 'not-running']) {
    const out = stopOutcome({ ok: how === 'gone', how }, 'WiVRn NX');
    assert.equal(out.quiet, true, `${how} is a success, not an error toast`);
    assert.equal(out.message, '');
  }
  for (const how of ['shutdown-request', 'sigterm', 'remote']) {
    assert.equal(stopOutcome({ ok: true, how }, 'WiVRn NX').quiet, true, `${how} needs no announcement`);
  }
  const failed = stopOutcome({ ok: false, how: 'sigterm' }, 'WiVRn NX');
  assert.equal(failed.quiet, false, 'a process that outlived SIGTERM is worth saying out loud');
  assert.equal(failed.level, 'error');
  assert.match(failed.message, /still running/);
  assert.match(failed.message, /Close it from its own window/, 'and says what to do next');
  assert.equal(stopOutcome(null, 'x').quiet, true, 'a missing bridge already said its piece');
  assert.equal(stopOutcome(undefined, 'x').quiet, true);
  assert.match(stopOutcome({ ok: false }, '').message, /the app/, 'a nameless app still gets a sentence');
});

/* ----------------------------------------------------------------- the mock */

test('the mock roster carries all three sources at once', async () => {
  const { nxhub, dev } = createMock();
  const running = (await nxhub.getState()).running;
  const by = new Map(running.map((r) => [r.appId, r]));
  assert.equal(by.get('pulsenx').source, 'both', 'launched here and on the bus');
  assert.equal(by.get('wivrn-nx').source, 'bus', 'on the bus only');
  assert.equal(by.get('wivrn-nx').artifactId, null, 'so the hub cannot name its build');
  assert.equal(by.get('oscgoesbrrr-nx-patches').source, 'hub', 'launched here and silent');
  assert.ok(by.get('oscgoesbrrr-nx-patches').pid > 0, 'with a real pid to signal');
  assert.equal(
    running.every((r) => r.canStop),
    true
  );
  dev.stop();
});

test('the mock walks the whole ladder: polite, stubborn, silent, gone, remote', async () => {
  const { nxhub, dev } = createMock();
  await nxhub.getState();

  // 1. asks nicely, and the client leaves.
  const polite = await nxhub.stopApp('pulsenx', 'appimage-linux');
  assert.deepEqual(
    { ok: polite.ok, how: polite.how },
    { ok: true, how: 'shutdown-request' },
    'the app took the hint'
  );
  assert.ok(!(await nxhub.getState()).running.some((r) => r.appId === 'pulsenx'), 'and left the roster');

  // 2. ignores the request; the hub waits, then signals. Never SIGKILL.
  const stubborn = await nxhub.stopApp('wivrn-nx');
  assert.equal(stubborn.how, 'sigterm', 'the fall-through happened');
  assert.equal(stubborn.pid, 40877, 'to the pid it reported at hello');

  // 3. no bus at all — straight to the signal.
  const silent = await nxhub.stopApp('oscgoesbrrr-nx-patches', 'appimage-linux');
  assert.equal(silent.how, 'sigterm');
  assert.equal((await nxhub.getState()).running.length, 0, 'the roster is empty now');

  // 4. nothing left to stop.
  assert.deepEqual(
    await nxhub.stopApp('pulsenx'),
    { ok: false, how: 'not-running', pid: null, appId: 'pulsenx' }
  );
  assert.equal((await nxhub.stopApp('')).ok, false, 'and a nameless stop does nothing');
  dev.stop();
});

test('the mock can be armed to find the process already gone', async () => {
  const { nxhub, dev } = createMock();
  dev.armGoneStop('oscgoesbrrr-nx-patches');
  const res = await nxhub.stopApp('oscgoesbrrr-nx-patches', 'appimage-linux');
  assert.equal(res.how, 'gone');
  assert.equal(res.ok, true, 'gone is a success');
  assert.equal(stopOutcome(res, 'OGB NX-Patches').quiet, true, 'so the UI says nothing');
  assert.ok(!(await nxhub.getState()).running.some((r) => r.appId === 'oscgoesbrrr-nx-patches'));
  dev.stop();
});

test('the mock stops a remote app through its peer, and it stays stopped', async () => {
  const { nxhub, dev } = createMock();
  const before = await nxhub.getState();
  const peer = (before.connector.remote || []).find((p) => p.peerId === 'a1b2c3d4e5f60718');
  assert.ok(peer && peer.clients.some((c) => c.app === 'oscgoesbrrr-nx-patches'), 'workshop-pc is relaying it');

  const res = await nxhub.stopApp('oscgoesbrrr-nx-patches', undefined, { peer: 'a1b2c3d4e5f60718' });
  assert.equal(res.how, 'remote', 'only the peer can reach that process');

  const after = await nxhub.getState();
  const roster = (after.connector.remote || []).find((p) => p.peerId === 'a1b2c3d4e5f60718');
  assert.ok(!(roster ? roster.clients : []).some((c) => c.app === 'oscgoesbrrr-nx-patches'), 'it left the peer’s bus');
  // The local pid is untouched: this hub stopped the copy over there.
  assert.ok(after.running.some((r) => r.appId === 'oscgoesbrrr-nx-patches'), 'and the local one is still running');

  dev.restoreRemoteRun();
  assert.ok(
    ((await nxhub.getState()).connector.remote.find((p) => p.peerId === 'a1b2c3d4e5f60718') || { clients: [] }).clients
      .length > 0,
    'the toolbar can hand it back'
  );
  dev.stop();
});

test('the mock can give an app a hub pid without a bus client, and take it away', async () => {
  const { nxhub, dev } = createMock();
  assert.equal(dev.toggleHubRun('quadforge'), true, 'now it is running');
  let row = (await nxhub.getState()).running.find((r) => r.appId === 'quadforge');
  assert.ok(row, 'the roster picked it up');
  assert.equal(row.source, 'hub', 'silent, but running');
  assert.equal(dev.toggleHubRun('quadforge'), false);
  row = (await nxhub.getState()).running.find((r) => r.appId === 'quadforge');
  assert.equal(row, undefined);
  dev.stop();
});

/* ------------------------------------------- the whole card, from mock state */

test('the mock’s own state renders a Stop on every surface that claims presence', async () => {
  const { nxhub, dev } = createMock();
  const state = normalizeState(await nxhub.getState());
  const rows = runningMap(state.running);
  const clients = new Map(state.connector.clients.map((c) => [c.app, c]));

  const pulse = state.apps.find((a) => a.id === 'pulsenx');
  const live = renderAppCard(pulse, {
    now: Date.now(),
    settings: state.settings,
    clients,
    running: rows,
    stopping: new Map(),
    caps: {},
  });
  assert.match(live, /class="live"/);
  assert.match(live, /data-act="stop-app"[^>]*data-app="pulsenx"/);

  const ogb = state.apps.find((a) => a.id === 'oscgoesbrrr-nx-patches');
  const quiet = renderAppCard(ogb, {
    now: Date.now(),
    settings: state.settings,
    clients,
    running: rows,
    remote: new Map(),
    stopping: new Map(),
    caps: {},
  });
  assert.match(quiet, /class="run"/, 'the silent one gets the quiet strip');
  assert.match(quiet, /data-act="stop-app"[^>]*data-app="oscgoesbrrr-nx-patches"/);
  dev.stop();
});

test('a running strip made of hostile strings still renders as text', () => {
  const html = renderRunningStrip(
    normalizeRunningRow({
      appId: '<script>alert(1)</script>',
      appName: '"><img src=x onerror=alert(2)>',
      pid: 7,
      since: since(2),
    }),
    { now: NOW, stop: { appName: '<b>x</b>', artifactId: '"onmouseover="alert(3)', pending: null } }
  );
  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes(' onmouseover='), html);
  assert.ok(!html.includes('<b>'), html);
  assert.match(html, /&lt;script&gt;/, 'the id is visible, as text, in the data attribute');
  assert.equal(renderRunningStrip(null), '', 'and nothing at all renders nothing');
  assert.equal(renderRunningStrip({ appId: '' }), '');
  assert.equal(renderStripStop(null, { appId: 'x' }), '', 'no bundle, no control');
  assert.equal(renderStripStop({ appName: 'x' }, {}), '', 'no app, no control');
});
