import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAppCard,
  renderArtifactRow,
  renderUnpublishedCard,
  renderJobBar,
  renderPostInstallNote,
  renderTokenHint,
  renderRateLimitBanner,
  renderSkeletonCard,
  renderEmpty,
  extractCommand,
  artifactKey,
} from '../../src/renderer/views/card.js';
import { renderSettingsPanel } from '../../src/renderer/views/settings.js';
import { normalizeState, normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const SETTINGS = { owners: ['nerdrx'], extraRepos: ['WiVRn/WiVRn'] };
const ADB = { connected: true, devices: [{ serial: 'PA7X', model: 'Pico 4 Ultra', state: 'device' }], versions: {} };

async function mockState() {
  const { nxhub } = createMock();
  return normalizeState(await nxhub.getState());
}

/* ------------------------------------------------------- roster smoke test */

test('every card of the real roster renders without throwing', async () => {
  const state = await mockState();
  assert.ok(state.apps.length >= 8, `roster has ${state.apps.length} apps`);
  for (const app of state.apps) {
    const out = app.unpublished
      ? renderUnpublishedCard(app)
      : renderAppCard(app, { settings: state.settings, adb: state.adb, platform: 'linux' });
    assert.ok(out.includes('<article'), app.id);
    assert.ok(out.includes(app.name.replace(/&/g, '&amp;')), app.id);
  }
});

test('the roster covers install / update / launch / windows / unpublished states', async () => {
  const state = await mockState();
  const html = state.apps
    .map((a) =>
      a.unpublished
        ? renderUnpublishedCard(a)
        : renderAppCard(a, { settings: state.settings, adb: state.adb, platform: 'linux' })
    )
    .join('');
  assert.ok(html.includes('>Install<'), 'an Install button exists');
  assert.ok(html.includes('>Update<'), 'an Update button exists');
  assert.ok(html.includes('>Launch<'), 'a Launch button exists');
  assert.ok(html.includes('install from the hub on Windows'), 'windows rows are explained');
  assert.ok(html.includes('this app'), 'the hub card is labelled');
  assert.ok(html.includes('Open GitHub'), 'unpublished cards link out');
  assert.ok(html.includes('badge-owner'), 'the pinned upstream repo shows an owner badge');
  assert.ok(html.includes('class="lock"'), 'private repos show the lock glyph');
});

/* --------------------------------------------------------------- escaping */

test('hostile repo metadata cannot inject markup', () => {
  const app = normalizeApp({
    id: 'evil',
    repo: 'x/"><script>alert(1)</script>',
    name: '<img src=x onerror=alert(1)>',
    tagline: '"><b>bold</b>',
    latest: { version: '<i>1</i>', publishedAt: '2026-08-01T00:00:00Z', notes: '' },
    artifacts: [{ id: 'a', label: '</div><script>x</script>', platform: 'linux', kind: 'appimage' }],
  });
  const out = renderAppCard(app, { settings: SETTINGS, platform: 'linux' });
  assert.ok(!out.includes('<script'), out.slice(0, 200));
  assert.ok(!out.includes('<img src=x'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('release notes are rendered through the safe markdown path', () => {
  const app = normalizeApp({
    id: 'x',
    repo: 'o/x',
    name: 'X',
    latest: { version: '1.0.0', publishedAt: '2026-08-01T00:00:00Z', notes: '# Hi\n<script>bad()</script>\n- one' },
    artifacts: [],
  });
  const closed = renderAppCard(app, { settings: SETTINGS });
  assert.ok(closed.includes('Release notes'));
  assert.ok(!closed.includes('<h3>Hi</h3>'), 'notes stay collapsed by default');

  const open = renderAppCard(app, { settings: SETTINGS, expandedNotes: ['x'] });
  assert.ok(open.includes('<h3>Hi</h3>'));
  assert.ok(open.includes('<li>one</li>'));
  assert.ok(!open.includes('<script>bad'));
});

/* ------------------------------------------------------------- job + note */

test('job bar shows phase, percent, speed and a cancel control', () => {
  const bar = renderJobBar({ id: 'j1', phase: 'download', pct: 43, message: '12.3 MB/s' });
  assert.ok(bar.includes('Downloading 43% — 12.3 MB/s'));
  assert.ok(bar.includes('style="width:43%"'));
  assert.ok(bar.includes('data-act="cancel"'));
  assert.ok(bar.includes('data-job="j1"'));
  assert.equal(renderJobBar(null), '');
});

test('an unknown percentage renders an indeterminate bar', () => {
  const bar = renderJobBar({ id: 'j2', phase: 'extract', pct: -1, message: '' });
  assert.ok(bar.includes('bar-indeterminate'));
  assert.ok(bar.includes('Extracting'));
});

test('a running job replaces the artifact row buttons with progress', () => {
  const app = normalizeApp({
    id: 'x',
    repo: 'o/x',
    name: 'X',
    latest: { version: '1.0.0' },
    artifacts: [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage' }],
  });
  const out = renderAppCard(app, {
    settings: SETTINGS,
    job: { id: 'j9', appId: 'x', artifactId: 'appimage-linux', phase: 'install', pct: 80, message: '' },
  });
  assert.ok(out.includes('data-job="j9"'));
  assert.ok(out.includes('disabled'), 'buttons are disabled while the job runs');
});

test('post-install note renders with a copy-to-clipboard command', () => {
  const app = normalizeApp({
    id: 'wivrn-nx',
    repo: 'nerdrx/wivrn-nx',
    name: 'WiVRn NX',
    latest: { version: '1.9.2' },
    artifacts: [
      {
        id: 'tarball-prefix-linux',
        label: 'Linux server',
        platform: 'linux',
        kind: 'tarball-prefix',
        postInstallNote: 'Re-run: sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server (required after every update)',
        installed: { version: '1.9.2', path: '/home/x/.local' },
      },
    ],
  });
  const out = renderAppCard(app, { settings: SETTINGS, platform: 'linux' });
  assert.ok(out.includes('pin-note'));
  assert.ok(out.includes('data-act="copy"'));
  assert.ok(out.includes('data-copy="sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server"'));
  assert.ok(out.includes('data-act="dismiss-note"'));

  const dismissed = renderAppCard(app, {
    settings: SETTINGS,
    dismissedNotes: [artifactKey('wivrn-nx', 'tarball-prefix-linux')],
  });
  assert.ok(!dismissed.includes('pin-note'));
});

test('a note is only shown once the artifact is actually installed', () => {
  const app = normalizeApp({
    id: 'x',
    repo: 'o/x',
    name: 'X',
    latest: { version: '1.0.0' },
    artifacts: [{ id: 'a', label: 'L', platform: 'linux', kind: 'tarball-prefix', postInstallNote: 'do the thing' }],
  });
  assert.ok(!renderAppCard(app, { settings: SETTINGS }).includes('pin-note'));
});

test('extractCommand pulls the runnable part out of a note', () => {
  assert.equal(
    extractCommand('Re-run: sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server (required after every update)'),
    'sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server'
  );
  assert.equal(extractCommand('Run `adb devices` first'), 'adb devices');
  assert.equal(extractCommand('nothing to do here'), 'nothing to do here');
  assert.equal(extractCommand(''), '');
});

test('post-install note escapes its own content', () => {
  const html = renderPostInstallNote(
    { id: 'a' },
    { id: 'b', label: '<x>', postInstallNote: '<script>alert(1)</script>' }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

/* --------------------------------------------------------------- adb rows */

test('apk rows show the device model, or the no-headset hint', () => {
  const app = normalizeApp({
    id: 'wivrn-nx',
    repo: 'nerdrx/wivrn-nx',
    name: 'WiVRn NX',
    latest: { version: '1.9.2' },
    artifacts: [
      {
        id: 'apk-adb-android',
        label: 'Pico headset APK',
        platform: 'android',
        kind: 'apk-adb',
        packageId: 'org.meumeu.wivrn.nx',
        installed: { version: '1.8.0' },
      },
    ],
  });
  const artifact = app.artifacts[0];

  const on = renderArtifactRow(app, artifact, { adb: { ...ADB, versions: { 'org.meumeu.wivrn.nx': '1.8.5' } } });
  assert.ok(on.includes('Pico 4 Ultra'));
  assert.ok(on.includes('on device'), 'the live device version is flagged');
  assert.ok(on.includes('1.8.5 → 1.9.2'));

  const off = renderArtifactRow(app, artifact, { adb: { connected: false, devices: [], versions: {} } });
  assert.ok(off.includes('no headset connected'));
  assert.ok(off.includes('chip-android'));
});

test('an artifact from an older release is labelled against its own version', () => {
  const app = normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    latest: { version: '1.1.1', tag: 'v1.1.1' },
    artifacts: [
      {
        id: 'appimage-linux',
        label: 'PC dashboard (Linux)',
        platform: 'linux',
        kind: 'appimage',
        sourceVersion: '1.0.1',
        sourceTag: 'v1.0.1',
        fromOlderRelease: true,
        installed: { version: '1.0.1' },
      },
      {
        id: 'apk-adb-android',
        label: 'Android bridge APK',
        platform: 'android',
        kind: 'apk-adb',
        installed: { version: '1.1.1' },
      },
    ],
  });
  const [linux, android] = app.artifacts;
  assert.equal(linux.sourceVersion, '1.0.1', 'normalizeArtifact keeps the source version');
  assert.equal(linux.fromOlderRelease, true);
  assert.equal(linux.updateAvailable, false, 'it is current for the release that shipped it');

  const row = renderArtifactRow(app, linux, { platform: 'linux' });
  assert.ok(row.includes('1.0.1 · up to date'), `expected the row to read against 1.0.1: ${row}`);
  assert.ok(!row.includes('1.0.1 → 1.1.1'), 'the app-level version must not create a phantom update');
  assert.ok(row.includes('from v1.0.1'), 'the row says where it came from');
  assert.ok(row.includes("newest release didn't ship this platform"), 'and explains it on hover');

  // A platform the newest release DID ship keeps the plain label.
  const apk = renderArtifactRow(app, android, { platform: 'linux' });
  assert.ok(apk.includes('1.1.1 · up to date'));
  assert.ok(!apk.includes('art-src'), 'no marker when the artifact is from the latest release');
});

/* --------------------------------------------------- panels, banners, misc */

test('settings panel renders sources, token state and about', () => {
  const out = renderSettingsPanel(
    { owners: ['nerdrx'], extraRepos: ['WiVRn/WiVRn'], token: '', installRoot: '~/Applications', adbPath: 'adb', checkIntervalHours: 6 },
    { hubVersion: '0.1.0', tokenSource: 'gh' }
  );
  assert.ok(out.includes('type="password"'));
  assert.ok(out.includes('using gh CLI token'));
  assert.ok(out.includes('data-act="add-owner"'));
  assert.ok(out.includes('data-act="remove-repo"'));
  assert.ok(out.includes('data-act="check-hub"'));
  assert.ok(out.includes('0.1.0'));
  assert.ok(out.includes('data-act="save-settings"'));
  assert.ok(!out.includes('<script'));
});

test('settings panel surfaces a repo validation error', () => {
  const out = renderSettingsPanel({ owners: [], extraRepos: [] }, { repoError: 'bad "repo"' });
  assert.ok(out.includes('field-error'));
  assert.ok(out.includes('bad &quot;repo&quot;'));
  assert.ok(out.includes('none — add one below'));
});

test('token value is not leaked into an unescaped attribute', () => {
  const out = renderSettingsPanel({ token: '"><script>x</script>' }, {});
  assert.ok(!out.includes('<script>'));
});

test('rate-limit banner tells the user when to retry', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  const out = renderRateLimitBanner({ resetAt: now + 12 * 60000 }, now);
  assert.ok(out.includes('rate limit'));
  assert.ok(out.includes('12 minutes'));
  assert.ok(out.includes('data-act="refresh"'));
  assert.equal(renderRateLimitBanner(null), '');
});

test('token hint, skeleton and empty states', () => {
  assert.ok(renderTokenHint().includes('data-act="settings"'));
  assert.ok(renderSkeletonCard().includes('sk-title'));
  assert.ok(renderEmpty('').includes('No apps discovered'));
  const filtered = renderEmpty('<b>');
  assert.ok(filtered.includes('&lt;b&gt;'));
  assert.ok(filtered.includes('data-act="clear-filter"'));
});

test('unpublished cards are read-only', () => {
  const out = renderUnpublishedCard(normalizeApp({ id: 'nxtakt', repo: 'nerdrx/nxtakt', name: 'NxTakt', private: true }));
  assert.ok(out.includes('card-unpub'));
  assert.ok(out.includes('Open GitHub'));
  assert.ok(!out.includes('data-act="install"'));
  assert.ok(out.includes('class="lock"'));
});

/* ------------------------------------------------------------ mock bridge */

test('the mock implements the whole frozen surface', () => {
  const { nxhub } = createMock();
  for (const fn of [
    'getState',
    'refresh',
    'install',
    'uninstall',
    'launch',
    'cancelJob',
    'setSettings',
    'openExternal',
    'showInFolder',
    'onEvent',
  ]) {
    assert.equal(typeof nxhub[fn], 'function', `nxhub.${fn}`);
  }
});

test('mock uninstall/settings mutate state and notify listeners', async () => {
  const { nxhub } = createMock();
  const seen = [];
  const off = nxhub.onEvent((ev) => seen.push(ev.type));

  await nxhub.uninstall('pulsenx', 'appimage-linux');
  let state = normalizeState(await nxhub.getState());
  const pulse = state.apps.find((a) => a.id === 'pulsenx');
  assert.equal(pulse.artifacts.find((a) => a.id === 'appimage-linux').installed, null);

  await nxhub.setSettings({ owners: ['someone'], token: '' });
  state = normalizeState(await nxhub.getState());
  assert.deepEqual(state.settings.owners, ['someone']);
  assert.ok(seen.includes('state-changed'));
  off();
  await nxhub.uninstall('pulsenx', 'appimage-linux');
  assert.equal(seen.filter((t) => t === 'state-changed').length, 2, 'unsubscribe works');
});

test('mock dev helpers flip adb and produce updates', async () => {
  const { nxhub, dev } = createMock();
  dev.toggleAdb();
  assert.equal(normalizeState(await nxhub.getState()).adb.connected, false);
  dev.toggleAdb();
  assert.equal(normalizeState(await nxhub.getState()).adb.connected, true);

  dev.simulateUpdate();
  const state = normalizeState(await nxhub.getState());
  const hub = state.apps.find((a) => a.id === 'nx-hub');
  assert.ok(hub.artifacts.some((a) => a.updateAvailable), 'the hub itself now offers an update');
});
