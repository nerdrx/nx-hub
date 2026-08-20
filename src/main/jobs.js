"use strict";
// NX Hub — install/uninstall job queue. One active job per app, cancellable.
// Pure node: no electron require (relaunch is injected by ipc/index).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const config = require("./config");
const githubMod = require("./github");
const stateStore = require("./state");
const discovery = require("./discovery");
const provenance = require("./provenance");

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
    // v0.10: the facts only the run itself knows, filled in by run*() below and
    // handed to the journal by finish(). `version` is what is installed once
    // the job is done (null when nothing is); `previousVersion` is what it
    // replaced, and `previouslyInstalled` tells "nothing was there" apart from
    // "something was there whose version we never recorded".
    version: null,
    previousVersion: null,
    previouslyInstalled: null,
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
    emit({
      type: "job-done",
      jobId: job.id,
      appId: job.appId,
      artifactId: job.artifactId,
      // v0.10: the run's own facts, so the flight recorder never has to parse
      // the human sentence below to learn them. `previousVersion` is the one
      // that cannot be recovered any other way — it is what tells a first
      // install from an update, and it is what [replay] needs to undo this
      // job exactly instead of reporting `uncertain`.
      jobType: job.type,
      appName: job.appName,
      version: job.version,
      previousVersion: job.previousVersion,
      previouslyInstalled: job.previouslyInstalled,
      message: job.message,
    });
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
    // v0.8: the signature belongs to the asset, so it retargets with it
    hasSignature: Boolean(match.hasSignature),
    signatureName: match.signatureName || null,
    signatureUrl: match.signatureUrl || null,
    signatureId: match.signatureId != null ? match.signatureId : null,
    // v0.6: the delta patches belong to the TARGET release's asset, not to the
    // live one — carry them across with the rest of the asset fields.
    deltaPatches: match.deltaPatches || null,
    version,
  });
  return { target, release, version };
}

/* ------------------------------------------------------------------ */
/* v0.6: delta updates                                                 */
/* ------------------------------------------------------------------ */

// zstd needs the same window size on both ends; release.sh patches with it too.
const ZSTD_LONG = "--long=27";

/** First executable `zstd` on PATH, or null. No subprocess, no cache. */
function findZstd() {
  const raw = process.env.PATH || "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "zstd");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* next */
    }
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function runProcess(cmd, args, { signal, timeout } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { signal, timeout: timeout || 10 * 60 * 1000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr: stderr || (err && err.message) || "" });
    });
  });
}

/**
 * Everything SPEC requires before a delta is even considered. Returns the plan
 * or a one-line reason why not (logged at debug volume, never shown).
 */
function planDelta({ app, artifact, liveArtifact, version }) {
  if (artifact.kind !== "appimage") return { skip: `kind ${artifact.kind} is not delta-capable` };

  const rec = stateStore.getInstall(app.id, liveArtifact.id);
  const from = rec && rec.version != null ? String(rec.version) : null;
  if (!from) return { skip: "nothing installed to patch from" };
  const norm = (v) => String(discovery.parseVersion(v) ?? v);
  if (norm(from) === norm(version)) return { skip: "already at this version" };

  const patches = Array.isArray(artifact.deltaPatches) ? artifact.deltaPatches : [];
  const patch = patches.find((p) => p && norm(p.fromVersion) === norm(from));
  if (!patch) return { skip: `release has no patch from ${from}` };
  if (!patch.url && patch.id == null) return { skip: "patch asset has no download url" };

  // Mandatory for delta: the FULL asset's sidecar is what proves the
  // reconstruction is byte-identical to what everyone else downloads.
  if (!artifact.checksumUrl && artifact.checksumId == null) return { skip: "full asset has no .sha256 sidecar" };

  const zstd = findZstd();
  if (!zstd) return { skip: "zstd not on PATH" };

  // The kept original .AppImage the appimage engine records in its manifest.
  const installDir = rec.path || null;
  if (!installDir) return { skip: "install path unknown" };
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(installDir, ".nx-manifest.json"), "utf8"));
  } catch (e) {
    return { skip: `no install manifest (${e.code || e.message})` };
  }
  const keptName = manifest && manifest.appImageFile;
  if (!keptName) return { skip: "manifest records no kept AppImage" };
  const kept = path.join(installDir, keptName);
  if (!fs.existsSync(kept)) return { skip: `kept original missing (${keptName})` };

  return { patch, kept, zstd, from };
}

/**
 * Download `<assetName>.from-<installed>.zpatch` and rebuild the full asset at
 * `filePath`. Returns true only when the result is verified byte-for-byte
 * against the full asset's sidecar; ANY failure returns false and the caller
 * does the ordinary full download.
 */
