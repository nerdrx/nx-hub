"use strict";
// The CLI's wiring into the hub's own logic layer.
//
// Nothing here re-implements hub behaviour: config/github/discovery/jobs/state
// and the install engine are exactly the modules the GUI drives — this file
// only gives them a CLI-shaped emitter and awaits the jobs they queue.
//
// Deliberately NOT wired: discovery's `afterRefresh` hook. In the GUI it runs
// the per-app update policies (which may download or install in the
// background); a `nx list` must never start an install behind the user's back.

const fs = require("fs");
const net = require("net");
const path = require("path");

const config = require("../main/config");
const github = require("../main/github");
const discovery = require("../main/discovery");
const jobs = require("../main/jobs");
const stateStore = require("../main/state");
const ipc = require("../main/ipc");
const stacksStore = require("../main/stacks");
const shim = require("./shim");

const ROOT = path.join(__dirname, "..", "..");

function hubVersion() {
  try {
    // eslint-disable-next-line global-require
    return require(path.join(ROOT, "package.json")).version;
  } catch (_) {
    return "0.0.0";
  }
}

function runtimeLabel() {
  const node = `node ${process.versions.node}`;
  return process.versions.electron ? `${node} (electron ${process.versions.electron}, run-as-node)` : node;
}

function createRuntime() {
  const listeners = new Set();
  let booted = false;

  function emit(evt) {
    if (!evt || !evt.type) return;
    for (const fn of [...listeners]) {
      try {
        fn(evt);
      } catch (_) {
        /* a listener must never break a job */
      }
    }
  }

  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function boot() {
    if (booted) return;
    booted = true;
    config.ensureDir(config.dataDir());
    github.init({ getToken: () => config.resolveToken(), cacheDir: config.cacheDir() });
    discovery.init({ emit });
    jobs.init({ emit });
    // v0.5: stacks run IN THIS PROCESS when driven from the CLI — same store,
    // same jobs, but no bus (the GUI hub owns the only connector server), so
    // `connector` health gates fail fast and stop() falls back to SIGTERM on
    // the pids this process launched.
    stacksStore.init({ jobs, connector: null, config, emit });
  }

  /* ---------------- discovery ---------------- */

  async function refresh({ force = false } = {}) {
    boot();
    await discovery.refresh({ force });
    return discovery.getCached();
  }

  /** Apps from the in-memory cache, refreshing first when it is empty. */
  async function apps({ force = false } = {}) {
    boot();
    const cached = discovery.getCached();
    if (force || !cached.apps || cached.apps.length === 0) await discovery.refresh({ force });
    return discovery.getCached().apps || [];
  }

  function cached() {
    return discovery.getCached();
  }

  async function releases(appId) {
    boot();
    const list = discovery.getReleases(appId);
    if (list.length) return list;
    try {
      return await discovery.fetchReleases(appId);
    } catch (e) {
      config.log(`nx versions ${appId}: ${e.message}`);
      return [];
    }
  }

  /* ---------------- jobs ---------------- */

  /**
   * Queue a job and resolve when it finishes.
   *
   * Progress can start SYNCHRONOUSLY inside `start()` (jobs.js emits its first
   * "download" progress before enqueue returns), so the listener is attached
   * first and matches on app+artifact until the job id is known.
   */
  function runJob(start, { appId, artifactId, onProgress, onToast } = {}) {
    boot();
    return new Promise((resolve, reject) => {
      let jobId = null;
      let settled = false;

      const off = on((evt) => {
        if (settled) return;
        if (evt.type === "toast") {
          if (onToast) onToast(evt);
          return;
        }
        if (!evt.jobId) return;
        const mine = jobId ? evt.jobId === jobId : evt.appId === appId && evt.artifactId === artifactId;
        if (!mine) return;
        if (evt.type === "job-progress") {
          if (onProgress) onProgress(evt);
          return;
        }
        if (evt.type === "job-done") {
          settled = true;
          cleanup();
          resolve({ ok: true, message: evt.message || "done", jobId: evt.jobId });
          return;
        }
        if (evt.type === "job-error") {
          settled = true;
          cleanup();
          const err = new Error(evt.message || "the job failed");
          err.jobId = evt.jobId;
          err.operational = true;
          reject(err);
        }
      });

      const onSigint = () => {
        if (jobId) jobs.cancelJob(jobId);
      };
      process.on("SIGINT", onSigint);

      function cleanup() {
        off();
        process.removeListener("SIGINT", onSigint);
      }

      try {
        jobId = start();
      } catch (e) {
        settled = true;
        cleanup();
        e.operational = true;
        reject(e);
      }
    });
  }

  function install(appId, artifactId, { tag, onProgress, onToast } = {}) {
    return runJob(() => (tag ? jobs.installVersion(appId, artifactId, tag) : jobs.install(appId, artifactId)), {
      appId,
      artifactId,
      onProgress,
      onToast,
    });
  }

  function uninstall(appId, artifactId, { onProgress, onToast } = {}) {
    return runJob(() => jobs.uninstall(appId, artifactId), { appId, artifactId, onProgress, onToast });
  }

  function rollback(appId, artifactId, { onProgress, onToast } = {}) {
    return runJob(() => jobs.rollback(appId, artifactId), { appId, artifactId, onProgress, onToast });
  }

  async function launch(appId, artifactId) {
    boot();
    return jobs.launch(appId, artifactId);
  }

  /* ---------------- v0.5: connector + stacks ---------------- */

  /**
   * Can THIS process bind the connector port? If it can, nothing is listening —
   * no hub, no bus. The CLI never joins the bus as a client: the protocol has
   * no query message, so presence is read from the hub's own snapshot file
   * (`<dataDir>/connector-clients.json`, written by ipc.setConnector).
   */
  function probeBus(port = config.NX_CONNECTOR_PORT, { timeoutMs = 1500 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (listening) => {
        if (settled) return;
        settled = true;
        try {
          server.close();
        } catch (_) {
          /* never listened */
        }
        resolve(listening);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      if (timer.unref) timer.unref();
      const server = net.createServer();
      server.once("error", (e) => {
        clearTimeout(timer);
        done(e && e.code === "EADDRINUSE"); // in use = something IS listening
      });
      server.once("listening", () => {
        clearTimeout(timer);
        done(false);
      });
      try {
        server.listen(port, "127.0.0.1");
      } catch (_) {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /** Field definitions per app id, straight from the cached overlay (offline). */
  function connectorFieldDefs() {
    const overlay = discovery.normalizeOverlay(config.readJson(path.join(config.cacheDir(), "overlay.json"), null));
    const out = {};
    for (const key of Object.keys(overlay.apps || {})) {
      const entry = overlay.apps[key];
      if (entry && entry.connector && Array.isArray(entry.connector.fields)) out[key] = entry.connector.fields;
    }
    return out;
  }

  /** Everything `nx status` needs, in one object. */
  async function connectorStatus({ maxAgeMs = 120000 } = {}) {
    const snapshot = ipc.readConnectorSnapshot(maxAgeMs);
    const listening = await probeBus();
    return {
      port: config.NX_CONNECTOR_PORT,
      host: "127.0.0.1",
      listening,
      // The bus answers AND the hub's snapshot is fresh enough to trust.
      online: listening && !snapshot.stale,
      stale: snapshot.stale,
      snapshotPath: snapshot.path,
      snapshotExists: snapshot.exists,
      ts: snapshot.ts,
      ageMs: snapshot.ageMs,
      clients: snapshot.clients,
      fieldDefs: connectorFieldDefs(),
      hubVersion: hubVersion(),
    };
  }

  function stackList() {
    boot();
    return stacksStore.list();
  }

  function runStack(id) {
    boot();
    return stacksStore.run(id);
  }

  function stopStack(id) {
    boot();
    return stacksStore.stop(id);
  }

  function saveStack(stack) {
    boot();
    return stacksStore.save(stack);
  }

  /* ---------------- doctor ---------------- */

  async function doctor() {
    boot();
    const settings = config.load();
    const state = discovery.getCached();

    let tokenSource = "";
    if (settings.token) tokenSource = "settings";
    else {
      try {
        tokenSource = (await config.resolveToken(settings)) ? "gh" : "";
      } catch (_) {
        tokenSource = "";
      }
    }

    let engine = null;
    let engineError = null;
    try {
      engine = jobs.getEngine();
    } catch (e) {
      engineError = e.message;
    }

    let adb = state.adb;
    if ((!adb || !adb.devices) && engine) {
      try {
        adb = await engine.getAdbStatus({
          dataDir: config.dataDir(),
          installRoot: config.installRoot(settings),
          settings,
          log: (m) => config.log(`[adb] ${m}`),
          emitProgress: () => {},
        });
      } catch (_) {
        adb = { available: false, devices: [] };
      }
    }

    const installs = stateStore.listInstalls();
    const appList = state.apps || [];
    const shimInfo = shim.inspect({ binary: process.execPath, appDir: ROOT });

    return {
      hubVersion: hubVersion(),
      runtime: runtimeLabel(),
      dataDir: config.dataDir(),
      installRoot: config.installRoot(settings),
      settingsPath: config.settingsPath(),
      settingsExists: fs.existsSync(config.settingsPath()),
      logFile: config.logFile(),
      tokenSource,
      owners: settings.owners || [],
      extraRepos: settings.extraRepos || [],
      adbPath: settings.adbPath,
      adb: adb || { available: false, devices: [] },
      engine: Boolean(engine),
      engineError,
      rateLimit: state.rateLimit || null,
      errors: state.errors || [],
      lastRefresh: state.lastRefresh || null,
      appCount: appList.length,
      installedCount: installs.length,
      updateCount: appList.filter((a) => (a.artifacts || []).some((x) => x.updateAvailable)).length,
      shimPath: shimInfo.path,
      shimState: shimInfo.state,
      shimOnPath: shim.onPath(path.dirname(shimInfo.path)),
      cliShimSetting: settings.cliShim !== false,
    };
  }

  return {
    on,
    emit,
    boot,
    refresh,
    apps,
    cached,
    releases,
    install,
    uninstall,
    rollback,
    launch,
    doctor,
    // v0.5
    connectorStatus,
    probeBus,
    stackList,
    runStack,
    stopStack,
    saveStack,
    hubVersion,
    config,
    discovery,
    jobs,
    stateStore,
  };
}

module.exports = { createRuntime, hubVersion, runtimeLabel, ROOT };
