import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  downgradeConfirmText,
  isDowngrade,
  normalizeRelease,
  normalizeReleases,
  readyTargets,
  releaseArtifactAction,
  releaseTargets,
  rollbackConfirmText,
  rollbackTargets,
  sameVersion,
  visibleReleases,
} from '../../src/renderer/lib/releases.js';
import { renderVersionsSheet, renderReleaseRow, renderRollbackBlock } from '../../src/renderer/views/versions.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const APP = normalizeApp({
  id: 'wivrn-nx',
  repo: 'nerdrx/wivrn-nx',
  name: 'WiVRn NX',
  latest: { tag: 'v1.9.2', version: '1.9.2' },
  artifacts: [
    {
      id: 'tarball-prefix-linux',
      label: 'Linux server',
      platform: 'linux',
      kind: 'tarball-prefix',
      installed: { version: '1.9.2', path: '/x' },
      rollbackAvailable: true,
      prevVersion: '1.9.1',
    },
    { id: 'windows-zip-windows', label: 'Windows build', platform: 'windows', kind: 'windows-zip' },
  ],
});

const REL = (over) => normalizeRelease({ tag: 'v1.9.0', version: '1.9.0', publishedAt: '2026-06-01T00:00:00Z', ...over });

/* ------------------------------------------------------------- normalizing */

test('normalizeRelease accepts both the SPEC shape and raw GitHub-ish keys', () => {
  const r = normalizeRelease({ tag_name: 'v2.0.0', body: 'notes', published_at: '2026-08-01T00:00:00Z', prerelease: 1 });
  assert.equal(r.tag, 'v2.0.0');
  assert.equal(r.version, '2.0.0', 'the version is derived from the tag when absent');
  assert.equal(r.notes, 'notes');
  assert.equal(r.publishedAt, '2026-08-01T00:00:00Z');
  assert.equal(r.prerelease, true);
  assert.deepEqual(r.assets, []);

  const withAssets = normalizeRelease({ tag: 'v1', assets: ['a.zip', { name: 'b.apk', size: 5 }, null] });
  assert.deepEqual(withAssets.assets, [{ name: 'a.zip', size: 0 }, { name: 'b.apk', size: 5 }]);
});

test('normalizeReleases sorts newest first and drops empties', () => {
  const list = normalizeReleases([
    { tag: 'v1.0.0' },
    null,
    { tag: 'v2.1.0' },
    {},
    { tag: 'v2.0.0' },
    { tag: 'v2.2.0-rc1' },
  ]);
  assert.deepEqual(list.map((r) => r.tag), ['v2.2.0-rc1', 'v2.1.0', 'v2.0.0', 'v1.0.0']);
  assert.deepEqual(normalizeReleases(null), []);
});

test('visibleReleases honours the prerelease pref', () => {
  const list = normalizeReleases([{ tag: 'v2.0.0' }, { tag: 'v2.1.0-rc1', prerelease: true }]);
  assert.equal(visibleReleases(list, true).length, 2);
  assert.deepEqual(visibleReleases(list, false).map((r) => r.tag), ['v2.0.0']);
});

/* -------------------------------------------------------- downgrade detection */

test('isDowngrade only fires when the target is strictly older', () => {
  assert.equal(isDowngrade('1.8.0', '1.9.2'), true);
  assert.equal(isDowngrade('1.9.2', '1.9.2'), false);
  assert.equal(isDowngrade('1.10.0', '1.9.2'), false, '1.10 > 1.9 — not a string compare');
  assert.equal(isDowngrade('2.0.0', '1.9.2'), false);
  assert.equal(isDowngrade('1.0.0-rc1', '1.0.0'), true, 'a prerelease is older than its final');
  // nothing installed → nothing to downgrade from
  assert.equal(isDowngrade('1.0.0', ''), false);
  assert.equal(isDowngrade('', '1.0.0'), false);
});

