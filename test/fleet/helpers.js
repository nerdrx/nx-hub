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
  app,
  startFleet,
  pairHubs,
  waitUntil,
  waitForSession,
  waitForEvent,
  rawClient,
};
