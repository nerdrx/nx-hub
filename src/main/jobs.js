"use strict";
// NX Hub — install/uninstall job queue. One active job per app, cancellable.
// Pure node: no electron require (relaunch is injected by ipc/index).

const fs = require("fs");
const path = require("path");

const config = require("./config");
const githubMod = require("./github");
const stateStore = require("./state");
const discovery = require("./discovery");

const KEEP_FINISHED = 20;

let deps = {
  emit: () => {},
  engine: null, // injected in tests; otherwise lazily required
  relaunch: null, // injected by ipc/index (app.relaunch + app.exit)
  github: null,
  resolve: null, // (appId, artifactId) => {app, artifact}
};

let seq = 0;
const jobs = new Map(); // jobId → job
const queues = new Map(); // appId → { pending: [jobId], active: jobId|null }

function init(d = {}) {
  deps = Object.assign(deps, d);
  return module.exports;
}

function gh() {
  return deps.github || githubMod.client();
}

function resolve(appId, artifactId) {
  if (typeof deps.resolve === "function") return deps.resolve(appId, artifactId);
  return discovery.findArtifact(appId, artifactId);
}

/** The engines agent owns src/main/install/engine.js — load it lazily. */
function getEngine() {
  if (deps.engine) return deps.engine;
  if (typeof deps.engineLoader === "function") return deps.engineLoader(); // test hook
  try {
    // eslint-disable-next-line global-require
    return require("./install/engine");
  } catch (e) {
    const err = new Error(`Install engine unavailable: ${e.message}`);
    err.code = "ENOENGINE";
    throw err;
  }
}

function emit(evt) {
  try {
    deps.emit(evt);
  } catch (_) {
    /* never let a listener break a job */
  }
}

function publicJob(job) {
  return {
    id: job.id,
    jobId: job.id, // renderer normalizes j.id || j.jobId; emit both
    type: job.type,
    appId: job.appId,
    artifactId: job.artifactId,
    appName: job.appName,
    artifactLabel: job.artifactLabel,
    status: job.status,
    phase: job.phase,
    pct: job.pct,
    message: job.message,
    error: job.error || null,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
  };
}

function list() {
  return [...jobs.values()].map(publicJob);
}

function activeFor(appId) {
  const q = queues.get(appId);
  return q && q.active ? jobs.get(q.active) : null;
}

function progress(job, phase, pct, message) {
  job.phase = phase;
  job.pct = typeof pct === "number" ? Math.max(0, Math.min(100, Math.round(pct))) : job.pct;
  job.message = message || job.message;
  emit({
    type: "job-progress",
    jobId: job.id,
    appId: job.appId,
    artifactId: job.artifactId,
    phase: job.phase,
    pct: job.pct,
    message: job.message,
  });
}

/** assets/icon.png, used by the engines when an artifact has no icon of its own. */
function fallbackIcon() {
  const p = path.join(__dirname, "..", "..", "assets", "icon.png");
  return fs.existsSync(p) ? p : null;
}

function makeCtx(job, settings, overrides = {}) {
  return Object.assign(
    {
      dataDir: config.dataDir(),
      installRoot: config.installRoot(settings),
      settings,
      fallbackIcon: fallbackIcon(),
      log: (msg) => config.log(`[${job.type}:${job.appId}/${job.artifactId}] ${msg}`),
      emitProgress: (phase, pct, message) => progress(job, phase, pct, message),
      signal: job.controller.signal,
    },
    overrides
  );
}

function prune() {
  const finished = [...jobs.values()].filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled");
  finished.sort((a, b) => new Date(a.endedAt || 0) - new Date(b.endedAt || 0));
  while (finished.length > KEEP_FINISHED) {
    const j = finished.shift();
    jobs.delete(j.id);
  }
}

/**
 * Queue a job. One runs per app at a time; extra jobs for the same app wait.
 * @returns {string} jobId
 */
function enqueue(type, appId, artifactId) {
  const { app, artifact } = resolve(appId, artifactId);
  if (!app) throw new Error(`Unknown app: ${appId}`);
  if (!artifact) throw new Error(`Unknown artifact ${artifactId} for ${appId}`);

  const dup = [...jobs.values()].find(
    (j) => j.appId === app.id && j.artifactId === artifact.id && j.type === type && (j.status === "queued" || j.status === "running")
  );
  if (dup) return dup.id;

  seq += 1;
  const job = {
    id: `job-${seq}`,
    type,
    appId: app.id,
    artifactId: artifact.id,
    appName: app.name,
    artifactLabel: artifact.label,
    status: "queued",
    phase: type === "install" ? "download" : "install",
    pct: 0,
    message: "queued",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);

  if (!queues.has(app.id)) queues.set(app.id, { pending: [], active: null });
  queues.get(app.id).pending.push(job.id);
  emit({ type: "state-changed" });
  pump(app.id);
  return job.id;
}

