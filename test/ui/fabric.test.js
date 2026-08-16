// v0.7 "fabric" — cross-hub stack steps, dev links, LAN seeding and wake.
//
// Everything here is the pure half: the model round-trip, the editor's
// peer/action/gate matrix, the tile glyphs, and the escaping of the two new
// classes of untrusted string (another hub's NAME, and a path off the user's
// disk that is rendered inside a menu). The stub-DOM half lives in smoke.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeStack,
  normalizeStacks,
  normalizeStep,
  normalizeHealth,
  normalizePeerId,
  isWakeStep,
  healthTypesFor,
  coerceHealthType,
  coerceStepFields,
  blankStep,
  draftFromStack,
  stackFromDraft,
  validateDraft,
  stackTiles,
  applyStackProgress,
  runLabel,
  healthLabel,
  peerNameMap,
  HEALTH_TYPES,
  LOCAL_HEALTH_TYPES,
  PEER_HEALTH_TYPES,
  DEFAULT_WAKE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_PEER_ID_LEN,
} from '../../src/renderer/lib/stacks.js';
import {
  normalizeDevLink,
  normalizeDevLinks,
  devIds,
  isDevLinked,
  devTiles,
  devTileMenu,
  devUnlinkConfirm,
} from '../../src/renderer/lib/dev.js';
import { normalizePeer, normalizeFleet, canWake, wakeTitle } from '../../src/renderer/lib/fleet.js';
import { isLanSeeded, lanSeedPeer } from '../../src/renderer/lib/version.js';
import { renderStacksSheet } from '../../src/renderer/views/stacks.js';
import { renderStackTile } from '../../src/renderer/views/stacktile.js';
import { renderTile, renderLaunchGrid } from '../../src/renderer/views/tile.js';
import { renderAppCard, renderPhaseLabel, lanChip } from '../../src/renderer/views/card.js';
import { renderFleetSheet } from '../../src/renderer/views/fleet.js';
import { normalizeApp } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const PEERS = [
  { id: 'c0ffee11deadbeef', name: 'NX-WIN' },
  { id: 'a1b2c3d4e5f60718', name: 'workshop-pc' },
];

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

/** Wake NX-WIN → gate its port over the LAN → bring the local half up. */
const FABRIC = {
  id: 'vr-night-both-machines',
  name: 'VR Night (both machines)',
  steps: [
    {
      appId: null,
      artifactId: null,
      peer: 'c0ffee11deadbeef',
      action: 'wake',
      health: { type: 'peer-online', timeoutMs: 120000 },
    },
    {
      appId: 'wivrn-nx',
      peer: 'c0ffee11deadbeef',
      health: { type: 'port', port: 9757, timeoutMs: 45000 },
    },
    { appId: 'pulsenx', health: { type: 'connector', timeoutMs: 20000 } },
  ],
};

/* ------------------------------------------------------------------ model */

test('a step says where it runs and what it does, or says nothing at all', () => {
  const local = normalizeStep({ appId: 'PulseNX', health: { type: 'connector' } });
  assert.equal(local.appId, 'pulsenx');
  assert.equal('peer' in local, false, 'a local step carries no peer key at all');
  assert.equal('action' in local, false, 'and no action key — launch is the absence of one');

  const peered = normalizeStep({ appId: 'pulsenx', peer: 'c0ffee11deadbeef', health: { type: 'port', port: 9757 } });
  assert.equal(peered.peer, 'c0ffee11deadbeef');
  assert.deepEqual(peered.health, { type: 'port', port: 9757 });

  const wake = normalizeStep({ peer: 'c0ffee11deadbeef', action: 'wake' });
  assert.equal(isWakeStep(wake), true);
  assert.equal(wake.appId, null, 'main stores a wake step with a null app');
  assert.equal(wake.artifactId, null);
  assert.deepEqual(wake.health, { type: 'peer-online', timeoutMs: DEFAULT_WAKE_TIMEOUT_MS });
});

test('a peer id is kept verbatim and only bounded', () => {
  assert.equal(normalizePeerId('  C0FFEE 11  '), 'C0FFEE 11', 'never slugified, never lower-cased');
  assert.equal(normalizePeerId('x'.repeat(400)).length, MAX_PEER_ID_LEN);
  assert.equal(normalizePeerId(null), '');
  assert.equal(normalizeStep({ appId: 'a', peer: 'y'.repeat(300) }).peer.length, MAX_PEER_ID_LEN);
});

