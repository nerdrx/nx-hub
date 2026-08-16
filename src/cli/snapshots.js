"use strict";
// `nx snapshots` / `nx restore` — the config time machine from the terminal.
// SPEC v0.8 "Config time machine".
//
//   nx snapshots <app> [--json]
//   nx snapshots rm <app> <file>
//   nx restore <app> [file] [-y] [--json]
//
// A thin shell over src/main/snapshots.js — every decision (what is captured,
// retention, the $HOME-relative constraint, the traversal guards) lives there
// and is unit-tested there. This file resolves what the user typed, prints,
// and picks an exit code.

const { createStyle } = require("./ansi");
const { fmtBytes } = require("../main/github");
const { table, T } = require("./render");

const EXIT_OK = 0;
const EXIT_FAIL = 2;

const SUBS = ["ls", "list", "rm", "remove", "delete"];

/** Structurally index.js's UserError — see the same note in ./dev.js. */
function userError(message, hint) {
  const e = new Error(message);
  e.name = "UserError";
  e.hint = hint || null;
  e.exitCode = 1;
  return e;
}

function store(ctx) {
  // lazily required so `nx list` never loads it
  // eslint-disable-next-line global-require
  return (ctx && ctx.snapshots) || require("../main/snapshots");
}

/* ------------------------------------------------------------------ */
/* pure rendering                                                      */
/* ------------------------------------------------------------------ */

