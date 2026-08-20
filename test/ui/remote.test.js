// v0.10 [fabric2] — bus federation as the UI sees it: relayed rosters, the
// violet peer microchip, the card that is live somewhere else, the fleet
// sheet's inline roster, and the ambient settings-sync note.
//
// Everything under test here arrived over a NETWORK from a machine this hub
// does not control: peer names, app ids, field keys, field values. The escaping
// tests are not decoration — they are the actual threat model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConnector,
  normalizeRemotePeer,
  remotePeers,
  remoteClientsFor,
  remoteByApp,
  rosterFor,
  isPresent,
  isPresentAnywhere,
  presenceTitle,
} from '../../src/renderer/lib/connector.js';
import { renderStatusStrip, renderRemoteStrips, renderPeerMark } from '../../src/renderer/views/status.js';
import { renderAppCard } from '../../src/renderer/views/card.js';
import { renderFleetSheet, renderPeerChip } from '../../src/renderer/views/fleet.js';
import { fleetSyncEnabled, peerSyncs, syncNote, syncingPeers, normalizeFleet } from '../../src/renderer/lib/fleet.js';
import { normalizeState } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const REMOTE = {
  peerId: 'c0ffee11deadbeef',
  peerName: 'NX-WIN',
  clients: [
    {
      app: 'wivrn-nx-windows',
      version: '0.4.1',
      fields: { bitrate: 112, fps: 90 },
      history: { bitrate: [{ ts: 1, v: 100 }, { ts: 2, v: 112 }] },
    },
  ],
};

const WIN_DEFS = [
  { key: 'bitrate', label: 'Bitrate', unit: 'Mbit/s', kind: 'number' },
  { key: 'fps', label: 'Frames', unit: 'fps', kind: 'number' },
];

const APP = {
  id: 'wivrn-nx-windows',
  name: 'WiVRn NX for SteamVR',
  repo: 'nerdrx/wivrn-nx-windows',
  connectorFields: WIN_DEFS,
  latest: { version: '0.4.1', tag: 'v0.4.1', publishedAt: '2026-08-11T00:00:00Z' },
  artifacts: [],
};

/* ------------------------------------------------------------- normalize */

test('a relayed roster survives every shape the fleet could hand over', () => {
  const out = normalizeConnector({ clients: [], remote: [REMOTE] });
  assert.equal(out.remote.length, 1);
  assert.equal(out.remote[0].peerName, 'NX-WIN');
  assert.equal(out.remote[0].clients[0].app, 'wivrn-nx-windows');
  assert.equal(out.remote[0].clients[0].history.bitrate.length, 2);

  // Absent, junk, or a build that predates federation: all the same empty array.
  assert.deepEqual(normalizeConnector({ clients: [] }).remote, []);
  assert.deepEqual(normalizeConnector({ remote: 'nope' }).remote, []);
  assert.deepEqual(normalizeConnector({ remote: [null, 7, 'x'] }).remote, []);

  // A roster nobody can be attributed to is dropped: "live somewhere" is worse
  // than silence.
  assert.equal(normalizeRemotePeer({ clients: [{ app: 'x' }] }), null);
  assert.equal(normalizeRemotePeer({ peerId: '  ' }), null);

  // `id`/`name` are accepted as aliases, and a nameless peer falls back to its id.
  const alias = normalizeRemotePeer({ id: 'abc', clients: [] });
  assert.equal(alias.peerId, 'abc');
  assert.equal(alias.peerName, 'abc');
});

test('two rosters from one peer collapse, and app ids are lowercased like the bus', () => {
  const out = normalizeConnector({
    remote: [
      { peerId: 'p1', peerName: 'old', clients: [{ app: 'A' }] },
      { peerId: 'p1', peerName: 'new', clients: [{ app: 'B' }, { app: 'b', version: '2' }] },
    ],
  });
  assert.equal(out.remote.length, 1);
  assert.equal(out.remote[0].peerName, 'new', 'the newer session wins, like a duplicate hello');
  assert.deepEqual(
    out.remote[0].clients.map((c) => c.app),
    ['b']
  );
  assert.equal(out.remote[0].clients[0].version, '2');
});

