"use strict";
// NX Hub — main process bootstrap: single instance, window, tray, scheduler.

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification } = require("electron");

const config = require("./config");
const github = require("./github");
const discovery = require("./discovery");
const jobs = require("./jobs");
const ipc = require("./ipc");
const stacks = require("./stacks");
const e2e = require("./e2e");
const cliShim = require("../cli/shim");

const ROOT = path.join(__dirname, "..", "..");
const RENDERER = path.join(ROOT, "src", "renderer", "index.html");
const ICON_PNG = path.join(ROOT, "assets", "icon.png");
const TRAY_PNG = path.join(ROOT, "assets", "tray.png");

let mainWindow = null;
let tray = null;
let refreshTimer = null;
let quitting = false;
let connectorHandle = null; // {close} from the bus's init(), when it started
let trayRefreshTimer = null;
let fleetModule = null; // src/main/fleet, once it loaded (v0.6)
let fleetHandle = null; // {close} from fleet.init(), when the setting allowed it

/* ------------------------------------------------------------------ */
/* v0.2: autostart + start-minimized                                   */
/* ------------------------------------------------------------------ */

/** The binary an autostart entry has to launch (AppImage-aware). */
function selfExecPath() {
  return process.env.APPIMAGE || app.getPath("exe");
}

/** --minimized on the command line, or settings.startMinimized. */
function startsMinimized(settings) {
  if (process.argv.includes("--minimized")) return true;
  return Boolean((settings || config.load()).startMinimized);
}

/**
 * Keep `~/.local/bin/nx` pointing at THIS install (settings.cliShim, default
 * true). Idempotent: rewritten only when the baked paths changed — which is
 * exactly what makes the command survive a self-update — removed when the
 * setting is turned off, and never written over a foreign file of that name.
 */
function syncCliShim(settings) {
  // The e2e harness runs with temp data dirs but the REAL $HOME — a test must
  // never install a command into the user's ~/.local/bin.
  if (process.env.NX_HUB_E2E === "1") return { action: "skipped", reason: "e2e run" };
  const s = settings || config.load();
  const result = cliShim.sync(s, { binary: process.execPath, appDir: ROOT });
  if (result.action === "written" || result.action === "updated") {
    config.log(`cli shim ${result.action}: ${result.path}`);
    if (result.onPath === false) config.log(`note: ${path.dirname(result.path)} is not on PATH — add it to use \`nx\``);
  } else if (result.action === "foreign" || result.action === "error" || result.reason) {
    config.log(`cli shim ${result.action}${result.reason ? ` — ${result.reason}` : ""}`);
  }
  return result;
}

function syncAutostart(settings) {
  const s = settings || config.load();
  const result = config.applyAutostart(s, selfExecPath());
  config.log(`autostart ${s.autostart ? `enabled → ${result.path}` : "disabled"}`);
  return result;
}

function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><title>NX Hub</title></head>
   <body style="background:#0a0714;color:#efeaff;font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
   <div id="nxhub-placeholder">NX Hub — renderer not built yet</div></body></html>`
)}`;

const BOUNDS_FILE = () => path.join(config.dataDir(), "window.json");

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE(), "utf8"));
    if (b && Number(b.width) >= 900 && Number(b.height) >= 600) return b;
  } catch (_) {
    /* first run */
  }
  return null;
}

function persistBounds(win) {
  try {
    const b = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(BOUNDS_FILE(), JSON.stringify(b));
  } catch (_) {
    /* best effort */
  }
}

