"use strict";
// `nx dev` — the working tree you are hacking on, as a first-class app.
// SPEC v0.7 "nx dev".
//
//   nx dev ls
//   nx dev link <path> [--app <id>] [--cmd <c>] [--name <n>]
//   nx dev unlink <id>
//   nx dev run <id>
//
// A thin shell over src/main/devlinks.js: every decision (validation, id
// slugging, the launch heuristic) lives there and is unit-tested there. This
// file only resolves what the user typed, prints, and picks an exit code.

const os = require("os");
const path = require("path");

const { createStyle } = require("./ansi");
const { resolve: resolveOne } = require("./match");
const { table, T } = require("./render");

const SUBS = ["ls", "list", "link", "unlink", "run"];

const EXIT_OK = 0;
const EXIT_FAIL = 2;

/**
 * A problem the user fixes by typing something else → exit 1.
 *
 * Structurally index.js's `UserError` (message + hint + exitCode, which is all
 * its catch block reads) but built here: index.js requires this module at load
 * and assigns its own exports at the very bottom, so importing the class back —
 * even lazily — races the `nx dev …` dispatch on the main-module path.
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

/** "/home/u/src/foo" → "~/src/foo" — shorter, and no home path in a paste. */
function shortPath(p, home = os.homedir()) {
  const s = String(p == null ? "" : p);
  if (home && s === home) return "~";
  if (home && s.startsWith(`${home}${path.sep}`)) return `~${path.sep}${s.slice(home.length + 1)}`;
  return s;
}

/** How a link is launched, in one column. */
function launchText(link) {
  return link && link.launchCmd ? link.launchCmd : "auto";
}

/**
 * @param {object[]} links devlinks records, each optionally carrying `exists`
 */
function devLinksJson(links) {
  return {
    links: (Array.isArray(links) ? links : []).map((l) => ({
      appId: l.appId,
      name: l.name || null,
      path: l.path,
      launchCmd: l.launchCmd || null,
      exists: l.exists !== false,
    })),
  };
}

function renderDevLinks(links, { style, home = os.homedir() } = {}) {
  const st = style || createStyle(false);
  const list = Array.isArray(links) ? links : [];
  const lines = ["", st.section("Dev links"), ""];
  if (!list.length) {
    lines.push(`  ${st.muted("No dev links yet.")}`, "", `  ${st.dim("nx dev link ~/src/my-app")}`, "");
    return lines.join("\n");
  }
  const rows = list.map((l) => [
    T(l.exists === false ? "✗" : "·", l.exists === false ? st.danger : st.muted),
    T(l.appId, st.text),
    T(shortPath(l.path, home), st.muted),
    T(launchText(l), l.launchCmd ? st.cyan : st.dim),
  ]);
  lines.push(...table(["", "id", "path", "launch"], rows, st));
  const missing = list.filter((l) => l.exists === false).length;
  if (missing) lines.push("", `  ${st.danger(`${missing} linked director${missing > 1 ? "ies are" : "y is"} gone`)}`);
  lines.push("", `  ${st.dim("run one with: nx dev run <id>")}`, "");
  return lines.join("\n");
}

