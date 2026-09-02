"use strict";
// github.js — ETag cache, pagination, 404 handling, verified downloads, rate limit.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const github = require("../../src/main/github");

function clientFor(mock, env, token = null) {
  return github.createClient({
    baseUrl: mock.base,
    rawBaseUrl: `${mock.base}/raw`,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => token,
  });
}

test("listOwnerRepos returns public repos anonymously", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  const repos = await gh.listOwnerRepos("nerdrx");
  const names = repos.map((r) => r.name);
  assert.ok(names.includes("wivrn-nx"));
  assert.ok(!names.includes("OscGoesBrrr-NX-Patches"), "private repo hidden when anonymous");
});

test("listOwnerRepos includes private repos when the token owns them", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ token: "tok" });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env, "tok");
  const repos = await gh.listOwnerRepos("nerdrx");
  assert.ok(repos.some((r) => r.private), "private repo present");
  assert.ok(mock.stats.requests.some((r) => r.startsWith("/user/repos")), "authenticated listing endpoint used");
});

test("latestRelease returns null for a repo without releases", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  assert.strictEqual(await gh.latestRelease("nerdrx", "lonely-repo"), null);
  const rel = await gh.latestRelease("nerdrx", "wivrn-nx");
  assert.strictEqual(rel.tag_name, "v1.4.0");
});

test("ETag cache: a repeat request is conditional and served from cache on 304", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);

  const first = await gh.getJson(`${mock.base}/repos/nerdrx/wivrn-nx/releases/latest`);
  assert.strictEqual(first.fromCache, false);
  assert.strictEqual(mock.stats.notModified, 0);

  const cacheFiles = fs.readdirSync(path.join(env.dataDir, "cache"));
  assert.ok(cacheFiles.length >= 1, "etag entry persisted under dataDir/cache");

  const second = await gh.getJson(`${mock.base}/repos/nerdrx/wivrn-nx/releases/latest`);
  assert.strictEqual(second.fromCache, true, "304 served from cache");
  assert.strictEqual(mock.stats.notModified, 1);
  assert.deepStrictEqual(second.body.tag_name, first.body.tag_name);

  // force bypasses the conditional request entirely
  const conditionalsBefore = mock.stats.conditional;
  const forced = await gh.getJson(`${mock.base}/repos/nerdrx/wivrn-nx/releases/latest`, { force: true });
  assert.strictEqual(forced.fromCache, false);
  assert.strictEqual(mock.stats.conditional, conditionalsBefore, "no If-None-Match sent when forced");
});

test("downloadAsset streams with progress, uses the API asset endpoint and verifies the sha256 sidecar", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ token: "tok" });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env, "tok");

  const rel = mock.data.releases["nerdrx/wivrn-nx"];
  const target = rel.assets.find((a) => a.name.endsWith("linux-x86_64.tar.gz"));
  const dest = path.join(env.root, "download", target.name);

  const events = [];
  const result = await gh.downloadAsset(target, dest, {
    siblings: rel.assets,
    onProgress: (p) => events.push(p),
  });

  assert.ok(fs.existsSync(dest), "file written");
  assert.strictEqual(fs.readFileSync(dest).length, target._body.length);
  assert.strictEqual(result.sha256, helpers.sha256(target._body));
  assert.strictEqual(result.verified, true, "sidecar checksum was applied");
  assert.ok(!fs.existsSync(`${dest}.part`), "partial file cleaned up");

  const phases = [...new Set(events.map((e) => e.phase))];
  assert.ok(phases.includes("download"));
  assert.ok(phases.includes("verify"));
  assert.ok(
    events.some((e) => e.phase === "download" && e.pct === 100),
    "download reaches 100%"
  );

  const headers = mock.stats.lastDownloadHeaders;
  assert.strictEqual(headers.accept, "application/octet-stream");
  assert.strictEqual(headers.authorization, "Bearer tok", "token sent so private repos work");
});

test("downloadAsset retries a silently truncated download and fails hard when it keeps truncating", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  const rel = mock.data.releases["nerdrx/wivrn-nx"];
  const target = rel.assets.find((a) => a.name.endsWith("linux-x86_64.tar.gz"));

  // one clean-but-short response (server closed early), then a good one → recovers
  mock.stats.truncateDownloads = 1;
  const dest = path.join(env.root, "trunc", target.name);
  const result = await gh.downloadAsset(target, dest, { onProgress: () => {} });
  assert.strictEqual(fs.readFileSync(dest).length, target._body.length, "full file after retry");
  assert.strictEqual(result.sha256, helpers.sha256(target._body));
  assert.strictEqual(mock.stats.downloads, 2, "exactly one retry");

  // every attempt truncated → hard failure, no partial file left behind
  mock.stats.truncateDownloads = 99;
  const dest2 = path.join(env.root, "trunc2", target.name);
  await assert.rejects(
    () => gh.downloadAsset(target, dest2, { onProgress: () => {} }),
    /failed after 3 attempts/
  );
  assert.ok(!fs.existsSync(dest2), "no destination file");
  assert.ok(!fs.existsSync(`${dest2}.part`), "no partial file");
});

