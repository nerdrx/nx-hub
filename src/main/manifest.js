"use strict";
// NX Hub — SPEC v0.12 "app manifest".
//
// An app repo describes itself in `nx-app.json`; this module decides how much
// of that description the hub is willing to believe. Pure node: no electron,
// and validate() does no I/O and never throws.
//
// Two sources, first hit wins (SPEC "Where a manifest comes from"):
//   1. a release asset named exactly `nx-app.json` — travels with the version
//      it describes and works for private repos through the token
//   2. `nx-app.json` at the default-branch root — ONE fetchRaw, cached, and
//      skipped entirely when the hub is anonymous or the rate limit is tight
//      (discovery scans every repo; a per-repo fetch is exactly how a working
//      hub becomes a rate-limited one)
//
// Precedence lives in discovery.js: registry/overrides.json > this manifest >
// derived defaults, PER FIELD.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = require("./config");

/** The one file name, in a release's assets and at the repo root. */
const MANIFEST_FILE = "nx-app.json";

const BUNDLED_OVERLAY = path.join(__dirname, "..", "..", "registry", "overrides.json");

/**
 * Caps, because this crosses a wire (SPEC). Anything longer is CLIPPED rather
 * than rejected: a repo that writes a 900-character note gets 600 of it, not a
 * silently manifest-less app.
 */
const LIMITS = {
  bytes: 32 * 1024,
  note: 600,
  artifacts: 16,
  connectorFields: 16,
  name: 80,
  tagline: 200,
  label: 60,
  url: 300,
  cmd: 500,
  fsPath: 300,
  args: 32,
  configPaths: 16,
  key: 64,
  unit: 16,
  problems: 40,
};

/**
 * SPEC "Trust", tier one — accepted from ANY repo. Presentation only, escaped
 * by the renderer like every other foreign string.
 */
const PRESENTATION_FIELDS = ["name", "tagline", "label", "postInstallNote", "connector.fields", "homepage"];

/**
 * SPEC "Trust", tier two — accepted only from a trusted owner. Every field
 * that executes something or decides where bytes land. `postInstallCmd` is
 * what the Run button hands to pkexec; `prefix`/`addonsDir`/`configPaths`
 * write outside the install root.
 */
const TRUSTED_FIELDS = [
  "postInstallCmd",
  "launchCmd",
  "args",
  "sandbox",
  "configPaths",
  "prefix",
  "stripPrefix",
  "addonsDir",
  "binHint",
  "packageId",
  "keepAlive",
];

/**
 * Not named in either SPEC list, but they belong on the trusted side by the
 * rule the SPEC states: `kind` SELECTS THE INSTALL ENGINE (tarball-prefix
 * writes into a shared prefix, blender-addon into the Blender config tree), so
 * it decides where bytes land just as surely as `prefix` does. A foreign repo
 * can label and annotate whatever the classifier already recognised; it cannot
 * re-point it at another engine.
 */
const TRUSTED_STRUCTURAL = ["kind", "platform"];

/** Install kinds src/main/install/engine.js knows (kept literal: pure module). */
const KINDS = [
  "appimage",
  "archive-dir",
  "tarball-prefix",
  "apk-adb",
  "blender-addon",
  "blender-theme",
  "generic-zip",
  "windows-portable",
  "windows-zip",
];

const PLATFORMS = ["linux", "windows", "android"];
const SANDBOX_PROFILES = ["none", "confined", "offline"];
const FIELD_KINDS = ["text", "number", "bool"];

/** Keys a manifest may carry that we deliberately accept and then ignore. */
const IGNORED_KEYS = ["$schema", "//"];

const TOP_KEYS = [
  "nxApp",
  "name",
  "tagline",
  "homepage",
  "postInstallNote",
  "connector",
  "artifacts",
  "sandbox",
  "configPaths",
  "keepAlive",
];

const ARTIFACT_KEYS = [
  "assetPattern",
  "label",
  "postInstallNote",
  "kind",
  "platform",
  "packageId",
  "launchCmd",
  "postInstallCmd",
  "args",
  "prefix",
  "stripPrefix",
  "addonsDir",
  "binHint",
  "sandbox",
  "configPaths",
];

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function has(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Trimmed, clipped, control-characters stripped. Returns null for junk. */
function clip(value, max) {
  if (typeof value !== "string") return null;
  // Foreign text goes into a UI and into log lines: NUL/CR/ESC have no business
  // in either. (Escaping is the renderer's job; this is only hygiene.)
  const flat = value
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max) : flat;
}