test('a wake with nothing to wake degrades instead of pretending', () => {
  const orphan = normalizeStep({ action: 'wake', appId: 'pulsenx' });
  assert.equal(isWakeStep(orphan), false);
  assert.equal(orphan.appId, 'pulsenx', 'it is just a normal step again');
  // …and a wake with neither peer nor app is not a step, so the stack drops it.
  const stack = normalizeStack({ name: 'S', steps: [{ action: 'wake' }, { appId: 'pulsenx' }] });
  assert.deepEqual(stack.steps.map((s) => s.appId), ['pulsenx']);
});

test('the gate matrix follows where the step runs', () => {
  assert.deepEqual(healthTypesFor({}), LOCAL_HEALTH_TYPES);
  assert.deepEqual(healthTypesFor({ peer: 'p1' }), PEER_HEALTH_TYPES);
  assert.deepEqual(healthTypesFor({ peer: 'p1', action: 'wake' }), ['peer-online']);
  assert.ok(!LOCAL_HEALTH_TYPES.includes('peer-online'), 'peer-online is never offered locally');
  assert.ok(!PEER_HEALTH_TYPES.includes('connector'), "and connector never on someone else's machine");
  assert.deepEqual(HEALTH_TYPES, ['connector', 'port', 'delay', 'peer-online'], 'the union main also exports');

  // SPEC's own words: connector on a peered step is invalid → drop to delay.
  assert.equal(coerceHealthType('connector', { peer: 'p1' }), 'delay');
  // And the mirror: a local step can never end up gating on a peer beacon.
  assert.equal(coerceHealthType('peer-online', {}), 'connector');
  assert.equal(coerceHealthType('port', { peer: 'p1', action: 'wake' }), 'peer-online');
  assert.equal(coerceHealthType('nonsense', { peer: 'p1' }), 'port');

  // The same rule applied to a whole gate, on the way in from disk.
  assert.deepEqual(normalizeHealth({ type: 'connector', timeoutMs: 5000 }, { peer: 'p1' }), {
    type: 'delay',
    timeoutMs: 5000,
  });
  assert.equal(healthLabel({ type: 'peer-online' }), 'that hub answers');
});

test('a wake timeout defaults to two minutes and clamps to the model maximum', () => {
  const shape = { peer: 'p1', action: 'wake' };
  assert.equal(normalizeHealth({ type: 'peer-online' }, shape).timeoutMs, DEFAULT_WAKE_TIMEOUT_MS);
  assert.equal(normalizeHealth({ type: 'peer-online', timeoutMs: 0 }, shape).timeoutMs, DEFAULT_WAKE_TIMEOUT_MS);
  assert.equal(normalizeHealth({ type: 'peer-online', timeoutMs: 300000 }, shape).timeoutMs, 300000);
  assert.equal(
    normalizeHealth({ type: 'port', port: 1, timeoutMs: MAX_TIMEOUT_MS * 4 }, { peer: 'p1' }).timeoutMs,
    MAX_TIMEOUT_MS,
    'the number shown is the number that will be used'
  );
});

/* ---------------------------------------------------------- draft round-trip */

test('a cross-hub stack round-trips through the editor draft unchanged', () => {
  const stack = normalizeStack(FABRIC);
  const draft = draftFromStack(stack);

  assert.deepEqual(draft.steps[0], {
    appId: '',
    artifactId: '',
    peer: 'c0ffee11deadbeef',
    action: 'wake',
    healthType: 'peer-online',
    port: '',
    timeoutMs: '120000',
    optional: false,
  });
  assert.equal(draft.steps[1].peer, 'c0ffee11deadbeef');
  assert.equal(draft.steps[1].action, 'launch');
  assert.equal(draft.steps[1].healthType, 'port');
  assert.equal(draft.steps[2].peer, '');

  const back = stackFromDraft({ ...draft, name: FABRIC.name });
  assert.deepEqual(back, stack, 'draft → stack loses nothing');
});

test('coercion keeps a draft step internally consistent, whatever order it was typed in', () => {
  // Picked "wake" before picking a hub: the choice SURVIVES, because reverting
  // a select the user just changed is worse than an error message.
  const halfWake = coerceStepFields({ ...blankStep(), action: 'wake' });
  assert.equal(halfWake.action, 'wake');
  assert.equal(halfWake.healthType, 'peer-online', 'and its gate follows the action, not the peer');
  assert.equal(stackFromDraft({ name: 'S', steps: [halfWake] }).steps.length, 0, 'but it never saves as one');

  // Picked a hub while the gate still said "connector": the gate moves.
  const moved = coerceStepFields({ ...blankStep(), peer: 'p1', healthType: 'connector' });
  assert.equal(moved.healthType, 'delay');

  // Came back to this hub with peer-online still selected: the gate moves back.
  const home = coerceStepFields({ ...blankStep(), peer: '', healthType: 'peer-online' });
  assert.equal(home.healthType, 'connector');

  // Flipping to wake fills the boot budget ONCE — and never refills a cleared box.
  const flipped = coerceStepFields({ ...blankStep(), peer: 'p1', action: 'wake' }, { fillDefaults: true });
  assert.equal(flipped.timeoutMs, String(DEFAULT_WAKE_TIMEOUT_MS));
  assert.equal(flipped.healthType, 'peer-online');
  const cleared = coerceStepFields({ ...flipped, timeoutMs: '' });
  assert.equal(cleared.timeoutMs, '', 'a plain read never puts the default back');

  // The app id survives a round trip through "wake" — only the model drops it.
  const kept = coerceStepFields({ ...blankStep(), appId: 'pulsenx', peer: 'p1', action: 'wake' });
  assert.equal(kept.appId, 'pulsenx');
  assert.equal(stackFromDraft({ name: 'S', steps: [kept] }).steps[0].appId, null);
});

