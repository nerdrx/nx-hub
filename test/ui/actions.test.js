import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artifactActions, isLaunchable, detectPlatform, platformLabel } from '../../src/renderer/lib/actions.js';
import { normalizeArtifact, normalizeApp } from '../../src/renderer/lib/model.js';

const APP = normalizeApp({ id: 'demo', repo: 'nerdrx/demo', name: 'Demo', latest: { version: '2.0.0' } });
const ADB_ON = { connected: true, devices: [{ serial: 'PA7X', model: 'Pico 4 Ultra', state: 'device' }], versions: {} };
const ADB_OFF = { connected: false, devices: [], versions: {} };

function art(over) {
  return normalizeArtifact({ id: 'appimage-linux', label: 'Linux app', platform: 'linux', kind: 'appimage', ...over }, '2.0.0');
}
const labels = (r) => r.buttons.map((b) => b.label);
const variants = (r) => r.buttons.map((b) => b.variant);

test('not installed → a single violet Install', () => {
  const r = artifactActions(APP, art(), { platform: 'linux' });
  assert.deepEqual(labels(r), ['Install']);
  assert.deepEqual(variants(r), ['violet']);
  assert.equal(r.buttons[0].disabled, false);
  // No uninstall/show-in-folder before an install exists; the v0.2 entries
  // (version history, per-app options) are always offered.
  assert.deepEqual(r.menu.map((m) => m.act), ['versions', 'app-options', 'github']);
});

test('installed + update → amber Update first, then a secondary Launch', () => {
  const r = artifactActions(APP, art({ installed: { version: '1.0.0', path: '/x' } }), { platform: 'linux' });
  assert.deepEqual(labels(r), ['Update', 'Launch']);
  assert.deepEqual(variants(r), ['amber', 'ghost']);
  assert.equal(r.update, true);
  assert.deepEqual(r.menu.map((m) => m.act), ['uninstall', 'folder', 'versions', 'app-options', 'github']);
});

test('installed + current → outlined Launch plus the overflow menu', () => {
  const r = artifactActions(APP, art({ installed: { version: '2.0.0', path: '/x' } }), { platform: 'linux' });
  assert.deepEqual(labels(r), ['Launch']);
  assert.deepEqual(variants(r), ['outline']);
  assert.equal(r.current, true);
  assert.deepEqual(r.menu.map((m) => m.label), [
    'Uninstall',
    'Show in folder',
    'Version history…',
    'App options…',
    'Open GitHub page',
  ]);
});

test('windows artifact on linux → disabled install with the hub-on-Windows tooltip', () => {
  const a = art({ id: 'windows-zip-windows', platform: 'windows', kind: 'windows-zip' });
  const r = artifactActions(APP, a, { platform: 'linux' });
  assert.deepEqual(labels(r), ['Install']);
  assert.equal(r.buttons[0].disabled, true);
  assert.match(r.buttons[0].title, /install from the hub on Windows/);
});

test('windows artifact on win32 → normal install', () => {
  const a = art({ id: 'windows-zip-windows', platform: 'windows', kind: 'windows-zip' });
  const r = artifactActions(APP, a, { platform: 'win32' });
  assert.equal(r.buttons[0].disabled, false);
});

test('apk-adb reports the connected device and stays enabled', () => {
  const a = art({ id: 'apk-adb-android', platform: 'android', kind: 'apk-adb', packageId: 'com.x' });
  const r = artifactActions(APP, a, { platform: 'linux', adb: ADB_ON });
  assert.match(r.hint, /Pico 4 Ultra/);
  assert.equal(r.buttons[0].disabled, false);
});

test('apk-adb without a device → hint + disabled action', () => {
  const a = art({ id: 'apk-adb-android', platform: 'android', kind: 'apk-adb', installed: { version: '1.0.0' } });
  const r = artifactActions(APP, a, { platform: 'linux', adb: ADB_OFF });
  assert.match(r.hint, /no headset connected/);
  assert.equal(r.buttons[0].disabled, true);
  assert.equal(r.buttons[0].title, 'no headset connected');
  // Android installs have no local folder to show.
  assert.deepEqual(r.menu.map((m) => m.act), ['uninstall', 'versions', 'app-options', 'github']);
});

test('a running job disables every button for that app', () => {
  const a = art({ installed: { version: '1.0.0', path: '/x' } });
  const r = artifactActions(APP, a, { platform: 'linux', job: { id: 'j1', phase: 'download', pct: 10 } });
  assert.equal(r.busy, true);
  assert.ok(r.buttons.every((b) => b.disabled));
  assert.match(r.buttons[0].title, /already running/);
});

test('non-launchable kinds hide Launch entirely', () => {
  assert.equal(isLaunchable(art({ kind: 'blender-addon' })), false);
  assert.equal(isLaunchable(art({ kind: 'generic-zip' })), false);
  assert.equal(isLaunchable(art({ kind: 'appimage' })), true);
  assert.equal(isLaunchable(normalizeArtifact({ kind: 'tarball-prefix', launchable: false })), false);

  const addon = art({ id: 'blender-addon-linux', kind: 'blender-addon', installed: { version: '2.0.0', path: '/x' } });
  const r = artifactActions(APP, addon, { platform: 'linux' });
  assert.deepEqual(labels(r), []);
  assert.deepEqual(r.menu.map((m) => m.act), ['uninstall', 'folder', 'versions', 'app-options', 'github']);
});

test('an outdated non-launchable artifact still offers Update only', () => {
  const addon = art({ kind: 'blender-addon', installed: { version: '1.0.0', path: '/x' } });
  const r = artifactActions(APP, addon, { platform: 'linux' });
  assert.deepEqual(labels(r), ['Update']);
});

test('missing artifact does not throw', () => {
  const r = artifactActions(APP, null, {});
  assert.deepEqual(r.buttons, []);
  assert.equal(r.menu, null);
});

test('platform helpers', () => {
  assert.equal(platformLabel('android'), 'android');
  assert.equal(platformLabel(undefined), 'linux');
  assert.equal(detectPlatform({ platform: 'Win32', userAgent: 'Mozilla' }), 'win32');
  assert.equal(detectPlatform({ platform: 'Linux x86_64', userAgent: 'X11' }), 'linux');
  assert.equal(detectPlatform({ userAgentData: { platform: 'macOS' } }), 'darwin');
  assert.equal(detectPlatform({}), 'linux');
});
