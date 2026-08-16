"use strict";
// NX Hub — the flight recorder (SPEC v0.8 "Flight recorder").
//
// A hub that runs for weeks forgets everything the moment it quits: what got
// installed, which app fell off the bus at 3am, which stack refused to come up.
// This module is the memory. It taps the event fan-out (ONE line in ipc.emit),
// keeps the handful of events a human would ever ask about, and writes them as
// JSONL to <dataDir>/events.jsonl.
//
//   record(evt)   normalize + buffer (never throws — a poisoned event is a
//                 dropped line, never a broken fan-out)
//   query(q)      newest-first read-back across the rotated files
//   init(o)       {dataDir, log, now, maxBytes, flushMs, keep} — every knob is
//                 injectable so the tests can force a rotation in 200 bytes
//
// Design notes:
//   * Writes are BUFFERED and flushed on a ≤1s timer (and on close, on process
//     exit, and before every query). No fsync: this is a journal, not a ledger
//     — losing the last second of it after a kill -9 costs nothing.
//   * Rotation keeps three files: events.jsonl → events.1.jsonl →
//     events.2.jsonl, oldest dropped. 5 MB each by default.
//   * A reader must tolerate a TORN LAST LINE (the process died mid-append),
//     so query() skips any line that does not parse. That is also why every
//     entry is exactly one line of JSON.
//   * All time formatting is locale-independent (ordinal, ISO, hand-built
//     YYYY-MM-DD) — the host may run de_DE.

const fs = require("fs");
const path = require("path");

const config = require("./config");

/* ------------------------------------------------------------------ */
/* shape                                                               */
/* ------------------------------------------------------------------ */

const CURRENT_FILE = "events.jsonl";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 1000;
/** events.1.jsonl + events.2.jsonl behind the live one (SPEC: "keep 2"). */
const DEFAULT_KEEP = 2;
/** SPEC: the summary is ONE human line. */
const MAX_SUMMARY = 160;
const MAX_DATA_VALUE = 200;
const MAX_DATA_KEYS = 10;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

/** The event types the recorder listens to. Everything else is ignored. */
const RECORDED_TYPES = Object.freeze([
  "job-done",
  "job-error",
  "update-available",
  "stack-progress", // terminal phases only (the run's own verdict)
  "connector-changed", // diffed into connector-join / connector-leave
  "fleet-progress", // terminal events only
  "supervisor", // v0.8 [guardian]
]);

/** The types that end up IN the journal (what query() can return). */
const ENTRY_TYPES = Object.freeze([
  "job-done",
  "job-error",
  "update-available",
  "stack-progress",
  "connector-join",
  "connector-leave",
  "fleet-progress",
  "supervisor",
  "day", // the daily marker, written before the first entry of a new local day
]);

/**
 * A stack's TERMINAL phases. The run's own verdict always carries
 * `stepIndex: null` (stacks.js) — per-step failures/stops are noise here.
 */
const TERMINAL_STACK_PHASES = new Set(["done", "failed", "stopped", "triggered"]);

const MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let state = null;
let exitHooked = false;

