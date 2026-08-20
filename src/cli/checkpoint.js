"use strict";
// `nx checkpoint` — the ecosystem time machine from the terminal.
// SPEC v0.10 "Ecosystem checkpoints" ([replay]).
//
//   nx checkpoint show <when> [--json]
//   nx checkpoint restore <when> [--configs] [-y] [--json]
//   nx checkpoint <when>                     (same as `show`)
//
// `when` takes the recorder's own forms: 24h · 2d · 90m · 1w · 2026-08-15 ·
// 2026-08-15T10:00:00Z · now.
//
// A thin shell over src/main/checkpoints.js, in the same spirit as `nx log`
// over the recorder: every decision about WHAT was installed when, and what may
// safely be done about it, was already made there and is unit-tested there.
// This file resolves what the user typed, draws the plan, asks before it acts,
// streams the phases, and picks an exit code:
//
//   0  the plan ran (skips included — a skip is a report, not a failure)
//   1  the user typed something unusable
//   2  at least one action failed
//
// Nothing here EVER acts on an uncertain row. The plan marks them, the table
// paints them amber, the confirmation lists them under "skipping" — and the
// executor refuses them on its own account even if this file forgot to.

const { createStyle } = require("./ansi");
const { table, T } = require("./render");

const EXIT_OK = 0;
const EXIT_FAIL = 2;

const SUBS = ["show", "plan", "restore", "apply"];

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
  return (ctx && ctx.checkpoints) || require("../main/checkpoints");
}

/* ------------------------------------------------------------------ */
/* pure rendering                                                      */
/* ------------------------------------------------------------------ */

