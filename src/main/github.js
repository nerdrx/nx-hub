"use strict";
// NX Hub — minimal GitHub REST client (plain fetch, no deps).
// Pure node: must be require-able without electron.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");

const config = require("./config");

const DEFAULT_API = "https://api.github.com";
const DEFAULT_RAW = "https://raw.githubusercontent.com";
const UA = "nx-hub";

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

function apiBase() {
  return stripSlash(process.env.NX_HUB_GITHUB_BASE || DEFAULT_API);
}

function rawBase() {
  if (process.env.NX_HUB_GITHUB_RAW_BASE) return stripSlash(process.env.NX_HUB_GITHUB_RAW_BASE);
  // When the API is redirected at a mock server, serve raw content from <base>/raw
  // so tests/e2e need only one origin.
  if (process.env.NX_HUB_GITHUB_BASE) return `${apiBase()}/raw`;
  return DEFAULT_RAW;
}

class HttpError extends Error {
  constructor(message, status, opts = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    Object.assign(this, opts);
  }
}

function friendlyRateLimit(res) {
  const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
  const resetAt = reset ? reset * 1000 : Date.now() + 60 * 60 * 1000;
  // locale-independent on purpose (host machines may run de_DE): ISO → "HH:MM UTC"
  const when = reset ? `${new Date(resetAt).toISOString().slice(11, 16)} UTC` : null;
  const msg = when
    ? `GitHub rate limit reached — try again after ${when}, or sign in (gh auth login) for a much higher limit.`
    : "GitHub rate limit reached — try again later, or sign in (gh auth login) for a much higher limit.";
  return new HttpError(msg, res.status, { rateLimited: true, resetAt });
}

function cacheKey(url) {
  return crypto.createHash("sha1").update(url).digest("hex");
}

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl]      API base (default env NX_HUB_GITHUB_BASE)
 * @param {string} [opts.rawBaseUrl]   raw.githubusercontent base
 * @param {string} [opts.cacheDir]     where ETag entries live (default dataDir/cache)
 * @param {function} [opts.getToken]   async () => token|null
 * @param {function} [opts.fetchImpl]  injectable fetch (tests)
 */
