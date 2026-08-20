// v0.10 [audit] — "Verify installs" in Settings → Storage: the normalization of
// audit(), the per-problem rows, and the Repair wiring.
//
// The one design rule under test that is easy to lose: Repair reinstalls through
// the EXISTING pipeline, so it reports through the existing job events. This
// surface must therefore never grow a second progress bar of its own — it hands
// off and says where to look.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProblem,
  normalizeAuditRow,
  normalizeAudit,
  problemLabel,
  problemChip,
  auditKey,
  brokenRows,
  auditSummary,
  auditSummaryText,
  rowSummaryText,
} from '../../src/renderer/lib/audit.js';
import { renderAuditRow, renderAuditBlock, renderStorageSection, renderSettingsPanel } from '../../src/renderer/views/settings.js';
import { createMock } from '../../src/renderer/mock.js';

const APPS = [
  { id: 'wivrn-nx', name: 'WiVRn NX' },
  { id: 'pulsenx', name: 'PulseNX' },
];

const BROKEN = {
  appId: 'wivrn-nx',
  artifactId: 'tarball-prefix-linux',
  ok: false,
  problems: [
    { kind: 'missing-binary', path: '/home/n/Applications/nx/wivrn-nx/bin/wivrn-server', detail: 'recorded, not on disk' },
    { kind: 'hash-mismatch', path: '/home/n/x', detail: '' },
  ],
};

/* ------------------------------------------------------------- normalize */

test('a problem survives every shape audit() could hand over', () => {
  assert.deepEqual(normalizeProblem({ kind: 'missing-file', path: '/x', detail: 'gone' }), {
    kind: 'missing-file',
    path: '/x',
    detail: 'gone',
  });
  // `message` is the other name main might use for the same sentence.
  assert.equal(normalizeProblem({ kind: 'x', message: 'why' }).detail, 'why');
  // A bare string is a kind — a hub that flattened its list still renders.
  assert.deepEqual(normalizeProblem('missing-dir'), { kind: 'missing-dir', path: '', detail: '' });
  // A problem with a path but no kind is still a problem worth showing.
  assert.equal(normalizeProblem({ path: '/x' }).kind, 'problem');

  assert.equal(normalizeProblem({}), null, 'but an empty one has nothing to say');
  assert.equal(normalizeProblem(null), null);
  assert.equal(normalizeProblem(''), null);
});

test('the LIST is the evidence — a row with problems is not ok, whatever ok said', () => {
  const lying = normalizeAuditRow({ appId: 'x', ok: true, problems: [{ kind: 'missing-dir' }] });
  assert.equal(lying.ok, false);

  // …and the flag is trusted the other way: no problems listed, ok:false stands.
  assert.equal(normalizeAuditRow({ appId: 'x', ok: false }).ok, false);
  assert.equal(normalizeAuditRow({ appId: 'x' }).ok, true, 'absent ok means clean');
  assert.equal(normalizeAuditRow({ artifactId: 'a' }), null, 'no app id, no row');
  assert.equal(normalizeAuditRow('nope'), null);
  assert.equal(normalizeAuditRow({ appId: 'X', problems: 'nope' }).appId, 'x');
  assert.deepEqual(normalizeAuditRow({ appId: 'x', problems: [null, {}, 'bad-manifest'] }).problems, [
    { kind: 'bad-manifest', path: '', detail: '' },
  ]);
});

test('the audit sorts broken first and drops duplicate installs', () => {
  const rows = normalizeAudit([
    { appId: 'clean', artifactId: 'a', ok: true },
    { appId: 'bad', artifactId: 'b', problems: [{ kind: 'missing-dir' }] },
    { appId: 'clean', artifactId: 'a', ok: true },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.appId), ['bad', 'clean']);
  assert.deepEqual(normalizeAudit(null), []);
  assert.deepEqual(normalizeAudit('nope'), []);

  // One app with two artifacts is two installs, not a duplicate.
  assert.equal(normalizeAudit([{ appId: 'a', artifactId: 'x' }, { appId: 'a', artifactId: 'y' }]).length, 2);
  assert.equal(auditKey('a', 'x'), 'a::x');
});

test('the summary counts installs and problems separately', () => {
  const rows = normalizeAudit([BROKEN, { appId: 'pulsenx', artifactId: 'a', ok: true }]);
  assert.deepEqual(auditSummary(rows), { total: 2, broken: 1, clean: 1, problems: 2, skipped: 0 });
  assert.deepEqual(brokenRows(rows).map((r) => r.appId), ['wivrn-nx']);
  assert.deepEqual(auditSummary(null), { total: 0, broken: 0, clean: 0, problems: 0, skipped: 0 });

  assert.equal(auditSummaryText(rows), '1 of 2 installs has a problem — repair reinstalls from the release.');
  assert.equal(auditSummaryText([{ ok: true }, { ok: true }]), 'All 2 installs check out.');
  assert.equal(auditSummaryText([]), 'Nothing installed by the hub to check.');
  assert.equal(rowSummaryText(normalizeAuditRow(BROKEN)), '2 problems');
  assert.equal(rowSummaryText({ ok: true, problems: [] }), 'No problems found');
  assert.equal(rowSummaryText(null), '');
});

