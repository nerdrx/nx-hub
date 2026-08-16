"use strict";
// v0.7 [fleet-fabric]: LAN asset seeding.
//
// Three layers, bottom up:
//
//   1. the index and its auth   pure functions and a temp-dir json file
//   2. the wire                 two real hubs on 127.0.0.1: asset-query /
//                               asset-have, then the authed HTTP GET on the
//                               same ephemeral port the WS server listens on
//   3. the download path        jobs.install against a mock GitHub, with a
//                               real fleet running — the peer supplies the
//                               bytes and GitHub is never asked for them
//
// The last one is the point of the whole feature, and it is also where the
// safety property lives: a peer that LIES about what it has must cost nothing
// but a retry against GitHub.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const h = require("./helpers");
const core = require("../core/helpers");
const assets = require("../../src/main/fleet/assets");
const fleet = require("../../src/main/fleet");

test.after(async () => {
  await fleet.close();
  await h.stopAll();
  h.cleanupTempDirs();
});

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** A file with recognisable, incompressible-enough content. */
function writeFixture(dir, name, seed = "nx-seed") {
  const body = Buffer.concat(
    Array.from({ length: 64 }, (_, i) => crypto.createHash("sha512").update(`${seed}:${i}`).digest())
  );
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return { file, body, sha: sha256(body) };
}

/* ------------------------------------------------------------------ */
/* the auth token                                                      */
/* ------------------------------------------------------------------ */

const SHA = "a".repeat(64);
const SECRET = "b".repeat(64);

test("the hour bucket is UTC, so two hubs in different zones agree", () => {
  const at = Date.UTC(2026, 7, 16, 23, 59, 59);
  assert.strictEqual(assets.hourBucket(at), "2026081623");
  assert.strictEqual(assets.hourBucket(at + 1000), "2026081700", "it rolls with the hour, not the day");
  assert.strictEqual(assets.hourBucket(Date.UTC(2026, 0, 5, 4, 0, 0)), "2026010504", "zero padded");
});

test("assetAuth is hmac(secret, sha256 + bucket) and nothing else", () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const want = crypto.createHmac("sha256", SECRET).update(`${SHA}2026081612`).digest("hex");
  assert.strictEqual(assets.assetAuth(SECRET, SHA, { now }), want);
  // Change any input and the token changes.
  assert.notStrictEqual(assets.assetAuth(SECRET, "c".repeat(64), { now }), want);
  assert.notStrictEqual(assets.assetAuth("other", SHA, { now }), want);
  assert.notStrictEqual(assets.assetAuth(SECRET, SHA, { now: now + 3600000 }), want);
});

test("a token is good for this hour and the last one, never the next", () => {
  const now = Date.UTC(2026, 7, 16, 12, 30, 0);
  const token = assets.assetAuth(SECRET, SHA, { now });
  assert.strictEqual(assets.verifyAssetAuth(SECRET, SHA, token, { now }), true);
  // Minted just before the top of the hour, arriving just after — the reason
  // the previous bucket is accepted at all.
  assert.strictEqual(assets.verifyAssetAuth(SECRET, SHA, token, { now: now + 3600000 }), true);
  assert.strictEqual(assets.verifyAssetAuth(SECRET, SHA, token, { now: now + 2 * 3600000 }), false);
  assert.strictEqual(assets.verifyAssetAuth(SECRET, SHA, token, { now: now - 3600000 }), false, "a token from the future");
});

test("a wrong secret, a wrong hash and junk are all simply false", () => {
  const now = Date.UTC(2026, 7, 16, 12, 30, 0);
  const token = assets.assetAuth(SECRET, SHA, { now });
  assert.strictEqual(assets.verifyAssetAuth("nope", SHA, token, { now }), false);
  assert.strictEqual(assets.verifyAssetAuth(SECRET, "c".repeat(64), token, { now }), false);
  for (const junk of ["", null, undefined, "zz", "0".repeat(63), "0".repeat(65), 12345, {}]) {
    assert.strictEqual(assets.verifyAssetAuth(SECRET, SHA, junk, { now }), false, `${junk}`);
  }
});

test("authorizePeer finds the one peer whose secret matches", () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const peers = [
    { id: "1111111111111111", name: "one", secret: "1".repeat(64) },
    { id: "2222222222222222", name: "two", secret: SECRET },
    { id: "3333333333333333", name: "three", secret: null },
  ];
  const token = assets.assetAuth(SECRET, SHA, { now });
  const peer = assets.authorizePeer(peers, SHA, token, { now });
  assert.strictEqual(peer && peer.name, "two");
  assert.strictEqual(assets.authorizePeer(peers, SHA, "0".repeat(64), { now }), null);
  assert.strictEqual(assets.authorizePeer([], SHA, token, { now }), null);
});