async function tryDelta(job, { app, artifact, liveArtifact, version, filePath }) {
  let plan;
  try {
    plan = planDelta({ app, artifact, liveArtifact, version });
  } catch (e) {
    config.log(`delta: unavailable for ${app.id}/${artifact.id} — ${e.message}`);
    return false;
  }
  if (plan.skip) {
    config.log(`delta: skipped for ${app.id}/${artifact.id} — ${plan.skip}`);
    return false;
  }

  const { patch, kept, zstd, from } = plan;
  const patchPath = `${filePath}.zpatch`;
  const fmt = githubMod.fmtBytes;
  const fullSize = Number(artifact.size || 0);
  try {
    progress(
      job,
      "download",
      0,
      `downloading delta patch (${fmt(patch.size)}${fullSize ? ` instead of ${fmt(fullSize)}` : ""})`
    );
    await withDownloadSlot(() =>
      gh().downloadAsset({ name: patch.name, url: patch.url, id: patch.id, size: patch.size }, patchPath, {
        signal: job.controller.signal,
        onProgress: (p) => progress(job, p.phase || "download", p.pct, `delta patch — ${p.message}`),
      })
    );
    if (job.cancelRequested) throw new Error("aborted");

    progress(job, "verify", 20, `applying delta patch (zstd, from ${from})`);
    safeUnlink(filePath);
    const res = await runProcess(
      zstd,
      ["-d", "-f", "-q", ZSTD_LONG, `--patch-from=${kept}`, patchPath, "-o", filePath],
      { signal: job.controller.signal }
    );
    if (res.code !== 0) {
      throw new Error(`zstd exited ${res.code}${res.stderr ? `: ${String(res.stderr).trim().split("\n").pop()}` : ""}`);
    }

    progress(job, "verify", 70, "verifying the delta result");
    const sidecar = {
      name: artifact.checksumName || `${artifact.assetName}.sha256`,
      url: artifact.checksumUrl,
      id: artifact.checksumId,
    };
    const text = await gh().fetchAssetText(sidecar, { signal: job.controller.signal });
    const m = String(text).match(/\b[a-fA-F0-9]{64}\b/);
    if (!m) throw new Error("sidecar has no sha256");
    const got = await sha256File(filePath);
    if (got !== m[0].toLowerCase()) {
      throw new Error(`checksum mismatch (expected ${m[0].toLowerCase()}, got ${got})`);
    }

    const patchBytes = fs.statSync(patchPath).size;
    const saved = fullSize > 0 ? Math.max(0, Math.round((1 - patchBytes / fullSize) * 100)) : 0;
    safeUnlink(patchPath);
    progress(
      job,
      "verify",
      100,
      `delta applied — ${fmt(patchBytes)} downloaded instead of ${fmt(fullSize)}${saved ? ` (${saved}% saved)` : ""}`
    );
    config.log(`delta: rebuilt ${artifact.assetName} from ${from} (${patchBytes} of ${fullSize} bytes)`);
    return true;
  } catch (e) {
    safeUnlink(patchPath);
    safeUnlink(filePath);
    if (job.cancelRequested || e.name === "AbortError") throw e; // a cancel is not a fallback
    config.log(`delta: falling back to the full download for ${app.id}/${artifact.id} — ${e.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* v0.7: LAN asset seeding                                             */
/* ------------------------------------------------------------------ */

/**
 * The fleet, lazily and defensively.
 *
 * jobs.js must keep working in a build with no fleet at all (and in every unit
 * test that never starts one), so this is a require-in-a-try that returns null
 * rather than a hard dependency at the top of the file.
 */
function fleetMod() {
  try {
    // eslint-disable-next-line global-require
    return require("./fleet");
  } catch (_) {
    return null;
  }
}

/** The seeding index — maintained even when the fleet itself is switched off. */
function assetIndex() {
  const fleet = fleetMod();
  try {
    return fleet ? fleet.assetIndex() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Remember that `filePath` hashes to `sha256`, so paired hubs can pull it.
 *
 * Fire-and-forget in every sense: an unknown hash is computed off the critical
 * path, and any failure is silence. Nothing about an install may hinge on the
 * seeding index being writable.
 */
function noteAsset(filePath, sha256) {
  const index = assetIndex();
  if (!index || !filePath) return;
  try {
    if (sha256) {
      index.record(sha256, filePath);
      return;
    }
    // No hash to hand (a reused download, a delta rebuild) — hash it later so
    // the install is not waiting on a 200 MB read.
    setImmediate(() => {
      index.recordFile(filePath).catch(() => {});
    });
  } catch (_) {
    /* the index is a convenience, never a requirement */
  }
}

/**
 * After an appimage install, the engine keeps the original .AppImage inside
 * the install dir. That copy is the DURABLE one — downloads/ is cleaned up at
 * the end of every job — so it is what the index should point at.
 */
function noteKeptAsset(result, sha256) {
  const index = assetIndex();
  if (!index || !result || !result.path) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(result.path, ".nx-manifest.json"), "utf8"));
    const keptName = manifest && (manifest.appImageFile || (manifest.extra && manifest.extra.appImageFile));
    if (!keptName) return;
    const kept = path.join(result.path, keptName);
    if (!fs.existsSync(kept)) return;
    if (sha256) index.record(sha256, kept);
    else setImmediate(() => index.recordFile(kept).catch(() => {}));
  } catch (_) {
    /* no manifest, no kept file, nothing to seed */
  }
}

/** The expected sha256 from the artifact's sidecar, or null. */
async function sidecarHash(job, artifact) {
  const sidecars = siblingsFromArtifact(artifact);
  if (!sidecars.length) return null;
  try {
    const text = await gh().fetchAssetText(sidecars[0], { signal: job.controller.signal });
    const m = String(text).match(/\b[a-fA-F0-9]{64}\b/);
    return m ? m[0].toLowerCase() : null;
  } catch (_) {
    return null; // no sidecar, no seeding — GitHub it is
  }
}

/* ------------------------------------------------------------------ */
/* v0.8: signature verification                                        */
/* ------------------------------------------------------------------ */

/** The `<asset>.sig` sibling as a fetchable asset, or null. */
function signatureFromArtifact(artifact) {
  if (!artifact.signatureUrl && artifact.signatureId == null) return null;
  return {
    name: artifact.signatureName || `${artifact.assetName}.sig`,
    url: artifact.signatureUrl,
    id: artifact.signatureId,
  };
}

/**
 * SPEC v0.8: the last gate before an asset is handed to an install engine.
 *
 * Runs on whatever ended up at `filePath` — a full download, a LAN-seeded
 * copy, a delta reconstruction or a cached pre-download — because all four
 * converge on the same bytes and all four are equally worth refusing. By this
 * point the bytes have already been checked against the `.sha256` sidecar;
 * this asks the harder question of WHO produced them.
 *
 * Fatal cases throw (the job fails, nothing is installed):
 *   - a signature that does not verify against the owner's pinned key
 *   - a pinned owner with no signature while `requireSignatures` is on
 *
 * Everything else logs and returns: an unpinned owner's signature is not
 * something this hub can judge, and an unsigned asset is the pre-v0.8 status
 * quo, which stays installable by default.
 *
 * @param {string|null} sha256  the asset's hash when the download path already
 *                              computed it — saves re-reading the file
 */
async function verifySignature(job, { app, artifact, filePath, settings, sha256 }) {
  const sigAsset = signatureFromArtifact(artifact);
  // app.owner is always set by discovery; the repo full_name is the fallback
  // for hand-built app models (provenance.decide splits "owner/repo" itself).
  const owner = app.owner || app.repo || "";
  const decision = provenance.decide({
    owner,
    hasSignature: Boolean(sigAsset),
    requireSignatures: Boolean(settings && settings.requireSignatures),
  });

  if (decision.action === "refuse") {
    throw new Error(`${artifact.assetName}: unsigned asset from a pinned owner — refusing to install`);
  }
  if (decision.action === "skip") {
    config.log(`provenance: ${artifact.assetName} — ${decision.reason}`);
    return false;
  }

  progress(job, "verify", 0, "verifying signature");
  let text = null;
  try {
    text = await gh().fetchAssetText(sigAsset, { signal: job.controller.signal });
  } catch (e) {
    if (job.cancelRequested || e.name === "AbortError") throw e;
    // The signature exists but we could not read it. That is not a mismatch,
    // so it follows the same rule as an absent one: fatal only when the user
    // asked for signatures to be mandatory.
    if (settings && settings.requireSignatures) {
      throw new Error(`${artifact.assetName}: signature unavailable (${e.message}) — refusing to install`);
    }
    config.log(`provenance: ${artifact.assetName} — signature unavailable (${e.message})`);
    progress(job, "verify", 100, "signature unavailable");
    return false;
  }

  const ok = await provenance.verifyAsset(owner, filePath, text, { sha256: sha256 || undefined });
  if (!ok) {
    // No fallback, by design: a wrong signature is the one failure that cannot
    // be a transient. Delete the bytes so no later run can reuse them.
    safeUnlink(filePath);
    try {
      stateStore.removeDownload(app.id, artifact.id);
    } catch (_) {
      /* the file is gone either way */
    }
    config.log(`provenance: ${artifact.assetName} FAILED verification against ${owner}'s pinned key`);
    throw new Error(`${artifact.assetName}: signature verification failed — refusing to install`);
  }
  config.log(`provenance: ${artifact.assetName} verified against ${owner}'s pinned key`);
  progress(job, "verify", 100, "signature verified");
  return true;
}

/**
 * SPEC v0.7: before going to GitHub, ask the LAN.
 *
 * The .sha256 sidecar is what makes this safe AND possible: it names the exact
 * bytes we want, so a peer either has them or does not, and whatever comes
 * back is verified against that same hash before it is allowed anywhere near
 * the install pipeline. A peer that lies, stalls, or hangs up costs one failed
 * attempt and the ordinary download proceeds untouched.
 *
 * @returns {Promise<string|null>} the verified sha256 when the file came from a
 *          peer, null when the caller should download it from GitHub
 */
async function trySeed(job, { app, artifact, filePath, settings }) {
  if (settings && settings.lanSeeding === false) return null;
  const fleet = fleetMod();
  // Three cheap gates before a single byte moves: a running fleet, a connected
  // peer, and an artifact whose hash we can actually know in advance.
  if (!fleet || typeof fleet.isRunning !== "function" || !fleet.isRunning()) return null;
  if (!fleet.hasOnlinePeers()) return null;
  if (!artifact.checksumUrl && artifact.checksumId == null) return null;

  const expected = await sidecarHash(job, artifact);
  if (!expected) return null;
  if (job.cancelRequested) throw new Error("aborted");

  let found = null;
  try {
    found = await fleet.findAsset(expected);
  } catch (_) {
    found = null;
  }
  if (!found) return null;

  const who = found.peerName || found.peerId;
  const fmt = githubMod.fmtBytes;
  try {
    progress(job, "download", 0, `fetching from ${who} (LAN)`);
    await withDownloadSlot(() =>
      fleet.fetchAsset(expected, filePath, {
        peer: found,
        signal: job.controller.signal,
        onProgress: (p) =>
          progress(
            job,
            "download",
            p.pct,
            `fetching from ${who} (LAN) — ${fmt(p.transferred)}${p.total ? ` / ${fmt(p.total)}` : ""}`
          ),
      })
    );
    progress(job, "verify", 100, `checksum ok — fetched from ${who} (LAN)`);
    config.log(`seeding: ${artifact.assetName} came from ${who} over the LAN (${expected.slice(0, 12)}…)`);
    return expected;
  } catch (e) {
    safeUnlink(filePath);
    if (job.cancelRequested || e.name === "AbortError") throw e; // a cancel is not a fallback
    config.log(`seeding: ${who} could not serve ${artifact.assetName} — ${e.message}; falling back to GitHub`);
    return null;
  }
}

async function runInstall(job) {
  const { app, artifact: liveArtifact } = resolve(job.appId, job.artifactId);
  if (!app || !liveArtifact) throw new Error("App or artifact disappeared — refresh and try again");
  const settings = config.load();
  setDownloadLimit(settings.maxConcurrentDownloads);

  // v0.10: read BEFORE step 3 overwrites the record. An install over nothing
  // and an install over 1.3.2 both end up writing "Installed <app> <version>",
  // so this is the only moment the difference is knowable.
  const replaced = stateStore.getInstall(app.id, liveArtifact.id);
  job.previouslyInstalled = Boolean(replaced);
  job.previousVersion = replaced && replaced.version != null ? String(replaced.version) : null;

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

  // v0.7 seeding: `hash` is the sha256 of what ends up at filePath when we
  // already know it; `verified` says those bytes were checked against a
  // sidecar. Only verified bytes are ever offered to the fleet — seeding an
  // unvouched-for download would turn this hub into a bad mirror.
  const seed = { hash: null, verified: false };

  if (reusable) {
    progress(job, "download", 100, `using the downloaded ${artifact.assetName}`);
    // Nothing to add: the "download" update policy indexed this file the
    // moment it verified it (see predownload), and the record on disk carries
    // no hash for us to re-assert here.
  } else if (await tryDelta(job, { app, artifact, liveArtifact, version, filePath })) {
    // reconstructed from a patch — filePath now holds the verified full asset
    // (tryDelta only returns true after checking it against the full sidecar)
    seed.verified = true;
  } else if ((seed.hash = await trySeed(job, { app, artifact, filePath, settings }))) {
    // a paired hub on this LAN already had these exact bytes
    seed.verified = true;
  } else {
    progress(job, "download", 0, `downloading ${artifact.assetName}`);
    const downloaded = await withDownloadSlot(() =>
      gh().downloadAsset(assetFromArtifact(artifact), filePath, {
        signal: job.controller.signal,
        siblings: siblingsFromArtifact(artifact),
        onProgress: (p) => progress(job, p.phase || "download", p.pct, p.message),
      })
    );
    if (downloaded && downloaded.verified) {
      seed.verified = true;
      seed.hash = downloaded.sha256 || null;
    }
  }
  if (job.cancelRequested) throw new Error("aborted");

  // v0.8: whatever route those bytes took, they have now been hash-checked —
  // ask who signed them before anything unpacks or executes them. Throws (and
  // fails the job) on a bad signature; see verifySignature for the full table.
  await verifySignature(job, { app, artifact, filePath, settings, sha256: seed.hash });

  if (seed.verified) noteAsset(filePath, seed.hash); // v0.7: offer it to the fleet

  // SPEC: core sets artifact.version before handing off to the engine
  artifact.version = version;

  // v0.8 [timemachine]: snapshot the config when this install REPLACES another
  // version of the same artifact (the module decides; it never throws).
  await require("./snapshots").maybeSnapshotForUpdate(app, liveArtifact.id, version, settings);

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
  job.version = result.version || version;
  stateStore.recordInstall(app.id, artifact.id, {
    version: job.version,
    path: result.path || null,
    launchable: result.launchable !== false,
    iconPath: result.iconPath || null,
    installedAt: new Date().toISOString(),
  });
  // v0.6: a fresh install (or reinstall) is a clean slate for crash counting
  stateStore.resetCrashes(app.id, artifact.id);
  // v0.7: an appimage install keeps the original alongside the extracted tree.
  // That copy outlives downloads/, so it is the one worth seeding from.
  if (seed.verified) noteKeptAsset(result, seed.hash);

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
  maybeAutoRunCmd(job, app, artifact, settings);
  return result;
}

/**
 * Opt-in: run the artifact's overlay postInstallCmd right after a successful
 * install (settings.autoRunPostInstallCmd, per-app appPrefs.autoRunCmd). One
 * carve-out: a PRIVILEGED command (sudo→pkexec) on a BACKGROUND policy install
 * would pop an auth dialog unattended — skip it and leave the note instead.
 * Fire-and-forget: never blocks or fails the install job itself.
 */
function maybeAutoRunCmd(job, app, artifact, settings) {
  try {
    const cmd = artifact.postInstallCmd;
    if (!cmd) return;
    if (!config.effectiveAutoRunCmd(settings, app.id)) return;
    const runcmd = require("./runcmd");
    const spec = runcmd.rewriteForPrivilege(cmd);
    if (!spec) return;
    if (spec.privileged && job.origin === "policy") {
      config.log(`auto-run skipped for ${app.id}: privileged command on a background install`);
      return;
    }
    config.log(`auto-run post-install cmd for ${app.id}/${artifact.id}: ${spec.cmd}`);
    runcmd.runShell(spec.cmd).then((res) => {
      if (res.ok) emit({ type: "toast", level: "info", message: `Auto-ran: ${cmd}` });
      else emit({ type: "toast", level: "error", message: `Auto-run failed (exit ${res.code}): ${cmd}` });
    });
  } catch (e) {
    config.log(`auto-run error: ${e.message}`);
  }
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
  // v0.10: nothing is installed when this finishes, and the version that is
  // going away is what an undo of this uninstall would have to put back.
  job.previouslyInstalled = Boolean(rec);
  job.previousVersion = rec && rec.version != null ? String(rec.version) : null;
  job.version = null;

  // v0.8 [timemachine]: the last config snapshot before the app goes away.
  await require("./snapshots").maybeSnapshot(app, settings, "pre-uninstall");

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
  stateStore.resetCrashes(job.appId, job.artifactId);
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
  job.previouslyInstalled = Boolean(rec); // v0.10
  job.previousVersion = rec && rec.version != null ? String(rec.version) : null;

  const engine = getEngine();
  if (typeof engine.rollback !== "function") throw new Error("This build cannot roll installs back");

  progress(job, "install", 20, `restoring the previous ${artifact.label}`);
  const result = (await engine.rollback({ app, artifact, installedPath, ctx: makeCtx(job, settings) })) || {};

  const version = result.version != null ? result.version : artifact.prevVersion || null;
  job.version = version;
  stateStore.recordInstall(app.id, artifact.id, {
    version,
    path: result.path || installedPath || null,
    launchable: result.launchable !== false,
    installedAt: new Date().toISOString(),
  });
  // v0.6: rolling back is the cure for a crash loop — clear the counter so the
  // banner disappears the moment the older build is back.
  stateStore.resetCrashes(app.id, artifact.id);
  try {
    discovery.remerge();
  } catch (_) {
    /* cache may be empty in tests */
  }
  progress(job, "cleanup", 100, "restored");
  job.message = `Restored ${app.name}${version ? ` ${version}` : ""}`;
  return result;
}

/* ------------------------------------------------------------------ */
/* v0.6: crash-aware rollback — the launch watchdog                    */
/* ------------------------------------------------------------------ */

/**
 * SPEC: crash = exit code ≠ 0 && uptime < 30s; the counter resets on a run
 * ≥ 120s (or a version change / rollback / reinstall). At most 10 processes
 * are watched at once — a launcher, not a supervisor.
 *
 * How we see the exit at all: the engines spawn through `util.spawnDetached`,
 * which announces every child to `util.onSpawn`. `launch()` listens across the
 * engine call and keeps the ChildProcess. `unref()` (which spawnDetached still
 * does, unchanged) only drops the handle from the event loop's ref count — the
 * hub still receives 'exit' with the real exit code while it is running, and
 * the child still outlives the hub when it is not. Detachment is untouched.
 *
 * Fallback: if a launch reports a pid we never saw spawned (an engine that
 * shells out through some other path), we poll liveness with signal 0 instead.
 * That mode cannot know the exit CODE, so a process that vanishes inside 30s
 * counts as a crash — see `onWatchedExit`.
 */
const CRASH_DEFAULTS = { crashMs: 30000, healthyMs: 120000, pollMs: 5000, max: 10 };
let crashCfg = Object.assign({}, CRASH_DEFAULTS);
const tracked = new Map(); // pid → {appId, artifactId, version, startedAt, timer, mode}

/* ------------------------------------------------------------------ */
/* v0.8: the launch-exit stream (src/main/supervisor.js, [recorder])   */
/* ------------------------------------------------------------------ */

/**
 * Every watched process that ends is announced here, crash or not:
 *   {appId, appName, artifactId, version, pid, code, signal, uptimeMs,
 *    stoppedByHub, crashCount, crashLoop, unknownExit}
 * Subscribers must never throw; one that does is logged and ignored.
 */
const exitListeners = new Set();

/** Subscribe to launch exits. @returns {function} unsubscribe */
function onLaunchExit(fn) {
  if (typeof fn !== "function") return () => {};
  exitListeners.add(fn);
  return () => exitListeners.delete(fn);
}

/**
 * Deliberate stops the HUB itself performed, remembered just long enough to
 * colour the next exit (SPEC v0.8: the watchdog must not fight a stack stop).
 * Keyed by pid AND by app/artifact, because a polite `shutdown-request` over
 * the bus never mentions a pid.
 */
const HUB_STOP_MS = 10000;
const hubStops = new Map(); // "pid:1234" | "app:foo::bar" | "app:foo" → epoch ms

/**
 * Record "the hub asked this to stop". Called by every hub-side stop path
 * (stacks.stop, fleet's remote stop, an IPC stop button); harmless to call
 * more than once. Any of {pid} / {appId[,artifactId]} identifies the target.
 */
function noteHubStop(o = {}) {
  const now = Date.now();
  const pid = Number(o.pid);
  if (Number.isFinite(pid) && pid > 0) hubStops.set(`pid:${pid}`, now);
  if (o.appId) {
    hubStops.set(`app:${o.appId}`, now);
    if (o.artifactId) hubStops.set(`app:${o.appId}::${o.artifactId}`, now);
  }
  // Cheap sweep: this map is only ever a handful of keys.
  for (const [key, at] of hubStops) if (now - at > HUB_STOP_MS * 3) hubStops.delete(key);
  return now;
}

/**
 * Signals that mean "something asked this process to go away" rather than
 * "it fell over". A crash worth restarting is a bad exit CODE or a fault
 * signal (SIGSEGV/SIGABRT/SIGBUS/…), never one of these. Being generous here
 * is the conservative direction: the watchdog stays out of the way of stack
 * stops, `pkill`, and session teardown even when those paths never called
 * noteHubStop().
 */
const STOP_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP", "SIGKILL"]);

/** Was this exit somebody's decision rather than a crash? */
function wasStopped(entry, { signal } = {}) {
  if (signal && STOP_SIGNALS.has(String(signal))) return true;
  const now = Date.now();
  const keys = [`pid:${entry.pid}`, `app:${entry.appId}::${entry.artifactId}`, `app:${entry.appId}`];
  return keys.some((k) => {
    const at = hubStops.get(k);
    return at != null && now - at <= HUB_STOP_MS;
  });
}

function fireLaunchExit(evt) {
  for (const fn of [...exitListeners]) {
    try {
      fn(evt);
    } catch (e) {
      config.log(`launch-exit listener failed: ${e.message}`);
    }
  }
}

/** Is a launch of this app/artifact still being watched? (supervisor guard) */
function isTracked(appId, artifactId) {
  for (const entry of tracked.values()) {
    if (entry.appId !== appId) continue;
    if (artifactId && entry.artifactId !== artifactId) continue;
    return true;
  }
  return false;
}

function untrack(pid) {
  const entry = tracked.get(pid);
  if (!entry) return null;
  if (entry.timer) clearInterval(entry.timer);
  tracked.delete(pid);
  return entry;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // running, just not ours to signal
  }
}