test('sameVersion compares semantically, not textually', () => {
  assert.equal(sameVersion('1.9.2', 'v1.9.2'), true);
  assert.equal(sameVersion('1.9', '1.9.0'), true);
  assert.equal(sameVersion('1.9.2', '1.9.3'), false);
  assert.equal(sameVersion('', '1.0.0'), false);
});

/* ------------------------------------------------------- per-release actions */

test('the release button says install / reinstall / downgrade', () => {
  const art = APP.artifacts[0]; // installed 1.9.2
  const older = releaseArtifactAction(REL({ tag: 'v1.8.0', version: '1.8.0' }), art);
  assert.equal(older.kind, 'downgrade');
  assert.equal(older.label, 'Downgrade');
  assert.match(older.title, /replaces 1\.9\.2 with the older 1\.8\.0/);

  const same = releaseArtifactAction(REL({ tag: 'v1.9.2', version: '1.9.2' }), art);
  assert.equal(same.kind, 'current');
  assert.equal(same.label, 'Reinstall');

  const newer = releaseArtifactAction(REL({ tag: 'v2.0.0', version: '2.0.0' }), art);
  assert.equal(newer.kind, 'upgrade');
  assert.equal(newer.label, 'Install this version');

  const fresh = releaseArtifactAction(REL({ version: '1.9.0' }), APP.artifacts[1]);
  assert.equal(fresh.kind, 'install');
  assert.equal(fresh.variant, 'violet');
});

test('multi-artifact releases label each button, and a job disables them', () => {
  const many = releaseArtifactAction(REL({ version: '2.0.0' }), APP.artifacts[0], { many: true });
  assert.equal(many.label, 'Install — Linux server');
  const busy = releaseArtifactAction(REL({ version: '2.0.0' }), APP.artifacts[0], { busy: true });
  assert.equal(busy.disabled, true);
  assert.match(busy.title, /already running/);
});

test('release targets skip artifacts this host cannot install', () => {
  assert.deepEqual(releaseTargets(APP, { platform: 'linux' }).map((a) => a.id), ['tarball-prefix-linux']);
  assert.equal(releaseTargets(APP, { platform: 'win32' }).length, 2);
  assert.deepEqual(releaseTargets(null), []);
});

test('rollback and ready targets come off the artifact flags', () => {
  assert.deepEqual(rollbackTargets(APP), [
    { artifactId: 'tarball-prefix-linux', label: 'Linux server', prevVersion: '1.9.1', currentVersion: '1.9.2' },
  ]);
  assert.deepEqual(rollbackTargets(null), []);

  const ready = normalizeApp({
    id: 'x',
    repo: 'o/x',
    latest: { version: '2' },
    artifacts: [{ id: 'a', kind: 'appimage', readyToInstall: true }, { id: 'b', kind: 'appimage' }],
  });
  assert.deepEqual(readyTargets(ready).map((a) => a.id), ['a']);
});

test('confirm texts name both versions', () => {
  const text = downgradeConfirmText(APP, APP.artifacts[0], '1.8.0');
  assert.match(text, /WiVRn NX — Linux server/);
  assert.match(text, /1\.9\.2 → 1\.8\.0/);
  const roll = rollbackConfirmText(APP, rollbackTargets(APP)[0]);
  assert.match(roll, /1\.9\.2 → 1\.9\.1/);
});

/* ------------------------------------------------------------------ renderer */

test('the versions sheet renders loading, error and empty states', () => {
  assert.match(renderVersionsSheet(APP, { loading: true }), /sheet-loading/);
  const err = renderVersionsSheet(APP, { error: 'nope' });
  assert.match(err, /sheet-error/);
  assert.match(err, /data-act="versions"/, 'the error offers a retry');
  assert.match(renderVersionsSheet(APP, { releases: [] }), /No releases found/);
});