/* ------------------------------------------------------------------ */
/* the index                                                           */
/* ------------------------------------------------------------------ */

test("the index records, reads back and forgets", () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const fx = writeFixture(dir, "one.bin");

  assert.strictEqual(index.get(fx.sha), null, "empty to start with");
  const entry = index.record(fx.sha, fx.file);
  assert.strictEqual(entry.sha256, fx.sha);
  assert.strictEqual(entry.size, fx.body.length);

  const back = index.get(fx.sha);
  assert.strictEqual(back.path, fx.file);
  assert.strictEqual(back.size, fx.body.length);
  assert.deepStrictEqual(index.all().map((a) => a.sha256), [fx.sha]);

  assert.strictEqual(index.remove(fx.sha), true);
  assert.strictEqual(index.remove(fx.sha), false);
  assert.strictEqual(index.get(fx.sha), null);
});

test("the index refuses a hash it cannot back with a file", () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  assert.strictEqual(index.record(SHA, path.join(dir, "not-there.bin")), null);
  assert.strictEqual(index.record("not-a-sha", path.join(dir, "x")), null);
  assert.strictEqual(index.record(SHA, null), null);
  assert.deepStrictEqual(index.all(), [], "an index full of ghosts is worse than an empty one");
});

test("recordFile hashes what it is given", async () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const fx = writeFixture(dir, "two.bin", "hash-me");
  const entry = await index.recordFile(fx.file);
  assert.strictEqual(entry.sha256, fx.sha);
  assert.strictEqual(await index.recordFile(path.join(dir, "gone.bin")), null);
});

test("a corrupt index file degrades to an empty, usable one", () => {
  const dir = h.tempDataDir();
  fs.writeFileSync(assets.indexPath(dir), "{ this is not json");
  const index = assets.createAssetIndex(dir);
  assert.deepStrictEqual(index.all(), []);
  const fx = writeFixture(dir, "three.bin");
  assert.ok(index.record(fx.sha, fx.file), "and it writes over the wreckage");
});

test("junk entries are dropped on load, good ones survive", () => {
  const dir = h.tempDataDir();
  const fx = writeFixture(dir, "four.bin");
  fs.writeFileSync(
    assets.indexPath(dir),
    JSON.stringify({
      assets: {
        [fx.sha]: { path: fx.file, size: fx.body.length, mtimeMs: 1 },
        "not-a-hash": { path: fx.file },
        [SHA]: { nothing: true },
        [SECRET]: null,
      },
    })
  );
  const index = assets.createAssetIndex(dir);
  assert.deepStrictEqual(index.all().map((a) => a.sha256), [fx.sha]);
});

test("validate drops an entry whose file is gone", async () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const fx = writeFixture(dir, "five.bin");
  index.record(fx.sha, fx.file);
  fs.unlinkSync(fx.file);

  assert.strictEqual(await index.validate(fx.sha), null);
  assert.strictEqual(index.get(fx.sha), null, "and it is not offered again");
});

test("validate re-hashes a file that moved under us, and drops a mismatch", async () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const fx = writeFixture(dir, "six.bin");
  index.record(fx.sha, fx.file);

  // Same path, different bytes — exactly what a partially rewritten download
  // or a reinstalled AppImage looks like.
  fs.writeFileSync(fx.file, Buffer.concat([fx.body, Buffer.from("tampered")]));
  assert.strictEqual(await index.validate(fx.sha), null, "the bytes no longer hash to what was promised");
  assert.strictEqual(index.get(fx.sha), null);
});

test("validate keeps an entry whose bytes are unchanged but whose stat moved", async () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const fx = writeFixture(dir, "seven.bin");
  index.record(fx.sha, fx.file);
  // A touch: identical content, new mtime.
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(fx.file, later, later);

  const entry = await index.validate(fx.sha);
  assert.ok(entry, "the same bytes are still the same bytes");
  assert.strictEqual(entry.sha256, fx.sha);
  // And the refreshed stat means the next serve takes the cheap path.
  assert.strictEqual(index.get(fx.sha).mtimeMs, fs.statSync(fx.file).mtimeMs);
});

