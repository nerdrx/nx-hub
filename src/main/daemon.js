"use strict";
// SPEC v0.10 [daemon] — the hub without electron.
//
// `nx daemon run` needs everything the GUI hub wires in src/main/index.js
// EXCEPT the parts that only exist because there is a window: no BrowserWindow,
// no tray, no `ipcMain` channels, no e2e hook server, no autostart entry, no
// CLI-shim sync. What is left is the machinery that keeps working while nobody
// is looking:
//
//   config + github + discovery + jobs   the model and the work queue
//   the flight recorder                   what happened, on disk
//   the connector bus (:9021)             apps announce themselves here
//   the fleet (:9022/:9023)               the other hubs on the LAN
//   stacks + triggers, the supervisor     orchestration and keep-alive
//   a refresh loop                        checkIntervalHours, and the update
//                                         policies that hang off afterRefresh
//
// This file is a COMPOSITION ROOT and nothing else: every one of those modules
// is initialised through its own frozen `init()` and none of their behaviour is
// re-implemented here. It is pure node — requiring it from a test (or from the
// CLI running under ELECTRON_RUN_AS_NODE) must never pull electron in.
//
// The one thing the daemon does that the GUI does not: it REFUSES TO START when
// the connector or fleet port is already bound. Two hubs sharing a data dir
// would fight over state.json and double every scheduled install, and a busy
// :9021 is the cheapest possible proof that one is already there.

const net = require("net");

const config = require("./config");
const github = require("./github");
const discovery = require("./discovery");
const jobs = require("./jobs");
const stacks = require("./stacks");
const recorder = require("./recorder");
// ipc.js is the renderer's half of the hub and the daemon has no renderer — but
// `setConnector` is also what mirrors the bus roster to
// <dataDir>/connector-clients.json, which is how EVERY out-of-process reader
// (`nx status`, `nx daemon status`) learns that a hub is alive. Reusing it beats
// duplicating the snapshot format; nothing else in ipc.js is touched, and
// init() is deliberately never called.
const ipc = require("./ipc");

/** Fall back to 6h exactly like the GUI scheduler, and never poll faster than
 *  6 minutes — 0.1h is the floor the SPEC gives the daemon. */
const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_HOURS = 0.1;

/** The first pass after boot is jittered so a rack of hubs woken by the same
 *  power event does not hit GitHub in lockstep. */
const FIRST_RUN_MIN_MS = 3000;
const FIRST_RUN_JITTER_MS = 27000;

/* ------------------------------------------------------------------ */
/* port pre-flight                                                     */
/* ------------------------------------------------------------------ */

/**
 * Can this process bind `port` on `host`? Resolves true when something else
 * already owns it. Same shape as the CLI's own probe (src/cli/runtime.js) —
 * EADDRINUSE is the only answer that means "occupied"; every other failure is
 * treated as free so a locked-down box still gets a real error later, from the
 * module that actually needs the socket.
 */
function portBusy(port, { host = "127.0.0.1", timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (busy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch (_) {
        /* never listened */
      }
      resolve(busy);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (timer.unref) timer.unref();
    const server = net.createServer();
    server.once("error", (e) => done(Boolean(e && e.code === "EADDRINUSE")));
    server.once("listening", () => done(false));
    try {
      server.listen(port, host);
    } catch (_) {
      done(false);
    }
  });
}

