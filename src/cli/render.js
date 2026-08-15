"use strict";
// Rendering the discovery model as text. Pure: model in, string out — every
// function takes the style so tests can render both the coloured and the plain
// variant of the exact same input.

const { createStyle } = require("./ansi");
const { fmtBytes } = require("../main/github");
const { hostPlatform } = require("./match");

/* status glyphs — deliberately not emoji (DESIGN §8: no emoji anywhere) */
const GLYPH = { update: "↑", installed: "✓", available: "·", unpublished: "·" };

const DASH = "—";

function dateOnly(iso) {
  const s = String(iso || "");
  // locale-independent on purpose: the ISO date, never toLocaleDateString
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function uniq(list) {
  return [...new Set(list.filter((v) => v != null && v !== ""))].map(String);
}

/** Distinct installed versions across an app's artifacts. */
function installedVersions(app) {
  return uniq(((app && app.artifacts) || []).map((a) => a.installed && a.installed.version));
}

/**
 * The single status an app gets in `nx list`.
 * @returns {"update"|"installed"|"available"|"unpublished"}
 */
function statusOf(app) {
  if (!app) return "unpublished";
  const arts = app.artifacts || [];
  if (arts.some((a) => a.updateAvailable)) return "update";
  if (arts.some((a) => a.installed)) return "installed";
  if (app.unpublished || !app.latest) return "unpublished";
  return "available";
}

const STATUS_TEXT = {
  update: "update available",
  installed: "up to date",
  available: "not installed",
  unpublished: "no release",
};

function paintFor(st, status) {
  if (status === "update") return st.amber;
  if (status === "installed") return st.cyan;
  return st.muted;
}

/** Why an app sits in the bottom block (mirrors the GUI's wording). */
function bottomReason(app) {
  if (!app) return "";
  if (app.overlayHidden) return "hidden by the overlay registry";
  if (app.localHidden) return "hidden by you";
  if (app.unpublished) return app.hasAnyRelease ? "releases exist, but nothing installable" : "no releases yet";
  const v = app.latest && app.latest.version ? ` (latest ${app.latest.version})` : "";
  return `nothing for this machine${v}`;
}

/** Bottom section = exactly what the GUI pushes below the grid. */
function inMainGrid(app) {
  return Boolean(app) && !app.unpublished && !app.overlayHidden && !app.localHidden && app.installableHere !== false;
}

function splitApps(apps) {
  const list = (Array.isArray(apps) ? apps : []).filter(Boolean);
  return { main: list.filter(inMainGrid), bottom: list.filter((a) => !inMainGrid(a)) };
}

/* ------------------------------------------------------------------ */
/* table primitives                                                    */
/* ------------------------------------------------------------------ */

/** A table cell: text plus the paint function that colours it. */
function T(text, paint) {
  return { t: String(text == null ? "" : text), paint: paint || null };
}

/**
 * @param {string[]} headers
 * @param {Array<Array<{t:string,paint:function}>>} rows
 */
function table(headers, rows, st, { indent = "  ", gap = 2 } = {}) {
  const cols = headers.length;
  const widths = headers.map((h, i) => {
    const cells = rows.map((r) => (r[i] ? r[i].t.length : 0));
    return Math.max(String(h).length, ...(cells.length ? cells : [0]));
  });
  const sep = " ".repeat(gap);
  const out = [];
  // The last column is never padded: trailing spaces would end up INSIDE the
  // colour escapes, where no trim can reach them.
  out.push(
    indent +
      headers
        .map((h, i) => st.head(i === cols - 1 ? String(h).toUpperCase() : String(h).toUpperCase().padEnd(widths[i])))
        .join(sep)
        .trimEnd()
  );
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const c = cell || T("");
        const padded = i === row.length - 1 ? c.t : c.t.padEnd(widths[i]);
        return c.paint ? c.paint(padded) : padded;
      })
      .join(sep);
    out.push((indent + line).replace(/\s+$/, ""));
  }
  return out;
}

