// v0.8 config time machine — the snapshot model, the rollback-affinity rule
// (the one piece of logic in this wave that can quietly restore the WRONG
// config), the section inside App options, and the rollback confirm sheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASONS,
  EMPTY_TEXT,
  AFFINITY_LABEL,
  normalizeSnapshot,
  normalizeSnapshots,
  reasonLabel,
  snapshotLabel,
  rollbackSnapshot,
  affinityNote,
  restoreConfirmText,
  deleteConfirmText,
  restoreResultText,
} from '../../src/renderer/lib/snapshots.js';
import { renderSnapshotsSection, renderRollbackSheet } from '../../src/renderer/views/snapshots.js';
import { renderAppOptions } from '../../src/renderer/views/appoptions.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const APP = normalizeApp({
  id: 'wivrn-nx',
  repo: 'nerdrx/wivrn-nx',
  name: 'WiVRn NX',
  latest: { version: '1.9.2', tag: 'v1.9.2' },
  configPaths: ['~/.config/wivrn'],
  artifacts: [{ id: 'tarball-prefix-linux', label: 'Linux server', platform: 'linux' }],
});

function snap(over = {}) {
  return {
    file: '20260805T190400-1.9.0-pre-update.tar.zst',
    ts: '2026-08-05T19:04:00.000Z',
    version: '1.9.0',
    reason: 'pre-update',
    bytes: 2_180_000,
    ...over,
  };
}

/* ---------------------------------------------------------- normalizing */

test('normalizeSnapshot fills the shape and refuses junk sizes', () => {
  const s = normalizeSnapshot({ file: 'a.tar.zst', bytes: '-4' });
  assert.equal(s.bytes, 0, 'a negative size reads as unknown, not as a negative bar');
  assert.equal(s.version, '');
  assert.equal(normalizeSnapshot(null).file, '');
  assert.equal(normalizeSnapshot({ file: 'x', bytes: 'nope' }).bytes, 0);
});

test('normalizeSnapshots sorts newest first and drops entries with no file', () => {
  const list = normalizeSnapshots([
    snap({ file: 'old', ts: '2026-01-01T00:00:00Z' }),
    { reason: 'manual' },
    snap({ file: 'new', ts: '2026-08-01T00:00:00Z' }),
    null,
  ]);
  assert.deepEqual(list.map((s) => s.file), ['new', 'old']);
  assert.deepEqual(normalizeSnapshots(null), []);
});

test('every documented reason has words, and an unknown one survives as itself', () => {
  assert.deepEqual(REASONS, ['pre-update', 'pre-uninstall', 'pre-restore', 'manual']);
  assert.equal(reasonLabel('pre-update'), 'before an update');
  assert.equal(reasonLabel('pre-uninstall'), 'before uninstalling');
  assert.equal(reasonLabel('pre-restore'), 'before a restore');
  assert.equal(reasonLabel('manual'), 'taken by hand');
  assert.equal(reasonLabel('pre-migration'), 'pre-migration', 'a newer main process is not rendered as blank');
  assert.equal(reasonLabel(''), 'snapshot');
});

test('the one-line label reads date · version · reason · size', () => {
  const label = snapshotLabel(snap());
  assert.match(label, /5 Aug 2026/, label);
  assert.match(label, /1\.9\.0/);
  assert.match(label, /before an update/);
  assert.match(label, /2\.1 MB/);
  // A snapshot with no size simply loses that segment rather than showing "0 B".
  assert.ok(!snapshotLabel(snap({ bytes: 0 })).includes('B'), snapshotLabel(snap({ bytes: 0 })));
});

/* ------------------------------------------------- THE AFFINITY RULE */

test('rollback affinity matches a pre-update snapshot at the target version', () => {
  const list = [
    snap({ file: 'a', version: '1.9.1', reason: 'pre-update', ts: '2026-08-10T00:00:00Z' }),
    snap({ file: 'b', version: '1.9.0', reason: 'pre-update', ts: '2026-08-05T00:00:00Z' }),
  ];
  assert.equal(rollbackSnapshot(list, '1.9.1').file, 'a');
  assert.equal(rollbackSnapshot(list, '1.9.0').file, 'b');
});

test('the NEWEST matching pre-update wins', () => {
  // The same version was updated away from twice; the recent config is the one
  // the user actually just lost.
  const list = [
    snap({ file: 'older', version: '1.4.1', reason: 'pre-update', ts: '2026-01-02T00:00:00Z' }),
    snap({ file: 'newer', version: '1.4.1', reason: 'pre-update', ts: '2026-06-13T00:00:00Z' }),
  ];
  assert.equal(rollbackSnapshot(list, '1.4.1').file, 'newer');
  // …and the rule holds whichever order the bridge handed them over in.
  assert.equal(rollbackSnapshot(list.slice().reverse(), '1.4.1').file, 'newer');
});

