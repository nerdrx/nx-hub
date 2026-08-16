// Stub-DOM smoke test: boot the real controller (app.js) against a fake DOM and
// the in-page mock, then drive it through the v0.2 flows with fake clicks.
//
// Nothing here renders pixels — it proves the wiring: boot order, event
// handling, delegation by data-act, and that every host element gets markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, fakeControl, tick } from './dom-stub.js';

const dom = installDom();
// app.js boots itself on import (document.readyState === 'complete').
const app = await import('../../src/renderer/app.js');
const { doc } = dom;

await tick(60);

function click(attrs) {
  doc.click(fakeControl(doc, attrs));
}
async function clickAndSettle(attrs, ms = 80) {
  click(attrs);
  await tick(ms);
}
const mock = () => globalThis.window.__nxhubMock;

test('the renderer boots, installs the mock and fills every host', async () => {
  assert.equal(globalThis.window.__nxhubBooted, true, 'boot finished');
  assert.ok(globalThis.window.nxhub, 'the mock bridge is installed');
  assert.ok(dom.html('logo').includes('<svg'), 'the logo rendered');
  assert.ok(dom.html('grid').includes('<article'), 'cards rendered');
  assert.ok(dom.html('grid').includes('WiVRn NX'));
  assert.ok(dom.html('unpublished').includes('Nothing to install'), 'the bottom section rendered');
  assert.ok(dom.html('hidden-apps').includes('Show hidden'), 'the hidden row rendered');
  assert.ok(dom.html('device-chip').includes('data-act="devices"'), 'the device chip rendered');
  assert.match(doc.getElementById('tab-manage').innerHTML, /Manage/);
});

test('the Manage tab carries the update badge', () => {
  const label = doc.getElementById('tab-manage').innerHTML;
  assert.match(label, /class="tab-badge"/, `expected a badge, got ${label}`);
  assert.match(label, />\d+<\/span>/, label);
});

test('switching views toggles the hosts and remembers the choice', async () => {
  // Boot opened the launcher (the mock roster has installed apps).
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' });
  assert.equal(doc.getElementById('launch').hidden, false);
  assert.equal(doc.getElementById('manage-view').hidden, true);
  assert.ok(dom.html('launch').includes('tiles-grid'));
  assert.ok(dom.html('launch').includes('tile-star'), 'the favorite shows its star');

  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' });
  assert.equal(doc.getElementById('manage-view').hidden, false);
  assert.equal(doc.getElementById('launch').hidden, true);
  assert.match(dom.store.get('nxhub.ui.v1') || '', /"view":"manage"/, 'the choice is remembered');
});

test('launching a tile records a recent so favorites/recents can order', async () => {
  await clickAndSettle({ 'data-act': 'tile-launch', 'data-app': 'pulsenx', 'data-art': 'appimage-linux' });
  const saved = JSON.parse(dom.store.get('nxhub.ui.v1'));
  assert.deepEqual(saved.recents.slice(0, 1), ['pulsenx::appimage-linux']);
  assert.ok(dom.html('toasts').includes('Launching'), 'the mock toasted');
});

test('the app-options sheet opens, previews args live and saves', async () => {
  await clickAndSettle({ 'data-act': 'app-options', 'data-app': 'wivrn-nx' });
  const sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('App options'), 'the sheet opened');
  assert.ok(sheet.includes('data-pref="updatePolicy"'));
  assert.ok(sheet.includes('living room'), 'the seeded launch args round-tripped');

  // The live preview updates without a re-render, so the caret never jumps.
  const argsInput = doc.createElement('input');
  argsInput.setAttribute('data-pref', 'launchArgs');
  argsInput.value = '--a "b c"';
  const preview = doc.createElement('div');
  preview.id = 'args-preview';
  doc.body.appendChild(preview);
  doc.byId.set('args-preview', preview);
  doc.input(argsInput);
  assert.match(preview.innerHTML, /arg-chip/);
  assert.match(preview.innerHTML, /b c/);

  await clickAndSettle({ 'data-act': 'save-app-prefs', 'data-app': 'wivrn-nx' });
  assert.equal(dom.html('sheet-root'), '', 'the sheet closed after saving');
  assert.ok(dom.html('toasts').includes('App options saved'));
});