/** epoch ms → "2026-08-13 09:00" (never locale-formatted — the host may be de_DE). */
function whenText(ts) {
  if (ts == null || ts === "") return "—"; // Number(null) is 0, which is a real date
  const n = Number(ts);
  if (!Number.isFinite(n)) return "—";
  const iso = new Date(n).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** An ISO string from a snapshot name → the same short form. */
function stampText(iso) {
  const at = Date.parse(String(iso || ""));
  return Number.isFinite(at) ? whenText(at) : "—";
}

const ACTION_TEXT = { install: "install", remove: "remove", none: "—" };

function actionPaint(st, entry) {
  if (entry.skipReason) return st.amber;
  if (entry.action === "remove") return st.danger;
  if (entry.action === "install") return st.violet;
  return st.dim;
}

/** The version a row would move TO, as text ("?" when nobody knows). */
function thenText(entry) {
  if (entry.uncertain) return "?";
  return entry.version || "—";
}

function label(entry) {
  return entry.appName || entry.appId;
}

/** One line per action, the words the confirmation and the report share. */
function actionLine(entry, st) {
  const name = `${label(entry)} ${st.dim(`— ${entry.artifactId}`)}`;
  if (entry.action === "remove") {
    return `${st.danger("remove ")} ${st.text(name)} ${st.dim(entry.currentVersion || "")}`.trimEnd();
  }
  const from = entry.currentVersion || "not installed";
  return `${st.violet("install")} ${st.text(name)} ${st.dim(`${from} → ${entry.version}`)}${
    entry.tag ? st.dim(` (${entry.tag})`) : ""
  }`;
}

function skipLine(entry, st, cp) {
  return `${st.amber("skip   ")} ${st.text(`${label(entry)} ${st.dim(`— ${entry.artifactId}`)}`)} ${st.dim(
    `— ${cp.reasonText(entry)}`
  )}`;
}

/**
 * The plan as a table: what is installed now, what was installed then, and what
 * `nx checkpoint restore` would do about it.
 */
function renderPlan(plan, { style, cp } = {}) {
  const st = style || createStyle(false);
  const mod = cp || require("../main/checkpoints");
  const lines = ["", st.section(`checkpoint — ${whenText(plan.ts)}`), ""];

  if (!plan.apps.length) {
    lines.push(
      `  ${st.cyan("✓")} ${st.text("Nothing to put back.")}`,
      "",
      `  ${st.dim("everything installed now was installed then, at the same version.")}`,
      ""
    );
    return lines.join("\n");
  }

  const rows = plan.apps.map((e) => [
    T(e.skipReason ? "·" : e.action === "remove" ? "✗" : "↓", actionPaint(st, e)),
    T(label(e), st.text),
    T(e.artifactId, st.dim),
    T(e.currentVersion || "—", e.currentVersion ? st.muted : st.dim),
    T(thenText(e), e.uncertain ? st.amber : st.cyan),
    T(e.skipReason ? "skip" : ACTION_TEXT[e.action] || e.action, actionPaint(st, e)),
    T(e.snapshot ? stampText(e.snapshotAt) : "—", st.dim),
  ]);
  lines.push(...table(["", "app", "artifact", "now", "then", "action", "config"], rows, st));

  const skipped = plan.apps.filter((e) => e.skipReason);
  if (skipped.length) {
    lines.push("", `  ${st.head("skipped")}`);
    for (const e of skipped) lines.push(`  ${st.amber("·")} ${st.text(label(e))} ${st.dim(`— ${mod.reasonText(e)}`)}`);
  }

  const n = plan.actionable;
  lines.push(
    "",
    `  ${st.dim(`${n} action${n === 1 ? "" : "s"}${plan.skipped ? `, ${plan.skipped} skipped` : ""}`)}`
  );
  if (n) {
    lines.push(`  ${st.dim(`put it back with: nx checkpoint restore ${whenText(plan.ts).replace(" ", "T")}Z`)}`);
    lines.push(`  ${st.dim("add --configs to bring each app's config snapshot back too")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** One `checkpoint-progress` event → one line on stderr. */
function renderPhase(evt, { style } = {}) {
  const st = style || createStyle(false);
  const who = evt.appId ? `${evt.appId}${evt.artifactId ? ` — ${evt.artifactId}` : ""}` : "";
  switch (evt.phase) {
    case "planning":
      return `  ${st.dim("reading the journal…")}`;
    case "installing":
      return `  ${st.violet("install")} ${st.text(who)}${evt.version ? st.dim(` ${evt.version}`) : ""}`;
    case "removing":
      return `  ${st.danger("remove ")} ${st.text(who)}`;
    case "restoring-config":
      return `  ${st.cyan("config ")} ${st.text(who)}${evt.file ? st.dim(` ${evt.file}`) : ""}`;
    case "failed":
      return evt.appId
        ? `  ${st.danger("✗")} ${st.text(who)} ${st.dim(evt.error || "failed")}`
        : `  ${st.danger("✗")} ${st.text("the checkpoint did not fully apply")}`;
    case "done":
      return `  ${st.cyan("✓")} ${st.text("checkpoint applied")}`;
    default:
      return `  ${st.dim(evt.phase || "")}`;
  }
}

function renderResult(result, { style } = {}) {
  const st = style || createStyle(false);
  const c = result.counts;
  const glyph = result.ok ? st.cyan("✓") : st.danger("✗");
  const head = `${glyph} ${st.text(`Checkpoint ${whenText(result.ts)}`)} ${st.dim(
    `— ${c.done} done, ${c.failed} failed, ${c.skipped} skipped`
  )}`;
  const lines = [head];
  for (const row of result.results) {
    if (row.skipped) {
      lines.push(`  ${st.amber("·")} ${st.text(`${row.appId}${row.artifactId ? ` — ${row.artifactId}` : ""}`)} ${st.dim(`skipped (${row.reason})`)}`);
    } else if (!row.ok) {
      lines.push(`  ${st.danger("✗")} ${st.text(`${row.appId}${row.artifactId ? ` — ${row.artifactId}` : ""}`)} ${st.dim(row.error || "failed")}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* the commands                                                        */
/* ------------------------------------------------------------------ */

/** The plan builder's collaborators, wired to whatever this CLI process has. */
function optsFor(ctx) {
  return {
    recorder: ctx.recorder || undefined,
    // A CLI process starts with an empty discovery cache, so the tag lookup
    // goes through the runtime (which fetches when the cache has nothing).
    releases: (appId) => ctx.runtime.releases(appId),
    findApp: (appId) => (ctx.apps || []).find((a) => a && a.id === appId) || null,
  };
}

function parseWhen(ctx, raw) {
  if (!raw) {
    throw userError("Name a point in time.", "nx checkpoint show 2d   ·   nx checkpoint show 2026-08-15");
  }
  const at = store(ctx).parseWhen(raw);
  if (at == null) {
    throw userError(`I cannot read "${raw}" as a point in time`, "try 24h, 2d, 90m, or a date like 2026-08-15");
  }
  return at;
}

/** `nx checkpoint show <when>` — the plan, and nothing else. */
async function cmdShow(ctx, raw) {
  const cp = store(ctx);
  const at = parseWhen(ctx, raw);
  ctx.apps = await ctx.loadApps();
  const plan = await ctx.withStatus("reconstructing…", () => cp.checkpointAt(at, optsFor(ctx)));

  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({ ok: true }, plan), null, 2));
    return EXIT_OK;
  }
  ctx.out(renderPlan(plan, { style: ctx.st, cp }));
  return EXIT_OK;
}

/** `nx checkpoint restore <when> [--configs] [-y]`. */
async function cmdRestore(ctx, raw) {
  const cp = store(ctx);
  const at = parseWhen(ctx, raw);
  const configs = ctx.flags.configs === true;
  ctx.apps = await ctx.loadApps();
  const plan = await ctx.withStatus("reconstructing…", () => cp.checkpointAt(at, optsFor(ctx)));

  const actions = plan.apps.filter((e) => e.action !== "none" && !e.skipReason);
  if (!actions.length) {
    if (ctx.json) {
      ctx.out(JSON.stringify({ ok: true, ts: plan.ts, results: [], counts: { done: 0, failed: 0, skipped: plan.skipped }, plan }, null, 2));
      return EXIT_OK;
    }
    ctx.out(renderPlan(plan, { style: ctx.st, cp }));
    return EXIT_OK;
  }

  // SPEC: the confirmation lists EVERY action. A checkpoint touches the whole
  // ecosystem at once — nobody should have to guess what it is about to do.
  if (!ctx.flags.yes && !ctx.json) {
    ctx.err(`${ctx.stErr.section(`checkpoint — ${whenText(plan.ts)}`)}`);
    for (const entry of actions) ctx.err(`  ${actionLine(entry, ctx.stErr)}`);
    if (configs) {
      for (const entry of configsIn(plan, actions)) {
        ctx.err(`  ${ctx.stErr.cyan("config ")} ${ctx.stErr.text(label(entry))} ${ctx.stErr.dim(`from ${stampText(entry.snapshotAt)} (${entry.snapshot})`)}`);
      }
    }
    const skipped = plan.apps.filter((e) => e.skipReason);
    for (const entry of skipped) ctx.err(`  ${skipLine(entry, ctx.stErr, cp)}`);
    const okay = await ctx.confirm(
      `Apply this checkpoint? ${actions.length} action${actions.length === 1 ? "" : "s"}${
        configs ? ", configs included" : ""
      }.`
    );
    if (!okay) {
      ctx.err(ctx.stErr.muted("Nothing changed."));
      return EXIT_OK;
    }
  }

  const events = [];
  const result = await cp.restore(at,
    Object.assign(optsFor(ctx), {
      configs,
      emit: (evt) => {
        events.push(evt);
        if (!ctx.json) ctx.err(renderPhase(evt, { style: ctx.stErr }));
      },
      // The jobs go through the CLI's own runtime, so a checkpoint install
      // draws the same progress bar `nx install` does.
      runJob: (kind, entry) => runOne(ctx, kind, entry),
    })
  );

  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({}, result, { events }), null, 2));
    return result.ok ? EXIT_OK : EXIT_FAIL;
  }
  ctx.out(renderResult(result, { style: ctx.st }));
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

