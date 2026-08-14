"use strict";
// NX Hub — installed-state store (state.json). Atomic writes, no electron.

const config = require("./config");

function normalize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  // never alias a shared default — callers mutate the returned object
  const installed = s.installed && typeof s.installed === "object" ? s.installed : {};
  // v0.2: last update-notification per app (once per app+version) and assets
  // pre-downloaded by the "download" update policy.
  const notified = s.notified && typeof s.notified === "object" ? s.notified : {};
  const downloads = s.downloads && typeof s.downloads === "object" ? s.downloads : {};
  return { version: 1, installed, notified, downloads };
}

function load() {
  return normalize(config.readJson(config.statePath(), null));
}

function save(state) {
  const next = normalize(state);
  config.writeJsonAtomic(config.statePath(), next);
  return next;
}

/** @returns {{version:string,path:string,installedAt:string}|null} */
function getInstall(appId, artifactId, state) {
  const s = state || load();
  const app = s.installed[appId];
  if (!app) return null;
  return app[artifactId] || null;
}

/** All installs for an app: { artifactId: record } */
function getApp(appId, state) {
  const s = state || load();
  return s.installed[appId] || {};
}

function recordInstall(appId, artifactId, record) {
  const s = load();
  if (!s.installed[appId]) s.installed[appId] = {};
  s.installed[appId][artifactId] = {
    version: record && record.version != null ? String(record.version) : null,
    path: record && record.path ? record.path : null,
    installedAt: (record && record.installedAt) || new Date().toISOString(),
  };
  if (record && record.launchable != null) s.installed[appId][artifactId].launchable = Boolean(record.launchable);
  if (record && record.extra && typeof record.extra === "object") {
    s.installed[appId][artifactId].extra = record.extra;
  }
  save(s);
  return s.installed[appId][artifactId];
}

function removeInstall(appId, artifactId) {
  const s = load();
  if (s.installed[appId]) {
    delete s.installed[appId][artifactId];
    if (Object.keys(s.installed[appId]).length === 0) delete s.installed[appId];
  }
  save(s);
  return s;
}

/** Flat list of installs: [{appId, artifactId, ...record}] */
function listInstalls(state) {
  const s = state || load();
  const out = [];
  for (const appId of Object.keys(s.installed)) {
    for (const artifactId of Object.keys(s.installed[appId] || {})) {
      out.push(Object.assign({ appId, artifactId }, s.installed[appId][artifactId]));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* v0.2: update-notification bookkeeping                               */
/* ------------------------------------------------------------------ */

/** Did we already notify about this exact (app, version)? */
function wasNotified(appId, version, state) {
  const s = state || load();
  const rec = s.notified[appId];
  return Boolean(rec && version != null && String(rec.version) === String(version));
}

function markNotified(appId, version) {
  const s = load();
  s.notified[appId] = { version: version == null ? null : String(version), at: new Date().toISOString() };
  save(s);
  return s.notified[appId];
}

function clearNotified(appId) {
  const s = load();
  if (appId) delete s.notified[appId];
  else s.notified = {};
  save(s);
  return s.notified;
}

/* ------------------------------------------------------------------ */
/* v0.2: pre-downloaded assets (updatePolicy "download")               */
/* ------------------------------------------------------------------ */

function recordDownload(appId, artifactId, record) {
  const s = load();
  if (!s.downloads[appId]) s.downloads[appId] = {};
  s.downloads[appId][artifactId] = {
    version: record && record.version != null ? String(record.version) : null,
    path: (record && record.path) || null,
    assetName: (record && record.assetName) || null,
    at: (record && record.at) || new Date().toISOString(),
  };
  save(s);
  return s.downloads[appId][artifactId];
}

function getDownload(appId, artifactId, state) {
  const s = state || load();
  const forApp = s.downloads[appId];
  if (!forApp) return null;
  return forApp[artifactId] || null;
}

function removeDownload(appId, artifactId) {
  const s = load();
  if (s.downloads[appId]) {
    delete s.downloads[appId][artifactId];
    if (Object.keys(s.downloads[appId]).length === 0) delete s.downloads[appId];
  }
  save(s);
  return s;
}

function clearDownloads() {
  const s = load();
  s.downloads = {};
  save(s);
  return s;
}

module.exports = {
  load,
  save,
  getInstall,
  getApp,
  recordInstall,
  removeInstall,
  listInstalls,
  wasNotified,
  markNotified,
  clearNotified,
  recordDownload,
  getDownload,
  removeDownload,
  clearDownloads,
};