function defaults() {
  return {
    dataDir: null, // null = resolve config.dataDir() lazily (tests move it)
    log: null,
    now: null,
    maxBytes: DEFAULT_MAX_BYTES,
    flushMs: DEFAULT_FLUSH_MS,
    keep: DEFAULT_KEEP,
    buffer: [],
    timer: null,
    lastDay: null,
    /** Has THIS incarnation proven the journal ends on a newline? */
    tailOk: false,
    /** appId -> the client record we last saw on the bus (for join/leave). */
    clients: new Map(),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir] where events.jsonl lives (default: config's)
 * @param {function} [opts.log] line logger
 * @param {function} [opts.now] injectable clock, → epoch ms
 * @param {number} [opts.maxBytes] rotate above this (default 5 MB)
 * @param {number} [opts.flushMs] buffer window; 0 = write through
 * @param {number} [opts.keep] rotated files kept behind the live one
 */
function init(opts = {}) {
  flush(); // never lose what the previous incarnation buffered
  const s = defaults();
  if (opts.dataDir) s.dataDir = String(opts.dataDir);
  if (typeof opts.log === "function") s.log = opts.log;
  if (typeof opts.now === "function") s.now = opts.now;
  if (Number(opts.maxBytes) > 0) s.maxBytes = Number(opts.maxBytes);
  if (opts.flushMs != null && Number(opts.flushMs) >= 0) s.flushMs = Number(opts.flushMs);
  if (Number(opts.keep) >= 0) s.keep = Math.floor(Number(opts.keep));
  state = s;
  hookExit();
  primeDay();
  return module.exports;
}

/** Auto-init on first use so a hub (or a test) that never called init() works. */
function live() {
  if (!state) {
    state = defaults();
    hookExit();
    primeDay();
  }
  return state;
}

/** A crash takes the buffer with it; a normal exit must not. */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  try {
    process.once("exit", () => {
      try {
        flush();
      } catch (_) {
        /* an exit handler must never throw */
      }
    });
  } catch (_) {
    /* no process object worth hooking */
  }
}

/**
 * Which local day the journal already ends on, so a restart inside the same
 * day does not draw a second day marker. Reads the tail only.
 */
function primeDay() {
  const s = state;
  try {
    const file = currentPath();
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const e = parseLine(lines[i]);
      if (!e) continue;
      s.lastDay = dayKey(e.ts);
      return;
    }
  } catch (_) {
    /* no journal yet — the first record opens the first day */
  }
}

function nowMs() {
  const s = live();
  if (s.now) {
    const v = Number(s.now());
    if (Number.isFinite(v)) return v;
  }
  return Date.now();
}

function dataDir() {
  const s = live();
  return s.dataDir || config.dataDir();
}

function currentPath() {
  return path.join(dataDir(), CURRENT_FILE);
}

function rotatedPath(n) {
  return path.join(dataDir(), `events.${n}.jsonl`);
}

/** Newest first: the live journal, then events.1, events.2… */
function files() {
  const s = live();
  const out = [currentPath()];
  for (let i = 1; i <= s.keep; i += 1) out.push(rotatedPath(i));
  return out;
}