/* -------------------------------------------------------------- validation */

test('a wake step needs a hub, and needs no app', () => {
  const wake = (patch) => ({
    name: 'Fabric',
    steps: [{ ...blankStep(), action: 'wake', healthType: 'peer-online', ...patch }],
  });

  const orphan = validateDraft(wake({}));
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors['step-0-peer'], /Pick the hub/);
  assert.equal(orphan.errors['step-0-appId'], undefined, 'it must not also demand an app');

  const good = validateDraft(wake({ peer: 'c0ffee11deadbeef', timeoutMs: '120000' }));
  assert.equal(good.ok, true);
  assert.equal(good.stack.steps[0].appId, null);
  assert.equal(good.stack.steps[0].health.type, 'peer-online');

  // A LAUNCH step still needs its app, peered or not.
  const noApp = validateDraft({ name: 'F', steps: [{ ...blankStep(), peer: 'p1', healthType: 'delay', timeoutMs: '1' }] });
  assert.match(noApp.errors['step-0-appId'], /Pick an app/);

  // A peered port gate is validated exactly like a local one.
  const badPort = validateDraft({
    name: 'F',
    steps: [{ ...blankStep(), appId: 'a', peer: 'p1', healthType: 'port', port: '70000' }],
  });
  assert.match(badPort.errors['step-0-port'], /1 to 65535/);
});

test('an unpaired peer is still saveable — it is a run-time failure by design', () => {
  const draft = {
    name: 'Fabric',
    steps: [{ ...blankStep(), action: 'wake', peer: 'a-hub-that-left', timeoutMs: '120000' }],
  };
  assert.equal(validateDraft(draft).ok, true, 'pairing can change under a stored stack');
});

/* --------------------------------------------------------- the editor view */

test('the cross-hub controls only exist when this hub has a fleet', () => {
  const draft = { name: 'Fabric', steps: [blankStep()] };

  const alone = renderStacksSheet({ draft, apps: APPS });
  assert.ok(!alone.includes('data-step-field="peer"'), 'no peers, no "Runs on"');
  assert.ok(!alone.includes('data-step-field="action"'), 'and nothing to wake');
  assert.ok(alone.includes('data-step-field="healthType"'), 'the v0.6 editor is untouched');

  const fleeted = renderStacksSheet({ draft, apps: APPS, peers: PEERS });
  assert.ok(fleeted.includes('data-step-field="peer"'));
  assert.ok(fleeted.includes('data-step-field="action"'));
  assert.ok(fleeted.includes('>This hub<'), 'and "this hub" is the default choice');
  assert.ok(fleeted.includes('>NX-WIN<'));
});

test('picking a hub swaps the gates, and picking wake swaps the whole step', () => {
  const step = (patch) => ({ ...blankStep(), ...patch });

  const local = renderStacksSheet({
    draft: { name: 'F', steps: [step({ appId: 'wivrn-nx' })] },
    apps: APPS,
    peers: PEERS,
  });
  assert.ok(local.includes('The app reports in on the bus'), 'a local step can gate on the bus');

  const peered = renderStacksSheet({
    draft: { name: 'F', steps: [step({ appId: 'wivrn-nx', peer: 'c0ffee11deadbeef', healthType: 'port', port: '9757' })] },
    apps: APPS,
    peers: PEERS,
  });
  assert.ok(!peered.includes('The app reports in on the bus'), "the remote bus is not visible from here");
  assert.ok(peered.includes('The other hub answers'), 'but peer-online is');
  assert.ok(peered.includes('class="step-peer"'), 'the row wears the hub name');
  assert.match(peered, /only NX-WIN can see its own bus/);

  const wake = renderStacksSheet({
    draft: { name: 'F', steps: [step({ peer: 'c0ffee11deadbeef', action: 'wake', timeoutMs: '120000' })] },
    apps: APPS,
    peers: PEERS,
  });
  assert.ok(!wake.includes('data-step-field="appId"'), 'no app picker on a wake step');
  assert.ok(!wake.includes('data-step-field="artifactId"'), 'and no build picker');
  assert.ok(!wake.includes('data-step-field="healthType"'), 'the gate is fixed, so it is not a control');
  assert.ok(wake.includes('step-wake-label'));
  assert.ok(wake.includes('Wake NX-WIN'));
  assert.match(wake, /Time to boot \(ms\)/, 'the timeout says what it actually budgets');
  assert.match(wake, /value="120000"/);
});