test('remote lookups answer per app, per peer, and never confuse the two', () => {
  const conn = normalizeConnector({
    clients: [{ app: 'pulsenx', fields: { hr: 60 } }],
    remote: [REMOTE, { peerId: 'p2', peerName: 'workshop-pc', clients: [{ app: 'pulsenx', fields: { hr: 80 } }] }],
  });

  assert.deepEqual(remotePeers(conn).map((p) => p.peerId), ['c0ffee11deadbeef', 'p2']);
  assert.deepEqual(rosterFor(conn, 'p2').map((c) => c.app), ['pulsenx']);
  assert.deepEqual(rosterFor(conn, 'nobody'), []);
  assert.deepEqual(rosterFor(conn, ''), []);

  const win = remoteClientsFor(conn, 'wivrn-nx-windows');
  assert.equal(win.length, 1);
  assert.equal(win[0].peerName, 'NX-WIN');
  // Case-insensitive, because an app id off a socket may arrive in any case.
  assert.equal(remoteClientsFor(conn, 'WIVRN-NX-WINDOWS').length, 1);
  assert.deepEqual(remoteClientsFor(conn, 'nothing'), []);
  assert.deepEqual(remoteClientsFor(conn, ''), []);

  const byApp = remoteByApp(conn);
  assert.deepEqual([...byApp.keys()].sort(), ['pulsenx', 'wivrn-nx-windows']);
  assert.equal(byApp.get('pulsenx')[0].peerName, 'workshop-pc');
});

test('presence stays LOCAL by default — only isPresentAnywhere widens it', () => {
  const conn = normalizeConnector({ clients: [], remote: [REMOTE] });
  assert.equal(isPresent(conn, 'wivrn-nx-windows'), false, 'a launcher tile must not claim a process we do not have');
  assert.equal(isPresentAnywhere(conn, 'wivrn-nx-windows'), true);
  assert.equal(isPresentAnywhere(conn, 'nothing'), false);
});

test('the presence tooltip says WHERE when it is somewhere else', () => {
  const client = { app: 'pulsenx', version: '2.3.0' };
  assert.equal(presenceTitle(client, '2 min ago'), 'pulsenx 2.3.0 · connected 2 min ago');
  assert.equal(presenceTitle(client, '2 min ago', 'NX-WIN'), 'pulsenx 2.3.0 · connected on NX-WIN 2 min ago');
  assert.equal(presenceTitle(null, '', 'NX-WIN'), '');
});

/* ---------------------------------------------------------------- strips */

test('a remote strip wears the violet peer microchip and keeps its sparkline', () => {
  const conn = normalizeConnector({ remote: [REMOTE] });
  const out = renderRemoteStrips(remoteClientsFor(conn, 'wivrn-nx-windows'), WIN_DEFS, { now: Date.now() });

  assert.match(out, /class="live live-remote"/);
  assert.match(out, /class="live-peer"[^>]*>on NX-WIN</);
  assert.match(out, /data-live="wivrn-nx-windows"/);
  assert.match(out, /data-live-peer="c0ffee11deadbeef"/);
  assert.match(out, /LIVE</, 'a remote client is still LIVE — it just says where');
  assert.match(out, /data-spark="bitrate"/, 'a short relayed history still draws');
  // fps came with no series at all; the reading is there, the line is not.
  assert.match(out, />90</);
  assert.ok(!out.includes('data-spark="fps"'));
});

test('the peer mark is empty without a name, and never trusts one', () => {
  assert.equal(renderPeerMark(''), '');
  assert.equal(renderPeerMark('   '), '');
  const evil = renderPeerMark('"><script>alert(1)</script>', '"><img src=x>');
  assert.ok(!evil.includes('<script'), evil);
  assert.ok(!evil.includes('<img'), evil);
  assert.match(evil, /&lt;script&gt;/);
});

test('a peer name, app id and field key full of markup all escape on the strip', () => {
  const conn = normalizeConnector({
    remote: [
      {
        peerId: '"><b>id',
        peerName: '<img src=x onerror=alert(1)>',
        clients: [
          {
            app: '"><script>x</script>',
            fields: { '"><i>k': 5, ok: '<b>v</b>' },
            history: { '"><i>k': [{ ts: 1, v: 5 }] },
          },
        ],
      },
    ],
  });
  const out = renderRemoteStrips(remoteByApp(conn).get('"><script>x</script>'), null, {});
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(!out.includes('<b>'), out);
  assert.ok(!out.includes('<i>'), out);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /data-spark="&quot;&gt;&lt;i&gt;k"/);
});

