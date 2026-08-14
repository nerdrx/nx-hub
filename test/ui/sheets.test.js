import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderAppOptions, renderArgsPreview } from '../../src/renderer/views/appoptions.js';
import { renderSheet, renderSheetLoading, renderSheetError } from '../../src/renderer/views/sheet.js';
import {
  renderAppCard,
  renderArtifactRow,
  renderHiddenSection,
  appMenuItems,
  appMenuKey,
} from '../../src/renderer/views/card.js';
import { artifactActions } from '../../src/renderer/lib/actions.js';
import { normalizeApp, normalizeState } from '../../src/renderer/lib/model.js';
import { envRows, joinArgs, normalizeAppPref } from '../../src/renderer/lib/prefs.js';
import { createMock } from '../../src/renderer/mock.js';

const APP = normalizeApp({
  id: 'wivrn-nx',
  repo: 'nerdrx/wivrn-nx',
  name: 'WiVRn NX',
  latest: { tag: 'v1.9.2', version: '1.9.2', publishedAt: '2026-08-11T00:00:00Z', notes: '' },
  artifacts: [
    { id: 'appimage-linux', label: 'Linux app', platform: 'linux', kind: 'appimage', installed: { version: '1.9.0', path: '/x' } },
  ],
});

function draftFrom(pref) {
  const p = normalizeAppPref(pref);
  return { ...p, launchArgsText: joinArgs(p.launchArgs), envRows: envRows(p.launchEnv) };
}

/* ------------------------------------------------------------- sheet shell */