function logSafe(message) {
  const s = state;
  try {
    if (s && s.log) s.log(message);
    else config.log(message);
  } catch (_) {
    /* logging must never throw */
  }
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

/** One human line — never more (SPEC: summary ≤160 chars). */
function clip(s, max = MAX_SUMMARY) {
  const text = String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** "v1.4.0" / "1.4.0" → "1.4.0" (never "vv1.4.0" downstream). */
function ver(v) {
  const s = str(v).trim();
  return /^v\d/.test(s) ? s.slice(1) : s;
}

/** Small, primitive-only extras. Anything else is not worth a journal line. */
function pick(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  let keys = 0;
  for (const key of Object.keys(obj)) {
    if (keys >= MAX_DATA_KEYS) break;
    const v = obj[key];
    if (v == null || v === "") continue;
    if (typeof v === "string") out[key] = clip(v, MAX_DATA_VALUE);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else continue;
    keys += 1;
  }
  return out;
}

/** Local YYYY-MM-DD, hand-built — never toLocaleDateString (the host may be de_DE). */
function dayKey(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "45s" · "12m" · "3h" · "2d" — ordinal, locale-free. */
function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < MS.m) return `${Math.max(1, Math.round(n / MS.s))}s`;
  if (n < MS.h) return `${Math.round(n / MS.m)}m`;
  if (n < MS.d) return `${Math.round(n / MS.h)}h`;
  return `${Math.round(n / MS.d)}d`;
}

function entry(ts, type, fields = {}) {
  const e = { ts: Number(ts) || 0, type };
  for (const key of ["appId", "artifactId", "peerId", "stackId"]) {
    const v = str(fields[key]);
    if (v) e[key] = v;
  }
  e.summary = clip(fields.summary);
  const data = pick(fields.data);
  if (Object.keys(data).length) e.data = data;
  return e;
}

function one(e) {
  return e ? [e] : [];
}

/* ------------------------------------------------------------------ */
/* normalization — the only place that knows what an event MEANS       */
/* ------------------------------------------------------------------ */

const JOB_VERBS = [
  [/^installed\b/i, "installed"],
  [/^updated\b/i, "updated"],
  [/^(?:removed|uninstalled)\b/i, "uninstalled"],
  [/^(?:restored|rolled back)\b/i, "rolled back"],
];

/**
 * jobs.js emits only {jobId, appId, artifactId, message} — the job's TYPE never
 * makes it onto the wire — so the verb and the app's display name are read back
 * out of the message it wrote ("Installed WiVRn NX 1.4.0", "Removed WiVRn NX —
 * Headset APK"). An emitter that does pass `jobType`/`appName` wins over this.
 */
function parseJobMessage(message) {
  const out = { verb: null, name: "", version: "" };
  const msg = str(message).trim();
  if (!msg) return out;
  for (const [re, verb] of JOB_VERBS) {
    const m = msg.match(re);
    if (!m) continue;
    out.verb = verb;
    let rest = msg.slice(m[0].length).trim();
    // "Installed. <post-install note>" — a note is not an app name.
    if (rest.startsWith(".")) rest = "";
    rest = rest.split(" — ")[0].trim();
    const v = rest.match(/\s+v?(\d[0-9A-Za-z.+-]*)$/);
    if (v) {
      out.version = v[1];
      rest = rest.slice(0, v.index).trim();
    }
    out.name = rest;
    break;
  }
  return out;
}

function jobVerb(evt, parsed) {
  if (evt.updated === true) return "updated";
  const explicit = str(evt.jobType || (evt.job && evt.job.type)).toLowerCase();
  if (explicit === "install") return evt.previousVersion ? "updated" : "installed";
  if (explicit === "update") return "updated";
  if (explicit === "uninstall") return "uninstalled";
  if (explicit === "rollback") return "rolled back";
  return parsed.verb || "finished";
}

function jobDone(evt, ts) {
  const message = str(evt.message);
  const parsed = parseJobMessage(message);
  const verb = jobVerb(evt, parsed);
  const name = str(evt.appName) || parsed.name || str(evt.appId) || "an app";
  const version = ver(evt.version) || parsed.version;
  return entry(ts, "job-done", {
    appId: evt.appId,
    artifactId: evt.artifactId,
    summary: `${verb} ${name}${version ? ` v${version}` : ""}`,
    data: { jobId: evt.jobId, verb, version, message },
  });
}

function jobError(evt, ts) {
  const message = str(evt.message) || "failed";
  const name = str(evt.appName) || str(evt.appId) || "a job";
  const cancelled = /^cancell?ed/i.test(message);
  return entry(ts, "job-error", {
    appId: evt.appId,
    artifactId: evt.artifactId,
    summary: cancelled ? `cancelled ${name}` : `${name} failed — ${message}`,
    data: { jobId: evt.jobId, message, silent: evt.silent === true ? true : null },
  });
}

function updateAvailable(evt, ts) {
  const name = str(evt.appName) || str(evt.appId) || "an app";
  const version = ver(evt.version);
  return entry(ts, "update-available", {
    appId: evt.appId,
    artifactId: evt.artifactId,
    summary: `update available: ${name}${version ? ` v${version}` : ""}`,
    data: { version },
  });
}

function stackProgress(evt, ts) {
  const phase = str(evt.phase).toLowerCase();
  if (!TERMINAL_STACK_PHASES.has(phase)) return null;
  // Only the RUN's verdict, never a per-step phase (stacks.js marks the run's
  // own terminal event with stepIndex null).
  if (evt.stepIndex != null) return null;
  const stackId = str(evt.stackId);
  const label = str(evt.stackName) || stackId || "a stack";
  const message = str(evt.message);
  const reason = str(evt.reason);
  let summary;
  if (phase === "done") summary = `stack ${label} is up`;
  else if (phase === "failed") summary = `stack ${label} failed${message ? ` — ${message}` : ""}`;
  else if (phase === "stopped") summary = `stack ${label} stopped`;
  else summary = `stack ${label} triggered${reason ? ` — ${reason}` : ""}`;
  return entry(ts, "stack-progress", {
    stackId,
    appId: evt.appId,
    summary,
    data: { phase, message, reason, failedStep: evt.failedStep, count: evt.count },
  });
}

function fleetProgress(evt, ts) {
  const event = str(evt.event);
  const phase = str(evt.phase).toLowerCase();
  const failed = event === "job-error" || phase === "error";
  const done = event === "job-done" || phase === "done";
  if (!failed && !done) return null; // terminal events only
  const who = str(evt.peerName) || str(evt.peerId) || "a peer";
  const what = str(evt.appName) || str(evt.appId) || "a job";
  const message = str(evt.message);
  return entry(ts, "fleet-progress", {
    peerId: evt.peerId,
    appId: evt.appId,
    artifactId: evt.artifactId,
    summary: failed ? `${what} failed on ${who}${message ? ` — ${message}` : ""}` : `${what} finished on ${who}`,
    data: { event: event || (failed ? "job-error" : "job-done"), peerName: evt.peerName, message },
  });
}

/**
 * v0.8 [guardian] emits these. The shape is theirs, so this stays generous:
 * an explicit `summary` wins, then `message`, then something built out of
 * whatever action word came along.
 */
function supervisor(evt, ts) {
  const name = str(evt.appName) || str(evt.appId) || "an app";
  const action = str(evt.action) || str(evt.phase);
  const attempt = Number(evt.attempt);
  let summary = str(evt.summary) || str(evt.message);
  if (!summary) {
    if (action === "relaunch" || action === "relaunched") {
      summary = `relaunched ${name}${Number.isFinite(attempt) && attempt > 0 ? ` (attempt ${attempt})` : ""}`;
    } else if (action === "gave-up" || action === "giveup") {
      summary = `gave up relaunching ${name}`;
    } else if (action) {
      summary = `${name}: ${action}`;
    } else {
      summary = `${name}: supervised`;
    }
  }
  return entry(ts, "supervisor", {
    appId: evt.appId,
    artifactId: evt.artifactId,
    summary,
    data: { action, attempt: Number.isFinite(attempt) ? attempt : null, delayMs: evt.delayMs, reason: evt.reason },
  });
}

/**
 * `connector-changed` carries no roster — the bus only says "something moved".
 * ipc's tap therefore attaches the CURRENT client list (getClients()) and this
 * diffs it against the last one it saw. No polling, no second source of truth.
 *
 * @returns {object[]} zero or more join/leave entries
 */
function connectorDiff(evt, ts) {
  const list = Array.isArray(evt.clients) ? evt.clients : null;
  if (!list) return []; // no roster attached = nothing can be said
  const s = live();
  const next = new Map();
  for (const c of list) {
    const app = str(c && c.app);
    if (app) next.set(app, c || {});
  }
  const prev = s.clients;
  const out = [];
  for (const [app, c] of next) {
    if (prev.has(app)) continue;
    const version = ver(c.version);
    out.push(
      entry(ts, "connector-join", {
        appId: app,
        summary: `${app} connected${version ? ` v${version}` : ""}`,
        data: { version, pid: Number(c.pid) || null },
      })
    );
  }
  for (const [app, c] of prev) {
    if (next.has(app)) continue;
    const since = Date.parse(str(c.since));
    const uptime = Number.isFinite(since) ? fmtDuration(ts - since) : "";
    out.push(
      entry(ts, "connector-leave", {
        appId: app,
        summary: `${app} disconnected${uptime ? ` after ${uptime}` : ""}`,
        data: { version: ver(c.version), uptime },
      })
    );
  }
  s.clients = next;
  return out;
}

/** evt → zero or more journal entries. Pure; throws only on truly hostile input. */
function normalize(evt) {
  if (!evt || typeof evt !== "object") return [];
  const type = typeof evt.type === "string" ? evt.type : null;
  if (!type) return [];
  const ts = nowMs();
  switch (type) {
    case "job-done":
      return one(jobDone(evt, ts));
    case "job-error":
      return one(jobError(evt, ts));
    case "update-available":
      return one(updateAvailable(evt, ts));
    case "stack-progress":
      return one(stackProgress(evt, ts));
    case "connector-changed":
      return connectorDiff(evt, ts);
    case "fleet-progress":
      return one(fleetProgress(evt, ts));
    case "supervisor":
      return one(supervisor(evt, ts));
    default:
      return []; // toast, state-changed, job-progress, fleet-changed, …
  }
}

/* ------------------------------------------------------------------ */
/* the journal                                                         */
/* ------------------------------------------------------------------ */

/**
 * The tap. Called from ipc.emit BEFORE the fan-out, for every event the hub
 * raises — so it has to be cheap, and it must NEVER throw.
 *
 * @param {object} evt any hub event
 * @returns {object[]} the entries it wrote (empty for an ignored event)
 */
function record(evt) {
  try {
    const entries = normalize(evt);
    if (!entries.length) return [];
    const s = live();
    for (const e of entries) {
      const marker = dayMarker(e.ts);
      if (marker) push(marker);
      push(e);
    }
    if (s.flushMs <= 0) flush();
    else schedule();
    return entries;
  } catch (e) {
    logSafe(`recorder: dropped an event — ${(e && e.message) || e}`);
    return [];
  }
}

/** The daily marker, drawn once, before the first entry of a new local day. */
function dayMarker(ts) {
  const s = live();
  const key = dayKey(ts);
  if (s.lastDay === key) return null;
  s.lastDay = key;
  return { ts: Number(ts) || 0, type: "day", summary: key };
}

/** Serialize now (a cyclic `data` must not survive to bite flush()). */
function push(e) {
  const s = live();
  let line;
  try {
    line = `${JSON.stringify(e)}\n`;
  } catch (err) {
    logSafe(`recorder: unserializable entry — ${(err && err.message) || err}`);
    return;
  }
  s.buffer.push(line);
}

function schedule() {
  const s = live();
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    flush();
  }, Math.max(0, s.flushMs));
  if (s.timer.unref) s.timer.unref();
}

