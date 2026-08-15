import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugify,
  normalizeStack,
  normalizeStacks,
  normalizeHealth,
  blankDraft,
  blankStep,
  draftFromStack,
  stackFromDraft,
  validateDraft,
  moveStep,
  applyStackProgress,
  newRun,
  isFinished,
  stepGlyph,
  stepStateClass,
  stackTiles,
  runLabel,
  pickableApps,
  stepArtifacts,
  healthLabel,
  MAX_TIMEOUT_MS,
} from '../../src/renderer/lib/stacks.js';
import { renderStackTile, renderStackTiles, renderStackGhost } from '../../src/renderer/views/stacktile.js';
import { renderStacksSheet } from '../../src/renderer/views/stacks.js';
import { renderLaunchGrid } from '../../src/renderer/views/tile.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const STACK = {
  id: 'vr-night',
  name: 'VR Night',
  steps: [
    { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', health: { type: 'connector', timeoutMs: 30000 } },
    { appId: 'oscgoesbrrr-nx-patches', health: { type: 'delay', timeoutMs: 1500 }, optional: true },
    { appId: 'pulsenx', health: { type: 'port', port: 9000, timeoutMs: 20000 } },
  ],
};

const APPS = [
  normalizeApp({
    id: 'wivrn-nx',
    repo: 'nerdrx/wivrn-nx',
    name: 'WiVRn NX',
    latest: { version: '1.9.2' },
    artifacts: [
      { id: 'apk-adb-android', label: 'Headset APK', platform: 'android', kind: 'apk-adb' },
      { id: 'tarball-prefix-linux', label: 'Linux server', platform: 'linux', kind: 'tarball-prefix' },
    ],
  }),
  normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    latest: { version: '2.3.0' },
    artifacts: [{ id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage' }],
  }),
  normalizeApp({
    id: 'quadforge',
    repo: 'nerdrx/quadforge',
    name: 'QuadForge',
    latest: { version: '0.9.0' },
    artifacts: [{ id: 'blender-addon-linux', label: 'Addon', platform: 'linux', kind: 'blender-addon' }],
  }),
  normalizeApp({ id: 'nxtakt', repo: 'nerdrx/nxtakt', name: 'NxTakt', unpublished: true, artifacts: [] }),
];

const ev = (stepIndex, appId, phase, stackId = 'vr-night') => ({
  type: 'stack-progress',
  stackId,
  stepIndex,
  appId,
  phase,
});

function fold(events, stack = normalizeStack(STACK)) {
  let run = null;
  for (const e of events) run = applyStackProgress(run, e, { stack, now: 1000 });
  return run;
}

/* ------------------------------------------------------------------ model */

test('ids are slugified from the name, ASCII only', () => {
  assert.equal(slugify('VR Night'), 'vr-night');
  assert.equal(slugify('  Stream & Chill!!  '), 'stream-chill');
  assert.equal(slugify('###'), '');
  assert.equal(slugify('Über Setup'), 'ber-setup', 'no locale surprises');
  assert.equal(slugify('x'.repeat(80)).length, 48);
  assert.equal(slugify(null), '');
});

test('the stack model round-trips through the editor draft', () => {
  const stack = normalizeStack(STACK);
  const draft = draftFromStack(stack);
  assert.equal(draft.originalId, 'vr-night');
  assert.equal(draft.name, 'VR Night');
  assert.deepEqual(draft.steps[0], {
    appId: 'wivrn-nx',
    artifactId: 'tarball-prefix-linux',
    healthType: 'connector',
    port: '',
    timeoutMs: '30000',
  optional: false,
  });
  assert.equal(draft.steps[1].optional, true);
  assert.equal(draft.steps[2].port, '9000');

  const back = stackFromDraft({ ...draft, name: 'VR Night' });
  assert.deepEqual(back, stack, 'draft → stack → draft loses nothing');
});

