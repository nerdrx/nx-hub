// v0.8 watchdog, sandbox and signed releases — the pref tri-states, the
// supervisor banner lifecycle, and the shield matrix on artifact rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_CHOICES,
  SANDBOX_VALUES,
  RESTART_CLEAR_MS,
  KEEP_ALIVE_NOTE,
  sandboxValue,
  sandboxChoice,
  sandboxFromChoice,
  sandboxLabel,
  sandboxNote,
  overlaySandbox,
  effectiveSandbox,
  isSandboxed,
  supervisorKey,
  foldSupervisor,
  pruneSupervisor,
  dismissSupervisor,
  supervisorFor,
  restartingLine,
  gaveUpText,
} from '../../src/renderer/lib/guardian.js';
import {
  renderAppCard,
  renderArtifactRow,
  renderSupervisorLine,
  renderSupervisorBanner,
  signatureMark,
} from '../../src/renderer/views/card.js';
import { renderAppOptions } from '../../src/renderer/views/appoptions.js';
import { renderSettingsPanel } from '../../src/renderer/views/settings.js';
import { normalizeApp, normalizeArtifact, normalizeSettings } from '../../src/renderer/lib/model.js';
import { normalizeAppPref, DEFAULT_APP_PREF } from '../../src/renderer/lib/prefs.js';
import { createMock } from '../../src/renderer/mock.js';

function app(over = {}) {
  return normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    latest: { version: '2.3.0', tag: 'v2.3.0' },
    artifacts: [
      { id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage', hasSignature: true },
    ],
    ...over,
  });
}

/* ------------------------------------------------------- the app model */

test('the app model carries keepAlive, both sandbox fields and configPaths', () => {
  const a = app({
    keepAlive: true,
    sandbox: 'confined',
    sandboxPref: 'offline',
    configPaths: ['~/.config/pulsenx', '', null, 7],
  });
  assert.equal(a.keepAlive, true);
  assert.equal(a.sandbox, 'confined', 'the overlay’s own profile');
  assert.equal(a.sandboxPref, 'offline', 'and the user’s override, kept apart');
  assert.deepEqual(a.configPaths, ['~/.config/pulsenx', '7']);

  // Junk profiles read as absent rather than sticking.
  const junk = app({ sandbox: 'jail', sandboxPref: 'yes' });
  assert.equal(junk.sandbox, '');
  assert.equal(junk.sandboxPref, '');
  assert.equal(app().keepAlive, false, 'off unless said otherwise');
});

test('the app pref carries the same two, with null as the sandbox clear', () => {
  assert.equal(DEFAULT_APP_PREF.keepAlive, false);
  assert.equal(DEFAULT_APP_PREF.sandbox, null);
  assert.equal(normalizeAppPref({ keepAlive: 1 }).keepAlive, true);
  assert.equal(normalizeAppPref({ sandbox: 'confined' }).sandbox, 'confined');
  assert.equal(normalizeAppPref({ sandbox: 'inherit' }).sandbox, null, '"inherit" is not a stored value');
  assert.equal(normalizeAppPref({ sandbox: 'jail' }).sandbox, null);
});

/* ------------------------------------------------------------- sandbox */

test('the sandbox tri-state resolves the way autoRunCmd’s does', () => {
  assert.deepEqual(SANDBOX_VALUES, ['none', 'confined', 'offline']);
  assert.deepEqual(SANDBOX_CHOICES, ['inherit', 'none', 'confined', 'offline']);

  assert.equal(sandboxValue('confined'), 'confined');
  assert.equal(sandboxValue('inherit'), '', 'inherit is a UI word, not a value');
  assert.equal(sandboxValue(null), '');

  // Select value → what setAppPref stores. null (not undefined) is the clear.
  assert.equal(sandboxFromChoice('inherit'), null);
  assert.equal(sandboxFromChoice('none'), 'none', '"none" is a real choice, distinct from clearing');
  assert.equal(sandboxFromChoice('offline'), 'offline');
  assert.equal(sandboxFromChoice('junk'), null);

  // …and back again.
  assert.equal(sandboxChoice(app({ sandboxPref: 'offline' })), 'offline');
  assert.equal(sandboxChoice(app({ sandbox: 'confined' })), 'inherit', 'the overlay is not the user’s choice');
  assert.equal(sandboxChoice(null), 'inherit');
});