test('a step pointing at a hub that left says so, and stays editable', () => {
  const html = renderStacksSheet({
    draft: { name: 'F', steps: [{ ...blankStep(), appId: 'wivrn-nx', peer: 'ghost-hub', healthType: 'delay', timeoutMs: '1000' }] },
    apps: APPS,
    peers: PEERS,
  });
  assert.ok(html.includes('step-unpaired'), 'the chip warns');
  assert.match(html, /not paired/);
  assert.ok(html.includes('value="ghost-hub" selected'), 'and the picker can still un-point it');
});

test('the stacks list shows where each step runs', () => {
  const html = renderStacksSheet({ stacks: [FABRIC], apps: APPS, peers: PEERS });
  assert.ok(html.includes('Wake NX-WIN'), 'the wake step reads as a machine');
  assert.ok(html.includes('step-peer-tag'), 'and the remote launch is tagged with its hub');
});

/* ---------------------------------------------------------- the stack tile */

test('a peered step wears a link glyph and a wake step wears a power glyph', () => {
  const [tile] = stackTiles([FABRIC], { apps: APPS, peers: PEERS });
  const [wake, remote, local] = tile.steps;

  assert.equal(wake.wake, true);
  assert.equal(wake.monogram, '', 'no two-letter abbreviation of a machine');
  assert.equal(wake.name, 'NX-WIN', 'the hub name IS the label');
  assert.equal(remote.wake, false);
  assert.equal(remote.peerName, 'NX-WIN');
  assert.equal(local.peer, '');

  const html = renderStackTile(tile);
  assert.ok(html.includes('st-mono-wake'), 'the power monogram rendered');
  assert.ok(html.includes('class="st-link"'), 'and the link glyph');
  assert.equal((html.match(/class="st-link"/g) || []).length, 2, 'one per peered step, not on the local one');
  assert.match(html, /title="[^"]*port gate on NX-WIN/);
  assert.match(html, /title="Wake NX-WIN"/);
});

test('a peer that is gone marks its steps, but only when the peers are known', () => {
  const [known] = stackTiles([FABRIC], { apps: APPS, peers: [{ id: 'someone-else', name: 'other' }] });
  assert.equal(known.steps[0].unknownPeer, true);
  assert.ok(renderStackTile(known).includes('st-unpaired'));
  assert.match(renderStackTile(known), /not paired any more/);

  // No peer list at all (a build with no fleet) must not brand everything broken.
  const [blind] = stackTiles([FABRIC], { apps: APPS });
  assert.equal(blind.steps[0].unknownPeer, false);
  assert.ok(!renderStackTile(blind).includes('st-unpaired'));
});

/* ------------------------------------------------------ peer-name prefixing */

test('a remote step says which machine it is happening on', () => {
  const stack = normalizeStack(FABRIC);
  const names = APPS;
  const peers = peerNameMap(PEERS);
  const fold = (evs) => {
    let run = null;
    for (const e of evs) run = applyStackProgress(run, { stackId: stack.id, ...e }, { stack, now: 1 });
    return run;
  };

  // The wake step, from the event's own extras.
  const waking = fold([{ stepIndex: 0, appId: '', phase: 'launching', peer: 'c0ffee11deadbeef' }]);
  assert.equal(runLabel(waking, stack, names, peers), 'Waking NX-WIN…');
  const waited = fold([
    { stepIndex: 0, appId: '', phase: 'launching', peer: 'c0ffee11deadbeef' },
    { stepIndex: 0, appId: '', phase: 'waiting', peer: 'c0ffee11deadbeef' },
  ]);
  assert.equal(runLabel(waited, stack, names, peers), 'Waiting for NX-WIN to answer…');

  // The remote launch: the app name, prefixed by the machine.
  const remote = fold([{ stepIndex: 1, appId: 'wivrn-nx', phase: 'waiting', peer: 'c0ffee11deadbeef' }]);
  assert.equal(runLabel(remote, stack, names, peers), 'NX-WIN · Waiting for WiVRn NX…');

  // The local step has no prefix at all.
  const home = fold([{ stepIndex: 2, appId: 'pulsenx', phase: 'launching' }]);
  assert.equal(runLabel(home, stack, names, peers), 'Launching PulseNX…');

  // An event with no extras falls back to what the model already knew.
  const modelOnly = fold([{ stepIndex: 1, appId: 'wivrn-nx', phase: 'healthy' }]);
  assert.equal(runLabel(modelOnly, stack, names, peers), 'NX-WIN · WiVRn NX is up');

  // An unknown peer id degrades to the id rather than vanishing.
  const stranger = fold([{ stepIndex: 1, appId: 'wivrn-nx', phase: 'waiting', peer: 'unknown-hub' }]);
  assert.equal(runLabel(stranger, stack, names, peers), 'unknown-hub · Waiting for WiVRn NX…');

  // And with no peer map at all, the line is still a sentence.
  assert.equal(runLabel(home, stack, names), 'Launching PulseNX…');
});