test("prune clears out everything that vanished", () => {
  const dir = h.tempDataDir();
  const index = assets.createAssetIndex(dir);
  const a = writeFixture(dir, "a.bin", "a");
  const b = writeFixture(dir, "b.bin", "b");
  index.record(a.sha, a.file);
  index.record(b.sha, b.file);
  fs.unlinkSync(a.file);
  assert.strictEqual(index.prune(), 1);
  assert.deepStrictEqual(index.all().map((x) => x.sha256), [b.sha]);
});

/* ------------------------------------------------------------------ */
/* the HTTP route                                                      */
/* ------------------------------------------------------------------ */

/** GET a URL and collect the body as a Buffer. */
function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      })
      .on("error", reject);
  });
}

function assetUrlFor(hub, sha, secret, { now } = {}) {
  return assets.assetUrl({
    host: "127.0.0.1",
    port: hub.server.port,
    sha256: sha,
    auth: assets.assetAuth(secret, sha, { now: now || Date.now() }),
  });
}

/** Hub A holding one file, paired with B. Returns the shared secret too. */
async function seeder({ seed = "wire" } = {}) {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);
  const fx = writeFixture(path.join(a.dataDir, "downloads"), "App.AppImage", seed);
  a.assetIndex().record(fx.sha, fx.file);
  // B's copy of the shared secret is what a request has to be signed with.
  const secret = b.store.getPeer(a.localId).secret;
  return { a, b, fx, secret };
}

test("an authed GET streams the exact bytes", async () => {
  const { a, fx, secret } = await seeder();
  const res = await get(assetUrlFor(a, fx.sha, secret));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"], "application/octet-stream");
  assert.strictEqual(Number(res.headers["content-length"]), fx.body.length);
  assert.deepStrictEqual(res.body, fx.body);
  assert.strictEqual(sha256(res.body), fx.sha, "byte for byte");
});

test("no auth, a wrong secret and a stale token are all 403", async () => {
  const { a, fx, secret } = await seeder({ seed: "auth" });
  const bare = `http://127.0.0.1:${a.server.port}/asset/${fx.sha}`;
  assert.strictEqual((await get(bare)).status, 403, "no token at all");
  assert.strictEqual((await get(`${bare}?auth=`)).status, 403, "an empty token");
  assert.strictEqual((await get(`${bare}?auth=${"0".repeat(64)}`)).status, 403, "a made-up token");
  assert.strictEqual((await get(`${bare}?auth=nonsense`)).status, 403, "junk");

  const stale = assets.assetAuth(secret, fx.sha, { now: Date.now() - 5 * 3600000 });
  assert.strictEqual((await get(`${bare}?auth=${stale}`)).status, 403, "yesterday's token");

  const stranger = assets.assetAuth("c".repeat(64), fx.sha, {});
  assert.strictEqual((await get(`${bare}?auth=${stranger}`)).status, 403, "somebody else's secret");
});

test("a token is bound to ONE hash — it does not unlock the index", async () => {
  const { a, fx, secret } = await seeder({ seed: "bound" });
  const other = writeFixture(path.join(a.dataDir, "downloads"), "Other.AppImage", "other");
  a.assetIndex().record(other.sha, other.file);

  const token = assets.assetAuth(secret, fx.sha, {});
  const res = await get(`http://127.0.0.1:${a.server.port}/asset/${other.sha}?auth=${token}`);
  assert.strictEqual(res.status, 403, "the token names the file it is for");
});

test("a hash this hub does not hold is 404 — after the auth check, never before", async () => {
  const { a, secret } = await seeder({ seed: "unknown" });
  const unknown = sha256(Buffer.from("nothing here"));
  const res = await get(assetUrlFor(a, unknown, secret));
  assert.strictEqual(res.status, 404);
});

test("an entry whose file vanished is 404 and is forgotten", async () => {
  const { a, fx, secret } = await seeder({ seed: "vanish" });
  fs.unlinkSync(fx.file);
  const res = await get(assetUrlFor(a, fx.sha, secret));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(a.assetIndex().get(fx.sha), null, "and the stale entry is gone");
});

test("an entry whose bytes changed under us is 404, not a wrong file", async () => {
  const { a, fx, secret } = await seeder({ seed: "swap" });
  fs.writeFileSync(fx.file, Buffer.from("completely different content"));
  const res = await get(assetUrlFor(a, fx.sha, secret));
  assert.strictEqual(res.status, 404, "serving the wrong bytes under a hash is the one unforgivable bug");
  assert.strictEqual(a.assetIndex().get(fx.sha), null);
});

