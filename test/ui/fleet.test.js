// v0.6 Fleet — the peer model, the matching table, the pairing state machine,
// the progress fold, and the two rendered surfaces.
//
// Every string in a peer is NETWORK INPUT from another machine, so the escaping
// tests at the bottom are load-bearing, not decoration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePeer,
  normalizePeerApp,
  normalizeFleet,
  installedVersions,
  fleetCounts,
  peerById,
  peerAppTable,
  peerAppActions,
  blankPairState,
  pairShowStart,
  pairCodeArrived,
  pairEnterStart,
  pairSubmitStart,
  pairResult,
  pairCancel,
  normalizeCode,
  validatePairForm,
  codeMsLeft,
  formatCountdown,
  isCodeLive,
  codeGroups,
  foldFleetProgress,
  pruneFleetJobs,
  peerJobs,
  PAIR_WINDOW_MS,
} from '../../src/renderer/lib/fleet.js';
import { renderPeerChip, renderFleetSheet } from '../../src/renderer/views/fleet.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const PEER = {
  id: 'a1b2c3d4e5f60718',
  name: 'workshop-pc',
  host: '192.168.1.50',
  online: true,
  lastSeen: '2026-08-16T10:00:00Z',
  summary: {
    apps: [
      { id: 'wivrn-nx', name: 'WiVRn NX', installed: '1.9.0', updates: 1 },
      { id: 'pulsenx', name: 'PulseNX', installed: '2.3.0', updates: 0 },
      { id: 'lab-rig', name: 'Lab Rig', installed: '', updates: 0 },
    ],
  },
};

const OFFLINE = {
  id: 'bb00cc11dd22ee33',
  name: 'living-room',
  host: 'living-room.local',
  online: false,
  lastSeen: '2026-08-16T09:00:00Z',
  summary: { apps: [{ id: 'wivrn-nx', name: 'WiVRn NX', installed: '1.8.0', updates: 2 }] },
};

const APPS = [
  normalizeApp({
    id: 'wivrn-nx',
    repo: 'nerdrx/wivrn-nx',
    name: 'WiVRn NX',
    latest: { version: '1.9.2' },
    artifacts: [
      { id: 'tarball-prefix-linux', label: 'Linux server', platform: 'linux', kind: 'tarball-prefix' },
      { id: 'apk-adb-android', label: 'Headset APK', platform: 'android', kind: 'apk-adb' },
      { id: 'windows-zip-windows', label: 'Windows build', platform: 'windows', kind: 'windows-zip' },
    ],
  }),
  normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    latest: { version: '2.3.0' },
    artifacts: [{ id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage' }],
  }),
];

/* ------------------------------------------------------------------ model */

test('a peer normalizes defensively — junk in, usable peer out', () => {
  const p = normalizePeer(null);
  assert.equal(p.id, '');
  assert.equal(p.name, 'Unnamed hub');
  assert.deepEqual(p.summary.apps, []);

  const named = normalizePeer({ host: '10.0.0.4', summary: { apps: 'nonsense' } });
  assert.equal(named.name, '10.0.0.4', 'the host stands in for a missing name');
  assert.deepEqual(named.summary.apps, []);

  const full = normalizePeer(PEER);
  assert.equal(full.online, true);
  assert.equal(full.summary.apps.length, 3);
  assert.equal(full.summary.apps[0].id, 'wivrn-nx');
});

test('installed versions arrive as a string, a list or a map', () => {
  assert.deepEqual(installedVersions('1.2.3'), ['1.2.3']);
  assert.deepEqual(installedVersions(['1.2.3', '1.2.3', '2.0.0']), ['1.2.3', '2.0.0'], 'deduped');
  assert.deepEqual(installedVersions({ 'appimage-linux': '1.0.0', apk: { version: '1.1.0' } }), ['1.0.0', '1.1.0']);
  assert.deepEqual(installedVersions([{ version: '3.1' }]), ['3.1']);
  assert.deepEqual(installedVersions(null), []);
  assert.deepEqual(installedVersions(''), []);
});

