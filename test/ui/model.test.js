import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeJobFor,
  normalizeState,
  normalizeAdb,
  normalizeApp,
  normalizeSettings,
  filterApps,
  fuzzyScore,
  splitPublished,
  showOwnerBadge,
  ownerOf,
  isValidRepoRef,
  githubUrl,
  releaseUrl,
  jobFor,
  normalizeArtifact,
  visibleApps,
  hiddenApps,
  appHidden,
  appHasUpdate,
  updateBadgeCount,
  clampConcurrency,
} from '../../src/renderer/lib/model.js';
import { validateRepoRef } from '../../src/renderer/views/settings.js';

test('normalizeState survives garbage from main', () => {
  for (const input of [null, undefined, {}, { apps: 'nope', jobs: 5, settings: 7 }]) {
    const s = normalizeState(input);
    assert.ok(Array.isArray(s.apps));
    assert.ok(Array.isArray(s.jobs));
    assert.ok(Array.isArray(s.settings.owners));
    assert.equal(typeof s.adb.connected, 'boolean');
  }
});

test('normalizeState sorts by overlay order then name', () => {
  const s = normalizeState({
    apps: [
      { id: 'b', repo: 'o/b', name: 'B', order: 5 },
      { id: 'a', repo: 'o/a', name: 'A', order: 1 },
      { id: 'c', repo: 'o/c', name: 'C' },
    ],
  });
  assert.deepEqual(s.apps.map((a) => a.id), ['a', 'b', 'c']);
});

test('normalizeApp derives update flags from the latest version', () => {
  const app = normalizeApp({
    id: 'x',
    repo: 'o/x',
    latest: { version: '2.0.0' },
    artifacts: [
      { id: 'a1', installed: { version: '1.0.0' } },
      { id: 'a2', installed: { version: '2.0.0' } },
      { id: 'a3' },
    ],
  });
  assert.deepEqual(app.artifacts.map((a) => a.updateAvailable), [true, false, false]);
});

test('an app with neither release nor artifacts counts as unpublished', () => {
  assert.equal(normalizeApp({ id: 'x', repo: 'o/x' }).unpublished, true);
  assert.equal(normalizeApp({ id: 'x', repo: 'o/x', latest: { version: '1' } }).unpublished, false);
});

test('normalizeAdb accepts every plausible shape', () => {
  assert.equal(normalizeAdb(null).connected, false);
  assert.equal(normalizeAdb({ connected: true, devices: [{ model: 'Pico 4' }] }).connected, true);
  assert.equal(normalizeAdb({ device: { model: 'Pico 4', serial: 'X' } }).devices[0].model, 'Pico 4');
  assert.equal(normalizeAdb(['ABC123']).devices[0].model, 'ABC123');
  // A device listed as unauthorized/offline is not "connected".
  assert.equal(normalizeAdb({ devices: [{ model: 'P', state: 'unauthorized' }] }).connected, false);
});

test('normalizeSettings fills defaults but keeps provided values', () => {
  const s = normalizeSettings({ owners: ['me'], token: 'tok' });
  assert.deepEqual(s.owners, ['me']);
  assert.deepEqual(s.extraRepos, []);
  assert.equal(s.token, 'tok');
  assert.equal(s.installRoot, '~/Applications');
  assert.equal(normalizeSettings(null).owners[0], 'nerdrx');
});

test('owner badge appears only for non-primary owners', () => {
  const settings = { owners: ['nerdrx'] };
  assert.equal(showOwnerBadge({ repo: 'nerdrx/wivrn-nx' }, settings), false);
  assert.equal(showOwnerBadge({ repo: 'NERDRX/wivrn-nx' }, settings), false);
  assert.equal(showOwnerBadge({ repo: 'WiVRn/WiVRn' }, settings), true);
  assert.equal(showOwnerBadge({ repo: 'x/y' }, { owners: [] }), false);
  assert.equal(ownerOf('a/b'), 'a');
  assert.equal(ownerOf('b'), '');
});

