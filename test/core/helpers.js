"use strict";
// Shared test harness: mock GitHub API server + temp dirs + fixtures.
// (Not a test file — exports helpers only.)

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

process.env.NX_HUB_QUIET = process.env.NX_HUB_QUIET || "1";
process.env.NX_HUB_NO_GH = "1"; // never shell out to `gh` in tests
process.env.NX_HUB_NO_LIVE_OVERLAY = process.env.NX_HUB_NO_LIVE_OVERLAY || "1";

function tempDir(prefix = "nxhub-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fresh NX_HUB_DATA_DIR + NX_HUB_INSTALL_ROOT for one test. */
function useTempEnv() {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const installRoot = path.join(root, "apps");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  process.env.NX_HUB_DATA_DIR = dataDir;
  process.env.NX_HUB_INSTALL_ROOT = installRoot;
  return {
    root,
    dataDir,
    installRoot,
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function etagOf(body) {
  return `"${crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
}

function repo(owner, name, extra = {}) {
  return Object.assign(
    {
      id: crypto.createHash("md5").update(`${owner}/${name}`).digest().readUInt32BE(0),
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      private: false,
      archived: false,
      description: `${name} description`,
    },
    extra
  );
}

let assetSeq = 1000;
function asset(base, ownerRepo, name, body) {
  assetSeq += 1;
  const id = assetSeq;
  return {
    id,
    name,
    size: body.length,
    url: `${base}/repos/${ownerRepo}/releases/assets/${id}`,
    browser_download_url: `${base}/download/${ownerRepo}/${name}`,
    _body: body,
  };
}

function release(tag, assets, extra = {}) {
  return Object.assign(
    {
      id: assetSeq,
      tag_name: tag,
      published_at: "2026-05-01T10:00:00Z",
      body: `Release notes for ${tag}`,
      prerelease: false,
      assets,
    },
    extra
  );
}

/** A tiny but real .zip so install engines / e2e have something to unpack. */
function makeZip(entries) {
  // minimal store-only zip writer
  const files = [];
  const chunks = [];
  let offset = 0;
  for (const [name, contentRaw] of Object.entries(entries)) {
    const content = Buffer.from(contentRaw);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(content) : crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, content);
    files.push({ nameBuf, crc, size: content.length, offset });
    offset += local.length + nameBuf.length + content.length;
  }
  const centralStart = offset;
  for (const f of files) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(f.crc >>> 0, 16);
    central.writeUInt32LE(f.size, 20);
    central.writeUInt32LE(f.size, 24);
    central.writeUInt16LE(f.nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(f.offset, 42);
    chunks.push(central, f.nameBuf);
    offset += central.length + f.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = buildCrcTable());
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ -1) >>> 0;
}
function buildCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

/**
 * Default fixture universe. `base` is the mock server URL.
 * owner "nerdrx": wivrn-nx, quadforge, banish-protocol, petri (hidden),
 *                 lonely-repo (no release), OscGoesBrrr-NX-Patches
 * owner "someone-else": cool-tool (used for extraRepos)
 */
function defaultData(base) {
  const serverTar = Buffer.from("fake tar.gz payload for wivrn server\n".repeat(50));
  const apk = Buffer.from("fake apk bytes\n".repeat(20));
  const qfZip = makeZip({ "quadforge/__init__.py": "# quadforge addon\n" });
  const linuxZip = makeZip({ "limbo/run.sh": "#!/bin/sh\necho limbo\n" });
  const winZip = makeZip({ "limbo.exe": "MZ" });

  const wivrnAssets = [
    asset(base, "nerdrx/wivrn-nx", "wivrn-nx-release-1.4.0.apk", apk),
    asset(base, "nerdrx/wivrn-nx", "wivrn-nx-server-1.4.0-linux-x86_64.tar.gz", serverTar),
  ];
  wivrnAssets.push(
    asset(
      base,
      "nerdrx/wivrn-nx",
      "wivrn-nx-server-1.4.0-linux-x86_64.tar.gz.sha256",
      Buffer.from(`${sha256(serverTar)}  wivrn-nx-server-1.4.0-linux-x86_64.tar.gz\n`)
    ),
    asset(base, "nerdrx/wivrn-nx", "latest-linux.yml", Buffer.from("version: 1.4.0\n"))
  );

  const repos = {
    nerdrx: [
      repo("nerdrx", "wivrn-nx", { description: "OpenXR streaming" }),
      repo("nerdrx", "quadforge", { description: "Retopology addon" }),
      repo("nerdrx", "banish-protocol", { description: "Co-op roguelite" }),
      repo("nerdrx", "petri", { description: "noise repo" }),
      repo("nerdrx", "lonely-repo", { description: "no releases here" }),
      repo("nerdrx", "OscGoesBrrr-NX-Patches", { description: "OGB fork", private: true }),
    ],
    "someone-else": [repo("someone-else", "cool-tool", { description: "third party tool" })],
  };

  const releases = {
    "nerdrx/wivrn-nx": release("v1.4.0", wivrnAssets),
    "nerdrx/quadforge": release("nx-1.3", [asset(base, "nerdrx/quadforge", "quadforge-1.3.zip", qfZip)]),
    "nerdrx/banish-protocol": release("2.0", [
      asset(base, "nerdrx/banish-protocol", "limbo-linux.zip", linuxZip),
      asset(base, "nerdrx/banish-protocol", "limbo-windows.zip", winZip),
    ]),
    "nerdrx/petri": release("v0.1", [asset(base, "nerdrx/petri", "petri-linux.zip", linuxZip)]),
    "nerdrx/OscGoesBrrr-NX-Patches": release("v3.1.0", [
      asset(base, "nerdrx/OscGoesBrrr-NX-Patches", "OGB-3.1.0-linux.AppImage", Buffer.from("AppImage bytes")),
      asset(base, "nerdrx/OscGoesBrrr-NX-Patches", "OGB-3.1.0-windows-portable.exe", Buffer.from("exe bytes")),
      asset(base, "nerdrx/OscGoesBrrr-NX-Patches", "OGB-3.1.0-windows-setup.exe", Buffer.from("setup bytes")),
    ]),
    "someone-else/cool-tool": release("v0.9", [
      asset(base, "someone-else/cool-tool", "cool-tool-linux.tar.gz", Buffer.from("tar bytes")),
    ]),
  };

  return { repos, releases, overlay: null };
}

/**
 * Mock GitHub API. Honours ETag / If-None-Match, pagination, the asset
 * download endpoint (Accept: application/octet-stream) and /raw/... overlays.
 */
function startMockGitHub(opts = {}) {
  const stats = { requests: [], conditional: 0, notModified: 0, downloads: 0 };
  let data = null;
  let base = null;
  const token = opts.token || null; // when set, /user works and private repos are listed
  const failWith = opts.failWith || null; // {path: status} forced failures
  let rateLimited = Boolean(opts.rateLimited);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
    const p = url.pathname;
    stats.requests.push(p + (url.search || ""));
    const auth = req.headers.authorization || null;
    const authed = Boolean(token && auth === `Bearer ${token}`);

    if (rateLimited) {
      res.writeHead(403, { "Content-Type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1780000000" });
      return res.end(JSON.stringify({ message: "API rate limit exceeded" }));
    }
    if (failWith && failWith[p]) {
      res.writeHead(failWith[p], { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "forced failure" }));
    }

    const json = (body, status = 200) => {
      const etag = etagOf(body);
      if (req.headers["if-none-match"]) {
        stats.conditional += 1;
        if (req.headers["if-none-match"] === etag) {
          stats.notModified += 1;
          res.writeHead(304, { ETag: etag });
          return res.end();
        }
      }
      res.writeHead(status, { "Content-Type": "application/json", ETag: etag });
      return res.end(JSON.stringify(body));
    };
    const notFound = () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
    };

    // GET /user
    if (p === "/user") {
      if (!authed) return notFound();
      return json({ login: "nerdrx", id: 1 });
    }

    // GET /user/repos (authenticated owner listing — includes private)
    if (p === "/user/repos") {
      if (!authed) return notFound();
      const page = Number(url.searchParams.get("page") || 1);
      return json(page === 1 ? data.repos.nerdrx : []);
    }

    // GET /users/:owner/repos
    let m = p.match(/^\/users\/([^/]+)\/repos$/);
    if (m) {
      const list = data.repos[m[1]];
      if (!list) return notFound();
      const page = Number(url.searchParams.get("page") || 1);
      const visible = list.filter((r) => !r.private);
      return json(page === 1 ? visible : []);
    }

    // GET /orgs/:owner/repos
    m = p.match(/^\/orgs\/([^/]+)\/repos$/);
    if (m) return notFound();

    // GET /repos/:owner/:repo/releases/latest
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/);
    if (m) {
      const rel = data.releases[`${m[1]}/${m[2]}`];
      if (!rel) return notFound();
      return json(rel);
    }

    // GET /repos/:owner/:repo/releases/assets/:id  (octet-stream download)
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/);
    if (m) {
      const id = Number(m[3]);
      let found = null;
      for (const rel of Object.values(data.releases)) {
        const a = rel.assets.find((x) => x.id === id);
        if (a) found = a;
      }
      if (!found) return notFound();
      stats.downloads += 1;
      stats.lastDownloadHeaders = req.headers;
      const body = found._body;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      return res.end(body);
    }

    // GET /repos/:owner/:repo
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (m) {
      const list = data.repos[m[1]] || [];
      const r = list.find((x) => x.name.toLowerCase() === m[2].toLowerCase());
      if (!r) return notFound();
      return json(r);
    }

    // GET /raw/:owner/:repo/:ref/<path>  (overlay)
    m = p.match(/^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      if (!data.overlay) return notFound();
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(JSON.stringify(data.overlay));
    }

    return notFound();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      data = (opts.makeData || defaultData)(base);
      if (opts.overlay) data.overlay = opts.overlay;
      resolve({
        base,
        data,
        stats,
        token,
        setRateLimited(v) {
          rateLimited = v;
        },
        assetNamed(fullName, name) {
          const rel = data.releases[fullName];
          return rel && rel.assets.find((a) => a.name === name);
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = {
  tempDir,
  useTempEnv,
  startMockGitHub,
  defaultData,
  makeZip,
  sha256,
  repo,
  asset,
  release,
};
