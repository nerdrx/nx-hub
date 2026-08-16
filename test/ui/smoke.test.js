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
  assert.equal(mock().peers().length, 3, 'and pairs nothing');

  // A malformed code never reaches the bridge at all.
  code.value = '12';
  await clickAndSettle({ 'data-act': 'fleet-pair-submit' }, 120);
  assert.match(dom.html('sheet-root'), /A pairing code has 6 digits/);

  // …then the real one.
  code.value = mock().pairCode();
  await clickAndSettle({ 'data-act': 'fleet-pair-submit' }, 700);
  assert.equal(mock().peers().length, 4, 'the peer joined the fleet');
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
  assert.equal(mock().peers().length, 4, 'a declined confirm unpairs nothing');

  globalThis.window.__confirm = true;
  const spare = mock().peers()[3].id;
  await clickAndSettle({ 'data-act': 'fleet-unpair', 'data-peer': spare }, 200);
  assert.equal(mock().peers().length, 3, 'a confirmed one does');

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

/* ------------------------------------------------------------------ v0.7 */

test('dev links get their own tiles, run from the checkout, and unlink', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' }, 80);
  const launch = dom.html('launch');
  assert.ok(launch.includes('tile-dev'), 'the linked checkouts have tiles');
  assert.ok(launch.includes('>DEV<'), 'wearing the DEV chip');
  assert.ok(launch.includes('data-act="dev-run"'), 'and they run the checkout, not an install');
  assert.ok(!launch.includes('<b>'), 'the linked names are escaped');

  // The tile order: dev tiles sit last, after every installed app.
  assert.ok(
    launch.lastIndexOf('data-act="tile-launch"') < launch.indexOf('data-act="dev-run"'),
    'dev tiles come after the app tiles'
  );

  await clickAndSettle({ 'data-act': 'dev-run', 'data-dev': 'nx-sandbox' }, 120);
  const toasts = dom.html('toasts');
  assert.match(toasts, /Running NX Sandbox/, toasts);
  assert.match(toasts, /--verbose/, 'the custom command is what ran');
  assert.equal(
    (toasts.match(/Running NX Sandbox/g) || []).length,
    1,
    'devRun toasts on its own — the renderer must not say it twice'
  );

  // A link whose folder went away: still listed, no longer runnable.
  mock().toggleDevExists('nx-sandbox');
  await tick(120);
  const broken = dom.html('launch');
  assert.ok(broken.includes('tile-dev-broken'), 'the tile reads as inert');
  assert.ok(broken.includes('folder is gone'));
  assert.match(broken, /<button class="tile-hit"[^>]*disabled/);
  mock().toggleDevExists('nx-sandbox');
  await tick(120);

  // The error path shows the bridge's own message, not a wrapped one.
  await clickAndSettle({ 'data-act': 'dev-run', 'data-dev': 'not-a-link' }, 140);
  assert.match(dom.html('toasts'), /No dev link/, dom.html('toasts'));

  // The card of the app that ALSO has a checkout carries the marker.
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' }, 80);
  assert.ok(dom.html('grid').includes('dev-mark'), 'the WiVRn NX card is marked');

  // Unlinking asks first.
  globalThis.window.__confirm = false;
  await clickAndSettle({ 'data-act': 'dev-unlink', 'data-dev': 'nx-sandbox' }, 120);
  assert.equal(mock().devLinks().length, 2, 'a declined confirm unlinks nothing');

  globalThis.window.__confirm = true;
  await clickAndSettle({ 'data-act': 'dev-unlink', 'data-dev': 'nx-sandbox' }, 200);
  assert.equal(mock().devLinks().length, 1);
  assert.match(dom.html('toasts'), /unlinked/);
  assert.ok(!dom.html('grid').includes('NX Sandbox'), 'the fresh list from the call is what redrew');

  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' }, 80);
  assert.ok(!dom.html('launch').includes('NX Sandbox'), 'and the tile is gone');

  mock().relinkDev();
  await tick(80);
});

