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

// Auto-install ("install" policy) attempts, one per app+artifact+version —
// a failed background install must not retry (and re-toast) every refresh.
const policyAttempts = new Set();

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

/**
 * SPEC v0.2 `maxConcurrentDownloads`: a counting semaphore around the transfer
 * itself. Installs stay serialised per app (the queues above); this only caps
 * how many downloads run at the same time ACROSS apps.
 */
const downloads = { limit: 0, active: 0, waiters: [] };

function setDownloadLimit(n) {
  const limit = Number(n);
  if (!Number.isFinite(limit) || limit < 1) return downloads.limit;
  downloads.limit = Math.floor(limit);
  drainDownloadWaiters();
  return downloads.limit;
}

function drainDownloadWaiters() {
  while (downloads.active < downloads.limit && downloads.waiters.length) {
    downloads.active += 1;
    const next = downloads.waiters.shift();
    next();
  }
}

async function acquireDownloadSlot() {
  if (downloads.limit < 1) setDownloadLimit(config.load().maxConcurrentDownloads || 2);
  if (downloads.active < downloads.limit) {
    downloads.active += 1;
    return;
  }
  await new Promise((resolve) => downloads.waiters.push(resolve));
}

function releaseDownloadSlot() {
  downloads.active = Math.max(0, downloads.active - 1);
  drainDownloadWaiters();
}

/** Run `fn` holding one download slot. */
async function withDownloadSlot(fn) {
  await acquireDownloadSlot();
  try {
    return await fn();
  } finally {
    releaseDownloadSlot();
  }
}

