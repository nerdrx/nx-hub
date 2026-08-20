"use strict";
// The v0.5 half of the window.nxhub surface: the connector's clients reach the
// renderer through getState()/getConnector(), the stacks channels answer, and
// the on-disk client snapshot — the only thing an out-of-process `nx status`
// can read — is written, stamped and debounced.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const discovery = require("../../src/main/discovery");
const ipc = require("../../src/main/ipc");
const stacks = require("../../src/main/stacks");

const V05_METHODS = ["getConnector", "getStacks", "saveStack", "deleteStack", "runStack", "stopStack"];

/** Minimal ipcMain double — same shape as test/core/ipc-v02.test.js. */
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

function fakeConnector(clients = []) {
  const listeners = new Set();
  return {
    clients,
    listeners,
    getClients() {
      return this.clients;
    },
    isPresent(appId) {
      return this.clients.some((c) => c.app === appId);
    },
    requestShutdown() {
      return true;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fire() {
      for (const cb of listeners) cb();
    },
  };
}

function client(app, over = {}) {
  return Object.assign(
    { app, version: "1.2.1", pid: 4242, since: "2026-08-16T10:00:00Z", lastSeen: "2026-08-16T10:05:00Z", fields: {} },
    over
  );
}

/** Hermetic: a real phone on the developer's USB port must never leak in. */
function isolate(env) {
  config.save({ owners: ["nerdrx"], extraRepos: [], adbPath: path.join(env.root, "no-such-adb") });
}

function boot(t, { connector = null, jobs = null } = {}) {
  const env = helpers.useTempEnv();
  isolate(env);
  const ipcMain = fakeIpcMain();
  const events = [];
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });
  ipc.setConnector(connector, { snapshotDebounceMs: 10, snapshotHeartbeatMs: 0 });
  stacks._reset();
  stacks.init({ jobs: jobs || { async launch() { return { pid: 999 }; } }, connector, config, emit: (e) => events.push(e), timing: { pollMs: 10, shutdownWaitMs: 20 } });
  t.after(() => {
    ipc.setConnector(null);
    stacks._reset();
    discovery._setCached({ apps: [] });
    env.cleanup();
  });
  return { env, ipcMain, events };
}

/* ------------------------------------------------------------ surface */

test("preload exposes exactly the v0.5 methods the SPEC lists", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "preload.js"), "utf8");
  for (const name of V05_METHODS) {
    assert.match(src, new RegExp(`\\b${name}:\\s*\\(`), `preload.${name} missing`);
    assert.match(src, new RegExp(`nxhub:${name}`), `preload.${name} must invoke nxhub:${name}`);
  }
});

test("every v0.5 channel is registered, and works with no bus at all", async (t) => {
  const { ipcMain } = boot(t);

  for (const name of V05_METHODS) assert.ok(ipcMain.handlers.has(`nxhub:${name}`), `channel nxhub:${name} not registered`);

  // no connector module → an EMPTY client list, never a crash
  // v0.10 [fabric2]: `remote` joins it — every PEER's bus, empty with no fleet
  assert.deepStrictEqual(await ipcMain.invoke("nxhub:getConnector"), { clients: [], remote: [] });
  const state = await ipcMain.invoke("nxhub:getState");
  assert.deepStrictEqual(state.connector, { clients: [], remote: [] }, "getState().connector is always present");
  assert.deepStrictEqual(await ipcMain.invoke("nxhub:getStacks"), []);
});

test("getState()/getConnector() report whoever is on the bus", async (t) => {
  const connector = fakeConnector([client("pulsenx", { fields: { hr: 72, connected: true } })]);
  const { ipcMain } = boot(t, { connector });

  const { clients } = await ipcMain.invoke("nxhub:getConnector");
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].app, "pulsenx");
  assert.deepStrictEqual(clients[0].fields, { hr: 72, connected: true });

  const state = await ipcMain.invoke("nxhub:getState");
  assert.deepStrictEqual(state.connector.clients[0].app, "pulsenx");

  // a bus that throws on getClients() must not take getState() down with it
  connector.getClients = () => {
    throw new Error("socket exploded");
  };
  assert.deepStrictEqual((await ipcMain.invoke("nxhub:getState")).connector, { clients: [], remote: [] });
});

