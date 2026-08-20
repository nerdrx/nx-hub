"use strict";
// v0.10 [audit] — `nx doctor --deep [--repair] [--json] [-y]`.
//
// The deep section of doctor: src/main/audit.js walks every recorded install
// against the manifest its engine wrote, and this file turns the rows into
// terminal output (and, with --repair, into reinstalls).
//
// Exit codes follow the CLI's contract: 0 when every install checks out, 2
// when problems REMAIN — after a repair pass, if one was asked for. A refused
// prompt is not a failure of the command, but the install it left broken still
// counts, because "nx doctor --deep" answering 0 with a rotted install on disk
// would make the whole command worthless in a script.
//
// Repairs go through ctx.runtime.install — the same call `nx install` makes,
// which is jobs.install, which is what audit.repair() queues for the GUI. One
// pipeline, so LAN seeding, delta patching, the kept `.prev` and the pre-update
// config snapshot all keep happening exactly as they do for any other install.

const { createStyle } = require("./ansi");

const GLYPH_OK = "✓";
const GLYPH_BAD = "✕";
const GLYPH_SKIP = "·";

/** The audit module, unless a test injected one on ctx. */
function auditor(ctx) {
  // eslint-disable-next-line global-require
  return (ctx && ctx.audit) || require("../main/audit");
}

function labelOf(row) {
  return `${row.appId}/${row.artifactId}`;
}

/**
 * The audit as a block of text.
 *
 * One line per install (glyph, id, version, kind), then one indented line per
 * problem — kind first, because the kind is what the user greps for and what
 * the docs name. Paths are dim: they are long, and they are context, not the
 * finding.
 */
function renderAudit(rows, { style, title = "Install audit" } = {}) {
  const st = style || createStyle(false);
  const list = Array.isArray(rows) ? rows : [];
  const lines = ["", st.section(title), ""];

  if (!list.length) {
    lines.push(`  ${st.muted("nothing installed — nothing to check")}`, "");
    return lines.join("\n");
  }

  const width = list.reduce((n, r) => Math.max(n, labelOf(r).length), 0);
  const vwidth = list.reduce((n, r) => Math.max(n, String(r.version || "").length), 0);
  for (const row of list) {
    const skipped = row.ok && row.deviceResident;
    const glyph = row.ok ? (skipped ? st.muted(GLYPH_SKIP) : st.cyan(GLYPH_OK)) : st.danger(GLYPH_BAD);
    const meta = `${String(row.version || "").padEnd(vwidth)}  ${row.kind || ""}`.trimEnd();
    lines.push(`  ${glyph} ${st.text(st.padEnd(labelOf(row), width))}  ${st.muted(meta)}`);
    for (const p of row.problems || []) {
      const where = p.path ? ` ${st.dim(p.path)}` : "";
      const why = p.detail ? ` ${st.muted(`— ${p.detail}`)}` : "";
      lines.push(`      ${st.danger(st.padEnd(p.kind, 21))}${where}${why}`);
    }
    for (const note of row.notes || []) lines.push(`      ${st.dim(note)}`);
  }

  const sum = summarize(list);
  lines.push("");
  lines.push(
    sum.broken
      ? `  ${st.danger(`${sum.broken} of ${sum.total} installs need attention`)} ${st.dim(
          `(${sum.problems} problem${sum.problems === 1 ? "" : "s"})`
        )}`
      : `  ${st.cyan(`${sum.total} install${sum.total === 1 ? "" : "s"} checked out`)}`
  );
  lines.push("");
  return lines.join("\n");
}

function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const broken = list.filter((r) => r && !r.ok);
  return {
    total: list.length,
    ok: list.length - broken.length,
    broken: broken.length,
    problems: broken.reduce((n, r) => n + ((r.problems || []).length || 0), 0),
  };
}

/**
 * Reinstall one broken install, streaming its job exactly like `nx install`.
 * @returns {Promise<{appId, artifactId, ok, message?, error?}>}
 */
async function repairOne(ctx, row) {
  const { progress, onProgress, onToast } = ctx.jobHooks();
  ctx.err(`${ctx.stErr.violet("repairing")} ${ctx.stErr.text(labelOf(row))}`);
  try {
    const result = await ctx.runtime.install(row.appId, row.artifactId, { onProgress, onToast });
    progress.finish(result && result.message ? result.message : `Reinstalled ${labelOf(row)}`);
    return { appId: row.appId, artifactId: row.artifactId, ok: true, message: (result && result.message) || null };
  } catch (e) {
    progress.finish(`${labelOf(row)}: ${e.message}`, "error");
    return { appId: row.appId, artifactId: row.artifactId, ok: false, error: e.message || String(e) };
  }
}

/**
 * The whole `--deep` pass: audit → (optionally) repair → re-audit.
 *
 * Human output is written here as it happens, so the repair prompts appear
 * BELOW the audit that justifies them. `--json` writes nothing and hands the
 * caller one object to embed in doctor's own payload.
 *
 * @returns {Promise<{ok:boolean, audit:Array, repairs:Array, json:object}>}
 */
async function runDeep(ctx) {
  const audit = auditor(ctx);
  let rows = await audit.audit();
  if (!ctx.json) ctx.out(renderAudit(rows, { style: ctx.st }));

  const broken = rows.filter((r) => !r.ok);
  const repairs = [];

  if (broken.length && !ctx.flags.repair) {
    if (!ctx.json) ctx.out(`  ${ctx.st.dim("reinstall them with `nx doctor --deep --repair`")}\n`);
  }

  if (broken.length && ctx.flags.repair) {
    // jobs.install resolves the app through discovery — with `--offline` the
    // model may still be empty, so fill it before the first repair rather than
    // failing every one of them with "Unknown app".
    try {
      await ctx.loadApps();
    } catch (_) {
      /* an unreachable GitHub is the repair's problem to report, not ours */
    }
    for (const row of broken) {
      if (!ctx.flags.yes) {
        // eslint-disable-next-line no-await-in-loop
        const okay = await ctx.confirm(`Reinstall ${labelOf(row)} (${(row.problems || []).length} problem(s))?`);
        if (!okay) {
          repairs.push({ appId: row.appId, artifactId: row.artifactId, ok: false, skipped: true });
          if (!ctx.json) ctx.err(ctx.stErr.muted(`  skipped ${labelOf(row)}`));
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      repairs.push(await repairOne(ctx, row));
    }
    if (repairs.some((r) => r.ok)) {
      rows = await audit.audit();
      if (!ctx.json) ctx.out(renderAudit(rows, { style: ctx.st, title: "After repair" }));
    }
  }

  const ok = rows.every((r) => r.ok);
  return { ok, audit: rows, repairs, json: { audit: rows, repairs, auditOk: ok } };
}

module.exports = { runDeep, renderAudit, summarize, repairOne, GLYPH_OK, GLYPH_BAD, GLYPH_SKIP };