/**
 * Write the buffer out. Synchronous on purpose: it is at most a second's worth
 * of short lines, and it has to be safe to call from a process `exit` handler.
 *
 * @returns {number} lines written
 */
function flush() {
  const s = state;
  if (!s) return 0;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (!s.buffer.length) return 0;
  const lines = s.buffer;
  s.buffer = [];
  let chunk = lines.join("");
  try {
    config.ensureDir(dataDir());
    const file = currentPath();
    // A process that died mid-append left a line with no newline on it. Appending
    // straight onto that would GLUE the next entry to the wreckage and lose it
    // too, so the first write of every incarnation heals the tail first. After
    // that our own writes are proof enough — they all end in "\n".
    if (!s.tailOk) {
      if (!endsWithNewline(file)) chunk = `\n${chunk}`;
      s.tailOk = true;
    }
    rotateIfNeeded(file, Buffer.byteLength(chunk));
    fs.appendFileSync(file, chunk);
  } catch (e) {
    logSafe(`recorder: could not write the journal — ${(e && e.message) || e}`);
    return 0;
  }
  return lines.length;
}

/** Does the journal end on a line boundary? (A missing file does.) */
function endsWithNewline(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch (_) {
    return true; // nothing there to glue onto
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * SPEC: rotate at 5 MB → events.1.jsonl, keep 2. The oldest file is dropped,
 * so the recorder's footprint is bounded at (keep + 1) × maxBytes.
 *
 * Rotation happens BEFORE the append that would cross the line, so no file
 * ever exceeds maxBytes (except by one oversized line, which still gets a
 * fresh file to itself).
 */
function rotateIfNeeded(file, incoming) {
  const s = live();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return; // no journal yet
  }
  if (size + incoming <= s.maxBytes) return;
  if (s.keep <= 0) {
    try {
      fs.rmSync(file, { force: true });
    } catch (_) {
      /* ignore */
    }
    return;
  }
  try {
    fs.rmSync(rotatedPath(s.keep), { force: true });
  } catch (_) {
    /* nothing that old yet */
  }
  for (let i = s.keep - 1; i >= 1; i -= 1) {
    try {
      fs.renameSync(rotatedPath(i), rotatedPath(i + 1));
    } catch (_) {
      /* that generation does not exist yet */
    }
  }
  try {
    fs.renameSync(file, rotatedPath(1));
  } catch (e) {
    logSafe(`recorder: rotation failed — ${(e && e.message) || e}`);
  }
}

/** One JSONL line → an entry, or null (blank line, torn write, garbage). */
function parseLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  let e;
  try {
    e = JSON.parse(text);
  } catch (_) {
    return null; // a half-written last line is expected, not exceptional
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return null;
  if (typeof e.type !== "string" || !e.type) return null;
  if (typeof e.summary !== "string") e.summary = "";
  return e;
}

/* ------------------------------------------------------------------ */
/* query                                                               */
/* ------------------------------------------------------------------ */

function clampLimit(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

/**
 * Accepts epoch ms, a Date, an ISO date/datetime, or a relative "24h"/"2d".
 * Locale-independent by construction: a bare YYYY-MM-DD becomes LOCAL midnight
 * built from its own parts, never Date.parse of an ambiguous string.
 *
 * Resolves relatives against the RECORDER's clock (injectable via init({now})),
 * so a caller and the journal can never disagree about what "24h" means.
 *
 * @returns {number|null} epoch ms, or null when absent/unparseable
 */
function parseSince(value, now) {
  if (now == null) now = nowMs();
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return now;

  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (rel) return now - Number(rel[1]) * MS[rel[2].toLowerCase()];

  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0, 0);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const at = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(at) ? at : null;
  }
  if (/^\d{11,}$/.test(s)) return Number(s);
  return null;
}