test('health rules normalize to exactly what SPEC allows', () => {
  assert.deepEqual(normalizeHealth(null), { type: 'connector' });
  assert.deepEqual(normalizeHealth({ type: 'nonsense', port: 80 }), { type: 'connector' });
  assert.deepEqual(normalizeHealth({ type: 'port', port: '9021', timeoutMs: '5000' }), {
    type: 'port',
    timeoutMs: 5000,
    port: 9021,
  });
  assert.deepEqual(normalizeHealth({ type: 'delay', timeoutMs: 1500, port: 80 }), {
    type: 'delay',
    timeoutMs: 1500,
  }, 'a port on a delay gate is dropped');
  assert.deepEqual(normalizeHealth({ type: 'connector', timeoutMs: -1 }), { type: 'connector' });

  assert.equal(healthLabel({ type: 'port', port: 9021 }), 'port 9021');
  assert.equal(healthLabel({ type: 'delay', timeoutMs: 1500 }), 'wait 1500 ms');
  assert.equal(healthLabel(null), 'on the bus');
});

test('a stack from disk is defended against every junk shape', () => {
  assert.deepEqual(normalizeStacks(null), []);
  assert.deepEqual(normalizeStacks([{ name: '' }, 7]), []);
  const [one] = normalizeStacks([{ name: 'Only Name', steps: [{ appId: 'A' }, {}, 'x'] }]);
  assert.equal(one.id, 'only-name');
  assert.deepEqual(one.steps, [{ appId: 'a', health: { type: 'connector' } }], 'stepless junk is dropped');
});

/* -------------------------------------------------------------- validation */

test('the editor refuses what main would refuse', () => {
  const stacks = normalizeStacks([STACK]);

  const empty = validateDraft(blankDraft(), stacks);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.name, /name/i);
  assert.match(empty.errors['step-0-appId'], /Pick an app/);

  const noSteps = validateDraft({ name: 'Solo', steps: [] }, stacks);
  assert.equal(noSteps.ok, false);
  assert.match(noSteps.errors.steps, /at least one step/);

  const unslug = validateDraft({ name: '###', steps: [{ ...blankStep(), appId: 'a' }] }, stacks);
  assert.match(unslug.errors.name, /no letters or digits/);

  const clash = validateDraft({ name: 'vr night', steps: [{ ...blankStep(), appId: 'a' }] }, stacks);
  assert.equal(clash.ok, false);
  assert.match(clash.errors.name, /already uses the id “vr-night”/);

  const rename = validateDraft(
    { originalId: 'vr-night', name: 'VR Night', steps: [{ ...blankStep(), appId: 'a' }] },
    stacks
  );
  assert.equal(rename.ok, true, 'editing a stack does not collide with itself');
});

test('a port gate needs a port, a delay gate needs a wait', () => {
  const base = (patch) => ({ name: 'S', steps: [{ ...blankStep(), appId: 'a', ...patch }] });

  assert.match(validateDraft(base({ healthType: 'port' })).errors['step-0-port'], /needs a port/);
  assert.match(validateDraft(base({ healthType: 'port', port: '0' })).errors['step-0-port'], /1 to 65535/);
  assert.match(validateDraft(base({ healthType: 'port', port: '70000' })).errors['step-0-port'], /1 to 65535/);
  assert.match(validateDraft(base({ healthType: 'port', port: '80.5' })).errors['step-0-port'], /1 to 65535/);
  assert.equal(validateDraft(base({ healthType: 'port', port: '9021' })).ok, true);

  assert.match(validateDraft(base({ healthType: 'delay' })).errors['step-0-timeoutMs'], /wait in milliseconds/);
  assert.equal(validateDraft(base({ healthType: 'delay', timeoutMs: '1500' })).ok, true);

  assert.equal(validateDraft(base({})).ok, true, 'a connector gate needs nothing else');
  assert.equal(validateDraft(base({ timeoutMs: '5000' })).ok, true);
  assert.match(
    validateDraft(base({ timeoutMs: String(MAX_TIMEOUT_MS + 1) })).errors['step-0-timeoutMs'],
    /milliseconds/
  );
});

