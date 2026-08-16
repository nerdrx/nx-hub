"use strict";
// NX Hub — fleet: LAN asset seeding (SPEC v0.7 "LAN asset seeding").
//
// Two hubs on the same LAN that watch the same repos download the same 200 MB
// AppImage twice, over the internet, for no reason. This module is the fix: a
// hub REMEMBERS the sha256 of every file it verified, and will hand that exact
// file to a paired peer over the fleet port on request.
//
// Three pieces live here:
//
//   the index      dataDir/asset-index.json, sha256 → {path, size, mtimeMs}.
//                  Written after every verified download and after an appimage
//                  install keeps its original. Entries are NOT trusted on
//                  serve — see validate().
//   the auth       GET /asset/<sha256>?auth=hmac(secret, sha256 + yyyymmddhh).
//                  The peer's pairing secret is the key, so only a hub that
//                  already passed the pairing dance can pull a file; the hour
//                  bucket keeps a captured URL from working tomorrow.
//   the fetch      the client half — stream, hash, verify, rename. Same
//                  integrity contract as a GitHub download: the file is only
//                  moved into place once its sha256 matches what was asked for.
//
// THREAT MODEL. The bytes are plaintext, like everything else on the fleet
// channel (SPEC v0.6). What matters is that a stranger cannot read arbitrary
// paths off the hub: the URL carries a HASH, never a path, and a hash is only
// servable if this hub itself put it in the index. There is no traversal to
// find, because there is no path in the request at all.
//
// Pure node: fs + http + crypto. No electron.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const config = require("../config");

const FILE = "asset-index.json";
/** How long findAsset waits for the fleet to answer (SPEC: 800ms). */
const FIND_TIMEOUT_MS = 800;
/** A LAN transfer that stalls this long is not worth waiting for. */
const FETCH_TIMEOUT_MS = 60000;

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function normalizeSha(value) {
  const hex = String(value == null ? "" : value).trim().toLowerCase();
  return isSha256(hex) ? hex : null;
}

function indexPath(dataDir) {
  return path.join(dataDir || config.dataDir(), FILE);
}

/* ------------------------------------------------------------------ */
/* the auth token                                                      */
/* ------------------------------------------------------------------ */

/**
 * The hour bucket a token is minted for: `yyyymmddhh`, in UTC.
 *
 * UTC and not local time on purpose — two hubs in different zones (a laptop
 * that travelled, a VM with a wrong TZ) would otherwise never agree, and the
 * only thing this value has to be is the SAME on both sides.
 */
function hourBucket(now = Date.now()) {
  const d = new Date(now);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
}

/** hmac-sha256(secret, sha256 + yyyymmddhh), hex. */
function assetAuth(secret, sha256, { now = Date.now(), bucket } = {}) {
  return crypto
    .createHmac("sha256", String(secret == null ? "" : secret))
    .update(`${String(sha256)}${bucket || hourBucket(now)}`)
    .digest("hex");
}

/**
 * Does `presented` authorise `sha256` under `secret`?
 *
 * The PREVIOUS hour is accepted too. Without it, a request that crosses the
 * top of the hour between minting and arriving fails for no reason a user
 * could ever diagnose; with it, the worst case is a token that stays valid for
 * two hours on a LAN the peer is already paired with. Constant-time, so a
 * wrong token leaks nothing about the right one.
 */
function verifyAssetAuth(secret, sha256, presented, { now = Date.now() } = {}) {
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/i.test(presented)) return false;
  const offered = Buffer.from(presented.toLowerCase(), "hex");
  let ok = false;
  for (const at of [now, now - 3600000]) {
    const want = Buffer.from(assetAuth(secret, sha256, { now: at }), "hex");
    if (want.length !== offered.length) continue;
    // No early exit: every bucket is always compared, so the timing does not
    // reveal WHICH one matched either.
    if (crypto.timingSafeEqual(want, offered)) ok = true;
  }
  return ok;
}

/**
 * Find the peer whose secret authorises this request, in constant time over
 * the whole peer list. Returns the peer or null.
 */
function authorizePeer(peers, sha256, presented, { now = Date.now() } = {}) {
  let found = null;
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || !peer.secret) continue;
    const hit = verifyAssetAuth(peer.secret, sha256, presented, { now });
    if (hit && !found) found = peer;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* the index                                                           */