test('renderRemoteStrips is empty for everything that is not a roster', () => {
  assert.equal(renderRemoteStrips([], null, {}), '');
  assert.equal(renderRemoteStrips(null, null, {}), '');
  assert.equal(renderRemoteStrips([null, {}], null, {}), '');
});

/* ----------------------------------------------------------------- cards */

test('a card live only on ANOTHER hub still gets a LIVE strip, peer-tagged', () => {
  const conn = normalizeConnector({ clients: [], remote: [REMOTE] });
  const out = renderAppCard(APP, {
    clients: new Map(),
    remote: remoteByApp(conn),
    now: Date.now(),
  });
  assert.match(out, /class="live live-remote"/);
  assert.match(out, />on NX-WIN</);
  assert.ok(!/class="live"/.test(out), 'and no bare local strip appears beside it');
});

test('a card live in BOTH places shows both strips, local first', () => {
  const conn = normalizeConnector({
    clients: [{ app: 'wivrn-nx-windows', fields: { bitrate: 50 } }],
    remote: [REMOTE],
  });
  const clients = new Map(conn.clients.map((c) => [c.app, c]));
  const out = renderAppCard(APP, { clients, remote: remoteByApp(conn), now: Date.now() });
  assert.ok(out.indexOf('class="live"') < out.indexOf('class="live live-remote"'), 'this machine leads');
  assert.match(out, />50</);
  assert.match(out, />112</);
});

test('a card with no federation at all is byte-for-byte the pre-v0.10 card', () => {
  const base = renderAppCard(APP, { clients: new Map(), now: 0 });
  assert.equal(renderAppCard(APP, { clients: new Map(), remote: new Map(), now: 0 }), base);
  assert.equal(renderAppCard(APP, { clients: new Map(), remote: 'nope', now: 0 }), base);
  assert.ok(!base.includes('live-remote'));
});

/* ----------------------------------------------------------- fleet sheet */

test('a peer shows the roster it relayed, inline, with peer-tagged strips', () => {
  const fleet = normalizeFleet({
    peers: [{ id: 'c0ffee11deadbeef', name: 'NX-WIN', host: '192.168.1.64', online: true, summary: { apps: [] } }],
  });
  const conn = normalizeConnector({ remote: [REMOTE] });
  const remote = new Map(conn.remote.map((r) => [r.peerId, r.clients]));

  const out = renderFleetSheet({ peers: fleet.peers, apps: [APP], remote, now: Date.now(), settings: {} });
  assert.match(out, /class="peer-bus"/);
  assert.match(out, />Live there</);
  assert.match(out, /data-live="wivrn-nx-windows"/);
  assert.match(out, />on NX-WIN</);
  // The overlay's own labels are used for the relayed fields.
  assert.match(out, /Bitrate/);

  // No roster from that peer → no block at all, not an empty heading.
  const bare = renderFleetSheet({ peers: fleet.peers, apps: [APP], now: Date.now(), settings: {} });
  assert.ok(!bare.includes('peer-bus'), bare);
});

test('the header chip mentions what the fleet is running — in the tooltip only', () => {
  const peers = normalizeFleet({ peers: [{ id: 'p1', name: 'NX-WIN', online: true, summary: { apps: [] } }] }).peers;

  const quiet = renderPeerChip(peers, {});
  assert.match(quiet, /1 of 1 paired hub online — click to manage/);
  assert.ok(!quiet.includes('peer-live'));

  const live = renderPeerChip(peers, { remoteLive: 2 });
  assert.match(live, /online · 2 apps live there — click to manage/);
  assert.match(live, /peer-chip peer-on peer-live/);
  assert.match(renderPeerChip(peers, { remoteLive: 1 }), /1 app live there/);
  // The chip's own text is unchanged — the update badge keeps that space.
  assert.match(live, /class="peer-chip-text">1 hub</);

  // An offline fleet cannot be relaying anything, whatever it is handed.
  const dark = normalizeFleet({ peers: [{ id: 'p2', name: 'x', online: false }] }).peers;
  assert.ok(!renderPeerChip(dark, { remoteLive: 3 }).includes('live there'));
});