test('fuzzy filter matches substrings and subsequences', () => {
  const apps = [
    { id: 'wivrn-nx', name: 'WiVRn NX', tagline: 'streaming', repo: 'nerdrx/wivrn-nx' },
    { id: 'pulsenx', name: 'PulseNX', tagline: 'heart rate', repo: 'nerdrx/pulsenx' },
    { id: 'quadforge', name: 'QuadForge', tagline: 'blender', repo: 'nerdrx/quadforge' },
  ];
  assert.deepEqual(filterApps(apps, 'pulse').map((a) => a.id), ['pulsenx']);
  assert.deepEqual(filterApps(apps, 'qf').map((a) => a.id), ['quadforge']);
  assert.deepEqual(filterApps(apps, 'blender').map((a) => a.id), ['quadforge']);
  assert.equal(filterApps(apps, '').length, 3);
  assert.equal(filterApps(apps, 'zzzz').length, 0);
  assert.ok(fuzzyScore('nx', 'WiVRn NX') >= 0);
  assert.equal(fuzzyScore('nx', ''), -1);
});

test('splitPublished separates the unpublished section', () => {
  const { published, unpublished } = splitPublished([
    { id: 'a', unpublished: false },
    { id: 'b', unpublished: true },
  ]);
  assert.deepEqual(published.map((a) => a.id), ['a']);
  assert.deepEqual(unpublished.map((a) => a.id), ['b']);
});

test('repo reference validation', () => {
  assert.ok(isValidRepoRef('nerdrx/nx-hub'));
  assert.ok(isValidRepoRef('WiVRn/WiVRn'));
  assert.ok(!isValidRepoRef('nx-hub'));
  assert.ok(!isValidRepoRef('a/b/c'));
  assert.ok(!isValidRepoRef('-bad/repo'));
  assert.ok(!isValidRepoRef(''));
  assert.equal(validateRepoRef('nerdrx/nx-hub'), '');
  assert.match(validateRepoRef(''), /owner\/repo/);
  assert.match(validateRepoRef('junk'), /not a valid/);
});

test('github urls', () => {
  assert.equal(githubUrl('nerdrx/nx-hub'), 'https://github.com/nerdrx/nx-hub');
  assert.equal(releaseUrl({ repo: 'o/r', latest: { tag: 'v1.0' } }), 'https://github.com/o/r/releases/tag/v1.0');
  assert.equal(releaseUrl({ repo: 'o/r' }), 'https://github.com/o/r/releases');
});

test('jobFor finds the job of an app/artifact', () => {
  const jobs = [{ appId: 'a', artifactId: 'x' }, { appId: 'b', artifactId: 'y' }];
  assert.equal(jobFor(jobs, 'b', 'y').appId, 'b');
  assert.equal(jobFor(jobs, 'a', 'zzz'), null);
  assert.equal(jobFor(null, 'a', 'x'), null);
});

/* ------------------------------------------------------------- v0.2 model */

test('normalizeSettings fills the v0.2 fields and clamps concurrency', () => {
  const s = normalizeSettings({});
  assert.equal(s.updatePolicy, 'notify');
  assert.equal(s.includePrereleases, false);
  assert.equal(s.notifications, true);
  assert.equal(s.autostart, false);
  assert.equal(s.startMinimized, false);
  assert.equal(s.createDesktopEntries, true);
  assert.equal(s.maxConcurrentDownloads, 2);
  assert.equal(s.preferredDeviceSerial, '');
  assert.deepEqual(s.appPrefs, {});

  const odd = normalizeSettings({
    updatePolicy: 'sideways',
    notifications: 'no',
    maxConcurrentDownloads: 99,
    preferredDeviceSerial: 7,
    appPrefs: { a: { favorite: 1 } },
  });
  assert.equal(odd.updatePolicy, 'notify', 'unknown policies fall back');
  assert.equal(odd.notifications, true, 'non-booleans keep the default');
  assert.equal(odd.maxConcurrentDownloads, 4);
  assert.equal(odd.preferredDeviceSerial, '');
  assert.equal(odd.appPrefs.a.favorite, true);
  assert.equal(normalizeSettings({ maxConcurrentDownloads: 0 }).maxConcurrentDownloads, 1);
  assert.equal(clampConcurrency('x'), 2);
  assert.equal(clampConcurrency(3), 3);
});

test('normalizeArtifact carries the v0.2 flags, rollback only when installed', () => {
  const a = normalizeArtifact(
    { id: 'x', kind: 'appimage', rollbackAvailable: true, prevVersion: '1.0.0', readyToInstall: 1 },
    '2.0.0'
  );
  assert.equal(a.rollbackAvailable, false, 'nothing installed → nothing to roll back to');
  assert.equal(a.prevVersion, '1.0.0');
  assert.equal(a.readyToInstall, true);

  const b = normalizeArtifact(
    { id: 'x', kind: 'appimage', installed: { version: '2.0.0' }, rollbackAvailable: true, prevVersion: '1.0.0' },
    '2.0.0'
  );
  assert.equal(b.rollbackAvailable, true);
  assert.equal(normalizeArtifact({ id: 'x' }).readyToInstall, false);
});

