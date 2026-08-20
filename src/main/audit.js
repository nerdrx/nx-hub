"use strict";
// NX Hub — the deep audit. SPEC v0.10 "Deep audit".
//
// `fsck` for installs: state.json says an app is installed, this module asks
// the filesystem whether that is still TRUE. Every install the hub recorded is
// walked against the manifest the engine wrote next to it, and each way it can
// have rotted gets its own typed problem:
//
//   missing-dir           the install directory is gone (or is not a directory)
//   bad-manifest          .nx-manifest.json is missing, unreadable or not JSON
//   missing-binary        manifest.binary names a file that is not there
//   not-executable        it is there, but nothing can run it (no +x)
//   missing-file          a file the manifest recorded OUTSIDE the install dir
//                         (or an appimage's kept original) has gone
//   missing-desktop-entry a .desktop entry the install wrote is gone
//   hash-mismatch         the kept AppImage's sha256 is not the one on record
//
// Two rules shape everything below.
//
//   1. NOTHING HERE THROWS. An audit that dies on the first unreadable
//      directory is worse than no audit: the user gets a stack trace instead of
//      the six installs that are fine and the one that is not. Every failure
//      becomes a problem in the report — including "this audit could not be
//      completed", which is a bad-manifest with the reason attached.
//   2. NOTHING HERE WRITES. Not the asset index (its validate() would happily
//      drop entries), not state.json, not the install. The only verb that
//      changes anything is repair(), and that one just queues the normal
//      install job — the pipeline that already knows about LAN seeding, delta
//      patching, snapshots and rollback keeps owning all of it.
//
// apk-adb installs are the one kind we cannot check: the bytes live on a
// headset, not on this disk. Their manifest is verified and the rest is
// skipped with a note rather than reported as damage.
//
// Pure node — no electron, no jobs at load time (repair requires it lazily, so
// jobs.js may keep requiring the modules this one uses).

const fsp = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const stateStore = require("./state");
const { readManifest, MANIFEST_NAME } = require("./install/util");
const assets = require("./fleet/assets");

/** Every problem kind this module can report (the UI's legend). */
const PROBLEM_KINDS = Object.freeze([
  "missing-dir",
  "bad-manifest",
  "missing-binary",
  "not-executable",
  "missing-file",
  "missing-desktop-entry",
  "hash-mismatch",
]);

/** Kinds whose payload lives on a device, not on this filesystem. */
const DEVICE_KINDS = Object.freeze(["apk-adb"]);

/* ------------------------------------------------------------------ */
/* small safe filesystem helpers                                       */
/* ------------------------------------------------------------------ */

/** lstat without the throw: {st} on success, {error} otherwise. */
async function statOf(target) {
  try {
    return { st: await fsp.stat(target), error: null };
  } catch (err) {
    return { st: null, error: err };
  }
}

/** "gone" vs "there but unreadable" — the message the user should see. */
function whyMissing(err) {
  if (!err) return "not found";
  if (err.code === "ENOENT") return "not found";
  if (err.code === "EACCES" || err.code === "EPERM") return "unreadable (permission denied)";
  return err.code ? `unreadable (${err.code})` : `unreadable (${err.message})`;
}

/**
 * Can anything execute this? Windows has no exec bit, so the question does not
 * apply there and the check is skipped rather than answered wrongly.
 */
function isExecutable(st, platform = process.platform) {
  if (platform === "win32") return true;
  return (st.mode & 0o111) !== 0;
}

/* ------------------------------------------------------------------ */
/* what we know about a file's sha256                                  */
/* ------------------------------------------------------------------ */

/**
 * The asset index, keyed by absolute path instead of by hash.
 *
 * Read-only on purpose: `validate()` would re-hash and DELETE entries it no
 * longer believes, which is exactly the mutation an audit must not perform.
 * A missing/corrupt index is simply an empty map — "we know no hashes".
 */
function hashesByPath(dataDir) {
  const out = new Map();
  try {
    const index = assets.createAssetIndex(dataDir || config.dataDir());
    for (const entry of index.all()) {
      if (!entry || !entry.path) continue;
      out.set(path.resolve(entry.path), { sha256: entry.sha256, size: entry.size || 0, source: "asset-index" });
    }
  } catch (_) {
    /* no index, no expectations — the hash check is skipped, not failed */
  }
  return out;
}

/**
 * A sha256 the install itself recorded, if any. Nothing writes these today;
 * the lookup exists so that the day an engine stamps the hash into its
 * manifest, the audit starts checking it without another release.
 */