test('favorite, hide and unhide go straight through setAppPref', async () => {
  await clickAndSettle({ 'data-act': 'toggle-fav', 'data-app': 'quadforge' });
  assert.equal(mock().state.settings.appPrefs.quadforge.favorite, true);
  assert.ok(dom.html('grid').includes('fav-star'));

  await clickAndSettle({ 'data-act': 'hide-app', 'data-app': 'quadforge' });
  assert.equal(mock().state.settings.appPrefs.quadforge.hidden, true);
  assert.ok(!dom.html('grid').includes('QuadForge'), 'the card left the grid');

  await clickAndSettle({ 'data-act': 'toggle-hidden' });
  assert.ok(dom.html('hidden-apps').includes('data-act="unhide-app"'));

  await clickAndSettle({ 'data-act': 'unhide-app', 'data-app': 'quadforge' });
  assert.equal(mock().state.settings.appPrefs.quadforge.hidden, false);
  assert.ok(dom.html('grid').includes('QuadForge'), 'the card came back');
});

test('skip and clear-skip write the exact version', async () => {
  await clickAndSettle({ 'data-act': 'skip-version', 'data-app': 'pulsenx', 'data-version': '2.3.0' });
  assert.equal(mock().state.settings.appPrefs.pulsenx.skippedVersion, '2.3.0');
  await clickAndSettle({ 'data-act': 'clear-skip', 'data-app': 'pulsenx' });
  assert.equal(mock().state.settings.appPrefs.pulsenx.skippedVersion, '');
});

test('the versions sheet loads the history and can install an older tag', async () => {
  await clickAndSettle({ 'data-act': 'versions', 'data-app': 'wivrn-nx' }, 500);
  const sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('Version history'));
  assert.ok(sheet.includes('data-act="install-version"'));
  assert.ok(sheet.includes('Roll back to 1.9.1'), 'the rollback block is there');

  // Expanding one release's notes only toggles that row.
  await clickAndSettle({ 'data-act': 'rel-notes', 'data-tag': 'v1.9.2' });
  assert.ok(dom.html('sheet-root').includes('markdown'));

  // A downgrade asks first — say no, nothing happens.
  globalThis.window.__confirm = false;
  await clickAndSettle({
    'data-act': 'install-version',
    'data-app': 'wivrn-nx',
    'data-art': 'tarball-prefix-linux',
    'data-tag': 'v1.9.1',
  });
  assert.ok(dom.html('sheet-root').includes('Version history'), 'a declined downgrade keeps the sheet open');
  globalThis.window.__confirm = true;
});

test('rollback confirms, then restores the previous version', async () => {
  await clickAndSettle({ 'data-act': 'rollback', 'data-app': 'wivrn-nx', 'data-art': 'tarball-prefix-linux' }, 120);
  const art = mock()
    .state.apps.find((a) => a.id === 'wivrn-nx')
    .artifacts.find((a) => a.id === 'tarball-prefix-linux');
  assert.equal(art.installed.version, '1.9.1');
  assert.equal(dom.html('sheet-root'), '', 'the sheet closed');
});

test('the devices sheet connects over Wi-Fi and reports errors', async () => {
  await clickAndSettle({ 'data-act': 'devices' }, 260);
  assert.ok(dom.html('sheet-root').includes('adb targets'));
  assert.ok(dom.html('sheet-root').includes('Pico 4 Ultra'));

  const input = doc.createElement('input');
  input.setAttribute('data-field', 'adbHost');
  input.value = '127.0.0.1:5555';
  doc.input(input);
  await clickAndSettle({ 'data-act': 'adb-connect' }, 1200);
  assert.ok(dom.html('sheet-root').includes('field-error'), 'a refused connection surfaces');

  input.value = '192.168.1.42:5555';
  doc.input(input);
  await clickAndSettle({ 'data-act': 'adb-connect' }, 1400);
  assert.ok(mock().state.adb.devices.some((d) => d.serial === '192.168.1.42:5555'));

  await clickAndSettle({ 'data-act': 'select-device', 'data-serial': '192.168.1.42:5555' }, 260);
  assert.equal(mock().state.settings.preferredDeviceSerial, '192.168.1.42:5555');
  await clickAndSettle({ 'data-act': 'close-sheet' });
});

