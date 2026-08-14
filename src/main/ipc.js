"use strict";
// NX Hub — the window.nxhub surface (main-process half). Requires electron
// objects only through init(deps), so buildState() stays unit-testable.

const path = require("path");

const config = require("./config");
const discovery = require("./discovery");
const jobs = require("./jobs");
const stateStore = require("./state");

let deps = {
  ipcMain: null,
  BrowserWindow: null,
  shell: null,
  app: null,
  onSettingsChanged: () => {},
};

function init(d = {}) {
  deps = Object.assign(deps, d);
  register();
  return module.exports;
}

/** Fan-out to every renderer. Also used by discovery/jobs via init({emit}). */
function emit(evt) {
  if (!evt || !evt.type) return;
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

module.exports = { init, emit, buildState, launchables, hubVersion };