test("the fleet port still refuses everything else it always refused", async () => {
  const { a } = await seeder({ seed: "426" });
  const base = `http://127.0.0.1:${a.server.port}`;
  assert.strictEqual((await get(`${base}/`)).status, 426, "the websocket brush-off survives");
  assert.strictEqual((await get(`${base}/asset/`)).status, 426);
  assert.strictEqual((await get(`${base}/asset/tooshort`)).status, 426);
  assert.strictEqual((await get(`${base}/asset/../../etc/passwd`)).status, 426, "there is no path to traverse");
  assert.strictEqual((await get(`${base}/anything`)).status, 426);
});

/* ------------------------------------------------------------------ */
/* asset-query / asset-have / fetchAsset                               */
/* ------------------------------------------------------------------ */

test("findAsset turns up the peer that has the file", async () => {
  const { a, b, fx } = await seeder({ seed: "find" });
  const found = await b.findAsset(fx.sha);
  assert.ok(found, "B's neighbour has it");
  assert.strictEqual(found.peerId, a.localId);
  assert.strictEqual(found.size, fx.body.length);
  assert.ok(!("secret" in found), "and the answer carries no secret for a caller to leak");
});

test("findAsset gives up quickly when nobody has it", async () => {
  const { b } = await seeder({ seed: "nobody" });
  const started = Date.now();
  const found = await b.findAsset(sha256(Buffer.from("not on this LAN")));
  assert.strictEqual(found, null);
  assert.ok(
    Date.now() - started < 700,
    "a fleet that all said no must not burn the whole 800ms budget before every download"
  );
});

test("findAsset with no sessions, and with a nonsense hash, is null", async () => {
  const lonely = await h.startFleet();
  assert.strictEqual(await lonely.findAsset(SHA), null);
  const { b } = await seeder({ seed: "junk-hash" });
  assert.strictEqual(await b.findAsset("not-a-hash"), null);
  assert.strictEqual(await b.findAsset(null), null);
});

test("fetchAsset pulls the file across and verifies it", async () => {
  const { a, b, fx } = await seeder({ seed: "fetch" });
  const dest = path.join(b.dataDir, "downloads", "Fetched.AppImage");
  const progress = [];
  const result = await b.fetchAsset(fx.sha, dest, { onProgress: (p) => progress.push(p) });

  assert.strictEqual(result.sha256, fx.sha);
  assert.strictEqual(result.size, fx.body.length);
  assert.strictEqual(result.peerId, a.localId);
  assert.deepStrictEqual(fs.readFileSync(dest), fx.body);
  assert.ok(progress.length, "and it reported progress on the way");
  assert.ok(!fs.existsSync(`${dest}.part`), "the part file is cleaned up");
});