test('“inherit” spells out what it resolves to, and the pref wins at launch', () => {
  assert.equal(overlaySandbox(app()), 'none', 'no overlay profile means none');
  assert.equal(overlaySandbox(app({ sandbox: 'confined' })), 'confined');
  assert.equal(sandboxLabel('inherit', app({ sandbox: 'confined' })), 'Inherit (overlay: confined)');
  assert.equal(sandboxLabel('inherit', app()), 'Inherit (overlay: none)');
  assert.equal(sandboxLabel('offline', app()), 'Offline');

  assert.equal(effectiveSandbox(app({ sandbox: 'confined' })), 'confined');
  assert.equal(effectiveSandbox(app({ sandbox: 'confined', sandboxPref: 'none' })), 'none', 'the user can opt out');
  assert.equal(effectiveSandbox(app({ sandboxPref: 'offline' })), 'offline');
  assert.equal(effectiveSandbox(app()), 'none');

  assert.equal(isSandboxed(app({ sandbox: 'confined' })), true);
  assert.equal(isSandboxed(app({ sandbox: 'confined', sandboxPref: 'none' })), false);
  assert.match(sandboxNote('offline', app()), /network is cut/);
  assert.match(sandboxNote('inherit', app({ sandbox: 'confined' })), /fresh home/);
});

test('the options sheet renders both controls and preselects the current values', () => {
  const a = app({ sandbox: 'confined' });
  const draft = { updatePolicy: 'inherit', envRows: [], launchArgsText: '', keepAlive: true, sandbox: 'offline' };
  const html = renderAppOptions(a, draft, { caps: {} });
  assert.match(html, /Watchdog &amp; sandbox/);
  assert.match(html, /data-pref="keepAlive" checked/);
  assert.match(html, new RegExp(KEEP_ALIVE_NOTE));
  assert.match(html, /data-pref="sandbox"/);
  assert.match(html, /Inherit \(overlay: confined\)/, 'the inherit option names the overlay’s profile');
  assert.match(html, /<option value="offline" selected>/);
  assert.match(html, /bwrap/, 'and says what it needs on PATH');

  // A build that cannot write prefs shows neither control.
  assert.ok(!renderAppOptions(a, draft, { caps: { setAppPref: false } }).includes('data-pref="sandbox"'));
});

test('a keep-alive app and a sandboxed one are marked on the card', () => {
  const plain = renderAppCard(app(), {});
  assert.ok(!plain.includes('keep-mark'));
  assert.ok(!plain.includes('sandbox-mark'));

  const guarded = renderAppCard(app({ keepAlive: true, sandbox: 'confined' }), {});
  assert.match(guarded, /class="keep-mark"/);
  assert.match(guarded, /restarts this app if it exits unexpectedly/);
  assert.match(guarded, /class="sandbox-mark"[^>]*>confined</);

  const offline = renderAppCard(app({ sandboxPref: 'offline' }), {});
  assert.match(offline, /no network from inside/);
  // Opting out of the overlay's profile takes the mark with it.
  assert.ok(!renderAppCard(app({ sandbox: 'confined', sandboxPref: 'none' }), {}).includes('sandbox-mark'));
});

/* ---------------------------------------------------- supervisor state */

const REV = { type: 'supervisor', appId: 'pulsenx', appName: 'PulseNX', artifactId: 'appimage-linux' };