test('a wake that timed out blames the machine, not a null app', () => {
  const stack = normalizeStack(FABRIC);
  const run = applyStackProgress(null, { stackId: stack.id, stepIndex: 0, phase: 'failed' }, { stack, now: 1 });
  const label = runLabel(run, stack, APPS, PEERS);
  assert.equal(label, 'NX-WIN did not wake up');
  assert.ok(!/null/.test(label), 'never "Launching null"');
});

test('a stop that crossed the LAN reports whether the far side agreed', () => {
  const stack = normalizeStack(FABRIC);
  const stop = (how) =>
    applyStackProgress(
      null,
      { stackId: stack.id, stepIndex: 1, phase: 'stopped', how, peer: 'c0ffee11deadbeef' },
      { stack, now: 1 }
    );
  assert.equal(runLabel(stop('remote-stop'), stack, APPS, PEERS), 'Stopped on NX-WIN');
  assert.equal(runLabel(stop('remote-failed'), stack, APPS, PEERS), 'NX-WIN did not confirm the stop');
  assert.equal(runLabel(stop(''), stack, APPS, PEERS), 'Stopped');
});

/* ------------------------------------------------------------- dev links */

test('dev links normalize to exactly what the bridge hands over', () => {
  assert.deepEqual(normalizeDevLink({ appId: 'WiVRn-NX', path: ' /src/w ' }), {
    appId: 'wivrn-nx',
    path: '/src/w',
    launchCmd: '',
    name: 'wivrn-nx',
    appName: '',
    known: false,
    // An older main that never checked must not make every link look broken.
    exists: true,
  });
  assert.equal(normalizeDevLink({ id: 'x', cmd: './run' }).launchCmd, './run');
  assert.equal(normalizeDevLink({ appId: 'x', exists: false }).exists, false);

  // A link that shadows a catalogue app borrows that app's real name.
  const known = normalizeDevLink({ appId: 'pulsenx', name: 'pulsenx', appName: 'PulseNX', known: true });
  assert.equal(known.name, 'PulseNX');
  assert.equal(known.known, true);
  // …and a standalone one keeps its own.
  assert.equal(normalizeDevLink({ appId: 's', name: 'NX Sandbox', appName: 'ignored' }).name, 'NX Sandbox');

  assert.deepEqual(normalizeDevLinks(null), []);
  assert.deepEqual(normalizeDevLinks([{ path: '/nowhere' }]), [], 'no id, no link');

  const deduped = normalizeDevLinks([
    { appId: 'a', path: '/one' },
    { appId: 'a', path: '/two' },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].path, '/two', 'the later entry wins');

  assert.deepEqual([...devIds([{ appId: 'A' }, { appId: 'b' }])], ['a', 'b']);
  assert.equal(isDevLinked('A', [{ appId: 'a' }]), true);
  assert.equal(isDevLinked('', [{ appId: 'a' }]), false);
});

test('dev tiles sort last, alphabetically, and carry their command', () => {
  const links = [
    { appId: 'zeta', path: '/src/zeta', name: 'Zeta' },
    { appId: 'nx-sandbox', path: '/src/sandbox', name: 'NX Sandbox', launchCmd: './build/sandbox --verbose' },
  ];
  const tiles = devTiles(links);
  assert.deepEqual(tiles.map((t) => t.name), ['NX Sandbox', 'Zeta']);
  assert.equal(tiles[0].key, 'dev::nx-sandbox');
  assert.equal(tiles[0].dev, true);
  assert.equal(tiles[0].favorite, false, 'a checkout never joins the favorites rotation');
  assert.match(tiles[0].title, /\.\/build\/sandbox --verbose/);
  assert.equal(devTiles(links, { filter: 'zet' }).length, 1, 'the filter reaches them too');
});