function install(appId, artifactId) {
  return enqueue("install", appId, artifactId);
}
function uninstall(appId, artifactId) {
  return enqueue("uninstall", appId, artifactId);
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === "queued") {
    const q = queues.get(job.appId);
    if (q) q.pending = q.pending.filter((id) => id !== jobId);
    finish(job, "cancelled", "Cancelled");
    return true;
  }
  if (job.status === "running") {
    job.cancelRequested = true;
    try {
      job.controller.abort();
    } catch (_) {
      /* ignore */
    }
    return true;
  }
  return false;
}

function finish(job, status, message) {
  job.status = status;
  job.endedAt = new Date().toISOString();
  job.message = message || job.message;
  if (status === "done") {
    job.pct = 100;
    emit({ type: "job-done", jobId: job.id, appId: job.appId, artifactId: job.artifactId, message: job.message });
  } else {
    job.error = message || "failed";
    emit({
      type: "job-error",
      jobId: job.id,
      appId: job.appId,
      artifactId: job.artifactId,
      message: job.error,
    });
  }
  prune();
  emit({ type: "state-changed" });
}

async function pump(appId) {
  const q = queues.get(appId);
  if (!q || q.active) return;
  const nextId = q.pending.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job || job.status !== "queued") return pump(appId);

  q.active = job.id;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  emit({ type: "state-changed" });

  try {
    if (job.type === "install") await runInstall(job);
    else if (job.type === "uninstall") await runUninstall(job);
    else throw new Error(`Unknown job type ${job.type}`);
    if (job.status === "running") finish(job, "done", job.message || "done");
  } catch (e) {
    const aborted = job.cancelRequested || e.name === "AbortError" || /aborted/i.test(String(e.message));
    if (aborted) finish(job, "cancelled", "Cancelled");
    else {
      config.log(`job ${job.id} failed: ${e.stack || e.message}`);
      finish(job, "error", e.message || String(e));
    }
  } finally {
    q.active = null;
    setImmediate(() => pump(appId));
  }
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

function assetFromArtifact(artifact) {
  return {
    name: artifact.assetName,
    url: artifact.assetUrl,
    id: artifact.assetId,
    size: artifact.size,
  };
}

function siblingsFromArtifact(artifact) {
  if (!artifact.checksumUrl && !artifact.checksumId) return [];
  return [{ name: artifact.checksumName || `${artifact.assetName}.sha256`, url: artifact.checksumUrl, id: artifact.checksumId }];
}

async function runInstall(job) {
  const { app, artifact } = resolve(job.appId, job.artifactId);
  if (!app || !artifact) throw new Error("App or artifact disappeared — refresh and try again");
  if (!app.latest) throw new Error(`${app.name} has no release to install`);
  const settings = config.load();

  // 1. download
  const downloads = config.downloadsDir();
  config.ensureDir(downloads);
  const filePath = path.join(downloads, `${app.id}-${artifact.assetName}`);
  progress(job, "download", 0, `downloading ${artifact.assetName}`);
  await gh().downloadAsset(assetFromArtifact(artifact), filePath, {
    signal: job.controller.signal,
    siblings: siblingsFromArtifact(artifact),
    onProgress: (p) => progress(job, p.phase || "download", p.pct, p.message),
  });
  if (job.cancelRequested) throw new Error("aborted");

  // SPEC: core sets artifact.version before handing off to the engine
  artifact.version = app.latest.version;

  // 2. install
  let result;
  if (app.id === "nx-hub") {
    result = await runSelfUpdate(job, { app, artifact, filePath, settings });
  } else {
    let engine = null;
    try {
      engine = getEngine();
    } catch (e) {
      // download-only assets need no engine — stay useful without one
      if (artifact.kind !== "generic-zip") throw e;
      config.log(`no engine available; handling ${artifact.kind} in core`);
    }
    if (engine) {
      progress(job, "install", 0, `installing ${artifact.label}`);
      result = await engine.install({ app, artifact, filePath, ctx: makeCtx(job, settings) });
    } else {
      result = saveDownloadOnly(job, artifact, filePath, settings, app);
    }
  }
  if (!result || typeof result !== "object") result = {};

  // 3. record
  stateStore.recordInstall(app.id, artifact.id, {
    version: result.version || app.latest.version,
    path: result.path || null,
    launchable: result.launchable !== false,
    iconPath: result.iconPath || null,
    installedAt: new Date().toISOString(),
  });

  // 4. cleanup
  progress(job, "cleanup", 100, "cleaning up");
  safeUnlink(filePath); // the engine copied whatever it needed out of downloads/
  try {
    discovery.remerge();
  } catch (_) {
    /* cache may be empty in tests */
  }
  // the engine may return its own note (tarball-prefix records one in the manifest)
  const note = result.postInstallNote || artifact.postInstallNote || null;
  job.message = note ? `Installed. ${note}` : `Installed ${app.name} ${app.latest.version}`;
  if (note) emit({ type: "toast", level: "info", message: note });
  return result;
}