test('settings open, gain storage/logs on demand, and save the v0.2 fields', async () => {
  await clickAndSettle({ 'data-act': 'settings' });
  assert.ok(dom.html('panel-root').includes('data-field="updatePolicy"'));

  await clickAndSettle({ 'data-act': 'disk-usage' }, 420);
  assert.ok(dom.html('panel-root').includes('usage-bar'), 'the bars appeared');
  assert.ok(dom.html('panel-root').includes('Total <strong>'));

  await clickAndSettle({ 'data-act': 'clear-cache' }, 420);
  assert.ok(dom.html('toasts').includes('freed'), 'the freed-bytes toast fired');

  await clickAndSettle({ 'data-act': 'load-logs' }, 120);
  assert.ok(dom.html('panel-root').includes('<pre class="logbox"'));
  assert.ok(dom.html('panel-root').includes('data-act="copy-logs"'));

  await clickAndSettle({ 'data-act': 'export-settings' }, 120);
  assert.ok(dom.html('toasts').includes('exported'));

  await clickAndSettle({ 'data-act': 'step', 'data-field': 'maxConcurrentDownloads', 'data-delta': '1' });
  await clickAndSettle({ 'data-act': 'save-settings' }, 120);
  assert.equal(dom.html('panel-root'), '', 'the panel closed after saving');
  assert.equal(mock().state.settings.maxConcurrentDownloads, 3);
  assert.equal(typeof mock().state.settings.notifications, 'boolean');
});

test('an update-available event toasts with an Update button that installs', async () => {
  const appId = mock().simulateUpdateEvent('pulsenx');
  await tick(60);
  const toasts = dom.html('toasts');
  assert.ok(toasts.includes('is available'), toasts);
  assert.ok(toasts.includes('data-act="update-app"'));

  await clickAndSettle({ 'data-act': 'update-app', 'data-app': appId, 'data-id': 'x' }, 120);
  assert.ok(
    mock().state.jobs.some((j) => j.appId === appId) || dom.html('grid').includes('data-job'),
    'the update started'
  );
});

test('Escape closes the sheet first, then the settings panel', async () => {
  await clickAndSettle({ 'data-act': 'settings' });
  await clickAndSettle({ 'data-act': 'app-options', 'data-app': 'pulsenx' });
  assert.ok(dom.html('sheet-root').length > 0);

  doc.key('Escape');
  await tick(40);
  assert.equal(dom.html('sheet-root'), '', 'the sheet went first');
  assert.ok(dom.html('panel-root').length > 0, 'the panel is still open');

  doc.key('Escape');
  await tick(40);
  assert.equal(dom.html('panel-root'), '');
});

/* ------------------------------------------------------------------ v0.5 */

test('a live bus client puts a status strip on its card', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' });
  const grid = dom.html('grid');
  assert.ok(grid.includes('class="live"'), 'the strip rendered');
  assert.ok(grid.includes('>LIVE<'));
  assert.ok(grid.includes('Heart rate'), 'the declared label won');
  assert.ok(grid.includes('latency_ms'), 'the undeclared field still shows');

  // Taking the app off the bus takes the strip with it.
  mock().toggleBusClient('pulsenx');
  await tick(80);
  assert.ok(!dom.html('grid').includes('data-live="pulsenx"'), 'the strip left with the client');
  mock().toggleBusClient('pulsenx');
  await tick(80);
  assert.ok(dom.html('grid').includes('data-live="pulsenx"'), 'and came back');
});

test('the launcher shows presence on tiles and the prebuilt stack tile', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' });
  const launch = dom.html('launch');
  assert.ok(launch.includes('class="tile-live"'), 'the presence dot rendered');
  assert.ok(/tile-cap">\d+ bpm</.test(launch), launch.slice(0, 400));
  assert.ok(launch.includes('tile-stack'), 'the stack tile rendered');
  assert.ok(launch.includes('VR Night'));
  assert.ok(launch.indexOf('tile-stack') < launch.indexOf('data-act="tile-launch"'), 'stacks come first');
  assert.ok(launch.includes('data-act="stack-new"'), 'the ghost tile invites a new stack');
  assert.equal(doc.getElementById('stacks-btn').hidden, false, 'the header entry appeared');
});