function lower(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* trust                                                               */
/* ------------------------------------------------------------------ */

/**
 * SPEC: trusted = settings.owners ∪ settings.trustedManifestOwners.
 * @param {string} owner  repo owner login
 * @param {object} [settings]
 */
function isTrustedOwner(owner, settings) {
  const who = lower(owner);
  if (!who) return false;
  const s = settings || config.load();
  const lists = [Array.isArray(s.owners) ? s.owners : [], Array.isArray(s.trustedManifestOwners) ? s.trustedManifestOwners : []];
  return lists.some((list) => list.some((o) => lower(o) === who));
}

/* ------------------------------------------------------------------ */
/* validate — pure, no I/O, never throws                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string|object} raw   the manifest text or an already-parsed object
 * @param {object} [opts]
 * @param {string} [opts.owner]   repo owner (reporting only)
 * @param {boolean} [opts.trusted] may this manifest carry executable fields?
 * @returns {{ok:boolean, manifest:object|null, problems:Array<{field:string,detail:string}>, dropped:string[]}}
 */
function validate(raw, opts = {}) {
  const owner = opts.owner || null;
  const trusted = opts.trusted === true;
  const problems = [];
  const dropped = [];

  const add = (field, detail) => {
    if (problems.length < LIMITS.problems) problems.push({ field: String(field || ""), detail: String(detail) });
  };
  // Bare names, deduped: this list becomes ONE log line and one CLI paragraph.
  const drop = (field) => {
    const name = String(field);
    if (!dropped.includes(name)) dropped.push(name);
  };
  const fail = () => ({ ok: false, manifest: null, problems, dropped, owner, trusted });

  /* ---- parse + size cap ---- */
  let text = null;
  let obj = null;
  try {
    if (typeof raw === "string") text = raw;
    else if (raw && typeof raw === "object" && !Array.isArray(raw)) text = JSON.stringify(raw);
    else {
      add("", `expected a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
      return fail();
    }
  } catch (e) {
    add("", `could not be read (${e.message})`);
    return fail();
  }

  const bytes = Buffer.byteLength(text || "", "utf8");
  if (bytes > LIMITS.bytes) {
    add("", `too large — ${bytes} bytes, the limit is ${LIMITS.bytes}`);
    return fail();
  }

  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      add("", `not valid JSON (${e.message})`);
      return fail();
    }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    add("", "expected a JSON object");
    return fail();
  }

  const out = {};

  /* ---- format marker ---- */
  if (has(obj, "nxApp")) {
    const n = Number(obj.nxApp);
    if (Number.isFinite(n) && n >= 1) out.nxApp = Math.floor(n);
    else add("nxApp", "expected a version number (1)");
  }
  if (out.nxApp == null) out.nxApp = 1;

  /* ---- presentation, accepted from anyone ---- */
  const name = clip(obj.name, LIMITS.name);
  if (has(obj, "name") && !name) add("name", "expected a non-empty string");
  if (name) out.name = name;

  const tagline = clip(obj.tagline, LIMITS.tagline);
  if (has(obj, "tagline") && !tagline) add("tagline", "expected a non-empty string");
  if (tagline) out.tagline = tagline;

  if (has(obj, "homepage")) {
    const url = clip(obj.homepage, LIMITS.url);
    if (url && /^https?:\/\/\S+$/i.test(url)) out.homepage = url;
    else add("homepage", "expected an http(s) URL");
  }

  const note = clip(obj.postInstallNote, LIMITS.note);
  if (has(obj, "postInstallNote") && !note) add("postInstallNote", "expected a non-empty string");
  if (note) out.postInstallNote = note;

  /* ---- connector.fields, accepted from anyone ---- */
  if (has(obj, "connector")) {
    const fields = readConnectorFields(obj.connector, add);
    if (fields.length) out.connector = { fields };
  }

  /* ---- trusted-only, app level ---- */
  const takeTrusted = (src, key, field, apply) => {
    if (!has(src, key) || src[key] == null) return;
    if (!trusted) {
      drop(key);
      return;
    }
    apply(src[key], field);
  };

  takeTrusted(obj, "sandbox", "sandbox", (value) => {
    const profile = lower(value);
    if (SANDBOX_PROFILES.includes(profile)) out.sandbox = profile;
    else add("sandbox", `expected one of ${SANDBOX_PROFILES.join(", ")}`);
  });
  takeTrusted(obj, "configPaths", "configPaths", (value) => {
    const paths = readPaths(value, "configPaths", add);
    if (paths.length) out.configPaths = paths;
  });
  takeTrusted(obj, "keepAlive", "keepAlive", (value) => {
    if (typeof value === "boolean") out.keepAlive = value;
    else add("keepAlive", "expected true or false");
  });

  /* ---- artifacts ---- */
  out.artifacts = [];
  if (has(obj, "artifacts")) {
    if (!Array.isArray(obj.artifacts)) {
      add("artifacts", "expected an array");
    } else {
      const list = obj.artifacts;
      if (list.length > LIMITS.artifacts) {
        add("artifacts", `only the first ${LIMITS.artifacts} artifacts are used (${list.length} given)`);
      }
      list.slice(0, LIMITS.artifacts).forEach((entry, index) => {
        const row = readArtifact(entry, index, { trusted, add, drop });
        if (row) out.artifacts.push(row);
      });
    }
  }

  /* ---- unknown keys are dropped (and reported, so CI catches typos) ---- */
  for (const key of Object.keys(obj)) {
    if (TOP_KEYS.includes(key) || IGNORED_KEYS.includes(key)) continue;
    add(key, "unknown field — ignored");
  }

  /* ---- a file with nothing we recognise is not a manifest ---- */
  const carries = TOP_KEYS.some((k) => k !== "nxApp" && has(out, k) && (k !== "artifacts" || out.artifacts.length));
  if (!carries) {
    add("", dropped.length ? "nothing left after the untrusted fields were dropped" : "no recognised nx-app.json fields");
    return fail();
  }

  return { ok: true, manifest: out, problems, dropped, owner, trusted };
}

/** `connector: {fields: [...]}` — key/label/unit/kind, ≤16, presentation only. */
function readConnectorFields(connector, add) {
  const out = [];
  if (!connector || typeof connector !== "object") {
    add("connector", "expected an object with a `fields` array");
    return out;
  }
  let raw = connector.fields;
  // The overlay also allows the shorthand {key: "Label"} (nx-wisp) — accept it
  // here too rather than telling an app author their file is wrong.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = Object.keys(raw).map((key) => ({ key, label: raw[key] }));
  }
  if (!Array.isArray(raw)) {
    add("connector.fields", "expected an array of {key, label, unit, kind}");
    return out;
  }
  if (raw.length > LIMITS.connectorFields) {
    add("connector.fields", `only the first ${LIMITS.connectorFields} fields are used (${raw.length} given)`);
  }
  for (const field of raw.slice(0, LIMITS.connectorFields)) {
    if (!field || typeof field !== "object") continue;
    const key = clip(field.key, LIMITS.key);
    if (!key) {
      add("connector.fields", "a field without a `key` was ignored");
      continue;
    }
    const row = { key, label: clip(field.label, LIMITS.label) || key, unit: clip(field.unit, LIMITS.unit) || "" };
    const kind = lower(field.kind);
    if (!kind) row.kind = "text";
    else if (FIELD_KINDS.includes(kind)) row.kind = kind;
    else {
      add(`connector.fields.${key}.kind`, `unknown kind "${field.kind}" — treated as text`);
      row.kind = "text";
    }
    out.push(row);
  }
  return out;
}

function readPaths(value, field, add) {
  if (!Array.isArray(value)) {
    add(field, "expected an array of strings");
    return [];
  }
  const out = [];
  for (const item of value.slice(0, LIMITS.configPaths)) {
    const p = clip(item, LIMITS.fsPath);
    if (p) out.push(p);
  }
  if (value.length > LIMITS.configPaths) add(field, `only the first ${LIMITS.configPaths} entries are used`);
  return out;
}

/** One `artifacts[]` entry, trust-filtered. Returns null when unusable. */
function readArtifact(entry, index, { trusted, add, drop }) {
  const where = `artifacts[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    add(where, "expected an object");
    return null;
  }
  const pattern = clip(entry.assetPattern, LIMITS.name);
  if (!pattern) {
    add(`${where}.assetPattern`, "required — the asset name (globs allowed) this entry describes");
    return null;
  }
  const row = { assetPattern: pattern };

  const label = clip(entry.label, LIMITS.label);
  if (has(entry, "label") && !label) add(`${where}.label`, "expected a non-empty string");
  if (label) row.label = label;

  const note = clip(entry.postInstallNote, LIMITS.note);
  if (has(entry, "postInstallNote") && !note) add(`${where}.postInstallNote`, "expected a non-empty string");
  if (note) row.postInstallNote = note;

  const takeTrusted = (key, apply) => {
    if (!has(entry, key) || entry[key] == null) return;
    if (!trusted) {
      drop(key);
      return;
    }
    apply(entry[key]);
  };

  takeTrusted("kind", (value) => {
    const kind = lower(value);
    if (KINDS.includes(kind)) row.kind = kind;
    else add(`${where}.kind`, `unknown install kind "${value}"`);
  });
  takeTrusted("platform", (value) => {
    const platform = lower(value);
    if (PLATFORMS.includes(platform)) row.platform = platform;
    else add(`${where}.platform`, `expected one of ${PLATFORMS.join(", ")}`);
  });
  takeTrusted("sandbox", (value) => {
    const profile = lower(value);
    if (SANDBOX_PROFILES.includes(profile)) row.sandbox = profile;
    else add(`${where}.sandbox`, `expected one of ${SANDBOX_PROFILES.join(", ")}`);
  });
  takeTrusted("configPaths", (value) => {
    const paths = readPaths(value, `${where}.configPaths`, add);
    if (paths.length) row.configPaths = paths;
  });
  takeTrusted("args", (value) => {
    if (!Array.isArray(value)) {
      add(`${where}.args`, "expected an array of strings");
      return;
    }
    const args = value.slice(0, LIMITS.args).map((a) => clip(a, LIMITS.cmd)).filter(Boolean);
    if (args.length) row.args = args;
  });
  for (const key of ["packageId", "launchCmd", "postInstallCmd", "prefix", "stripPrefix", "addonsDir", "binHint"]) {
    takeTrusted(key, (value) => {
      const max = key === "launchCmd" || key === "postInstallCmd" ? LIMITS.cmd : LIMITS.fsPath;
      const v = clip(value, max);
      if (v) row[key] = v;
      else add(`${where}.${key}`, "expected a non-empty string");
    });
  }

  for (const key of Object.keys(entry)) {
    if (ARTIFACT_KEYS.includes(key) || IGNORED_KEYS.includes(key)) continue;
    add(`${where}.${key}`, "unknown field — ignored");
  }

  // A pattern with nothing attached to it says nothing — and after an
  // untrusted drop that is exactly what a commands-only entry becomes.
  if (Object.keys(row).length === 1) {
    add(where, "nothing usable besides `assetPattern` — ignored");
    return null;
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* fromOverlayEntry — `nx manifest init`                               */
/* ------------------------------------------------------------------ */

function bundledOverlay() {
  try {
    const raw = JSON.parse(fs.readFileSync(BUNDLED_OVERLAY, "utf8"));
    const apps = {};
    if (raw && raw.apps && typeof raw.apps === "object") {
      for (const key of Object.keys(raw.apps)) apps[key.toLowerCase()] = raw.apps[key] || {};
    }
    return { apps };
  } catch (_) {
    return { apps: {} };
  }
}

/** Every app id the bundled overlay curates, sorted — `nx manifest init`'s hint. */
function overlayIds(opts = {}) {
  const overlay = opts.overlay && opts.overlay.apps ? opts.overlay : bundledOverlay();
  return Object.keys(overlay.apps || {}).sort();
}

/**
 * The `nx-app.json` an app the hub ALREADY curates would ship — so our own
 * repos adopt this by pasting one file (SPEC: `nx manifest init <app>`).
 *
 * Only fields the validator accepts are emitted: `order` and `skip` stay
 * central-overlay-only on purpose (a repo does not get to rank itself).
 *
 * @param {string} appId
 * @param {object} [opts]
 * @param {object} [opts.overlay] normalized overlay ({apps:{}}) — defaults to
 *                                the bundled registry/overrides.json
 * @returns {object|null}
 */
function fromOverlayEntry(appId, opts = {}) {
  const overlay = opts.overlay && opts.overlay.apps ? opts.overlay : bundledOverlay();
  const id = lower(appId);
  if (!id) return null;
  const apps = overlay.apps || {};
  // App ids of foreign owners are `owner--repo`; the overlay is keyed by repo.
  const key = has(apps, id) ? id : id.includes("--") ? id.slice(id.indexOf("--") + 2) : id;
  const entry = apps[key];
  if (!entry || typeof entry !== "object") return null;

  const out = { nxApp: 1 };
  if (entry.name) out.name = entry.name;
  if (entry.tagline) out.tagline = entry.tagline;
  if (entry.homepage) out.homepage = entry.homepage;
  if (entry.postInstallNote) out.postInstallNote = entry.postInstallNote;
  if (typeof entry.sandbox === "string") out.sandbox = entry.sandbox;
  if (Array.isArray(entry.configPaths) && entry.configPaths.length) out.configPaths = entry.configPaths.slice();
  if (entry.connector) {
    const fields = readConnectorFields(entry.connector, () => {});
    if (fields.length) out.connector = { fields };
  }

  const artifacts = [];
  for (const a of Array.isArray(entry.artifacts) ? entry.artifacts : []) {
    if (!a || typeof a !== "object" || !a.assetPattern || a.skip) continue;
    const row = { assetPattern: a.assetPattern };
    for (const key2 of ARTIFACT_KEYS) {
      if (key2 === "assetPattern") continue;
      if (a[key2] != null) row[key2] = Array.isArray(a[key2]) ? a[key2].slice() : a[key2];
    }
    artifacts.push(row);
  }
  if (artifacts.length) out.artifacts = artifacts;
  return out;
}

/* ------------------------------------------------------------------ */
/* sources                                                             */
/* ------------------------------------------------------------------ */

/** The `nx-app.json` asset of the newest release that ships one, or null. */
function manifestAsset(releases) {
  const list = Array.isArray(releases) ? releases : releases ? [releases] : [];
  for (const rel of list) {
    if (!rel || rel.draft) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const hit = assets.find((a) => a && String(a.name || "").toLowerCase() === MANIFEST_FILE);
    if (hit) return { asset: hit, release: rel };
  }
  return null;
}

/** True for the manifest asset itself — it must never become an installable row. */
function isManifestAsset(name) {
  return String(name || "").toLowerCase() === MANIFEST_FILE;
}

/* ------------------------------------------------------------------ */
/* repo-root fetch + its cache                                         */
/* ------------------------------------------------------------------ */

/** How long a repo-root answer (including "there is none") is reused. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cacheFileFor(fullName) {
  const safe = String(fullName || "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(config.cacheDir(), "manifests", `${safe}.json`);
}

function readCache(fullName) {
  return config.readJson(cacheFileFor(fullName), null);
}

function writeCache(fullName, entry) {
  try {
    config.ensureDir(path.dirname(cacheFileFor(fullName)));
    config.writeJsonAtomic(cacheFileFor(fullName), entry);
  } catch (_) {
    /* the cache is best-effort — a hub with a read-only cache dir still works */
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

/**
 * `nx-app.json` at the default-branch root. One fetchRaw, cached by content
 * sha with a TTL that also remembers "this repo has none" — without the
 * negative cache every refresh would re-ask every repo.
 *
 * @returns {Promise<string|null>} the manifest text, or null
 */
async function fetchRepoRoot({ repo, github, force = false, signal, ttlMs = CACHE_TTL_MS, log = config.log }) {
  const fullName = String(repo.full_name || repo.name || "");
  const ref = repo.default_branch || "main";
  const cached = readCache(fullName);
  const fresh = cached && Number.isFinite(Number(cached.at)) && Date.now() - Number(cached.at) < ttlMs;
  if (!force && fresh && cached.ref === ref) return cached.missing ? null : cached.text || null;

  let text = null;
  try {
    text = await github.fetchRaw(fullName, ref, MANIFEST_FILE, { signal });
  } catch (e) {
    // A repo-root miss is never fatal: fall back to whatever we cached, even
    // if it is stale, and let discovery carry on.
    log(`manifest: ${fullName} root fetch failed (${e.message})`);
    return cached && !cached.missing ? cached.text || null : null;
  }
  if (typeof text !== "string" || !text.trim()) {
    writeCache(fullName, { repo: fullName, ref, at: Date.now(), missing: true });
    return null;
  }
  writeCache(fullName, { repo: fullName, ref, at: Date.now(), sha: sha256(text), text });
  return text;
}

/* ------------------------------------------------------------------ */
/* one repo → one manifest entry                                       */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<null|{present:true, source:"asset"|"repo", trusted:boolean,
 *                         owner:string, manifest:object, problems:Array, dropped:string[]}>}
 */
async function loadForRepo({
  repo,
  releases,
  github,
  settings,
  allowRepoFetch = false,
  force = false,
  signal,
  log = config.log,
  ttlMs = CACHE_TTL_MS,
}) {
  if (!repo || !repo.name) return null;
  const fullName = String(repo.full_name || repo.name);
  const owner = (repo.owner && repo.owner.login) || String(fullName).split("/")[0] || "";
  const trusted = isTrustedOwner(owner, settings);

  let text = null;
  let source = null;

  const hit = manifestAsset(releases);
  if (hit) {
    source = "asset";
    if (Number(hit.asset.size || 0) > LIMITS.bytes) {
      log(`manifest: ${fullName} ships an ${MANIFEST_FILE} asset of ${hit.asset.size} bytes — ignored (limit ${LIMITS.bytes})`);
      return null;
    }
    try {
      text = await github.fetchAssetText(hit.asset, { signal });
    } catch (e) {
      log(`manifest: ${fullName} ${MANIFEST_FILE} asset could not be read (${e.message})`);
      return null;
    }
  } else if (allowRepoFetch) {
    source = "repo";
    text = await fetchRepoRoot({ repo, github, force, signal, ttlMs, log });
  }

  if (typeof text !== "string" || !text.trim()) return null;

  const result = validate(text, { owner, trusted });
  if (!result.ok) {
    // SPEC: a malformed manifest is ignored with ONE log line and NEVER breaks
    // discovery.
    const why = (result.problems[0] && result.problems[0].detail) || "unusable";
    log(`manifest: ${fullName} ${MANIFEST_FILE} (${source}) ignored — ${why}`);
    return null;
  }
  if (result.dropped.length) {
    // SPEC: ONE log line naming the fields. "Show this sentence" and "offer to
    // run this command as root" are not the same privilege.
    log(`manifest: ${owner} is not a trusted manifest owner — dropped ${result.dropped.join(", ")} from ${fullName}/${MANIFEST_FILE}`);
  }
  return {
    present: true,
    source,
    trusted,
    owner,
    manifest: result.manifest,
    problems: result.problems,
    dropped: result.dropped,
  };
}

/* ------------------------------------------------------------------ */
/* the discovery pass                                                  */
/* ------------------------------------------------------------------ */

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1))).fill(0).map(async () => {
    for (;;) {
      const idx = i;
      i += 1;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Manifests for a whole discovery pass, keyed by lowercased repo full_name.
 *
 * `allowRepoFetch` gates ONLY source 2 — a release asset costs nothing extra
 * and is always read.
 *
 * @returns {Promise<{manifests:object, stats:{asset:number, repo:number, dropped:number}}>}
 */
async function collect({
  repos,
  releases,
  github,
  settings,
  allowRepoFetch = false,
  force = false,
  signal,
  concurrency = 6,
  log = config.log,
  ttlMs = CACHE_TTL_MS,
}) {
  const manifests = {};
  const stats = { asset: 0, repo: 0, dropped: 0 };
  const list = Array.isArray(repos) ? repos.filter((r) => r && r.name) : [];

  await mapLimit(list, concurrency, async (repo) => {
    const key = String(repo.full_name || repo.name).toLowerCase();
    try {
      const entry = await loadForRepo({
        repo,
        releases: (releases && releases[key]) || null,
        github,
        settings,
        allowRepoFetch,
        force,
        signal,
        log,
        ttlMs,
      });
      if (!entry) return;
      manifests[key] = entry;
      stats[entry.source] += 1;
      if (entry.dropped.length) stats.dropped += 1;
    } catch (e) {
      // Belt and braces: nothing in this module may break a discovery pass.
      log(`manifest: ${repo.full_name || repo.name} — ${e.message}`);
    }
  });

  return { manifests, stats };
}

module.exports = {
  MANIFEST_FILE,
  LIMITS,
  KINDS,
  PLATFORMS,
  PRESENTATION_FIELDS,
  TRUSTED_FIELDS,
  TRUSTED_STRUCTURAL,
  CACHE_TTL_MS,
  validate,
  isTrustedOwner,
  fromOverlayEntry,
  overlayIds,
  manifestAsset,
  isManifestAsset,
  fetchRepoRoot,
  loadForRepo,
  collect,
};
