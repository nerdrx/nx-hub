"use strict";
// `nx log` — the flight recorder from the terminal. SPEC v0.8 "Flight recorder".
//
//   nx log
//   nx log --since 24h --type job-done,job-error --app wivrn-nx --limit 50
//   nx log --json
//   nx log --follow            (poll every 2s; Ctrl-C leaves with 0)
//
// A thin shell over src/main/recorder.js, in the same spirit as `nx dev` over
// devlinks: every decision about what an event MEANS was made when it was
// recorded. This file parses what the user typed, paints it, and picks an exit
// code. It reads the journal FILE, so it works whether or not the hub is up.
//
// The journal is stored newest-first; the terminal prints it CHRONOLOGICALLY
// (newest last, right above your prompt) — which is also what makes `--follow`
// read like `tail -f`.

const { createStyle } = require("./ansi");

const EXIT_OK = 0;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const FOLLOW_MS = 2000;

/**
 * Structurally index.js's UserError (message + hint + exitCode is all its catch
 * block reads), built here — index.js assigns its exports at the very bottom,
 * so importing the class back would race the dispatch. Same trick as dev.js.
 */
function userError(message, hint) {
  const e = new Error(message);
  e.name = "UserError";
  e.hint = hint || null;
  e.exitCode = 1;
  return e;
}

/* ------------------------------------------------------------------ */
/* pure rendering                                                      */
/* ------------------------------------------------------------------ */

/** type → the short chip in column two, and the palette it wears. */
const CHIPS = {
  "job-done": ["done", "cyan"],
  "job-error": ["error", "danger"],
  "update-available": ["update", "amber"],
  "stack-progress": ["stack", "violet"],
  "connector-join": ["join", "cyan"],
  "connector-leave": ["leave", "muted"],
  "fleet-progress": ["fleet", "violet"],
  supervisor: ["watch", "amber"],
};

const CHIP_WIDTH = Math.max(...Object.values(CHIPS).map(([label]) => label.length));

function chipOf(type) {
  return CHIPS[type] || [String(type || "?").slice(0, CHIP_WIDTH), "muted"];
}