test('the stacks sheet edits, saves, runs and stops a stack', async () => {
  await clickAndSettle({ 'data-act': 'stacks' }, 120);
  assert.ok(dom.html('sheet-root').includes('VR Night'), 'the list opened');

  await clickAndSettle({ 'data-act': 'stack-new' });
  assert.ok(dom.html('sheet-root').includes('data-stack-field="name"'), 'the editor opened');

  // The stub DOM never parses innerHTML, so stand-in inputs play the part of
  // the fields the editor just rendered.
  const sheet = doc.getElementById('sheet-root');
  const field = (attrs, value) => {
    const el = doc.createElement('input');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.value = value;
    sheet.appendChild(el);
    return el;
  };
  const inputs = [
    field({ 'data-stack-field': 'name' }, 'Test Stack'),
    field({ 'data-step-field': 'appId', 'data-index': '0' }, 'pulsenx'),
  ];

  // Switching the health rule swaps the inputs under that step.
  const gate = field({ 'data-step-field': 'healthType', 'data-index': '0' }, 'port');
  inputs.push(gate);
  doc.dispatch('change', { target: gate });
  await tick(40);
  assert.ok(dom.html('sheet-root').includes('data-step-field="port"'), 'the port box appeared');
  gate.value = 'connector';
  doc.dispatch('change', { target: gate });
  await tick(40);
  assert.ok(!dom.html('sheet-root').includes('data-step-field="port"'), 'and went away again');

  // Saving with one blank step surfaces the error instead of writing junk.
  await clickAndSettle({ 'data-act': 'stack-step-add' });
  await clickAndSettle({ 'data-act': 'stack-save' }, 120);
  assert.ok(dom.html('sheet-root').includes('Pick an app for this step'), 'the second step is empty');
  assert.ok(!mock().stacks().some((s) => s.id === 'test-stack'), 'nothing was saved');

  inputs.push(field({ 'data-step-field': 'appId', 'data-index': '1' }, 'wivrn-nx'));
  await clickAndSettle({ 'data-act': 'stack-save' }, 200);
  const saved = mock().stacks().find((s) => s.id === 'test-stack');
  assert.ok(saved, 'the stack reached the bridge');
  assert.deepEqual(saved.steps.map((s) => s.appId), ['pulsenx', 'wivrn-nx']);
  assert.deepEqual(saved.steps.map((s) => s.health.type), ['connector', 'connector']);
  assert.ok(dom.html('toasts').includes('saved'));
  assert.ok(dom.html('sheet-root').includes('Test Stack'), 'the list came back with it');
  for (const el of inputs) el.remove();

  await clickAndSettle({ 'data-act': 'close-sheet' });
  await clickAndSettle({ 'data-act': 'stack-run', 'data-stack': 'test-stack' }, 400);
  let launch = dom.html('launch');
  assert.ok(launch.includes('is-running'), 'the tile reads as running');
  assert.ok(launch.includes('data-act="stack-stop"'), 'and offers a way out');
  assert.ok(/st-(go|wait|ok)/.test(launch), launch.slice(launch.indexOf('tile-stack'), 400));

  await clickAndSettle({ 'data-act': 'stack-stop', 'data-stack': 'test-stack' }, 700);
  launch = dom.html('launch');
  assert.ok(launch.includes('Stopped'), 'the stop landed');
  assert.ok(!launch.includes('data-act="stack-stop"'));

  await clickAndSettle({ 'data-act': 'stacks' }, 120);
  globalThis.window.__confirm = true;
  await clickAndSettle({ 'data-act': 'stack-delete', 'data-stack': 'test-stack' }, 200);
  assert.ok(!mock().stacks().some((s) => s.id === 'test-stack'), 'delete went through');
  await clickAndSettle({ 'data-act': 'close-sheet' });
});

/* ------------------------------------------------------------------ v0.6 */

/** Stand-in inputs for the fields a sheet just rendered (innerHTML is a string). */
function sheetField(attrs, value) {
  const sheet = doc.getElementById('sheet-root');
  const el = doc.createElement('input');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.value = value;
  sheet.appendChild(el);
  return el;
}

test('the header carries a peer chip once the bridge has a fleet', async () => {
  await tick(40);
  const chip = dom.html('fleet-chip');
  assert.ok(chip.includes('data-act="fleet"'), chip);
  assert.match(chip, /peer-chip peer-on/, 'one of the two mock hubs is online');
  assert.match(chip, /1 hub</);
});

