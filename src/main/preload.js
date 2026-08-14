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
