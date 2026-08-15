"use strict";
// Resolving what the user typed to an app / artifact of the discovery model.
// Pure: takes app models in, returns picks + candidate lists, never prints.

/** The platform key discovery uses for "installable from this machine". */
function hostPlatform(platform = process.platform) {
  return platform === "win32" ? "windows" : "linux";
}

function lower(s) {
  return String(s == null ? "" : s).toLowerCase();
}

/**
 * Generic "exact → prefix → substring" resolution over a list of records.
 * Ordinal comparisons only (the host may run any locale).
 *
 * @param {Array} list
 * @param {string} query
 * @param {function} keysOf record → string[] of things the query may name
 * @returns {{match:any|null, candidates:Array, exact:boolean}}
 */
function resolve(list, query, keysOf) {
  const q = lower(query).trim();
  const rows = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!q) return { match: null, candidates: rows, exact: false };

  const exact = rows.filter((r) => keysOf(r).some((k) => lower(k) === q));
  if (exact.length === 1) return { match: exact[0], candidates: exact, exact: true };
  if (exact.length > 1) return { match: null, candidates: exact, exact: true };

  const prefix = rows.filter((r) => keysOf(r).some((k) => lower(k).startsWith(q)));
  if (prefix.length === 1) return { match: prefix[0], candidates: prefix, exact: false };
  if (prefix.length > 1) return { match: null, candidates: prefix, exact: false };

  const loose = rows.filter((r) => keysOf(r).some((k) => lower(k).includes(q)));
  if (loose.length === 1) return { match: loose[0], candidates: loose, exact: false };
  return { match: null, candidates: loose, exact: false };
}

/** Everything a query may legitimately name an app by. */
function appKeys(app) {
  const keys = [app.id, app.name, app.repo];
  // "nerdrx/wivrn-nx" typed as "wivrn-nx" is already covered by id; also allow
  // the bare repo name of a foreign-owner app (id is "owner--name" there).
  if (app.repo && String(app.repo).includes("/")) keys.push(String(app.repo).split("/")[1]);
  // names like "WiVRn NX" should also answer to "wivrn-nx" / "wivrnnx"
  if (app.name) {
    keys.push(String(app.name).replace(/\s+/g, "-"));
    keys.push(String(app.name).replace(/\s+/g, ""));
  }
  return keys.filter(Boolean);
}

/**
 * @returns {{app:object|null, candidates:object[], error:string|null}}
 */
function matchApp(apps, query) {
  const list = Array.isArray(apps) ? apps : [];
  if (!query) return { app: null, candidates: [], error: "Name an app — try `nx list` to see them all." };
  const { match, candidates } = resolve(list, query, appKeys);
  if (match) return { app: match, candidates: [match], error: null };
  if (candidates.length > 1) {
    return {
      app: null,
      candidates,
      error: `"${query}" matches ${candidates.length} apps — be more specific.`,
    };
  }
  return { app: null, candidates: [], error: `No app matches "${query}". Try \`nx list\`.` };
}

const ARTIFACT_MODES = {
  /** installable from this machine: same platform, or android (sideloaded over adb) */
  install: (a, host) => a.platform === host || a.platform === "android",
  installed: (a) => Boolean(a.installed),
  launch: (a) => Boolean(a.installed) && a.launchable !== false,
  rollback: (a) => Boolean(a.rollbackAvailable),
  update: (a, host) => Boolean(a.updateAvailable) && (a.platform === host || a.platform === "android"),
  any: () => true,
};

function artifactKeys(artifact) {
  return [artifact.id, artifact.label, artifact.kind, artifact.assetName].filter(Boolean);
}

/**
 * Pick the artifact a command should act on.
 *
 * With an explicit `query` the match runs over ALL artifacts (so an id always
 * works, whatever its state). Without one, the artifacts eligible for `mode`
 * decide: exactly one → that one, otherwise the caller lists the candidates.
 *
 * @returns {{artifact:object|null, candidates:object[], error:string|null}}
 */
function pickArtifact(app, query, { mode = "install", platform = process.platform } = {}) {
  const all = (app && app.artifacts) || [];
  const host = hostPlatform(platform);
  const eligible = all.filter((a) => (ARTIFACT_MODES[mode] || ARTIFACT_MODES.any)(a, host));

  if (query) {
    const { match, candidates } = resolve(all, query, artifactKeys);
    if (match) return { artifact: match, candidates: [match], error: null };
    if (candidates.length > 1) {
      return { artifact: null, candidates, error: `"${query}" matches ${candidates.length} downloads of ${app.name}.` };
    }
    return { artifact: null, candidates: all, error: `${app.name} has no download called "${query}".` };
  }

  if (eligible.length === 1) return { artifact: eligible[0], candidates: eligible, error: null };
  if (eligible.length === 0) {
    return {
      artifact: null,
      candidates: all,
      error: emptyMessage(app, mode, host),
    };
  }
  return {
    artifact: null,
    candidates: eligible,
    error: `${app.name} has ${eligible.length} downloads — name one.`,
  };
}

function emptyMessage(app, mode, host) {
  const name = (app && app.name) || "This app";
  switch (mode) {
    case "installed":
      return `${name} is not installed.`;
    case "launch":
      return `${name} has nothing installed to launch.`;
    case "rollback":
      return `${name} has no kept previous version to roll back to.`;
    case "update":
      return `${name} is up to date.`;
    default:
      return `${name} has nothing installable on this machine (${host}).`;
  }
}

module.exports = { matchApp, pickArtifact, resolve, appKeys, artifactKeys, hostPlatform, ARTIFACT_MODES };