test('the editor builds a peered step and saves it as a cross-hub stack', async () => {
  await clickAndSettle({ 'data-act': 'stacks' }, 140);
  await clickAndSettle({ 'data-act': 'stack-new' }, 120);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('data-step-field="peer"'), 'the fleet gives the step a "Runs on"');
  assert.ok(sheet.includes('>NX-WIN<'), 'and the peers are pickable by name');

  const fields = [
    sheetField({ 'data-stack-field': 'name' }, 'Remote helper'),
    sheetField({ 'data-step-field': 'appId', 'data-index': '0' }, 'wivrn-nx'),
    sheetField({ 'data-step-field': 'peer', 'data-index': '0' }, 'c0ffee11deadbeef'),
    sheetField({ 'data-step-field': 'healthType', 'data-index': '0' }, 'port'),
    sheetField({ 'data-step-field': 'port', 'data-index': '0' }, '9757'),
  ];

  // Moving the step to another hub re-renders it: the local bus is not on offer.
  doc.dispatch('change', { target: fields[2] });
  await tick(60);
  sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('class="step-peer"'), 'the row says where it runs');
  assert.ok(!sheet.includes('The app reports in on the bus'), 'and cannot gate on this hub');
  assert.ok(sheet.includes('The other hub answers'));

  await clickAndSettle({ 'data-act': 'stack-save' }, 220);
  const saved = mock().stacks().find((s) => s.id === 'remote-helper');
  assert.ok(saved, 'it saved');
  assert.equal(saved.steps[0].peer, 'c0ffee11deadbeef');
  assert.equal(saved.steps[0].appId, 'wivrn-nx');
  assert.deepEqual(saved.steps[0].health, { type: 'port', port: 9757 }, 'gated on the remote port');

  for (const el of fields) el.remove();
  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);

  // The tile shows the step as remote.
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' }, 100);
  const launch = dom.html('launch');
  assert.ok(launch.includes('st-link'), 'the step monogram wears the link glyph');
  assert.ok(launch.includes('st-mono-wake'), 'and the prebuilt stack still shows its wake step');
});

test('a wake step refuses to save without a hub, then saves without an app', async () => {
  await clickAndSettle({ 'data-act': 'stacks' }, 140);
  await clickAndSettle({ 'data-act': 'stack-new' }, 120);

  const fields = [
    sheetField({ 'data-stack-field': 'name' }, 'Wake the box'),
    sheetField({ 'data-step-field': 'action', 'data-index': '0' }, 'wake'),
    sheetField({ 'data-step-field': 'peer', 'data-index': '0' }, ''),
  ];

  // "Wake" with nothing to wake is refused, and says what is missing.
  await clickAndSettle({ 'data-act': 'stack-save' }, 160);
  assert.match(dom.html('sheet-root'), /Pick the hub this step should wake/);
  assert.equal(mock().stacks().some((s) => s.id === 'wake-the-box'), false, 'and saved nothing');

  // Point it at a hub: the app picker disappears and the boot budget fills in.
  fields[2].value = 'c0ffee11deadbeef';
  doc.dispatch('change', { target: fields[2] });
  await tick(60);
  const sheet = dom.html('sheet-root');
  assert.ok(!sheet.includes('data-step-field="appId"'), 'no app to pick on a wake step');
  assert.ok(sheet.includes('Wake NX-WIN'));
  assert.match(sheet, /Time to boot \(ms\)/);
  assert.match(sheet, /value="120000"/, 'two minutes, prefilled');

  await clickAndSettle({ 'data-act': 'stack-save' }, 220);
  const saved = mock().stacks().find((s) => s.id === 'wake-the-box');
  assert.ok(saved, 'it saved');
  assert.equal(saved.steps[0].action, 'wake');
  assert.equal(saved.steps[0].appId, null, 'with no app at all');
  assert.deepEqual(saved.steps[0].health, { type: 'peer-online', timeoutMs: 120000 });

  for (const el of fields) el.remove();
  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
});

test('a remote step names the machine it is happening on', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'launch' }, 80);
  app.onHubEvent({
    type: 'stack-progress',
    stackId: 'remote-helper',
    stepIndex: 0,
    appId: 'wivrn-nx',
    phase: 'waiting',
    peer: 'c0ffee11deadbeef',
  });
  await tick(80);
  const launch = dom.html('launch');
  assert.ok(launch.includes('NX-WIN · Waiting for WiVRn NX…'), launch.slice(launch.indexOf('remote-helper'), 900));

  app.onHubEvent({ type: 'stack-progress', stackId: 'remote-helper', stepIndex: 0, phase: 'stopped', how: 'remote-stop' });
  await tick(80);
  assert.ok(dom.html('launch').includes('Stopped on NX-WIN'), 'and the far side confirmed the stop');
});