test('a device-resident install is "not checked", never "verified"', () => {
  // [audit] badges kinds whose payload lives on a headset: ok there means
  // "nothing on this disk to check". Claiming a clean bill of health for files
  // this machine never looked at is the one lie a verify button must not tell.
  const row = normalizeAuditRow({
    appId: 'wivrn',
    artifactId: 'apk-android',
    ok: true,
    deviceResident: true,
    notes: ['apk: installed on a device — files not checked here', ''],
  });
  assert.equal(row.deviceResident, true);
  assert.deepEqual(row.notes, ['apk: installed on a device — files not checked here']);
  assert.equal(rowSummaryText(row), 'Installed on a device — not checked here');

  const out = renderAuditRow(row, { apps: [] });
  assert.match(out, /class="audit-row is-ok is-device"/);
  assert.match(out, />·</, 'a muted dot, not a cyan tick');
  assert.ok(!out.includes('>✓<'), out);

  const rows = normalizeAudit([row, { appId: 'ok', artifactId: 'a', ok: true }]);
  assert.equal(auditSummary(rows).skipped, 1);
  assert.equal(
    auditSummaryText(rows),
    'All 1 install on this machine check out — 1 lives on a device and cannot be checked from here.'
  );
  // A plain row is unaffected, and a BROKEN device row is still broken.
  assert.equal(auditSummary([{ ok: true }]).skipped, 0);
  assert.equal(
    rowSummaryText(normalizeAuditRow({ appId: 'x', deviceResident: true, problems: [{ kind: 'bad-manifest' }] })),
    '1 problem'
  );
});

test('every SPEC check has a readable label, and an unknown one still reads', () => {
  assert.equal(problemLabel('missing-dir'), 'Install folder is gone');
  assert.equal(problemLabel('bad-manifest'), 'Manifest will not parse');
  assert.equal(problemLabel('missing-binary'), 'Program file is missing');
  assert.equal(problemLabel('not-executable'), 'Program file is not executable');
  assert.equal(problemLabel('hash-mismatch'), 'Contents do not match the release');
  assert.equal(problemLabel('missing-desktop-entry'), 'Desktop entry is missing');
  // A newer main process adding a check must not render as a hole.
  assert.equal(problemLabel('signature-broken'), 'Signature broken');
  assert.equal(problemLabel(''), 'Problem');

  assert.equal(problemChip('missing-binary'), 'MISSING BINARY');
  assert.equal(problemChip(''), 'PROBLEM');
  assert.equal(problemChip('a-very-long-kind-name-indeed').length, 16, 'the chip stays a chip');
});

/* ---------------------------------------------------------------- markup */

test('a broken row lists every problem with its path, and offers Repair', () => {
  const out = renderAuditRow(normalizeAuditRow(BROKEN), { apps: APPS, caps: {} });
  assert.match(out, /class="audit-row is-bad"/);
  assert.match(out, /data-audit="wivrn-nx::tarball-prefix-linux"/);
  assert.match(out, />WiVRn NX</, 'the catalogue name, not the id');
  assert.match(out, />2 problems</);
  assert.match(out, /MISSING BINARY/);
  assert.match(out, /Program file is missing/);
  assert.match(out, /Contents do not match the release/);
  assert.match(out, /wivrn-server/);
  assert.match(out, /data-act="repair-install" data-app="wivrn-nx"\s*\n?\s*data-art="tarball-prefix-linux"/);
});

test('a clean row is one quiet line with no Repair button', () => {
  const out = renderAuditRow(normalizeAuditRow({ appId: 'pulsenx', artifactId: 'a', ok: true }), { apps: APPS });
  assert.match(out, /class="audit-row is-ok"/);
  assert.match(out, />No problems found</);
  assert.ok(!out.includes('repair-install'), out);
  assert.ok(!out.includes('audit-problems'), 'and no empty problem list');
});

test('the Repair button disappears without repairInstall(), and disables while busy', () => {
  const row = normalizeAuditRow(BROKEN);
  assert.ok(!renderAuditRow(row, { apps: APPS, caps: { repairInstall: false } }).includes('repair-install'));

  const busy = renderAuditRow(row, { apps: APPS, repairing: 'wivrn-nx::tarball-prefix-linux' });
  assert.match(busy, /Repairing…/);
  assert.match(busy, /disabled/);
  // Another row's repair does not disable this one.
  assert.ok(!renderAuditRow(row, { apps: APPS, repairing: 'other::x' }).includes('disabled'));
});