function recordedHash(manifest, record) {
  const candidates = [
    manifest && manifest.sha256,
    manifest && manifest.extra && manifest.extra.sha256,
    record && record.extra && record.extra.sha256,
  ];
  for (const value of candidates) {
    const sha = assets.normalizeSha(value);
    if (sha) return sha;
  }
  return null;
}

/** The name of the original .AppImage an appimage install kept beside the tree. */
function keptAppImage(manifest) {
  if (!manifest) return null;
  const name = manifest.appImageFile || (manifest.extra && manifest.extra.appImageFile);
  return typeof name === "string" && name ? name : null;
}

/* ------------------------------------------------------------------ */
/* the audit                                                           */
/* ------------------------------------------------------------------ */

function problem(kind, target, detail) {
  const out = { kind, detail: detail || "" };
  if (target) out.path = target;
  return out;
}

/**
 * Audit one recorded install.
 *
 * The checks are ordered by how much they depend on each other: no directory
 * means no manifest, and no manifest means there is nothing to check the rest
 * AGAINST — so each of those stops the walk instead of burying the real
 * finding under a dozen consequences of it.
 */
async function auditInstall(rec, opts = {}) {
  const settings = opts.settings || null;
  const row = {
    appId: rec.appId,
    artifactId: rec.artifactId,
    ok: true,
    kind: null,
    version: rec.version != null ? String(rec.version) : null,
    path: rec.path || config.installPathFor(settings, rec.appId, rec.artifactId),
    // true for kinds whose payload lives on a headset, not on this disk
    deviceResident: false,
    problems: [],
    notes: [],
  };
  const add = (p) => {
    row.problems.push(p);
    row.ok = false;
  };

  try {
    // 1. the install directory
    const dir = await statOf(row.path);
    if (!dir.st || !dir.st.isDirectory()) {
      add(
        problem(
          "missing-dir",
          row.path,
          dir.st ? "not a directory" : whyMissing(dir.error)
        )
      );
      return row;
    }

    // 2. the manifest the engine wrote
    const manifest = await readManifest(row.path);
    if (!manifest || typeof manifest !== "object") {
      add(problem("bad-manifest", path.join(row.path, MANIFEST_NAME), "missing or not valid JSON"));
      return row;
    }
    row.kind = typeof manifest.kind === "string" ? manifest.kind : null;
    if (manifest.version != null) row.manifestVersion = String(manifest.version);

    // 3. device-resident kinds: the manifest is all we can honestly check
    if (row.kind && DEVICE_KINDS.includes(row.kind)) {
      // `deviceResident` so the UI and the CLI can badge these rows without
      // parsing prose — "ok" here means "nothing to check", not "verified".
      row.deviceResident = true;
      row.notes.push(`${row.kind}: installed on a device — files not checked here`);
      return row;
    }

    // 4. the launch target
    if (manifest.binary) {
      const binary = path.join(row.path, String(manifest.binary));
      const bin = await statOf(binary);
      if (!bin.st) add(problem("missing-binary", binary, whyMissing(bin.error)));
      else if (!isExecutable(bin.st, opts.platform || process.platform)) {
        add(problem("not-executable", binary, `mode ${(bin.st.mode & 0o777).toString(8)} — nothing can run it`));
      }
    }

    // 5. everything the install put OUTSIDE its own directory (this is what
    //    uninstall would remove, so it is what "installed" means off-tree)
    for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
      if (typeof file !== "string" || !file) continue;
      const st = await statOf(file);
      if (!st.st) add(problem("missing-file", file, whyMissing(st.error)));
    }

    // 6. menu entries
    for (const entry of Array.isArray(manifest.desktopEntries) ? manifest.desktopEntries : []) {
      if (typeof entry !== "string" || !entry) continue;
      const st = await statOf(entry);
      if (!st.st) add(problem("missing-desktop-entry", entry, whyMissing(st.error)));
    }

    // 7. appimage: the kept original, and its hash when anything knows it
    if (row.kind === "appimage") await auditKeptAppImage(row, manifest, rec, opts, add);
  } catch (err) {
    // Rule 1: an audit that cannot finish says so, in the report.
    add(problem("bad-manifest", row.path, `audit failed: ${(err && err.message) || String(err)}`));
  }

  return row;
}

/**
 * The AppImage an appimage install keeps beside its extracted tree.
 *
 * That file is the durable copy the LAN seeder serves to peers, so it is the
 * one place where the hub actually knows what the bytes SHOULD be. When
 * nothing knows the expected hash the check is skipped silently — a note, not
 * a problem: "we never learned it" is not damage.
 */