test('a miss stays a miss — wrong reason, wrong version, or nothing at all', () => {
  const list = [
    snap({ file: 'uninstall', version: '1.9.1', reason: 'pre-uninstall' }),
    snap({ file: 'restore', version: '1.9.1', reason: 'pre-restore' }),
    snap({ file: 'manual', version: '1.9.1', reason: 'manual' }),
    snap({ file: 'other-version', version: '1.9.0', reason: 'pre-update' }),
  ];
  assert.equal(rollbackSnapshot(list, '1.9.1'), null, 'only pre-update counts');
  assert.equal(rollbackSnapshot(list, '2.0.0'), null);
  assert.equal(rollbackSnapshot([], '1.9.1'), null);
  assert.equal(rollbackSnapshot(null, '1.9.1'), null);
  assert.equal(rollbackSnapshot(list, ''), null, 'no target version, no offer');
  assert.equal(rollbackSnapshot(list, '  '), null);
});

test('the version match is exact, not fuzzy', () => {
  // "1.9.1" must not be satisfied by "1.9.10" or by a v-prefixed tag: the
  // snapshot's own version field is what the file was named from.
  const list = [
    snap({ file: 'ten', version: '1.9.10', reason: 'pre-update' }),
    snap({ file: 'tagged', version: 'v1.9.1', reason: 'pre-update' }),
  ];
  assert.equal(rollbackSnapshot(list, '1.9.1'), null);
});

/* ---------------------------------------------------------------- copy */

test('the restore confirm states overwrite-in-place, both halves of it', () => {
  const text = restoreConfirmText(APP, snap());
  assert.match(text, /WiVRn NX/);
  assert.match(text, /written back over the current ones/, 'it overwrites');
  assert.match(text, /Anything created since then stays where it is/, 'and does not delete newer files');
  assert.match(text, /not a full revert/);
  assert.match(text, /snapshotted first/, 'and says the escape hatch exists');
});

test('the delete confirm promises exactly one thing', () => {
  const text = deleteConfirmText(APP, snap());
  assert.match(text, /archive is removed from disk/);
  assert.match(text, /Nothing else changes/);
});

test('the affinity note repeats the overwrite semantics next to the checkbox', () => {
  assert.equal(AFFINITY_LABEL, 'also restore the config from before the update');
  const note = affinityNote(snap());
  assert.match(note, /5 Aug 2026/);
  assert.match(note, /written back over the current config/);
  assert.match(note, /Files added since then are left alone/);
});

test('the restore result speaks the bridge’s own answer', () => {
  assert.match(restoreResultText(APP, { ok: true, restored: ['~/.config/wivrn'], preRestore: 'x' }), /Restored 1 path/);
  assert.match(restoreResultText(APP, { ok: true, restored: ['a', 'b'] }), /Restored 2 paths/);
  assert.match(restoreResultText(APP, { ok: true, restored: [], preRestore: 'x' }), /Restored the config/);
  assert.match(restoreResultText(APP, { ok: true, restored: ['a'], preRestore: 'x' }), /snapshotted first/);
  assert.match(restoreResultText(APP, { ok: false }), /Could not restore/);
});

/* ----------------------------------------------------------- rendering */

test('the section lists each snapshot with restore and delete', () => {
  const html = renderSnapshotsSection(APP, { snapshots: [snap(), snap({ file: 'b', reason: 'manual' })] });
  assert.equal((html.match(/class="snap-row"/g) || []).length, 2);
  assert.equal((html.match(/data-act="snap-restore"/g) || []).length, 2);
  assert.equal((html.match(/data-act="snap-delete"/g) || []).length, 2);
  assert.match(html, /data-snap="20260805T190400-1\.9\.0-pre-update\.tar\.zst"/);
  assert.match(html, /data-app="wivrn-nx"/);
  assert.match(html, /before an update/);
  assert.match(html, /taken by hand/);
  assert.match(html, /2\.1 MB/);
  assert.match(html, /Config snapshots/);
});

test('the section has loading, error and empty states', () => {
  assert.match(renderSnapshotsSection(APP, { loading: true }), /Reading the snapshots/);
  assert.match(renderSnapshotsSection(APP, { error: 'boom' }), /field-error/);
  const empty = renderSnapshotsSection(APP, { snapshots: [] });
  assert.match(empty, /Snapshots are taken automatically before updates/);
  assert.equal(EMPTY_TEXT, 'Snapshots are taken automatically before updates.');
});

test('a row being worked on disables both of its buttons', () => {
  const html = renderSnapshotsSection(APP, { snapshots: [snap()] }, { busy: snap().file });
  assert.equal((html.match(/disabled/g) || []).length, 2);
});

