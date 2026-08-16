"use strict";
// `nx bisect` — binary-search the releases of one artifact for the first bad
// one. SPEC v0.7 "nx bisect". CLI-only: there is no GUI for this.
//
//   nx bisect <app> [artifact]   start (installs the midpoint release)
//   nx bisect good | bad | skip  verdict on what is installed → next candidate
//   nx bisect status             where the search stands
//   nx bisect reset              put back whatever was installed before
//
// A thin shell: every state transition is a pure function in
// src/main/bisect.js, and every install goes through the SAME job pipeline as
// `nx install` (progress bar included). This file resolves the app, drives
// those two, and prints.
//
// The verdicts are positional, so an app actually called "good", "skip" or
// "status" would be shadowed by them; `nx bisect start <app>` is the escape
// hatch for that (and reads better in a script either way).

const { createStyle } = require("./ansi");
const render = require("./render");

const SUBS = ["good", "bad", "skip", "status", "reset", "start"];

const EXIT_OK = 0;

/** Structurally index.js's UserError — see the note in ./dev.js for why. */
function userError(message, hint) {
  const e = new Error(message);
  e.name = "UserError";
  e.hint = hint || null;
  e.exitCode = 1;
  return e;
}

function core(ctx) {
  // eslint-disable-next-line global-require
  return (ctx && ctx.bisect) || require("../main/bisect");
}

/* ------------------------------------------------------------------ */
/* pure rendering                                                      */
/* ------------------------------------------------------------------ */

/** "install this next" — the line printed after every verdict. */
function renderCandidate(summary, { style } = {}) {
  const st = style || createStyle(false);
  const cur = summary.current || {};
  const steps = summary.stepsLeft;
  return `${st.violet("testing")} ${st.text(cur.tag || "?")}${
    cur.publishedAt ? st.dim(` ${render.dateOnly(cur.publishedAt)}`) : ""
  } ${st.dim(`— ${summary.remaining} left, ~${steps} step${steps === 1 ? "" : "s"}`)}`;
}

/** `nx bisect status` — the remaining range and how far it still has to go. */
function renderStatus(summary, { style, notes = [] } = {}) {
  const st = style || createStyle(false);
  const lines = ["", st.section("Bisect"), ""];
  lines.push(
    ...render.kv(
      [
        ["app", `${summary.appId}${summary.artifactId ? ` / ${summary.artifactId}` : ""}`, st.text],
        ["range", `${summary.loTag || "?"} … ${summary.hiTag || "?"}`, st.value],
        ["remaining", `${summary.remaining} of ${summary.total}`, st.value],
        ["steps left", String(summary.stepsLeft), st.value],
        ["tested", String(summary.tested), st.muted],
        ["skipped", summary.skipped.length ? summary.skipped.join(", ") : "none", st.muted],
        ["testing", summary.current ? summary.current.tag : summary.done ? "—" : "nothing", st.cyan],
        ["restore to", summary.restore ? summary.restore.tag || summary.restore.version : "nothing installed", st.dim],
      ],
      st
    )
  );
  lines.push("");
  if (summary.done) lines.push(...outcomeLines(summary, st, notes));
  else lines.push(`  ${st.dim("mark it with: nx bisect good | bad | skip")}`, "");
  return lines.join("\n");
}

/** The convergence report: the tag, its date, and the head of its notes. */
function outcomeLines(summary, st, notes = []) {
  const lines = [];
  if (summary.outcome === "first-bad" && summary.firstBad) {
    const bad = summary.firstBad;
    lines.push(`  ${st.danger("✗")} ${st.text(bad.tag)} ${st.dim("is the first bad release")}`);
    if (bad.publishedAt) lines.push(`    ${st.muted("published")} ${st.value(render.dateOnly(bad.publishedAt))}`);
    // Starting a bisect asserts the newest release is broken, so that one is
    // never installed. If it is also the answer, say the search assumed it.
    if (summary.confirmed === false) {
      lines.push(`    ${st.amber("assumed")} ${st.dim("— it was never installed, every older release tested good")}`);
    }
    if (notes.length) {
      lines.push("");
      for (const line of notes) lines.push(`    ${st.dim(line)}`);
    }
  } else if (summary.outcome === "all-good") {
    lines.push(`  ${st.cyan("✓")} ${st.text("Every release tested good")} ${st.dim("— nothing to blame here")}`);
  } else if (summary.outcome === "exhausted") {
    lines.push(
      `  ${st.amber("!")} ${st.text("Only skipped releases are left")} ${st.dim(
        `— the break is somewhere in ${summary.loTag} … ${summary.hiTag}`
      )}`
    );
  }
  lines.push("", `  ${st.dim("nx bisect reset")} ${st.muted("puts back what was installed before")}`, "");
  return lines;
}

function renderResult(summary, notes, { style } = {}) {
  const st = style || createStyle(false);
  return ["", st.section("Bisect done"), "", ...outcomeLines(summary, st, notes)].join("\n");
}