function createWindow({ minimized = false } = {}) {
  const prev = savedBounds();
  mainWindow = new BrowserWindow({
    width: prev ? prev.width : 1200,
    height: prev ? prev.height : 800,
    x: prev && Number.isFinite(prev.x) ? prev.x : undefined,
    y: prev && Number.isFinite(prev.y) ? prev.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0714",
    title: "NX Hub",
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (fs.existsSync(RENDERER)) mainWindow.loadFile(RENDERER);
  else {
    config.log(`renderer missing at ${RENDERER} — loading placeholder`);
    mainWindow.loadURL(PLACEHOLDER);
  }

  // v0.2: --minimized / settings.startMinimized → stay hidden, tray only
  if (minimized) config.log("starting minimized to the tray");
  else
    mainWindow.once("ready-to-show", () => {
      if (prev && prev.maximized) mainWindow.maximize();
      mainWindow.show();
    });

  // Remember size/position/maximized state across sessions.
  for (const evt of ["resized", "moved", "maximize", "unmaximize"]) {
    mainWindow.on(evt, () => persistBounds(mainWindow));
  }

  // Close → hide to tray. Real quit goes through before-quit.
  mainWindow.on("close", (e) => {
    persistBounds(mainWindow);
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) =>
    config.log(`renderer gone: ${JSON.stringify(details)}`)
  );

  return mainWindow;
}

function showWindow() {
  const win = getWindow() || createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ */
/* tray                                                                */
/* ------------------------------------------------------------------ */

function buildTrayMenu() {
  const items = [{ label: "Open NX Hub", click: () => showWindow() }, { type: "separator" }];

  let entries = [];
  try {
    entries = ipc.launchables();
  } catch (e) {
    config.log(`tray: launchables failed — ${e.message}`);
  }

  if (entries.length) {
    for (const entry of entries) {
      // v0.5: an app that is live on the connector bus says so right here —
      // "PulseNX · 72 bpm" when the overlay declares fields, a bare presence
      // marker otherwise. `live` is "" for everything that is not connected.
      const base = entries.filter((x) => x.appId === entry.appId).length > 1 ? `${entry.appName} — ${entry.label}` : entry.appName;
      items.push({
        label: `${base}${entry.live || ""}`,
        click: () =>
          jobs.launch(entry.appId, entry.artifactId).catch((err) => {
            config.log(`tray launch failed: ${err.message}`);
            ipc.emit({ type: "toast", level: "error", message: `Launch failed: ${err.message}` });
          }),
      });
    }
  } else {
    items.push({ label: "No apps installed yet", enabled: false });
  }

  items.push(
    { type: "separator" },
    { label: "Check for updates", click: () => discovery.refresh({ force: true }).catch(() => {}) },
    { type: "separator" },
    {
      label: "Quit NX Hub",
      click: () => {
        quitting = true;
        app.quit();
      },
    }
  );
  return Menu.buildFromTemplate(items);
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    config.log(`tray menu update failed: ${e.message}`);
  }
}

/**
 * Bus traffic is chatty (status frames up to 4/s per client); rebuilding a tray
 * menu that often would be silly, so connector/stack events coalesce into one
 * rebuild every couple of seconds.
 */
function updateTraySoon(delayMs = 2000) {
  if (trayRefreshTimer) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    updateTray();
  }, delayMs);
  if (trayRefreshTimer.unref) trayRefreshTimer.unref();
}