test('the fleet sheet opens, shows a code and survives a wrong one', async () => {
  await clickAndSettle({ 'data-act': 'fleet' }, 160);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('aria-label="Fleet"'), 'the sheet opened');
  assert.ok(sheet.includes('workshop-pc'), 'the online peer is listed');
  assert.ok(sheet.includes('living-room'), 'and the offline one');
  assert.ok(sheet.includes('data-act="fleet-update-all"'), 'a hub with updates can be updated wholesale');

  // Direction 1: this hub shows a code.
  await clickAndSettle({ 'data-act': 'fleet-show-code' }, 160);
  sheet = dom.html('sheet-root');
  assert.match(sheet, /pair-group">482</, sheet.slice(sheet.indexOf('Pairing'), 900));
  assert.match(sheet, /expires in [12]:\d\d/, 'the countdown started');

  // Direction 2: this hub types the other one's code — wrong first.
  await clickAndSettle({ 'data-act': 'fleet-pair-open' });
  const host = sheetField({ 'data-fleet-field': 'host' }, '192.168.1.99');
  const code = sheetField({ 'data-fleet-field': 'code' }, '000000');
  await clickAndSettle({ 'data-act': 'fleet-pair-submit' }, 700);
  assert.match(dom.html('sheet-root'), /did not match/, 'the wrong code says so, inline');
  assert.equal(mock().peers().length, 2, 'and pairs nothing');

  // A malformed code never reaches the bridge at all.
  code.value = '12';
  await clickAndSettle({ 'data-act': 'fleet-pair-submit' }, 120);
  assert.match(dom.html('sheet-root'), /A pairing code has 6 digits/);

  // …then the real one.
  code.value = mock().pairCode();
  await clickAndSettle({ 'data-act': 'fleet-pair-submit' }, 700);
  assert.equal(mock().peers().length, 3, 'the peer joined the fleet');
  assert.ok(dom.html('toasts').includes('Paired with'), 'and it said so');
  assert.ok(dom.html('sheet-root').includes('192.168.1.99'), 'the list picked it up');

  host.remove();
  code.remove();
});

test('unpairing confirms, and a remote job draws a row under its peer', async () => {
  const peerId = mock().peers()[0].id;
  mock().simulateFleetJob(peerId, 'wivrn-nx');
  await tick(300);
  assert.ok(dom.html('sheet-root').includes('class="fleet-job"'), 'the relayed progress rendered');
  assert.match(dom.html('sheet-root'), /delta-chip/, 'and it is a delta transfer');

  globalThis.window.__confirm = false;
  await clickAndSettle({ 'data-act': 'fleet-unpair', 'data-peer': peerId }, 120);
  assert.equal(mock().peers().length, 3, 'a declined confirm unpairs nothing');

  globalThis.window.__confirm = true;
  const spare = mock().peers()[2].id;
  await clickAndSettle({ 'data-act': 'fleet-unpair', 'data-peer': spare }, 200);
  assert.equal(mock().peers().length, 2, 'a confirmed one does');

  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
  assert.equal(dom.html('sheet-root'), '', 'the sheet (and its countdown) closed');
});

test('installing on a peer goes through the compact picker', async () => {
  await clickAndSettle({ 'data-act': 'fleet' }, 160);
  const peerId = mock().peers()[0].id;
  // The picker the sheet rendered, standing in for the real <select>.
  const pick = sheetField({ 'data-fleet-art': `${peerId}::wivrn-nx` }, 'tarball-prefix-linux');
  await clickAndSettle({ 'data-act': 'fleet-install', 'data-peer': peerId, 'data-app': 'wivrn-nx' }, 200);
  assert.ok(dom.html('toasts').includes('Installing wivrn-nx on workshop-pc'), dom.html('toasts'));
  pick.remove();
  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
});