/**
 * Start watching one launched process.
 * @returns {object|null} the tracking entry (tests read it)
 */
function trackLaunch({ appId, appName, artifactId, version, pid, child }) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return null;
  untrack(id); // a recycled pid always starts fresh

  // Cap the watch list: drop the OLDEST watch rather than refusing the newest,
  // so the process the user just started is always the one being observed.
  while (tracked.size >= crashCfg.max) {
    const oldest = [...tracked.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    untrack(oldest.pid);
  }

  const entry = {
    appId,
    appName: appName || appId,
    artifactId,
    version: version == null ? null : String(version),
    pid: id,
    startedAt: Date.now(),
    mode: child ? "child" : "poll",
    timer: null,
  };
  tracked.set(id, entry);

  if (child) {
    child.once("exit", (code, signal) => {
      if (tracked.get(id) !== entry) return;
      onWatchedExit(entry, { code, signal });
    });
    child.once("error", () => untrack(id));
  } else {
    entry.timer = setInterval(() => {
      if (tracked.get(id) !== entry) return;
      if (alive(id)) return;
      onWatchedExit(entry, { code: null, signal: null, unknownExit: true });
    }, crashCfg.pollMs);
    // never hold the hub (or `nx launch`) open just to keep watching
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }
  return entry;
}

/** A watched process ended: score it, update the counter, tell the UI. */
function onWatchedExit(entry, { code, signal, unknownExit } = {}) {
  untrack(entry.pid);
  const uptime = Date.now() - entry.startedAt;
  const label = `${entry.appId}/${entry.artifactId}`;
  // v0.8: decided BEFORE the crash bookkeeping below, while the hub-stop
  // window is still fresh.
  const stoppedByHub = wasStopped(entry, { signal });
  let changed = false;

  if (uptime >= crashCfg.healthyMs) {
    // SPEC: a run of ≥120s clears the counter — whatever happened after that
    // is the app's own business, not a failed update.
    changed = Boolean(stateStore.resetCrashes(entry.appId, entry.artifactId));
    if (changed) config.log(`crash counter reset for ${label} — ran ${Math.round(uptime / 1000)}s`);
  } else {
    // Exit code semantics. With a ChildProcess we have the real thing (a
    // signal death — SIGSEGV & friends — is "≠ 0" too). In poll mode there is
    // no code at all: a short-lived process is scored as a crash, which also
    // catches "the user opened it and quit again immediately". That is
    // acceptable because the counter is advisory, needs THREE of them, and any
    // single ≥120s run wipes it.
    const badExit = unknownExit ? true : code !== 0;
    if (badExit && uptime < crashCfg.crashMs) {
      const rec = stateStore.recordCrash(entry.appId, entry.artifactId, entry.version);
      changed = true;
      config.log(
        `crash #${rec.count} for ${label} ${entry.version || "?"} — ` +
          `exit ${unknownExit ? "unknown (polled)" : signal || code} after ${uptime}ms`
      );
    }
  }

  // v0.8: the supervisor (and the flight recorder) see EVERY exit, healthy
  // ones included — the crash counter above only speaks about the bad ones.
  if (exitListeners.size) {
    let crash = null;
    try {
      crash = stateStore.getCrashes(entry.appId, entry.artifactId);
    } catch (_) {
      crash = null;
    }
    const sameVersion =
      crash && crash.version != null && entry.version != null && String(crash.version) === String(entry.version);
    fireLaunchExit({
      appId: entry.appId,
      appName: entry.appName || entry.appId,
      artifactId: entry.artifactId,
      version: entry.version,
      pid: entry.pid,
      code: code == null ? null : code,
      signal: signal || null,
      uptimeMs: uptime,
      stoppedByHub,
      unknownExit: Boolean(unknownExit),
      crashCount: sameVersion ? Number(crash.count || 0) : 0,
      // SPEC v0.6 banner threshold, reused here: three crashes at the version
      // that is installed suspends keepAlive for it.
      crashLoop: Boolean(sameVersion && Number(crash.count || 0) >= 3),
    });
  }

  if (!changed) return;
  try {
    discovery.remerge();
  } catch (_) {
    /* cache may be empty (CLI, tests) */
  }
  emit({ type: "state-changed" });
}