/** "  key   value" lines with an aligned, muted key column. */
function kv(pairs, st, { indent = "  " } = {}) {
  const width = Math.max(0, ...pairs.map(([k]) => String(k).length));
  return pairs
    .filter(([, v]) => v != null)
    .map(([k, v, paint]) => {
      const value = paint ? paint(String(v)) : String(v);
      return `${indent}${st.key(String(k).padEnd(width))}  ${value}`;
    });
}

/* ------------------------------------------------------------------ */
/* nx list                                                             */
/* ------------------------------------------------------------------ */

function renderList(apps, { style, showAll = false } = {}) {
  const st = style || createStyle(false);
  const { main, bottom } = splitApps(apps);
  const lines = [];

  lines.push("", st.section("Apps"), "");
  if (!main.length) {
    lines.push(`  ${st.muted("Nothing discovered yet — run `nx refresh`.")}`);
  } else {
    const rows = main.map((app) => {
      const status = statusOf(app);
      const paint = paintFor(st, status);
      const installed = installedVersions(app);
      const latest = (app.latest && app.latest.version) || DASH;
      const name = app.foreignOwner ? `${app.name} (${String(app.repo).split("/")[0]})` : app.name;
      return [
        T(GLYPH[status], paint),
        T(name, st.text),
        T(installed.length ? installed.join(", ") : DASH, installed.length ? st.cyan : st.dim),
        T(latest, status === "update" ? st.amber : st.muted),
        T(app.id, st.dim),
      ];
    });
    lines.push(...table(["", "name", "installed", "latest", "id"], rows, st));
  }

  const counts = summarize(apps);
  lines.push(
    "",
    `  ${st.muted("apps")} ${st.value(counts.total)}   ${st.muted("installed")} ${st.value(counts.installed)}   ${st.muted(
      "updates"
    )} ${counts.updates ? st.amber(String(counts.updates)) : st.value(0)}`
  );

  if (bottom.length) {
    lines.push("", st.dim(st.track("Other repos")), "");
    if (showAll) {
      for (const app of bottom) lines.push(`  ${st.dim(`${app.id} — ${bottomReason(app)}`)}`);
    } else {
      const shown = bottom.slice(0, 6).map((a) => a.id);
      const rest = bottom.length - shown.length;
      lines.push(`  ${st.dim(shown.join(", ") + (rest > 0 ? `, +${rest} more` : ""))}`);
      lines.push(`  ${st.dim("nothing installable here — `nx list --all` for the reasons")}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function summarize(apps) {
  const list = (Array.isArray(apps) ? apps : []).filter(Boolean);
  const { main, bottom } = splitApps(list);
  let installed = 0;
  let updates = 0;
  for (const app of list) {
    const arts = app.artifacts || [];
    if (arts.some((a) => a.installed)) installed += 1;
    if (arts.some((a) => a.updateAvailable)) updates += 1;
  }
  return { total: list.length, published: main.length, bottom: bottom.length, installed, updates };
}

/* ------------------------------------------------------------------ */
/* JSON projections (--json)                                           */
/* ------------------------------------------------------------------ */

function artifactJson(artifact) {
  const a = artifact || {};
  return {
    id: a.id,
    label: a.label,
    platform: a.platform,
    kind: a.kind,
    assetName: a.assetName || null,
    size: Number(a.size || 0),
    sourceTag: a.sourceTag || null,
    sourceVersion: a.sourceVersion || null,
    fromOlderRelease: Boolean(a.fromOlderRelease),
    installed: a.installed
      ? { version: a.installed.version || null, path: a.installed.path || null, installedAt: a.installed.installedAt || null }
      : null,
    updateAvailable: Boolean(a.updateAvailable),
    updateSkipped: Boolean(a.updateSkipped),
    launchable: a.launchable !== false,
    rollbackAvailable: Boolean(a.rollbackAvailable),
    prevVersion: a.prevVersion || null,
    readyToInstall: Boolean(a.readyToInstall),
    deviceOffline: Boolean(a.deviceOffline),
    postInstallNote: a.postInstallNote || null,
  };
}

function appJson(app) {
  const a = app || {};
  return {
    id: a.id,
    name: a.name,
    repo: a.repo,
    owner: a.owner || null,
    tagline: a.tagline || "",
    private: Boolean(a.private),
    status: statusOf(a),
    unpublished: Boolean(a.unpublished),
    overlayHidden: Boolean(a.overlayHidden),
    localHidden: Boolean(a.localHidden),
    installableHere: a.installableHere !== false,
    updatePolicy: a.updatePolicy || null,
    latest: a.latest
      ? {
          tag: a.latest.tag || null,
          version: a.latest.version || null,
          publishedAt: a.latest.publishedAt || null,
          prerelease: Boolean(a.latest.prerelease),
        }
      : null,
    installedVersions: installedVersions(a),
    artifacts: (a.artifacts || []).map(artifactJson),
  };
}

function listJson(apps, extra = {}) {
  return Object.assign(
    {
      apps: (Array.isArray(apps) ? apps : []).map(appJson),
      summary: summarize(apps),
    },
    extra
  );
}

/* ------------------------------------------------------------------ */
/* nx info                                                             */
/* ------------------------------------------------------------------ */

function renderInfo(app, { style, platform = process.platform } = {}) {
  const st = style || createStyle(false);
  const host = hostPlatform(platform);
  const lines = [];
  const status = statusOf(app);

  lines.push("", st.section(app.name), "");
  const latest = app.latest
    ? `${app.latest.version}${app.latest.tag && app.latest.tag !== app.latest.version ? `  (${app.latest.tag})` : ""}${
        app.latest.publishedAt ? `  ${dateOnly(app.latest.publishedAt)}` : ""
      }${app.latest.prerelease ? "  prerelease" : ""}`
    : DASH;
  lines.push(
    ...kv(
      [
        ["id", app.id, st.text],
        ["repo", app.repo, st.text],
        ["tagline", app.tagline || DASH, st.muted],
        ["latest", latest, app.latest ? st.value : st.muted],
        ["status", STATUS_TEXT[status], paintFor(st, status)],
        ["policy", `${app.updatePolicy || "notify"}${app.includePrereleases ? " · prereleases on" : ""}`, st.muted],
        app.private ? ["access", "private repo", st.muted] : null,
      ].filter(Boolean),
      st
    )
  );

  const artifacts = app.artifacts || [];
  lines.push("", `  ${st.section("Artifacts")}`, "");
  if (!artifacts.length) {
    lines.push(`  ${st.muted(app.hasAnyRelease ? "released, but nothing the hub can install" : "no releases yet")}`);
  } else {
    const rows = artifacts.map((a) => {
      const installedV = (a.installed && a.installed.version) || DASH;
      const rowStatus = a.updateAvailable ? "update" : a.installed ? "installed" : "available";
      const source = `${a.sourceVersion || (app.latest && app.latest.version) || DASH}${a.fromOlderRelease ? " (older)" : ""}`;
      const here = a.platform === host || a.platform === "android";
      return [
        T(a.id, here ? st.text : st.dim),
        T(a.label, st.muted),
        T(a.platform, st.dim),
        T(a.size ? fmtBytes(a.size) : DASH, st.dim),
        T(source, a.fromOlderRelease ? st.dim : st.muted),
        T(installedV, a.installed ? st.cyan : st.dim),
        // an offline device still shows the pending update — it is the reason
        // the row is interesting — with the caveat appended, not instead of it
        T(
          a.deviceOffline ? `${a.updateAvailable ? STATUS_TEXT.update : "not checked"} (device offline)` : STATUS_TEXT[rowStatus],
          a.deviceOffline && !a.updateAvailable ? st.muted : paintFor(st, rowStatus)
        ),
      ];
    });
    lines.push(...table(["id", "label", "platform", "size", "source", "installed", "status"], rows, st, { indent: "  " }));

    const carried = artifacts.filter((a) => a.fromOlderRelease);
    if (carried.length) {
      lines.push(
        "",
        `  ${st.dim(`(older) = carried over from ${uniq(carried.map((a) => a.sourceTag)).join(", ")} — the latest release does not ship it`)}`
      );
    }
    const notes = artifacts.filter((a) => a.postInstallNote);
    for (const a of notes) lines.push("", `  ${st.amber("note")} ${st.text(`${a.id}: ${a.postInstallNote}`)}`);
    const cmds = artifacts.filter((a) => a.postInstallCmd);
    for (const a of cmds) lines.push(`  ${st.muted("     ")}${st.cyan(a.postInstallCmd)}`);
  }

  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* nx versions                                                         */
/* ------------------------------------------------------------------ */

function renderVersions(app, releases, { style } = {}) {
  const st = style || createStyle(false);
  const lines = ["", st.section(`${app.name} versions`), ""];
  const list = Array.isArray(releases) ? releases : [];
  if (!list.length) {
    lines.push(`  ${st.muted("No releases found — `nx refresh` may help.")}`, "");
    return lines.join("\n");
  }
  const installed = new Set(installedVersions(app));
  const latestVersion = app.latest && app.latest.version;
  const rows = list.map((r) => {
    const marks = [];
    if (r.version === latestVersion) marks.push("latest");
    if (installed.has(String(r.version))) marks.push("installed");
    if (r.prerelease) marks.push("prerelease");
    return [
      T(r.tag || DASH, r.version === latestVersion ? st.value : st.text),
      T(r.version || DASH, st.muted),
      T(dateOnly(r.publishedAt) || DASH, st.dim),
      T(String((r.assets || []).length), st.dim),
      T(marks.join(", "), marks.includes("installed") ? st.cyan : st.muted),
    ];
  });
  lines.push(...table(["tag", "version", "published", "assets", ""], rows, st));
  lines.push("", `  ${st.dim("install one with: nx install " + app.id + " --tag <tag>")}`, "");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* nx doctor                                                           */
/* ------------------------------------------------------------------ */

function renderDoctor(info, { style } = {}) {
  const st = style || createStyle(false);
  const lines = ["", st.section("Doctor"), ""];
  const ok = (v) => st.cyan(v);
  const warn = (v) => st.amber(v);

  const adb = info.adb || {};
  const devices = adb.devices || [];
  const online = devices.filter((d) => d && d.state === "device");
  const adbText = !adb.available
    ? `not found (settings.adbPath = ${info.adbPath})`
    : online.length
      ? `${online.length} device${online.length > 1 ? "s" : ""} — ${online.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ""}`).join(", ")}`
      : devices.length
        ? `${devices.length} device(s), none authorized — accept the "Allow USB debugging" prompt`
        : "no device connected";

  const rate = info.rateLimit;
  const rateText = rate ? `throttled until ${String(rate.resetAt ? new Date(rate.resetAt).toISOString().slice(11, 16) : "?")} UTC` : "ok";

  lines.push(
    ...kv(
      [
        ["hub version", info.hubVersion, st.value],
        ["cli runtime", info.runtime, st.muted],
        ["data dir", info.dataDir, st.text],
        ["install root", info.installRoot, st.text],
        ["settings", `${info.settingsPath}${info.settingsExists ? "" : " (defaults — not written yet)"}`, st.muted],
        ["token", info.tokenSource === "settings" ? "settings.token" : info.tokenSource === "gh" ? "gh auth token" : "anonymous (60 req/h)", info.tokenSource ? ok : warn],
        ["sources", `${(info.owners || []).join(", ") || DASH}${info.extraRepos && info.extraRepos.length ? ` (+${info.extraRepos.length} pinned repos)` : ""}`, st.muted],
        ["rate limit", rateText, rate ? warn : ok],
        ["install engine", info.engine ? "ready" : `unavailable — ${info.engineError || "unknown reason"}`, info.engine ? ok : warn],
        ["adb", adbText, adb.available && online.length ? ok : warn],
        ["cli shim", `${info.shimPath}${info.shimState ? ` (${info.shimState})` : ""}`, info.shimState === "current" ? ok : warn],
        ["apps", info.lastRefresh ? `${info.appCount} discovered, ${info.updateCount} with updates` : "not checked (--offline)", st.muted],
        ["installs", `${info.installedCount} recorded in state.json`, st.muted],
        ["last refresh", info.lastRefresh ? `${dateOnly(info.lastRefresh)} ${String(info.lastRefresh).slice(11, 19)} UTC` : "never", st.muted],
        ["log", info.logFile, st.dim],
      ],
      st
    )
  );

  const errors = info.errors || [];
  if (errors.length) {
    lines.push("", `  ${st.amber("discovery warnings")}`);
    for (const e of errors.slice(0, 8)) lines.push(`  ${st.dim(`${e.source}: ${e.message}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* nx help                                                             */
/* ------------------------------------------------------------------ */

const COMMANDS = [
  ["list", "[--all] [--json]", "every app: installed version, latest, status"],
  ["info", "<app> [--json]", "one app in detail: artifacts, sources, notes"],
  ["install", "<app> [artifact] [--tag <tag>]", "install (or reinstall) an artifact"],
  ["uninstall", "<app> [artifact]", "remove an installed artifact"],
  ["update", "[<app>] [--all]", "install pending updates"],
  ["launch", "<app> [artifact]", "start an installed app"],
  ["rollback", "<app> [artifact]", "restore the kept previous version"],
  ["versions", "<app> [--json]", "every published release"],
  ["refresh", "[--json]", "re-run discovery (--force bypasses the ETag cache)"],
  ["doctor", "[--offline] [--json]", "environment: adb, token, paths, rate limit"],
  ["help", "", "this text"],
];

const GLOBALS = [
  ["--json", "machine-readable output (list, info, versions, refresh, doctor)"],
  ["--plain / --no-color", "no ANSI styling (also honours NO_COLOR)"],
  ["--verbose", "let the hub's log lines through"],
  ["--force", "ignore cached ETags on the discovery pass"],
  ["--offline", "doctor: report what is on disk, no network"],
  ["--yes / -y", "skip confirmations (uninstall)"],
  ["--version", "print the hub version"],
];

function renderHelp({ style, hubVersion } = {}) {
  const st = style || createStyle(false);
  const lines = ["", st.section("nx"), ""];
  lines.push(`  ${st.muted("NX Hub from the terminal")}${hubVersion ? st.dim(`  ${hubVersion}`) : ""}`);
  lines.push("", `  ${st.text("nx <command> [app] [artifact] [flags]")}`, "");
  const width = Math.max(...COMMANDS.map(([c, a]) => `${c} ${a}`.trim().length));
  for (const [cmd, args, help] of COMMANDS) {
    const usage = `${cmd}${args ? ` ${args}` : ""}`;
    lines.push(`  ${st.violet(cmd)}${st.muted(args ? ` ${args}` : "")}${" ".repeat(Math.max(1, width - usage.length + 2))}${st.dim(help)}`);
  }
  lines.push("", `  ${st.head("flags")}`);
  const fw = Math.max(...GLOBALS.map(([f]) => f.length));
  for (const [flag, help] of GLOBALS) lines.push(`  ${st.muted(flag.padEnd(fw))}  ${st.dim(help)}`);
  lines.push(
    "",
    `  ${st.dim("apps match on id, name or prefix — `nx info wiv` works.")}`,
    `  ${st.dim("exit codes: 0 ok · 1 usage error · 2 operation failed")}`,
    ""
  );
  return lines.join("\n");
}

module.exports = {
  renderList,
  renderInfo,
  renderVersions,
  renderDoctor,
  renderHelp,
  listJson,
  appJson,
  artifactJson,
  statusOf,
  installedVersions,
  splitApps,
  inMainGrid,
  bottomReason,
  summarize,
  table,
  kv,
  T,
  dateOnly,
  GLYPH,
  STATUS_TEXT,
  COMMANDS,
};
