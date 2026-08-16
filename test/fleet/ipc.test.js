"use strict";
// The v0.6 half of the window.nxhub surface: the fleet channels answer, the
// `fleet` setting exists and sanitises, and getFleet() has one shape whether
// or not a fleet is actually running.
//
// This file drives ipc.js the way the renderer does — through a fake ipcMain —
// and never opens a window or a socket of its own.

const test = require("node:test");
const assert = require("node:assert");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NX_HUB_QUIET = process.env.NX_HUB_QUIET || "1";
process.env.NX_HUB_NO_FILE_LOG = process.env.NX_HUB_NO_FILE_LOG || "1";
process.env.NX_HUB_NO_GH = "1";

const config = require("../../src/main/config");
const ipc = require("../../src/main/ipc");
const fleet = require("../../src/main/fleet");
const h = require("./helpers");

const FLEET_CHANNELS = [
  "nxhub:getFleet",
  "nxhub:fleetShowCode",
  "nxhub:fleetPair",
  "nxhub:fleetUnpair",
  "nxhub:fleetInstall",
  "nxhub:fleetLaunch",
  "nxhub:fleetUpdateAll",
  "nxhub:fleetWake", // v0.7
];

/** Minimal ipcMain double — same shape as test/core's. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

/** A temp NX_HUB_DATA_DIR for one test, restored afterwards. */
function useTempDataDir() {
  const before = process.env.NX_HUB_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-fleet-ipc-"));
  process.env.NX_HUB_DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      if (before === undefined) delete process.env.NX_HUB_DATA_DIR;
      else process.env.NX_HUB_DATA_DIR = before;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

test.after(async () => {
  await fleet.close();
  await h.stopAll();
  h.cleanupTempDirs();
});

/* ------------------------------------------------------------------ */
/* the setting                                                         */
/* ------------------------------------------------------------------ */

test("settings gain `fleet`, defaulting to true and sanitising like the others", (t) => {
  const env = useTempDataDir();
  t.after(() => env.cleanup());

  assert.strictEqual(config.defaults().fleet, true);
  assert.strictEqual(config.load().fleet, true, "a hub with no settings file is in the fleet");
  assert.strictEqual(config.sanitize({}).fleet, true);
  assert.strictEqual(config.sanitize({ fleet: false }).fleet, false);
  assert.strictEqual(config.sanitize({ fleet: "false" }).fleet, false, "string booleans are accepted");
  assert.strictEqual(config.sanitize({ fleet: "true" }).fleet, true);
  assert.strictEqual(config.sanitize({ fleet: 17 }).fleet, true, "junk falls back to the default");

  assert.strictEqual(config.save({ fleet: false }).fleet, false);
  assert.strictEqual(config.load().fleet, false, "it survives a reload");
});

test("`fleet` round-trips through export/import like every other boolean", (t) => {
  const env = useTempDataDir();
  t.after(() => env.cleanup());
  config.save({ fleet: false });
  const exported = config.exportSettings();
  assert.match(exported, /"fleet": false/);

  config.save({ fleet: true });
  const result = config.importSettings(exported);
  assert.ok(result.applied.includes("fleet"));
  assert.strictEqual(config.load().fleet, false);
});

/* ------------------------------------------------------------------ */
/* the IPC surface                                                     */
/* ------------------------------------------------------------------ */

test("init() registers every v0.6 fleet channel", (t) => {
  const env = useTempDataDir();
  t.after(() => env.cleanup());
  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain });
  for (const channel of FLEET_CHANNELS) {
    assert.ok(ipcMain.handlers.has(channel), `${channel} is not registered`);
  }
});

test("getFleet() has the same shape with no fleet running", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });
  await fleet.close(); // make sure nothing from another test is live

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain });
  const state = await ipcMain.invoke("nxhub:getFleet");

  assert.strictEqual(state.enabled, true, "the setting is on…");
  assert.strictEqual(state.running, false, "…but nothing started it in a unit test");
  assert.deepStrictEqual(state.peers, []);
  assert.strictEqual(state.pairing, null);
  assert.strictEqual(state.id, null);
  assert.strictEqual(typeof state.hubVersion, "string");
});

