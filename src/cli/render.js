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
/* nx status — the NX Connector bus (v0.5)                             */
/* ------------------------------------------------------------------ */

/** ms → "42s" / "12m" / "3h 04m" / "2d 3h". Locale-independent by design. */
function fmtDuration(ms) {
  if (ms == null || ms === "") return DASH; // "unknown" is not "zero"
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return DASH;
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function sinceMs(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ""));
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** The connector fields of one client, formatted the way the tray formats them. */
function clientFields(client, fieldDefs) {
  // One implementation, shared with the tray and the cards (src/main/ipc.js).
  // eslint-disable-next-line global-require
  const { formatFields } = require("../main/ipc");
  const defs = (fieldDefs && (fieldDefs[String(client.app).toLowerCase()] || fieldDefs[client.app])) || [];
  return formatFields(defs, client.fields);
}

function statusJson(info, { now = Date.now() } = {}) {
  const i = info || {};
  return {
    ok: Boolean(i.online),
    bus: {
      host: i.host || "127.0.0.1",
      port: i.port || null,
      listening: Boolean(i.listening),
      online: Boolean(i.online),
      stale: Boolean(i.stale),
      snapshot: i.snapshotPath || null,
      snapshotAgeMs: i.ageMs == null ? null : i.ageMs,
      ts: i.ts || null,
    },
    clients: (i.clients || []).map((c) => ({
      app: c.app,
      version: c.version || null,
      pid: c.pid == null ? null : c.pid,
      since: c.since || null,
      uptimeMs: sinceMs(c.since, now),
      lastSeen: c.lastSeen || null,
      fields: c.fields && typeof c.fields === "object" ? c.fields : {},
    })),
  };
}

function renderStatus(info, { style, now = Date.now() } = {}) {
  const st = style || createStyle(false);
  const i = info || {};
  const lines = ["", st.section("Connector"), ""];
  const where = `${i.host || "127.0.0.1"}:${i.port || DASH}`;

  const busText = !i.listening
    ? "offline — no hub is running"
    : i.stale
      ? "listening, but the hub published no fresh client list"
      : "online";
  lines.push(
    ...kv(
      [
        ["bus", `${where}  ${busText}`, i.online ? st.cyan : i.listening ? st.amber : st.muted],
        ["snapshot", i.snapshotExists ? `${i.snapshotPath}  ${fmtDuration(i.ageMs)} old` : `${i.snapshotPath} (not written yet)`, st.dim],
      ],
      st
    )
  );

  const clients = i.clients || [];
  lines.push("", `  ${st.section("Clients")}`, "");
  if (!i.listening) {
    lines.push(`  ${st.muted("Start NX Hub to bring the bus up.")}`);
  } else if (!clients.length) {
    lines.push(`  ${st.muted("No NX app is connected right now.")}`);
  } else {
    const rows = clients.map((c) => {
      const fields = clientFields(c, i.fieldDefs);
      return [
        T("·", st.cyan),
        T(c.app, st.text),
        T(c.version || DASH, st.muted),
        T(fmtDuration(sinceMs(c.since, now)), st.dim),
        T(c.pid == null ? DASH : String(c.pid), st.dim),
        T(fields || DASH, fields ? st.value : st.dim),
      ];
    });
    lines.push(...table(["", "app", "version", "uptime", "pid", "status"], rows, st));
    if (i.stale) lines.push("", `  ${st.amber("this list is stale — the hub may have gone away")}`);
  }

  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* nx stack (v0.5)                                                     */
/* ------------------------------------------------------------------ */

function healthText(health) {
  const h = health || {};
  if (h.type === "port") return `port ${h.port}`;
  if (h.type === "delay") return h.timeoutMs ? `wait ${Math.round(h.timeoutMs / 1000)}s` : "no wait";
  return "connector";
}

function stackFlow(stack) {
  return ((stack && stack.steps) || [])
    .map((s) => `${s.appId}${s.optional ? "?" : ""}`)
    .join(" → ");
}

function stacksJson(stacks) {
  return { stacks: (Array.isArray(stacks) ? stacks : []).map((s) => ({ id: s.id, name: s.name, steps: s.steps || [] })) };
}

/* ------------------------------------------------------------------ */
/* v0.6: the fleet                                                     */
/* ------------------------------------------------------------------ */

/** Rows for `nx fleet ls --json`. Pure: peer rows in, plain JSON out. */
function fleetJson(rows, { identity = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    hub: identity ? { id: identity.id, name: identity.name } : null,
    peers: list.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      online: Boolean(row.online),
      hubVersion: row.hubVersion || null,
      error: row.error || null,
      updates: Number(row.updates) || 0,
      apps: (row.apps || []).map((a) => ({
        id: a.id,
        name: a.name,
        latest: a.latest || null,
        updates: Number(a.updates) || 0,
        installed: (a.installed || []).map((i) => ({
          artifactId: i.artifactId,
          label: i.label || i.artifactId,
          version: i.version || null,
        })),
      })),
    })),
  };
}