test('an audit row escapes the filesystem it describes', () => {
  const out = renderAuditRow(
    normalizeAuditRow({
      appId: '"><script>x</script>',
      artifactId: '"><b>art',
      problems: [{ kind: '"><i>kind', path: '/home/n/"><img src=x onerror=alert(1)>', detail: '<u>d</u>' }],
    }),
    { apps: [] }
  );
  for (const bad of ['<script', '<img', '<b>', '<i>', '<u>']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  assert.match(out, /&lt;script&gt;/);
});

test('the block walks unchecked → checking → results → error', () => {
  const idle = renderAuditBlock(null, {});
  assert.match(idle, /data-act="verify-installs"/);
  assert.match(idle, />Verify installs</);
  assert.match(idle, /Checks every installed file/);
  assert.ok(!idle.includes('audit-row'), 'nothing is claimed before anything was checked');

  const loading = renderAuditBlock({ loading: true }, {});
  assert.match(loading, /Checking every install…/);
  assert.match(loading, /Verifying…/);
  assert.match(loading, /disabled/);

  const rows = normalizeAudit([BROKEN, { appId: 'pulsenx', artifactId: 'a', ok: true }]);
  const done = renderAuditBlock({ ran: true, rows }, { apps: APPS });
  assert.match(done, /1 of 2 installs has a problem/);
  assert.equal(done.match(/class="audit-row/g).length, 2);
  assert.match(done, />Verify again</);

  const clean = renderAuditBlock({ ran: true, rows: [] }, {});
  assert.match(clean, /Nothing installed by the hub to check/);

  const failed = renderAuditBlock({ ran: true, error: 'the state file is unreadable' }, {});
  assert.match(failed, /field-error/);
  assert.match(failed, /the state file is unreadable/);
});

test('the Storage section carries the block, and a build without getAudit does not', () => {
  const withAudit = renderStorageSection(null, APPS, { caps: {} });
  assert.match(withAudit, /data-act="verify-installs"/);
  assert.ok(!renderStorageSection(null, APPS, { caps: { getAudit: false } }).includes('verify-installs'));

  // The audit outlives the measurer: a build with no getDiskUsage still verifies.
  const auditOnly = renderStorageSection(null, APPS, { caps: { getDiskUsage: false } });
  assert.match(auditOnly, /data-act="verify-installs"/);
  assert.ok(!auditOnly.includes('data-act="disk-usage"'));

  // …and the whole section only vanishes when it has nothing left to offer.
  const panel = renderSettingsPanel(
    { owners: [], extraRepos: [] },
    { caps: { getDiskUsage: false, getAudit: false, clearDownloadCache: false } }
  );
  assert.ok(!panel.includes('<span>Storage</span>'), panel.slice(0, 200));
});

test('the panel threads the audit state through to the rows', () => {
  const rows = normalizeAudit([BROKEN]);
  const panel = renderSettingsPanel(
    { owners: [], extraRepos: [] },
    { caps: {}, apps: APPS, audit: { ran: true, rows }, repairing: 'wivrn-nx::tarball-prefix-linux' }
  );
  assert.match(panel, /class="audit-row is-bad"/);
  assert.match(panel, /Repairing…/);
});

/* ----------------------------------------------------------- mock bridge */

test('the mock reports two damaged installs, and repair fixes exactly one', async () => {
  const { nxhub, dev } = createMock();
  const rows = normalizeAudit(await nxhub.getAudit());
  const s = auditSummary(rows);
  assert.equal(s.broken, 2, 'two broken installs to design against');
  assert.ok(s.total > s.broken, 'and clean ones to compare them with');
  assert.deepEqual(rows.slice(0, 2).map((r) => r.ok), [false, false], 'broken first');

  // Different failure classes, so the row layout is proven on more than one.
  const kinds = new Set(rows.flatMap((r) => r.problems.map((p) => p.kind)));
  assert.ok(kinds.has('missing-binary'));
  assert.ok(kinds.has('hash-mismatch'));

  // Repair returns a jobId and narrates through the NORMAL job events.
  const jobEvents = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'job-progress' || ev.type === 'job-done') jobEvents.push(ev.type);
  });
  const jobId = await nxhub.repairInstall('oscgoesbrrr-nx-patches', 'appimage-linux');
  assert.ok(jobId, 'a repair is a job');
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(jobEvents.includes('job-progress'), 'and it reports as one');

  const after = normalizeAudit(await nxhub.getAudit());
  assert.equal(auditSummary(after).broken, 1, 'the repaired install verifies clean now');
  assert.equal(dev.breakInstalls(), 2, 'and the toolbar can damage them again');
  dev.stop();
});

test('the mock can scope an audit to one app', async () => {
  const { nxhub, dev } = createMock();
  const rows = normalizeAudit(await nxhub.getAudit('wivrn-nx'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].appId, 'wivrn-nx');
  dev.stop();
});
