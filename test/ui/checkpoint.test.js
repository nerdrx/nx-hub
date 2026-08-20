// v0.10 [replay] — ecosystem checkpoints: the reconstruction, the plan table,
// the exclusion of uncertain rows, and the folding of checkpoint-progress.
//
// The rule this file exists to protect: an `uncertain` row is SHOWN and NOT
// APPLIED. Getting that backwards either hides work from the user or performs
// work the reconstruction was not sure about — the two worst outcomes a restore
// button has.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  normalizePlanRow,
  normalizePlan,
  planRows,
  actionableRows,
  uncertainRows,
  planSummary,
  hasWork,
  hasSnapshots,
  snapshotCount,
  versionMove,
  actionLabel,
  actionTone,
  uncertainNote,
  emptyPlanText,
  restoreConfirmText,
  blankRun,
  startRun,
  foldCheckpointProgress,
  isRunning,
  isFinished,
  phaseLabel,
  rowTone,
  runResultText,
} from '../../src/renderer/lib/checkpoint.js';
import {
  renderCheckpointSheet,
  renderPlanRow,
  renderPlanTable,
  renderProgress,
  renderRestoreControl,
  checkpointMoment,
} from '../../src/renderer/views/checkpoint.js';
import { renderActivitySheet, renderDayGroup, renderEventRow, canRestoreAt } from '../../src/renderer/views/activity.js';
import { normalizeEvents, groupByDay } from '../../src/renderer/lib/events.js';
import { createMock } from '../../src/renderer/mock.js';

const TS = Date.parse('2026-08-20T14:32:00Z');

const PLAN = {
  ts: TS,
  apps: [
    { appId: 'wivrn-nx', artifactId: 'tarball', version: '1.9.1', currentVersion: '1.9.2', action: 'install', snapshot: 'a.tar.zst' },
    { appId: 'pulsenx', artifactId: 'appimage', version: '2.3.0', currentVersion: '2.3.0', action: 'none' },
    { appId: 'quadforge', artifactId: 'addon', version: '', currentVersion: '0.9.0', action: 'remove' },
    { appId: 'ogb', artifactId: 'appimage', version: '1.4.1', currentVersion: '', action: 'install', uncertain: true, reason: 'tag gone' },
  ],
};

const APPS = [
  { id: 'wivrn-nx', name: 'WiVRn NX' },
  { id: 'pulsenx', name: 'PulseNX' },
  { id: 'quadforge', name: 'QuadForge' },
];

/* ------------------------------------------------------------- normalize */

test('a plan row survives every shape [replay] could hand over', () => {
  const row = normalizePlanRow({ appId: 'WiVRn-NX', action: 'install', version: 1.9, uncertain: 1 });
  assert.equal(row.appId, 'wivrn-nx', 'ids are lowercased like everywhere else');
  assert.equal(row.version, '1.9');
  assert.equal(row.uncertain, true);
  assert.equal(row.currentVersion, '');
  assert.equal(row.snapshot, '');

  // An unknown verb degrades to "no change" — never to a guess about the disk.
  assert.equal(normalizePlanRow({ appId: 'x', action: 'nuke' }).action, 'none');
  assert.equal(normalizePlanRow({ appId: 'x' }).action, 'none');
  assert.deepEqual(ACTIONS, ['none', 'install', 'remove']);

  // No app id → no row: it could not be shown or acted on.
  assert.equal(normalizePlanRow({ action: 'install' }), null);
  assert.equal(normalizePlanRow(null), null);
});