function typeSet(type) {
  const list = Array.isArray(type) ? type : String(type == null ? "" : type).split(",");
  const out = new Set();
  for (const t of list) {
    const v = String(t == null ? "" : t).trim();
    if (v) out.add(v);
  }
  return out;
}

/**
 * SPEC: `query({since, type, appId, limit})` reads back NEWEST FIRST.
 *
 * Reads the live journal, then the rotated ones, only as far as it has to:
 * every file is append-ordered, so the scan stops the moment it walks past
 * `since`. Torn lines are skipped, never fatal.
 *
 * @param {object} [q]
 * @param {number|string|Date} [q.since] lower bound (inclusive)
 * @param {number|string|Date} [q.until] upper bound (inclusive)
 * @param {string|string[]} [q.type] one type, a comma list, or an array
 * @param {string} [q.appId]
 * @param {number} [q.limit] default 200, hard max 1000
 * @returns {object[]} entries, newest first
 */
function query(q = {}) {
  const opts = q && typeof q === "object" ? q : {};
  const now = nowMs();
  const limit = clampLimit(opts.limit);
  const since = parseSince(opts.since, now);
  const until = parseSince(opts.until, now);
  const types = typeSet(opts.type);
  const appId = str(opts.appId).trim().toLowerCase();

  flush(); // an event recorded a moment ago is part of the answer

  const out = [];
  for (const file of files()) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue; // not rotated that far yet
    }
    const lines = text.split("\n");
    let walkedPast = false;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const e = parseLine(lines[i]);
      if (!e) continue;
      if (since != null && e.ts < since) {
        walkedPast = true; // append-ordered: everything below is older still
        break;
      }
      if (until != null && e.ts > until) continue;
      if (types.size && !types.has(e.type)) continue;
      if (appId && str(e.appId).toLowerCase() !== appId) continue;
      out.push(e);
      if (out.length >= limit) return out;
    }
    if (walkedPast) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** Flush and stand down (the timer, not the state — query still works). */
function close() {
  const n = flush();
  const s = state;
  if (s && s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  return n;
}

/** Where the journal lives, for doctor/tests. */
function paths() {
  const s = live();
  const rotated = [];
  for (let i = 1; i <= s.keep; i += 1) rotated.push(rotatedPath(i));
  return { dir: dataDir(), current: currentPath(), rotated };
}

/** Tests only: forget everything WITHOUT writing the buffer out. */
function _reset() {
  const s = state;
  if (s && s.timer) clearTimeout(s.timer);
  state = null;
}

module.exports = {
  init,
  record,
  query,
  flush,
  close,
  paths,
  parseSince,
  // exported for the CLI/UI and for the tests
  RECORDED_TYPES,
  ENTRY_TYPES,
  TERMINAL_STACK_PHASES,
  MAX_SUMMARY,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  clampLimit,
  dayKey,
  fmtDuration,
  parseJobMessage,
  _reset,
};