test('steps reorder without losing anything', () => {
  const steps = ['a', 'b', 'c'];
  assert.deepEqual(moveStep(steps, 2, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveStep(steps, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveStep(steps, 0, -1), steps, 'off the top is a no-op');
  assert.deepEqual(moveStep(steps, 2, 3), steps, 'off the bottom is a no-op');
  assert.deepEqual(moveStep(null, 0, 1), []);
});

/* -------------------------------------------------------- progress machine */

test('the glyph machine walks a healthy run to done', () => {
  const seq = [
    ev(0, 'wivrn-nx', 'launching'),
    ev(0, 'wivrn-nx', 'waiting'),
    ev(0, 'wivrn-nx', 'healthy'),
    ev(1, 'oscgoesbrrr-nx-patches', 'launching'),
    ev(1, 'oscgoesbrrr-nx-patches', 'waiting'),
    ev(1, 'oscgoesbrrr-nx-patches', 'healthy'),
    ev(2, 'pulsenx', 'launching'),
    ev(2, 'pulsenx', 'healthy'),
    ev(2, 'pulsenx', 'done'),
  ];
  // Halfway through, the tile shows exactly where the run is.
  const mid = fold(seq.slice(0, 4));
  assert.deepEqual(mid.steps, ['healthy', 'launching']);
  assert.equal(mid.phase, 'running');
  assert.equal(isFinished(mid), false);
  assert.deepEqual(mid.steps.map(stepGlyph), ['✓', '▸']);
  assert.deepEqual(mid.steps.map(stepStateClass), ['ok', 'go']);

  const done = fold(seq);
  assert.deepEqual(done.steps, ['healthy', 'healthy', 'healthy']);
  assert.equal(done.phase, 'done');
  assert.equal(isFinished(done), true);
  assert.equal(done.finishedAt, 1000);
});

test('an optional step that fails does not end the run', () => {
  const run = fold([
    ev(0, 'wivrn-nx', 'launching'),
    ev(0, 'wivrn-nx', 'healthy'),
    ev(1, 'oscgoesbrrr-nx-patches', 'waiting'),
    ev(1, 'oscgoesbrrr-nx-patches', 'failed'),
    ev(2, 'pulsenx', 'launching'),
  ]);
  assert.equal(run.phase, 'running');
  assert.deepEqual(run.steps, ['healthy', 'failed', 'launching']);
  assert.deepEqual(run.skipped, [1]);
  assert.equal(stepGlyph(run.steps[1]), '✕');
  assert.equal(stepStateClass(run.steps[1]), 'bad');
});

test('a required step that fails stops the run right there', () => {
  const run = fold([
    ev(0, 'wivrn-nx', 'launching'),
    ev(0, 'wivrn-nx', 'waiting'),
    ev(0, 'wivrn-nx', 'failed'),
  ]);
  assert.equal(run.phase, 'failed');
  assert.equal(run.failedIndex, 0);
  assert.equal(isFinished(run), true);
  assert.equal(runLabel(run, normalizeStack(STACK), APPS), 'WiVRn NX did not come up');
});

test('stopping walks through stopping → stopped', () => {
  const running = fold([ev(0, 'wivrn-nx', 'healthy'), ev(1, 'oscgoesbrrr-nx-patches', 'waiting')]);
  const stopping = applyStackProgress(running, ev(1, 'oscgoesbrrr-nx-patches', 'stopping'), { now: 1 });
  assert.equal(stopping.phase, 'stopping');
  assert.equal(isFinished(stopping), false);

  const stopped = applyStackProgress(stopping, ev(0, 'wivrn-nx', 'stopped'), { now: 2 });
  assert.equal(stopped.phase, 'stopped');
  assert.equal(isFinished(stopped), true);
  assert.equal(stepGlyph(stopped.steps[0]), '·');
});

test('the machine shrugs off junk and re-arms for the next run', () => {
  const done = fold([ev(0, 'wivrn-nx', 'done')]);
  for (const junk of [null, 'nope', {}, { stackId: 'vr-night' }, { phase: 'launching' }, ev(0, 'x', 'weird')]) {
    assert.equal(applyStackProgress(done, junk, {}), done, JSON.stringify(junk));
  }
  // An event for a different stack never touches this run.
  assert.equal(applyStackProgress(done, ev(0, 'x', 'launching', 'other'), {}), done);

  const again = applyStackProgress(done, ev(0, 'wivrn-nx', 'launching'), { now: 5 });
  assert.equal(again.phase, 'running');
  assert.deepEqual(again.steps, ['launching'], 'the finished run did not leak into the new one');

  assert.equal(applyStackProgress(null, ev(0, 'x', 'launching'), {}).phase, 'running');
  assert.equal(stepGlyph(''), '·');
  assert.equal(stepStateClass('nonsense'), 'idle');
  assert.equal(isFinished(null), false);
  assert.equal(runLabel(null, null, []), '');
});

test('the status line names the app and the phase', () => {
  const stack = normalizeStack(STACK);
  const say = (events) => runLabel(fold(events), stack, APPS);
  assert.equal(say([ev(0, 'wivrn-nx', 'launching')]), 'Launching WiVRn NX…');
  assert.equal(say([ev(0, 'wivrn-nx', 'waiting')]), 'Waiting for WiVRn NX…');
  assert.equal(say([ev(0, 'wivrn-nx', 'healthy')]), 'WiVRn NX is up');
  assert.equal(say([ev(1, 'oscgoesbrrr-nx-patches', 'failed')]), 'oscgoesbrrr-nx-patches timed out — carrying on');
  assert.equal(say([ev(2, 'pulsenx', 'done')]), 'Every step is up');
  assert.equal(say([ev(0, 'wivrn-nx', 'stopping')]), 'Stopping…');
  assert.equal(runLabel(newRun('vr-night'), stack, APPS), 'Running…');
});

/* ------------------------------------------------------------- tile render */

test('stack tiles carry a monogram and a glyph per step', () => {
  const runs = { 'vr-night': fold([ev(0, 'wivrn-nx', 'launching')]) };
  const [tile] = stackTiles([STACK], { apps: APPS, runs });
  assert.equal(tile.id, 'vr-night');
  assert.equal(tile.running, true);
  assert.deepEqual(tile.steps.map((s) => s.monogram), ['WN', 'ON', 'PN'], 'an unknown app falls back to its id');
  assert.deepEqual(tile.steps.map((s) => s.glyph), ['▸', '·', '·']);
  assert.deepEqual(tile.steps.map((s) => s.state), ['go', 'idle', 'idle']);
  assert.equal(tile.steps[1].optional, true);
  assert.equal(tile.status, 'Launching WiVRn NX…');

  const idle = stackTiles([STACK], { apps: APPS })[0];
  assert.equal(idle.running, false);
  assert.equal(idle.status, '');
});

test('the wide tile spans two columns, runs on click and offers Stop', () => {
  const [idle] = stackTiles([STACK], { apps: APPS });
  const out = renderStackTile(idle);
  assert.match(out, /class="tile tile-stack"/);
  assert.match(out, /data-act="stack-run"[^>]*data-stack="vr-night"/);
  assert.match(out, /data-act="stack-edit"[^>]*data-stack="vr-night"/);
  assert.match(out, /st-kicker">Stack</);
  assert.match(out, /3 steps/, 'an idle tile says how long it is');
  assert.ok(!out.includes('st-glyph'), 'a stack that has not run wears no glyphs');
  assert.ok(!out.includes('data-act="stack-stop"'));
  assert.ok(!out.includes('disabled'));

  const runs = { 'vr-night': fold([ev(0, 'wivrn-nx', 'waiting')]) };
  const [live] = stackTiles([STACK], { apps: APPS, runs });
  const running = renderStackTile(live);
  assert.match(running, /tile-stack is-running/);
  assert.match(running, /data-act="stack-stop"[^>]*data-stack="vr-night"/);
  assert.match(running, /data-act="stack-run"[^>]*disabled/, 'a running stack cannot be run twice');
  assert.match(running, /Waiting for WiVRn NX…/);
  assert.match(running, /st-wait/);

  const failed = renderStackTile(stackTiles([STACK], { apps: APPS, runs: { 'vr-night': fold([ev(0, 'wivrn-nx', 'failed')]) } })[0]);
  assert.match(failed, /phase-failed/);
  assert.match(failed, /st-bad/);
  assert.ok(!failed.includes('data-act="stack-stop"'), 'a finished run has nothing to stop');
});

test('the ghost tile opens the editor and hides without saveStack', () => {
  assert.match(renderStackGhost(), /data-act="stack-new"/);
  const grid = renderLaunchGrid([], { stacks: stackTiles([STACK], { apps: APPS }) });
  assert.match(grid, /tiles-grid/);
  assert.match(grid, /tile-stack/);
  assert.match(grid, /data-act="stack-new"/);

  const readonly = renderStackTiles(stackTiles([STACK], { apps: APPS }), { canEdit: false, canCreate: false });
  assert.ok(!readonly.includes('data-act="stack-new"'));
  assert.ok(!readonly.includes('data-act="stack-edit"'));

  // Stacks step aside while the user is filtering for an app.
  const filtered = renderLaunchGrid([], { stacks: stackTiles([STACK], { apps: APPS }), filter: 'pulse' });
  assert.ok(!filtered.includes('tile-stack'));
});

test('stack tiles come before app tiles in the grid', () => {
  const appTile = {
    key: 'pulsenx::appimage-linux',
    appId: 'pulsenx',
    artifactId: 'appimage-linux',
    name: 'PulseNX',
    monogram: 'PN',
    hue: 200,
    title: 'Launch PulseNX',
  };
  const grid = renderLaunchGrid([appTile], { stacks: stackTiles([STACK], { apps: APPS }) });
  assert.ok(grid.indexOf('tile-stack') < grid.indexOf('data-act="tile-launch"'), grid.slice(0, 120));
});

test('a hostile stack name cannot inject markup anywhere', () => {
  const evil = { id: 'x', name: '<img src=x onerror=alert(1)>', steps: [{ appId: '"><script>a</script>' }] };
  const [tile] = stackTiles([evil], { apps: APPS });
  const out = renderStackTile(tile);
  assert.ok(!out.includes('<img src=x'));
  assert.ok(!out.includes('<script'));
  assert.ok(!renderStacksSheet({ stacks: [evil], apps: APPS }).includes('<script'));
  assert.ok(!renderStacksSheet({ stacks: [], apps: APPS, draft: draftFromStack(evil) }).includes('<script'));
});

/* ------------------------------------------------------------ editor sheet */

test('the sheet lists saved stacks with run, edit and delete', () => {
  const out = renderStacksSheet({ stacks: [STACK], apps: APPS });
  assert.match(out, /role="dialog"/);
  assert.match(out, /<h2>Stacks<\/h2>/);
  assert.match(out, /stack-row-name">VR Night</);
  assert.match(out, /WiVRn NX/);
  assert.match(out, /step-opt">optional</);
  assert.match(out, /data-act="stack-run"[^>]*data-stack="vr-night"/);
  assert.match(out, /data-act="stack-edit"[^>]*data-stack="vr-night"/);
  assert.match(out, /data-act="stack-delete"[^>]*data-stack="vr-night"/);
  assert.match(out, /data-act="stack-new"/);

  const running = renderStacksSheet({
    stacks: [STACK],
    apps: APPS,
    runs: { 'vr-night': fold([ev(0, 'wivrn-nx', 'launching')]) },
  });
  assert.match(running, /data-act="stack-stop"/);
  assert.ok(!running.includes('data-act="stack-run"'));

  assert.match(renderStacksSheet({ stacks: [], apps: APPS }), /No stacks yet/);
});

test('the editor renders one row per step with the right controls', () => {
  const out = renderStacksSheet({ stacks: [STACK], apps: APPS, draft: draftFromStack(STACK) });
  assert.match(out, /<h2>Edit stack<\/h2>/);
  assert.match(out, /data-stack-field="name"[^>]*value="VR Night"/);

  // step 1: wivrn-nx has two launchable artifacts → the build picker shows
  assert.match(out, /data-step-field="appId"[^>]*data-index="0"/);
  assert.match(out, /data-step-field="artifactId"[^>]*data-index="0"/);
  assert.match(out, /value="tarball-prefix-linux"\s+selected/);
  // step 3: pulsenx has one → no picker for that row
  assert.ok(!/data-step-field="artifactId"[^>]*data-index="2"/.test(out));

  assert.match(out, /data-step-field="healthType"[^>]*data-index="1"/);
  assert.match(out, /value="delay"\s+selected/);
  assert.match(out, /data-step-field="timeoutMs"[^>]*data-index="1"[^>]*value="1500"/);
  assert.match(out, /data-step-field="port"[^>]*data-index="2"[^>]*value="9000"/);
  assert.ok(!/data-step-field="port"[^>]*data-index="0"/.test(out), 'no port box on a connector gate');
  assert.match(out, /data-step-field="optional"[^>]*data-index="1"[^>]*checked/);

  assert.match(out, /data-act="stack-step-up"[^>]*data-index="0"[^>]*disabled/);
  assert.match(out, /data-act="stack-step-down"[^>]*data-index="2"[^>]*disabled/);
  assert.match(out, /data-act="stack-step-remove"[^>]*data-index="1"/);
  assert.match(out, /data-act="stack-step-add"/);
  assert.match(out, /data-act="stack-save"/);
  assert.match(out, /data-act="stack-cancel"/);

  assert.match(renderStacksSheet({ apps: APPS, draft: blankDraft() }), /<h2>New stack<\/h2>/);
});

test('the editor shows validation errors where they belong', () => {
  const { errors } = validateDraft({ name: '', steps: [{ ...blankStep(), healthType: 'port' }] }, []);
  const out = renderStacksSheet({ apps: APPS, draft: { name: '', steps: [{ ...blankStep(), healthType: 'port' }] }, errors });
  assert.match(out, /field-error">Give the stack a name/);
  assert.match(out, /field-error">Pick an app for this step/);
  assert.match(out, /field-error">A port gate needs a port number/);
});

test('the app picker offers only apps a step can point at', () => {
  const ids = pickableApps(APPS).map((a) => a.id);
  assert.deepEqual(ids, ['wivrn-nx', 'pulsenx'], 'no unpublished repos, no addon-only apps');
  assert.deepEqual(stepArtifacts(APPS[0]).map((a) => a.id), ['apk-adb-android', 'tarball-prefix-linux']);
  assert.deepEqual(stepArtifacts(null), []);

  const out = renderStacksSheet({ apps: APPS, draft: blankDraft() });
  assert.match(out, /<option value="wivrn-nx">WiVRn NX<\/option>/);
  assert.ok(!out.includes('>QuadForge<'));
  assert.ok(!out.includes('>NxTakt<'));
  assert.match(renderStacksSheet({ apps: [], draft: blankDraft() }), /Nothing installable is discovered yet/);
});

/* -------------------------------------------------------------- mock bridge */

test('the mock implements the whole v0.5 surface', () => {
  const { nxhub } = createMock();
  for (const fn of ['getConnector', 'getStacks', 'saveStack', 'deleteStack', 'runStack', 'stopStack']) {
    assert.equal(typeof nxhub[fn], 'function', `nxhub.${fn}`);
  }
});

test('the mock ships a prebuilt stack and saves round-trips', async () => {
  const { nxhub } = createMock();
  const [vr] = normalizeStacks(await nxhub.getStacks());
  assert.equal(vr.id, 'vr-night');
  assert.deepEqual(vr.steps.map((s) => s.appId), ['wivrn-nx', 'oscgoesbrrr-nx-patches', 'pulsenx']);
  assert.deepEqual(vr.steps.map((s) => s.health.type), ['connector', 'delay', 'connector']);
  assert.equal(vr.steps[1].optional, true);

  const draft = { name: 'Studio', steps: [{ ...blankStep(), appId: 'pulsenx', healthType: 'port', port: '9000' }] };
  const { ok, stack } = validateDraft(draft, [vr]);
  assert.equal(ok, true);
  assert.equal(await nxhub.saveStack(stack), true);

  const saved = normalizeStacks(await nxhub.getStacks()).find((s) => s.id === 'studio');
  assert.deepEqual(saved, stack, 'what went in is what comes back');

  // saving the same id again edits in place
  await nxhub.saveStack({ ...stack, name: 'Studio' });
  assert.equal(normalizeStacks(await nxhub.getStacks()).length, 2);

  assert.equal(await nxhub.deleteStack('studio'), true);
  assert.equal(await nxhub.deleteStack('studio'), false);
  assert.deepEqual(normalizeStacks(await nxhub.getStacks()).map((s) => s.id), ['vr-night']);
  assert.equal(await nxhub.saveStack(null), false);
});

test('the mock run reaches every phase the UI can draw', async () => {
  const { nxhub, dev } = createMock();
  const stack = normalizeStacks(await nxhub.getStacks())[0];
  const seen = [];
  nxhub.onEvent((e) => {
    if (e.type === 'stack-progress') seen.push(e);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runFor = async (ms = 2600) => {
    seen.length = 0;
    assert.equal(dev.runMockStack(), true);
    assert.equal(dev.runMockStack(), false, 'one run per stack at a time');
    await sleep(ms);
    let run = null;
    for (const e of seen) run = applyStackProgress(run, e, { stack });
    return run;
  };

  // run 1 — everything comes up
  const good = await runFor();
  assert.equal(good.phase, 'done');
  assert.deepEqual(good.steps, ['healthy', 'healthy', 'healthy']);
  const connector = await nxhub.getConnector();
  assert.ok(
    connector.clients.some((c) => c.app === 'oscgoesbrrr-nx-patches') === false,
    'a delay-gated step does not fake a bus client'
  );

  // run 2 — the optional step times out and the run carries on
  const partial = await runFor();
  assert.equal(partial.phase, 'done');
  assert.equal(partial.steps[1], 'failed');
  assert.deepEqual(partial.skipped, [1]);

  // run 3 — a required step times out and the run stops there
  const bad = await runFor(2600);
  assert.equal(bad.phase, 'failed');
  assert.equal(bad.failedIndex, 2);
  assert.ok(!seen.some((e) => e.phase === 'done'));

  // and a stop takes the apps back off the bus
  seen.length = 0;
  dev.runMockStack();
  await sleep(900);
  assert.equal(dev.stopMockStack(), true);
  await sleep(600);
  let stopped = null;
  for (const e of seen) stopped = applyStackProgress(stopped, e, { stack });
  assert.equal(stopped.phase, 'stopped');
  assert.ok(seen.some((e) => e.phase === 'stopping'), 'the polite stop is visible');
  const after = await nxhub.getConnector();
  assert.ok(!after.clients.some((c) => c.app === 'wivrn-nx'), 'the stack took its apps down again');
  dev.stop();
});
