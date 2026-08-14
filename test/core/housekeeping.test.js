"use strict";
// v0.2 housekeeping: disk usage (du in node, cached), download-cache clearing
// and the log tail.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const stateStore = require("../../src/main/state");
const housekeeping = require("../../src/main/housekeeping");

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
}

test("getDiskUsage sums each app dir and the download cache", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    housekeeping.invalidateUsageCache();
    env.cleanup();
  });
  housekeeping.invalidateUsageCache();

  const nx = path.join(env.installRoot, "nx");
  writeFile(path.join(nx, "wivrn-nx", "archive-dir-linux", "bin", "wivrn"), 4000);
  writeFile(path.join(nx, "wivrn-nx", "archive-dir-linux.prev", "bin", "wivrn"), 1000);
  writeFile(path.join(nx, "quadforge", "blender-addon-linux", "addon.py"), 500);
  writeFile(path.join(nx, "downloads", "parked.zip"), 700);
  writeFile(path.join(config.downloadsDir(), "wivrn-nx-server.tar.gz"), 300);

  const usage = await housekeeping.getDiskUsage({ force: true });
  assert.strictEqual(usage.perApp["wivrn-nx"], 5000, "the kept .prev counts towards the app");
  assert.strictEqual(usage.perApp.quadforge, 500);
  assert.ok(!("downloads" in usage.perApp), "the downloads folder is not an app");
  assert.strictEqual(usage.downloadCache, 300);
  assert.strictEqual(usage.downloads, 1000, "cache + parked assets");
  assert.strictEqual(usage.installed, 5500);
  assert.strictEqual(usage.total, 6500);
  assert.strictEqual(typeof usage.at, "string");
});

test("getDiskUsage is cached for 30s and refreshable with force", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    housekeeping.invalidateUsageCache();
    env.cleanup();
  });
  housekeeping.invalidateUsageCache();

  const nx = path.join(env.installRoot, "nx");
  writeFile(path.join(nx, "demo", "appimage-linux", "AppRun"), 100);
  const first = await housekeeping.getDiskUsage({ force: true });
  assert.strictEqual(first.total, 100);

  writeFile(path.join(nx, "demo", "appimage-linux", "extra"), 900);
  const cached = await housekeeping.getDiskUsage();
  assert.strictEqual(cached.total, 100, "served from the 30s cache");
  const forced = await housekeeping.getDiskUsage({ force: true });
  assert.strictEqual(forced.total, 1000);
  assert.strictEqual(housekeeping.USAGE_TTL_MS, 30000);
});

test("an empty / missing install root reports zeroes instead of throwing", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    housekeeping.invalidateUsageCache();
    env.cleanup();
  });
  housekeeping.invalidateUsageCache();
  fs.rmSync(env.installRoot, { recursive: true, force: true });

  const usage = await housekeeping.getDiskUsage({ force: true });
  assert.deepStrictEqual(usage.perApp, {});
  assert.strictEqual(usage.total, 0);
});

test("clearDownloadCache empties the cache dir and forgets pre-downloads", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => {
    housekeeping.invalidateUsageCache();
    env.cleanup();
  });

  const cacheDir = config.downloadsDir();
  writeFile(path.join(cacheDir, "a.zip"), 1000);
  writeFile(path.join(cacheDir, "b.AppImage"), 2000);
  writeFile(path.join(cacheDir, "leftover", "c.part"), 50);
  stateStore.recordDownload("wivrn-nx", "archive-dir-linux", { version: "1.4.0", path: path.join(cacheDir, "a.zip") });

  // an installed app must NOT be touched by clearing the cache
  const installed = path.join(env.installRoot, "nx", "demo", "appimage-linux", "AppRun");
  writeFile(installed, 10);

  const result = await housekeeping.clearDownloadCache();
  assert.strictEqual(result.removed, 3);
  assert.strictEqual(result.bytes, 3050);
  assert.deepStrictEqual(fs.readdirSync(cacheDir), []);
  assert.strictEqual(stateStore.getDownload("wivrn-nx", "archive-dir-linux"), null);
  assert.ok(fs.existsSync(installed), "installs are left alone");

  const again = await housekeeping.clearDownloadCache();
  assert.strictEqual(again.removed, 0, "clearing an empty cache is a no-op");
});

test("getLogs tails the log file without reading all of it", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  const empty = housekeeping.getLogs(10);
  assert.deepStrictEqual(empty.lines, [], "no log file yet → no lines, no error");
  assert.strictEqual(empty.error, null);

  for (let i = 1; i <= 25; i += 1) config.log(`line ${i}`);
  const tail = housekeeping.getLogs(5);
  assert.strictEqual(tail.lines.length, 5);
  assert.match(tail.lines[4], /line 25$/);
  assert.match(tail.lines[0], /line 21$/);
  assert.strictEqual(tail.file, config.logFile());
  assert.ok(tail.size > 0);

  assert.strictEqual(housekeeping.getLogs(1000).lines.length, 25, "asking for more than exists is fine");
  assert.strictEqual(housekeeping.getLogs(0).lines.length, 25, "0 / missing falls back to the default tail");
  assert.strictEqual(housekeeping.getLogs(-5).lines.length, 1, "a negative tail size is clamped, not fatal");
});
