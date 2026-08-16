// v0.6 trigger-driven stacks — the model, the editor draft round-trip, the
// validation, the "auto" markers, and the `triggered` run phase.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTrigger,
  normalizeStack,
  draftFromStack,
  stackFromDraft,
  triggerFromDraft,
  blankDraft,
  blankStep,
  blankTriggerFields,
  validateDraft,
  triggerLabel,
  cooldownLabel,
  triggerReasonLabel,
  stackTiles,
  applyStackProgress,
  isFinished,
  runLabel,
  DEFAULT_COOLDOWN_MS,
  MIN_COOLDOWN_S,
  MAX_COOLDOWN_S,
} from '../../src/renderer/lib/stacks.js';
import { renderStacksSheet } from '../../src/renderer/views/stacks.js';
import { renderStackTile } from '../../src/renderer/views/stacktile.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const APPS = [
  normalizeApp({
    id: 'wivrn-nx',
    repo: 'nerdrx/wivrn-nx',
    name: 'WiVRn NX',
    latest: { version: '1.9.2' },
    artifacts: [{ id: 'tarball-prefix-linux', label: 'Linux server', platform: 'linux', kind: 'tarball-prefix' }],
  }),
  normalizeApp({
    id: 'pulsenx',
    repo: 'nerdrx/pulsenx',
    name: 'PulseNX',
    latest: { version: '2.3.0' },
    artifacts: [{ id: 'appimage-linux', label: 'PC dashboard', platform: 'linux', kind: 'appimage' }],
  }),
];

const TRIGGERED = {
  id: 'headset-arrives',
  name: 'Headset arrives',
  trigger: { type: 'adb-device', serial: 'PA7HA0M123', stopOnLeave: true, cooldownMs: 90000 },
  steps: [{ appId: 'wivrn-nx', health: { type: 'connector', timeoutMs: 30000 } }],
};

/* ------------------------------------------------------------------ model */

test('a trigger normalizes to exactly what SPEC allows, or to Manual', () => {
  assert.equal(normalizeTrigger(null), null);
  assert.equal(normalizeTrigger({ type: 'cron' }), null, 'an unknown type is Manual');
  assert.equal(normalizeTrigger({ serial: 'X' }), null, 'no type is Manual');

  assert.deepEqual(normalizeTrigger({ type: 'adb-device' }), {
    type: 'adb-device',
    cooldownMs: DEFAULT_COOLDOWN_MS,
  }, 'no serial means any device, and the default cooldown applies');

  assert.deepEqual(normalizeTrigger({ type: 'adb-device', serial: '  PA7  ', stopOnLeave: 1 }), {
    type: 'adb-device',
    serial: 'PA7',
    stopOnLeave: true,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  });

  assert.deepEqual(normalizeTrigger({ type: 'connector-app', appId: ' PulseNX ' }), {
    type: 'connector-app',
    appId: 'PulseNX',
    cooldownMs: DEFAULT_COOLDOWN_MS,
  }, 'the bus id is kept verbatim — never slugified, never lower-cased');

  assert.equal(normalizeTrigger({ type: 'connector-app' }), null, 'a bus trigger with no app could never fire');

  // A serial on a bus trigger, or an app id on a device trigger, is dropped.
  assert.equal(normalizeTrigger({ type: 'adb-device', appId: 'x' }).appId, undefined);
  assert.equal(normalizeTrigger({ type: 'connector-app', appId: 'x', serial: 'y' }).serial, undefined);
});