test('folding a supervisor event keys it per artifact and keeps the numbers', () => {
  const map = foldSupervisor({}, { ...REV, action: 'restarting', attempt: 2, delayMs: 4000 }, 1000);
  const key = supervisorKey('pulsenx', 'appimage-linux');
  assert.deepEqual(Object.keys(map), [key]);
  assert.equal(map[key].action, 'restarting');
  assert.equal(map[key].attempt, 2);
  assert.equal(map[key].delayMs, 4000);
  assert.equal(map[key].appName, 'PulseNX');

  // Two artifacts of one app do not merge.
  const both = foldSupervisor(map, { ...REV, artifactId: 'apk-adb-android', action: 'gave-up', attempt: 5 }, 1000);
  assert.equal(Object.keys(both).length, 2);
  assert.equal(supervisorFor(both, 'pulsenx').length, 2);

  // Junk is ignored rather than parked as a blank row.
  assert.deepEqual(foldSupervisor({}, { ...REV, action: 'exploded' }, 1), {});
  assert.deepEqual(foldSupervisor({}, { action: 'restarting' }, 1), {}, 'no appId, no entry');
  assert.deepEqual(foldSupervisor({}, null, 1), {});
});

test('the story can go either way — a give-up replaces a retry and vice versa', () => {
  const key = supervisorKey('pulsenx', 'appimage-linux');
  let map = foldSupervisor({}, { ...REV, action: 'restarting', attempt: 4 }, 1000);
  map = foldSupervisor(map, { ...REV, action: 'gave-up', attempt: 5 }, 2000);
  assert.equal(map[key].action, 'gave-up');
  assert.equal(Object.keys(map).length, 1, 'one artifact, one entry');
  // The user relaunched it and the watchdog is trying again.
  map = foldSupervisor(map, { ...REV, action: 'restarting', attempt: 1 }, 3000);
  assert.equal(map[key].action, 'restarting');
});

test('a restarting line clears when the app reports in, or when it ages out', () => {
  const now = 100000;
  const map = foldSupervisor({}, { ...REV, action: 'restarting', attempt: 1 }, now);

  // Still fresh, nothing on the bus: it stays.
  assert.equal(Object.keys(pruneSupervisor(map, { now: now + 1000, live: new Map() })).length, 1);

  // The relaunch reported in — a client whose presence STARTED after the event.
  const fresh = new Map([['pulsenx', { since: new Date(now + 500).toISOString() }]]);
  assert.deepEqual(pruneSupervisor(map, { now: now + 1000, live: fresh }), {}, 'that is the state pull showing it live');

  // A client that was already announced BEFORE the restart proves nothing —
  // it is a stale roster entry, not evidence the relaunch worked.
  const stale = new Map([['pulsenx', { since: new Date(now - 60000).toISOString() }]]);
  assert.equal(Object.keys(pruneSupervisor(map, { now: now + 1000, live: stale })).length, 1);

  // And with nothing on the bus at all, it simply ages out.
  assert.equal(Object.keys(pruneSupervisor(map, { now: now + RESTART_CLEAR_MS - 1 })).length, 1);
  assert.deepEqual(pruneSupervisor(map, { now: now + RESTART_CLEAR_MS }), {});

  // A bare Set means "presence is proof" — the shape unit tests use.
  assert.deepEqual(pruneSupervisor(map, { now: now + 1, live: new Set(['pulsenx']) }), {});
  assert.deepEqual(pruneSupervisor(map, { now: now + 1, live: ['pulsenx'] }), {});
});

test('a give-up never ages out — only a dismissal removes it', () => {
  const key = supervisorKey('pulsenx', 'appimage-linux');
  const map = foldSupervisor({}, { ...REV, action: 'gave-up', attempt: 5 }, 1000);
  assert.equal(Object.keys(pruneSupervisor(map, { now: 1000 + RESTART_CLEAR_MS * 10 })).length, 1);
  assert.equal(
    Object.keys(pruneSupervisor(map, { now: 2000, live: new Set(['pulsenx']) })).length,
    1,
    'even a live app keeps the banner — the user has to acknowledge it'
  );
  assert.deepEqual(dismissSupervisor(map, key), {});
  assert.equal(Object.keys(dismissSupervisor(map, 'nope')).length, 1);
});