function downloadStats() {
  return { limit: downloads.limit, active: downloads.active, waiting: downloads.waiters.length };
}

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
      // v0.2: this app's prefs (launchArgs / launchEnv / …) travel with the ctx
      appPrefs: config.getAppPref(settings, job.appId),
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
function enqueue(type, appId, artifactId, opts = {}) {
  const { app, artifact } = resolve(appId, artifactId);
  if (!app) throw new Error(`Unknown app: ${appId}`);
  if (!artifact) throw new Error(`Unknown artifact ${artifactId} for ${appId}`);

  const tag = opts.tag ? String(opts.tag) : null;
  const dup = [...jobs.values()].find(
    (j) =>
      j.appId === app.id &&
      j.artifactId === artifact.id &&
      j.type === type &&
      (j.tag || null) === tag &&
      (j.status === "queued" || j.status === "running")
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
    tag, // v0.2: installVersion target ("" / null = the app's latest)
    origin: opts.origin === "policy" ? "policy" : "user",
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

function install(appId, artifactId, opts = {}) {
  return enqueue("install", appId, artifactId, opts);
}
function uninstall(appId, artifactId) {
  return enqueue("uninstall", appId, artifactId);
}
/** SPEC v0.2: install ANY published version (the UI confirms downgrades). */
function installVersion(appId, artifactId, tag) {
  if (!tag) return install(appId, artifactId);
  return enqueue("install", appId, artifactId, { tag });
}
/** SPEC v0.2: restore the kept `<installdir>.prev`. */
function rollback(appId, artifactId) {
  return enqueue("rollback", appId, artifactId);
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
      // Background-policy failures are logged and badged, never toasted.
      silent: job.origin === "policy",
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
    else if (job.type === "rollback") await runRollback(job);
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

/**
 * v0.2: an install can target any release. The live artifact keeps its identity
 * (id, kind, overlay hints) — only the ASSET fields come from the chosen
 * release, matched by artifact id / assetPattern against that release's assets.
 */
function retargetArtifact(app, artifact, tag) {
  const release = discovery.findRelease(app.id, tag);
  if (!release) throw new Error(`${app.name} has no release tagged ${tag}`);
  const match = discovery.matchArtifactInRelease(app.id, artifact.id, release, artifact);
  if (!match) {
    throw new Error(`Release ${release.tag_name} has no download matching "${artifact.label}"`);
  }
  const version = discovery.parseVersion(release.tag_name);
  const target = Object.assign({}, artifact, {
    assetName: match.assetName,
    assetUrl: match.assetUrl,
    assetId: match.assetId,
    size: match.size,
    checksumName: match.checksumName || null,
    checksumUrl: match.checksumUrl || null,
    checksumId: match.checksumId || null,
    version,
  });
  return { target, release, version };
}

async function runInstall(job) {
  const { app, artifact: liveArtifact } = resolve(job.appId, job.artifactId);
  if (!app || !liveArtifact) throw new Error("App or artifact disappeared — refresh and try again");
  const settings = config.load();
  setDownloadLimit(settings.maxConcurrentDownloads);

  // pick the release to install: an explicit tag (installVersion) or the
  // artifact's own source release (which may be older than app.latest when a
  // release only patched a different platform)
  let artifact = liveArtifact;
  let version = liveArtifact.sourceVersion || (app.latest ? app.latest.version : null);
  if (job.tag) {
    const retargeted = retargetArtifact(app, liveArtifact, job.tag);
    artifact = retargeted.target;
    version = retargeted.version;
    job.targetVersion = version;
  } else if (!app.latest) {
    throw new Error(`${app.name} has no release to install`);
  }

  // 1. download (or reuse what the "download" update policy already fetched)
  const downloads = config.downloadsDir();
  config.ensureDir(downloads);
  const filePath = path.join(downloads, `${app.id}-${artifact.assetName}`);
  const cached = stateStore.getDownload(app.id, liveArtifact.id);
  const reusable =
    cached && cached.path === filePath && String(cached.version) === String(version) && fs.existsSync(filePath);

  if (reusable) {
    progress(job, "download", 100, `using the downloaded ${artifact.assetName}`);
  } else {
    progress(job, "download", 0, `downloading ${artifact.assetName}`);
    await withDownloadSlot(() =>
      gh().downloadAsset(assetFromArtifact(artifact), filePath, {
        signal: job.controller.signal,
        siblings: siblingsFromArtifact(artifact),
        onProgress: (p) => progress(job, p.phase || "download", p.pct, p.message),
      })
    );
  }
  if (job.cancelRequested) throw new Error("aborted");

  // SPEC: core sets artifact.version before handing off to the engine
  artifact.version = version;

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
    version: result.version || version,
    path: result.path || null,
    launchable: result.launchable !== false,
    iconPath: result.iconPath || null,
    installedAt: new Date().toISOString(),
  });

  // 4. cleanup
  progress(job, "cleanup", 100, "cleaning up");
  safeUnlink(filePath); // the engine copied whatever it needed out of downloads/
  stateStore.removeDownload(app.id, artifact.id); // the pre-download was consumed
  try {
    discovery.remerge();
  } catch (_) {
    /* cache may be empty in tests */
  }
  // the engine may return its own note (tarball-prefix records one in the manifest)
  const note = result.postInstallNote || artifact.postInstallNote || null;
  job.message = note ? `Installed. ${note}` : `Installed ${app.name} ${version}`;
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

  // The staged engine install wrote its desktop entry pointing INTO the
  // staging dir, which no longer exists after the swap — rewrite every staged
  // path in it to the final location or the menu entry dangles.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".nx-manifest.json"), "utf8"));
    for (const entry of manifest.desktopEntries || []) {
      if (!fs.existsSync(entry)) continue;
      const txt = fs.readFileSync(entry, "utf8");
      fs.writeFileSync(entry, txt.split(stagedPath).join(target));
    }
  } catch (e) {
    config.log(`self-update: desktop entry rewrite skipped — ${e.message}`);
  }

  emit({ type: "toast", level: "info", message: "Hub updated — restarting…" });
  progress(job, "cleanup", 100, "restarting");
  if (typeof deps.relaunch === "function") {
    const newBinary = path.join(target, "AppRun");
    setTimeout(() => {
      try {
        deps.relaunch(fs.existsSync(newBinary) ? newBinary : undefined);
      } catch (e) {
        config.log(`relaunch failed: ${e.message}`);
      }
    }, 400);
  }
  return {
    version: (staged && staged.version) || artifact.version || (app.latest && app.latest.version) || null,
    path: target,
    launchable: true,
  };
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

/**
 * SPEC v0.2 rollback: hand the kept `<installdir>.prev` back to the engine,
 * then record the restored version. Runs through the per-app queue like any
 * other job, so it can never race an install of the same app.
 */
async function runRollback(job) {
  const { app, artifact } = resolve(job.appId, job.artifactId);
  if (!app || !artifact) throw new Error("App or artifact disappeared — refresh and try again");
  const settings = config.load();
  const rec = stateStore.getInstall(job.appId, job.artifactId);
  const installedPath = (rec && rec.path) || (artifact.installed && artifact.installed.path) || null;

  const engine = getEngine();
  if (typeof engine.rollback !== "function") throw new Error("This build cannot roll installs back");

  progress(job, "install", 20, `restoring the previous ${artifact.label}`);
  const result = (await engine.rollback({ app, artifact, installedPath, ctx: makeCtx(job, settings) })) || {};

  const version = result.version != null ? result.version : artifact.prevVersion || null;
  stateStore.recordInstall(app.id, artifact.id, {
    version,
    path: result.path || installedPath || null,
    launchable: result.launchable !== false,
    installedAt: new Date().toISOString(),
  });
  try {
    discovery.remerge();
  } catch (_) {
    /* cache may be empty in tests */
  }
  progress(job, "cleanup", 100, "restored");
  job.message = `Restored ${app.name}${version ? ` ${version}` : ""}`;
  return result;
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
    // v0.2: launchArgs / launchEnv for this app reach the engine through ctx
    appPrefs: config.getAppPref(settings, app.id),
    fallbackIcon: fallbackIcon(),
    log: (msg) => config.log(`[launch:${app.id}/${artifact.id}] ${msg}`),
    emitProgress: () => {},
    signal: undefined,
  };
  config.log(`launch ${app.id}/${artifact.id}`);
  return engine.launch({ app, artifact, installedPath, ctx });
}