test('an app row counts updates without trusting the type', () => {
  assert.equal(normalizePeerApp({ id: 'x', updates: '3' }).updates, 3);
  assert.equal(normalizePeerApp({ id: 'x', updates: true }).updates, 1);
  assert.equal(normalizePeerApp({ id: 'x', updates: -4 }).updates, 0);
  assert.equal(normalizePeerApp({ id: 'x', updates: 'lots' }).updates, 0);
  assert.equal(normalizePeerApp({ id: ' WiVRn-NX ' }).id, 'wivrn-nx', 'ids are lowercased and trimmed');
  assert.equal(normalizePeerApp({ id: 'x' }).name, 'x', 'the id stands in for a missing name');
});

test('the fleet dedupes by peer id and counts what the chip shows', () => {
  const fleet = normalizeFleet({ peers: [PEER, OFFLINE, { ...PEER, name: 'renamed' }] });
  assert.equal(fleet.peers.length, 2);
  assert.equal(fleet.peers[0].name, 'renamed', 'the last beacon wins');

  const counts = fleetCounts(fleet.peers);
  assert.deepEqual(counts, { peers: 2, online: 1, updates: 3 });
  assert.deepEqual(fleetCounts(null), { peers: 0, online: 0, updates: 0 });

  assert.equal(peerById(fleet.peers, OFFLINE.id).name, 'living-room');
  assert.equal(peerById(fleet.peers, 'nope'), null);
  assert.equal(peerById(fleet.peers, ''), null);
});

test('a peer without a summary is still listed (an offline hub has nothing to say)', () => {
  const fleet = normalizeFleet([{ id: 'x1', name: 'bare', host: '10.0.0.9' }]);
  assert.equal(fleet.peers.length, 1, 'a bare array of peers is accepted too');
  assert.deepEqual(fleet.peers[0].summary.apps, []);
  assert.deepEqual(normalizeFleet(undefined), { peers: [] });
});

/* --------------------------------------------------------- matching table */

test('the peer app table matches against the local catalogue for artifacts', () => {
  const rows = peerAppTable(normalizePeer(PEER), { apps: APPS });
  assert.deepEqual(rows.map((r) => r.id), ['wivrn-nx', 'pulsenx', 'lab-rig']);

  const [wivrn, pulse, lab] = rows;
  assert.equal(wivrn.known, true);
  assert.deepEqual(
    wivrn.artifacts.map((a) => a.id),
    ['tarball-prefix-linux', 'windows-zip-windows'],
    'an apk is not something one hub installs on another'
  );
  assert.equal(wivrn.updates, 1);
  assert.equal(wivrn.canLaunch, true);

  assert.equal(pulse.artifacts.length, 1);
  assert.equal(lab.known, false, 'an app this hub never discovered still gets a row');
  assert.deepEqual(lab.artifacts, []);
  assert.equal(lab.canLaunch, false, 'nothing installed there — nothing to launch');
});

test('row actions read Install / Update / Reinstall and gate Launch', () => {
  const [wivrn, pulse, lab] = peerAppTable(normalizePeer(PEER), { apps: APPS });
  assert.equal(peerAppActions(wivrn)[0].label, 'Update');
  assert.equal(peerAppActions(wivrn)[0].variant, 'violet');
  assert.equal(peerAppActions(pulse)[0].label, 'Reinstall');
  assert.equal(peerAppActions(lab)[0].label, 'Install');
  assert.equal(peerAppActions(lab)[1].disabled, true);
  assert.equal(peerAppActions(wivrn)[1].disabled, false);
  assert.deepEqual(peerAppActions(null).map((a) => a.act), ['fleet-install', 'fleet-launch']);
});

/* ------------------------------------------------------ pairing machine */

test('a pairing code is six digits, forgiving of spaces and dashes', () => {
  assert.equal(normalizeCode('482913'), '482913');
  assert.equal(normalizeCode('482 913'), '482913');
  assert.equal(normalizeCode('482-913'), '482913');
  assert.equal(normalizeCode('48291'), '', 'five digits is not a code');
  assert.equal(normalizeCode('4829133'), '');
  assert.equal(normalizeCode(null), '');
  assert.deepEqual(codeGroups('482913'), ['482', '913']);
  assert.deepEqual(codeGroups(''), []);
});