test('the watchdog’s two sentences say what happened and what to do next', () => {
  assert.equal(restartingLine({ attempt: 2 }), 'Restarting — attempt 2…');
  assert.equal(restartingLine({}), 'Restarting…');
  const text = gaveUpText({ appName: 'PulseNX', attempt: 5 });
  assert.match(text, /PulseNX kept exiting/);
  assert.match(text, /after 5 attempts/);
  assert.match(text, /Start it by hand/, 'and what to do about it');
  assert.match(text, /Keep alive/);
  assert.match(gaveUpText({ appId: 'x', attempt: 1 }), /1 attempt\b/, 'singular when it is one');
});

test('the card shows a restart as a line and a give-up as a dismissable banner', () => {
  const now = Date.now();
  const restarting = foldSupervisor({}, { ...REV, action: 'restarting', attempt: 2 }, now);
  const line = renderAppCard(app(), { supervisor: restarting });
  assert.match(line, /class="sup-line"/);
  assert.match(line, /Restarting — attempt 2…/);
  assert.ok(!line.includes('banner-sup'), 'a retry is not an alarm');

  const gaveUp = foldSupervisor({}, { ...REV, action: 'gave-up', attempt: 5 }, now);
  const banner = renderAppCard(app(), { supervisor: gaveUp });
  assert.match(banner, /banner banner-warn banner-sup/, 'amber, because the user must decide something');
  assert.match(banner, /data-act="dismiss-supervisor"/);
  assert.match(banner, /data-sup="pulsenx::appimage-linux"/);

  // Another app's news never lands on this card.
  const other = foldSupervisor({}, { ...REV, appId: 'wivrn-nx' }, now);
  assert.ok(!renderAppCard(app(), { supervisor: { ...other } }).includes('sup-line'));

  // A name off another program is escaped like everything else.
  const evil = foldSupervisor({}, { ...REV, appName: '<img src=x>', action: 'gave-up' }, now);
  assert.ok(!renderSupervisorBanner(Object.values(evil)[0]).includes('<img src=x>'));
  assert.ok(!renderSupervisorLine({ key: '"><b>', attempt: 1 }).includes('"><b>'));
});

/* ------------------------------------------------------ signed releases */

const SIGNED = normalizeArtifact({ id: 'a', label: 'Linux app', platform: 'linux', hasSignature: true });
const UNSIGNED = normalizeArtifact({ id: 'b', label: 'Blender addon', platform: 'linux' });

test('hasSignature is always present on the model — absent reads as false', () => {
  assert.equal(SIGNED.hasSignature, true);
  assert.equal(UNSIGNED.hasSignature, false);
  assert.equal(normalizeArtifact({ id: 'c', hasSignature: 'yes' }).hasSignature, true);
});

test('the shield matrix: signed always marks, unsigned only under the strict setting', () => {
  const relaxed = normalizeSettings({ requireSignatures: false });
  const strict = normalizeSettings({ requireSignatures: true });

  // signed × relaxed → the violet shield
  const a = signatureMark(SIGNED, relaxed);
  assert.match(a, /sig-mark sig-ok/);
  assert.match(a, /cryptographically signed release/);

  // signed × strict → the same shield; a signature is a property of the asset
  assert.match(signatureMark(SIGNED, strict), /sig-mark sig-ok/);

  // unsigned × relaxed → nothing at all. Most of GitHub is unsigned.
  assert.equal(signatureMark(UNSIGNED, relaxed), '');

  // unsigned × strict → the muted struck-through shield
  const d = signatureMark(UNSIGNED, strict);
  assert.match(d, /sig-mark sig-none/);
  assert.match(d, /no signature/);
  assert.match(d, /refused/, 'and says what the setting does about it');

  // Missing settings behave like the relaxed default.
  assert.equal(signatureMark(UNSIGNED, undefined), '');
  assert.equal(signatureMark(null, strict), signatureMark(UNSIGNED, strict), 'no artifact reads as unsigned');
});

