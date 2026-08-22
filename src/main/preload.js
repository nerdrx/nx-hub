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

  // ---- v0.10 [audit] (SPEC "Deep audit") ----
  // getAudit(appId?) → [{appId, artifactId, ok, kind, version, path,
  // deviceResident, problems:[{kind, path?, detail}], notes:[…]}], one row per
  // recorded install. `problems` is empty exactly when `ok`.
  // Problem kinds: missing-dir · bad-manifest · missing-binary · not-executable
  // · missing-file · missing-desktop-entry · hash-mismatch. Never rejects.
  // deviceResident rows (apk-adb) come back ok with a note: their files live on
  // a headset, so "ok" means "nothing here to check", not "verified".
  // repairInstall(appId, artifactId) → a JOB ID: an ordinary install job, so
  // it streams the same job-progress/job-done events as any other install.
  getAudit: (appId) => ipcRenderer.invoke("nxhub:getAudit", appId || null),
  repairInstall: (appId, artifactId) => ipcRenderer.invoke("nxhub:repairInstall", appId, artifactId),

  // ---- v0.10 [replay] (SPEC "Ecosystem checkpoints") ----
  // getCheckpoint(when) → {ts, iso, apps:[{appId, appName, artifactId, version,
  // currentVersion, action: none|install|remove, tag, snapshot, snapshotAt,
  // uncertain, why, skipReason}], uncertain, actionable, skipped, horizon}.
  // `when` takes epoch ms or the recorder's strings ("24h", "2d", "2026-08-15").
  // `version` is what was installed THEN — null means "not installed then", or
  // "unknown" when `uncertain` is set (those rows are never acted on).
  // A checkpoint on `now` comes back with an empty `apps`.
  // restoreCheckpoint(when, {configs}) resolves with the verdict {ok, ts,
  // results, counts} once the whole plan has run; follow it live on onEvent
  // through `checkpoint-progress` {phase: planning|installing|removing|
  // restoring-config|done|failed, appId, artifactId} — the run's own verdict
  // carries appId: null. One restore at a time (a second call rejects).
  getCheckpoint: (when) => ipcRenderer.invoke("nxhub:getCheckpoint", when),
  restoreCheckpoint: (when, opts) => ipcRenderer.invoke("nxhub:restoreCheckpoint", when, opts || {}),

  // ---- v0.11 [stopper] (SPEC "Stopping one app") ----
  // getState().running is the companion read: [{appId, appName, artifactId|null,
  // version, pid|null, since, source: "hub"|"bus"|"both", canStop}], newest
  // first, ALWAYS an array — one row per (appId, artifactId).
  // stopApp(appId, artifactId?, {peer}?) → {ok, how, pid, appId, artifactId,
  // appName} where how ∈ shutdown-request | sigterm | remote | gone |
  // not-running. `gone` means the process had already ended: a success, not an
  // error. `not-running` (ok:false) means there was nothing to stop. One call,
  // no confirmation — stopping is not destructive, and never SIGKILLs.
  stopApp: (appId, artifactId, opts) => ipcRenderer.invoke("nxhub:stopApp", appId, artifactId || null, opts || {}),

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
