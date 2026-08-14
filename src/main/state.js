"use strict";
// NX Hub — installed-state store (state.json). Atomic writes, no electron.

const config = require("./config");

function normalize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  // never alias a shared default — callers mutate the returned object
  const installed = s.installed && typeof s.installed === "object" ? s.installed : {};
  return { version: 1, installed };
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

module.exports = { load, save, getInstall, getApp, recordInstall, removeInstall, listInstalls };