/** v0.8: the sandbox helper, lazily required like the engine (never fatal). */
function sandbox() {
  if (deps.sandbox) return deps.sandbox; // test hook
  try {
    // eslint-disable-next-line global-require
    return require("./install/sandbox");
  } catch (_) {
    return null;
  }
}

/** Engines announce their detached children here; require lazily like the engine. */
function spawnHook() {
  if (deps.spawnHook) return deps.spawnHook; // test hook
  try {
    // eslint-disable-next-line global-require
    return require("./install/util");
  } catch (_) {
    return null;
  }
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
  // v0.8 sandbox profiles: appPrefs.sandbox → artifact overlay → app overlay →
  // "none", and never for a kind that cannot be wrapped. The engines that can
  // honour it (appimage, archive-dir) read these two fields; the rest ignore
  // them, which is why nothing else has to change.
  const sandboxMod = sandbox();
  if (sandboxMod) {
    try {
      ctx.sandboxProfile = sandboxMod.resolveProfile({ appPrefs: ctx.appPrefs, app, artifact });
      ctx.sandboxConfigPaths = sandboxMod.resolveConfigPaths({ app, artifact });
    } catch (e) {
      config.log(`sandbox profile resolution failed for ${app.id}/${artifact.id}: ${e.message}`);
      ctx.sandboxProfile = "none";
      ctx.sandboxConfigPaths = [];
    }
  }
  config.log(
    `launch ${app.id}/${artifact.id}` +
      (ctx.sandboxProfile && ctx.sandboxProfile !== "none" ? ` (sandbox: ${ctx.sandboxProfile})` : "")
  );

  // v0.6: collect whatever the engine spawns while it is launching, so the
  // watchdog below can attach to the real ChildProcess (exit code + uptime).
  const util = spawnHook();
  const spawned = [];
  const off =
    util && typeof util.onSpawn === "function" ? util.onSpawn((child) => child && spawned.push(child)) : null;
  let result;
  try {
    result = await engine.launch({ app, artifact, installedPath, ctx });
  } finally {
    if (off) off();
  }

  const pid = result && result.pid;
  if (pid) {
    // Match by pid: an engine may spawn helpers (adb, a wrapper) — only the
    // process it reports as the app is worth watching.
    const child = spawned.find((c) => c && c.pid === pid) || null;
    trackLaunch({
      appId: app.id,
      appName: app.name || app.id,
      artifactId: artifact.id,
      // the version we are watching is the INSTALLED one, which is what the
      // crash counter is keyed on
      version: (rec && rec.version) || (artifact.installed && artifact.installed.version) || null,
      pid,
      child,
    });
  }
  return result;
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
  const downloaded = await withDownloadSlot(() =>
    gh().downloadAsset(assetFromArtifact(artifact), filePath, {
      siblings: siblingsFromArtifact(artifact),
      onProgress: () => {},
    })
  );
  stateStore.recordDownload(app.id, artifact.id, { version, path: filePath, assetName: artifact.assetName });
  // v0.7: a pre-downloaded asset sits in downloads/ until the user installs it
  // — the longest-lived, most seedable thing this hub owns.
  if (downloaded && downloaded.verified) noteAsset(filePath, downloaded.sha256);
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
  for (const pid of [...tracked.keys()]) untrack(pid);
  crashCfg = Object.assign({}, CRASH_DEFAULTS);
  exitListeners.clear();
  hubStops.clear();
}

/** test hook: shrink the 30s/120s/5s windows so the suite stays fast. */
function _setCrashConfig(next = {}) {
  crashCfg = Object.assign({}, crashCfg, next);
  return crashCfg;
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
  trackLaunch,
  onLaunchExit,
  noteHubStop,
  isTracked,
  findZstd,
  _reset,
  _setCrashConfig,
  _jobs: jobs,
  _tracked: tracked,
};