test("v0.10 — getState().connector.remote carries every PEER's bus", async (t) => {
  const connector = fakeConnector([client("wivrn-nx", { fields: { fps: 90 } })]);
  const { ipcMain } = boot(t, { connector });

  // A real fleet on loopback + an ephemeral port (the user's own hub owns
  // :9023 on this machine), with a roster planted where a peer's would land.
  const fleet = require("../../src/main/fleet");
  const handle = fleet.init({
    dataDir: path.join(helpers.tempDir("nxhub-fleet-ipc-"), "data"),
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    connector: null,
    stacks: null,
    syncConfig: { load: () => ({ fleetSync: false }) },
  });
  await handle.ready;
  t.after(() => fleet.close());

  handle.rosters.set("peer-1", {
    peerId: "peer-1",
    peerName: "Workshop PC",
    clients: [{ app: "pulsenx", version: "2.0.0", since: 1, fields: { hr: 72 }, history: { hr: [{ ts: 1, v: 72 }] } }],
    at: Date.now(),
  });

  const state = await ipcMain.invoke("nxhub:getState");
  assert.deepStrictEqual(state.connector.clients.map((c) => c.app), ["wivrn-nx"], "the LOCAL bus is unchanged");
  assert.deepStrictEqual(state.connector.remote, [
    {
      peerId: "peer-1",
      peerName: "Workshop PC",
      clients: [{ app: "pulsenx", version: "2.0.0", since: 1, fields: { hr: 72 }, history: { hr: [{ ts: 1, v: 72 }] } }],
    },
  ]);
  // getConnector() answers with exactly the same block
  assert.deepStrictEqual(await ipcMain.invoke("nxhub:getConnector"), state.connector);

  // …and a fleet that throws is [] rather than a broken getState()
  const broken = handle.getRemoteClients;
  handle.getRemoteClients = () => {
    throw new Error("fleet exploded");
  };
  assert.deepStrictEqual(ipc.remoteClients(), []);
  handle.getRemoteClients = broken;

  await fleet.close();
  assert.deepStrictEqual(ipc.remoteClients(), [], "a hub with no fleet reports no peers, never undefined");
});

/* ------------------------------------------------------------- stacks */

test("the stack channels save, list, run and delete", async (t) => {
  const launched = [];
  const { ipcMain, events } = boot(t, {
    jobs: {
      async launch(appId, artifactId) {
        launched.push([appId, artifactId || null]);
        return { pid: 1234 };
      },
    },
  });

  const saved = await ipcMain.invoke("nxhub:saveStack", {
    id: "VR Session",
    name: "VR Session",
    steps: [{ appId: "wivrn-nx", health: { type: "delay", timeoutMs: 0 } }, { appId: "junk-step" }],
  });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.stack.id, "vr-session", "ids are slugified before they are stored");
  assert.strictEqual(saved.stacks.length, 1);

  const list = await ipcMain.invoke("nxhub:getStacks");
  assert.deepStrictEqual(list.map((s) => s.id), ["vr-session"]);

  // runStack returns immediately — a run outlives any IPC round trip
  const started = await ipcMain.invoke("nxhub:runStack", "vr-session");
  assert.deepStrictEqual(started, { started: true, stackId: "vr-session" });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(launched, [["wivrn-nx", null], ["junk-step", null]]);
  assert.ok(events.some((e) => e.type === "stack-progress" && e.phase === "done"));

  const stopped = await ipcMain.invoke("nxhub:stopStack", "vr-session");
  assert.strictEqual(stopped.ok, true);

  const removed = await ipcMain.invoke("nxhub:deleteStack", "vr-session");
  assert.deepStrictEqual(removed, { ok: true, stacks: [] });
});

test("saveStack rejects junk and runStack refuses a second run", async (t) => {
  const { ipcMain } = boot(t);
  await assert.rejects(() => ipcMain.invoke("nxhub:saveStack", { name: "  ", steps: [] }), /id or a name/);

  await ipcMain.invoke("nxhub:saveStack", { id: "slow", name: "Slow", steps: [{ appId: "a", health: { type: "delay", timeoutMs: 400 } }] });
  await ipcMain.invoke("nxhub:runStack", "slow");
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => ipcMain.invoke("nxhub:runStack", "slow"), /still running/);
  await ipcMain.invoke("nxhub:stopStack", "slow");
});

/* ----------------------------------------------------------- snapshot */