/**
 * Fallback for "generic-zip" when no install engine is present: park the asset
 * next to where the engine would put it (<installRoot>/nx/downloads), no entry.
 */
function saveDownloadOnly(job, artifact, filePath, settings) {
  const dest = path.join(config.installRoot(settings), "nx", "downloads", artifact.assetName);
  config.ensureDir(path.dirname(dest));
  progress(job, "install", 50, `saving to ${dest}`);
  moveFile(filePath, dest);
  return { version: artifact.version, path: dest, launchable: false, downloadPath: dest };
}

/**
 * Self-update: install into a staging root, then swap the real install dir
 * (rename-old → move-new → delete-old) and relaunch.
 */
async function runSelfUpdate(job, { app, artifact, filePath, settings }) {
  const engine = getEngine();
  const staging = path.join(config.dataDir(), "self-update");
  rmrf(staging);
  config.ensureDir(staging);
  progress(job, "install", 0, "staging new hub build");
  const staged = await engine.install({ app, artifact, filePath, ctx: makeCtx(job, settings, { installRoot: staging }) });
  const stagedPath = (staged && staged.path) || path.join(staging, "nx", app.id, artifact.id);

  const target = config.installPathFor(settings, app.id, artifact.id);
  const old = `${target}.old-${Date.now()}`;
  progress(job, "install", 70, "swapping hub install");
  config.ensureDir(path.dirname(target));
  if (fs.existsSync(target)) fs.renameSync(target, old);
  moveDir(stagedPath, target);
  rmrf(old);
  rmrf(staging);

  emit({ type: "toast", level: "info", message: "Hub updated — restarting…" });
  progress(job, "cleanup", 100, "restarting");
  if (typeof deps.relaunch === "function") {
    setTimeout(() => {
      try {
        deps.relaunch();
      } catch (e) {
        config.log(`relaunch failed: ${e.message}`);
      }
    }, 400);
  }
  return { version: (staged && staged.version) || app.latest.version, path: target, launchable: true };
}

/* ------------------------------------------------------------------ */
/* uninstall + launch                                                  */
/* ------------------------------------------------------------------ */

async function runUninstall(job) {
  const { app, artifact } = resolve(job.appId, job.artifactId);
  if (!app || !artifact) throw new Error("App or artifact disappeared — refresh and try again");
  const settings = config.load();
  const rec = stateStore.getInstall(job.appId, job.artifactId);
  const installedPath = (rec && rec.path) || (artifact.installed && artifact.installed.path) || null;

  progress(job, "install", 10, `removing ${artifact.label}`);
  let engine = null;
  try {
    engine = getEngine();
  } catch (e) {
    if (artifact.kind !== "generic-zip") throw e;
  }
  if (engine) await engine.uninstall({ app, artifact, installedPath, ctx: makeCtx(job, settings) });
  else if (installedPath) safeUnlink(installedPath);
  stateStore.removeInstall(job.appId, job.artifactId);
  try {
    discovery.remerge();
  } catch (_) {
    /* ignore */
  }
  progress(job, "cleanup", 100, "removed");
  job.message = `Removed ${app.name} — ${artifact.label}`;
}

/** Launch is immediate (not queued) — SPEC: window.nxhub.launch → engine.launch. */
async function launch(appId, artifactId) {
  const { app, artifact } = resolve(appId, artifactId);
  if (!app || !artifact) throw new Error(`Unknown artifact ${appId}/${artifactId}`);
  const settings = config.load();
  const rec = stateStore.getInstall(app.id, artifact.id);
  const installedPath = (rec && rec.path) || (artifact.installed && artifact.installed.path) || null;
  const engine = getEngine();
  const ctx = {
    dataDir: config.dataDir(),
    installRoot: config.installRoot(settings),
    settings,
    fallbackIcon: fallbackIcon(),
    log: (msg) => config.log(`[launch:${app.id}/${artifact.id}] ${msg}`),
    emitProgress: () => {},
    signal: undefined,
  };
  config.log(`launch ${app.id}/${artifact.id}`);
  return engine.launch({ app, artifact, installedPath, ctx });
}

/* ------------------------------------------------------------------ */

function safeUnlink(p) {
  try {
    if (p) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

function rmrf(p) {
  try {
    if (p) fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.copyFileSync(src, dest);
    safeUnlink(src);
  }
}

function moveDir(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true });
    rmrf(src);
  }
}

/** test hook */
function _reset() {
  jobs.clear();
  queues.clear();
  seq = 0;
}

module.exports = {
  init,
  enqueue,
  install,
  uninstall,
  launch,
  cancelJob,
  list,
  activeFor,
  getEngine,
  _reset,
  _jobs: jobs,
};