function bisectJson(summary, notes = []) {
  if (!summary) return { ok: true, bisect: null };
  return { ok: true, bisect: Object.assign({}, summary, { notes }) };
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

async function cmdBisect(ctx) {
  const first = String(ctx.args[0] || "").toLowerCase();
  if (!first) throw userError("Name an app to bisect.", "nx bisect <app> [artifact]");
  if (SUBS.includes(first) && first !== "start") {
    if (first === "status") return bisectStatus(ctx);
    if (first === "reset") return bisectReset(ctx);
    return bisectVerdict(ctx, first);
  }
  return bisectStart(ctx, first === "start" ? ctx.args.slice(1) : ctx.args);
}

/** Load the state or explain that there is nothing to act on. */
function requireState(ctx) {
  const state = core(ctx).read();
  if (!state) throw userError("No bisect in progress.", "start one with `nx bisect <app>`");
  return state;
}

/** Install one tag through the ordinary job pipeline — bar and all. */
async function installTag(ctx, state, tag) {
  const { progress, onProgress, onToast } = ctx.jobHooks();
  ctx.err(
    `${ctx.stErr.violet("installing")} ${ctx.stErr.text(`${state.appId} — ${state.artifactId}`)} ${ctx.stErr.dim(tag)}`
  );
  const result = await ctx.runtime.install(state.appId, state.artifactId, { tag, onProgress, onToast });
  progress.finish(result.message);
}

async function bisectStart(ctx, args) {
  const bisect = core(ctx);
  const apps = await ctx.loadApps();
  const app = ctx.requireApp(apps, args[0]);
  const artifact = ctx.requireArtifact(app, args[1], "install");

  const releases = await ctx.withStatus("loading releases…", () => ctx.runtime.releases(app.id));
  const tags = bisect.orderTags(releases, {
    includePrereleases: Boolean(app.includePrereleases) || Boolean(ctx.flags.all),
  });
  if (tags.length < 2) {
    throw userError(`${app.name} has ${tags.length} bisectable release${tags.length === 1 ? "" : "s"}.`, "nx versions " + app.id);
  }

  // What is installed RIGHT NOW is what `nx bisect reset` has to put back.
  const installed = artifact.installed || null;
  const restore = installed
    ? {
        version: installed.version != null ? String(installed.version) : null,
        tag: (tags.find((t) => t.version != null && String(t.version) === String(installed.version)) || {}).tag || null,
      }
    : null;

  const state = bisect.write(
    bisect.startState({ appId: app.id, artifactId: artifact.id, tags, restore })
  );

  if (!ctx.json) {
    ctx.err(
      `${ctx.stErr.violet("bisecting")} ${ctx.stErr.text(`${app.name} — ${artifact.label}`)} ${ctx.stErr.dim(
        `${tags.length} releases, ${tags[0].tag} … ${tags[tags.length - 1].tag}`
      )}`
    );
  }
  return afterTransition(ctx, state, { install: true });
}

async function bisectVerdict(ctx, verdict) {
  const bisect = core(ctx);
  const state = requireState(ctx);
  if (state.done) return afterTransition(ctx, state, { install: false });
  let next;
  try {
    next = bisect.applyVerdict(state, verdict);
  } catch (e) {
    throw userError(e.message, "nx bisect good | bad | skip");
  }
  bisect.write(next);
  return afterTransition(ctx, next, { install: true });
}

/**
 * One place decides what happens after the state moved: install the next
 * candidate, or print the verdict of the whole search.
 */
async function afterTransition(ctx, state, { install }) {
  const bisect = core(ctx);
  const summary = bisect.summary(state);

  if (state.done) {
    const bad = bisect.firstBadTag(state);
    const notes = bad ? bisect.notesHead(bad.notes) : [];
    if (ctx.json) {
      ctx.out(JSON.stringify(bisectJson(summary, notes), null, 2));
      return EXIT_OK;
    }
    ctx.out(renderResult(summary, notes, { style: ctx.st }));
    return EXIT_OK;
  }

  if (install) await installTag(ctx, state, summary.current.tag);
  if (ctx.json) {
    ctx.out(JSON.stringify(bisectJson(summary), null, 2));
    return EXIT_OK;
  }
  ctx.out(renderCandidate(summary, { style: ctx.st }));
  ctx.out(ctx.st.dim("  does it work? nx bisect good | bad | skip"));
  return EXIT_OK;
}

function bisectStatus(ctx) {
  const bisect = core(ctx);
  const state = requireState(ctx);
  const summary = bisect.summary(state);
  const bad = bisect.firstBadTag(state);
  const notes = bad ? bisect.notesHead(bad.notes) : [];
  if (ctx.json) {
    ctx.out(JSON.stringify(bisectJson(summary, notes), null, 2));
    return EXIT_OK;
  }
  ctx.out(renderStatus(summary, { style: ctx.st, notes }));
  return EXIT_OK;
}

/**
 * SPEC: reinstall the version installed before the bisect began — and when
 * nothing was installed then, uninstall what the bisect put there.
 */
async function bisectReset(ctx) {
  const bisect = core(ctx);
  const state = requireState(ctx);
  const restore = state.restore;
  await ctx.loadApps();

  const { progress, onProgress, onToast } = ctx.jobHooks();
  let message;
  if (restore && (restore.tag || restore.version)) {
    const tag = restore.tag || restore.version;
    ctx.err(`${ctx.stErr.violet("restoring")} ${ctx.stErr.text(state.appId)} ${ctx.stErr.dim(tag)}`);
    const result = await ctx.runtime.install(state.appId, state.artifactId, { tag, onProgress, onToast });
    message = result.message;
  } else {
    ctx.err(`${ctx.stErr.violet("removing")} ${ctx.stErr.text(state.appId)} ${ctx.stErr.dim("(nothing was installed before)")}`);
    const result = await ctx.runtime.uninstall(state.appId, state.artifactId, { onProgress, onToast });
    message = result.message;
  }
  progress.finish(message);
  bisect.clear();

  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, restored: restore || null, appId: state.appId, artifactId: state.artifactId }, null, 2));
    return EXIT_OK;
  }
  ctx.out(`${ctx.st.cyan("✓")} Bisect reset ${ctx.st.dim(restore ? `— back on ${restore.tag || restore.version}` : "— nothing installed")}`);
  return EXIT_OK;
}

module.exports = {
  cmdBisect,
  renderCandidate,
  renderStatus,
  renderResult,
  outcomeLines,
  bisectJson,
  SUBS,
};