test('a plan keeps one row per app+artifact and always has a usable timestamp', () => {
  const plan = normalizePlan({
    ts: TS,
    apps: [{ appId: 'a', action: 'install' }, { appId: 'a', action: 'remove' }, null, { nothing: true }],
  });
  assert.equal(plan.apps.length, 1);
  assert.equal(plan.apps[0].action, 'install', 'the first row wins — a plan cannot disagree with itself');
  assert.equal(plan.ts, TS);

  // ...but an app that ships several artifacts moves them independently, and
  // [replay] reconstructs a version per (app, artifact). Collapsing those onto
  // the app id would show one row and restore two.
  const multi = normalizePlan({
    ts: TS,
    apps: [
      { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', action: 'install', version: '1.9.1' },
      { appId: 'wivrn-nx', artifactId: 'apk-adb-android', action: 'remove', currentVersion: '1.8.0' },
      { appId: 'wivrn-nx', artifactId: 'apk-adb-android', action: 'install', version: '9.9.9' },
    ],
  });
  assert.equal(multi.apps.length, 2, 'both artifacts survive; the repeated pair does not');
  assert.deepEqual(multi.apps.map((r) => r.artifactId), ['tarball-prefix-linux', 'apk-adb-android']);
  assert.equal(multi.apps[1].action, 'remove', 'the first row for a pair still wins');

  // A plan with no ts of its own borrows the moment that was asked for.
  assert.equal(normalizePlan({ apps: [] }, { ts: TS }).ts, TS);
  assert.equal(normalizePlan(null, { ts: TS }).ts, TS);
  assert.equal(normalizePlan(null).ts, 0);
  assert.deepEqual(normalizePlan('nope').apps, []);
});

/* ------------------------------------------------------------ arithmetic */

test('uncertain rows are counted, shown, and never included in the work', () => {
  const plan = normalizePlan(PLAN);
  assert.equal(planRows(plan).length, 4, 'every row stays on screen');
  assert.deepEqual(actionableRows(plan).map((r) => r.appId), ['wivrn-nx', 'quadforge']);
  assert.deepEqual(uncertainRows(plan).map((r) => r.appId), ['ogb']);

  const s = planSummary(plan);
  assert.deepEqual(s, { install: 1, remove: 1, none: 1, uncertain: 1, changes: 2, total: 4 });
  assert.equal(hasWork(plan), true);
});

test('a plan of nothing but "none" has nothing to confirm', () => {
  const plan = normalizePlan({ ts: TS, apps: [{ appId: 'a', action: 'none' }] });
  assert.equal(hasWork(plan), false);
  assert.equal(emptyPlanText(plan), 'Everything already matches that point. Nothing would change.');
  assert.match(emptyPlanText(normalizePlan({ apps: [] })), /nothing to restore/);
  assert.equal(emptyPlanText(normalizePlan(PLAN)), '');
});

test('a plan whose only work is uncertain is not work', () => {
  const plan = normalizePlan({ ts: TS, apps: [{ appId: 'a', action: 'install', uncertain: true }] });
  assert.equal(hasWork(plan), false);
  assert.equal(planSummary(plan).changes, 0);
});

test('the config toggle exists only when a TOUCHED row kept a snapshot', () => {
  assert.equal(hasSnapshots(normalizePlan(PLAN)), true);
  assert.equal(snapshotCount(normalizePlan(PLAN)), 1);

  // A snapshot on a row nothing will happen to is not something to offer.
  const idle = normalizePlan({ ts: TS, apps: [{ appId: 'a', action: 'none', snapshot: 'x.tar.zst' }] });
  assert.equal(hasSnapshots(idle), false);

  // …and neither is one on a row that is being skipped.
  const skipped = normalizePlan({
    ts: TS,
    apps: [{ appId: 'a', action: 'install', uncertain: true, snapshot: 'x.tar.zst' }],
  });
  assert.equal(hasSnapshots(skipped), false);
});

test('the move reads "now → then" with the empty side spelled out', () => {
  assert.deepEqual(versionMove({ currentVersion: '1.9.2', version: '1.9.1' }), {
    from: '1.9.2',
    to: '1.9.1',
    same: false,
  });
  assert.deepEqual(versionMove({ currentVersion: '0.9.0', version: '' }), {
    from: '0.9.0',
    to: 'not installed',
    same: false,
  });
  assert.deepEqual(versionMove({ currentVersion: '', version: '1.0' }), {
    from: 'not installed',
    to: '1.0',
    same: false,
  });
  assert.equal(versionMove({ currentVersion: '2', version: '2' }).same, true);
  assert.equal(versionMove(null).from, 'not installed');
});

test('the palette obeys DESIGN §1 — amber means attention, never danger', () => {
  assert.equal(actionTone({ action: 'install' }), 'cyan');
  assert.equal(actionTone({ action: 'remove' }), 'violet', 'a removal is planned work, not an alarm');
  assert.equal(actionTone({ action: 'none' }), 'muted');
  assert.equal(actionTone({ action: 'install', uncertain: true }), 'amber');
  assert.equal(actionTone(null), 'muted');

  assert.equal(actionLabel('install'), 'install');
  assert.equal(actionLabel('remove'), 'remove');
  assert.equal(actionLabel('anything'), 'no change');
});

test('the copy says what happens and what is skipped', () => {
  const plan = normalizePlan(PLAN);
  assert.equal(
    uncertainNote(plan),
    '1 app cannot be placed — the release it needs is no longer published. It is left exactly as it is.'
  );
  assert.equal(uncertainNote(normalizePlan({ apps: [{ appId: 'a', action: 'none' }] })), '');

  const two = normalizePlan({
    apps: [
      { appId: 'a', action: 'install', uncertain: true },
      { appId: 'b', action: 'install', uncertain: true },
    ],
  });
  assert.match(uncertainNote(two), /^2 apps cannot be placed — the releases they need are/);

  const confirm = restoreConfirmText(plan, { configs: false });
  assert.match(confirm, /install or change 1 app and remove 1 app/);
  assert.match(confirm, /1 app will be skipped/);
  assert.ok(!confirm.includes('config'), 'the config sentence only appears when it was asked for');
  assert.match(restoreConfirmText(plan, { configs: true }), /Saved configs from that time are restored too/);
  assert.match(restoreConfirmText(normalizePlan({ apps: [] }), {}), /change nothing/);
});

/* --------------------------------------------------------------- folding */

test('progress folds per app, latest phase wins, order preserved', () => {
  let run = startRun(1000);
  assert.equal(isRunning(run), true);
  assert.equal(isFinished(run), false);

  run = foldCheckpointProgress(run, { phase: 'install', appId: 'wivrn-nx' }, 1001);
  run = foldCheckpointProgress(run, { phase: 'remove', appId: 'quadforge' }, 1002);
  run = foldCheckpointProgress(run, { phase: 'done', appId: 'wivrn-nx' }, 1003);
  assert.deepEqual(run.rows.map((r) => [r.appId, r.phase]), [
    ['wivrn-nx', 'done'],
    ['quadforge', 'remove'],
  ]);
  assert.equal(run.rows.length, 2, 'a repeat updates its row, never adds one');
  assert.equal(isRunning(run), true, 'one app finishing is not the run finishing');
});

test('a terminal phase WITHOUT an app id ends the whole run', () => {
  let run = foldCheckpointProgress(startRun(0), { phase: 'install', appId: 'a' });
  run = foldCheckpointProgress(run, { phase: 'done' });
  assert.equal(run.phase, 'done');
  assert.equal(isFinished(run), true);
  assert.equal(isRunning(run), false);

  let bad = foldCheckpointProgress(startRun(0), { phase: 'failed', message: 'asset is gone' });
  assert.equal(bad.phase, 'failed');
  assert.equal(bad.error, 'asset is gone');
  // `error` is accepted as a synonym for `failed` — main may say either.
  assert.equal(foldCheckpointProgress(startRun(0), { phase: 'error' }).phase, 'failed');
});

test('the run verdict closes every row main never reported on', () => {
  // [replay] emits a step's FAILURE and its success not at all, and a failed
  // step does not abort the rest. Without this rule every app that worked would
  // sit on "Installing…" after the restore had visibly finished.
  let run = startRun(0);
  run = foldCheckpointProgress(run, { phase: 'installing', appId: 'a' });
  run = foldCheckpointProgress(run, { phase: 'removing', appId: 'b' });
  run = foldCheckpointProgress(run, { phase: 'failed', appId: 'c', message: 'that tag 404s' });
  assert.equal(isRunning(run), true, 'one step failing does not end the run');

  run = foldCheckpointProgress(run, { phase: 'failed', appId: null });
  assert.deepEqual(run.rows.map((r) => [r.appId, r.phase]), [
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'failed'],
  ]);
  assert.equal(run.phase, 'failed', 'the run still says it did not go cleanly');
  assert.equal(rowTone(run.rows[2]), 'danger', 'and the row that broke stays red');

  // The same promotion on a clean ending.
  let ok = foldCheckpointProgress(startRun(0), { phase: 'installing', appId: 'a' });
  ok = foldCheckpointProgress(ok, { phase: 'done', appId: null });
  assert.equal(ok.rows[0].phase, 'done');
});