/** The refusal the SPEC asks for: say what is in the way and what to do. */
function portBusyMessage(what, port) {
  return (
    `the ${what} port ${port} is already in use — an NX Hub is already running on this machine.\n` +
    "Quit the GUI hub (or stop the other daemon) first: `systemctl --user stop nx-hub-daemon`."
  );
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

/**
 * Bring the headless hub up.
 *
 * @param {object} [opts]
 * @param {function} [opts.log]              line sink (default config.log)
 * @param {number} [opts.connectorPort]      TEST: 0 = ephemeral, and skips the
 *                                           pre-flight (nothing to collide with)
 * @param {number} [opts.fleetPort]          TEST: fleet :9023 override
 * @param {number} [opts.beaconPort]         TEST: fleet :9022 override
 * @param {number} [opts.beaconSendPort]     TEST: where beacons are sent
 * @param {boolean} [opts.fleet]             force the fleet on/off (default:
 *                                           settings.fleet)
 * @param {number} [opts.intervalMs]         TEST: override checkIntervalHours
 * @param {number} [opts.firstRunMs]         TEST: replace the boot jitter
 * @param {object} [opts.timers]             TEST: {setTimeout, clearTimeout}
 * @param {object} [opts.connectorOpts]      TEST: pingMs/reapMs for the bus
 * @returns {Promise<{stop:function, ports:object, refreshNow:function}>}
 */
async function start(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : (m) => config.log(m);
  const timers = opts.timers || { setTimeout, clearTimeout };

  const settings = config.load();
  const wantFleet = opts.fleet === undefined ? settings.fleet !== false : Boolean(opts.fleet);

  const connectorPort = Number.isInteger(opts.connectorPort) ? opts.connectorPort : config.NX_CONNECTOR_PORT;
  // Required lazily: a build without a fleet (or without a bus) must still run.
  const fleetProtocol = wantFleet ? tryRequire("./fleet/protocol") : null;
  const fleetPort = Number.isInteger(opts.fleetPort)
    ? opts.fleetPort
    : fleetProtocol
      ? fleetProtocol.FLEET_PORT
      : null;

  /* -- pre-flight, BEFORE a single module is initialised ------------- */
  //
  // Nothing below this point is undone by throwing: no file has been written,
  // no socket opened, no timer armed. That is the whole reason the probe runs
  // first rather than letting connector.init() come back inert (which is the
  // right answer for the GUI — a hub with a dead bus is still a useful hub —
  // and exactly the wrong answer for a daemon whose ONLY job is to be that hub).
  if (connectorPort > 0 && (await portBusy(connectorPort))) {
    throw operational(portBusyMessage("connector", connectorPort));
  }
  if (wantFleet && fleetPort > 0 && (await portBusy(fleetPort, { host: "0.0.0.0" }))) {
    throw operational(portBusyMessage("fleet", fleetPort));
  }

  config.ensureDir(config.dataDir());
  config.ensureDir(config.cacheDir());
  config.ensureDir(config.logsDir());
  log(`nx daemon starting — data ${config.dataDir()}, installRoot ${config.installRoot(settings)}`);

  /* -- the event fan-out --------------------------------------------- */

  let fleetMod = null; // set once the fleet actually starts
  let connectorMod = null;
  let engineWarned = false;

  const emit = (evt) => {
    if (!evt || !evt.type) return;
    try {
      // `connector-changed` travels EMPTY — the bus only says "something moved".
      // The recorder diffs rosters, so it needs the roster attached, exactly as
      // ipc.recordEvent does it for the GUI. Without this the daemon's journal
      // would never contain a single connector-join.
      recorder.record(
        evt.type === "connector-changed" && connectorMod
          ? Object.assign({}, evt, { clients: safeClients(connectorMod, log) })
          : evt
      );
    } catch (e) {
      log(`recorder: ${e.message}`);
    }
    // v0.6: progress for jobs a PEER asked us to run rides back over its
    // session. Same tap, same place in the pipeline as the GUI's wire().
    if (fleetMod) {
      try {
        fleetMod.onHubEvent(evt);
      } catch (e) {
        log(`fleet: relaying ${evt.type} failed — ${e.message}`);
      }
    }
    logEvent(log, evt);
  };

  /* -- the model ------------------------------------------------------ */

  recorder.init({ dataDir: config.dataDir(), log: (m) => config.log(m) });
  github.init({ getToken: () => config.resolveToken(), cacheDir: config.cacheDir() });
  discovery.init({
    emit,
    // SPEC v0.2: the per-app update policies run after EVERY refresh. The CLI
    // deliberately does NOT wire this (a `nx list` must not install anything
    // behind your back) — but a daemon is precisely the thing that should.
    afterRefresh: (apps) => jobs.applyUpdatePolicies({ apps }),
  });
  // No `relaunch`: a self-update of the hub binary cannot restart a process
  // that electron does not own. systemd's Restart=on-failure is the answer,
  // and jobs.js treats a missing relaunch hook as "just finish the install".
  jobs.init({ emit });

  /* -- the bus -------------------------------------------------------- */

  const connectorServer = tryRequire("./connector/server");
  let connectorHandle = null;
  let connectorReady = { ok: false, port: null };
  if (!connectorServer) {
    log("connector: no bus in this build — apps cannot announce themselves");
  } else {
    connectorHandle = connectorServer.init(
      Object.assign(
        {
          port: connectorPort,
          dataDir: config.dataDir(),
          emit,
          log: (m) => log(`[connector] ${m}`),
          hubVersion: hubVersion(),
          // v0.12: translate the name a client calls itself into the hub's own app
          // id, so an app discovered under "<owner>--<name>" is still matched by a
          // client that only knows its bare repo name.
          resolveAppId: (id) => {
            const app = discovery.findApp(id);
            return (app && app.id) || id;
          },
        },
        opts.connectorOpts || {}
      )
    );
    connectorReady = await connectorHandle.ready;
    if (connectorReady.ok) {
      connectorMod = connectorServer;
      // The snapshot file is the daemon's proof of life for `nx status` and
      // `nx daemon status`: re-stamped on every roster change and on a timer.
      ipc.setConnector(connectorServer);
      log(`connector listening on 127.0.0.1:${connectorReady.port}`);
    } else {
      log(`connector: did not start — ${(connectorReady.error && connectorReady.error.message) || "unknown"}`);
    }
  }

  /* -- the watchdog and the orchestrator ------------------------------ */

  const supervisor = tryRequire("./supervisor");
  if (supervisor) supervisor.init({ jobs, connector: () => connectorMod, config, emit });
  else log("supervisor unavailable — keepAlive apps will not be restarted");

  stacks.init({
    jobs,
    connector: () => connectorMod,
    config,
    emit,
    engine: () => {
      try {
        return jobs.getEngine();
      } catch (e) {
        if (!engineWarned) {
          engineWarned = true;
          log(`install engine unavailable — adb-device triggers are off (${e.message})`);
        }
        return null;
      }
    },
    fleet: () => (fleetMod && fleetMod.isRunning && fleetMod.isRunning() ? fleetMod : null),
  });

  /* -- the LAN ------------------------------------------------------- */
  //
  // Last, exactly as in the GUI: the fleet reads the discovery model and
  // enqueues jobs, so everything it can touch is already wired by the time a
  // peer could possibly reach it.

  let fleetHandle = null;
  if (wantFleet) {
    const mod = tryRequire("./fleet");
    if (!mod) log("fleet: not in this build");
    else {
      try {
        fleetHandle = mod.init({
          config,
          jobs,
          discovery,
          emit,
          log: (m) => log(`[fleet] ${m}`),
          hubVersion: hubVersion(),
          connector: connectorMod,
          port: Number.isInteger(opts.fleetPort) ? opts.fleetPort : undefined,
          beaconPort: Number.isInteger(opts.beaconPort) ? opts.beaconPort : undefined,
          beaconSendPort: Number.isInteger(opts.beaconSendPort) ? opts.beaconSendPort : undefined,
        });
        fleetMod = mod;
        fleetHandle.ready
          .then((r) => log(`fleet: ${r.ok ? `listening on :${r.port}` : "did not start"}${r.id ? ` (id ${r.id})` : ""}`))
          .catch(() => {});
      } catch (e) {
        log(`fleet: could not start — ${e.message}`);
        fleetHandle = null;
        fleetMod = null;
      }
    }
  } else {
    log("fleet: disabled in settings");
  }

  /* -- the scheduler -------------------------------------------------- */

  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : intervalFrom(settings);
  let refreshTimer = null;
  let stopped = false;

  async function refreshNow({ force = false } = {}) {
    try {
      await discovery.refresh({ force });
      // afterRefresh (the update policies) is fired but NOT awaited by
      // discovery — a "download"/"install" policy must not hold the pass open.
      // The daemon has nowhere to be, so it waits: that keeps one cycle's
      // installs from overlapping the next cycle's refresh.
      const pending = discovery.getCached().policyPromise;
      if (pending && typeof pending.then === "function") await pending;
    } catch (e) {
      log(`refresh failed: ${e.message}`);
    }
  }

  // The pass currently in flight (or the last one). Only `settled()` reads it —
  // a fake-timer test needs something to await after firing the callback.
  let pending = null;

  function arm(delayMs) {
    if (stopped) return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      pending = refreshNow().then(
        () => arm(intervalMs),
        () => arm(intervalMs)
      );
    }, delayMs);
    if (refreshTimer && refreshTimer.unref) refreshTimer.unref();
  }

  const firstRunMs = Number.isFinite(opts.firstRunMs)
    ? Math.max(0, Number(opts.firstRunMs))
    : FIRST_RUN_MIN_MS + Math.floor(Math.random() * FIRST_RUN_JITTER_MS);
  arm(firstRunMs);
  log(`refresh every ${(intervalMs / 3600000).toFixed(2)}h, first pass in ${Math.round(firstRunMs / 1000)}s`);

  /* -- teardown, in reverse ------------------------------------------- */

  let stopping = null;
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      if (refreshTimer) timers.clearTimeout(refreshTimer);
      refreshTimer = null;

      // The fleet first: it is the only listener open to the network, and its
      // sessions carry job progress that the modules below still produce.
      if (fleetMod) {
        try {
          await fleetMod.close();
        } catch (e) {
          log(`fleet close failed: ${e.message}`);
        }
      }
      fleetMod = null;

      try {
        stacks.stopWatcher(); // no trigger may fire into a half-torn-down hub
      } catch (e) {
        log(`stacks: ${e.message}`);
      }
      if (supervisor) {
        try {
          supervisor.stop(); // no relaunches after we are gone
        } catch (e) {
          log(`supervisor: ${e.message}`);
        }
      }

      // Drop the snapshot heartbeat before the bus it describes goes away.
      try {
        ipc.setConnector(null);
      } catch (_) {
        /* ignore */
      }
      connectorMod = null;
      if (connectorHandle) {
        try {
          // Awaited: the listening socket must really be released, or a
          // restart on the same port races its own predecessor.
          await connectorHandle.close();
        } catch (e) {
          log(`connector close failed: ${e.message}`);
        }
      }
      connectorHandle = null;

      try {
        recorder.flush(); // the journal must survive a clean shutdown
      } catch (_) {
        /* ignore */
      }
      log("nx daemon stopped");
    })();
    return stopping;
  }

  return {
    stop,
    refreshNow,
    /** Resolves once the scheduled pass that is running right now is done. */
    settled: () => pending || Promise.resolve(),
    ports: {
      connector: connectorReady.ok ? connectorReady.port : null,
      fleet: fleetHandle ? fleetPort : null,
    },
    intervalMs,
    firstRunMs,
    fleetReady: fleetHandle ? fleetHandle.ready : Promise.resolve({ ok: false }),
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** checkIntervalHours → ms, clamped to the SPEC's 0.1h floor. */
function intervalFrom(settings) {
  const hours = Number((settings || config.load()).checkIntervalHours) || DEFAULT_INTERVAL_HOURS;
  return Math.max(MIN_INTERVAL_HOURS, hours) * 3600 * 1000;
}

/**
 * SPEC: "Notifications/toasts become log lines." There is no tray to bubble
 * into and no renderer to paint a card, so the two user-facing event types
 * land in the log — where `journalctl --user -u nx-hub-daemon` finds them.
 * Everything else is already in the flight recorder (`nx log`).
 */
function logEvent(log, evt) {
  if (evt.type === "toast") {
    log(`[${evt.level || "info"}] ${evt.message}`);
  } else if (evt.type === "update-available") {
    log(`update available: ${evt.appName || evt.appId} ${evt.version || ""}`.trim());
  } else if (evt.type === "job-error") {
    log(`job failed: ${evt.message || "unknown error"}`);
  }
}

/** The bus roster, or [] — getClients() must never break the event stream. */
function safeClients(connectorMod, log) {
  try {
    const list = connectorMod.getClients();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    log(`connector.getClients failed: ${e.message}`);
    return [];
  }
}

function tryRequire(id) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(id);
  } catch (_) {
    return null;
  }
}

function hubVersion() {
  try {
    // eslint-disable-next-line global-require
    return require("../../package.json").version;
  } catch (_) {
    return "0.0.0";
  }
}

/** A failure the user can act on — the CLI prints it without a stack. */
function operational(message) {
  const e = new Error(message);
  e.operational = true;
  e.exitCode = 2;
  return e;
}

module.exports = {
  start,
  portBusy,
  portBusyMessage,
  intervalFrom,
  logEvent,
  DEFAULT_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
};
