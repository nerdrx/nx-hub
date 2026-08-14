"use strict";
// v0.2 adb: `adb connect`, the preferred device serial, and getDeviceInfo
// (battery + storage). No real adb is ever invoked — a fake script replays
// canned output from the sandbox.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const adb = require("../../src/main/install/adb");
const H = require("./helpers");

const TWO_DEVICES = `List of devices attached
1WMHH8K1234567         device product:phoenix model:Pico_4 device:phoenix transport_id:3
192.168.1.50:5555      device product:quest model:Quest_3 device:eureka transport_id:4
emulator-5554          offline
`;

const BATTERY = `Current Battery Service state:
  AC powered: false
  USB powered: true
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  temperature: 291
`;

const DF_DATA = `Filesystem      1K-blocks     Used Available Use% Mounted on
/dev/block/dm-5 110000000 50000000  58720256  46% /data
`;

/** Fake adb whose behaviour is assembled from case branches. */
async function fakeAdb(box, body) {
  const fake = await H.writeFakeAdb(box, body);
  return fake;
}

function ctxFor(box, fake, settings = {}) {
  return H.makeCtx(box, { settings: Object.assign({ adbPath: fake.path }, settings) });
}

/* ---------------- adb connect ---------------- */

test("normalizeHostPort fills in the default port and rejects nonsense", () => {
  assert.strictEqual(adb.normalizeHostPort("192.168.1.50"), "192.168.1.50:5555");
  assert.strictEqual(adb.normalizeHostPort(" 192.168.1.50:4444 "), "192.168.1.50:4444");
  assert.strictEqual(adb.normalizeHostPort("adb connect 10.0.0.7"), "10.0.0.7:5555");
  assert.strictEqual(adb.normalizeHostPort("headset.local"), "headset.local:5555");
  assert.strictEqual(adb.normalizeHostPort(""), null);
  assert.strictEqual(adb.normalizeHostPort("rm -rf /"), null);
});

test("adbConnect reports success, an already-open connection, and friendly failures", async (t) => {
  const box = await H.makeSandbox("adb-connect");
  t.after(() => H.cleanup(box));

  const ok = await fakeAdb(
    box,
    `case "$*" in
  "connect 192.168.1.50:5555") echo "connected to 192.168.1.50:5555" ;;
  "connect 10.0.0.7:5555") echo "already connected to 10.0.0.7:5555" ;;
  "connect 172.16.0.9:5555") echo "failed to connect to '172.16.0.9:5555': Connection refused" ;;
  "connect 172.16.0.10:5555") echo "failed to connect to '172.16.0.10:5555': No route to host" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`
  );
  const ctx = ctxFor(box, ok);

  const connected = await engine.adbConnect(ctx, "192.168.1.50");
  assert.strictEqual(connected.connected, true);
  assert.strictEqual(connected.alreadyConnected, false);
  assert.strictEqual(connected.target, "192.168.1.50:5555");
  assert.match(connected.message, /Connected to 192\.168\.1\.50:5555/);

  const again = await engine.adbConnect(ctx, "10.0.0.7:5555");
  assert.strictEqual(again.connected, true);
  assert.strictEqual(again.alreadyConnected, true);

  await assert.rejects(() => engine.adbConnect(ctx, "172.16.0.9"), /refused the connection.*wireless debugging/is);
  await assert.rejects(() => engine.adbConnect(ctx, "172.16.0.10"), /Could not reach 172\.16\.0\.10:5555/i);
  await assert.rejects(() => engine.adbConnect(ctx, "  "), /ip:port/i);

  assert.ok(
    ok.calls().some((c) => c === "connect 192.168.1.50:5555"),
    "adb connect was called with the normalised address"
  );
});

test("adbConnect explains a missing adb binary instead of throwing ENOENT", async (t) => {
  const box = await H.makeSandbox("adb-connect-missing");
  t.after(() => H.cleanup(box));
  const ctx = H.makeCtx(box, { settings: { adbPath: path.join(box.bin, "not-adb") } });
  await assert.rejects(() => engine.adbConnect(ctx, "192.168.1.50"), /adb not found/i);
});

/* ---------------- device selection ---------------- */

test("the preferred serial wins when it is online, with a graceful fallback", async (t) => {
  const box = await H.makeSandbox("adb-select");
  t.after(() => H.cleanup(box));

  const fake = await fakeAdb(
    box,
    `case "$*" in
  "devices -l") cat <<'EOF'
${TWO_DEVICES}EOF
    ;;
  *"shell dumpsys package "*) echo "  versionName=1.4.0" ;;
  *) echo "" ;;
esac`
  );

  const devices = adb.parseDevices(TWO_DEVICES);
  assert.strictEqual(adb.selectDevice(devices, { settings: {} }).serial, "1WMHH8K1234567", "first online by default");
  assert.strictEqual(
    adb.selectDevice(devices, { settings: { preferredDeviceSerial: "192.168.1.50:5555" } }).serial,
    "192.168.1.50:5555",
    "the preferred device is used"
  );
  const fallbackCtx = { settings: { preferredDeviceSerial: "GONE123" }, log: () => {} };
  assert.strictEqual(adb.selectDevice(devices, fallbackCtx).serial, "1WMHH8K1234567", "offline preference falls back");
  assert.strictEqual(adb.selectDevice([{ serial: "x", state: "offline" }], { settings: {} }), null);

  // requireDevice and getAdbStatus both honour it
  const ctx = ctxFor(box, fake, { preferredDeviceSerial: "192.168.1.50:5555" });
  const device = await adb.requireDevice(ctx);
  assert.strictEqual(device.serial, "192.168.1.50:5555");
  assert.strictEqual(device.model, "Quest 3");

  const status = await engine.getAdbStatus(ctx);
  assert.strictEqual(status.selected, "192.168.1.50:5555");
  assert.strictEqual(status.devices.length, 3);
  assert.ok(
    fake.calls().some((c) => c.startsWith("-s 192.168.1.50:5555 shell dumpsys package")),
    "package versions are read from the selected device"
  );
});