test('an offline peer with a known MAC can be woken from the fleet sheet', async () => {
  await clickAndSettle({ 'data-act': 'fleet' }, 200);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('data-act="fleet-wake"'), 'the sleeping hub offers a Wake button');
  assert.match(sheet, /Send a wake-on-LAN packet to a8:a1:59:22:0d:3e/);
  assert.equal(
    (sheet.match(/data-act="fleet-wake"/g) || []).length,
    1,
    'and only that one — living-room has no MAC, workshop-pc is already up'
  );

  await clickAndSettle({ 'data-act': 'fleet-wake', 'data-peer': 'c0ffee11deadbeef' }, 160);
  assert.match(dom.html('toasts'), /Magic packet sent to NX-WIN/, dom.html('toasts'));

  // The box answers a moment later and the button has nothing left to do.
  await tick(2400);
  sheet = dom.html('sheet-root');
  assert.ok(!sheet.includes('data-act="fleet-wake"'), 'a hub that is up cannot be woken');
  assert.match(dom.html('toasts'), /NX-WIN answered/);

  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
});

test('a LAN-seeded download says so, and a LAN-named app does not', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' }, 80);

  mock().simulateLanJob();
  await tick(320);
  assert.match(dom.html('grid'), /class="lan-chip"/, 'the bytes came off the fleet');
  assert.match(dom.html('grid'), /seeded from workshop-pc/);

  // Let it finish so the next job starts from a clean bar.
  await tick(1600);

  // The trap: an app literally named "LAN party" downloads from GitHub.
  mock().simulateLanNameJob();
  await tick(320);
  const grid = dom.html('grid');
  assert.ok(!grid.includes('class="lan-chip"'), 'a name is not a marker');
  await tick(1600);
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

/* ------------------------------------------------------------------ v0.8 */

test('the Activity sheet opens, groups by day and pages through the recording', async () => {
  assert.equal(doc.getElementById('activity-btn').hidden, false, 'the header entry appeared with the caps probe');

  await clickAndSettle({ 'data-act': 'activity' }, 200);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('aria-label="Activity"'), 'the sheet opened');
  assert.ok(sheet.includes('act-filters'), 'with its chips');
  assert.ok(sheet.includes('class="act-row'), 'and rows');
  assert.ok(sheet.includes('act-day-head'), 'under day separators');
  assert.ok(sheet.includes('<span>Today</span>'), sheet.slice(sheet.indexOf('act-day-head'), 400));
  assert.ok(!sheet.includes('act-chip">DAY<'), 'the recorder’s own dividers never become rows');

  const firstPage = (sheet.match(/class="act-row/g) || []).length;
  assert.equal(firstPage, 25, 'one page is one page');
  assert.ok(sheet.includes('data-act="activity-more"'), 'and there is more behind it');

  await clickAndSettle({ 'data-act': 'activity-more' }, 200);
  sheet = dom.html('sheet-root');
  const secondPage = (sheet.match(/class="act-row/g) || []).length;
  assert.ok(secondPage > firstPage, `expected more rows, went ${firstPage} → ${secondPage}`);
  assert.ok(!sheet.includes('data-act="activity-more"'), 'and that was the end of it');
  assert.ok(sheet.includes('That is the whole recording'));
  assert.ok(sheet.includes('<span>Yesterday</span>'), 'the older page brought its own separator');
});

test('the filter chips slice the timeline without another round trip', async () => {
  await clickAndSettle({ 'data-act': 'activity-filter', 'data-filter': 'errors' }, 60);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('act-chip">ERROR<'), 'errors survived');
  assert.ok(!sheet.includes('act-chip">JOIN<'), 'and nothing else did');
  assert.ok(!sheet.includes('act-chip">INSTALL<'));
  assert.ok(sheet.includes('act-danger'), 'the tone came with them');

  await clickAndSettle({ 'data-act': 'activity-filter', 'data-filter': 'watchdog' }, 60);
  sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('act-chip">WATCHDOG<'));
  assert.ok(!sheet.includes('act-chip">ERROR<'));

  // A chip with nothing under it says so in its own words rather than blanking.
  await clickAndSettle({ 'data-act': 'activity-filter', 'data-filter': 'stacks' }, 60);
  assert.ok(/act-chip">STACK<|Nothing under “Stacks”/.test(dom.html('sheet-root')));

  // An id that is not a chip is ignored rather than emptying the list.
  await clickAndSettle({ 'data-act': 'activity-filter', 'data-filter': 'nonsense' }, 60);
  assert.ok(dom.html('sheet-root').includes('act-chip">STACK<') || dom.html('sheet-root').includes('Nothing under'));

  await clickAndSettle({ 'data-act': 'activity-filter', 'data-filter': 'all' }, 60);
  assert.ok(dom.html('sheet-root').includes('act-chip">JOIN<'), 'All brings everything back');
});

test('a summary full of markup is escaped on the way to the sheet', () => {
  const sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the seeded hostile summary rendered as text');
  assert.ok(!sheet.includes('<img src=x'), sheet.slice(sheet.indexOf('INSTALL_FAILED') - 200, 200));
});

test('the sheet tails live events on a debounce, then lets go when it closes', async () => {
  const before = (dom.html('sheet-root').match(/class="act-row/g) || []).length;
  // A supervisor event both reaches the recorder and nudges the tail — which
  // is the pairing the debounce exists for.
  mock().simulateSupervisor('restarting', 'quadforge', 'blender-addon-linux');
  await tick(300);
  assert.equal(
    (dom.html('sheet-root').match(/class="act-row/g) || []).length,
    before,
    'nothing re-renders immediately — that is the point of the debounce'
  );
  await tick(2200);
  const after = (dom.html('sheet-root').match(/class="act-row/g) || []).length;
  assert.equal(after, before + 1, `expected one new row, went ${before} → ${after}`);

  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
  assert.equal(dom.html('sheet-root'), '', 'the sheet closed');
  mock().simulateSupervisor('restarting', 'quadforge', 'blender-addon-linux');
  await tick(2400);
  assert.equal(dom.html('sheet-root'), '', 'and its tail did not reopen it');
});

test('App options carries the snapshots, and they restore and delete', async () => {
  await clickAndSettle({ 'data-act': 'app-options', 'data-app': 'wivrn-nx' }, 160);
  let sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('Config snapshots'), 'the section rendered');
  assert.ok(sheet.includes('data-act="snap-restore"'));
  assert.ok(sheet.includes('before an update'), 'each row says why it was taken');

  const before = mock().snapshots('wivrn-nx');
  const target = before[1];

  // Restoring asks first, and a "no" leaves the disk alone.
  globalThis.window.__confirm = false;
  await clickAndSettle({ 'data-act': 'snap-restore', 'data-app': 'wivrn-nx', 'data-snap': target.file }, 160);
  assert.equal(mock().snapshots('wivrn-nx').length, before.length, 'a declined confirm restores nothing');

  globalThis.window.__confirm = true;
  await clickAndSettle({ 'data-act': 'snap-restore', 'data-app': 'wivrn-nx', 'data-snap': target.file }, 200);
  const after = mock().snapshots('wivrn-nx');
  assert.equal(after[0].reason, 'pre-restore', 'the current config was snapshotted first');
  assert.match(dom.html('toasts'), /config restored/, dom.html('toasts'));
  assert.equal(
    (dom.html('toasts').match(/config restored/g) || []).length,
    1,
    'restoreSnapshot toasts on its own — the renderer must not say it twice'
  );
  assert.ok(dom.html('sheet-root').includes('before a restore'), 'and the list redrew with it');

  // Deleting redraws from the answer, without a second round trip.
  await clickAndSettle({ 'data-act': 'snap-delete', 'data-app': 'wivrn-nx', 'data-snap': target.file }, 160);
  assert.ok(!mock().snapshots('wivrn-nx').some((s) => s.file === target.file), 'it is gone from the bridge');
  assert.ok(!dom.html('sheet-root').includes(target.file), 'and from the sheet');
  assert.match(dom.html('toasts'), /Snapshot deleted/);

  await clickAndSettle({ 'data-act': 'close-sheet' }, 60);
});

test('keepAlive and the sandbox override round-trip through setAppPref', async () => {
  await clickAndSettle({ 'data-act': 'app-options', 'data-app': 'quadforge' }, 160);
  const sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('data-pref="keepAlive"'), 'the toggle rendered');
  assert.ok(sheet.includes('restart this app if it exits unexpectedly'));
  assert.ok(sheet.includes('Inherit (overlay: none)'), 'and the select spells out what it inherits');

  // The stub DOM never parses innerHTML, so stand-ins play the controls.
  const host = doc.getElementById('sheet-root');
  const keep = doc.createElement('input');
  keep.setAttribute('type', 'checkbox');
  keep.setAttribute('data-pref', 'keepAlive');
  keep.checked = true;
  host.appendChild(keep);
  const sandbox = doc.createElement('select');
  sandbox.setAttribute('data-pref', 'sandbox');
  sandbox.value = 'offline';
  host.appendChild(sandbox);

  await clickAndSettle({ 'data-act': 'save-app-prefs', 'data-app': 'quadforge' }, 200);
  const pref = mock().state.settings.appPrefs.quadforge;
  assert.equal(pref.keepAlive, true);
  assert.equal(pref.sandbox, 'offline');
  keep.remove();
  sandbox.remove();

  // …and "Inherit" writes null, which is what clears the override.
  await clickAndSettle({ 'data-act': 'app-options', 'data-app': 'quadforge' }, 160);
  const back = doc.createElement('select');
  back.setAttribute('data-pref', 'sandbox');
  back.value = 'inherit';
  doc.getElementById('sheet-root').appendChild(back);
  await clickAndSettle({ 'data-act': 'save-app-prefs', 'data-app': 'quadforge' }, 200);
  assert.equal(mock().state.settings.appPrefs.quadforge.sandbox, null, 'null, not "inherit"');
  back.remove();
});

test('the watchdog puts a line on the card, then a banner it can be dismissed from', async () => {
  await clickAndSettle({ 'data-act': 'view', 'data-view': 'manage' }, 80);

  // A restart on an app that is NOT on the bus, so nothing clears it early.
  mock().simulateSupervisor('restarting', 'quadforge', 'blender-addon-linux');
  await tick(80);
  let grid = dom.html('grid');
  assert.ok(grid.includes('class="sup-line"'), grid.slice(grid.indexOf('quadforge'), 400));
  assert.match(grid, /Restarting — attempt \d…/);
  assert.ok(!grid.includes('banner-sup'), 'a retry is not an alarm');

  mock().simulateSupervisor('gave-up', 'quadforge', 'blender-addon-linux');
  await tick(80);
  grid = dom.html('grid');
  assert.ok(grid.includes('banner-sup'), 'the give-up banners');
  assert.match(grid, /kept exiting/);
  assert.match(grid, /Start it by hand/, 'and says what to do next');
  assert.ok(!grid.includes('class="sup-line"'), 'the retry line was superseded, not stacked');
  assert.equal(
    (dom.html('toasts').match(/kept exiting/g) || []).length,
    1,
    'main already toasted it — the renderer adds the standing copy only'
  );

  await clickAndSettle({ 'data-act': 'dismiss-supervisor', 'data-sup': 'quadforge::blender-addon-linux' }, 80);
  assert.ok(!dom.html('grid').includes('banner-sup'), 'dismissed');

  // An app that IS on the bus clears its own restart line the moment it reports
  // in, because the presence that follows the event is the relaunch answering.
  mock().simulateSupervisor('restarting', 'pulsenx', 'appimage-linux');
  await tick(80);
  assert.ok(dom.html('grid').includes('class="sup-line"'), 'it shows while the roster is stale');
  mock().toggleBusClient('pulsenx');
  await tick(120);
  mock().toggleBusClient('pulsenx');
  await tick(160);
  assert.ok(!dom.html('grid').includes('class="sup-line"'), 'and goes when the app announces itself again');
});

test('the shield marks signed rows, and the strict setting calls out the unsigned ones', async () => {
  let grid = dom.html('grid');
  assert.ok(grid.includes('sig-ok'), 'signed rows wear the violet shield');
  assert.ok(grid.includes('cryptographically signed release'));
  assert.ok(!grid.includes('sig-none'), 'and unsigned ones say nothing while the setting is off');

  mock().toggleRequireSignatures();
  await tick(120);
  grid = dom.html('grid');
  assert.ok(grid.includes('sig-none'), 'now they do');
  assert.ok(grid.includes('sig-ok'), 'and the signed ones are unchanged');

  // The setting is editable from the panel and survives a save.
  await clickAndSettle({ 'data-act': 'settings' }, 80);
  assert.ok(dom.html('panel-root').includes('data-field="requireSignatures" checked'));
  const box = doc.createElement('input');
  box.setAttribute('type', 'checkbox');
  box.setAttribute('data-field', 'requireSignatures');
  box.checked = false;
  doc.getElementById('panel-root').appendChild(box);
  await clickAndSettle({ 'data-act': 'save-settings' }, 160);
  assert.equal(mock().state.settings.requireSignatures, false, 'the checkbox reached setSettings');
  box.remove();
  await tick(80);
  assert.ok(!dom.html('grid').includes('sig-none'), 'and the markers went with it');
});

test('a rollback with a matching pre-update snapshot offers to bring the config back', async () => {
  mock().armRollback('quadforge', 'blender-addon-linux', '0.9.0', '0.8.0');
  await tick(120);

  await clickAndSettle({ 'data-act': 'rollback', 'data-app': 'quadforge', 'data-art': 'blender-addon-linux' }, 200);
  const sheet = dom.html('sheet-root');
  assert.ok(sheet.includes('data-act="rollback-confirm"'), 'the confirm became a sheet');
  assert.ok(sheet.includes('0.9.0 → 0.8.0'));
  assert.ok(sheet.includes('also restore the config from before the update'), 'with the affinity checkbox');
  assert.ok(sheet.includes('data-rollback-config checked'), 'opted in by default');
  assert.ok(sheet.includes('Files added since then are left alone'), 'and the overwrite semantics are spelled out');

  const file = mock().snapshots('quadforge').find((s) => s.reason === 'pre-update' && s.version === '0.8.0').file;

  // Untick it: the binary goes back, the config does not.
  const box = doc.createElement('input');
  box.setAttribute('type', 'checkbox');
  box.setAttribute('data-rollback-config', '');
  box.checked = false;
  doc.getElementById('sheet-root').appendChild(box);
  const beforeSnaps = mock().snapshots('quadforge').length;
  await clickAndSettle({ 'data-act': 'rollback-confirm', 'data-app': 'quadforge', 'data-art': 'blender-addon-linux', 'data-snap': file }, 260);
  box.remove();

  let art = mock().state.apps.find((a) => a.id === 'quadforge').artifacts[0];
  assert.equal(art.installed.version, '0.8.0', 'the rollback happened');
  assert.equal(mock().snapshots('quadforge').length, beforeSnaps, 'and nothing was restored');
  assert.equal(dom.html('sheet-root'), '', 'the sheet closed');

  // Now with it ticked: the restore follows the rollback, and only then.
  mock().armRollback('quadforge', 'blender-addon-linux', '0.9.0', '0.8.0');
  await tick(120);
  await clickAndSettle({ 'data-act': 'rollback', 'data-app': 'quadforge', 'data-art': 'blender-addon-linux' }, 200);
  assert.ok(dom.html('sheet-root').includes('data-act="rollback-confirm"'));
  const file2 = mock().snapshots('quadforge').find((s) => s.reason === 'pre-update' && s.version === '0.8.0').file;
  await clickAndSettle({ 'data-act': 'rollback-confirm', 'data-app': 'quadforge', 'data-art': 'blender-addon-linux', 'data-snap': file2 }, 300);

  art = mock().state.apps.find((a) => a.id === 'quadforge').artifacts[0];
  assert.equal(art.installed.version, '0.8.0');
  assert.equal(mock().snapshots('quadforge')[0].reason, 'pre-restore', 'the config came back too');
  assert.match(dom.html('toasts'), /config restored/);
});

test('a rollback with no matching snapshot still uses the plain confirm', async () => {
  // wivrn-nx deliberately has no pre-update snapshot at its rollback target, so
  // nothing about the v0.2 flow changed for it.
  mock().armRollback('quadforge', 'blender-addon-linux', '0.9.0', '0.5.0', { snapshot: false });
  await tick(120);
  globalThis.window.__confirm = false;
  await clickAndSettle({ 'data-act': 'rollback', 'data-app': 'quadforge', 'data-art': 'blender-addon-linux' }, 200);
  assert.equal(dom.html('sheet-root'), '', 'no sheet — there was nothing to offer');
  assert.equal(
    mock().state.apps.find((a) => a.id === 'quadforge').artifacts[0].installed.version,
    '0.9.0',
    'and a declined confirm rolls nothing back'
  );
  globalThis.window.__confirm = true;
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
