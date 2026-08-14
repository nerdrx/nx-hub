import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
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