test('a release row carries tag, date, chips, notes and per-artifact buttons', () => {
  const rel = REL({ tag: 'v1.9.2', version: '1.9.2', notes: '# Hi', prerelease: false });
  const out = renderReleaseRow(APP, rel, { platform: 'linux', now: Date.parse('2026-08-14T00:00:00Z') });
  assert.match(out, /rel-tag">v1\.9\.2/);
  assert.match(out, /badge-latest/);
  assert.match(out, /badge-installed/);
  assert.match(out, /data-act="install-version"[^>]*data-tag="v1\.9\.2"/);
  assert.match(out, /Reinstall/);
  assert.ok(!out.includes('<h3>Hi</h3>'), 'notes stay collapsed');

  const open = renderReleaseRow(APP, rel, { platform: 'linux', expanded: ['v1.9.2'] });
  assert.match(open, /<h3>Hi<\/h3>/);

  const pre = renderReleaseRow(APP, REL({ tag: 'v2.0.0-rc1', version: '2.0.0-rc1', prerelease: true }), {});
  assert.match(pre, /pre-release/);
  assert.match(pre, /No release notes/);
});

test('the rollback block appears only when an install kept a previous version', () => {
  assert.match(renderRollbackBlock(APP, {}), /Roll back to 1\.9\.1/);
  assert.match(renderRollbackBlock(APP, {}), /data-act="rollback"/);
  assert.equal(renderRollbackBlock(APP, { caps: false }), '', 'hidden when the bridge cannot roll back');
  assert.equal(renderRollbackBlock(normalizeApp({ id: 'x', repo: 'o/x' }), {}), '');
});

test('hostile release metadata cannot inject markup', () => {
  const rel = REL({ tag: '"><script>x</script>', version: '<b>1</b>', notes: '<script>bad()</script>' });
  const out = renderReleaseRow(APP, rel, { expanded: ['"><script>x</script>'] });
  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('&lt;script&gt;') || out.includes('&quot;&gt;&lt;script&gt;'));
});

/* ---------------------------------------------------------- mock coverage */

test('the mock serves a believable history for every published app', async () => {
  const { nxhub } = createMock();
  const list = normalizeReleases(await nxhub.getReleases('wivrn-nx'));
  assert.ok(list.length >= 5, `expected a history, got ${list.length}`);
  assert.ok(list.some((r) => r.prerelease), 'a pre-release is reachable');
  assert.ok(list.some((r) => r.version === '1.9.2'), 'the current release is in the list');
  assert.ok(list.every((r) => r.tag), 'every entry has a tag');
  assert.ok(list.some((r) => r.assets.length), 'assets ride along');
  assert.deepEqual(await nxhub.getReleases('does-not-exist'), []);
});

test('installVersion in the mock actually moves the installed version', async () => {
  const { nxhub, dev } = createMock();
  const releases = await nxhub.getReleases('pulsenx');
  const older = releases.find((r) => r.version === '2.2.3') || releases[releases.length - 1];
  await nxhub.installVersion('pulsenx', 'appimage-linux', older.tag);
  const art = dev.state.apps.find((a) => a.id === 'pulsenx').artifacts.find((a) => a.id === 'appimage-linux');
  // the fake job animates through its phases — wait for it to land
  for (let i = 0; i < 120 && art.installed.version !== older.version; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(art.installed.version, older.version);
  assert.equal(art.rollbackAvailable, true, 'the replaced version becomes a rollback target');
  // The Linux artifact rides on v2.2.0 (v2.3.0 was Android-only), so that is
  // what the downgrade replaces.
  assert.equal(art.prevVersion, '2.2.0');
  dev.stop();
});

test('rollback in the mock restores the kept version', async () => {
  const { nxhub, dev } = createMock();
  const before = dev.state.apps
    .find((a) => a.id === 'wivrn-nx')
    .artifacts.find((a) => a.id === 'tarball-prefix-linux');
  assert.equal(before.prevVersion, '1.9.1');
  assert.equal(await nxhub.rollback('wivrn-nx', 'tarball-prefix-linux'), true);
  assert.equal(before.installed.version, '1.9.1');
  assert.equal(before.rollbackAvailable, false, 'the rollback is spent');
  assert.equal(await nxhub.rollback('wivrn-nx', 'tarball-prefix-linux'), false);
  dev.stop();
});
