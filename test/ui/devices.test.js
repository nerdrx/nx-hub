import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  batteryLevel,
  deviceChipLabel,
  deviceSummary,
  normalizeDeviceInfo,
  parseHostPort,
  selectedSerial,
} from '../../src/renderer/lib/devices.js';
import { renderDeviceChip, renderDeviceLine, renderDevicesSheet } from '../../src/renderer/views/devices.js';
import { renderArtifactRow } from '../../src/renderer/views/card.js';
import { normalizeApp, normalizeState } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const INFO = { serial: 'PA7X', model: 'Pico 4', batteryPct: 82, storageFreeBytes: 13_300_000_000 };
const ADB_ON = { connected: true, devices: [{ serial: 'PA7X', model: 'Pico 4', state: 'device' }], versions: {} };
const ADB_OFF = { connected: false, devices: [], versions: {} };

/* --------------------------------------------------------------- normalize */

test('normalizeDeviceInfo clamps and fills, or returns null', () => {
  assert.equal(normalizeDeviceInfo(null), null);
  assert.equal(normalizeDeviceInfo('x'), null);
  const d = normalizeDeviceInfo({ serial: 'S', batteryPct: '117.6', storageFreeBytes: '-4' });
  assert.equal(d.model, 'S', 'the serial stands in for a missing model');
  assert.equal(d.batteryPct, 100);
  assert.equal(d.storageFreeBytes, 0);
  assert.equal(normalizeDeviceInfo({}).batteryPct, null);
  assert.equal(normalizeDeviceInfo({}).model, 'Android device');
});

/* ------------------------------------------------------- human-unit summary */

test('deviceSummary reads "Pico 4 · 82% · 12.4 GB free" — no locale involved', () => {
  assert.equal(deviceSummary(INFO), 'Pico 4 · 82% · 12.4 GB free');
  // A de_DE host must not turn the decimal point into a comma.
  assert.ok(!deviceSummary(INFO).includes(','));
  assert.equal(deviceSummary({ model: 'Quest 3' }), 'Quest 3');
  assert.equal(deviceSummary({ model: 'Quest 3', batteryPct: 5 }), 'Quest 3 · 5%');
  assert.equal(deviceSummary(null), '');
});

test('battery buckets drive the colour', () => {
  assert.equal(batteryLevel(82), 'ok');
  assert.equal(batteryLevel(40), 'warn');
  assert.equal(batteryLevel(20), 'low');
  assert.equal(batteryLevel(null), '');
});

/* ---------------------------------------------------------- device choice */

test('selectedSerial prefers the pinned device, else the first online one', () => {
  const adb = {
    devices: [
      { serial: 'A', state: 'offline' },
      { serial: 'B', state: 'device' },
      { serial: 'C', state: 'device' },
    ],
  };
  assert.equal(selectedSerial(adb, { preferredDeviceSerial: 'C' }), 'C');
  assert.equal(selectedSerial(adb, { preferredDeviceSerial: 'gone' }), 'B');
  assert.equal(selectedSerial(adb, {}), 'B');
  assert.equal(selectedSerial({ devices: [] }, {}), '');
});

test('the header chip says what is connected', () => {
  assert.equal(deviceChipLabel(ADB_OFF, null), 'No device');
  assert.equal(deviceChipLabel(ADB_ON, null), 'Pico 4');
  assert.equal(deviceChipLabel(ADB_ON, INFO), 'Pico 4 · 82%');
  assert.equal(deviceChipLabel({ devices: [{ serial: 'X', state: 'offline' }] }, null), '1 offline');
});

/* -------------------------------------------------------------- host:port */

test('parseHostPort defaults to 5555 and rejects nonsense', () => {
  assert.deepEqual(parseHostPort('192.168.1.42'), { ok: true, hostPort: '192.168.1.42:5555', error: '' });
  assert.equal(parseHostPort('192.168.1.42:5037').hostPort, '192.168.1.42:5037');
  assert.equal(parseHostPort('pico.local:5555').hostPort, 'pico.local:5555');
  assert.equal(parseHostPort('[fe80::1]:5555').hostPort, '[fe80::1]:5555');

  assert.match(parseHostPort('').error, /Enter the headset address/);
  assert.match(parseHostPort('192.168.1.42:99999').error, /not a valid port/);
  assert.match(parseHostPort('192.168.1.42:abc').error, /not a valid port/);
  assert.match(parseHostPort('has space:5555').error, /not a valid address/);
  assert.equal(parseHostPort('nonsense').ok, true, 'a bare hostname is fine');
});

/* ------------------------------------------------------------------ views */