test('the show-code half of the machine walks idle → show → live code', () => {
  const idle = blankPairState();
  assert.equal(idle.mode, 'idle');

  const asked = pairShowStart(idle);
  assert.equal(asked.mode, 'show');
  assert.equal(asked.busy, true);
  assert.equal(isCodeLive(asked, 0), false, 'nothing to show yet');

  const live = pairCodeArrived(asked, { code: '482913', expiresAt: 1000 + PAIR_WINDOW_MS }, 1000);
  assert.equal(live.busy, false);
  assert.equal(live.code, '482913');
  assert.equal(isCodeLive(live, 1000), true);
  assert.equal(isCodeLive(live, 1000 + PAIR_WINDOW_MS + 1), false, 'the window closes');

  // No expiry from the bridge → SPEC's 120s window, applied here.
  const defaulted = pairCodeArrived(asked, { code: '111222' }, 5000);
  assert.equal(defaulted.expiresAt, 5000 + PAIR_WINDOW_MS);

  const junk = pairCodeArrived(asked, { code: 'nope' }, 0);
  assert.match(junk.error, /did not return a pairing code/);
  assert.equal(junk.busy, false);
});

test('the countdown is m:ss and never locale-dependent', () => {
  assert.equal(formatCountdown(118000), '1:58');
  assert.equal(formatCountdown(60000), '1:00');
  assert.equal(formatCountdown(9000), '0:09');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(codeMsLeft(2000, 1000), 1000);
  assert.equal(codeMsLeft(500, 1000), 0, 'never negative');
  assert.equal(codeMsLeft(null), 0);
});

test('the enter-a-code half validates both fields before it calls the bridge', () => {
  assert.deepEqual(validatePairForm('192.168.1.50', '482913'), {
    ok: true,
    errors: {},
    host: '192.168.1.50',
    code: '482913',
  });
  assert.equal(validatePairForm('192.168.1.50:9023', '482 913').ok, true, 'a port and spaces are fine');

  assert.match(validatePairForm('', '482913').errors.host, /Enter the other hub/);
  assert.match(validatePairForm('has space', '482913').errors.host, /not a valid address/);
  assert.match(validatePairForm('10.0.0.5:99999', '482913').errors.host, /not a valid port/);
  assert.match(validatePairForm('10.0.0.5', '').errors.code, /six digits/);
  assert.match(validatePairForm('10.0.0.5', '4829').errors.code, /has 6 digits/);
  assert.equal(validatePairForm('10.0.0.5', 'abcdef').ok, false);
});

test('pairResult separates "wrong code" from "could not reach it"', () => {
  const submitting = pairSubmitStart(pairEnterStart(blankPairState()), '10.0.0.5', '000000');
  assert.equal(submitting.busy, true);
  assert.equal(submitting.mode, 'enter');

  const unreachable = pairResult(submitting, null);
  assert.match(unreachable.error, /Could not reach 10\.0\.0\.5/);
  assert.equal(unreachable.busy, false);
  assert.equal(unreachable.mode, 'enter', 'the form stays open so the user can retry');

  const refused = pairResult(submitting, { ok: false, error: 'That code did not match — ask for a fresh one.' });
  assert.match(refused.error, /did not match/);

  const bare = pairResult(submitting, false);
  assert.match(bare.error, /did not match/, 'a bare false still says something useful');

  const paired = pairResult(submitting, { ok: true, peer: { id: 'x', name: 'workshop-pc' } });
  assert.equal(paired.mode, 'idle');
  assert.equal(paired.error, '');
  assert.match(paired.ok, /Paired with workshop-pc/);

  assert.deepEqual(pairCancel(), blankPairState());
});

/* -------------------------------------------------------- progress fold */

const progress = (over) => ({ type: 'fleet-progress', peerId: PEER.id, jobId: 'j1', appId: 'wivrn-nx', ...over });