test("fetchAsset refuses bytes that do not hash to what was asked for", async () => {
  const { a, b, fx } = await seeder({ seed: "liar" });
  // A now claims a hash for a file whose content is something else entirely —
  // a corrupt index, a swapped file, or a peer being dishonest on purpose.
  const lie = writeFixture(path.join(a.dataDir, "downloads"), "Lie.AppImage", "lie");
  const index = a.assetIndex();
  index.record(lie.sha, lie.file);
  // Rewrite the entry so the recorded stat still matches but the hash is a
  // stranger's — validate()'s cheap path passes, so the check that matters is
  // the CLIENT's.
  const raw = JSON.parse(fs.readFileSync(assets.indexPath(a.dataDir), "utf8"));
  raw.assets[fx.sha] = raw.assets[lie.sha];
  fs.writeFileSync(assets.indexPath(a.dataDir), JSON.stringify(raw));

  const dest = path.join(b.dataDir, "downloads", "Lied.AppImage");
  await assert.rejects(() => b.fetchAsset(fx.sha, dest), /when .* was asked for/);
  assert.ok(!fs.existsSync(dest), "nothing is left for an install to pick up");
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test("fetchAsset on a hash nobody has rejects rather than hanging", async () => {
  const { b } = await seeder({ seed: "missing" });
  const dest = path.join(b.dataDir, "downloads", "Nope.AppImage");
  await assert.rejects(() => b.fetchAsset(sha256(Buffer.from("nowhere")), dest), /no peer has that file/);
  assert.ok(!fs.existsSync(dest));
});

test("a hub with the fleet off answers the seeding surface without throwing", async () => {
  await fleet.close();
  assert.strictEqual(fleet.isRunning(), false);
  assert.strictEqual(fleet.hasOnlinePeers(), false);
  assert.strictEqual(await fleet.wake("0123456789abcdef"), false);
  assert.strictEqual(await fleet.findAsset(SHA), null);
  assert.strictEqual(await fleet.probePeerPort("0123456789abcdef", 80), false);
  await assert.rejects(() => fleet.fetchAsset(SHA, "/tmp/nope"), /switched off/);
});

/* ------------------------------------------------------------------ */
/* the download path — jobs.install with a real fleet                  */
/* ------------------------------------------------------------------ */

const OWNER_REPO = "nerdrx/seedapp";
const APP_ID = "seedapp";
const ARTIFACT_ID = "appimage-linux";
const ASSET_NAME = "SeedApp-1.0.0-linux.AppImage";

/**
 * A whole hub's worth of scaffolding for one install: temp env, mock GitHub
 * serving the asset AND its .sha256 sidecar, a jobs runtime whose engine just
 * records what it was handed, and a real fleet paired with a peer that already
 * has the bytes.
 */
async function installRig({ peerHas = true, peerLies = false } = {}) {
  // eslint-disable-next-line global-require
  const github = require("../../src/main/github");
  // eslint-disable-next-line global-require
  const discovery = require("../../src/main/discovery");
  // eslint-disable-next-line global-require
  const jobs = require("../../src/main/jobs");
  // eslint-disable-next-line global-require
  const config = require("../../src/main/config");

  const env = core.useTempEnv();
  const body = Buffer.concat(
    Array.from({ length: 48 }, (_, i) => crypto.createHash("sha512").update(`seedapp:${i}`).digest())
  );
  const digest = sha256(body);

  const mock = await core.startMockGitHub({
    makeData: (base) => ({
      repos: { nerdrx: [core.repo("nerdrx", "seedapp", { description: "seeding test app" })] },
      releases: {
        [OWNER_REPO]: core.release("v1.0.0", [
          core.asset(base, OWNER_REPO, ASSET_NAME, body),
          core.asset(base, OWNER_REPO, `${ASSET_NAME}.sha256`, Buffer.from(`${digest}  ${ASSET_NAME}\n`)),
        ]),
      },
      overlay: null,
    }),
  });

  const release = mock.data.releases[OWNER_REPO];
  const app = {
    id: APP_ID,
    repo: OWNER_REPO,
    name: "SeedApp",
    latest: { tag: "v1.0.0", version: "1.0.0", publishedAt: null, notes: "", prerelease: false },
    artifacts: discovery.buildArtifacts(release, {}),
  };

  // The hub that HAS the file, and the local fleet paired with it.
  const peer = await h.startFleet();
  const local = fleet.init({
    dataDir: env.dataDir,
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    hubVersion: "9.9.9",
    discovery: h.fakeDiscovery([]),
    dialIntervalMs: 25,
    summaryIntervalMs: 25,
    dialTimeoutMs: 4000,
    log: () => {},
    emit: () => {},
  });
  await local.ready;
  await h.pairHubs(local, peer);
  await h.waitForSession(local, peer.store.load().id);
  await h.waitForSession(peer, local.store.load().id);

  if (peerHas) {
    const served = peerLies ? Buffer.from("these are not the bytes you are looking for") : body;
    const file = path.join(peer.dataDir, "downloads", ASSET_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, served);
    // record() hashes nothing — it stores what it is told, which is exactly
    // how a "lying" peer comes about in the field (a corrupt index).
    peer.assetIndex().record(digest, file);
  }

  const events = [];
  const listeners = [];
  const emit = (evt) => {
    events.push(evt);
    for (const l of [...listeners]) l(evt);
  };
  const got = {};
  jobs._reset();
  jobs.init({
    emit,
    github: github.createClient({
      baseUrl: mock.base,
      cacheDir: path.join(env.dataDir, "cache"),
      getToken: async () => null,
    }),
    relaunch: null,
    engineLoader: null,
    engine: {
      async install({ artifact, filePath, ctx }) {
        got.bytes = fs.readFileSync(filePath);
        const dest = path.join(ctx.installRoot, "nx", APP_ID, artifact.id);
        fs.mkdirSync(dest, { recursive: true });
        // What the appimage engine does: keep the original next to the tree.
        fs.copyFileSync(filePath, path.join(dest, ASSET_NAME));
        fs.writeFileSync(
          path.join(dest, ".nx-manifest.json"),
          JSON.stringify({ version: artifact.version, kind: "appimage", binary: "AppRun", appImageFile: ASSET_NAME })
        );
        return { version: artifact.version, path: dest, launchable: true };
      },
    },
    resolve: (appId, artifactId) => ({
      app,
      artifact: app.artifacts.find((a) => a.id === artifactId) || null,
    }),
  });

  return {
    env,
    mock,
    app,
    body,
    digest,
    peer,
    local,
    got,
    events,
    config,
    /** Was the big asset actually pulled from "GitHub"? */
    assetFetched() {
      const a = mock.assetNamed(OWNER_REPO, ASSET_NAME);
      return mock.stats.requests.some((r) => r.endsWith(`/releases/assets/${a.id}`));
    },
    messages() {
      return events.filter((e) => e.type === "job-progress").map((e) => e.message || "");
    },
    run() {
      const jobId = jobs.install(APP_ID, ARTIFACT_ID);
      return new Promise((resolve) => {
        const l = (evt) => {
          if ((evt.type === "job-done" || evt.type === "job-error") && evt.jobId === jobId) {
            listeners.splice(listeners.indexOf(l), 1);
            resolve(evt);
          }
        };
        listeners.push(l);
      });
    },
    async cleanup() {
      await fleet.close();
      jobs._reset();
      await mock.close();
      env.cleanup();
    },
  };
}

test("an install takes the asset off the LAN instead of GitHub", async () => {
  const rig = await installRig();
  try {
    const done = await rig.run();
    assert.strictEqual(done.type, "job-done", done.message || "");
    assert.deepStrictEqual(rig.got.bytes, rig.body, "the engine got exactly the released bytes");
    assert.strictEqual(rig.assetFetched(), false, "GitHub was never asked for the big file");

    const messages = rig.messages();
    assert.ok(
      messages.some((m) => /fetching from .+ \(LAN\)/.test(m)),
      `SPEC: the phase says where it came from — got ${JSON.stringify(messages)}`
    );
    assert.ok(messages.some((m) => /checksum ok/.test(m)));
  } finally {
    await rig.cleanup();
  }
});

test("a peer that lies about its bytes costs one retry and nothing else", async () => {
  const rig = await installRig({ peerLies: true });
  try {
    const done = await rig.run();
    assert.strictEqual(done.type, "job-done", done.message || "");
    // The install still succeeded — with the REAL asset, off GitHub.
    assert.deepStrictEqual(rig.got.bytes, rig.body);
    assert.strictEqual(rig.assetFetched(), true, "the fallback is the ordinary download");
    assert.ok(
      rig.messages().some((m) => /downloading SeedApp/.test(m)),
      "and the user sees the normal download phase after the LAN attempt"
    );
  } finally {
    await rig.cleanup();
  }
});

test("with no peer holding it, the download path is exactly what it always was", async () => {
  const rig = await installRig({ peerHas: false });
  try {
    const done = await rig.run();
    assert.strictEqual(done.type, "job-done", done.message || "");
    assert.deepStrictEqual(rig.got.bytes, rig.body);
    assert.strictEqual(rig.assetFetched(), true);
    assert.ok(!rig.messages().some((m) => /\(LAN\)/.test(m)), "and nothing pretends otherwise");
  } finally {
    await rig.cleanup();
  }
});

test("lanSeeding: false skips the LAN entirely", async () => {
  const rig = await installRig();
  try {
    rig.config.save({ lanSeeding: false });
    const done = await rig.run();
    assert.strictEqual(done.type, "job-done", done.message || "");
    assert.strictEqual(rig.assetFetched(), true, "the setting is honoured");
    assert.ok(!rig.messages().some((m) => /\(LAN\)/.test(m)));
  } finally {
    rig.config.save({ lanSeeding: true });
    await rig.cleanup();
  }
});

test("a verified download is indexed — downloads/ AND the kept AppImage", async () => {
  const rig = await installRig({ peerHas: false });
  try {
    const done = await rig.run();
    assert.strictEqual(done.type, "job-done", done.message || "");

    const index = assets.createAssetIndex(rig.env.dataDir);
    const entry = index.get(rig.digest);
    assert.ok(entry, "this hub now offers what it just verified");
    // downloads/ is cleaned up at the end of a job, so the entry has to have
    // moved on to the copy that outlives it.
    assert.ok(
      entry.path.includes(path.join("nx", APP_ID)),
      `the kept AppImage is the durable seed — got ${entry.path}`
    );
    assert.strictEqual(sha256(fs.readFileSync(entry.path)), rig.digest);
  } finally {
    await rig.cleanup();
  }
});