/** The apps whose config would come back, in plan order, de-duplicated. */
function configsIn(plan, actions) {
  const installing = new Set(actions.filter((e) => e.action === "install").map((e) => e.appId));
  const seen = new Set();
  return plan.apps.filter((e) => {
    if (!e.snapshot || !installing.has(e.appId) || seen.has(e.appId)) return false;
    seen.add(e.appId);
    return true;
  });
}

/** One plan step through the runtime the rest of the CLI already uses. */
async function runOne(ctx, kind, entry) {
  const { progress, onProgress, onToast } = ctx.jobHooks();
  try {
    const result =
      kind === "remove"
        ? await ctx.runtime.uninstall(entry.appId, entry.artifactId, { onProgress, onToast })
        : await ctx.runtime.install(entry.appId, entry.artifactId, { tag: entry.tag, onProgress, onToast });
    progress.finish((result && result.message) || "done");
    return result;
  } catch (e) {
    // The bar must come down before checkpoints.js prints the failure line.
    progress.finish(`${entry.appId} — ${entry.artifactId}: ${e.message}`, "error");
    throw e;
  }
}

/**
 * `nx checkpoint [show|restore] <when>`. A first argument that is not a
 * subcommand is taken as the `when` of a `show` — `nx checkpoint 2d` is what
 * everybody types first.
 */
async function cmdCheckpoint(ctx) {
  const first = String(ctx.args[0] || "").toLowerCase();
  const sub = SUBS.includes(first) ? first : null;
  if (!sub) {
    if (!ctx.args[0]) throw userError("Name a point in time.", "nx checkpoint show 2d | nx checkpoint restore 2d");
    return cmdShow(ctx, ctx.args[0]);
  }
  if (sub === "restore" || sub === "apply") return cmdRestore(ctx, ctx.args[1]);
  return cmdShow(ctx, ctx.args[1]);
}

module.exports = {
  cmdCheckpoint,
  cmdShow,
  cmdRestore,
  renderPlan,
  renderPhase,
  renderResult,
  actionLine,
  skipLine,
  configsIn,
  whenText,
  stampText,
  thenText,
  SUBS,
};