test('[replay]’s own vocabulary lands where the renderer expects it', () => {
  // The exact strings src/main/checkpoints.js emits.
  assert.equal(phaseLabel('planning'), 'Planning');
  assert.equal(phaseLabel('installing'), 'Installing');
  assert.equal(phaseLabel('removing'), 'Removing');
  // `planning` carries an explicit appId: null — that is a RUN event, not a row.
  const run = foldCheckpointProgress(startRun(0), { phase: 'planning', appId: null, artifactId: null });
  assert.deepEqual(run.rows, []);
  assert.equal(run.phase, 'running');

  // And its plan rows: `why` + `skipReason`, `appName`, null versions.
  const row = normalizePlanRow({
    appId: 'gone-app',
    appName: 'An App That Left',
    action: 'install',
    version: null,
    currentVersion: null,
    uncertain: true,
    why: 'the journal cannot say what was installed then',
    skipReason: 'uncertain',
  });
  assert.equal(row.version, '', 'a null version is "not installed", not the string "null"');
  assert.equal(row.currentVersion, '');
  assert.equal(row.reason, 'the journal cannot say what was installed then');
  assert.equal(row.skipReason, 'uncertain');
  assert.match(renderPlanRow(row, { apps: [] }), /An App That Left/, 'a name this hub never knew still shows');
  assert.match(renderPlanRow(row, { apps: [] }), /title="the journal cannot say/);
  // The local catalogue still wins when it has the app.
  assert.match(renderPlanRow(row, { apps: [{ id: 'gone-app', name: 'Local Name' }] }), /Local Name/);
});

test('folding survives junk, and never resurrects a finished run', () => {
  const start = startRun(0);
  assert.equal(foldCheckpointProgress(start, null), start);
  assert.equal(foldCheckpointProgress(start, 'nope'), start);
  assert.deepEqual(foldCheckpointProgress(null, { phase: 'install', appId: 'a' }).rows.length, 1);

  let done = foldCheckpointProgress(startRun(0), { phase: 'done' });
  done = foldCheckpointProgress(done, { phase: 'install', appId: 'late' });
  assert.equal(done.phase, 'done', 'a stray late event does not restart a finished run');
  assert.equal(done.rows.length, 1, 'but it is still recorded');

  // A phase-less event is just "something is happening".
  assert.equal(foldCheckpointProgress(blankRun(), { appId: 'a' }).rows[0].phase, 'working');
  assert.equal(foldCheckpointProgress(blankRun(), {}).phase, 'running');
});

test('phase labels are readable, and an unknown phase still reads', () => {
  assert.equal(phaseLabel('install'), 'Installing');
  assert.equal(phaseLabel('remove'), 'Removing');
  assert.equal(phaseLabel('config'), 'Restoring config');
  assert.equal(phaseLabel('done'), 'Done');
  assert.equal(phaseLabel('failed'), 'Failed');
  assert.equal(phaseLabel('post-verify'), 'Post verify');
  assert.equal(phaseLabel(''), 'Working');

  assert.equal(rowTone({ phase: 'failed' }), 'danger');
  assert.equal(rowTone({ phase: 'done' }), 'cyan');
  assert.equal(rowTone({ phase: 'skipped' }), 'muted');
  assert.equal(rowTone({ phase: 'install' }), 'violet');
});

test('the result line counts what actually landed', () => {
  const plan = normalizePlan(PLAN);
  let run = foldCheckpointProgress(startRun(0), { phase: 'done', appId: 'wivrn-nx' });
  run = foldCheckpointProgress(run, { phase: 'done', appId: 'quadforge' });
  assert.equal(runResultText(run, plan), '');
  run = foldCheckpointProgress(run, { phase: 'done' });
  assert.equal(runResultText(run, plan), 'Restored 2 apps. 1 could not be placed and was left alone.');

  const failed = foldCheckpointProgress(startRun(0), { phase: 'failed', message: 'the asset 404s' });
  assert.equal(runResultText(failed, plan), 'The restore stopped: the asset 404s');
  assert.match(runResultText(foldCheckpointProgress(startRun(0), { phase: 'failed' }), plan), /stopped before it finished/);
});

/* ---------------------------------------------------------------- markup */

test('the plan table renders the whole matrix: install, remove, none, skipped', () => {
  const plan = normalizePlan(PLAN);
  const out = renderPlanTable(plan, { apps: APPS });

  assert.match(out, /<td class="cp-name">\s*<span class="cp-title">WiVRn NX<\/span>/, 'names come from the catalogue');
  assert.match(out, />ogb</, 'an app this hub never discovered still shows its id');
  assert.match(out, /cp-chip cp-chip-cyan">install</);
  assert.match(out, /cp-chip cp-chip-violet">remove</);
  assert.match(out, /cp-chip cp-chip-muted">no change</);
  assert.match(out, /cp-chip-amber"[^>]*>skipped</);
  assert.match(out, /is-uncertain/);
  assert.match(out, /title="tag gone"/, 'the row says WHY it cannot be placed');
  assert.match(out, /class="cp-snap"/, 'the row that kept a config says so');
  assert.match(out, /1\.9\.2<\/span>\s*<span class="cp-arrow"[^>]*>→<\/span>\s*<span class="cp-to">1\.9\.1/);
  assert.match(out, />not installed</);

  assert.equal(renderPlanTable(normalizePlan({ apps: [] })), '', 'an empty plan renders no table');
});

test('two rows under one app name say which build they mean', () => {
  const apps = [
    {
      id: 'wivrn-nx',
      name: 'WiVRn NX',
      artifacts: [
        { id: 'tarball-prefix-linux', label: 'Linux server + dashboard' },
        { id: 'apk-adb-android', label: 'Pico headset APK' },
      ],
    },
    { id: 'pulsenx', name: 'PulseNX', artifacts: [{ id: 'appimage-linux', label: 'Linux app' }] },
  ];
  const plan = normalizePlan({
    ts: TS,
    apps: [
      { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', action: 'install', version: '1.9.1' },
      { appId: 'wivrn-nx', artifactId: 'apk-adb-android', action: 'remove', currentVersion: '1.8.0' },
      { appId: 'pulsenx', artifactId: 'appimage-linux', action: 'none' },
    ],
  });
  const out = renderPlanTable(plan, { apps });

  assert.match(out, /cp-art">Linux server \+ dashboard</);
  assert.match(out, /cp-art">Pico headset APK</);
  assert.equal(
    (out.match(/class="cp-art"/g) || []).length,
    2,
    'only the ambiguous app is qualified — PulseNX appears once and stays plain'
  );
  assert.match(out, /data-cp-artifact="apk-adb-android"/, 'the row carries its artifact for the DOM too');

  // An artifact this hub cannot name still gets told apart by its id.
  const unknown = renderPlanTable(
    normalizePlan({
      apps: [
        { appId: 'ghost', artifactId: 'one', action: 'install', version: '1' },
        { appId: 'ghost', artifactId: 'two', action: 'install', version: '2' },
      ],
    }),
    { apps }
  );
  assert.match(unknown, /cp-art">one</);
  assert.match(unknown, /cp-art">two</);
});

test('progress rows track each artifact separately and read as names', () => {
  const apps = [
    {
      id: 'wivrn-nx',
      name: 'WiVRn NX',
      artifacts: [
        { id: 'tarball-prefix-linux', label: 'Linux server + dashboard' },
        { id: 'apk-adb-android', label: 'Pico headset APK' },
      ],
    },
  ];
  let run = startRun(0);
  run = foldCheckpointProgress(run, { phase: 'installing', appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux' });
  run = foldCheckpointProgress(run, { phase: 'removing', appId: 'wivrn-nx', artifactId: 'apk-adb-android' });
  assert.equal(run.rows.length, 2, 'one app, two artifacts, two rows');

  // A later event for one pair updates ONLY that row.
  run = foldCheckpointProgress(run, {
    phase: 'failed',
    appId: 'wivrn-nx',
    artifactId: 'apk-adb-android',
    message: 'the device went away',
  });
  assert.equal(run.rows[0].phase, 'installing');
  assert.equal(run.rows[1].phase, 'failed');

  const out = renderProgress(run, null, { apps });
  assert.match(out, /WiVRn NX · Linux server \+ dashboard/);
  assert.match(out, /WiVRn NX · Pico headset APK/);
  assert.doesNotMatch(out, />wivrn-nx</, 'the raw id is not what a person reads');

  // The run's own verdict still closes every row that never failed.
  const ended = foldCheckpointProgress(run, { phase: 'done' });
  assert.deepEqual(ended.rows.map((r) => r.phase), ['done', 'failed']);
});

test('a progress event with no artifact still lands on the app it belongs to', () => {
  let run = startRun(0);
  run = foldCheckpointProgress(run, { phase: 'installing', appId: 'pulsenx' });
  run = foldCheckpointProgress(run, { phase: 'done', appId: 'pulsenx' });
  assert.equal(run.rows.length, 1, 'a build that names no artifact does not grow a second row');
  assert.equal(run.rows[0].phase, 'done');

  // Mixed: an artifact-less event after an artifact-keyed one updates the open row
  // rather than opening another.
  let mixed = startRun(0);
  mixed = foldCheckpointProgress(mixed, { phase: 'installing', appId: 'a', artifactId: 'x' });
  mixed = foldCheckpointProgress(mixed, { phase: 'failed', appId: 'a', message: 'boom' });
  assert.equal(mixed.rows.length, 1);
  assert.equal(mixed.rows[0].phase, 'failed');
  assert.equal(mixed.rows[0].artifactId, 'x', 'the row keeps the artifact it was opened with');
});

test('a plan row escapes everything the recorder recorded', () => {
  const row = normalizePlanRow({
    appId: '"><script>x</script>',
    version: '"><img src=x>',
    currentVersion: '<b>1</b>',
    action: 'install',
    snapshot: '"><i>s',
    uncertain: true,
    reason: '"><u>why',
  });
  const out = renderPlanRow(row, { apps: [] });
  for (const bad of ['<script', '<img', '<b>', '<i>', '<u>']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  assert.match(out, /&lt;script&gt;/);
});

test('the sheet walks loading → plan → progress → done', () => {
  const plan = normalizePlan(PLAN);

  const loading = renderCheckpointSheet({ ts: TS, loading: true, now: TS });
  assert.match(loading, /Reconstructing that moment/);
  assert.ok(!loading.includes('checkpoint-confirm'), 'nothing to confirm before there is a plan');

  const error = renderCheckpointSheet({ ts: TS, error: 'the recorder is empty', now: TS });
  assert.match(error, /the recorder is empty/);
  assert.match(error, /data-act="checkpoint-retry"/);

  const ready = renderCheckpointSheet({ ts: TS, plan, apps: APPS, now: TS });
  assert.match(ready, /Restore to Today 1[0-9]:[0-9]{2}|Restore to \d+ \w+ \d{4}/);
  assert.match(ready, /1 to install · 1 to remove · 1 skipped/);
  assert.match(ready, /data-act="checkpoint-confirm"/);
  assert.match(ready, /data-act="checkpoint-configs"/, 'the toggle is here because a snapshot is');
  assert.match(ready, /cp-note/, 'and so is the skipped-rows note');

  const checked = renderCheckpointSheet({ ts: TS, plan, apps: APPS, configs: true, now: TS });
  assert.match(checked, /data-act="checkpoint-configs" checked/);

  const busy = renderCheckpointSheet({ ts: TS, plan, apps: APPS, busy: true, now: TS });
  assert.match(busy, /Restoring…/);
  assert.match(busy, /disabled/);

  let run = foldCheckpointProgress(startRun(0), { phase: 'install', appId: 'wivrn-nx' });
  const running = renderCheckpointSheet({ ts: TS, plan, apps: APPS, run, now: TS });
  assert.match(running, /class="cp-progress"/);
  assert.match(running, />Installing</);
  assert.ok(!running.includes('checkpoint-confirm'), 'no second confirm while it runs');
  assert.ok(!running.includes('cp-table'), 'the table gives way to the progress it became');

  run = foldCheckpointProgress(run, { phase: 'done', appId: 'wivrn-nx' });
  run = foldCheckpointProgress(run, { phase: 'done' });
  const done = renderCheckpointSheet({ ts: TS, plan, apps: APPS, run, now: TS });
  assert.match(done, /field-ok/);
  assert.match(done, /Restored 1 app/);
  assert.match(done, /data-act="close-sheet">Close</);

  const failed = renderCheckpointSheet({
    ts: TS,
    plan,
    apps: APPS,
    run: foldCheckpointProgress(startRun(0), { phase: 'failed', message: 'nope' }),
    now: TS,
  });
  assert.match(failed, /field-error/);
  assert.match(failed, /The restore stopped: nope/);
});

test('a plan with nothing to do offers no confirm button at all', () => {
  const plan = normalizePlan({ ts: TS, apps: [{ appId: 'a', action: 'none' }] });
  const out = renderCheckpointSheet({ ts: TS, plan, now: TS });
  assert.ok(!out.includes('checkpoint-confirm'), out);
  assert.match(out, /Everything already matches that point/);
});

test('the progress list starts honestly, before any row exists', () => {
  assert.match(renderProgress(startRun(0), null), /Starting the restore/);
  const out = renderProgress(foldCheckpointProgress(startRun(0), { phase: 'install', appId: '"><b>x' }), null);
  assert.ok(!out.includes('<b>'), out);
});

test('the moment is hand-formatted, never toLocaleString', () => {
  const now = Date.parse('2026-08-20T20:00:00Z');
  assert.match(checkpointMoment(Date.parse('2026-08-20T14:32:00Z'), now), /^Today \d{2}:\d{2}$/);
  assert.match(checkpointMoment(Date.parse('2026-08-19T14:32:00Z'), now), /^Yesterday \d{2}:\d{2}$/);
  assert.match(checkpointMoment(Date.parse('2026-08-02T14:32:00Z'), now), /^2 Aug 2026 \d{2}:\d{2}$/);
  assert.equal(checkpointMoment(0), '');
  assert.equal(checkpointMoment('nope'), '');
});

/* ------------------------------------------------- the Activity entry point */

test('only rows that CHANGED the machine carry a restore control', () => {
  assert.equal(canRestoreAt({ type: 'job-done', ts: 1 }), true);
  assert.equal(canRestoreAt({ type: 'stack-progress', ts: 1 }), true);
  assert.equal(canRestoreAt({ type: 'connector-join', ts: 1 }), false, 'a bus join changed nothing on disk');
  assert.equal(canRestoreAt({ type: 'update-available', ts: 1 }), false);
  assert.equal(canRestoreAt({ type: 'job-done', ts: 0 }), false, 'and a row with no moment has nowhere to go');
  assert.equal(canRestoreAt(null), false);
});

test('the affordance appears on day separators and change rows — only with the cap', () => {
  const events = normalizeEvents([
    { ts: TS, type: 'job-done', summary: 'WiVRn NX installed', appId: 'wivrn-nx' },
    { ts: TS - 60000, type: 'connector-join', summary: 'pulsenx joined', appId: 'pulsenx' },
  ]);
  const group = groupByDay(events, TS)[0];

  const on = renderDayGroup(group, { canRestore: true });
  assert.equal(on.match(/data-act="checkpoint"/g).length, 2, 'the separator and the one job row');
  assert.match(on, new RegExp(`data-ts="${TS}"`));
  assert.ok(!/act-row act-cyan has-restore/.test(on), 'the bus join gets none');

  const off = renderDayGroup(group, {});
  assert.ok(!off.includes('data-act="checkpoint"'), 'no getCheckpoint() → the timeline is unchanged');
  assert.equal(renderDayGroup(group), off, 'and the old one-argument call still works');
  assert.equal(renderEventRow(events[0]), renderEventRow(events[0], {}));

  const sheet = renderActivitySheet({ events, now: TS, canRestore: true });
  assert.match(sheet, /class="act-restore"/);
  assert.ok(!renderActivitySheet({ events, now: TS }).includes('act-restore'));
});

test('the restore control refuses a moment it cannot use', () => {
  assert.equal(renderRestoreControl(0), '');
  assert.equal(renderRestoreControl('nope'), '');
  assert.equal(renderRestoreControl(-5), '');
  assert.match(renderRestoreControl(TS + 0.7), new RegExp(`data-ts="${TS + 1}"`), 'a fractional ms is rounded');
});

/* ----------------------------------------------------------- mock bridge */

test('the mock reconstructs a mixed plan and applies exactly the certain half', async () => {
  const { nxhub, dev } = createMock();
  const plan = normalizePlan(await nxhub.getCheckpoint(Date.now() - 3600000));

  const s = planSummary(plan);
  assert.ok(s.install >= 1 && s.remove >= 1, 'something to install and something to remove');
  assert.equal(s.uncertain, 2, 'and two rows the reconstruction could not place');
  assert.equal(hasSnapshots(plan), true, 'with a config to offer');

  // Relative forms, exactly as the recorder accepts them.
  assert.ok((await nxhub.getCheckpoint('24h')).ts < Date.now());
  assert.ok((await nxhub.getCheckpoint('3d')).ts < (await nxhub.getCheckpoint('90m')).ts);

  const progress = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'checkpoint-progress') progress.push(ev);
  });
  await nxhub.restoreCheckpoint(Date.now() - 3600000, { configs: false });
  await new Promise((r) => setTimeout(r, 4000));

  assert.ok(progress.length >= 4, `expected a narrated restore, got ${progress.length} events`);
  assert.equal(progress[0].phase, 'planning', 'it opens by saying it is planning');
  assert.equal(progress[0].appId, null);
  assert.ok(
    progress.some((p) => p.phase === 'installing') && progress.some((p) => p.phase === 'removing'),
    '[replay]’s own verbs, not a second vocabulary'
  );
  assert.ok(!progress.some((p) => p.phase === 'done' && p.appId), 'main never sends a per-app done, so neither does this');
  const terminal = progress[progress.length - 1];
  assert.equal(terminal.phase, 'done');
  assert.equal(terminal.appId, null, 'the last word is about the RUN, not an app');
  const touched = new Set(progress.filter((p) => p.appId).map((p) => p.appId));
  assert.ok(!touched.has('oscgoesbrrr-nx-patches'), 'an uncertain row is never walked');
  assert.ok(!touched.has('banish-protocol'));

  // The disk really moved: the plan was applied, not mimed.
  const state = await nxhub.getState();
  const wivrn = state.apps.find((a) => a.id === 'wivrn-nx').artifacts.find((a) => a.id === 'tarball-prefix-linux');
  assert.equal(wivrn.installed.version, '1.9.1');
  const quad = state.apps.find((a) => a.id === 'quadforge').artifacts.find((a) => a.id === 'blender-addon-linux');
  assert.equal(quad.installed, null, 'and the removal happened too');
  dev.stop();
});

test('the mock can also stop a restore partway', async () => {
  const { nxhub, dev } = createMock();
  assert.equal(dev.toggleCheckpointFailure(), true);
  const seen = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'checkpoint-progress') seen.push(ev);
  });
  await nxhub.restoreCheckpoint(Date.now() - 3600000, {});
  await new Promise((r) => setTimeout(r, 4000));

  // A failing step does NOT abort the rest — the verdict at the end is what
  // turns the run red, exactly as src/main/checkpoints.js behaves.
  const terminal = seen[seen.length - 1];
  assert.equal(terminal.phase, 'failed');
  assert.equal(terminal.appId, null);
  assert.ok(seen.some((e) => e.phase === 'failed' && e.appId), 'and the row that broke says which one it was');
  const afterFailure = seen.slice(seen.findIndex((e) => e.phase === 'failed' && e.appId) + 1);
  assert.ok(afterFailure.some((e) => e.appId), 'the walk carried on past it');

  // Folded, that is one red row and the rest closed by the verdict.
  const run = seen.reduce((acc, ev) => foldCheckpointProgress(acc, ev), startRun(0));
  assert.equal(run.phase, 'failed');
  assert.equal(run.rows.filter((r) => r.phase === 'failed').length, 1);
  assert.ok(run.rows.every((r) => r.phase === 'failed' || r.phase === 'done'), 'nothing is left mid-flight');
  dev.stop();
});

test('the mock walks the config phase when the toggle asked for it', async () => {
  const { nxhub, dev } = createMock();
  const seen = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'checkpoint-progress') seen.push(ev);
  });
  await nxhub.restoreCheckpoint(Date.now() - 3600000, { configs: true });
  await new Promise((r) => setTimeout(r, 5000));
  assert.ok(seen.some((e) => e.phase === 'config'), `expected a config phase, saw ${seen.map((e) => e.phase).join(',')}`);
  dev.stop();
});