test('the device chip reflects the connection state', () => {
  const on = renderDeviceChip(ADB_ON, INFO, {});
  assert.match(on, /dev-on/);
  assert.match(on, /data-act="devices"/);
  assert.match(on, /82%/);
  assert.match(renderDeviceChip(ADB_OFF, null, {}), /dev-none/);
  assert.match(renderDeviceChip(ADB_ON, { ...INFO, batteryPct: 12 }, {}), /batt-low/);
});

test('the device line is what an APK row shows before installing', () => {
  const line = renderDeviceLine(INFO, { title: 'target' });
  assert.match(line, /Pico 4 · 82% · 12\.4 GB free/);
  assert.match(line, /title="target"/);
  assert.equal(renderDeviceLine(null), '');
  assert.match(renderDeviceLine({ ...INFO, batteryPct: 9 }), /dev-line-low/);
});

test('apk rows carry the device summary only when a device is connected', () => {
  const app = normalizeApp({
    id: 'w',
    repo: 'o/w',
    name: 'W',
    latest: { version: '2.0.0' },
    artifacts: [{ id: 'apk-adb-android', label: 'APK', platform: 'android', kind: 'apk-adb' }],
  });
  const on = renderArtifactRow(app, app.artifacts[0], { adb: ADB_ON, deviceInfo: INFO });
  assert.match(on, /12\.4 GB free/);
  const off = renderArtifactRow(app, app.artifacts[0], { adb: ADB_OFF, deviceInfo: INFO });
  assert.ok(!off.includes('12.4 GB free'));
});

test('the devices sheet lists devices, wireless connect and the facts block', () => {
  const state = normalizeState({ adb: ADB_ON, settings: { preferredDeviceSerial: 'PA7X' } });
  const out = renderDevicesSheet(state, { info: INFO });
  assert.match(out, /data-act="select-device"[^>]*data-serial="PA7X"[^>]*checked/);
  assert.match(out, /data-act="adb-connect"/);
  assert.match(out, /data-field="adbHost"/);
  assert.match(out, /Free storage/);
  assert.match(out, /12\.4 GB/);
  assert.match(out, /data-act="device-info"/);

  const empty = renderDevicesSheet(normalizeState({ adb: ADB_OFF }), {});
  assert.match(empty, /No device\./);
  assert.match(empty, /USB debugging/);

  const err = renderDevicesSheet(state, { error: 'connection refused', host: '10.0.0.1' });
  assert.match(err, /field-error/);
  assert.match(err, /connection refused/);
  assert.match(err, /value="10\.0\.0\.1"/);
});

test('missing bridge methods remove their sections instead of breaking', () => {
  const state = normalizeState({ adb: ADB_ON });
  const out = renderDevicesSheet(state, { caps: { adbConnect: false, getDeviceInfo: false } });
  assert.ok(!out.includes('data-act="adb-connect"'));
  assert.ok(!out.includes('data-act="device-info"'));
  assert.match(out, /data-act="select-device"/, 'the list itself stays');
});

test('hostile device names cannot inject markup', () => {
  const state = normalizeState({
    adb: { connected: true, devices: [{ serial: '"><script>x</script>', model: '<img src=x>', state: 'device' }] },
  });
  const out = renderDevicesSheet(state, { info: { model: '<b>', serial: 'x' } });
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('<img src=x'));
});

/* ------------------------------------------------------------ mock bridge */

test('the mock connects, selects and reports devices', async () => {
  const { nxhub, dev } = createMock();
  const info = await nxhub.getDeviceInfo();
  assert.equal(info.model, 'Pico 4 Ultra');
  assert.ok(info.storageFreeBytes > 0);

  const bad = await nxhub.adbConnect('127.0.0.1:5555');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /connection refused/);

  const ok = await nxhub.adbConnect('192.168.1.42:5555');
  assert.equal(ok.ok, true);
  let state = normalizeState(await nxhub.getState());
  assert.ok(state.adb.devices.some((d) => d.serial === '192.168.1.42:5555'));

  await nxhub.adbSelectDevice('192.168.1.42:5555');
  state = normalizeState(await nxhub.getState());
  assert.equal(state.settings.preferredDeviceSerial, '192.168.1.42:5555');

  dev.toggleAdb();
  assert.equal(await nxhub.getDeviceInfo(), null, 'no device → no facts');
  dev.stop();
});

test('the fake-device dev button cycles through interesting states', async () => {
  const { nxhub, dev } = createMock();
  const seen = new Set();
  for (let i = 0; i < 3; i++) seen.add(dev.fakeDeviceInfo().batteryPct);
  assert.equal(seen.size, 3, 'each press lands on a different battery level');
  assert.ok([...seen].some((p) => p <= 20), 'a low-battery state is reachable');
  const info = await nxhub.getDeviceInfo();
  assert.ok(info && info.model);
  dev.stop();
});
