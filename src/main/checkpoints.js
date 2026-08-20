"use strict";
// NX Hub — ecosystem checkpoints (SPEC v0.10 "Ecosystem checkpoints", [replay]).
//
// "Put everything back the way it was on Tuesday."
//
// This module reconstructs WHICH VERSION OF WHAT was installed at an arbitrary
// point in the past, and then walks that reconstruction back through the hub's
// ORDINARY pipelines (jobs.installVersion / jobs.uninstall / snapshots.restore).
// It invents no install logic of its own — it only decides what to ask for.
//
// Two sources, and knowing which one is authoritative for what is the whole
// trick:
//
//   state.json     the truth about NOW. Never derived, never guessed at.
//   events.jsonl   the truth about CHANGE. Every finished job left a line;
//                  the flight recorder is the only record of what USED to be
//                  installed, because state.json keeps no history.
//
// So the walk runs BACKWARDS: start from what is installed now and undo every
// journal entry newer than `when`. Undoing "installed 1.4.0" needs the version
// that was there BEFORE it. Since v0.10 the entry says so itself (jobs.js
// attaches `previousVersion` / `previouslyInstalled` to every job-done), so
// one entry is enough; older entries only ever said "Installed <app> 1.4.0"
// for a first install and an update alike, and for those the answer has to be
// walked back to the entry immediately older than it. When neither route
// reaches, the honest answer is "I do not know", and this module reports that
// as `uncertain` and REFUSES TO ACT ON IT. A checkpoint that guesses is worse
// than no checkpoint at all: it would silently install the wrong build over a
// working one.
//
// Everything below the reconstruction is deliberately boring: resolve a version
// to a published tag, find the newest config snapshot at or before `when`, and
// run the plan one step at a time, emitting `checkpoint-progress`.
//
// All time handling is locale-independent (epoch ms and the recorder's own
// parser — the host may run de_DE).

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * Collaborators. Everything is injectable so the reconstruction matrix and the
 * executor can be tested without a journal, a network or an install engine.
 */
let deps = {
  recorder: null, // ./recorder
  state: null, // ./state
  snapshots: null, // ./snapshots
  discovery: null, // ./discovery (releases + app names)
  jobs: null, // ./jobs
  emit: null, // hub event sink (falls back to ipc.emit, lazily)
  runJob: null, // (kind, target) => Promise — see defaultRunJob
  now: null, // injectable clock → epoch ms
  pollMs: 200, // how often the default runner asks jobs.list()
};

/** SPEC: the progress event this module raises. */
const EVENT = "checkpoint-progress";
/** SPEC: {phase, appId} — `appId: null` marks the run's OWN verdict. */
const PHASES = Object.freeze(["planning", "installing", "removing", "restoring-config", "done", "failed"]);
/** Plan actions, SPEC "action: none|install|remove". */
const ACTIONS = Object.freeze(["none", "install", "remove"]);
/** Why a planned action was not carried out. */
const SKIP_REASONS = Object.freeze(["uncertain", "unknown-app", "unknown-tag"]);

/** How far back a single reconstruction reads. recorder.MAX_LIMIT. */
const SCAN_LIMIT = 1000;

/** The journal entries that move an install forward or back. */
const CHANGE_TYPE = "job-done";
/** recorder verbs that SET a version. */
const SET_VERBS = new Set(["installed", "updated", "rolled back", "restored"]);
/** recorder verbs that REMOVE an install. */
const CLEAR_VERBS = new Set(["uninstalled", "removed"]);

/** One restore at a time, hub-wide (SPEC: "serialized"). */
let running = false;

function init(d = {}) {
  deps = Object.assign({}, deps, d);
  return module.exports;
}

/** Tests: forget the in-flight guard (the journal and state are untouched). */
function _reset() {
  running = false;
}

function mod(name, over) {
  if (over) return over;
  if (deps[name]) return deps[name];
  // eslint-disable-next-line global-require
  return require(`./${name}`);
}

