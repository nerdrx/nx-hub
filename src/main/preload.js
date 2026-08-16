"use strict";
// NX Hub — contextBridge surface. Frozen shape, see SPEC "window.nxhub".

const { contextBridge, ipcRenderer } = require("electron");

const EVENT_CHANNEL = "nxhub:event";

const api = {
  getState: () => ipcRenderer.invoke("nxhub:getState"),
  refresh: (force) => ipcRenderer.invoke("nxhub:refresh", Boolean(force)),
  install: (appId, artifactId) => ipcRenderer.invoke("nxhub:install", appId, artifactId),
  uninstall: (appId, artifactId) => ipcRenderer.invoke("nxhub:uninstall", appId, artifactId),
  launch: (appId, artifactId) => ipcRenderer.invoke("nxhub:launch", appId, artifactId),
  cancelJob: (jobId) => ipcRenderer.invoke("nxhub:cancelJob", jobId),
  setSettings: (patch) => ipcRenderer.invoke("nxhub:setSettings", patch),
  openExternal: (url) => ipcRenderer.invoke("nxhub:openExternal", url),
  showInFolder: (p) => ipcRenderer.invoke("nxhub:showInFolder", p),

  // ---- v0.2 (SPEC "window.nxhub additions") ----
  getReleases: (appId) => ipcRenderer.invoke("nxhub:getReleases", appId),
  installVersion: (appId, artifactId, tag) => ipcRenderer.invoke("nxhub:installVersion", appId, artifactId, tag),
  rollback: (appId, artifactId) => ipcRenderer.invoke("nxhub:rollback", appId, artifactId),
  setAppPref: (appId, patch) => ipcRenderer.invoke("nxhub:setAppPref", appId, patch),
  adbConnect: (hostPort) => ipcRenderer.invoke("nxhub:adbConnect", hostPort),
  adbSelectDevice: (serial) => ipcRenderer.invoke("nxhub:adbSelectDevice", serial),
  getDeviceInfo: () => ipcRenderer.invoke("nxhub:getDeviceInfo"),
  getDiskUsage: (force) => ipcRenderer.invoke("nxhub:getDiskUsage", Boolean(force)),
  clearDownloadCache: () => ipcRenderer.invoke("nxhub:clearDownloadCache"),
  getLogs: (tailLines) => ipcRenderer.invoke("nxhub:getLogs", tailLines),
  exportSettings: () => ipcRenderer.invoke("nxhub:exportSettings"),
  importSettings: (json) => ipcRenderer.invoke("nxhub:importSettings", json),
  runPostInstallCmd: (appId, artifactId) => ipcRenderer.invoke("nxhub:runPostInstallCmd", appId, artifactId),

  // ---- v0.5 (SPEC "NX Connector → IPC additions") ----
  getConnector: () => ipcRenderer.invoke("nxhub:getConnector"),
  getStacks: () => ipcRenderer.invoke("nxhub:getStacks"),
  saveStack: (stack) => ipcRenderer.invoke("nxhub:saveStack", stack),
  deleteStack: (id) => ipcRenderer.invoke("nxhub:deleteStack", id),
  runStack: (id) => ipcRenderer.invoke("nxhub:runStack", id),
  stopStack: (id) => ipcRenderer.invoke("nxhub:stopStack", id),

  // ---- v0.6 (SPEC "Fleet → IPC") ----
  // Events that come back on onEvent: `fleet-changed` (peers/summaries moved),
  // `fleet-pair-code` ({code, expiresAt}), `fleet-progress` (a remote job's
  // progress, tagged with peerId).
  getFleet: () => ipcRenderer.invoke("nxhub:getFleet"),
  fleetShowCode: () => ipcRenderer.invoke("nxhub:fleetShowCode"),
  fleetPair: (host, code, port) => ipcRenderer.invoke("nxhub:fleetPair", host, code, port),
  fleetUnpair: (peerId) => ipcRenderer.invoke("nxhub:fleetUnpair", peerId),
  fleetInstall: (peerId, appId, artifactId) => ipcRenderer.invoke("nxhub:fleetInstall", peerId, appId, artifactId),
  fleetLaunch: (peerId, appId, artifactId) => ipcRenderer.invoke("nxhub:fleetLaunch", peerId, appId, artifactId),
  fleetUpdateAll: (peerId) => ipcRenderer.invoke("nxhub:fleetUpdateAll", peerId),

  // ---- v0.7 [fleet-fabric] (SPEC "WOL + peer MAC") ----
  // Wake a sleeping peer over the LAN. → {ok, sent, peerId, name, mac} or
  // {ok:false, reason:"no-mac"} when no session ever taught this hub the
  // peer's hardware address. `ok` means "the packets went out", not "it woke":
  // watch the peer's `online` in the next getFleet() for that.
  fleetWake: (peerId) => ipcRenderer.invoke("nxhub:fleetWake", peerId),

  // ---- v0.8 [recorder] (SPEC "Flight recorder") ----
  // getEvents({since, until, type, appId, limit}) → the Activity timeline,
  // NEWEST FIRST: [{ts, type, appId?, artifactId?, peerId?, stackId?, summary,
  // data?}]. `since`/`until` take epoch ms or the CLI's own strings ("24h",
  // "2d", "2026-08-15"); `type` takes one type, a comma list or an array;
  // `limit` defaults to 200 and is clamped to 1000 in the main process.
  getEvents: (q) => ipcRenderer.invoke("nxhub:getEvents", q || {}),

  // ---- v0.7 [dev-tools] (SPEC "nx dev") ----
  // getDevLinks() → [{appId, name, path, launchCmd, exists, known, appName}]
  getDevLinks: () => ipcRenderer.invoke("nxhub:getDevLinks"),
  devRun: (appId) => ipcRenderer.invoke("nxhub:devRun", appId),
  devUnlink: (appId) => ipcRenderer.invoke("nxhub:devUnlink", appId),

  // ---- v0.8 [timemachine] (SPEC "Config time machine") ----
  // getSnapshots(appId) → [{file, ts, version, reason, bytes}], newest first.
  // `file` is a bare archive name and the only thing the other two accept.
  // restoreSnapshot unpacks it over $HOME after snapshotting the current
  // config as "pre-restore" → {ok, file, restored:[paths], preRestore}.
  // deleteSnapshot → {ok, file, snapshots} (the fresh list, no round trip).
  getSnapshots: (appId) => ipcRenderer.invoke("nxhub:getSnapshots", appId),
  restoreSnapshot: (appId, file) => ipcRenderer.invoke("nxhub:restoreSnapshot", appId, file),
  deleteSnapshot: (appId, file) => ipcRenderer.invoke("nxhub:deleteSnapshot", appId, file),

  onEvent: (cb) => {
    if (typeof cb !== "function") return () => {};
    const handler = (_event, payload) => {
      try {
        cb(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("nxhub.onEvent handler threw", err);
      }
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("nxhub", api);