/* ------------------------------------------------------------------ */

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch (_) {
    return null;
  }
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const file = typeof raw.path === "string" && raw.path.trim() ? raw.path : null;
  if (!file) return null;
  const size = Number(raw.size);
  const mtimeMs = Number(raw.mtimeMs);
  return {
    path: file,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mtimeMs: Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0,
    at: Number(raw.at) > 0 ? Number(raw.at) : null,
  };
}

function sanitizeIndex(raw) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const assets = data.assets && typeof data.assets === "object" && !Array.isArray(data.assets) ? data.assets : {};
  const out = {};
  for (const key of Object.keys(assets)) {
    const sha = normalizeSha(key);
    if (!sha) continue;
    const entry = sanitizeEntry(assets[key]);
    if (entry) out[sha] = entry;
  }
  return { assets: out };
}

/**
 * The asset index for one data dir.
 *
 * Re-read on every call, exactly like fleet.json and for the same reason: the
 * CLI and the GUI hub are separate processes writing the same file, and a
 * stale map is how you end up serving a file the other process just deleted.
 * Writes go through the same atomic tmp+rename.
 */
function createAssetIndex(dataDir) {
  const dir = dataDir || config.dataDir();
  const file = indexPath(dir);

  function read() {
    return sanitizeIndex(config.readJson(file, null));
  }

  function write(data) {
    config.ensureDir(dir);
    config.writeJsonAtomic(file, data);
    return data;
  }

  /** Every sha256 this hub believes it holds (unvalidated). */
  function all() {
    const data = read();
    return Object.keys(data.assets).map((sha) => Object.assign({ sha256: sha }, data.assets[sha]));
  }

  function get(sha256) {
    const sha = normalizeSha(sha256);
    if (!sha) return null;
    const entry = read().assets[sha];
    return entry ? Object.assign({ sha256: sha }, entry) : null;
  }

  /**
   * Remember that `file` hashes to `sha256`.
   *
   * A record for a file that is not there is refused rather than stored: an
   * index full of ghosts makes findAsset answer "yes" and then 404, which is
   * strictly worse for the requester than a plain "no".
   */
  function record(sha256, filePath) {
    const sha = normalizeSha(sha256);
    if (!sha || !filePath) return null;
    const st = statOf(filePath);
    if (!st) return null;
    const data = read();
    const entry = { path: path.resolve(filePath), size: st.size, mtimeMs: st.mtimeMs, at: Date.now() };
    const existing = data.assets[sha];
    if (existing && existing.path === entry.path && existing.size === entry.size && existing.mtimeMs === entry.mtimeMs) {
      return Object.assign({ sha256: sha }, existing); // nothing moved — no write
    }
    data.assets[sha] = entry;
    write(data);
    return Object.assign({ sha256: sha }, entry);
  }

  /** Hash `filePath` and record it. Used when the caller has no hash to hand. */
  async function recordFile(filePath) {
    if (!statOf(filePath)) return null;
    const sha = await sha256File(filePath);
    return record(sha, filePath);
  }

  function remove(sha256) {
    const sha = normalizeSha(sha256);
    if (!sha) return false;
    const data = read();
    if (!data.assets[sha]) return false;
    delete data.assets[sha];
    write(data);
    return true;
  }

  /**
   * Is this entry still true? (SPEC: "entries validated on serve".)
   *
   * Cheap path first: the file is there and its size AND mtime are what we
   * recorded, so the bytes we hashed are the bytes on disk. If either moved,
   * the file was rewritten under us and the only honest answer is to re-hash;
   * a mismatch drops the entry, because serving the wrong bytes under a hash
   * is the one failure this whole feature must never have.
   *
   * @returns {Promise<{sha256, path, size}|null>}
   */
  async function validate(sha256) {
    const entry = get(sha256);
    if (!entry) return null;
    const st = statOf(entry.path);
    if (!st) {
      remove(entry.sha256);
      return null;
    }
    if (st.size === entry.size && st.mtimeMs === entry.mtimeMs) return entry;
    let actual = null;
    try {
      actual = await sha256File(entry.path);
    } catch (_) {
      actual = null;
    }
    if (actual !== entry.sha256) {
      remove(entry.sha256);
      return null;
    }
    // Same bytes, new stat (a copy, a touch) — refresh so the next serve is cheap.
    return record(entry.sha256, entry.path);
  }

  /** Drop every entry whose file is gone. Returns how many went. */
  function prune() {
    const data = read();
    let dropped = 0;
    for (const sha of Object.keys(data.assets)) {
      if (!statOf(data.assets[sha].path)) {
        delete data.assets[sha];
        dropped += 1;
      }
    }
    if (dropped) write(data);
    return dropped;
  }

  return { dir, path: file, read, all, get, record, recordFile, remove, validate, prune };
}

