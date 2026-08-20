"use strict";
// Shared harness for the fleet tests.
//
// Everything binds 127.0.0.1 on an EPHEMERAL port — the user's real hub owns
// :9022 and :9023 on this machine and the tests must never go near them. The
// beacon is off by default; the beacon tests opt in with loopback unicast on
// two ephemeral ports, which exercises exactly the same code path as a real
// broadcast without putting a datagram on the wire.
// (Not a test file — exports helpers only.)

const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NX_HUB_QUIET = process.env.NX_HUB_QUIET || "1";
process.env.NX_HUB_NO_FILE_LOG = process.env.NX_HUB_NO_FILE_LOG || "1";

const fleet = require("../../src/main/fleet");
const protocol = require("../../src/main/fleet/protocol");
const store = require("../../src/main/fleet/store");
const client = require("../../src/main/fleet/client");
const wire = require("../../src/main/fleet/wire");
const realConfig = require("../../src/main/config");
const realStacks = require("../../src/main/stacks");

const tempDirs = [];
const running = [];

function tempDataDir(prefix = "nxhub-fleet-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

async function stopAll() {
  while (running.length) {
    const hub = running.pop();
    try {
      await hub.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** A discovery stand-in: just the cached app model the summary is built from. */
function fakeDiscovery(apps = []) {
  const state = { apps: apps.slice() };
  return {
    getCached: () => state,
    _set(next) {
      state.apps = next.slice();
    },
  };
}

/**
 * A jobs stand-in that records what a peer asked this hub to do.
 *
 * `_tracked` mirrors the real jobs.js launch table (pid → {appId, pid, …}),
 * which is where a v0.7 remote `stop` finds the process to signal.
 */
function fakeJobs({ tracked = [] } = {}) {
  const calls = [];
  let counter = 0;
  const table = new Map();
  for (const entry of tracked) table.set(entry.pid, entry);
  return {
    calls,
    _tracked: table,
    install(appId, artifactId) {
      counter += 1;
      const jobId = `job-${counter}`;
      calls.push({ kind: "install", appId, artifactId, jobId });
      return jobId;
    },
    async launch(appId, artifactId) {
      calls.push({ kind: "launch", appId, artifactId });
      return true;
    },
  };
}

/**
 * A connector-bus stand-in for the polite half of a remote stop.
 * `present` is a live set — a test drops an app from it to play "it left".
 */
function fakeConnector({ present = [], honourShutdown = true } = {}) {
  const live = new Set(present);
  const calls = [];
  return {
    calls,
    live,
    isPresent: (appId) => live.has(appId),
    requestShutdown(appId) {
      calls.push(appId);
      if (!honourShutdown) return false;
      live.delete(appId); // the app took the hint
      return true;
    },
  };
}

/* ---------------------------------------------------------------- v0.10 */

/**
 * A connector bus stand-in for bus federation: a mutable client list plus the
 * module-level `onChange` the real bus exposes, so a test can make the roster
 * move and watch it cross the wire.
 */
function fakeBus({ clients = [] } = {}) {
  const listeners = new Set();
  const bus = {
    clients: clients.slice(),
    calls: [],
    getClients(opts) {
      bus.calls.push(opts || null);
      return bus.clients.map((c) => Object.assign({}, c));
    },
    onChange(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Replace the roster and tell everyone, exactly as the real bus does. */
    set(next) {
      bus.clients = next.slice();
      for (const cb of [...listeners]) cb();
    },
  };
  return bus;
}

/** One connector client in the shape connector/server.getClients() returns. */
function busClient(app, { version = "1.0.0", fields = {}, history = {}, since = Date.now() } = {}) {
  return { app, version, pid: 1234, since, lastSeen: Date.now(), fields, caps: [], history };
}

/**
 * Settings + stacks for ONE hub, in ONE directory.
 *
 * The fleet's settings sync reads and WRITES the hub's real settings.json and
 * stacks.json, and the machine running these tests has a real hub on it — so
 * every test drives sync through this facade instead. It is not a mock of the
 * logic: the sanitisers, the merge and the stamping are the real modules'
 * (`config.sanitize`, `config.mergeAppPref`, `stacks.sanitizeStack`), only the
 * file path is the test's.
 */
function syncEnv(dir) {
  const settingsFile = path.join(dir, "settings.json");
  const stacksFile = path.join(dir, "stacks.json");
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return fallback;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  const config = {
    file: settingsFile,
    load: () => realConfig.sanitize(readJson(settingsFile, {})),
    save(patch) {
      const next = realConfig.sanitize(Object.assign(config.load(), patch && typeof patch === "object" ? patch : {}));
      writeJson(settingsFile, next);
      return next;
    },
    sanitizeAppPrefs: (raw) => realConfig.sanitizeAppPrefs(raw),
    /** config.setAppPref's contract, including the v0.10 `_ts` stamp. */
    setAppPref(appId, patch, at) {
      const id = String(appId).toLowerCase();
      const prefs = Object.assign({}, config.load().appPrefs);
      const merged = realConfig.mergeAppPref(prefs[id], patch);
      merged._ts = at == null ? Date.now() : at;
      prefs[id] = merged;
      return config.save({ appPrefs: prefs });
    },
  };

  const stacks = {
    file: stacksFile,
    sanitizeStack: (raw) => realStacks.sanitizeStack(raw),
    list() {
      const raw = readJson(stacksFile, null);
      const list = raw && Array.isArray(raw.stacks) ? raw.stacks : [];
      const out = [];
      const seen = new Set();
      for (const entry of list) {
        const stack = realStacks.sanitizeStack(entry);
        if (!stack || !stack.steps.length || seen.has(stack.id)) continue;
        seen.add(stack.id);
        out.push(stack);
      }
      return out;
    },
    /** stacks.save's contract: stamps unless the sync says not to. */
    save(raw, { stamp = true, at } = {}) {
      const stack = realStacks.sanitizeStack(raw);
      if (!stack) throw new Error("A stack needs an id or a name");
      if (!stack.steps.length) throw new Error("A stack needs at least one step");
      if (stamp) stack.updatedAt = at == null ? Date.now() : at;
      const all = stacks.list();
      const idx = all.findIndex((s) => s.id === stack.id);
      if (idx >= 0) all[idx] = stack;
      else all.push(stack);
      writeJson(stacksFile, { version: 1, stacks: all });
      return stack;
    },
  };

  return { dir, config, stacks };
}

/**
 * Settings sync is OFF for every hub that does not ask for it.
 *
 * The fleet tests run against the real `config` module unless told otherwise,
 * and that module reads (and would write) the settings of the hub actually
 * installed on this machine. An inert stand-in is the safe default; the sync
 * tests hand over a syncEnv() instead.
 */
function inertSyncConfig() {
  return {
    load: () => ({ fleetSync: false, appPrefs: {} }),
    save: () => {
      throw new Error("this hub must never write settings");
    },
    sanitizeAppPrefs: () => ({}),
  };
}

/** One app in the shape discovery.buildApp produces (only the bits we read). */
function app(id, { name, latest = "1.0.0", artifacts = [] } = {}) {
  return {
    id,
    name: name || id,
    latest: latest ? { version: latest } : null,
    artifacts: artifacts.map((a) =>
      Object.assign(
        { id: a.id, label: a.label || a.id, platform: a.platform || "linux", installed: null, updateAvailable: false },
        a
      )
    ),
  };
}

/**
 * Start one hub's fleet on loopback + an ephemeral port.
 * @returns the fleet instance plus {dataDir, events, logs, id, port}
 */
async function startFleet(opts = {}) {
  const dataDir = opts.dataDir || tempDataDir();
  const events = [];
  const logs = [];
  const instance = fleet.createFleet(
    Object.assign(
      {
        dataDir,
        port: 0,
        host: "127.0.0.1",
        beacon: false,
        hubVersion: opts.hubVersion || "9.9.9",
        discovery: opts.discovery || fakeDiscovery([]),
        jobs: opts.jobs || null,
        // v0.10: null = "this hub has no bus", the default for every test that
        // is not about federation. `undefined` would lazily require the real
        // connector module instead.
        connector: opts.connector === undefined ? null : opts.connector,
        stacks: opts.stacks === undefined ? null : opts.stacks,
        syncConfig: opts.syncConfig || inertSyncConfig(),
        emit: (e) => events.push(e),
        log: (m) => logs.push(String(m)),
        // Fast timers everywhere: the tests must never wait on production
        // intervals (5s summary, 5s dial sweep, 120s pairing window).
        summaryIntervalMs: opts.summaryIntervalMs || 25,
        dialIntervalMs: opts.dialIntervalMs || 25,
        requestTimeoutMs: opts.requestTimeoutMs || 4000,
        dialTimeoutMs: opts.dialTimeoutMs || 4000,
      },
      opts.overrides || {}
    )
  );
  await instance.ready;
  instance.dataDir = dataDir;
  instance.events = events;
  instance.logs = logs;
  instance.localId = instance.store.load().id;
  running.push(instance);
  return instance;
}

/** Pair `a` into `b` the way a human does: b shows a code, a types it. */
async function pairHubs(initiator, responder) {
  const { code } = responder.showCode();
  const peer = await initiator.pair("127.0.0.1", code, responder.server.port);
  return peer;
}

/** Poll until `pred` holds (or throw). Used only where no event exists. */
async function waitUntil(pred, ms = 4000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = await pred();
    } catch (_) {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait for a hub to hold a live session with `peerId`. */
function waitForSession(hub, peerId, ms = 4000) {
  return waitUntil(
    () => {
      const s = hub.sessions.get(peerId);
      return s && s.alive ? s : false;
    },
    ms,
    `a session with ${peerId}`
  );
}

/** Wait for an emitted event of `type` and return it. */
function waitForEvent(hub, type, ms = 4000) {
  return waitUntil(() => hub.events.find((e) => e && e.type === type) || false, ms, `a ${type} event`);
}

/**
 * A deliberately dumb fleet client: it completes the WS handshake and then
 * sends whatever the negative tests want — a wrong MAC, a replayed sequence,
 * a stranger's secret.
 */
async function rawClient(port, { host = "127.0.0.1" } = {}) {
  const channel = await wire.dial({ host, port, timeoutMs: 4000 });
  const queue = [];
  const waiters = [];
  let closed = false;
  channel.onText = (text) => {
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      msg = { raw: text };
    }
    if (waiters.length) waiters.shift().resolve(msg);
    else queue.push(msg);
  };
  channel.onClose = () => {
    closed = true;
    while (waiters.length) waiters.shift().reject(new Error("closed"));
  };
  return {
    channel,
    get closed() {
      return closed;
    },
    sendPlain(obj) {
      return channel.send(JSON.stringify(obj));
    },
    sendRaw(text) {
      return channel.send(text);
    },
    next(ms = 4000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
        waiters.push({
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    untilClosed(ms = 4000) {
      return waitUntil(() => closed, ms, "the server to hang up");
    },
    close() {
      try {
        channel.destroy();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

module.exports = {
  fleet,
  protocol,
  store,
  client,
  wire,
  tempDataDir,
  cleanupTempDirs,
  stopAll,
  fakeDiscovery,
  fakeJobs,
  fakeConnector,
  fakeBus,
  busClient,
  syncEnv,
  inertSyncConfig,
  app,
  startFleet,
  pairHubs,
  waitUntil,
  waitForSession,
  waitForEvent,
  rawClient,
};