function recorderOf(o = {}) {
  return mod("recorder", o.recorder);
}
function stateOf(o = {}) {
  return mod("state", o.state);
}
function snapshotsOf(o = {}) {
  return mod("snapshots", o.snapshots);
}
function discoveryOf(o = {}) {
  return mod("discovery", o.discovery);
}
function jobsOf(o = {}) {
  return mod("jobs", o.jobs);
}

function nowMs(o = {}) {
  const clock = o.now == null ? deps.now : o.now;
  if (typeof clock === "function") {
    const v = Number(clock());
    if (Number.isFinite(v)) return v;
  } else if (clock != null && Number.isFinite(Number(clock))) {
    // …and NOT `Number(clock)` on its own: Number(null) is 0, which would
    // silently move every checkpoint to 1970.
    return Number(clock);
  }
  return Date.now();
}

function log(message) {
  try {
    // eslint-disable-next-line global-require
    require("./config").log(`[checkpoints] ${message}`);
  } catch (_) {
    /* logging must never break a restore */
  }
}

/**
 * Raise one hub event. Falls back to ipc.emit (required LAZILY — ipc requires
 * this module lazily right back, and neither may close a cycle at load time).
 */
function emit(evt, over) {
  const sink = over || deps.emit;
  try {
    if (typeof sink === "function") sink(evt);
    else {
      // eslint-disable-next-line global-require
      require("./ipc").emit(evt);
    }
  } catch (e) {
    log(`emit failed — ${(e && e.message) || e}`);
  }
  return evt;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** "v1.4.0" → "1.4.0" (the journal and state disagree about the leading v). */
function ver(v) {
  const s = str(v).trim();
  return /^v\d/.test(s) ? s.slice(1) : s;
}

function sameVersion(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return ver(a) === ver(b); // ordinal — never localeCompare
}

function keyOf(appId, artifactId) {
  return `${appId}::${artifactId}`;
}

/** Ordinal sort key for a stable, locale-independent plan order. */
function ordinal(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* ------------------------------------------------------------------ */
/* `when`                                                              */
/* ------------------------------------------------------------------ */

/**
 * The recorder's own time grammar, resolved against an injectable clock:
 * epoch ms · a Date · "now" · "24h" / "90m" / "2d" / "1w" · "2026-08-15"
 * (LOCAL midnight, built from its own parts) · "2026-08-15T10:00:00Z".
 *
 * Delegates to recorder.parseSince so `nx log --since 2d` and
 * `nx checkpoint show 2d` can never disagree about where 2d is; the explicit
 * `now` keeps it from touching the recorder's own clock (or initialising it).
 *
 * @returns {number|null} epoch ms, or null when it is not a time
 */
function parseWhen(value, opts = {}) {
  const rec = recorderOf(opts);
  const at = rec.parseSince(value, nowMs(opts));
  return Number.isFinite(at) ? at : null;
}

/** parseWhen or an error the CLI/IPC can hand straight to the user. */
function requireWhen(value, opts = {}) {
  const at = parseWhen(value, opts);
  if (at == null) {
    const e = new Error(`I cannot read "${str(value) || value}" as a point in time`);
    e.hint = "try 24h, 2d, 90m, or a date like 2026-08-15";
    throw e;
  }
  return at;
}

/* ------------------------------------------------------------------ */
/* the journal                                                         */
/* ------------------------------------------------------------------ */

/**
 * What ONE journal entry says about an install — AFTER it (`effect`) and, when
 * the entry is new enough to know, BEFORE it (`prior`).
 *
 * The recorder already did the hard part: `data.verb` and `data.version` are
 * derived once, when the event was recorded. They are not always both there
 * (a pre-v0.10 install with a post-install note wrote "Installed. <note>" and
 * carried no version), so the message — and failing that the summary the
 * recorder built — is re-read through the recorder's OWN parser rather than a
 * second private one.
 *
 * `prior` is the half no parse can reach. Since v0.10 jobs.js states outright
 * what its job replaced, so:
 *
 *   previousVersion present        → "set": that exact version was installed
 *   previouslyInstalled === false  → "clear": nothing was installed
 *   neither                        → "unknown"
 *
 * That third row is every journal line written before v0.10 — and also a
 * v0.10 line for an install over a record that carried no version at all,
 * which is exactly why the boolean is not just `!previousVersion`.
 *
 * @returns {{verb:string, version:string|null, effect:"set"|"clear"|"unknown",
 *           previousVersion:string|null, prior:"set"|"clear"|"unknown"}}
 */
function derive(entry, opts = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  const data = e.data && typeof e.data === "object" ? e.data : {};
  let verb = str(data.verb).toLowerCase();
  let version = ver(data.version);
  const previousVersion = ver(data.previousVersion) || null;
  const hadInstall = typeof data.previouslyInstalled === "boolean" ? data.previouslyInstalled : null;

  if (!verb || verb === "finished" || !version) {
    const rec = recorderOf(opts);
    const parsed = rec.parseJobMessage(str(data.message) || str(e.summary));
    if ((!verb || verb === "finished") && parsed.verb) verb = parsed.verb;
    if (!version && parsed.version) version = ver(parsed.version);
  }

  let effect = "unknown";
  if (CLEAR_VERBS.has(verb)) effect = "clear";
  else if (SET_VERBS.has(verb)) effect = version ? "set" : "unknown";

  let prior = "unknown";
  if (previousVersion) prior = "set";
  else if (hadInstall === false) prior = "clear";

  return { verb: verb || "finished", version: version || null, effect, previousVersion, prior };
}

/**
 * SPEC: `timeline(appId?)` — the install/update/rollback/uninstall history the
 * journal remembers, NEWEST FIRST (the order query() returns, and the order the
 * Activity sheet renders).
 *
 * @param {string} [appId] one app, or every app
 * @param {object} [opts] {recorder, limit}
 * @returns {{ts, appId, artifactId, verb, version, effect, summary}[]}
 */
function timeline(appId, opts = {}) {
  const rec = recorderOf(opts);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SCAN_LIMIT;
  const entries = rec.query({ type: CHANGE_TYPE, appId: appId || undefined, limit });
  return entries
    .filter((e) => e && e.appId)
    .map((e) => {
      const d = derive(e, opts);
      return {
        ts: e.ts,
        appId: e.appId,
        artifactId: e.artifactId || null,
        verb: d.verb,
        version: d.version,
        effect: d.effect,
        summary: e.summary || "",
      };
    });
}

/**
 * Every change entry the journal still holds, plus the HORIZON: the oldest
 * moment it can speak for.
 *
 * Rotation drops whole files, so if the oldest surviving entry is at T, the
 * journal is complete from T onwards — that is what makes "nothing happened to
 * this app since `when`" a fact rather than an assumption. The horizon is read
 * off the change entries only, which can only make it MORE RECENT than the true
 * one: erring towards `uncertain` is the safe direction here.
 */
function readJournal(opts = {}) {
  const rec = recorderOf(opts);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SCAN_LIMIT;
  const entries = rec.query({ type: CHANGE_TYPE, limit });
  return {
    entries,
    horizon: entries.length ? entries[entries.length - 1].ts : null,
    truncated: entries.length >= limit,
  };
}

/* ------------------------------------------------------------------ */
/* reconstruction — the part worth testing exhaustively                */
/* ------------------------------------------------------------------ */

/**
 * What was installed at `when`. PURE: hand it a synthetic journal and a
 * synthetic state and it answers without touching a disk.
 *
 * @param {number} when epoch ms
 * @param {object} o
 * @param {object[]} [o.entries]  journal entries (any order — sorted here)
 * @param {object[]} [o.installs] stateStore.listInstalls() shape
 * @param {number|null} [o.horizon] oldest moment the journal covers
 * @returns {{appId,artifactId,version,currentVersion,uncertain,why}[]}
 */
function reconstruct(when, o = {}) {
  const at = Number(when);
  const horizon = o.horizon == null ? null : Number(o.horizon);
  const covered = horizon != null && at >= horizon;

  /** key → {appId, artifactId, after:[], before:entry|null, install:record|null} */
  const rows = new Map();
  const touch = (appId, artifactId) => {
    const key = keyOf(appId, artifactId);
    let row = rows.get(key);
    if (!row) {
      row = { appId, artifactId, after: [], before: null, install: null };
      rows.set(key, row);
    }
    return row;
  };

  // Newest first, so the FIRST at-or-before entry we meet per key is the one
  // that was in force at `when`.
  const entries = (Array.isArray(o.entries) ? o.entries : [])
    .filter((e) => e && Number.isFinite(Number(e.ts)) && e.appId && e.artifactId)
    .slice()
    .sort((a, b) => Number(b.ts) - Number(a.ts) || ordinal(String(b.appId), String(a.appId)));

  for (const e of entries) {
    const row = touch(String(e.appId), String(e.artifactId));
    if (Number(e.ts) > at) row.after.push(e);
    else if (!row.before) row.before = e;
  }
  for (const rec of Array.isArray(o.installs) ? o.installs : []) {
    if (!rec || !rec.appId || !rec.artifactId) continue;
    touch(String(rec.appId), String(rec.artifactId)).install = rec;
  }

  const out = [];
  for (const row of rows.values()) {
    out.push(resolveRow(row, { at, covered, opts: o }));
  }
  out.sort((a, b) => ordinal(a.appId, b.appId) || ordinal(a.artifactId, b.artifactId));
  return out;
}

/** One (appId, artifactId) reconstructed. See the header for the reasoning. */
function resolveRow(row, { at, covered, opts }) {
  const currentVersion = row.install && row.install.version ? ver(row.install.version) : null;
  const installedAt = row.install ? Date.parse(str(row.install.installedAt)) : NaN;
  const stamped = Number.isFinite(installedAt);
  const base = { appId: row.appId, artifactId: row.artifactId, currentVersion };
  const unknown = (why) => Object.assign({}, base, { version: null, uncertain: true, why });
  const known = (version) => Object.assign({}, base, { version: version || null, uncertain: false, why: null });

  if (!row.after.length) {
    // Nothing has happened to this artifact since `when` — as far as the
    // journal knows. Then whatever is installed NOW was installed THEN.
    if (currentVersion != null && stamped && installedAt <= at) {
      // …and the install record itself proves it: it was written before `when`
      // and nothing has rewritten it since. True regardless of the horizon.
      return known(currentVersion);
    }
    if (!covered) return unknown("the journal does not reach back that far");
    if (currentVersion != null && stamped && installedAt > at) {
      // The record was written AFTER `when`, yet the journal — which covers
      // that whole stretch — never saw the job. Something installed this
      // behind the hub's back; do not pretend to know what was there before.
      return unknown("an install after that point left no journal entry");
    }
    return known(currentVersion); // includes "was not installed then" (null)
  }

  // Something DID change after `when`. The FIRST of those changes (row.after is
  // newest-first, so its last element) may simply say what it replaced — and a
  // v0.10 entry does, which settles the question outright: nothing happened
  // between `when` and that entry, so what it covered up IS the state at
  // `when`. No journal depth needed, and no chain to walk.
  const first = derive(row.after[row.after.length - 1], opts);
  if (first.prior === "set") return known(first.previousVersion);
  if (first.prior === "clear") return known(null);

  // Otherwise fall back on the chain: the state as of `when` is whatever the
  // newest entry at-or-before `when` left behind.
  if (!row.before) {
    // No entry older than `when` for this artifact, and the change after it
    // predates v0.10 — so it says "Installed <app> <version>" whether it was a
    // first install or an update, and cannot tell us whether something was
    // already there.
    return unknown(covered ? "nothing was recorded for it before that point" : "the journal does not reach back that far");
  }
  const b = derive(row.before, opts);
  if (b.effect === "set") return known(b.version);
  if (b.effect === "clear") return known(null); // definitively not installed then
  return unknown("the last change before that point recorded no version");
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

function actionFor(row) {
  if (row.uncertain) return "none"; // never act on a guess
  if (row.version == null) return row.currentVersion == null ? "none" : "remove";
  if (row.currentVersion == null) return "install";
  return sameVersion(row.version, row.currentVersion) ? "none" : "install";
}

/**
 * The published tag that carries `version`, or null when the release is gone.
 * A tag is a string a human chose ("v1.4.0", "nx-1.3", "1.4.0"), so the match
 * runs on discovery's parsed `version` first and the raw tag second.
 */
function tagForVersion(releases, version) {
  const want = ver(version);
  if (!want) return null;
  const list = Array.isArray(releases) ? releases : [];
  const byVersion = list.find((r) => r && r.version != null && ver(r.version) === want);
  if (byVersion) return byVersion.tag || null;
  const byTag = list.find((r) => r && (String(r.tag) === want || String(r.tag) === `v${want}`));
  return byTag ? byTag.tag || null : null;
}

/** The newest config snapshot taken at or before `when` for this app. */
function snapshotAt(appId, when, opts = {}) {
  try {
    const list = snapshotsOf(opts).list(appId) || []; // newest first
    for (const s of list) {
      const ts = Date.parse(str(s && s.ts));
      if (Number.isFinite(ts) && ts <= when) return s;
    }
  } catch (_) {
    /* no snapshots for this app — not a reason to lose the plan */
  }
  return null;
}

/** Releases for one app, cache first — injectable so the CLI can fetch. */
async function releasesFor(appId, opts = {}) {
  if (typeof opts.releases === "function") return (await opts.releases(appId)) || [];
  try {
    return discoveryOf(opts).getReleases(appId) || [];
  } catch (_) {
    return [];
  }
}

function appModel(appId, opts = {}) {
  if (typeof opts.findApp === "function") {
    try {
      return opts.findApp(appId) || null;
    } catch (_) {
      return null;
    }
  }
  try {
    return discoveryOf(opts).findApp(appId) || null;
  } catch (_) {
    return null;
  }
}

/**
 * SPEC: `checkpointAt(when)` → {ts, apps:[{appId, artifactId, version,
 * currentVersion, action, snapshot?}]}, plus the `uncertain` flag [replay] owes
 * the UI and the CLI.
 *
 * Rows where nothing needs doing AND nothing is in doubt are left out — a
 * checkpoint on `now` is an empty plan, which is exactly what it should be.
 *
 * @param {number|string|Date} when
 * @param {object} [opts] {recorder, state, snapshots, discovery, releases,
 *                         findApp, now, limit}
 */
async function checkpointAt(when, opts = {}) {
  const at = requireWhen(when, opts);
  const now = nowMs(opts);
  const journal = readJournal(opts);
  let installs = [];
  try {
    installs = stateOf(opts).listInstalls() || [];
  } catch (_) {
    installs = []; // no state.json yet: nothing is installed
  }

  const rows = reconstruct(at, {
    entries: journal.entries,
    installs,
    horizon: journal.horizon,
    recorder: opts.recorder,
  });

  const apps = [];
  for (const row of rows) {
    const action = actionFor(row);
    if (action === "none" && !row.uncertain) continue;

    const app = appModel(row.appId, opts);
    const entry = {
      appId: row.appId,
      appName: (app && app.name) || row.appId,
      artifactId: row.artifactId,
      // the version at `when` (null = not installed then, or unknown when
      // `uncertain` — those two are told apart by the flag, never guessed)
      version: row.version,
      currentVersion: row.currentVersion,
      action,
      tag: null,
      snapshot: null,
      snapshotAt: null,
      uncertain: row.uncertain,
      why: row.why,
      skipReason: row.uncertain ? "uncertain" : null,
    };

    if (action === "install") {
      const releases = await releasesFor(row.appId, opts);
      entry.tag = tagForVersion(releases, row.version);
      if (!entry.tag) entry.skipReason = app ? "unknown-tag" : "unknown-app";
    }

    const snap = snapshotAt(row.appId, at, opts);
    if (snap) {
      entry.snapshot = snap.file;
      entry.snapshotAt = snap.ts;
    }
    apps.push(entry);
  }

  return {
    ts: at,
    iso: new Date(at).toISOString(),
    now,
    apps,
    // Roll-ups the renderers would otherwise all recompute.
    uncertain: apps.some((a) => a.uncertain),
    actionable: apps.filter((a) => a.action !== "none" && !a.skipReason).length,
    skipped: apps.filter((a) => a.skipReason).length,
    horizon: journal.horizon,
    truncated: journal.truncated,
  };
}

/* ------------------------------------------------------------------ */
/* the executor                                                        */
/* ------------------------------------------------------------------ */

/**
 * Queue one job and resolve when it finishes.
 *
 * The default runner POLLS jobs.list() rather than listening for events: this
 * module has no event bus of its own, and the hub's fan-out is ipc's. The CLI
 * injects `runJob` instead, so a terminal restore gets the same progress bar
 * every other command draws.
 */
function defaultRunJob(kind, target, opts = {}) {
  const jobs = jobsOf(opts);
  const pollMs = Number(opts.pollMs) >= 0 ? Number(opts.pollMs) : Number(deps.pollMs) || 200;
  return new Promise((resolve, reject) => {
    let jobId;
    try {
      jobId = kind === "remove" ? jobs.uninstall(target.appId, target.artifactId) : jobs.installVersion(target.appId, target.artifactId, target.tag);
    } catch (e) {
      reject(e);
      return;
    }
    let seen = false;
    const tick = () => {
      let job = null;
      try {
        job = (jobs.list() || []).find((j) => j && (j.id === jobId || j.jobId === jobId)) || null;
      } catch (e) {
        reject(e);
        return;
      }
      if (!job) {
        // Never seen at all = the queue never took it. Seen and then gone = it
        // was pruned out from under us; either way we cannot claim success.
        reject(new Error(seen ? "the job disappeared before it finished" : "the job was never queued"));
        return;
      }
      seen = true;
      if (job.status === "done") {
        resolve({ ok: true, jobId, message: job.message || "done" });
        return;
      }
      if (job.status === "error" || job.status === "cancelled") {
        reject(new Error(job.error || job.message || job.status));
        return;
      }
      const timer = setTimeout(tick, pollMs);
      if (timer.unref) timer.unref();
    };
    tick();
  });
}

function stepEvent(phase, entry, extra = {}) {
  return Object.assign(
    {
      type: EVENT,
      phase,
      appId: (entry && entry.appId) || null,
      artifactId: (entry && entry.artifactId) || null,
    },
    extra
  );
}

/**
 * The plan's execution order. Removals first (they free the disk and can never
 * be undone by a later install), then installs, then the configs — a config
 * snapshot has to land ON TOP of the build it belongs to, never under it.
 */
function orderPlan(apps) {
  const acted = apps.filter((a) => a.action !== "none" && !a.skipReason);
  const by = (a, b) => ordinal(a.appId, b.appId) || ordinal(a.artifactId, b.artifactId);
  return [...acted.filter((a) => a.action === "remove").sort(by), ...acted.filter((a) => a.action === "install").sort(by)];
}

/**
 * SPEC: `restore(when, {configs})` — walk the plan through the existing
 * pipelines, serialized, emitting `checkpoint-progress {phase, appId}`.
 *
 * Skips are reported, never acted on: an `uncertain` app (the journal cannot
 * say what was there) and a version whose release has been deleted both leave
 * a row in `results` with `skipped: true` and a reason.
 *
 * A failing step does NOT abort the rest — the same choice `nx update --all`
 * makes. The run's own verdict comes last, with `appId: null`.
 */
async function restore(when, opts = {}) {
  if (running) throw new Error("A checkpoint restore is already running.");
  running = true;
  const sink = opts.emit || deps.emit;
  const run = typeof opts.runJob === "function" ? opts.runJob : typeof deps.runJob === "function" ? deps.runJob : defaultRunJob;
  const wantConfigs = opts.configs === true;

  try {
    emit({ type: EVENT, phase: "planning", appId: null, artifactId: null }, sink);
    const plan = await checkpointAt(when, opts);

    const results = [];
    for (const entry of plan.apps) {
      if (entry.skipReason) {
        results.push({
          appId: entry.appId,
          artifactId: entry.artifactId,
          action: entry.action,
          version: entry.version,
          ok: false,
          skipped: true,
          reason: entry.skipReason,
          why: entry.why || reasonText(entry),
        });
      }
    }

    for (const entry of orderPlan(plan.apps)) {
      const phase = entry.action === "remove" ? "removing" : "installing";
      emit(stepEvent(phase, entry, { version: entry.version, tag: entry.tag }), sink);
      const row = {
        appId: entry.appId,
        artifactId: entry.artifactId,
        action: entry.action,
        version: entry.version,
        tag: entry.tag,
        ok: false,
        skipped: false,
        reason: null,
      };
      try {
        const result = await run(entry.action, entry, opts);
        row.ok = true;
        row.message = (result && result.message) || null;
      } catch (e) {
        row.ok = false;
        row.error = (e && e.message) || String(e);
        emit(stepEvent("failed", entry, { error: row.error }), sink);
        log(`${entry.appId}/${entry.artifactId}: ${entry.action} failed — ${row.error}`);
      }
      results.push(row);
    }

    if (wantConfigs) await restoreConfigs(plan, results, { opts, sink });

    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    const verdict = {
      ok: failed === 0,
      ts: plan.ts,
      iso: plan.iso,
      configs: wantConfigs,
      results,
      counts: {
        done: results.filter((r) => r.ok).length,
        failed,
        skipped: results.filter((r) => r.skipped).length,
      },
      plan,
    };
    emit(
      {
        type: EVENT,
        phase: failed ? "failed" : "done",
        appId: null,
        artifactId: null,
        ts: plan.ts,
        counts: verdict.counts,
      },
      sink
    );
    return verdict;
  } finally {
    running = false;
  }
}

/**
 * The config half, once per APP (snapshots are per app, artifacts are not) and
 * only for apps this run actually PUT BACK — a config restored over a build the
 * plan did not move is a surprise nobody asked for, and an app that was not
 * installed at the checkpoint has no business getting its config files
 * recreated after the plan just removed it.
 */
async function restoreConfigs(plan, results, { opts, sink }) {
  const touched = new Set(results.filter((r) => r.ok && !r.skipped && r.action === "install").map((r) => r.appId));
  const seen = new Set();
  for (const entry of plan.apps) {
    if (!entry.snapshot || !touched.has(entry.appId) || seen.has(entry.appId)) continue;
    seen.add(entry.appId);
    emit(stepEvent("restoring-config", entry, { file: entry.snapshot, snapshotAt: entry.snapshotAt }), sink);
    const row = {
      appId: entry.appId,
      artifactId: null,
      action: "config",
      file: entry.snapshot,
      ok: false,
      skipped: false,
      reason: null,
    };
    try {
      const app = appModel(entry.appId, opts);
      await snapshotsOf(opts).restore(entry.appId, entry.snapshot, { app: app || null });
      row.ok = true;
    } catch (e) {
      row.error = (e && e.message) || String(e);
      emit(stepEvent("failed", entry, { error: row.error, file: entry.snapshot }), sink);
      log(`${entry.appId}: config restore failed — ${row.error}`);
    }
    results.push(row);
  }
  return results;
}

/** One human line for a skip — the CLI and the UI both want the same words. */
function reasonText(entry) {
  const reason = entry && entry.skipReason;
  if (reason === "uncertain") return entry.why || "the journal cannot say what was installed then";
  if (reason === "unknown-tag") return `no published release carries ${entry.version}`;
  if (reason === "unknown-app") return "the hub no longer knows this app";
  return "";
}

module.exports = {
  init,
  parseWhen,
  requireWhen,
  timeline,
  checkpointAt,
  restore,
  // exported for the CLI, the IPC layer and the tests
  reconstruct,
  derive,
  readJournal,
  actionFor,
  tagForVersion,
  snapshotAt,
  orderPlan,
  defaultRunJob,
  reasonText,
  sameVersion,
  EVENT,
  PHASES,
  ACTIONS,
  SKIP_REASONS,
  SCAN_LIMIT,
  _reset,
};