test("the connector snapshot is written, stamped and debounced", async (t) => {
  const connector = fakeConnector([client("pulsenx")]);
  const { env } = boot(t, { connector });
  const file = path.join(env.dataDir, "connector-clients.json");

  // setConnector writes once immediately: "the hub is up" is itself news
  assert.ok(fs.existsSync(file));
  assert.strictEqual(ipc.connectorSnapshotPath(), file);
  const first = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(first.clients[0].app, "pulsenx");
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);

  // a burst of bus changes collapses into ONE write
  connector.clients = [client("pulsenx"), client("wivrn-nx")];
  for (let i = 0; i < 20; i += 1) connector.fire();
  await new Promise((r) => setTimeout(r, 40));
  const second = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(second.clients.map((c) => c.app), ["pulsenx", "wivrn-nx"]);

  const fresh = ipc.readConnectorSnapshot();
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.exists, true);
  assert.ok(fresh.ageMs < 5000);

  // an old snapshot means "the hub is not running any more"
  fs.writeFileSync(file, JSON.stringify({ ts: "2020-01-01T00:00:00Z", clients: [client("ghost")] }));
  const stale = ipc.readConnectorSnapshot(120000);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.clients.length, 1, "the clients are still readable — just not trustworthy");

  // and a missing/garbled one never throws
  fs.writeFileSync(file, "{not json");
  const broken = ipc.readConnectorSnapshot();
  assert.deepStrictEqual(broken.clients, []);
  assert.strictEqual(broken.stale, true);
  fs.rmSync(file);
  assert.strictEqual(ipc.readConnectorSnapshot().exists, false);
});

test("setConnector unsubscribes the previous bus", async (t) => {
  const first = fakeConnector([client("a")]);
  const second = fakeConnector([client("b")]);
  const { env } = boot(t, { connector: first });
  const file = path.join(env.dataDir, "connector-clients.json");

  ipc.setConnector(second, { snapshotDebounceMs: 5, snapshotHeartbeatMs: 0 });
  assert.strictEqual(first.listeners.size, 0, "the old bus has no listener left");

  first.clients = [client("zombie")];
  first.fire();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).clients.map((c) => c.app), ["b"]);
});

/* --------------------------------------------------------------- tray */

test("live tray/card suffixes follow the overlay's connector fields", (t) => {
  const connector = fakeConnector([client("pulsenx", { fields: { hr: 72, connected: true } }), client("wivrn-nx", { fields: { fps: 90 } })]);
  boot(t, { connector });

  discovery._setCached({
    apps: [
      { id: "pulsenx", repo: "nerdrx/PulseNX", name: "PulseNX", artifacts: [] },
      { id: "wivrn-nx", repo: "nerdrx/wivrn-nx", name: "WiVRn NX", artifacts: [] },
      { id: "quadforge", repo: "nerdrx/quadforge", name: "QuadForge", artifacts: [] },
    ],
    overlay: {
      hidden: [],
      apps: {
        pulsenx: {
          connector: {
            fields: [
              { key: "hr", label: "Heart rate", unit: "bpm", kind: "number" },
              { key: "connected", label: "Band", kind: "bool" },
            ],
          },
        },
      },
    },
  });

  assert.strictEqual(ipc.liveSuffix("pulsenx"), " · 72 bpm · on", "SPEC tray line: 'PulseNX · 72 bpm'");
  assert.strictEqual(ipc.liveSuffix("wivrn-nx"), " · fps: 90", "no field definitions → generic key: value");
  assert.strictEqual(ipc.liveSuffix("quadforge"), "", "not on the bus → no suffix at all");

  // presence with nothing to say still marks the app as live
  connector.clients = [client("quadforge")];
  assert.strictEqual(ipc.liveSuffix("quadforge"), " ·");

  // pure formatting, independent of any bus
  assert.strictEqual(ipc.formatFields([{ key: "hr", unit: "bpm" }], { hr: 72 }), "72 bpm");
  assert.strictEqual(ipc.formatFields([{ key: "on", kind: "bool" }], { on: false }), "off");
  assert.strictEqual(ipc.formatFields([{ key: "missing" }], {}), "");
  assert.strictEqual(ipc.formatFields(null, null), "");
  assert.strictEqual(
    ipc.formatFields([{ key: "a" }, { key: "b" }, { key: "c" }], { a: 1, b: 2, c: 3 }),
    "1 · 2",
    "a tray line, not a dashboard"
  );
});

test("launchables carry the live suffix for the tray", (t) => {
  const connector = fakeConnector([client("quadforge", { fields: { jobs: 2 } })]);
  boot(t, { connector });

  discovery._setCached({
    apps: [
      { id: "quadforge", repo: "nerdrx/quadforge", name: "QuadForge", artifacts: [{ id: "zip-linux", label: "Addon", launchable: true }] },
    ],
    overlay: { hidden: [], apps: {} },
  });
  require("../../src/main/state").recordInstall("quadforge", "zip-linux", { version: "1.3", path: "/tmp/qf" });

  const entries = ipc.launchables();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].appName, "QuadForge");
  assert.strictEqual(entries[0].live, " · jobs: 2");
});