test("downloadAsset rejects and removes the file when the checksum mismatches", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);

  const rel = mock.data.releases["nerdrx/wivrn-nx"];
  const target = rel.assets.find((a) => a.name.endsWith("linux-x86_64.tar.gz"));
  const sidecar = rel.assets.find((a) => a.name.endsWith(".sha256"));
  sidecar._body = Buffer.from(`${"a".repeat(64)}  ${target.name}\n`);

  const dest = path.join(env.root, "bad", target.name);
  await assert.rejects(
    () => gh.downloadAsset(target, dest, { siblings: rel.assets }),
    /Checksum mismatch/
  );
  assert.ok(!fs.existsSync(dest), "bad download is not kept");
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test("downloadAsset can be aborted", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  const rel = mock.data.releases["nerdrx/quadforge"];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    gh.downloadAsset(rel.assets[0], path.join(env.root, "aborted.zip"), { signal: controller.signal })
  );
});

test("rate limiting surfaces a friendly message", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  mock.setRateLimited(true);
  await assert.rejects(
    () => gh.listOwnerRepos("nerdrx"),
    (err) => {
      assert.strictEqual(err.rateLimited, true);
      assert.match(err.message, /rate limit/i);
      assert.match(err.message, /gh auth login/);
      return true;
    }
  );
});

test("fetchRaw reads a file from the raw host and returns null when missing", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ overlay: { hidden: ["petri"], apps: {} } });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  const text = await gh.fetchRaw("nerdrx/nx-hub", "main", "registry/overrides.json");
  assert.deepStrictEqual(JSON.parse(text).hidden, ["petri"]);

  mock.data.overlay = null;
  assert.strictEqual(await gh.fetchRaw("nerdrx/nx-hub", "main", "registry/overrides.json"), null);
});

test("base URL override honours NX_HUB_GITHUB_BASE and derives the raw host", () => {
  const prev = process.env.NX_HUB_GITHUB_BASE;
  process.env.NX_HUB_GITHUB_BASE = "http://127.0.0.1:12345/";
  try {
    assert.strictEqual(github.apiBase(), "http://127.0.0.1:12345");
    assert.strictEqual(github.rawBase(), "http://127.0.0.1:12345/raw");
  } finally {
    if (prev === undefined) delete process.env.NX_HUB_GITHUB_BASE;
    else process.env.NX_HUB_GITHUB_BASE = prev;
  }
});

test("two concurrent downloads of one asset to one destination do not corrupt each other", async (t) => {
  // Two hub processes (the app's update policy and `nx update` in a terminal)
  // fetch the same asset into the same downloads/ path at the same moment.
  // In-process here, but the mechanism under test is the same: each download
  // owns a private part file and renames it into place atomically.
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const gh = clientFor(mock, env);
  const rel = mock.data.releases["nerdrx/wivrn-nx"];
  const target = rel.assets.find((a) => a.name.endsWith("linux-x86_64.tar.gz"));
  const dest = path.join(env.root, "race", target.name);

  const [a, b] = await Promise.all([
    gh.downloadAsset(target, dest, { siblings: rel.assets, onProgress: () => {} }),
    gh.downloadAsset(target, dest, { siblings: rel.assets, onProgress: () => {} }),
  ]);
  assert.strictEqual(a.sha256, helpers.sha256(target._body));
  assert.strictEqual(b.sha256, helpers.sha256(target._body));
  assert.strictEqual(a.verified && b.verified, true);
  assert.strictEqual(
    helpers.sha256(fs.readFileSync(dest)),
    helpers.sha256(target._body),
    "the file on disk is one intact, verified copy"
  );
  const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => n.includes(".part"));
  assert.deepStrictEqual(leftovers, [], "no part files survive either download");
  // the mock counts the sidecar fetch as a download too: two per call
  assert.ok(mock.stats.downloads >= 2, `both really downloaded (${mock.stats.downloads} fetches)`);
});
