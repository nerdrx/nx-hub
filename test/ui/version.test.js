import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripTag,
  compareVersions,
  isNewer,
  artifactHasUpdate,
  formatDate,
  relativeTime,
  formatBytes,
  extractSpeed,
  phaseLabel,
  progressLabel,
  versionLabel,
} from '../../src/renderer/lib/version.js';

test('stripTag removes tag decoration', () => {
  assert.equal(stripTag('v1.2.3'), '1.2.3');
  assert.equal(stripTag('V1.2.3'), '1.2.3');
  assert.equal(stripTag('nx-1.2.3'), '1.2.3');
  assert.equal(stripTag('release-2.0.0'), '2.0.0');
  assert.equal(stripTag('  v0.1.0 '), '0.1.0');
  assert.equal(stripTag(''), '');
  assert.equal(stripTag(null), '');
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('1.9.2', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
});

test('compareVersions treats a prerelease as older than its release', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc1'), 1);
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), -1);
  assert.equal(compareVersions('0.2.0-alpha', '0.2.0-beta'), -1);
});

test('compareVersions falls back to string order for junk', () => {
  assert.equal(compareVersions('nightly', 'nightly'), 0);
  assert.notEqual(compareVersions('alpha', 'beta'), 0);
});

test('isNewer handles the not-installed case', () => {
  assert.equal(isNewer('1.0.0', null), true);
  assert.equal(isNewer(null, '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
});

test('artifactHasUpdate prefers the flag from main, else compares', () => {
  assert.equal(artifactHasUpdate({ installed: { version: '1.0.0' }, updateAvailable: true }, '1.0.0'), true);
  assert.equal(artifactHasUpdate({ installed: { version: '1.0.0' } }, '1.1.0'), true);
  assert.equal(artifactHasUpdate({ installed: { version: '1.1.0' } }, '1.1.0'), false);
  assert.equal(artifactHasUpdate({ installed: null }, '1.1.0'), false);
  assert.equal(artifactHasUpdate(null, '1.1.0'), false);
});

test('formatDate is locale-independent', () => {
  assert.equal(formatDate('2026-08-14T09:30:00Z'), '14 Aug 2026');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate(''), '');
});

test('relativeTime buckets', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  assert.equal(relativeTime('2026-08-14T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-08-14T11:30:00Z', now), '30 min ago');
  assert.equal(relativeTime('2026-08-14T06:00:00Z', now), '6 h ago');
  assert.equal(relativeTime('2026-08-13T06:00:00Z', now), 'yesterday');
  assert.equal(relativeTime('2026-08-04T12:00:00Z', now), '10 days ago');
  assert.equal(relativeTime('2026-05-14T12:00:00Z', now), '3 months ago');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(41_500_000), '39.6 MB');
  assert.equal(formatBytes(412_000_000), '393 MB');
});

test('extractSpeed only fires when the message really has a rate', () => {
  assert.equal(extractSpeed('12.3 MB/s'), '12.3 MB/s');
  assert.equal(extractSpeed('downloading at 4 MiB/s now'), '4 MiB/s');
  assert.equal(extractSpeed('extracting squashfs-root'), '');
  assert.equal(extractSpeed(''), '');
  assert.equal(extractSpeed(undefined), '');
});

test('progressLabel composes phase, pct and speed', () => {
  assert.equal(progressLabel('download', 43, '12.3 MB/s'), 'Downloading 43% — 12.3 MB/s');
  assert.equal(progressLabel('download', 43, ''), 'Downloading 43%');
  assert.equal(progressLabel('extract', undefined, ''), 'Extracting');
  assert.equal(progressLabel('verify', 120, ''), 'Verifying 100%');
  assert.equal(phaseLabel('cleanup'), 'Finishing up');
  assert.equal(phaseLabel('weird'), 'weird');
});

test('versionLabel covers the three artifact states', () => {
  assert.equal(versionLabel({ installed: null }, '1.2.0'), 'not installed · 1.2.0 available');
  assert.equal(versionLabel({ installed: { version: '1.0.0' } }, '1.2.0'), '1.0.0 → 1.2.0');
  assert.equal(versionLabel({ installed: { version: '1.2.0' } }, '1.2.0'), '1.2.0 · up to date');
  assert.equal(versionLabel(null, ''), 'not installed');
});