/** One peer's apps as "wivrn-nx 0.6.0 ↑, facenx 1.2.0" — the tail of a row. */
function fleetAppSummary(row, { limit = 3 } = {}) {
  const apps = (row && row.apps) || [];
  if (!apps.length) return "";
  const parts = apps.slice(0, limit).map((a) => {
    const version = (a.installed || []).map((i) => i.version).filter(Boolean)[0];
    return `${a.id}${version ? ` ${version}` : ""}${a.updates ? " ↑" : ""}`;
  });
  if (apps.length > limit) parts.push(`+${apps.length - limit}`);
  return parts.join(", ");
}

/**
 * `nx fleet ls` — one line per paired hub.
 *
 * The status glyph reuses the app table's vocabulary on purpose: `↑` means
 * "something over there wants updating", `✓` means "reachable and current",
 * `·` means "not answering".
 */
function renderFleet(rows, { style, identity = null } = {}) {
  const st = style || createStyle(false);
  const list = Array.isArray(rows) ? rows : [];
  const lines = ["", st.section("Fleet"), ""];

  if (identity) {
    lines.push(...kv([["this hub", `${identity.name} ${DASH} ${identity.id}`, st.dim]], st), "");
  }

  if (!list.length) {
    lines.push(
      `  ${st.muted("No paired hubs yet.")}`,
      `  ${st.dim("open the hub on the other machine, press Pair, then: nx fleet pair <host>")}`,
      ""
    );
    return lines.join("\n");
  }

  const tableRows = list.map((row) => {
    const glyph = !row.online ? GLYPH.available : row.updates ? GLYPH.update : GLYPH.installed;
    const paint = !row.online ? st.muted : row.updates ? st.amber : st.cyan;
    const apps = fleetAppSummary(row);
    return [
      T(glyph, paint),
      T(row.name || row.id, row.online ? st.text : st.muted),
      T(row.port && row.port !== 9023 ? `${row.host}:${row.port}` : row.host, st.muted),
      T(row.online ? "online" : "offline", paint),
      T(row.hubVersion || DASH, st.dim),
      T(row.updates ? String(row.updates) : row.online ? "0" : DASH, row.updates ? st.amber : st.dim),
      T(apps || (row.online ? "nothing installed" : DASH), apps ? st.muted : st.dim),
    ];
  });
  lines.push(...table(["", "name", "host", "state", "hub", "upd", "apps"], tableRows, st));

  const failed = list.filter((r) => r.error);
  for (const row of failed) {
    lines.push(`  ${st.dim(`${row.name}: ${row.error}`)}`);
  }
  lines.push("", `  ${st.dim("nx fleet install <peer> <app>  ·  nx fleet update <peer>")}`, "");
  return lines.join("\n");
}

/** One relayed remote job event, as a single line for stderr. */
function renderFleetEvent(evt, { style } = {}) {
  const st = style || createStyle(false);
  const e = evt || {};
  const where = e.appId ? `${e.appId}${e.artifactId ? `/${e.artifactId}` : ""}` : "";
  if (e.event === "job-done") return `  ${st.cyan(GLYPH.installed)} ${st.text(where)} ${st.dim(e.message || "done")}`;
  if (e.event === "job-error") return `  ${st.danger("✗")} ${st.text(where)} ${st.dim(e.message || "failed")}`;
  const pct = typeof e.pct === "number" ? `${Math.round(e.pct)}%` : "";
  return `  ${st.violet("·")} ${st.text(where)} ${st.muted(e.phase || "")} ${st.dim([pct, e.message].filter(Boolean).join(" "))}`.trimEnd();
}