function createTray() {
  try {
    let image = nativeImage.createEmpty();
    const source = fs.existsSync(TRAY_PNG) ? TRAY_PNG : ICON_PNG;
    if (fs.existsSync(source)) {
      image = nativeImage.createFromPath(source);
      if (!image.isEmpty()) image = image.resize({ width: 22, height: 22 });
    }
    tray = new Tray(image);
    tray.setToolTip("NX Hub");
    tray.on("click", () => showWindow());
    updateTray();
  } catch (e) {
    tray = null;
    config.log(`tray unavailable: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* scheduler                                                           */
/* ------------------------------------------------------------------ */

function scheduleRefresh(settings) {
  if (refreshTimer) clearInterval(refreshTimer);
  const hours = Number((settings || config.load()).checkIntervalHours) || 6;
  const ms = Math.max(5 * 60 * 1000, hours * 3600 * 1000);
  refreshTimer = setInterval(() => {
    config.log("periodic refresh");
    discovery.refresh({ force: false }).catch((e) => config.log(`periodic refresh failed: ${e.message}`));
  }, ms);
  if (refreshTimer.unref) refreshTimer.unref();
  config.log(`refresh scheduled every ${hours}h`);
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

/**
 * v0.5: start the NX Connector bus, if this build has one.
 *
 * The bus module is required LAZILY and defensively: a hub whose connector
 * failed to bind (another instance, a locked-down box) — or a build that
 * simply does not ship `src/main/connector/` — must still run everything
 * else. Stacks then fall back to pid-based stop and `connector` health gates
 * fail fast instead of hanging.
 */
function startConnector(emit) {
  let mod = null;
  try {
    // eslint-disable-next-line global-require
    mod = require("./connector/server");
  } catch (e) {
    config.log(`connector: no bus in this build — ${e.message}`);
    return null;
  }
  try {
    connectorHandle = mod.init({
      port: config.NX_CONNECTOR_PORT,
      dataDir: config.dataDir(),
      emit,
      log: (m) => config.log(`[connector] ${m}`),
      hubVersion: ipc.hubVersion(),
    });
    ipc.setConnector(mod);
    config.log(`connector listening on 127.0.0.1:${config.NX_CONNECTOR_PORT}`);
    return mod;
  } catch (e) {
    config.log(`connector: could not start — ${e.message}`);
    connectorHandle = null;
    return null;
  }
}

function stopConnector() {
  try {
    if (connectorHandle && typeof connectorHandle.close === "function") connectorHandle.close();
  } catch (e) {
    config.log(`connector close failed: ${e.message}`);
  }
  connectorHandle = null;
}

/**
 * v0.6: hub-to-hub on the LAN (SPEC "Fleet"), gated by settings.fleet.
 *
 * Same defensive shape as the connector: required lazily, a busy port or a
 * missing module leaves the rest of the hub entirely unaffected. This is the
 * ONE listener the hub opens to the network rather than to loopback, so it is
 * also the one the user can switch off — and turning it off has to stop both
 * halves, the beacon and the :9023 server.
 */
function startFleet(emit) {
  const settings = config.load();
  if (settings.fleet === false) {
    config.log("fleet: disabled in settings");
    return null;
  }
  if (!fleetModule) {
    try {
      // eslint-disable-next-line global-require
      fleetModule = require("./fleet");
    } catch (e) {
      config.log(`fleet: not in this build — ${e.message}`);
      return null;
    }
  }
  try {
    fleetHandle = fleetModule.init({
      config,
      jobs,
      discovery,
      emit,
      log: (m) => config.log(`[fleet] ${m}`),
      hubVersion: ipc.hubVersion(),
    });
    fleetHandle.ready
      .then((r) => config.log(`fleet: ${r.ok ? `listening on :${r.port}` : "did not start"} (id ${r.id})`))
      .catch(() => {});
    return fleetModule;
  } catch (e) {
    config.log(`fleet: could not start — ${e.message}`);
    fleetHandle = null;
    return null;
  }
}

function stopFleet() {
  try {
    if (fleetModule && typeof fleetModule.close === "function") fleetModule.close();
  } catch (e) {
    config.log(`fleet close failed: ${e.message}`);
  }
  fleetHandle = null;
}

/** settings.fleet flipped → bring the fleet up or take it down, in place. */
function syncFleet(settings, emit) {
  const wanted = (settings || config.load()).fleet !== false;
  const running = Boolean(fleetHandle);
  if (wanted === running) return;
  if (wanted) startFleet(emit);
  else {
    stopFleet();
    config.log("fleet: stopped (setting turned off)");
  }
  ipc.emit({ type: "fleet-changed" });
}

function wire() {
  const emit = (evt) => {
    ipc.emit(evt);
    if (!evt) return;
    // v0.6: the fleet relays the progress of jobs a PEER asked this hub to run
    // back over that peer's session. This is the only place the whole hub's
    // event stream is visible, so the tap lives here rather than inside jobs.
    if (fleetModule) {
      try {
        fleetModule.onHubEvent(evt);
      } catch (e) {
        config.log(`fleet: relaying ${evt.type} failed — ${e.message}`);
      }
    }
    if (evt.type === "state-changed") updateTray();
    // v0.5: live status and stack phases both change what the tray should say
    if (evt.type === "connector-changed" || evt.type === "stack-progress") updateTraySoon();
  };

  github.init({ getToken: () => config.resolveToken(), cacheDir: config.cacheDir() });
  discovery.init({
    emit,
    // SPEC v0.2: per-app update policies run after every refresh
    afterRefresh: (apps) => jobs.applyUpdatePolicies({ apps }),
  });
  jobs.init({
    emit,
    relaunch: (newBinary) => {
      config.log(`relaunching after self-update${newBinary ? ` via ${newBinary}` : ""}`);
      quitting = true;
      // When the hub runs from an UNMANAGED location (hand-extracted copy),
      // plain app.relaunch() would restart the OLD binary — exec the freshly
      // installed one instead so the update actually takes effect.
      if (newBinary && require("fs").existsSync(newBinary)) {
        app.relaunch({ execPath: newBinary, args: [] });
      } else {
        app.relaunch();
      }
      app.exit(0);
    },
  });
  ipc.init({
    ipcMain: require("electron").ipcMain,
    BrowserWindow,
    shell,
    app,
    Notification, // v0.2: OS notifications for update-available
    onSettingsChanged: (settings) => {
      scheduleRefresh(settings);
      syncAutostart(settings); // v0.2: XDG autostart follows the setting
      syncCliShim(settings); // v0.3: ~/.local/bin/nx follows the setting
      syncFleet(settings, emit); // v0.6: the LAN listener follows the setting
    },
  });

  // v0.5: the bus first (so the very first getState() already knows about it),
  // then the stacks orchestrator on top of the same jobs/emit the GUI uses.
  startConnector(emit);
  stacks.init({
    jobs,
    connector: () => ipc.getConnectorModule(),
    config,
    emit,
    engine: () => ipc.getEngineModule(), // v0.6: adb-device triggers
  });
  // v0.6: the fleet last — it reads the discovery model and enqueues jobs, so
  // everything it talks to is already wired by the time it can accept a peer.
  startFleet(emit);
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", () => showWindow());

  config.ensureDir(config.dataDir());
  config.ensureDir(config.cacheDir());
  config.ensureDir(config.logsDir());
  config.log(`NX Hub starting — data ${config.dataDir()}, installRoot ${config.installRoot()}`);

  wire();

  app.on("before-quit", () => {
    quitting = true;
    e2e.stop();
    stopConnector();
    stopFleet(); // v0.6
  });

  // Closing the last window must not quit — we live in the tray.
  app.on("window-all-closed", () => {});

  app.whenReady().then(() => {
    const settings = config.load();
    createWindow({ minimized: startsMinimized(settings) });
    createTray();
    e2e.start({ getWindow });
    scheduleRefresh(settings);
    syncAutostart(settings);
    syncCliShim(settings);
    discovery
      .refresh({ force: false })
      .then(() => updateTray())
      .catch((e) => config.log(`initial refresh failed: ${e.message}`));

    app.on("activate", () => showWindow());
  });

  process.on("uncaughtException", (err) => config.log(`uncaught: ${err.stack || err.message}`));
  process.on("unhandledRejection", (err) => config.log(`unhandled rejection: ${(err && err.stack) || err}`));
}

main();