test('a dev tile runs the checkout and its menu offers the folder and the unlink', () => {
  const [tile] = devTiles([{ appId: 'nx-sandbox', path: '/src/sandbox', name: 'NX Sandbox' }]);
  const html = renderTile(tile, { openMenu: tile.key, caps: {} });

  assert.ok(html.includes('class="tile tile-dev"') || html.includes('tile-dev'), 'the tile is marked');
  assert.match(html, /data-act="dev-run"/, 'clicking it runs the checkout, not an install');
  assert.ok(!html.includes('data-act="tile-launch"'), 'and never the normal launch path');
  assert.match(html, /data-dev="nx-sandbox"/);
  assert.match(html, /class="dev-chip"/, 'the DEV badge is on the tile');
  assert.match(html, />DEV</);

  assert.deepEqual(devTileMenu(tile).map((m) => m.act), ['dev-run', 'dev-folder', 'dev-unlink']);
  assert.match(html, /data-act="dev-folder"[^>]*data-path="\/src\/sandbox"/);
  assert.match(html, /data-act="dev-unlink"/);

  // A build with no devUnlink() offers no unlink; a link with no path, no folder.
  assert.deepEqual(devTileMenu(tile, { devUnlink: false }).map((m) => m.act), ['dev-run', 'dev-folder']);
  assert.deepEqual(devTileMenu({ ...tile, path: '' }).map((m) => m.act), ['dev-run', 'dev-unlink']);

  assert.match(devUnlinkConfirm(tile), /Unlink NX Sandbox\?/);
  assert.match(devUnlinkConfirm(tile), /stay exactly where they are/);
});

test('a link whose folder is gone still shows, but cannot be run', () => {
  const [tile] = devTiles([{ appId: 'nx-sandbox', path: '/src/gone', name: 'NX Sandbox', exists: false }]);
  assert.equal(tile.broken, true);
  assert.equal(tile.disabled, true);
  assert.equal(tile.disabledReason, 'folder is gone');
  assert.match(tile.title, /is not there any more/);

  // The menu drops to the two actions that still mean something.
  assert.deepEqual(devTileMenu(tile).map((m) => m.act), ['dev-folder', 'dev-unlink']);

  const html = renderTile(tile, { openMenu: tile.key, caps: {} });
  assert.ok(html.includes('tile-dev-broken'), 'it reads as inert');
  assert.ok(html.includes('is-disabled'));
  assert.match(html, /<button class="tile-hit"[^>]*disabled/, 'and the hit target refuses the click');
  assert.ok(!html.includes('>Run<'), 'no Run entry in the menu');
  assert.match(html, />folder is gone</);
});

test('an app with a checkout linked is marked on its card as well as its tile', () => {
  const app = APPS[0];
  const plain = renderAppCard(app, { settings: { owners: [] } });
  assert.ok(!plain.includes('dev-mark'), 'an ordinary card says nothing');

  const marked = renderAppCard(app, { settings: { owners: [] }, devIds: devIds([{ appId: 'wivrn-nx' }]) });
  assert.match(marked, /class="dev-chip dev-mark"/);
  assert.match(marked, /a local checkout is linked/);

  // main's own model flag lights it too, for a hub that has no getDevLinks().
  const flagged = renderAppCard({ ...app, devLink: { path: '/src/w' } }, { settings: { owners: [] } });
  assert.ok(flagged.includes('dev-mark'));
});

test('dev tiles land in the launch grid among the app tiles', () => {
  const html = renderLaunchGrid([...devTiles([{ appId: 'nx-sandbox', path: '/s', name: 'NX Sandbox' }])], {
    canEditStacks: false,
  });
  assert.ok(html.includes('tiles-grid'));
  assert.ok(html.includes('dev-chip'));
});

/* --------------------------------------------------------------- LAN chip */

test('the LAN chip keys on the marker, never on the word', () => {
  assert.equal(isLanSeeded('from workshop-pc (LAN) — 42.0 MB / 96.0 MB'), true);
  assert.equal(lanSeedPeer('from workshop-pc (LAN) — 42.0 MB / 96.0 MB'), 'workshop-pc');

  // The trap: an app whose NAME contains LAN. Nothing about this is a LAN seed.
  assert.equal(isLanSeeded('Downloading LAN party 3.0'), false);
  assert.equal(isLanSeeded('installing LAN party'), false);
  assert.equal(isLanSeeded('lan'), false);
  assert.equal(isLanSeeded(''), false);
  assert.equal(isLanSeeded(null), false);
  assert.equal(lanSeedPeer('Downloading LAN party 3.0'), '');

  assert.equal(lanChip('Downloading LAN party 3.0'), '', 'so no chip on the party');
  assert.match(lanChip('from workshop-pc (LAN)'), /class="lan-chip"/);
  assert.match(lanChip('from workshop-pc (LAN)'), /seeded from workshop-pc/);

  const bar = renderPhaseLabel({ phase: 'download', pct: 42, message: 'from workshop-pc (LAN) — 4 MB/s' });
  assert.match(bar, /lan-chip/);
  const party = renderPhaseLabel({ phase: 'download', pct: 42, message: 'LAN party 3.0 at 4 MB/s' });
  assert.ok(!party.includes('lan-chip'));
});

