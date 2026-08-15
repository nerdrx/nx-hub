"use strict";
// NX Hub — the window.nxhub surface (main-process half). Requires electron
// objects only through init(deps), so buildState() stays unit-testable.

const path = require("path");

const config = require("./config");
const discovery = require("./discovery");
const jobs = require("./jobs");
const stateStore = require("./state");
const housekeeping = require("./housekeeping");

let deps = {
  ipcMain: null,
  BrowserWindow: null,
  shell: null,
  app: null,
  // v0.2: electron's Notification class (injected — pure modules stay electron-free)
  Notification: null,
  onSettingsChanged: () => {},
};

function init(d = {}) {
  deps = Object.assign(deps, d);
  register();
  return module.exports;
}

/**
 * SPEC v0.2: an `update-available` event also raises an OS notification when
 * settings.notifications is on. Guarded for platforms/builds without support;
 * the once-per-(app,version) bookkeeping lives in jobs/state, so this simply
 * mirrors whatever events actually get emitted.
 */
function notifyUpdate(evt) {
  try {
    const Notification = deps.Notification;
    if (!Notification || typeof Notification !== "function") return;
    if (typeof Notification.isSupported === "function" && !Notification.isSupported()) return;
    if (!config.load().notifications) return;
    const name = evt.appName || evt.appId;
    new Notification({
      title: `${name} ${evt.version} is available`,
      body: "Open NX Hub to install the update.",
      silent: false,
    }).show();
  } catch (e) {
    config.log(`notification failed: ${e.message}`);
  }
}

/** Fan-out to every renderer. Also used by discovery/jobs via init({emit}). */
function emit(evt) {
  if (!evt || !evt.type) return;
  if (evt.type === "update-available") notifyUpdate(evt);
  const BW = deps.BrowserWindow;
  if (!BW) return;
  for (const win of BW.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("nxhub:event", evt);
    } catch (_) {
      /* window going away */
    }
  }
}

function hubVersion() {
  try {
    if (deps.app && typeof deps.app.getVersion === "function") return deps.app.getVersion();
  } catch (_) {
    /* not in electron */
  }
  try {
    // eslint-disable-next-line global-require
    return require(path.join(__dirname, "..", "..", "package.json")).version;
  } catch (_) {
    return "0.0.0";
  }
}

/** SPEC: getState() → { apps, settings, jobs, adb, hubVersion, refreshing } */
async function buildState() {
  const settings = config.load();
  const cached = discovery.getCached();
  // "settings" | "gh" | "" — the UI uses this for the "private repos need a token" hint
  let tokenSource = "";
  if (settings.token) tokenSource = "settings";
  else {
    try {
      tokenSource = (await config.resolveToken(settings)) ? "gh" : "";
    } catch (_) {
      tokenSource = "";
    }
  }
  const adb = cached.adb || {};
  return {
    apps: cached.apps,
    settings: Object.assign({}, settings, { tokenSource }),
    tokenSource, // top-level: where the renderer reads it
    jobs: jobs.list(),
    adb: {
      available: Boolean(adb.available),
      devices: adb.devices || [],
      versions: adb.versions || adb.apkVersions || {},
      // v0.2: the device the hub acts on (settings.preferredDeviceSerial when online)
      selected: adb.selected || settings.preferredDeviceSerial || null,
    },
    hubVersion: hubVersion(),
    refreshing: cached.refreshing,
    rateLimit: cached.rateLimit || null,
    errors: cached.errors || [],
    lastRefresh: cached.lastRefresh,
  };
}