/* ------------------------------------------------------------ sync note */

test('fleetSync defaults to ON — only an explicit false turns it off', () => {
  assert.equal(fleetSyncEnabled(undefined), true);
  assert.equal(fleetSyncEnabled({}), true);
  assert.equal(fleetSyncEnabled({ fleetSync: true }), true);
  assert.equal(fleetSyncEnabled({ fleetSync: false }), false);
  // Not a truthiness test: 0 and '' are not "off".
  assert.equal(fleetSyncEnabled({ fleetSync: 0 }), true);
});

test('the sync note matrix: setting × peer state', () => {
  const online = { id: 'p1', name: 'NX-WIN', online: true };
  const offline = { id: 'p2', name: 'living-room', online: false };

  assert.equal(peerSyncs(online, {}), true);
  assert.equal(peerSyncs(online, { fleetSync: false }), false);
  assert.equal(peerSyncs(offline, {}), false, 'sync is a property of a LIVE session');
  assert.equal(peerSyncs(offline, { fleetSync: false }), false);
  assert.equal(peerSyncs(null, {}), false);

  assert.equal(syncNote(online, {}), 'preferences sync with this hub');
  assert.equal(syncNote(online, { fleetSync: false }), '');
  assert.equal(syncNote(offline, {}), '');

  assert.deepEqual(syncingPeers([online, offline], {}).map((p) => p.id), ['p1']);
  assert.deepEqual(syncingPeers([online, offline], { fleetSync: false }), []);
  assert.deepEqual(syncingPeers(null, {}), []);
});

test('the note reaches the sheet only for the peers that are actually syncing', () => {
  const fleet = normalizeFleet({
    peers: [
      { id: 'p1', name: 'NX-WIN', online: true, summary: { apps: [] } },
      { id: 'p2', name: 'living-room', online: false, summary: { apps: [] } },
    ],
  });
  const on = renderFleetSheet({ peers: fleet.peers, now: Date.now(), settings: {} });
  assert.equal(on.match(/class="peer-sync"/g).length, 1, 'one online peer, one note');
  assert.match(on, /preferences sync with this hub/);

  const off = renderFleetSheet({ peers: fleet.peers, now: Date.now(), settings: { fleetSync: false } });
  assert.ok(!off.includes('peer-sync'), 'the setting silences it everywhere');

  // No settings at all (a bridge that never answered) behaves like the default.
  const bare = renderFleetSheet({ peers: fleet.peers, now: Date.now() });
  assert.match(bare, /preferences sync with this hub/);
});

/* ----------------------------------------------------------- mock bridge */

test('the mock federates one roster from the start and another on wake', async () => {
  const { nxhub, dev } = createMock();
  const first = normalizeState(await nxhub.getState());
  assert.equal(first.connector.remote.length, 1, 'the online peer is relaying');
  assert.equal(first.connector.remote[0].peerName, 'workshop-pc');
  const relayed = first.connector.remote[0].clients[0];
  assert.equal(relayed.app, 'oscgoesbrrr-nx-patches');
  assert.ok(!first.connector.clients.some((c) => c.app === relayed.app), 'and it is NOT on this machine’s bus');
  assert.ok(relayed.history.receivers.length > 3, 'with a (short) relayed history');
  assert.ok(relayed.history.receivers.length <= 20, 'capped at the bus limit');

  dev.relayNxWin();
  const woken = normalizeState(await nxhub.getState());
  assert.equal(woken.connector.remote.length, 2);
  assert.ok(woken.connector.remote.some((r) => r.peerName === 'NX-WIN'));
  assert.ok(
    remoteClientsFor(woken.connector, 'wivrn-nx-windows').length === 1,
    'wivrn on NX-WIN, exactly as the fleet sheet will show it'
  );

  // A peer going dark clears the roster it was relaying (SPEC: session drops).
  dev.sleepMockPeer();
  const dark = normalizeState(await nxhub.getState());
  assert.ok(!dark.connector.remote.some((r) => r.peerName === 'NX-WIN'));

  // …and a session can be up with nothing relayed yet.
  dev.toggleRemoteRoster('a1b2c3d4e5f60718');
  const quiet = normalizeState(await nxhub.getState());
  assert.deepEqual(quiet.connector.remote, []);
  dev.stop();
});