test('a peer name in a LAN message cannot escape the chip title', () => {
  const chip = lanChip('from "><img src=x onerror=alert(1)> (LAN)');
  assert.ok(!chip.includes('<img'), chip);
  assert.ok(!chip.includes('"><'), chip);
  assert.match(chip, /&quot;&gt;&lt;img/);
});

/* -------------------------------------------------------------- wake / WOL */

test('only an offline peer with a stored MAC can be woken', () => {
  const asleep = normalizePeer({ id: 'p', name: 'NX-WIN', mac: 'a8:a1:59:22:0d:3e', online: false });
  const awake = normalizePeer({ id: 'p', name: 'NX-WIN', mac: 'a8:a1:59:22:0d:3e', online: true });
  const unknown = normalizePeer({ id: 'p', name: 'living-room', online: false });

  assert.equal(canWake(asleep), true);
  assert.equal(canWake(awake), false, 'nothing to wake');
  assert.equal(canWake(unknown), false, 'nothing to address the packet to');
  assert.equal(unknown.mac, '', 'an absent MAC is the empty string, never undefined');
  assert.match(wakeTitle(asleep), /a8:a1:59:22:0d:3e/);
  assert.equal(wakeTitle(unknown), '');
});

test('the fleet sheet offers Wake exactly where it can work', () => {
  const peers = normalizeFleet({
    peers: [
      { id: 'p1', name: 'NX-WIN', mac: 'a8:a1:59:22:0d:3e', online: false },
      { id: 'p2', name: 'workshop-pc', mac: '3c:7c:3f:1a:44:90', online: true },
      { id: 'p3', name: 'living-room', online: false },
    ],
  }).peers;

  const html = renderFleetSheet({ peers, apps: APPS });
  const buttons = html.match(/data-act="fleet-wake" data-peer="(p\d)"/g) || [];
  assert.deepEqual(buttons, ['data-act="fleet-wake" data-peer="p1"'], 'one button, on the sleeping addressable hub');
  assert.match(html, /Send a wake-on-LAN packet to a8:a1:59:22:0d:3e/);

  // A build with no fleetWake() shows none of it.
  const older = renderFleetSheet({ peers, apps: APPS, caps: { fleetWake: false } });
  assert.ok(!older.includes('fleet-wake'));
});

/* -------------------------------------------------------------------- XSS */

test('a hostile peer name cannot inject anywhere it is rendered', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const peers = [{ id: 'p1', name: evil }];
  const stack = {
    id: 'x',
    name: 'X',
    steps: [
      { peer: 'p1', action: 'wake', health: { type: 'peer-online' } },
      { appId: 'wivrn-nx', peer: 'p1', health: { type: 'port', port: 1 } },
    ],
  };

  const tile = renderStackTile(stackTiles([stack], { apps: APPS, peers })[0]);
  assert.ok(!tile.includes('<img'), tile);

  const sheet = renderStacksSheet({ stacks: [stack], apps: APPS, peers });
  assert.ok(!sheet.includes('<img'), sheet);

  const editor = renderStacksSheet({
    draft: draftFromStack(normalizeStack(stack)),
    apps: APPS,
    peers,
  });
  assert.ok(!editor.includes('<img'), editor);
  assert.match(editor, /&quot;&gt;&lt;img/, 'it is there, escaped');

  const fleet = renderFleetSheet({
    peers: normalizeFleet({ peers: [{ id: 'p1', name: evil, mac: 'aa:bb', online: false }] }).peers,
    apps: APPS,
  });
  assert.ok(!fleet.includes('<img'), fleet);

  // …and a hostile peer id, which reaches attributes rather than text.
  const idInjected = renderStacksSheet({
    draft: { name: 'X', steps: [{ ...blankStep(), appId: 'wivrn-nx', peer: '" onmouseover="alert(1)' }] },
    apps: APPS,
    peers,
  });
  assert.ok(!idInjected.includes('onmouseover="alert'), idInjected);
});

