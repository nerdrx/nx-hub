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
const e2e = require("./e2e");

const ROOT = path.join(__dirname, "..", "..");
const RENDERER = path.join(ROOT, "src", "renderer", "index.html");
const ICON_PNG = path.join(ROOT, "assets", "icon.png");
const TRAY_PNG = path.join(ROOT, "assets", "tray.png");

let mainWindow = null;
let tray = null;
let refreshTimer = null;
let quitting = false;

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

function createWindow({ minimized = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
  else mainWindow.once("ready-to-show", () => mainWindow.show());

  // Close → hide to tray. Real quit goes through before-quit.
  mainWindow.on("close", (e) => {
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
      items.push({
        label: entries.filter((x) => x.appId === entry.appId).length > 1 ? `${entry.appName} — ${entry.label}` : entry.appName,
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

function wire() {
  const emit = (evt) => {
    ipc.emit(evt);
    if (evt && evt.type === "state-changed") updateTray();
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
    },
  });
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