/** One resolved launch, as the line `nx dev run` leaves behind. */
function renderDevRun(result, link, { style } = {}) {
  const st = style || createStyle(false);
  const cmd = [result.cmd, ...(result.args || [])].join(" ");
  return `${st.cyan("✓")} Launched ${st.text(link.appId)} ${st.dim(`pid ${result.pid} · ${cmd}`)}`;
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

function devlinks(ctx) {
  // lazily required so `nx list` never loads the dev store
  // eslint-disable-next-line global-require
  return (ctx && ctx.devlinks) || require("../main/devlinks");
}

/** Exact → prefix → substring over ids, names and directory basenames. */
function matchLink(links, query) {
  const list = Array.isArray(links) ? links : [];
  if (!query) return { link: null, candidates: list, error: "Name a dev link — try `nx dev ls`." };
  const { match, candidates } = resolveOne(list, query, (l) => [l.appId, l.name, path.basename(l.path)].filter(Boolean));
  if (match) return { link: match, candidates: [match], error: null };
  if (candidates.length > 1) {
    return { link: null, candidates, error: `"${query}" matches ${candidates.length} dev links — be more specific.` };
  }
  return { link: null, candidates: [], error: `No dev link called "${query}". Try \`nx dev ls\`.` };
}

/** `nx dev …` — the store lives on disk, so none of this needs the hub. */
async function cmdDev(ctx) {
  const sub = String(ctx.args[0] || "ls").toLowerCase();
  if (!SUBS.includes(sub)) {
    throw userError(`unknown dev command "${ctx.args[0]}"`, "nx dev ls | link <path> | unlink <id> | run <id>");
  }
  const store = devlinks(ctx);
  if (sub === "ls" || sub === "list") return devList(ctx, store);
  if (sub === "link") return devLink(ctx, store);

  const { link, candidates, error } = matchLink(store.list(), ctx.args[1]);
  if (!link) {
    throw userError(error, candidates.length ? `did you mean: ${candidates.map((l) => l.appId).join(", ")}` : "nx dev ls");
  }
  return sub === "unlink" ? devUnlink(ctx, store, link) : devRun(ctx, store, link);
}

function withExistence(store, links) {
  return links.map((l) => Object.assign({}, l, { exists: store.isDir(l.path) }));
}

function devList(ctx, store) {
  const rows = withExistence(store, store.list());
  if (ctx.json) {
    ctx.out(JSON.stringify(devLinksJson(rows), null, 2));
    return EXIT_OK;
  }
  ctx.out(renderDevLinks(rows, { style: ctx.st }));
  return EXIT_OK;
}

function devLink(ctx, store) {
  const target = ctx.args[1];
  if (!target) throw userError("Name a directory to link.", "nx dev link ~/src/my-app");
  let record;
  try {
    record = store.link({
      path: target,
      appId: ctx.flags.app || null,
      launchCmd: ctx.flags.cmd || null,
      name: ctx.flags.name || null,
    });
  } catch (e) {
    // "no such directory" / "not a directory" / "cannot derive an app id" are
    // all things the user fixes by typing something else → exit 1.
    throw userError(e.message, "nx dev link <path> [--app <id>] [--cmd <c>]");
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, link: devLinksJson([record]).links[0] }, null, 2));
    return EXIT_OK;
  }
  ctx.out(
    `${ctx.st.cyan("✓")} Linked ${ctx.st.text(record.appId)} ${ctx.st.dim(`→ ${shortPath(record.path)}`)}${
      record.launchCmd ? ctx.st.dim(` (${record.launchCmd})`) : ""
    }`
  );
  ctx.out(ctx.st.dim(`  nx dev run ${record.appId}`));
  return EXIT_OK;
}

function devUnlink(ctx, store, link) {
  const removed = store.unlink(link.appId);
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: removed, appId: link.appId }, null, 2));
    return removed ? EXIT_OK : EXIT_FAIL;
  }
  ctx.out(`${ctx.st.cyan("✓")} Unlinked ${ctx.st.text(link.appId)} ${ctx.st.dim("(the directory is untouched)")}`);
  return EXIT_OK;
}

function devRun(ctx, store, link) {
  let result;
  try {
    result = store.run(link.appId, { env: ctx.env });
  } catch (e) {
    const list = Array.isArray(e.candidates) ? e.candidates.slice(0, 8) : [];
    throw userError(
      e.message,
      list.length
        ? `pick one with --cmd: ${list.join(", ")}`
        : `nx dev link ${link.appId} --cmd "<how to start it>"`
    );
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, appId: link.appId, pid: result.pid, cmd: result.cmd, args: result.args, cwd: result.cwd, source: result.source }, null, 2));
    return EXIT_OK;
  }
  ctx.out(renderDevRun(result, link, { style: ctx.st }));
  return EXIT_OK;
}

module.exports = {
  cmdDev,
  matchLink,
  renderDevLinks,
  renderDevRun,
  devLinksJson,
  shortPath,
  launchText,
  SUBS,
};