test('a hostile dev path cannot inject through the tile menu', () => {
  const [tile] = devTiles([
    { appId: 'evil', path: '/src/" onclick="alert(1)', name: '<b>Evil</b> & co', launchCmd: '"><script>x()</script>' },
  ]);
  const html = renderTile(tile, { openMenu: tile.key, caps: {} });

  assert.ok(!html.includes('<b>Evil'), html);
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!html.includes('onclick="alert'), html);
  assert.match(html, /&lt;b&gt;Evil/);
  assert.match(html, /data-path="\/src\/&quot; onclick=&quot;alert\(1\)"/);
});

/* -------------------------------------------------------------------- mock */

test('the mock ships every v0.7 state the UI can draw', async () => {
  const { nxhub, dev } = createMock();

  // Dev links: a BARE ARRAY of two, one with a custom command.
  const raw = await nxhub.getDevLinks();
  assert.ok(Array.isArray(raw), 'the bridge answers with a bare array, not a wrapper');
  const links = normalizeDevLinks(raw);
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.launchCmd), 'one carries a launchCmd');
  assert.ok(links.some((l) => l.known && l.appId === 'wivrn-nx'), 'and one shadows a discovered app');
  assert.ok(links.some((l) => !l.known), 'while the other stands alone');

  const ran = await nxhub.devRun('nx-sandbox');
  assert.equal(ran.ok, true);
  assert.ok(ran.pid > 0);
  assert.equal(ran.source, 'launchCmd');
  // The error path REJECTS with a message meant to be shown as-is.
  await assert.rejects(() => nxhub.devRun('nope'), /No dev link/);
  dev.toggleDevExists('nx-sandbox');
  await assert.rejects(() => nxhub.devRun('nx-sandbox'), /not there any more/);
  dev.toggleDevExists('nx-sandbox');

  // Unlink hands back the fresh list, so nothing has to re-pull.
  const gone = await nxhub.devUnlink('nx-sandbox');
  assert.equal(gone.ok, true);
  assert.ok(Array.isArray(gone.links));
  assert.equal(gone.links.length, 1);
  assert.equal((await nxhub.devUnlink('nx-sandbox')).ok, false, 'unlinking twice is a no-op');
  assert.equal(dev.relinkDev(), 1, 'and it can be put back for the next screenshot');

  // The peered stack, exactly as SPEC describes the shape.
  const fabric = normalizeStacks(await nxhub.getStacks()).find((s) => s.id === 'vr-night-both-machines');
  assert.ok(fabric, 'the cross-hub stack is in the roster');
  assert.equal(isWakeStep(fabric.steps[0]), true);
  assert.equal(fabric.steps[1].health.type, 'port', 'the remote helper is gated on its port');
  assert.equal(fabric.steps[1].peer, fabric.steps[0].peer, 'both remote steps mean the same machine');
  assert.equal(fabric.steps[2].peer, undefined, 'and the local half stays local');

  // Wake: only the asleep, addressable peer answers.
  const peers = normalizeFleet(await nxhub.getFleet()).peers;
  const win = peers.find((p) => p.name === 'NX-WIN');
  assert.equal(canWake(win), true);
  assert.equal(await nxhub.fleetWake(win.id), true);
  assert.equal(await nxhub.fleetWake('nobody'), false);
  assert.equal(canWake(peers.find((p) => p.name === 'living-room')), false, 'no MAC learned for that one');

  dev.stop();
});

test('the mock LAN download speaks the dialect the chip matches', async () => {
  const { nxhub, dev } = createMock();
  const messages = [];
  const off = nxhub.onEvent((ev) => {
    if (ev.type === 'job-progress') messages.push(ev.message || '');
  });

  dev.simulateLanJob();
  await new Promise((r) => setTimeout(r, 900));
  off();
  dev.stop();

  assert.ok(messages.length, 'the job reported at least once');
  assert.ok(messages.some((m) => isLanSeeded(m)), `expected a "(LAN)" message, got ${JSON.stringify(messages)}`);
  assert.ok(
    messages.some((m) => lanSeedPeer(m) === 'workshop-pc'),
    'and it names the hub that served it'
  );
  assert.ok(
    messages.every((m) => !/delta/i.test(m)),
    'a LAN seed is not a delta — the two chips are separate claims'
  );
});

test('the mock can also produce the message that must NOT light the chip', async () => {
  const { nxhub, dev } = createMock();
  const messages = [];
  const off = nxhub.onEvent((ev) => {
    if (ev.type === 'job-progress') messages.push(ev.message || '');
  });

  // Installs an app the mock names "LAN party 3.0" — plain GitHub bytes.
  dev.simulateLanNameJob();
  await new Promise((r) => setTimeout(r, 900));
  off();
  dev.stop();

  assert.ok(messages.length);
  assert.ok(messages.every((m) => !isLanSeeded(m)), `no chip for a LAN-named app, got ${JSON.stringify(messages)}`);
});