async function auditKeptAppImage(row, manifest, rec, opts, add) {
  const keptName = keptAppImage(manifest);
  if (!keptName) return;
  const kept = path.join(row.path, keptName);
  row.appImage = kept;

  const st = await statOf(kept);
  if (!st.st) {
    add(problem("missing-file", kept, `the kept AppImage is ${whyMissing(st.error)}`));
    return;
  }

  const byPath = opts.hashes instanceof Map ? opts.hashes : new Map();
  const known = byPath.get(path.resolve(kept)) || null;
  const stamped = recordedHash(manifest, rec);
  const expected = stamped || (known && known.sha256) || null;
  const source = stamped ? "recorded hash" : "asset index";
  if (!expected) {
    row.notes.push("no sha256 on record for the kept AppImage — hash not checked");
    return;
  }

  // A size that already disagrees settles it without reading 200 MB.
  if (!stamped && known && known.size > 0 && st.st.size !== known.size) {
    add(
      problem(
        "hash-mismatch",
        kept,
        `expected ${known.size} bytes, found ${st.st.size} — the file changed since it was installed`
      )
    );
    return;
  }

  let actual = null;
  try {
    actual = await assets.sha256File(kept); // streamed — never slurped
  } catch (err) {
    add(problem("missing-file", kept, `could not read the kept AppImage: ${whyMissing(err)}`));
    return;
  }
  if (actual !== expected) {
    add(
      problem(
        "hash-mismatch",
        kept,
        `expected ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}…`
      )
    );
    return;
  }
  row.sha256 = actual;
  row.notes.push(`sha256 verified against the ${source}`);
}

/**
 * SPEC v0.10: `audit(appId?)` — every recorded install, or one app's.
 *
 * @param {string|null} [appId]
 * @param {object} [opts]
 * @param {Array}  [opts.installs] override the state.json walk (tests)
 * @param {object} [opts.state]    a state object to read instead of the file
 * @param {object} [opts.settings] settings (for the install-root fallback)
 * @param {string} [opts.dataDir]  where asset-index.json lives
 * @returns {Promise<Array<{appId,artifactId,ok,kind,version,path,problems,notes}>>}
 */
async function audit(appId, opts = {}) {
  let installs = [];
  try {
    installs = opts.installs || stateStore.listInstalls(opts.state);
  } catch (_) {
    installs = []; // an unreadable state.json audits as "nothing installed"
  }
  const wanted = appId ? String(appId) : null;
  const rows = [];
  let settings = opts.settings || null;
  if (!settings) {
    try {
      settings = config.load();
    } catch (_) {
      settings = null;
    }
  }
  const hashes = opts.hashes instanceof Map ? opts.hashes : hashesByPath(opts.dataDir);

  for (const rec of installs) {
    if (!rec || (wanted && rec.appId !== wanted)) continue;
    // eslint-disable-next-line no-await-in-loop
    rows.push(await auditInstall(rec, { settings, hashes, platform: opts.platform }));
  }
  return rows;
}

/** {total, ok, broken, problems} over an audit's rows — the summary line. */
function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const broken = list.filter((r) => r && !r.ok);
  return {
    total: list.length,
    ok: list.length - broken.length,
    broken: broken.length,
    problems: broken.reduce((n, r) => n + (r.problems || []).length, 0),
  };
}

/**
 * SPEC v0.10: `repair(appId, artifactId)` — reinstall through the pipeline.
 *
 * There is deliberately no repair LOGIC here. Re-fetching an asset, seeding it
 * off a peer, applying a delta, keeping `.prev` for rollback and snapshotting
 * the config first are all things jobs.install already does correctly; a
 * second, subtly different copy of that inside an audit module is how the two
 * drift apart. So: queue the ordinary install job, hand back its id, let the
 * caller watch the same job-progress events every other install emits.
 *
 * @returns {string} the job id
 */
function repair(appId, artifactId, opts = {}) {
  if (!appId || !artifactId) throw new Error("repair needs an app and an artifact");
  // eslint-disable-next-line global-require
  const jobs = opts.jobs || require("./jobs");
  return jobs.install(String(appId), String(artifactId));
}

module.exports = {
  PROBLEM_KINDS,
  DEVICE_KINDS,
  audit,
  repair,
  summarize,
  // exported for tests and for anyone who wants one row without a state walk
  auditInstall,
  hashesByPath,
  keptAppImage,
  isExecutable,
};