test("getFleet() reports the setting being off without pretending to run", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });
  await fleet.close();
  config.save({ fleet: false });

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain });
  const state = await ipcMain.invoke("nxhub:getFleet");
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.running, false);
  assert.deepStrictEqual(state.peers, []);
});

test("getFleet() surfaces a live fleet: identity, port, peers and the pairing window", async (t) => {
  const env = useTempDataDir();
  const events = [];
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });

  const handle = fleet.init({
    config,
    dataDir: env.dir,
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    hubVersion: "0.6.0",
    discovery: h.fakeDiscovery([h.app("wivrn-nx", { artifacts: [{ id: "linux", installed: { version: "0.6.0" } }] })]),
    emit: (e) => events.push(e),
  });
  await handle.ready;

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain });

  const before = await ipcMain.invoke("nxhub:getFleet");
  assert.strictEqual(before.running, true);
  assert.match(before.id, /^[0-9a-f]{16}$/);
  assert.strictEqual(before.port, handle.server.port);
  assert.deepStrictEqual(before.peers, []);
  assert.strictEqual(before.pairing, null);
  assert.strictEqual(before.summary.apps[0].id, "wivrn-nx", "the hub reports what IT would push");

  // fleetShowCode arms the window and the code also goes out as an event.
  const armed = await ipcMain.invoke("nxhub:fleetShowCode");
  assert.match(armed.code, /^[0-9]{6}$/);
  assert.ok(armed.expiresAt > Date.now());
  assert.ok(events.some((e) => e.type === "fleet-pair-code" && e.code === armed.code));

  const after = await ipcMain.invoke("nxhub:getFleet");
  assert.deepStrictEqual(after.pairing, { code: armed.code, expiresAt: armed.expiresAt });
});

test("fleetPair / getFleet / fleetUnpair drive a real peer through the IPC channels", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    await h.stopAll();
    env.cleanup();
  });

  // The "other machine" is an ordinary fleet instance on loopback.
  const other = await h.startFleet({
    discovery: h.fakeDiscovery([h.app("pulsenx", { artifacts: [{ id: "linux", updateAvailable: true }] })]),
    jobs: h.fakeJobs(),
  });

  const handle = fleet.init({
    config,
    dataDir: env.dir,
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    hubVersion: "0.6.0",
    discovery: h.fakeDiscovery([]),
    emit: () => {},
    summaryIntervalMs: 25,
    dialIntervalMs: 25,
  });
  await handle.ready;

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain });

  const { code } = other.showCode();
  const paired = await ipcMain.invoke("nxhub:fleetPair", "127.0.0.1", code, other.server.port);
  assert.strictEqual(paired.ok, true);
  assert.strictEqual(paired.peer.id, other.localId);
  assert.strictEqual(paired.fleet.peers.length, 1);

  const peer = await h.waitUntil(
    async () => {
      const state = await ipcMain.invoke("nxhub:getFleet");
      const p = state.peers[0];
      return p && p.summary ? p : false;
    },
    4000,
    "the peer's summary over IPC"
  );
  assert.strictEqual(peer.online, true);
  assert.strictEqual(peer.connected, true);
  assert.strictEqual(peer.updates, 1);
  assert.strictEqual(peer.summary.apps[0].id, "pulsenx");
  assert.ok(!("secret" in peer), "the renderer never sees a peer's secret");

  const install = await ipcMain.invoke("nxhub:fleetInstall", other.localId, "pulsenx", "linux");
  assert.strictEqual(install.ok, true);
  assert.strictEqual(install.jobId, "job-1");

  const removed = await ipcMain.invoke("nxhub:fleetUnpair", other.localId);
  assert.strictEqual(removed.ok, true);
  assert.deepStrictEqual(removed.fleet.peers, []);
});