/* ------------------------------------------------------------------ */
/* v0.2: update policies                                               */
/* ------------------------------------------------------------------ */

/** Pre-fetch an artifact's asset into the download cache ("download" policy). */
async function predownload(app, artifact, version) {
  const dir = config.downloadsDir();
  config.ensureDir(dir);
  const filePath = path.join(dir, `${app.id}-${artifact.assetName}`);
  const already = stateStore.getDownload(app.id, artifact.id);
  if (already && already.path === filePath && String(already.version) === String(version) && fs.existsSync(filePath)) {
    return { path: filePath, cached: true };
  }
  await withDownloadSlot(() =>
    gh().downloadAsset(assetFromArtifact(artifact), filePath, {
      siblings: siblingsFromArtifact(artifact),
      onProgress: () => {},
    })
  );
  stateStore.recordDownload(app.id, artifact.id, { version, path: filePath, assetName: artifact.assetName });
  return { path: filePath, cached: false };
}

/**
 * Apply the effective update policy (appPrefs → global) to every artifact with
 * an update pending. Called after EVERY discovery refresh, scheduled or manual.
 *
 *  "notify"   → emit `update-available` once per (app, version); the OS
 *               notification itself is the ipc/index layer's job (electron
 *               must not leak into these modules).
 *  "download" → fetch the asset into the cache and flag readyToInstall.
 *  "install"  → queue a normal install (serialised per app by the queue).
 *
 * Never throws: one broken app must not stop the others.
 */
async function applyUpdatePolicies(opts = {}) {
  const settings = opts.settings || config.load();
  setDownloadLimit(settings.maxConcurrentDownloads);
  const apps = opts.apps || discovery.getCached().apps || [];
  const result = { notified: [], downloaded: [], installing: [], errors: [] };

  for (const app of apps) {
    if (!app || !app.latest) continue;
    if (app.localHidden) continue; // the user hid it — stay quiet
    const policy = config.effectiveUpdatePolicy(settings, app.id);
    const version = app.latest.version;

    for (const artifact of app.artifacts || []) {
      if (!artifact.updateAvailable) continue;
      const target = { appId: app.id, appName: app.name, artifactId: artifact.id, version };
      try {
        if (policy === "install") {
          // Preconditions the background engine must respect: never attempt a
          // sideload with no device attached (seen in the field: an error
          // toast every refresh cycle), and never auto-retry a version that
          // already failed once — the card badge keeps carrying the update,
          // and a user-initiated install always remains possible.
          if (artifact.kind === "apk-adb" && artifact.deviceOffline) continue;
          const attemptKey = `${app.id}::${artifact.id}::${version}`;
          if (policyAttempts.has(attemptKey)) continue;
          if (activeFor(app.id) && activeFor(app.id).artifactId === artifact.id) continue;
          policyAttempts.add(attemptKey);
          const jobId = install(app.id, artifact.id, { origin: "policy" });
          result.installing.push(Object.assign({ jobId }, target));
          continue;
        }

        if (policy === "download") {
          const { cached } = await predownload(app, artifact, version);
          artifact.readyToInstall = true;
          artifact.readyPath = path.join(config.downloadsDir(), `${app.id}-${artifact.assetName}`);
          if (!cached) result.downloaded.push(target);
          continue;
        }

        // "notify" (default) — once per app+version, persisted in state.json
        if (stateStore.wasNotified(app.id, version)) continue;
        stateStore.markNotified(app.id, version);
        result.notified.push(target);
        emit({ type: "update-available", appId: app.id, appName: app.name, artifactId: artifact.id, version });
      } catch (e) {
        config.log(`update policy (${policy}) failed for ${app.id}/${artifact.id}: ${e.message}`);
        result.errors.push(Object.assign({ message: e.message }, target));
      }
    }
  }

  if (result.downloaded.length) {
    try {
      discovery.remerge();
    } catch (_) {
      /* cache may be empty in tests */
    }
    emit({ type: "state-changed" });
  }
  return result;
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
  downloads.limit = 0;
  downloads.active = 0;
  downloads.waiters.length = 0;
}

module.exports = {
  init,
  enqueue,
  install,
  installVersion,
  uninstall,
  rollback,
  launch,
  cancelJob,
  list,
  activeFor,
  getEngine,
  applyUpdatePolicies,
  setDownloadLimit,
  downloadStats,
  withDownloadSlot,
  _reset,
  _jobs: jobs,
};