/* ---------------- device info ---------------- */

test("parsers: battery level and df output (1K blocks and human sizes)", () => {
  assert.strictEqual(adb.parseBatteryLevel(BATTERY), 87);
  assert.strictEqual(adb.parseBatteryLevel("level: 100\n"), 100);
  assert.strictEqual(adb.parseBatteryLevel("nothing useful here"), null);
  assert.strictEqual(adb.parseBatteryLevel(""), null);

  assert.strictEqual(adb.parseDfAvailable(DF_DATA), 58720256 * 1024);
  assert.strictEqual(
    adb.parseDfAvailable(`Filesystem  Size Used Avail Use% Mounted on\n/dev/block/dm-5  110G  50G  56G  46% /data\n`),
    56 * 1024 ** 3
  );
  // long device names wrap onto their own line
  assert.strictEqual(
    adb.parseDfAvailable(
      `Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/mapper/very-long-name\n  110000000 50000000  1000  46% /data\n`
    ),
    1000 * 1024
  );
  assert.strictEqual(adb.parseDfAvailable("df: /data: No such file or directory"), null);
  assert.strictEqual(adb.parseSizeToken("2.5G"), Math.round(2.5 * 1024 ** 3));
  assert.strictEqual(adb.parseSizeToken("junk"), null);
});

test("getDeviceInfo returns serial/model/battery/storage for the selected device", async (t) => {
  const box = await H.makeSandbox("adb-info");
  t.after(() => H.cleanup(box));

  const fake = await fakeAdb(
    box,
    `case "$*" in
  "devices -l") cat <<'EOF'
${TWO_DEVICES}EOF
    ;;
  *"shell dumpsys battery") cat <<'EOF'
${BATTERY}EOF
    ;;
  *"shell df /data") cat <<'EOF'
${DF_DATA}EOF
    ;;
  *) echo "" ;;
esac`
  );

  const info = await engine.getDeviceInfo(ctxFor(box, fake));
  assert.strictEqual(info.serial, "1WMHH8K1234567");
  assert.strictEqual(info.model, "Pico 4");
  assert.strictEqual(info.batteryPct, 87);
  assert.strictEqual(info.storageFreeBytes, 58720256 * 1024);
  assert.strictEqual(info.available, true);

  // the preferred device is the one we report on
  const preferred = await engine.getDeviceInfo(ctxFor(box, fake, { preferredDeviceSerial: "192.168.1.50:5555" }));
  assert.strictEqual(preferred.serial, "192.168.1.50:5555");
  assert.strictEqual(preferred.model, "Quest 3");
});

test("getDeviceInfo nulls out what it cannot read and never throws", async (t) => {
  const box = await H.makeSandbox("adb-info-partial");
  t.after(() => H.cleanup(box));

  // battery works, df fails on /data and /sdcard
  const partial = await fakeAdb(
    box,
    `case "$*" in
  "devices -l") cat <<'EOF'
${TWO_DEVICES}EOF
    ;;
  *"shell dumpsys battery") cat <<'EOF'
${BATTERY}EOF
    ;;
  *"shell df "*) echo "df: permission denied" >&2; exit 1 ;;
  *) echo "" ;;
esac`
  );
  const info = await engine.getDeviceInfo(ctxFor(box, partial));
  assert.strictEqual(info.batteryPct, 87);
  assert.strictEqual(info.storageFreeBytes, null, "unreadable storage is null, not an error");

  // no device connected at all
  const empty = await fakeAdb(box, `case "$*" in\n  "devices -l") echo "List of devices attached" ;;\n  *) echo "" ;;\nesac`);
  const none = await engine.getDeviceInfo(ctxFor(box, empty));
  assert.deepStrictEqual(none, {
    serial: null,
    model: null,
    batteryPct: null,
    storageFreeBytes: null,
    available: true,
    state: null,
  });

  // adb not installed
  const missing = await engine.getDeviceInfo(H.makeCtx(box, { settings: { adbPath: path.join(box.bin, "nope") } }));
  assert.strictEqual(missing.available, false);
  assert.strictEqual(missing.serial, null);
});

test("df falls back to /sdcard when /data is not readable", async (t) => {
  const box = await H.makeSandbox("adb-df-fallback");
  t.after(() => H.cleanup(box));

  const fake = await fakeAdb(
    box,
    `case "$*" in
  "devices -l") cat <<'EOF'
${TWO_DEVICES}EOF
    ;;
  *"shell df /data") exit 1 ;;
  *"shell df /sdcard") echo "Filesystem 1K-blocks Used Available Use% Mounted on"; echo "/dev/fuse 100000 1000 2048 2% /sdcard" ;;
  *) echo "" ;;
esac`
  );
  const info = await engine.getDeviceInfo(ctxFor(box, fake));
  assert.strictEqual(info.storageFreeBytes, 2048 * 1024);
  assert.ok(fake.calls().some((c) => c.includes("df /sdcard")));
});