test('fleet-progress folds per peer and clears on a terminal event', () => {
  let jobs = foldFleetProgress({}, progress({ phase: 'download', pct: 12 }), 1000);
  assert.equal(peerJobs(jobs, PEER.id).length, 1);
  assert.equal(peerJobs(jobs, PEER.id)[0].pct, 12);

  jobs = foldFleetProgress(jobs, progress({ phase: 'install', pct: 90 }), 2000);
  assert.equal(peerJobs(jobs, PEER.id).length, 1, 'the same job updates in place');
  assert.equal(peerJobs(jobs, PEER.id)[0].phase, 'install');

  const other = foldFleetProgress(jobs, progress({ peerId: OFFLINE.id, jobId: 'j9' }), 2100);
  assert.equal(peerJobs(other, OFFLINE.id).length, 1);
  assert.equal(peerJobs(other, PEER.id).length, 1, 'peers do not share rows');

  const done = foldFleetProgress(jobs, progress({ phase: 'done' }), 3000);
  assert.deepEqual(peerJobs(done, PEER.id), [], 'a finished job leaves no row');
  assert.deepEqual(done, {}, 'and the empty peer bucket goes with it');

  const failed = foldFleetProgress(jobs, progress({ error: 'checksum mismatch' }), 3000);
  assert.deepEqual(peerJobs(failed, PEER.id), []);
});

test('fleet-progress ignores junk and never mutates in place', () => {
  const before = foldFleetProgress({}, progress({ phase: 'download', pct: 5 }), 1000);
  const snapshot = JSON.parse(JSON.stringify(before));
  for (const junk of [null, 'nope', {}, { peerId: '' }, { jobId: 'x' }]) {
    assert.deepEqual(foldFleetProgress(before, junk, 2000), before);
  }
  foldFleetProgress(before, progress({ phase: 'verify' }), 2000);
  assert.deepEqual(before, snapshot, 'the caller keeps its old object');
  assert.deepEqual(peerJobs(null, 'x'), []);
});

test('a peer that vanishes mid-job has its rows pruned', () => {
  const jobs = foldFleetProgress({}, progress({ phase: 'download', pct: 30 }), 1000);
  assert.deepEqual(pruneFleetJobs(jobs, 2000), jobs, 'a fresh row survives');
  assert.deepEqual(pruneFleetJobs(jobs, 1000 + 60000), {}, 'a stale one does not');
});

/* --------------------------------------------------------------- render */

test('the header chip counts online hubs and carries the update total', () => {
  const peers = normalizeFleet({ peers: [PEER, OFFLINE] }).peers;
  const chip = renderPeerChip(peers);
  assert.match(chip, /data-act="fleet"/);
  assert.match(chip, /peer-chip peer-on/);
  assert.match(chip, /1 hub</);
  assert.match(chip, /peer-updates[^>]*>3</, 'three updates across the fleet');
  assert.match(chip, /peer-dot/);

  const dark = renderPeerChip([normalizePeer(OFFLINE)]);
  assert.match(dark, /peer-chip peer-off/);
  assert.match(dark, /1 offline</);
  assert.ok(!renderPeerChip(peers).includes('spinner'));
  assert.match(renderPeerChip(peers, { busy: true }), /spinner/);
});

test('the fleet sheet renders every peer, its table and its actions', () => {
  const peers = normalizeFleet({ peers: [PEER, OFFLINE] }).peers;
  const out = renderFleetSheet({ peers, apps: APPS, pair: blankPairState(), now: Date.parse('2026-08-16T10:05:00Z') });

  assert.match(out, /aria-label="Fleet"/);
  assert.match(out, /1 of 2 hubs online/);
  assert.match(out, /3 updates waiting/);
  assert.match(out, /class="peer is-online"/);
  assert.match(out, /class="peer is-offline"/);
  assert.match(out, /workshop-pc/);
  assert.match(out, /192\.168\.1\.50/);
  assert.match(out, /last seen/, 'the offline peer says when it was last heard from');

  // The matching table and its buttons.
  assert.match(out, /data-act="fleet-install"[^>]*data-peer="a1b2c3d4e5f60718"[^>]*data-app="wivrn-nx"/);
  assert.match(out, /data-act="fleet-launch"[^>]*data-app="pulsenx"/);
  assert.match(out, /data-fleet-art="a1b2c3d4e5f60718::wivrn-nx"/, 'two artifacts → a compact picker');
  assert.ok(!out.includes('data-fleet-art="a1b2c3d4e5f60718::pulsenx"'), 'one artifact needs no picker');
  assert.match(out, /data-act="fleet-update-all"[^>]*data-peer="a1b2c3d4e5f60718"/);
  assert.match(out, /data-act="fleet-unpair"[^>]*data-peer="a1b2c3d4e5f60718"/);
  assert.match(out, /pa-unknown/, 'the app this hub never saw is marked');

  // An offline peer cannot be told to do anything wholesale.
  const offlineBlock = out.slice(out.indexOf('bb00cc11dd22ee33'));
  assert.match(offlineBlock, /data-act="fleet-update-all"[^>]*disabled/);
});