test('the mark rides on the artifact row and therefore on the card', () => {
  const a = app({
    artifacts: [
      { id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage', hasSignature: true },
      { id: 'zip-linux', label: 'Sources', platform: 'linux', kind: 'archive-dir' },
    ],
  });
  const relaxed = renderAppCard(a, { settings: normalizeSettings({}) });
  assert.equal((relaxed.match(/sig-ok/g) || []).length, 1, 'one signed row, one shield');
  assert.ok(!relaxed.includes('sig-none'));

  const strict = renderAppCard(a, { settings: normalizeSettings({ requireSignatures: true }) });
  assert.equal((strict.match(/sig-ok/g) || []).length, 1);
  assert.equal((strict.match(/sig-none/g) || []).length, 1, 'and now the unsigned one is called out');

  // The row renderer is what carries it (the card only passes settings down).
  const row = renderArtifactRow(a, a.artifacts[1], { settings: normalizeSettings({ requireSignatures: true }) });
  assert.match(row, /sig-none/);
});

test('the setting lives under Updates and round-trips through the panel', () => {
  const html = renderSettingsPanel({ requireSignatures: true, owners: [], extraRepos: [] }, {});
  assert.match(html, /data-field="requireSignatures" checked/);
  assert.match(html, /Require signed releases/);
  assert.match(html, /refuse unsigned assets from trusted publishers/);
  // …under Updates, i.e. after that heading and before Startup.
  const i = html.indexOf('data-field="requireSignatures"');
  assert.ok(i > html.indexOf('<h3>Updates</h3>') && i < html.indexOf('Startup'), 'it sits in the Updates section');

  assert.ok(!renderSettingsPanel({ owners: [], extraRepos: [] }, {}).includes('requireSignatures" checked'));
  assert.equal(normalizeSettings({}).requireSignatures, false, 'SPEC default: off');
});

/* ------------------------------------------------------------- the mock */

test('the mock ships signed and unsigned artifacts, a guarded app and both watchdog endings', async () => {
  const { nxhub, dev } = createMock();
  const state = await nxhub.getState();
  const arts = state.apps.flatMap((a) => a.artifacts || []);
  assert.ok(arts.some((a) => a.hasSignature), 'signed rows exist');
  assert.ok(arts.some((a) => !a.hasSignature), 'and unsigned ones, so the strict setting has something to say');
  assert.equal(state.settings.requireSignatures, false);
  assert.equal(dev.toggleRequireSignatures(), true);
  assert.equal((await nxhub.getState()).settings.requireSignatures, true);

  const pulse = state.apps.find((a) => a.id === 'pulsenx');
  assert.equal(pulse.keepAlive, true, 'a background bridge is the natural keepAlive app');
  const wivrn = state.apps.find((a) => a.id === 'wivrn-nx');
  assert.equal(wivrn.sandbox, 'confined');
  assert.ok((wivrn.configPaths || []).length, 'and it names the config the snapshots cover');

  const seen = [];
  nxhub.onEvent((ev) => seen.push(ev));
  dev.simulateSupervisor('restarting');
  assert.equal(seen.filter((e) => e.type === 'supervisor').length, 1);
  assert.equal(seen.at(-1).action, 'restarting');
  assert.ok(!seen.some((e) => e.type === 'toast'), 'a retry does not toast');

  dev.simulateSupervisor('gave-up');
  const sup = seen.filter((e) => e.type === 'supervisor');
  assert.equal(sup.at(-1).action, 'gave-up');
  assert.equal(sup.at(-1).attempt, 5);
  assert.equal(
    seen.filter((e) => e.type === 'toast').length,
    1,
    'main toasts the give-up itself — that is why the renderer must not'
  );

  // Both endings also reach the recorder.
  const recorded = dev.events().filter((e) => e.type === 'supervisor');
  assert.ok(recorded.some((e) => e.data && e.data.action === 'gave-up'));
  dev.stop();
});