/* ------------------------------------------------------------------ */
/* the client half                                                     */
/* ------------------------------------------------------------------ */

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* already gone */
  }
}

/** `http://host:port/asset/<sha>?auth=<token>` */
function assetUrl({ host, port, sha256, auth }) {
  const target = String(host || "").includes(":") ? `[${host}]` : String(host || "");
  return `http://${target}:${Number(port)}/asset/${sha256}?auth=${auth}`;
}

/**
 * Pull one asset from a peer and verify it.
 *
 * The download lands on `${destPath}.part` and is only renamed into place once
 * the running hash matches the sha256 that was ASKED for — so a peer that
 * lies about what it has, or a truncated transfer, cannot produce a file the
 * caller would then install. Every failure is a plain `false`/throw with the
 * part file removed, because the caller's fallback (GitHub) must be untouched.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.sha256
 * @param {string} o.secret      the pairing secret shared with that peer
 * @param {string} o.destPath
 * @param {function} [o.onProgress] ({pct, transferred, total, message})
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{path, sha256, size}>}
 */
function fetchAsset(o = {}) {
  const sha = normalizeSha(o.sha256);
  const destPath = String(o.destPath || "");
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : FETCH_TIMEOUT_MS;
  const onProgress = typeof o.onProgress === "function" ? o.onProgress : () => {};
  if (!sha) return Promise.reject(new Error("fleet: not a sha256"));
  if (!destPath) return Promise.reject(new Error("fleet: no destination"));

  const auth = assetAuth(o.secret, sha, { now: typeof o.now === "number" ? o.now : Date.now() });
  const url = assetUrl({ host: o.host, port: o.port, sha256: sha, auth });
  const partPath = `${destPath}.part`;

  return new Promise((resolve, reject) => {
    config.ensureDir(path.dirname(destPath));
    safeUnlink(partPath);

    let settled = false;
    let req = null;
    let out = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        if (req) req.destroy();
      } catch (_) {
        /* ignore */
      }
      try {
        if (out) out.destroy();
      } catch (_) {
        /* ignore */
      }
      safeUnlink(partPath);
      reject(err);
    };

    const onAbort = () => fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (o.signal) {
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener("abort", onAbort, { once: true });
    }

    req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`the peer answered ${res.statusCode} for ${sha.slice(0, 12)}…`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      const hash = crypto.createHash("sha256");
      let transferred = 0;
      let lastPct = -1;

      out = fs.createWriteStream(partPath);
      res.on("data", (chunk) => {
        hash.update(chunk);
        transferred += chunk.length;
        const pct = total > 0 ? Math.min(99, Math.floor((transferred / total) * 100)) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress({ pct, transferred, total, message: `${transferred} / ${total}` });
        }
      });
      res.on("error", (e) => fail(e));
      out.on("error", (e) => fail(e));
      res.pipe(out);
      out.on("close", () => {
        if (settled) return;
        const got = hash.digest("hex");
        // The hash is the whole contract. A peer that sends something else —
        // by accident or on purpose — gets nothing installed.
        if (got !== sha) {
          fail(new Error(`the peer sent ${got.slice(0, 12)}… when ${sha.slice(0, 12)}… was asked for`));
          return;
        }
        let size = transferred;
        try {
          size = fs.statSync(partPath).size;
        } catch (_) {
          /* keep the counted value */
        }
        if (total > 0 && size !== total) {
          fail(new Error(`truncated transfer (${size} of ${total} bytes)`));
          return;
        }
        settled = true;
        if (o.signal) o.signal.removeEventListener("abort", onAbort);
        try {
          safeUnlink(destPath);
          fs.renameSync(partPath, destPath);
        } catch (e) {
          safeUnlink(partPath);
          reject(e);
          return;
        }
        onProgress({ pct: 100, transferred: size, total: size, message: "done" });
        resolve({ path: destPath, sha256: got, size });
      });
    });
    req.on("timeout", () => fail(new Error("the peer stopped sending")));
    req.on("error", (e) => fail(e));
    return undefined;
  });
}

module.exports = {
  FILE,
  FIND_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  isSha256,
  normalizeSha,
  indexPath,
  hourBucket,
  assetAuth,
  verifyAssetAuth,
  authorizePeer,
  sanitizeIndex,
  createAssetIndex,
  sha256File,
  assetUrl,
  fetchAsset,
};