test('the cooldown is clamped to the 5s–3600s band', () => {
  assert.equal(normalizeTrigger({ type: 'adb-device', cooldownMs: 1000 }).cooldownMs, MIN_COOLDOWN_S * 1000);
  assert.equal(normalizeTrigger({ type: 'adb-device', cooldownMs: 9_000_000 }).cooldownMs, MAX_COOLDOWN_S * 1000);
  assert.equal(normalizeTrigger({ type: 'adb-device', cooldownMs: 0 }).cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(normalizeTrigger({ type: 'adb-device', cooldownMs: 'soon' }).cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(normalizeTrigger({ type: 'adb-device', cooldownMs: 120000 }).cooldownMs, 120000);
});

test('a Manual stack carries no trigger key at all', () => {
  const stack = normalizeStack({ id: 'x', name: 'X', steps: [{ appId: 'a' }] });
  assert.ok(!('trigger' in stack), 'absent, not null — that is what reaches saveStack()');
  const kept = normalizeStack(TRIGGERED);
  assert.equal(kept.trigger.type, 'adb-device');
  assert.equal(kept.trigger.stopOnLeave, true);
});

/* ------------------------------------------------------- draft round-trip */

test('a triggered stack round-trips through the editor draft', () => {
  const stack = normalizeStack(TRIGGERED);
  const draft = draftFromStack(stack);
  assert.equal(draft.triggerType, 'adb-device');
  assert.equal(draft.triggerSerial, 'PA7HA0M123');
  assert.equal(draft.triggerStopOnLeave, true);
  assert.equal(draft.triggerCooldown, '90', 'the editor works in seconds');

  const back = stackFromDraft(draft);
  assert.deepEqual(back, stack, 'draft → stack loses nothing');
});

test('a Manual draft produces no trigger, and switching back drops it', () => {
  const blank = blankDraft();
  assert.deepEqual(blankTriggerFields(), {
    triggerType: '',
    triggerSerial: '',
    triggerAppId: '',
    triggerStopOnLeave: false,
    triggerCooldown: '60',
  });
  assert.equal(triggerFromDraft(blank), null);
  assert.ok(!('trigger' in stackFromDraft({ ...blank, name: 'Solo', steps: [{ ...blankStep(), appId: 'a' }] })));

  // The user filled a serial in, then went back to Manual: nothing survives.
  const abandoned = { ...draftFromStack(TRIGGERED), triggerType: '' };
  assert.equal(triggerFromDraft(abandoned), null);
});

test('a bus trigger round-trips with its app id', () => {
  const draft = {
    ...blankDraft(),
    name: 'Watch session',
    triggerType: 'connector-app',
    triggerAppId: 'pulsenx',
    triggerCooldown: '15',
    steps: [{ ...blankStep(), appId: 'wivrn-nx' }],
  };
  const stack = stackFromDraft(draft);
  assert.deepEqual(stack.trigger, { type: 'connector-app', appId: 'pulsenx', cooldownMs: 15000 });
  assert.equal(draftFromStack(stack).triggerCooldown, '15');
  assert.equal(draftFromStack(stack).triggerSerial, '');
});

/* ---------------------------------------------------------- validation */

const okDraft = (over) => ({
  ...blankDraft(),
  name: 'Auto Stack',
  steps: [{ ...blankStep(), appId: 'wivrn-nx' }],
  ...over,
});

test('Manual skips every trigger rule', () => {
  const { ok, errors } = validateDraft(okDraft({ triggerCooldown: 'nonsense', triggerAppId: '' }));
  assert.equal(ok, true, `expected no errors, got ${JSON.stringify(errors)}`);
});

test('a bus trigger without an app is refused, inline and by field', () => {
  const { ok, errors } = validateDraft(okDraft({ triggerType: 'connector-app' }));
  assert.equal(ok, false);
  assert.match(errors.triggerAppId, /Pick the app/);
  assert.ok(!errors.name, 'the rest of the form is still fine');

  assert.equal(validateDraft(okDraft({ triggerType: 'connector-app', triggerAppId: 'pulsenx' })).ok, true);
});

test('the cooldown input is validated in seconds, 5 to 3600', () => {
  const bad = (v) => validateDraft(okDraft({ triggerType: 'adb-device', triggerCooldown: v })).errors.triggerCooldown;
  assert.match(bad(''), /required/);
  assert.match(bad('4'), /Use 5 to 3600 seconds/);
  assert.match(bad('3601'), /Use 5 to 3600 seconds/);
  assert.match(bad('1.5'), /Use 5 to 3600 seconds/);
  assert.match(bad('soon'), /Use 5 to 3600 seconds/);
  assert.equal(bad('5'), undefined);
  assert.equal(bad('3600'), undefined);
});

test('a device serial may be empty (any device) but never contain spaces', () => {
  assert.equal(validateDraft(okDraft({ triggerType: 'adb-device', triggerSerial: '' })).ok, true);
  const spaced = validateDraft(okDraft({ triggerType: 'adb-device', triggerSerial: 'PA7 HA0' }));
  assert.equal(spaced.ok, false);
  assert.match(spaced.errors.triggerSerial, /no spaces/);
});

/* ------------------------------------------------------------- editor UI */

test('the Automation section stays one line until a trigger is picked', () => {
  const out = renderStacksSheet({ stacks: [], apps: APPS, draft: blankDraft() });
  assert.match(out, /<h3>Automation<\/h3>/);
  assert.match(out, /data-stack-field="triggerType"/);
  assert.match(out, /Manual — only when I press Run/);
  assert.ok(!out.includes('data-stack-field="triggerSerial"'), 'no serial box for Manual');
  assert.ok(!out.includes('data-stack-field="triggerCooldown"'), 'and no cooldown');
  assert.ok(!out.includes('data-stack-field="triggerStopOnLeave"'));
});

test('picking "device connects" reveals the serial, cooldown and stopOnLeave', () => {
  const draft = draftFromStack(TRIGGERED);
  const out = renderStacksSheet({ stacks: [], apps: APPS, draft });
  assert.match(out, /value="adb-device" selected/);
  assert.match(out, /data-stack-field="triggerSerial"/);
  assert.match(out, /placeholder="any device"/, 'an empty serial matches any device');
  assert.match(out, /value="PA7HA0M123"/);
  assert.match(out, /data-stack-field="triggerCooldown"[^>]*value="90"/);
  assert.match(out, /min="5"[^>]*max="3600"/);
  assert.match(out, /data-stack-field="triggerStopOnLeave"[^>]*checked/);
  assert.match(out, /Stop the stack when it leaves/);
  assert.match(out, /trg-preview/);
  assert.match(out, /Runs when PA7HA0M123 connects/);
  assert.ok(!out.includes('data-stack-field="triggerAppId"'), 'a device trigger needs no app picker');
});

test('picking "app joins the bus" swaps in the app picker', () => {
  const draft = { ...blankDraft(), triggerType: 'connector-app', triggerAppId: 'pulsenx' };
  const out = renderStacksSheet({ stacks: [], apps: APPS, draft });
  assert.match(out, /data-stack-field="triggerAppId"/);
  assert.match(out, /<option value="pulsenx" selected>PulseNX<\/option>/);
  assert.ok(!out.includes('data-stack-field="triggerSerial"'));
  assert.match(out, /Runs when PulseNX joins the bus/);
});

test('trigger errors render next to their own field', () => {
  const out = renderStacksSheet({
    stacks: [],
    apps: APPS,
    draft: { ...blankDraft(), triggerType: 'connector-app', triggerCooldown: '2' },
    errors: { triggerAppId: 'Pick the app whose arrival starts this stack.', triggerCooldown: 'Use 5 to 3600 seconds.' },
  });
  assert.match(out, /field-error">Pick the app whose arrival starts this stack\./);
  assert.match(out, /field-error">Use 5 to 3600 seconds\./);
});

/* ------------------------------------------------------------ the markers */

test('a triggered stack tile wears a bolt and an "auto" chip', () => {
  const [tile] = stackTiles([TRIGGERED], { apps: APPS });
  assert.equal(tile.triggered, true);
  assert.match(tile.triggerTitle, /Runs when PA7HA0M123 connects/);
  assert.match(tile.triggerTitle, /at most once every 1.5 minutes|at most once every 90 seconds/);
  assert.match(tile.triggerTitle, /stops when it leaves/);

  const out = renderStackTile(tile);
  assert.match(out, /class="st-bolt"/);
  assert.match(out, /class="st-auto"[^>]*>auto</);

  const manual = renderStackTile(stackTiles([{ ...TRIGGERED, trigger: null }], { apps: APPS })[0]);
  assert.ok(!manual.includes('st-auto'), 'a manual stack wears nothing');
  assert.ok(!manual.includes('st-bolt'));
});

test('the stacks list marks the triggered rows too', () => {
  const out = renderStacksSheet({ stacks: [TRIGGERED, { id: 'm', name: 'Manual one', steps: [{ appId: 'pulsenx' }] }], apps: APPS });
  assert.match(out, /stack-row-name">Headset arrives<span class="st-bolt"/);
  assert.match(out, /st-auto"[^>]*title="Runs when PA7HA0M123 connects"/);
  assert.match(out, /stack-row-name">Manual one<\/span>/, 'the manual row is plain');
});

test('the trigger labels read as English sentences', () => {
  assert.equal(triggerLabel({ type: 'adb-device' }), 'Runs when a device connects');
  assert.equal(triggerLabel({ type: 'adb-device', serial: 'PA7' }), 'Runs when PA7 connects');
  assert.equal(triggerLabel({ type: 'connector-app', appId: 'pulsenx' }, APPS), 'Runs when PulseNX joins the bus');
  assert.equal(triggerLabel({ type: 'connector-app', appId: 'unknown-app' }, APPS), 'Runs when unknown-app joins the bus');
  assert.equal(triggerLabel(null), '');

  assert.equal(cooldownLabel({ type: 'adb-device' }), 'at most once a minute');
  assert.equal(cooldownLabel({ type: 'adb-device', cooldownMs: 300000 }), 'at most once every 5 minutes');
  assert.equal(cooldownLabel({ type: 'adb-device', cooldownMs: 90000 }), 'at most once every 90 seconds');
  assert.equal(cooldownLabel(null), '');
});

/* ------------------------------------------------------- triggered phase */

test('the `triggered` event opens a run nobody clicked', () => {
  const ev = { stackId: 'headset-arrives', stepIndex: null, appId: null, phase: 'triggered', reason: 'adb-device' };
  const run = applyStackProgress(null, ev, { now: 1 });
  assert.ok(run, 'the phase is not dropped as unknown');
  assert.equal(run.phase, 'triggered');
  assert.equal(run.reason, 'adb-device');
  assert.equal(isFinished(run), false);
  assert.deepEqual(run.steps, [], 'nothing has launched yet');

  const stack = normalizeStack(TRIGGERED);
  assert.equal(runLabel(run, stack, APPS), 'A device connected — starting…');
  assert.equal(triggerReasonLabel('connector-app'), 'An app joined the bus — starting…');
  assert.equal(triggerReasonLabel(''), 'Triggered — starting…');

  // …and the first real step takes over from there.
  const launching = applyStackProgress(run, { stackId: 'headset-arrives', stepIndex: 0, appId: 'wivrn-nx', phase: 'launching' }, { now: 2 });
  assert.equal(launching.phase, 'running');
  assert.equal(launching.reason, 'adb-device', 'the reason survives the handover');
  assert.equal(runLabel(launching, stack, APPS), 'Launching WiVRn NX…');
});

test('a triggered run reads as running on its tile', () => {
  const runs = {
    'headset-arrives': applyStackProgress(null, { stackId: 'headset-arrives', phase: 'triggered', reason: 'adb-device' }, { now: 1 }),
  };
  const [tile] = stackTiles([TRIGGERED], { apps: APPS, runs });
  assert.equal(tile.running, true);
  assert.equal(tile.phase, 'triggered');
  const out = renderStackTile(tile);
  assert.match(out, /phase-triggered/);
  assert.match(out, /A device connected — starting…/);
  assert.match(out, /data-act="stack-stop"/, 'a self-started run can still be stopped');
});

/* ------------------------------------------------------------------ XSS */

test('a hostile stack file cannot inject through the trigger fields', () => {
  const draft = draftFromStack({
    id: 'evil',
    name: '"><script>alert(1)</script>',
    trigger: { type: 'adb-device', serial: '"><img src=x onerror="alert(2)">', cooldownMs: 60000 },
    steps: [{ appId: 'wivrn-nx' }],
  });
  const out = renderStacksSheet({ stacks: [], apps: APPS, draft });
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<img src=x'));
  assert.ok(!out.includes('onerror="alert'));
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&quot;&gt;&lt;img src=x/);

  const tile = renderStackTile(
    stackTiles([{ id: 'evil', name: 'x', trigger: { type: 'connector-app', appId: '"><svg onload=alert(3)>' }, steps: [{ appId: 'wivrn-nx' }] }], { apps: APPS })[0]
  );
  assert.ok(!tile.includes('<svg onload'));
  assert.match(tile, /&lt;svg onload/);
});

/* ------------------------------------------------------------------ mock */

test('the mock ships a triggered stack the editor can round-trip', async () => {
  const { nxhub, dev } = createMock();
  const stacks = await nxhub.getStacks();
  const auto = stacks.find((s) => s.id === 'headset-arrives');
  assert.ok(auto, 'the roster has one');
  assert.equal(auto.trigger.type, 'adb-device');
  assert.equal(auto.trigger.stopOnLeave, true);

  const draft = draftFromStack(auto);
  assert.equal(draft.triggerType, 'adb-device');
  assert.equal(draft.triggerCooldown, '90');

  const { ok, stack } = validateDraft(draft, stacks);
  assert.equal(ok, true);
  assert.equal(await nxhub.saveStack(stack), true);
  const saved = (await nxhub.getStacks()).find((s) => s.id === 'headset-arrives');
  assert.deepEqual(saved.trigger, auto.trigger, 'what went in is what comes back');
  dev.stop();
});