test('the sheet shell has a backdrop, a labelled dialog and a close button', () => {
  const out = renderSheet({ title: 'T', subtitle: 'S', body: '<p>b</p>', foot: '<button>x</button>' });
  assert.match(out, /sheet-backdrop"[^>]*data-act="close-sheet"/);
  assert.match(out, /role="dialog" aria-modal="true" aria-label="T"/);
  assert.match(out, /<p>b<\/p>/);
  assert.match(out, /sheet-foot/);
  assert.match(renderSheet({ title: '<b>' }), /&lt;b&gt;/);
  assert.match(renderSheetLoading(), /spinner/);
  assert.match(renderSheetError('boom', { act: 'versions', appId: 'a', label: 'Retry' }), /data-act="versions"/);
});

/* ------------------------------------------------------------- app options */

test('the options sheet renders every pref with the right control', () => {
  const draft = draftFrom({
    updatePolicy: 'download',
    includePrereleases: true,
    favorite: true,
    hidden: false,
    launchArgs: ['--profile', 'living room'],
    launchEnv: { WIVRN_BITRATE: '80000000' },
  });
  const out = renderAppOptions(APP, draft, { settings: { updatePolicy: 'notify' } });

  assert.match(out, /data-pref="updatePolicy"/);
  assert.match(out, /value="download"\s+selected/);
  assert.match(out, /Use the global setting \(Notify me\)/, 'inherit spells out the global default');
  assert.match(out, /data-pref="includePrereleases"[^>]*checked/);
  assert.match(out, /data-pref="favorite"[^>]*checked/);
  assert.ok(!/data-pref="hidden"[^>]*checked/.test(out));
  assert.match(out, /data-pref="launchArgs"[^>]*value="--profile &#39;living room&#39;"/);
  assert.match(out, /data-env-key="0"[^>]*value="WIVRN_BITRATE"/);
  assert.match(out, /data-env-val="0"[^>]*value="80000000"/);
  assert.match(out, /data-act="env-add"/);
  assert.match(out, /data-act="env-remove"[^>]*data-index="0"/);
  assert.match(out, /data-act="save-app-prefs"[^>]*data-app="wivrn-nx"/);
});

test('skip controls flip between “skip this version” and “clear”', () => {
  const none = renderAppOptions(APP, draftFrom({}), {});
  assert.match(none, /data-act="skip-version"[^>]*data-version="1\.9\.2"/);
  assert.match(none, /Skip 1\.9\.2/);

  const skipped = renderAppOptions(APP, draftFrom({ skippedVersion: '1.9.2' }), {});
  assert.match(skipped, /skip-chip">1\.9\.2/);
  assert.match(skipped, /data-act="clear-skip"/);
  assert.ok(!skipped.includes('data-act="skip-version"'));

  const noRelease = renderAppOptions(normalizeApp({ id: 'x', repo: 'o/x', name: 'X' }), draftFrom({}), {});
  assert.match(noRelease, /No release to skip yet/);
});

test('the launch-args preview shows one chip per parsed word', () => {
  const preview = renderArgsPreview('--no-gpu --profile "living room"');
  assert.match(preview, /arg-chips/);
  assert.equal((preview.match(/class="arg-chip"/g) || []).length, 3);
  assert.match(preview, /living room/);
  assert.match(renderArgsPreview(''), /No extra arguments/);
  assert.match(renderArgsPreview('--x "open'), /field-error/);
  assert.ok(!renderArgsPreview('<script>alert(1)</script>').includes('<script>'));
});

test('an app with nothing launchable says so', () => {
  const out = renderAppOptions(APP, draftFrom({}), { launchable: false });
  assert.match(out, /nothing launchable/);
});

/* --------------------------------------------------------- card additions */

test('the card gained a Versions button, a ⋮ menu and the favorite star', () => {
  const plain = renderAppCard(APP, { settings: {}, prefs: {} });
  assert.match(plain, /data-act="versions"[^>]*data-app="wivrn-nx"/);
  assert.match(plain, /data-act="menu"[^>]*data-art="__app__"/);
  assert.ok(!plain.includes('fav-star'));

  const fav = renderAppCard(APP, { settings: {}, prefs: { 'wivrn-nx': { favorite: true } } });
  assert.match(fav, /fav-star/);
  assert.match(fav, /card-fav/);

  const open = renderAppCard(APP, { settings: {}, prefs: {}, openMenu: appMenuKey('wivrn-nx') });
  assert.match(open, /role="menu"/);
  assert.match(open, /data-act="app-options"/);
  assert.match(open, /data-act="hide-app"/);
  assert.match(open, /Add to favorites/);
});

test('the card menu shrinks when the bridge lacks the methods', () => {
  assert.deepEqual(appMenuItems(APP, null, {}).map((m) => m.act), [
    'versions',
    'app-options',
    'toggle-fav',
    'hide-app',
    'github',
  ]);
  assert.deepEqual(appMenuItems(APP, null, { getReleases: false, setAppPref: false }).map((m) => m.act), ['github']);
  assert.equal(appMenuItems(APP, { favorite: true }, {})[2].label, 'Remove from favorites');

  const out = renderAppCard(APP, { settings: {}, prefs: {}, caps: { getReleases: false } });
  assert.ok(!out.includes('data-act="versions"'));
});

test('a skipped version is visible on the card with a way out', () => {
  const out = renderAppCard(APP, { settings: {}, prefs: { 'wivrn-nx': { skippedVersion: '1.9.2' } } });
  assert.match(out, /skip-chip/);
  assert.match(out, /data-act="clear-skip"[^>]*data-app="wivrn-nx"/);
  const other = renderAppCard(APP, { settings: {}, prefs: { 'wivrn-nx': { skippedVersion: '1.0.0' } } });
  assert.ok(!other.includes('skip-chip'));
});

test('a downloaded update becomes the primary button', () => {
  const app = normalizeApp({
    id: 'ogb',
    repo: 'o/ogb',
    name: 'OGB',
    latest: { version: '1.6.0' },
    artifacts: [
      { id: 'appimage-linux', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '1.4.2', path: '/x' }, readyToInstall: true },
    ],
  });
  const r = artifactActions(app, app.artifacts[0], { platform: 'linux' });
  assert.deepEqual(r.buttons.map((b) => b.label), ['Install downloaded update', 'Launch']);
  assert.equal(r.ready, true);

  const row = renderArtifactRow(app, app.artifacts[0], { platform: 'linux' });
  assert.match(row, /Install downloaded update/);
  assert.match(row, /art-ready/);
});

test('a rollback target adds a menu entry naming the version', () => {
  const app = normalizeApp({
    id: 'w',
    repo: 'o/w',
    name: 'W',
    latest: { version: '1.9.2' },
    artifacts: [
      { id: 'a', label: 'L', platform: 'linux', kind: 'appimage', installed: { version: '1.9.2', path: '/x' }, rollbackAvailable: true, prevVersion: '1.9.1' },
    ],
  });
  const r = artifactActions(app, app.artifacts[0], { platform: 'linux' });
  assert.ok(r.menu.some((m) => m.act === 'rollback' && m.label === 'Roll back to 1.9.1'));
  assert.ok(!artifactActions(app, app.artifacts[0], { caps: { rollback: false } }).menu.some((m) => m.act === 'rollback'));
});

/* ------------------------------------------------------------ hidden section */

test('the hidden section is a toggle row that reveals greyed rows', () => {
  const hidden = [normalizeApp({ id: 'w', repo: 'nerdrx/wivrn', name: 'WiVRn (upstream)' })];
  const closed = renderHiddenSection(hidden, { open: false });
  assert.match(closed, /data-act="toggle-hidden"/);
  assert.match(closed, /Show hidden/);
  assert.match(closed, /class="count">1</);
  assert.ok(!closed.includes('data-act="unhide-app"'));

  const open = renderHiddenSection(hidden, { open: true });
  assert.match(open, /hidden-row/);
  assert.match(open, /data-act="unhide-app"[^>]*data-app="w"/);
  assert.match(open, /nerdrx\/wivrn/);

  assert.equal(renderHiddenSection([], { open: true }), '', 'nothing hidden → no row at all');
  assert.equal(renderHiddenSection(null, {}), '');
});

test('hostile names cannot inject markup through the sheets', () => {
  const evil = normalizeApp({
    id: 'evil',
    repo: 'o/"><script>x</script>',
    name: '<img src=x onerror=alert(1)>',
    latest: { version: '<b>1</b>' },
    artifacts: [],
  });
  const options = renderAppOptions(evil, draftFrom({ skippedVersion: '"><script>y</script>' }), {});
  assert.ok(!options.includes('<script'));
  assert.ok(!options.includes('<img src=x'));
  assert.ok(!renderHiddenSection([evil], { open: true }).includes('<img src=x'));
});

/* ------------------------------------------------------------ mock bridge */

test('the mock implements the whole v0.2 surface', () => {
  const { nxhub } = createMock();
  for (const fn of [
    'getReleases',
    'installVersion',
    'rollback',
    'setAppPref',
    'adbConnect',
    'adbSelectDevice',
    'getDeviceInfo',
    'getDiskUsage',
    'clearDownloadCache',
    'getLogs',
    'exportSettings',
    'importSettings',
  ]) {
    assert.equal(typeof nxhub[fn], 'function', `nxhub.${fn}`);
  }
});

test('setAppPref merges, persists and mirrors hidden onto the app model', async () => {
  const { nxhub } = createMock();
  await nxhub.setAppPref('quadforge', { favorite: true });
  await nxhub.setAppPref('quadforge', { hidden: true });
  const state = normalizeState(await nxhub.getState());
  const pref = state.settings.appPrefs.quadforge;
  assert.equal(pref.favorite, true, 'the earlier patch survived');
  assert.equal(pref.hidden, true);
  assert.equal(pref.skippedVersion, '0.9.0', 'the seeded pref is still there');
  assert.equal(state.apps.find((a) => a.id === 'quadforge').localHidden, true);
  assert.equal(await nxhub.setAppPref('', {}), false);
});

test('the mock seeds every per-app state the UI can show', async () => {
  const { nxhub } = createMock();
  const state = normalizeState(await nxhub.getState());
  const prefs = state.settings.appPrefs;
  assert.ok(Object.values(prefs).some((p) => p.favorite), 'a favorite exists');
  assert.ok(Object.values(prefs).some((p) => p.hidden), 'a hidden app exists');
  assert.ok(Object.values(prefs).some((p) => p.skippedVersion), 'a skipped version exists');
  assert.ok(Object.values(prefs).some((p) => p.launchArgs.length), 'launch args exist');
  assert.ok(Object.values(prefs).some((p) => Object.keys(p.launchEnv).length), 'launch env exists');
  assert.ok(Object.values(prefs).some((p) => p.updatePolicy !== 'inherit'), 'a per-app policy exists');

  const arts = state.apps.flatMap((a) => a.artifacts);
  assert.ok(arts.some((a) => a.rollbackAvailable && a.prevVersion), 'a rollback target exists');
  assert.ok(arts.some((a) => a.readyToInstall), 'a downloaded update exists');
});

test('the update-available dev button emits the event and bumps the badge', async () => {
  const { nxhub, dev } = createMock();
  const seen = [];
  nxhub.onEvent((ev) => seen.push(ev));
  const appId = dev.simulateUpdateEvent('pulsenx');
  assert.equal(appId, 'pulsenx');
  const ev = seen.find((e) => e.type === 'update-available');
  assert.ok(ev, 'the event fired');
  assert.equal(ev.appId, 'pulsenx');
  assert.match(ev.version, /^\d+\.\d+\.\d+$/);
  const state = normalizeState(await nxhub.getState());
  assert.ok(
    state.apps.find((a) => a.id === 'pulsenx').artifacts.some((a) => a.updateAvailable),
    'the state agrees with the event'
  );
});

test('the stage-downloads dev button reaches the ready-to-install state', async () => {
  const { nxhub, dev } = createMock();
  assert.ok(dev.stageDownloads() >= 1);
  const state = normalizeState(await nxhub.getState());
  assert.ok(state.apps.flatMap((a) => a.artifacts).filter((a) => a.readyToInstall).length >= 1);
});