/** "2026-08-16T10:04:05.123Z" → "2026-08-16 10:04" (never locale-formatted). */
function whenText(ts) {
  const s = String(ts || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s || "—";
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

const REASON_TEXT = {
  "pre-update": "before update",
  "pre-uninstall": "before uninstall",
  "pre-restore": "before restore",
  manual: "manual",
};

function reasonText(reason) {
  return REASON_TEXT[reason] || String(reason || "");
}

function snapshotsJson(rows, { appId = null } = {}) {
  return {
    appId,
    snapshots: (Array.isArray(rows) ? rows : []).map((s) => ({
      file: s.file,
      ts: s.ts,
      version: s.version,
      reason: s.reason,
      bytes: s.bytes,
    })),
  };
}

function renderSnapshots(rows, { style, app = null } = {}) {
  const st = style || createStyle(false);
  const list = Array.isArray(rows) ? rows : [];
  const name = (app && app.name) || (app && app.id) || "this app";
  const lines = ["", st.section(`Config snapshots — ${name}`), ""];
  if (!list.length) {
    lines.push(
      `  ${st.muted("No snapshots yet.")}`,
      "",
      `  ${st.dim("one is taken automatically before an update or an uninstall,")}`,
      `  ${st.dim("for the config paths the app's overlay declares.")}`,
      ""
    );
    return lines.join("\n");
  }
  const rowsOut = list.map((s, i) => [
    T(i === 0 ? "·" : " ", st.cyan),
    T(whenText(s.ts), st.text),
    T(s.version || "—", st.muted),
    T(reasonText(s.reason), s.reason === "pre-update" ? st.violet : st.dim),
    T(fmtBytes(s.bytes || 0), st.dim),
    T(s.file, st.dim),
  ]);
  lines.push(...table(["", "when", "version", "reason", "size", "file"], rowsOut, st));
  lines.push(
    "",
    `  ${st.dim(`restore the newest with: nx restore ${(app && app.id) || "<app>"}`)}`,
    `  ${st.dim(`only the newest ${require("../main/snapshots").RETENTION} are kept per app`)}`,
    ""
  );
  return lines.join("\n");
}

function renderRestored(result, { style, app = null, meta = null } = {}) {
  const st = style || createStyle(false);
  const name = (app && app.name) || result.appId;
  const count = (result.restored || []).length;
  const lines = [
    `${st.cyan("✓")} Restored ${st.text(name)}'s config${meta && meta.ts ? st.dim(` from ${whenText(meta.ts)}`) : ""}` +
      st.dim(` (${count} path${count === 1 ? "" : "s"})`),
  ];
  for (const entry of (result.restored || []).slice(0, 6)) lines.push(`  ${st.dim(`~/${entry}`)}`);
  if (count > 6) lines.push(`  ${st.dim(`… and ${count - 6} more`)}`);
  if (result.preRestore) lines.push(`  ${st.dim(`the previous config was saved as ${result.preRestore}`)}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pick one archive: exact file name, else a unique prefix (a date is enough),
 * else the newest when nothing was typed.
 */
function pickSnapshot(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { snapshot: null, candidates: [], error: "There are no snapshots for this app yet." };
  if (!query) return { snapshot: list[0], candidates: [list[0]], error: null };
  const q = String(query);
  const exact = list.find((s) => s.file === q);
  if (exact) return { snapshot: exact, candidates: [exact], error: null };
  const partial = list.filter((s) => s.file.startsWith(q) || s.ts.startsWith(q));
  if (partial.length === 1) return { snapshot: partial[0], candidates: partial, error: null };
  if (partial.length > 1) {
    return { snapshot: null, candidates: partial, error: `"${q}" matches ${partial.length} snapshots — be more specific.` };
  }
  return { snapshot: null, candidates: list, error: `No snapshot called "${q}".` };
}

async function resolveApp(ctx, query) {
  if (!query) throw userError("Name an app.", "nx snapshots <app>");
  const apps = await ctx.loadApps();
  return ctx.requireApp(apps, query);
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/** `nx snapshots <app>` · `nx snapshots rm <app> <file>` */
async function cmdSnapshots(ctx) {
  const first = String(ctx.args[0] || "").toLowerCase();
  const sub = SUBS.includes(first) ? first : null;
  if (sub === "rm" || sub === "remove" || sub === "delete") return snapshotsRm(ctx);

  const app = await resolveApp(ctx, sub ? ctx.args[1] : ctx.args[0]);
  const rows = store(ctx).list(app.id);
  if (ctx.json) {
    ctx.out(JSON.stringify(snapshotsJson(rows, { appId: app.id }), null, 2));
    return EXIT_OK;
  }
  ctx.out(renderSnapshots(rows, { style: ctx.st, app }));
  return EXIT_OK;
}

async function snapshotsRm(ctx) {
  const app = await resolveApp(ctx, ctx.args[1]);
  const rows = store(ctx).list(app.id);
  const { snapshot, candidates, error } = pickSnapshot(rows, ctx.args[2]);
  if (!ctx.args[2]) throw userError("Name the snapshot to delete.", `nx snapshots ${app.id}`);
  if (!snapshot) {
    throw userError(error, candidates.length ? `try: ${candidates.slice(0, 5).map((s) => s.file).join(", ")}` : `nx snapshots ${app.id}`);
  }
  const result = store(ctx).remove(app.id, snapshot.file);
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, appId: app.id, file: result.file }, null, 2));
    return EXIT_OK;
  }
  ctx.out(`${ctx.st.cyan("✓")} Deleted ${ctx.st.text(result.file)} ${ctx.st.dim(`(${app.name})`)}`);
  return EXIT_OK;
}

/** `nx restore <app> [file]` — newest archive unless one is named. */
async function cmdRestore(ctx) {
  const app = await resolveApp(ctx, ctx.args[0]);
  const rows = store(ctx).list(app.id);
  const { snapshot, candidates, error } = pickSnapshot(rows, ctx.args[1]);
  if (!snapshot) {
    throw userError(
      error,
      candidates.length ? `try: ${candidates.slice(0, 5).map((s) => s.file).join(", ")}` : `nx snapshots ${app.id}`
    );
  }

  if (!ctx.flags.yes) {
    const okay = await ctx.confirm(
      `Restore ${app.name}'s config from ${whenText(snapshot.ts)} (${snapshot.version}, ${reasonText(snapshot.reason)})? ` +
        "The current files are overwritten."
    );
    if (!okay) {
      ctx.err(ctx.stErr.muted("Nothing restored."));
      return EXIT_OK;
    }
  }

  let result;
  try {
    result = await store(ctx).restore(app.id, snapshot.file, { app });
  } catch (e) {
    e.exitCode = EXIT_FAIL;
    throw e;
  }
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { ok: true, appId: app.id, file: result.file, restored: result.restored, preRestore: result.preRestore },
        null,
        2
      )
    );
    return EXIT_OK;
  }
  ctx.out(renderRestored(result, { style: ctx.st, app, meta: snapshot }));
  return EXIT_OK;
}

module.exports = {
  cmdSnapshots,
  cmdRestore,
  renderSnapshots,
  renderRestored,
  snapshotsJson,
  pickSnapshot,
  whenText,
  reasonText,
  SUBS,
};