/** Local HH:MM, hand-built — the host may run de_DE (SPEC: locale-independent). */
function hhmm(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local YYYY-MM-DD, same construction as the recorder's day marker. */
function dayKey(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function divider(label, st, width) {
  const rule = "─".repeat(Math.max(4, Math.min(48, (width || 60) - String(label).length - 6)));
  return `  ${st.dim(`── ${label} ${rule}`)}`;
}

/** One journal entry → one line. Day markers become a divider instead. */
function renderRow(entry, { style, width = 0 } = {}) {
  const st = style || createStyle(false);
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "day") return divider(entry.summary || "", st, width);
  const [label, paint] = chipOf(entry.type);
  const chip = (st[paint] || st.muted)(label.padEnd(CHIP_WIDTH));
  return `  ${st.dim(hhmm(entry.ts))}  ${chip}  ${st.text(entry.summary || entry.type)}`;
}

/**
 * @param {object[]} entries newest-first (as query returns them)
 * @param {object} opts {style, sinceLabel, width}
 * @returns {string} the whole block, oldest line first
 */
function renderLog(entries, opts = {}) {
  const st = opts.style || createStyle(false);
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const lines = ["", st.section("activity"), ""];
  if (!list.length) {
    if (opts.filtered) {
      lines.push(`  ${st.muted("Nothing in the journal matches that.")}`);
      lines.push(`  ${st.dim("Widen it: `nx log --since 7d`, or drop the --type / --app filter.")}`, "");
    } else {
      lines.push(`  ${st.muted("Nothing recorded yet.")}`);
      lines.push(`  ${st.dim("The hub writes this journal as it installs, updates and watches apps.")}`, "");
    }
    return lines.join("\n");
  }
  // Chronological: newest at the bottom, closest to the prompt. Day dividers
  // are DERIVED from the timestamps, so they survive a --type/--app filter that
  // strips the journal's own markers.
  let lastDay = null;
  for (const entry of list.slice().reverse()) {
    if (entry.type === "day") {
      lastDay = entry.summary || null;
    } else {
      const day = dayKey(entry.ts);
      if (day !== lastDay) {
        lines.push(divider(day, st, opts.width));
        lastDay = day;
      }
    }
    lines.push(renderRow(entry, { style: st, width: opts.width }));
  }
  const real = list.filter((e) => e.type !== "day").length;
  lines.push(
    "",
    `  ${st.dim(`${real} event${real === 1 ? "" : "s"}${opts.sinceLabel ? ` since ${opts.sinceLabel}` : ""}`)}`,
    ""
  );
  return lines.join("\n");
}

function logJson(entries, { since, until, type, appId, limit } = {}) {
  return {
    ok: true,
    count: Array.isArray(entries) ? entries.length : 0,
    query: {
      since: since == null ? null : since,
      until: until == null ? null : until,
      type: type && type.length ? type : null,
      appId: appId || null,
      limit,
    },
    events: Array.isArray(entries) ? entries : [],
  };
}

/* ------------------------------------------------------------------ */
/* follow                                                              */
/* ------------------------------------------------------------------ */

function keyOf(entry) {
  return `${entry.ts}|${entry.type}|${entry.summary}`;
}

/**
 * The `--follow` engine, pulled out so a test can drive it a tick at a time
 * instead of waiting on wall-clock seconds.
 *
 * Entries recorded inside the SAME millisecond as the last one we printed are
 * the interesting edge: the poll re-asks from `lastTs` (inclusive) and drops
 * what it already showed, so nothing is duplicated and nothing is skipped.
 *
 * @returns {{tick: function(): number, lastTs: function(): number}}
 */
function createFollower({ recorder, query = {}, write, style, format, from = 0, seenKeys = [] }) {
  let lastTs = Number(from) || 0;
  let seen = new Set(seenKeys);
  const paint = typeof format === "function" ? format : (e) => renderRow(e, { style });
  return {
    tick() {
      const fresh = recorder
        .query(Object.assign({}, query, { since: lastTs, limit: MAX_LIMIT }))
        .filter((e) => e.ts > lastTs || !seen.has(keyOf(e)));
      if (!fresh.length) return 0;
      for (const entry of fresh.slice().reverse()) write(paint(entry));
      lastTs = Math.max(lastTs, ...fresh.map((e) => e.ts));
      const nextSeen = new Set();
      for (const e of fresh) if (e.ts === lastTs) nextSeen.add(keyOf(e));
      // Anything still at lastTs from an earlier tick has to stay remembered.
      for (const k of seen) if (k.startsWith(`${lastTs}|`)) nextSeen.add(k);
      seen = nextSeen;
      return fresh.length;
    },
    lastTs: () => lastTs,
  };
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

function recorderOf(ctx) {
  // eslint-disable-next-line global-require
  return (ctx && ctx.recorder) || require("../main/recorder");
}

function parseLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) <= 0) {
    throw userError(`--limit wants a positive number, not "${raw}"`, "nx log --limit 50");
  }
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function parseTypes(raw) {
  return String(raw == null ? "" : raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `nx log [--since 24h] [--type a,b] [--app x] [--limit n] [--json] [--follow]`
 */
async function cmdLog(ctx) {
  const rec = recorderOf(ctx);
  const flags = ctx.flags || {};

  const sinceRaw = flags.since == null || flags.since === "" ? null : String(flags.since);
  const since = sinceRaw == null ? null : rec.parseSince(sinceRaw);
  if (sinceRaw != null && since == null) {
    throw userError(`I cannot read "${sinceRaw}" as a time`, "try 24h, 2d, 90m, or a date like 2026-08-15");
  }
  const types = parseTypes(flags.type);
  for (const t of types) {
    if (!rec.ENTRY_TYPES.includes(t)) {
      throw userError(`nothing is recorded under the type "${t}"`, `known types: ${rec.ENTRY_TYPES.join(", ")}`);
    }
  }
  const appId = flags.app ? String(flags.app) : null;
  const limit = parseLimit(flags.limit);
  const query = { since, type: types, appId, limit };

  // The stored day marker is a divider for human eyes — the table derives its
  // own from the timestamps, so it is dropped here unless it was asked for.
  const all = rec.query(query);
  const entries = types.includes("day") ? all : all.filter((e) => e.type !== "day");
  const filtered = Boolean(sinceRaw || types.length || appId);

  if (ctx.json) {
    ctx.out(JSON.stringify(logJson(entries, { since, type: types, appId, limit }), null, 2));
    if (!flags.follow) return EXIT_OK;
  } else {
    ctx.out(renderLog(entries, { style: ctx.st, sinceLabel: sinceRaw, width: ctx.stdout.columns || 0, filtered }));
  }

  if (!flags.follow) return EXIT_OK;
  return followLoop(ctx, rec, query, entries);
}

/**
 * Poll the journal every 2s and print what appeared. Ctrl-C (or an injected
 * abort signal, for the tests) ends it with exit 0 — a `tail -f` that made it
 * to the end of its work has not failed.
 */
function followLoop(ctx, rec, query, seeded) {
  const opts = ctx.follow || {};
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : FOLLOW_MS;
  const batch = Array.isArray(seeded) ? seeded : [];
  const from = batch.length ? batch[0].ts : Number(opts.from) || 0;
  const follower = createFollower({
    recorder: rec,
    query: Object.assign({}, query, { since: undefined }),
    write: (line) => ctx.out(line),
    style: ctx.st,
    // --json --follow stays machine-readable: one JSON object per new event.
    format: ctx.json ? (e) => JSON.stringify(e) : undefined,
    from,
    // The batch already on screen must not come round again — remember the
    // entries that share the newest timestamp, which is the only ambiguous ms.
    seenKeys: batch.filter((e) => e.ts === from).map(keyOf),
  });
  ctx.err(ctx.stErr.dim("following — ^C to stop"));

  return new Promise((resolve) => {
    let done = false;
    const timer = setInterval(() => {
      try {
        follower.tick();
      } catch (_) {
        /* a poll that trips over a torn write tries again in 2s */
      }
    }, intervalMs);
    if (timer.unref && opts.unref) timer.unref();

    const stop = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      try {
        process.removeListener("SIGINT", stop);
      } catch (_) {
        /* ignore */
      }
      resolve(EXIT_OK);
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener("abort", stop, { once: true });
    }
    process.once("SIGINT", stop);
    return undefined;
  });
}

module.exports = {
  cmdLog,
  renderLog,
  renderRow,
  logJson,
  createFollower,
  chipOf,
  hhmm,
  dayKey,
  CHIPS,
  CHIP_WIDTH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  FOLLOW_MS,
};