test('a hostile snapshot filename cannot break out of markup or an attribute', () => {
  const evil = '2026-08-01-0.8.0-"><img src=x onerror=alert(1)>.tar.zst';
  const html = renderSnapshotsSection(APP, { snapshots: [snap({ file: evil })] });
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('"><'), 'the attribute is not escapable');
  assert.match(html, /&quot;&gt;&lt;img/);
  // The same string reaches the confirm text and the affinity note.
  assert.ok(!renderRollbackSheet(APP, TARGET, snap({ file: evil }), {}).includes('<img'));

  // …and so does a version and a reason invented by another program.
  const badish = renderSnapshotsSection(APP, {
    snapshots: [snap({ version: '<b>1</b>', reason: '<i>x</i>' })],
  });
  assert.ok(!badish.includes('<b>1</b>'), badish);
  assert.ok(!badish.includes('<i>x</i>'), badish);
});

const TARGET = { artifactId: 'tarball-prefix-linux', label: 'Linux server', prevVersion: '1.9.1', currentVersion: '1.9.2' };

test('the rollback sheet carries the versions, the checkbox and the file to restore', () => {
  const html = renderRollbackSheet(APP, TARGET, snap({ file: 'cfg.tar.zst', version: '1.9.1' }), {});
  assert.match(html, /1\.9\.2 → 1\.9\.1/);
  assert.match(html, /Roll back to 1\.9\.1/);
  assert.match(html, /data-rollback-config checked/, 'the offer is opted-IN by default');
  assert.match(html, new RegExp(AFFINITY_LABEL));
  assert.match(html, /data-act="rollback-confirm"/);
  assert.match(html, /data-snap="cfg\.tar\.zst"/);
  assert.match(html, /data-art="tarball-prefix-linux"/);
  assert.match(html, /data-act="close-sheet"/, 'and a way out');
  // Unticking it survives a re-render.
  assert.ok(!renderRollbackSheet(APP, TARGET, snap(), { restoreConfig: false }).includes('data-rollback-config checked'));
});

/* ------------------------------------------------- inside App options */

test('App options grows the snapshots section only when the bridge has one', () => {
  const draft = { updatePolicy: 'inherit', envRows: [], launchArgsText: '' };
  const withCaps = renderAppOptions(APP, draft, { caps: { getSnapshots: true }, snapshots: { snapshots: [snap()] } });
  assert.match(withCaps, /Config snapshots/);
  assert.match(withCaps, /data-act="snap-restore"/);

  const without = renderAppOptions(APP, draft, { caps: {} });
  assert.ok(!without.includes('Config snapshots'), 'no getSnapshots, no section');
});

/* ------------------------------------------------------------- the mock */

test('the mock snapshots round-trip: list, restore (which snapshots first), delete', async () => {
  const { nxhub, dev } = createMock();

  const list = await nxhub.getSnapshots('wivrn-nx');
  assert.ok(list.length >= 3, 'the seed has a history to page through');
  assert.deepEqual(
    normalizeSnapshots(list).map((s) => s.file),
    list.map((s) => s.file),
    'the bridge already answers newest-first'
  );

  // The load-bearing seed: OGB's crash banner offers "Roll back to 1.4.1" and
  // there is a pre-update snapshot at exactly that version.
  const ogb = await nxhub.getSnapshots('oscgoesbrrr-nx-patches');
  assert.ok(rollbackSnapshot(ogb, '1.4.1'), 'the checkbox path is reachable from the default state');
  // …and WiVRn deliberately has none at 1.9.1, so the miss path is too.
  assert.equal(rollbackSnapshot(await nxhub.getSnapshots('wivrn-nx'), '1.9.1'), null);

  // Restoring snapshots the current config first and hands back what it wrote.
  const target = list[1];
  const res = await nxhub.restoreSnapshot('wivrn-nx', target.file);
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.restored) && res.restored.length, 'it says which paths it wrote');
  assert.ok(res.preRestore, 'and names the safety snapshot it took');
  const after = await nxhub.getSnapshots('wivrn-nx');
  assert.equal(after[0].reason, 'pre-restore', 'the safety snapshot is now the newest');

  // Deleting hands back the fresh list, so no second round trip is needed.
  const del = await nxhub.deleteSnapshot('wivrn-nx', target.file);
  assert.equal(del.ok, true);
  assert.ok(!del.snapshots.some((s) => s.file === target.file));
  assert.equal(del.snapshots.length, after.length - 1);
  assert.equal((await nxhub.deleteSnapshot('wivrn-nx', 'not-there')).ok, false);

  // An install over an existing one leaves the pre-update snapshot behind.
  const before = (await nxhub.getSnapshots('pulsenx')).length;
  await nxhub.install('pulsenx', 'appimage-linux');
  const seeded = await nxhub.getSnapshots('pulsenx');
  assert.ok(seeded.length >= before, 'maybeSnapshot ran before the install');
  assert.equal(seeded[0].reason, 'pre-update');
  assert.equal(seeded[0].version, '2.2.0', 'at the version being replaced, which is what a rollback looks for');

  // Retention keeps five per app.
  for (let i = 0; i < 8; i++) dev.seedSnapshot('quadforge', `0.${i}.0`, 'manual');
  assert.equal((await nxhub.getSnapshots('quadforge')).length, 5);

  dev.stop();
});