test('localHidden survives normalization', () => {
  assert.equal(normalizeApp({ id: 'a', repo: 'o/a', localHidden: 1 }).localHidden, true);
  assert.equal(normalizeApp({ id: 'a', repo: 'o/a' }).localHidden, false);
});

/* ----------------------------------------------------- visible / hidden / badge */

const APPS_V2 = [
  { id: 'a', repo: 'o/a', name: 'A', latest: { version: '2.0.0' }, artifacts: [{ id: 'x', kind: 'appimage', installed: { version: '1.0.0' } }] },
  { id: 'b', repo: 'o/b', name: 'B', latest: { version: '2.0.0' }, artifacts: [{ id: 'x', kind: 'appimage', installed: { version: '2.0.0' } }] },
  { id: 'c', repo: 'o/c', name: 'C', latest: { version: '3.0.0' }, artifacts: [{ id: 'x', kind: 'appimage', installed: { version: '1.0.0' } }] },
  { id: 'd', repo: 'o/d', name: 'D', unpublished: true, artifacts: [] },
];

test('visible / hidden split honours prefs and localHidden', () => {
  const state = normalizeState({ apps: APPS_V2, settings: { appPrefs: { c: { hidden: true } } } });
  assert.deepEqual(visibleApps(state.apps, state.settings).map((a) => a.id), ['a', 'b', 'd']);
  assert.deepEqual(hiddenApps(state.apps, state.settings).map((a) => a.id), ['c']);
  assert.equal(appHidden(state.apps[0], state.settings), false);

  const mirrored = normalizeState({ apps: [{ ...APPS_V2[0], localHidden: true }] });
  assert.equal(appHidden(mirrored.apps[0], mirrored.settings), true);
});

test('the Manage badge counts visible apps waiting for an update', () => {
  const plain = normalizeState({ apps: APPS_V2 });
  assert.equal(updateBadgeCount(plain.apps, plain.settings), 2, 'a and c want updates');

  const hidden = normalizeState({ apps: APPS_V2, settings: { appPrefs: { c: { hidden: true } } } });
  assert.equal(updateBadgeCount(hidden.apps, hidden.settings), 1, 'hidden apps do not nag');

  const skipped = normalizeState({ apps: APPS_V2, settings: { appPrefs: { a: { skippedVersion: '2.0.0' } } } });
  assert.equal(updateBadgeCount(skipped.apps, skipped.settings), 1, 'the skipped version is ignored');

  const otherSkip = normalizeState({ apps: APPS_V2, settings: { appPrefs: { a: { skippedVersion: '1.5.0' } } } });
  assert.equal(updateBadgeCount(otherSkip.apps, otherSkip.settings), 2, 'skipping an old version changes nothing');

  const staged = normalizeState({
    apps: [{ id: 'e', repo: 'o/e', name: 'E', latest: { version: '1.0.0' }, artifacts: [{ id: 'x', kind: 'appimage', installed: { version: '1.0.0' }, readyToInstall: true }] }],
  });
  assert.equal(updateBadgeCount(staged.apps, staged.settings), 1, 'a downloaded update still counts');
  assert.equal(updateBadgeCount(null, {}), 0);
});

test('appHasUpdate ignores unpublished repos', () => {
  const state = normalizeState({ apps: APPS_V2 });
  assert.equal(appHasUpdate(state.apps.find((a) => a.id === 'd'), state.settings), false);
  assert.equal(appHasUpdate(null, {}), false);
});

test('activeJobFor: finished jobs never produce a progress bar', () => {
  const jobs = [
    { appId: 'vrcx', artifactId: 'a', status: 'done', pct: 100, phase: 'cleanup' },
    { appId: 'vrcx', artifactId: 'a', status: 'running', pct: 40, phase: 'download' },
    { appId: 'ogb', artifactId: 'b', status: 'error', pct: 10 },
    { appId: 'live', artifactId: 'c', pct: 55 }, // live progress event — no status
  ];
  assert.equal(activeJobFor(jobs, 'vrcx').pct, 40, 'skips the done job, finds the running one');
  assert.equal(activeJobFor(jobs, 'ogb'), null, 'error jobs are history, not bars');
  assert.equal(activeJobFor(jobs, 'live').pct, 55, 'statusless live events stay active');
  assert.equal(activeJobFor(jobs, 'other'), null);
});