function renderStacks(stacks, { style, running = null } = {}) {
  const st = style || createStyle(false);
  const list = Array.isArray(stacks) ? stacks : [];
  const lines = ["", st.section("Stacks"), ""];
  if (!list.length) {
    lines.push(`  ${st.muted("No stacks yet — build one in the hub's Launch view.")}`, "");
    return lines.join("\n");
  }
  const rows = list.map((s) => [
    T(running && running.stackId === s.id ? "▸" : "·", running && running.stackId === s.id ? st.cyan : st.muted),
    T(s.id, st.text),
    T(s.name, st.muted),
    T(String((s.steps || []).length), st.dim),
    T(stackFlow(s), st.muted),
  ]);
  lines.push(...table(["", "id", "name", "steps", "flow"], rows, st));
  for (const s of list) {
    lines.push("", `  ${st.text(s.name)} ${st.dim(`(${s.id})`)}`);
    (s.steps || []).forEach((step, idx) => {
      lines.push(
        `    ${st.dim(String(idx + 1).padStart(2))} ${st.text(step.appId)}${step.artifactId ? st.dim(` / ${step.artifactId}`) : ""} ${st.muted(
          healthText(step.health)
        )}${step.optional ? st.dim(" optional") : ""}`
      );
    });
  }
  lines.push("", `  ${st.dim("run one with: nx stack run <id>")}`, "");
  return lines.join("\n");
}

const PHASE_PAINT = {
  launching: "violet",
  waiting: "muted",
  healthy: "cyan",
  failed: "danger",
  done: "cyan",
  stopping: "muted",
  stopped: "amber",
};

/**
 * One `stack-progress` event as a terminal line. The run's own terminal events
 * carry stepIndex null — those get the wide glyph, steps get their number.
 */
function renderStackPhase(evt, { style } = {}) {
  const st = style || createStyle(false);
  const e = evt || {};
  const paint = st[PHASE_PAINT[e.phase] || "muted"] || st.muted;
  const isRun = e.stepIndex == null;
  const mark = isRun ? (e.phase === "failed" ? st.danger("✗") : st.cyan("✓")) : st.dim(String(e.stepIndex + 1).padStart(2));
  const target = e.appId ? st.text(e.appId) : st.muted(e.phase === "done" ? "stack up" : "stack");
  const extra = e.message ? st.dim(` — ${e.message}`) : e.health ? st.dim(` (${e.health})`) : e.how ? st.dim(` (${e.how})`) : "";
  return `  ${mark} ${paint(String(e.phase).padEnd(9))} ${target}${extra}`;
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
  ["status", "[--json]", "the NX Connector bus: who is live right now"],
  ["stack", "ls | run <id> | stop <id>", "multi-app stacks"],
  ["fleet", "ls | pair <host> | install <peer> <app> | update <peer> | wake <peer>", "the other NX Hubs on your LAN"],
  // v0.7 [dev-tools]
  ["dev", "ls | link <path> | unlink <id> | run <id>", "working trees you are hacking on"],
  ["bisect", "<app> [artifact] | good | bad | skip | status | reset", "binary-search releases for the first bad one"],
  // v0.8 [timemachine]
  ["snapshots", "<app> | rm <app> <file>", "config snapshots taken before updates"],
  ["restore", "<app> [file] [-y]", "put a config snapshot back (newest by default)"],
  // v0.8 [recorder]
  ["log", "[--since 24h] [--type x] [--app y] [--follow]", "what the hub has been doing (the flight recorder)"],
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
  // v0.5
  renderStatus,
  statusJson,
  renderStacks,
  stacksJson,
  // v0.6
  renderFleet,
  fleetJson,
  fleetAppSummary,
  renderFleetEvent,
  renderStackPhase,
  stackFlow,
  healthText,
  clientFields,
  fmtDuration,
  sinceMs,
  PHASE_PAINT,
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