test("the fleet channels fail loudly, not silently, when the fleet is off", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });
  await fleet.close();

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null });
  await assert.rejects(() => ipcMain.invoke("nxhub:fleetShowCode"), /switched off/);
  await assert.rejects(() => ipcMain.invoke("nxhub:fleetPair", "127.0.0.1", "123456"), /switched off/);
  await assert.rejects(() => ipcMain.invoke("nxhub:fleetInstall", "x", "y"), /switched off/);
  // unpair is the one that stays quiet: forgetting a peer we do not have is
  // not a failure the user needs to hear about.
  assert.deepStrictEqual(await ipcMain.invoke("nxhub:fleetUnpair", "x"), {
    ok: false,
    fleet: (await ipcMain.invoke("nxhub:getFleet")),
  });
});

test("the preload surface exposes exactly the fleet methods the SPEC names", () => {
  // preload.js requires electron, so the contract is checked as source: it is
  // the one file the renderer's whole fleet UI depends on.
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "preload.js"), "utf8");
  for (const [method, channel] of [
    ["getFleet", "nxhub:getFleet"],
    ["fleetShowCode", "nxhub:fleetShowCode"],
    ["fleetPair", "nxhub:fleetPair"],
    ["fleetUnpair", "nxhub:fleetUnpair"],
    ["fleetInstall", "nxhub:fleetInstall"],
    ["fleetLaunch", "nxhub:fleetLaunch"],
    ["fleetUpdateAll", "nxhub:fleetUpdateAll"],
    ["fleetWake", "nxhub:fleetWake"], // v0.7
  ]) {
    assert.match(source, new RegExp(`\\b${method}:`), `preload is missing ${method}`);
    assert.ok(source.includes(`"${channel}"`), `preload does not invoke ${channel}`);
  }
});

/* ------------------------------------------------------------------ */
/* v0.7: fleetWake                                                     */
/* ------------------------------------------------------------------ */

test("fleetWake reports no-mac rather than pretending it woke something", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });
  await fleet.close();

  const hub = fleet.init({
    dataDir: env.dir,
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    log: () => {},
    emit: () => {},
  });
  await hub.ready;
  const peer = await h.startFleet();
  await h.pairHubs(hub, peer);

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null });
  const result = await ipcMain.invoke("nxhub:fleetWake", peer.store.load().id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, "no-mac", "no session ever taught this hub a hardware address");
});

test("fleetWake with a stored MAC sends, and reports what it sent", async (t) => {
  const env = useTempDataDir();
  t.after(async () => {
    await fleet.close();
    env.cleanup();
  });
  await fleet.close();

  const sink = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const packets = [];
  sink.on("message", (m) => packets.push(Buffer.from(m)));
  const port = await new Promise((r) => sink.bind(0, "127.0.0.1", () => r(sink.address().port)));
  t.after(() => sink.close());

  const hub = fleet.init({
    dataDir: env.dir,
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    // Loopback and an ephemeral port: nothing broadcasts out of this test.
    wolAddress: "127.0.0.1",
    wolPorts: [port],
    log: () => {},
    emit: () => {},
  });
  await hub.ready;
  const peer = await h.startFleet();
  await h.pairHubs(hub, peer);
  const peerId = peer.store.load().id;
  hub.store.touchPeer(peerId, { mac: "aa:bb:cc:dd:ee:ff" });

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null });
  const result = await ipcMain.invoke("nxhub:fleetWake", peerId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.mac, "aa:bb:cc:dd:ee:ff");

  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(packets.length, 3, "SPEC: three magic packets");
  assert.strictEqual(packets[0].length, 102);
});

test("fleetWake on a switched-off fleet is a quiet false, not a throw", async (t) => {
  const env = useTempDataDir();
  t.after(() => env.cleanup());
  await fleet.close();

  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null });
  const result = await ipcMain.invoke("nxhub:fleetWake", "0123456789abcdef");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.sent, false);
});
