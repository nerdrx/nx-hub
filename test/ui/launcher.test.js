import { test } from 'node:test';
import assert from 'node:assert/strict';

import { launchTiles, tileMenu, monogram, tileHue, defaultView } from '../../src/renderer/lib/launcher.js';
import { renderTile, renderLaunchGrid, renderLaunchEmpty, iconSrc } from '../../src/renderer/views/tile.js';
import { normalizeState, normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const ADB_ON = { connected: true, devices: [{ serial: 'PA7X', model: 'Pico 4 Ultra', state: 'device' }], versions: {} };
const ADB_OFF = { connected: false, devices: [], versions: {} };

function app(id, artifacts, over = {}) {
  return normalizeApp({
    id,
    repo: `nerdrx/${id}`,
    name: over.name || id,
    latest: { version: '2.0.0' },
    artifacts,
    ...over,
  });
}

/* ------------------------------------------------------------- selection */

test('only installed, launchable artifacts become tiles', () => {
  const apps = [
    app('a', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/a' } }]),
    app('b', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage' }]), // not installed
    app('c', [{ id: 'blender-addon-linux', label: 'Addon', platform: 'linux', kind: 'blender-addon', installed: { version: '2.0.0' } }]),
    app('d', [{ id: 'x', label: 'X', platform: 'linux', kind: 'archive-dir', installed: { version: '1' }, launchable: false }]),
  ];
  assert.deepEqual(launchTiles(apps, { adb: ADB_ON }).map((t) => t.appId), ['a']);
});

test('unpublished apps and junk input never produce tiles', () => {
  assert.deepEqual(launchTiles(null), []);
  assert.deepEqual(launchTiles([null, undefined]), []);
  assert.deepEqual(launchTiles([app('u', [], { unpublished: true })]), []);
});

test('one launchable artifact → a single tile with no sublabel', () => {
  const tiles = launchTiles(
    [app('pulsenx', [{ id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/p' } }], { name: 'PulseNX' })],
    { adb: ADB_ON }
  );
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].sublabel, '');
  assert.equal(tiles[0].name, 'PulseNX');
  assert.equal(tiles[0].key, 'pulsenx::appimage-linux');
});

test('several launchable artifacts → one tile each, with platform sublabels', () => {
  const tiles = launchTiles(
    [
      app(
        'wivrn-nx',
        [
          { id: 'apk-adb-android', label: 'APK', platform: 'android', kind: 'apk-adb', installed: { version: '2.0.0' } },
          { id: 'tarball-prefix-linux', label: 'Server', platform: 'linux', kind: 'tarball-prefix', installed: { version: '2.0.0', path: '/l' } },
        ],
        { name: 'WiVRn NX' }
      ),
    ],
    { adb: ADB_ON }
  );
  assert.equal(tiles.length, 2);
  assert.deepEqual(tiles.map((t) => t.sublabel), ['android', 'linux']);
  assert.ok(tiles.every((t) => t.name === 'WiVRn NX'));
});

test('apk tiles are disabled while no device is connected', () => {
  const apps = [app('w', [{ id: 'apk-adb-android', label: 'APK', platform: 'android', kind: 'apk-adb', installed: { version: '2.0.0' } }])];
  const on = launchTiles(apps, { adb: ADB_ON })[0];
  const off = launchTiles(apps, { adb: ADB_OFF })[0];
  assert.equal(on.disabled, false);
  assert.equal(off.disabled, true);
  assert.equal(off.disabledReason, 'no device');
  assert.match(off.title, /no headset connected/);
  // A missing adb block must not enable android tiles by accident.
  assert.equal(launchTiles(apps, {})[0].disabled, true);
});

test('desktop tiles ignore the adb state entirely', () => {
  const apps = [app('a', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/a' } }])];
  assert.equal(launchTiles(apps, { adb: ADB_OFF })[0].disabled, false);
});

test('update availability rides along for the amber dot', () => {
  const tiles = launchTiles(
    [app('a', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '1.0.0', path: '/a' } }])],
    { adb: ADB_ON }
  );
  assert.equal(tiles[0].updateAvailable, true);
});

test('iconPath is optional — absence is not an error', () => {
  const withIcon = launchTiles(
    [app('a', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/a', iconPath: '/a/icon.png' } }])],
    { adb: ADB_ON }
  )[0];
  const without = launchTiles(
    [app('b', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/b' } }])],
    { adb: ADB_ON }
  )[0];
  assert.equal(withIcon.iconPath, '/a/icon.png');
  assert.equal(without.iconPath, '');
  assert.ok(without.monogram.length >= 1);
});

/* ---------------------------------------------------------- monogram/hue */

test('monogram picks readable initials', () => {
  assert.equal(monogram('WiVRn NX'), 'WN');
  assert.equal(monogram('QuadForge'), 'QF');
  assert.equal(monogram('PulseNX'), 'PN');
  assert.equal(monogram('nxtakt'), 'NX');
  assert.equal(monogram('LIMBO PROTOCOL'), 'LP');
  assert.equal(monogram(''), '?');
  assert.equal(monogram(null), '?');
});

test('tileHue is deterministic and stays inside the brand range', () => {
  for (const id of ['wivrn-nx', 'pulsenx', 'quadforge', 'nx-hub', '']) {
    const h = tileHue(id);
    assert.equal(h, tileHue(id), 'stable across calls');
    assert.ok(h >= 187 && h <= 290, `${id} → ${h}`);
  }
  assert.notEqual(tileHue('pulsenx'), tileHue('quadforge'));
});

/* ------------------------------------------------------------ menu/view */

test('tile menu adapts to the artifact', () => {
  const desktop = { appId: 'a', artifactId: 'x', platform: 'linux', path: '/a' };
  assert.deepEqual(tileMenu(desktop).map((m) => m.label), ['Launch', 'Show in folder', 'Manage']);

  const android = { appId: 'a', artifactId: 'x', platform: 'android', path: '', disabled: true };
  const menu = tileMenu(android);
  assert.deepEqual(menu.map((m) => m.label), ['Launch', 'Manage']);
  assert.equal(menu[0].disabled, true);
  assert.deepEqual(tileMenu(null), []);
});

test('defaultView opens the launcher only when something is installed', () => {
  assert.equal(defaultView([{ key: 'a' }]), 'launch');
  assert.equal(defaultView([]), 'manage');
  assert.equal(defaultView(null), 'manage');
});

/* -------------------------------------------------------------- renderers */

test('iconSrc builds a file URL, and refuses nonsense', () => {
  assert.equal(iconSrc('/home/x/icon.png'), 'file:///home/x/icon.png');
  assert.equal(iconSrc('file:///home/x/icon.png'), 'file:///home/x/icon.png');
  assert.equal(iconSrc('relative/icon.png'), '');
  assert.equal(iconSrc(''), '');
  assert.equal(iconSrc(null), '');
  assert.ok(!iconSrc('/home/x/a b.png').includes(' '));
});

test('a tile with an icon renders an img with a monogram fallback attribute', () => {
  const [tile] = launchTiles(
    [app('pulsenx', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/p', iconPath: '/p/icon.png' } }], { name: 'PulseNX' })],
    { adb: ADB_ON }
  );
  const out = renderTile(tile);
  assert.ok(out.includes('<img class="tile-icon" src="file:///p/icon.png"'));
  assert.ok(out.includes('data-fallback="PN"'));
  assert.ok(out.includes('data-act="tile-launch"'));
});

test('a tile without an icon renders the monogram with its hue', () => {
  const [tile] = launchTiles(
    [app('quadforge', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '1.0.0', path: '/q' } }], { name: 'QuadForge' })],
    { adb: ADB_ON }
  );
  const out = renderTile(tile);
  assert.ok(out.includes('tile-mono'));
  assert.ok(out.includes(`--h:${tileHue('quadforge')}`));
  assert.ok(out.includes('tile-dot'), 'update dot');
  assert.ok(!out.includes('<img'));
});

test('a disabled tile says why and cannot be clicked', () => {
  const [tile] = launchTiles(
    [app('w', [{ id: 'apk-adb-android', label: 'APK', platform: 'android', kind: 'apk-adb', installed: { version: '2.0.0' } }])],
    { adb: ADB_OFF }
  );
  const out = renderTile(tile);
  assert.ok(out.includes('is-disabled'));
  assert.ok(out.includes('disabled'));
  assert.ok(out.includes('no device'));
});

test('tile menus open only for the selected tile', () => {
  const [tile] = launchTiles(
    [app('a', [{ id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '/a' } }])],
    { adb: ADB_ON }
  );
  assert.ok(!renderTile(tile).includes('role="menu"'));
  const open = renderTile(tile, { openMenu: tile.key });
  assert.ok(open.includes('role="menu"'));
  assert.ok(open.includes('data-act="manage-jump"'));
});

test('hostile app names cannot inject markup into a tile', () => {
  const [tile] = launchTiles(
    [app('evil', [{ id: 'appimage-linux', label: '<b>', platform: 'linux', kind: 'appimage', installed: { version: '2.0.0', path: '"><script>x</script>' } }], { name: '<img src=x onerror=alert(1)>' })],
    { adb: ADB_ON }
  );
  const out = renderTile(tile, { openMenu: tile.key });
  assert.ok(!out.includes('<img src=x'));
  assert.ok(!out.includes('<script'));
});

test('launch grid and empty states', () => {
  assert.ok(renderLaunchGrid([]).includes('Nothing installed yet'));
  assert.ok(renderLaunchGrid([], { filter: 'zz' }).includes('Nothing installed matches'));
  assert.ok(renderLaunchEmpty('').includes('data-view="manage"'));
  assert.ok(renderLaunchEmpty('<b>').includes('&lt;b&gt;'));
});

/* ---------------------------------------------------------- mock coverage */

test('the mock roster produces a useful launcher', async () => {
  const { nxhub } = createMock();
  const state = normalizeState(await nxhub.getState());
  const tiles = launchTiles(state.apps, { adb: state.adb });

  assert.ok(tiles.length >= 4, `expected several tiles, got ${tiles.length}`);
  assert.ok(tiles.some((t) => t.iconPath), 'one tile has an iconPath');
  assert.ok(tiles.filter((t) => !t.iconPath).length >= 2, 'several monogram tiles');
  assert.ok(tiles.some((t) => t.updateAvailable), 'an update dot is reachable');
  assert.ok(tiles.some((t) => t.sublabel), 'a multi-artifact app shows sublabels');
  assert.ok(tiles.some((t) => t.platform === 'android'), 'an apk tile exists');

  const html = renderLaunchGrid(tiles);
  assert.ok(html.includes('tiles-grid'));
  assert.ok(html.includes('tile-mono'));
  assert.ok(html.includes('<img class="tile-icon"'));
});

test('toggling the mock device disables/enables the apk tiles', async () => {
  const { nxhub, dev } = createMock();
  dev.toggleAdb();
  let state = normalizeState(await nxhub.getState());
  assert.ok(launchTiles(state.apps, { adb: state.adb }).filter((t) => t.platform === 'android').every((t) => t.disabled));

  dev.toggleAdb();
  state = normalizeState(await nxhub.getState());
  assert.ok(launchTiles(state.apps, { adb: state.adb }).filter((t) => t.platform === 'android').every((t) => !t.disabled));
});