test('the stacks editor saves a trigger and the tile grows a bolt', async () => {
  await clickAndSettle({ 'data-act': 'stacks' }, 140);
  assert.ok(dom.html('sheet-root').includes('Headset arrives'), 'the triggered stack is listed');
  assert.ok(dom.html('sheet-root').includes('st-auto'), 'and already marked auto');

  await clickAndSettle({ 'data-act': 'stack-edit', 'data-stack': 'headset-arrives' }, 120);
  assert.ok(dom.html('sheet-root').includes('data-stack-field="triggerType"'), 'the Automation section rendered');
  assert.ok(dom.html('sheet-root').includes('value="PA7HA0M123"'), 'the serial round-tripped');

  const fields = [
    sheetField({ 'data-stack-field': 'name' }, 'Headset arrives'),
    sheetField({ 'data-stack-field': 'triggerType' }, 'connector-app'),
    sheetField({ 'data-stack-field': 'triggerCooldown' }, '30'),
  ];
  // Switching the type swaps the serial box for the app picker.
  doc.dispatch('change', { target: fields[1] });
  await tick(40);
  assert.ok(dom.html('sheet-root').includes('data-stack-field="triggerAppId"'), 'the app picker appeared');
  assert.ok(!dom.html('sheet-root').includes('data-stack-field="triggerSerial"'), 'and the serial box left');

  // Saving with no app on a bus trigger is refused, inline.
  await clickAndSettle({ 'data-act': 'stack-save' }, 140);
  assert.ok(dom.html('sheet-root').includes('Pick the app whose arrival starts this stack'), 'it said what is missing');
  assert.equal(
    mock().stacks().find((s) => s.id === 'headset-arrives').trigger.type,
    'adb-device',
    'and saved nothing'
  );

  fields.push(sheetField({ 'data-stack-field': 'triggerAppId' }, 'pulsenx'));
  await clickAndSettle({ 'data-act': 'stack-save' }, 200);
  const saved = mock().stacks().find((s) => s.id === 'headset-arrives');
  assert.deepEqual(saved.trigger, { type: 'connector-app', appId: 'pulsenx', stopOnLeave: true, cooldownMs: 30000 });
  for (const el of fields) el.remove();
  await clickAndSettle({ 'data-act': 'close-sheet' });

  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' }, 80);
  const launch = dom.html('launch');
  assert.ok(launch.includes('st-auto'), 'the tile wears the auto chip');
  assert.ok(launch.includes('st-bolt'), 'and the bolt');
});

test('a triggered run opens on the tile before anything launches', async () => {
  app.onHubEvent({ type: 'stack-progress', stackId: 'headset-arrives', stepIndex: null, phase: 'triggered', reason: 'connector-app' });
  await tick(60);
  const launch = dom.html('launch');
  assert.ok(launch.includes('phase-triggered'), launch.slice(launch.indexOf('headset-arrives'), 400));
  assert.ok(launch.includes('An app joined the bus — starting…'));
  assert.ok(!launch.includes('st-glyph'), 'no step has been reached yet');
});

test('a crash-looping app banners its card, and the dismissal sticks per version', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' }, 80);
  let grid = dom.html('grid');
  assert.ok(grid.includes('banner-crash'), 'the amber banner is on the card');
  assert.ok(grid.includes('Crashed 4 times since updating to 1.4.2.'), grid.slice(grid.indexOf('banner-crash'), 600));
  assert.ok(grid.includes('Roll back to 1.4.1'), 'with a way out');

  await clickAndSettle({
    'data-act': 'dismiss-crash',
    'data-app': 'oscgoesbrrr-nx-patches',
    'data-art': 'appimage-linux',
    'data-version': '1.4.2',
  });
  grid = dom.html('grid');
  assert.ok(!grid.includes('banner-crash'), 'dismissed');
  const saved = JSON.parse(dom.store.get('nxhub.ui.v1'));
  assert.deepEqual(saved.dismissedCrashes, ['oscgoesbrrr-nx-patches::appimage-linux@1.4.2']);

  // Without a rollback target the banner still offers a reinstall.
  mock().cycleCrashLoop();
  await tick(80);
  assert.ok(!dom.html('grid').includes('banner-crash'), 'still dismissed — same version');
});

test('a delta install shows the Δ chip and its closing line', async () => {
  mock().simulateDeltaJob();
  await tick(500);
  const grid = dom.html('grid');
  assert.ok(grid.includes('delta-chip'), grid.slice(grid.indexOf('data-job'), 600));
  assert.ok(/Downloading \d+%<span class="delta-chip"/.test(grid), 'the chip sits on the phase label');

  // Let it finish: the install re-arms the (dismissed) crash banner because the
  // version changed underneath it.
  await tick(4200);
  const after = dom.html('grid');
  assert.ok(!after.includes('data-job'), 'the job bar cleared');
  assert.ok(!after.includes('banner-crash'), 'and the fresh install has no crash history');
});

test('the controller never throws on a junk event', () => {
  for (const ev of [null, 'nope', {}, { type: 'unknown' }, { type: 'update-available' }]) {
    app.onHubEvent(ev);
  }
  assert.ok(true);
});

test('hiding the document parks the starfield loop', async () => {
  // The parallax sky runs on requestAnimationFrame; it must stop dead when the
  // window is not visible (and it is what lets this process exit).
  doc.hidden = true;
  doc.dispatch('visibilitychange', {});
  await tick(40);
  mock().stop();
  await tick(40);
  // The globals stay installed on purpose: a late frame from an earlier render
  // must still find its window instead of exploding.
  assert.equal(doc.hidden, true);
});