function safeExternal(url) {
  const u = String(url || "");
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

/* ------------------------------------------------------------------ */
/* v0.2 helpers                                                        */
/* ------------------------------------------------------------------ */

/** ctx for the engine's adb entry points (same shape jobs builds). */
function engineCtx() {
  const settings = config.load();
  return {
    dataDir: config.dataDir(),
    installRoot: config.installRoot(settings),
    settings,
    log: (m) => config.log(`[adb] ${m}`),
    emitProgress: () => {},
  };
}

function engineOrThrow() {
  const engine = jobs.getEngine();
  if (!engine) throw new Error("Install engine unavailable");
  return engine;
}

/** SPEC v0.2 getReleases(appId): cached list, fetched live when we have none. */
async function getReleases(appId) {
  const cachedList = discovery.getReleases(appId);
  if (cachedList.length) return cachedList;
  try {
    return await discovery.fetchReleases(appId);
  } catch (e) {
    config.log(`getReleases(${appId}) failed: ${e.message}`);
    return [];
  }
}

function register() {
  const { ipcMain } = deps;
  if (!ipcMain) return;

  const handle = (channel, fn) => {
    try {
      ipcMain.removeHandler(channel);
    } catch (_) {
      /* ignore */
    }
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        config.log(`ipc ${channel} failed: ${err.stack || err.message}`);
        emit({ type: "toast", level: "error", message: err.message || String(err) });
        throw err;
      }
    });
  };

  handle("nxhub:getState", () => buildState());

  handle("nxhub:refresh", async (force) => {
    await discovery.refresh({ force: Boolean(force) });
    return buildState();
  });

  handle("nxhub:install", (appId, artifactId) => jobs.install(appId, artifactId));
  handle("nxhub:uninstall", (appId, artifactId) => jobs.uninstall(appId, artifactId));
  handle("nxhub:launch", async (appId, artifactId) => {
    await jobs.launch(appId, artifactId);
    emit({ type: "toast", level: "info", message: "Launching…" });
    return true;
  });
  handle("nxhub:cancelJob", (jobId) => jobs.cancelJob(jobId));

  handle("nxhub:setSettings", async (patch) => {
    const before = config.load();
    const next = config.save(patch || {});
    emit({ type: "state-changed" });
    const sourcesChanged =
      JSON.stringify(before.owners) !== JSON.stringify(next.owners) ||
      JSON.stringify(before.extraRepos) !== JSON.stringify(next.extraRepos) ||
      before.token !== next.token;
    try {
      deps.onSettingsChanged(next, { sourcesChanged });
    } catch (e) {
      config.log(`onSettingsChanged failed: ${e.message}`);
    }
    if (sourcesChanged) discovery.refresh({ force: true }).catch(() => {});
    return buildState();
  });

  /* ---------------- v0.2 surface ---------------- */

  handle("nxhub:getReleases", (appId) => getReleases(appId));

  handle("nxhub:installVersion", (appId, artifactId, tag) => jobs.installVersion(appId, artifactId, tag));

  handle("nxhub:rollback", (appId, artifactId) => jobs.rollback(appId, artifactId));

  handle("nxhub:setAppPref", async (appId, patch) => {
    config.setAppPref(appId, patch || {});
    // hidden / includePrereleases change what the model looks like — rebuild
    try {
      discovery.rebuild();
    } catch (e) {
      config.log(`setAppPref rebuild failed: ${e.message}`);
    }
    emit({ type: "state-changed" });
    return buildState();
  });

  handle("nxhub:adbConnect", async (hostPort) => {
    const result = await engineOrThrow().adbConnect(engineCtx(), hostPort);
    await discovery.refreshAdb().catch(() => {});
    emit({ type: "toast", level: "info", message: result.message || `Connected to ${result.target}` });
    emit({ type: "state-changed" });
    return result;
  });

  handle("nxhub:adbSelectDevice", async (serial) => {
    config.save({ preferredDeviceSerial: serial ? String(serial) : null });
    const adb = await discovery.refreshAdb().catch(() => null);
    emit({ type: "state-changed" });
    return { selected: config.load().preferredDeviceSerial, adb: adb || null };
  });

  handle("nxhub:getDeviceInfo", async () => {
    try {
      // The devices sheet calls this on open — rescan the device list in the
      // same breath so the list and the info tiles can never disagree (seen
      // in the field: freshly authorized phone showed info but "No device").
      await discovery.refreshAdb().catch(() => {});
      emit({ type: "state-changed" });
      return await engineOrThrow().getDeviceInfo(engineCtx());
    } catch (e) {
      config.log(`getDeviceInfo: ${e.message}`);
      return { serial: null, model: null, batteryPct: null, storageFreeBytes: null, available: false };
    }
  });

  handle("nxhub:getDiskUsage", (force) => housekeeping.getDiskUsage({ force: Boolean(force) }));

  handle("nxhub:clearDownloadCache", async () => {
    const result = await housekeeping.clearDownloadCache();
    try {
      discovery.remerge();
    } catch (_) {
      /* cache may be empty */
    }
    emit({ type: "state-changed" });
    return result;
  });

  handle("nxhub:getLogs", (tailLines) => housekeeping.getLogs(tailLines));

  handle("nxhub:exportSettings", () => config.exportSettings());

  handle("nxhub:importSettings", async (json) => {
    const result = config.importSettings(json);
    try {
      discovery.rebuild();
    } catch (_) {
      /* no cache yet */
    }
    emit({ type: "state-changed" });
    try {
      deps.onSettingsChanged(result.settings, { sourcesChanged: true });
    } catch (e) {
      config.log(`onSettingsChanged failed: ${e.message}`);
    }
    discovery.refresh({ force: true }).catch(() => {});
    return result;
  });

  handle("nxhub:openExternal", async (url) => {
    const safe = safeExternal(url);
    if (!safe) throw new Error("Refusing to open a non-web URL");
    if (deps.shell) await deps.shell.openExternal(safe);
    return true;
  });

  handle("nxhub:showInFolder", (p) => {
    if (!p) return false;
    if (deps.shell) deps.shell.showItemInFolder(String(p));
    return true;
  });
}

/** Installed + launchable artifacts, for the tray menu. */
function launchables() {
  const apps = discovery.getCached().apps || [];
  const st = stateStore.load();
  const out = [];
  for (const app of apps) {
    for (const artifact of app.artifacts || []) {
      const rec = (st.installed[app.id] || {})[artifact.id];
      if (!rec) continue;
      if (artifact.launchable === false) continue; // discovery decides (kind + engine result)
      out.push({ appId: app.id, artifactId: artifact.id, appName: app.name, label: artifact.label });
    }
  }
  return out;
}

module.exports = { init, emit, buildState, launchables, hubVersion, getReleases, engineCtx };