test('an empty fleet invites the next action instead of apologizing', () => {
  const out = renderFleetSheet({ peers: [], apps: APPS, pair: blankPairState() });
  assert.match(out, /No other hub paired/);
  assert.match(out, /data-act="fleet-show-code"/);
  assert.match(out, /data-act="fleet-pair-open"/);
  assert.ok(!out.includes('data-act="fleet-unpair"'));
});

test('the pairing panel renders both directions and their errors', () => {
  const now = 10000;
  const showing = renderFleetSheet({
    peers: [],
    pair: pairCodeArrived(pairShowStart(blankPairState()), { code: '482913', expiresAt: now + 118000 }, now),
    now,
  });
  assert.match(showing, /pair-group">482</);
  assert.match(showing, /pair-group">913</);
  assert.match(showing, /expires in 1:58/);

  const expired = renderFleetSheet({
    peers: [],
    pair: pairCodeArrived(pairShowStart(blankPairState()), { code: '482913', expiresAt: now }, now),
    now: now + 1,
  });
  assert.match(expired, /is-expired/);
  assert.match(expired, /expired — show a fresh one/);

  const form = renderFleetSheet({
    peers: [],
    pair: { ...pairEnterStart(blankPairState()), host: '10.0.0.5', input: '1234', errors: { code: 'A pairing code has 6 digits.' } },
  });
  assert.match(form, /data-fleet-field="host"[^>]*value="10\.0\.0\.5"/);
  assert.match(form, /data-fleet-field="code"/);
  assert.match(form, /field-error">A pairing code has 6 digits\./);
  assert.match(form, /data-act="fleet-pair-submit"/);

  const failed = renderFleetSheet({
    peers: [],
    pair: pairResult(pairSubmitStart(pairEnterStart(blankPairState()), '10.0.0.5', '000000'), false),
  });
  assert.match(failed, /did not match/);
});

test('a live remote job draws a slim row under its peer, delta and all', () => {
  const peers = normalizeFleet({ peers: [PEER] }).peers;
  const jobs = foldFleetProgress(
    {},
    progress({ phase: 'download', pct: 41, message: 'downloading delta patch (14.2 MB instead of 84.6 MB)' }),
    1000
  );
  const out = renderFleetSheet({ peers, apps: APPS, pair: blankPairState(), jobs, now: 1000 });
  assert.match(out, /class="fleet-job"/);
  assert.match(out, /Downloading 41%/);
  assert.match(out, /delta-chip/, 'the savings show up here too');
  assert.match(out, /width:41%/);

  const unknown = foldFleetProgress({}, progress({ phase: 'extract', pct: -1 }), 1000);
  assert.match(renderFleetSheet({ peers, jobs: unknown, pair: blankPairState() }), /bar-indeterminate/);
});

/* ------------------------------------------------------------------ XSS */

const NASTY = '<img src=x onerror="alert(1)">';
const EVIL_PEER = {
  id: '"><script>alert(1)</script>',
  name: NASTY,
  host: `10.0.0.1" onmouseover="alert(2)`,
  online: true,
  lastSeen: '2026-08-16T10:00:00Z',
  summary: {
    apps: [
      { id: '<b>evil</b>', name: `</td><script>alert(3)</script>`, installed: '<i>9.9</i>', updates: 2 },
      { id: 'wivrn-nx', name: '</span><svg onload=alert(4)>', installed: "'; DROP--", updates: 0 },
    ],
  },
};

test('every peer-supplied string is escaped — names, hosts, ids, versions', () => {
  const peers = normalizeFleet({ peers: [EVIL_PEER] }).peers;
  const out = renderFleetSheet({ peers, apps: APPS, pair: blankPairState(), now: Date.now() });

  assert.ok(!out.includes('<script>'), 'no injected script tag survives');
  assert.ok(!out.includes('<svg onload'), 'no injected svg survives');
  assert.ok(!out.includes('<img src=x'), 'no injected img survives');
  assert.ok(!out.includes('onerror="alert'), 'no injected handler survives');
  assert.ok(!out.includes('onmouseover="'), 'a hostname cannot break out of an attribute');
  assert.match(out, /onmouseover=&quot;/, 'it is inert text, quotes and all');
  assert.ok(!/<b>evil<\/b>/.test(out), 'an app id is not markup either');
  assert.match(out, /&lt;img src=x/, 'it renders as text');
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&#39;; DROP--/, 'a version string is text too');

  // Attribute values built from a peer id must stay inside their quotes.
  assert.ok(!/data-peer="[^"]*"[^>]*onmouseover/.test(out));
  assert.match(out, /data-peer="&quot;&gt;&lt;script&gt;/);
});

test('the header chip escapes a hostile fleet too', () => {
  const peers = normalizeFleet({ peers: [EVIL_PEER] }).peers;
  const chip = renderPeerChip(peers);
  assert.ok(!chip.includes('<script>'));
  assert.ok(!chip.includes('onerror='));
  assert.match(chip, /data-act="fleet"/);
});

/* ------------------------------------------------------------------ mock */

test('the mock ships a full fleet surface', async () => {
  const { nxhub, dev } = createMock();
  const fleet = normalizeFleet(await nxhub.getFleet());
  assert.equal(fleet.peers.length, 2);
  const [online, offline] = fleet.peers;
  assert.equal(online.online, true);
  assert.equal(offline.online, false);
  assert.ok(online.summary.apps.some((a) => a.updates > 0), 'something is waiting to be updated there');
  assert.ok(online.summary.apps.some((a) => a.id === 'lab-rig'), 'and one app this hub never discovered');

  // The wrong-code path is reachable, and so is the right one.
  const refused = await nxhub.fleetPair('10.0.0.9', '000000');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /did not match/);

  const ok = await nxhub.fleetPair('10.0.0.9', dev.pairCode());
  assert.equal(ok.ok, true);
  assert.equal(normalizeFleet(await nxhub.getFleet()).peers.length, 3);
  assert.equal(await nxhub.fleetUnpair(ok.peer.id), true);
  assert.equal(normalizeFleet(await nxhub.getFleet()).peers.length, 2);

  const code = await nxhub.fleetShowCode();
  assert.equal(code.code, dev.pairCode());
  assert.ok(code.expiresAt > Date.now(), 'the window is in the future');
  dev.stop();
});

test('the mock relays remote job progress and finishes the remote install', async () => {
  const { nxhub, dev } = createMock();
  const seen = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'fleet-progress') seen.push(ev);
  });
  const peerId = dev.peers()[0].id;
  const res = await nxhub.fleetInstall(peerId, 'wivrn-nx', 'tarball-prefix-linux');
  assert.equal(res.ok, true);

  await new Promise((r) => setTimeout(r, 2800));
  assert.ok(seen.length >= 3, `expected a few progress events, saw ${seen.length}`);
  assert.ok(seen.every((ev) => ev.peerId === peerId));
  assert.equal(seen[seen.length - 1].phase, 'done', 'the relay ends the row');

  const jobs = seen.reduce((acc, ev) => foldFleetProgress(acc, ev, Date.now()), {});
  assert.deepEqual(peerJobs(jobs, peerId), [], 'the folded map is empty once it finished');

  const after = normalizeFleet(await nxhub.getFleet()).peers.find((p) => p.id === peerId);
  const row = after.summary.apps.find((a) => a.id === 'wivrn-nx');
  assert.equal(row.updates, 0, 'the summary caught up');
  dev.stop();
});

test('the mock can take a peer offline and update a whole hub at once', async () => {
  const { nxhub, dev } = createMock();
  const peerId = dev.peers()[0].id;
  assert.equal(dev.togglePeer(peerId), false, 'toggled off');
  assert.equal(normalizeFleet(await nxhub.getFleet()).peers[0].online, false);
  assert.equal(dev.togglePeer(peerId), true, 'and back on');

  const res = await nxhub.fleetUpdateAll(peerId);
  assert.equal(res.ok, true);
  assert.ok(res.jobs >= 1, 'at least one app was waiting');
  assert.equal(await nxhub.fleetUpdateAll('nope'), false);
  dev.stop();
});