function createClient(opts = {}) {
  const base = stripSlash(opts.baseUrl || apiBase());
  const raw = stripSlash(opts.rawBaseUrl || rawBase());
  const cdir = opts.cacheDir || config.cacheDir();
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));
  const getToken = opts.getToken || (async () => null);

  let viewerCache; // undefined = unknown, null = anonymous/failed

  async function authHeaders(extra) {
    const h = Object.assign(
      {
        "User-Agent": UA,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      extra || {}
    );
    const token = await getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  function cacheFile(url) {
    return path.join(cdir, `${cacheKey(url)}.json`);
  }

  function readCache(url) {
    return config.readJson(cacheFile(url), null);
  }

  function writeCache(url, entry) {
    try {
      config.ensureDir(cdir);
      config.writeJsonAtomic(cacheFile(url), entry);
    } catch (_) {
      /* cache is best-effort */
    }
  }

  /**
   * Conditional GET returning parsed JSON. 304 → cached body.
   * @returns {Promise<{body:any, fromCache:boolean, status:number}>}
   */
  async function getJson(url, { force = false, signal } = {}) {
    const cached = readCache(url);
    const headers = await authHeaders();
    if (cached && cached.etag && !force) headers["If-None-Match"] = cached.etag;

    const res = await doFetch(url, { headers, signal, redirect: "follow" });

    if (res.status === 304 && cached) return { body: cached.body, fromCache: true, status: 304 };
    if (res.status === 404) throw new HttpError(`Not found: ${url}`, 404, { notFound: true });
    if (res.status === 401) throw new HttpError("GitHub rejected the token (401) — check `gh auth status` or clear the token in Settings.", 401);
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || res.status === 429) throw friendlyRateLimit(res);
      throw new HttpError(`GitHub refused the request (403) for ${url}`, 403);
    }
    if (!res.ok) throw new HttpError(`GitHub request failed (${res.status}) for ${url}`, res.status);

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new HttpError(`GitHub returned invalid JSON for ${url}`, res.status);
    }
    const etag = res.headers.get("etag");
    if (etag) writeCache(url, { etag, body, url, at: Date.now() });
    return { body, fromCache: false, status: res.status };
  }

  async function getViewer() {
    if (viewerCache !== undefined) return viewerCache;
    const token = await getToken();
    if (!token) {
      viewerCache = null;
      return viewerCache;
    }
    try {
      const { body } = await getJson(`${base}/user`, { force: true });
      viewerCache = body && body.login ? body : null;
    } catch (_) {
      viewerCache = null;
    }
    return viewerCache;
  }

  async function paginate(makeUrl, { force, signal } = {}) {
    const out = [];
    for (let page = 1; page <= 10; page += 1) {
      const url = makeUrl(page);
      const { body } = await getJson(url, { force, signal });
      if (!Array.isArray(body) || body.length === 0) break;
      out.push(...body);
      if (body.length < 100) break;
    }
    return out;
  }

  /** All repos owned by `owner`; private ones included when the token owns them. */
  async function listOwnerRepos(owner, { force = false, signal } = {}) {
    const viewer = await getViewer();
    const isSelf = viewer && String(viewer.login).toLowerCase() === String(owner).toLowerCase();
    const makeUrl = isSelf
      ? (page) => `${base}/user/repos?affiliation=owner&per_page=100&page=${page}&sort=full_name`
      : (page) => `${base}/users/${encodeURIComponent(owner)}/repos?type=owner&per_page=100&page=${page}&sort=full_name`;
    let repos;
    try {
      repos = await paginate(makeUrl, { force, signal });
    } catch (e) {
      if (e.status === 404) {
        // Might be an org, not a user.
        repos = await paginate(
          (page) => `${base}/orgs/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}`,
          { force, signal }
        );
      } else throw e;
    }
    return repos.filter((r) => r && !r.archived);
  }

  async function getRepo(owner, repo, { force = false, signal } = {}) {
    const { body } = await getJson(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { force, signal });
    return body;
  }

  /** Latest release for owner/repo, or null when the repo has none (404). */
  async function latestRelease(owner, repo, { force = false, signal } = {}) {
    const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
    try {
      const { body } = await getJson(url, { force, signal });
      return body || null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Every release of owner/repo, newest first as GitHub returns them.
   * Paginated (100/page) and ETag-cached through getJson; drafts are dropped
   * (they are invisible to anonymous clients anyway) and a repo without any
   * release resolves to [] instead of throwing.
   *
   * Accepts listReleases("owner/repo") as well as listReleases(owner, repo).
   */
  async function listReleases(owner, repo, opts = {}) {
    let o = owner;
    let r = repo;
    if (r && typeof r === "object") {
      opts = r;
      r = undefined;
    }
    if (!r && typeof o === "string" && o.includes("/")) {
      [o, r] = o.split("/");
    }
    if (!o || !r) throw new Error(`listReleases needs owner/repo (got ${owner}/${repo})`);
    const { force = false, signal } = opts;
    const makeUrl = (page) =>
      `${base}/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/releases?per_page=100&page=${page}`;
    try {
      const all = await paginate(makeUrl, { force, signal });
      return all.filter((rel) => rel && !rel.draft);
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  function assetApiUrl(asset) {
    if (asset && asset.url) return asset.url;
    if (asset && asset.repoFullName && asset.id) return `${base}/repos/${asset.repoFullName}/releases/assets/${asset.id}`;
    if (asset && asset.browser_download_url) return asset.browser_download_url;
    throw new Error(`Asset ${asset && asset.name} has no download URL`);
  }

  /** Fetch a (small) asset as text — used for sibling .sha256 files. */
  async function fetchAssetText(asset, { signal } = {}) {
    const headers = await authHeaders({ Accept: "application/octet-stream" });
    const res = await doFetch(assetApiUrl(asset), { headers, signal, redirect: "follow" });
    if (!res.ok) throw new HttpError(`Could not fetch ${asset.name} (${res.status})`, res.status);
    return res.text();
  }

  /**
   * Stream a release asset to destPath with progress + optional sha256 verification.
   * Uses the API asset endpoint with Accept: application/octet-stream so private
   * repos work with a token.
   *
   * @param {object} asset          release asset object (name, id, url, size)
   * @param {string} destPath
   * @param {object} [o]
   * @param {function} [o.onProgress] ({phase,pct,message,transferred,total}) => void
   * @param {AbortSignal} [o.signal]
   * @param {Array} [o.siblings]     other assets of the release (to find <name>.sha256)
   * @param {string} [o.expectedSha256]
   */
  async function downloadAsset(asset, destPath, o = {}) {
    const onProgress = typeof o.onProgress === "function" ? o.onProgress : () => {};
    const signal = o.signal;
    const headers = await authHeaders({ Accept: "application/octet-stream" });

    config.ensureDir(path.dirname(destPath));
    const partPath = `${destPath}.part`;

    // A stream that ends early without a network error would otherwise pass
    // straight to the extractor as a truncated file (seen in the field: S3
    // closing slow anonymous connections). So: verify the byte count against
    // the API's authoritative asset.size and retry truncations.
    const ATTEMPTS = 3;
    let sha256 = null;
    let transferred = 0;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const res = await doFetch(assetApiUrl(asset), { headers, signal, redirect: "follow" });
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        if (remaining === "0" || res.status === 429) throw friendlyRateLimit(res);
      }
      if (!res.ok) throw new HttpError(`Download failed for ${asset.name} (${res.status})`, res.status);

      const total = Number(res.headers.get("content-length") || asset.size || 0);
      const hash = crypto.createHash("sha256");
      transferred = 0;
      let lastPct = -1;

      const source = Readable.fromWeb ? Readable.fromWeb(res.body) : res.body;
      // The meter is a pipeline STAGE, not a bare "data" listener — a second
      // consumer on the source can race the write stream for chunks; a stage
      // guarantees hash/count describe exactly the bytes that reach the disk.
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          transferred += chunk.length;
          const pct = total > 0 ? Math.min(99, Math.floor((transferred / total) * 100)) : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress({
              phase: "download",
              pct,
              transferred,
              total,
              message: total ? `${fmtBytes(transferred)} / ${fmtBytes(total)}` : fmtBytes(transferred),
            });
          }
          cb(null, chunk);
        },
      });

      let streamErr = null;
      try {
        await pipeline(source, meter, fs.createWriteStream(partPath), { signal });
      } catch (e) {
        if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
          safeUnlink(partPath);
          throw e;
        }
        streamErr = e;
      }

      const expectedBytes = Number(asset.size || 0) || total;
      // Verify what actually reached the DISK, not just what streamed past the
      // progress listener — those can disagree if a consumer race drops chunks.
      let onDisk = -1;
      try {
        onDisk = fs.statSync(partPath).size;
      } catch (_) {
        /* missing part file counts as truncated below */
      }
      const truncated = expectedBytes > 0 && (transferred !== expectedBytes || onDisk !== expectedBytes);

      if (!streamErr && !truncated) {
        sha256 = hash.digest("hex");
        break;
      }

      safeUnlink(partPath);
      const why = streamErr
        ? streamErr.message
        : `got ${transferred} bytes (file: ${onDisk}) of ${expectedBytes}`;
      if (attempt === ATTEMPTS) {
        throw new Error(`Download of ${asset.name} failed after ${ATTEMPTS} attempts (${why})`);
      }
      config.log(`download attempt ${attempt}/${ATTEMPTS} for ${asset.name} failed (${why}) — retrying`);
      onProgress({ phase: "download", pct: 0, transferred: 0, total, message: `retrying (attempt ${attempt + 1})` });
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    onProgress({ phase: "download", pct: 100, transferred, total: transferred, message: "download complete" });

    let expected = o.expectedSha256 || null;
    if (!expected && Array.isArray(o.siblings)) {
      const sidecar = o.siblings.find((a) => a && a.name === `${asset.name}.sha256`);
      if (sidecar) {
        onProgress({ phase: "verify", pct: 0, message: "fetching checksum" });
        try {
          const text = await fetchAssetText(sidecar, { signal });
          const m = String(text).match(/\b[a-fA-F0-9]{64}\b/);
          if (m) expected = m[0].toLowerCase();
        } catch (e) {
          onProgress({ phase: "verify", pct: 100, message: `checksum unavailable (${e.message})` });
        }
      }
    }

    if (expected) {
      onProgress({ phase: "verify", pct: 50, message: "verifying sha256" });
      if (expected.toLowerCase() !== sha256) {
        safeUnlink(partPath);
        throw new Error(`Checksum mismatch for ${asset.name} — expected ${expected}, got ${sha256}`);
      }
      onProgress({ phase: "verify", pct: 100, message: "checksum ok" });
    }

    safeUnlink(destPath);
    fs.renameSync(partPath, destPath);
    return { path: destPath, sha256, size: transferred, verified: Boolean(expected) };
  }

  /** Raw file from a repo (used for the live overlay). Returns text or null. */
  async function fetchRaw(ownerRepo, ref, filePath, { signal } = {}) {
    const url = `${raw}/${ownerRepo}/${ref}/${filePath}`;
    const headers = await authHeaders({ Accept: "application/vnd.github.raw" });
    const res = await doFetch(url, { headers, signal, redirect: "follow" });
    if (!res.ok) return null;
    return res.text();
  }

  return {
    base,
    raw,
    getJson,
    getViewer,
    listOwnerRepos,
    getRepo,
    latestRelease,
    listReleases,
    downloadAsset,
    fetchAssetText,
    fetchRaw,
    assetApiUrl,
    cacheDir: cdir,
  };
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Module-level default client (main process). Tests use createClient() directly.
let singleton = null;

function init(deps = {}) {
  singleton = createClient(
    Object.assign(
      {
        getToken: () => config.resolveToken(),
        cacheDir: config.cacheDir(),
      },
      deps
    )
  );
  return singleton;
}

function client() {
  if (!singleton) init();
  return singleton;
}

module.exports = {
  createClient,
  init,
  client,
  HttpError,
  apiBase,
  rawBase,
  fmtBytes,
};
