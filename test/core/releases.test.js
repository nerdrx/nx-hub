"use strict";
// v0.2 discovery: full release lists, prerelease selection (global + per-app),
// skippedVersion suppression, appPrefs.hidden, rollback / readyToInstall flags.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const stateStore = require("../../src/main/state");

/** wivrn-nx: 1.3.0 stable → 1.4.0 stable → 1.5.0-rc1 prerelease (+ a draft). */
function multiReleaseData(base) {
  const data = helpers.defaultData(base);
  const zip = helpers.makeZip({ "run.sh": "#!/bin/sh\n" });
  const mk = (tag, when, extra) =>
    helpers.release(
      tag,
      [helpers.asset(base, "nerdrx/wivrn-nx", `wivrn-nx-${tag.replace(/^v/, "")}-linux.zip`, zip)],
      Object.assign({ published_at: when }, extra)
    );

  data.releases["nerdrx/wivrn-nx"] = [
    mk("v1.5.0-rc1", "2026-06-01T10:00:00Z", { prerelease: true }),
    mk("v1.9.9-draft", "2026-07-01T10:00:00Z", { draft: true }),
    mk("v1.4.0", "2026-05-01T10:00:00Z"),
    mk("v1.3.0", "2026-04-01T10:00:00Z"),
  ];
  data.releases["nerdrx/quadforge"] = [
    helpers.release("nx-2.0-beta", [helpers.asset(base, "nerdrx/quadforge", "quadforge-2.0-beta.zip", zip)], {
      prerelease: true,
      published_at: "2026-06-10T10:00:00Z",
    }),
    helpers.release("nx-1.3", [helpers.asset(base, "nerdrx/quadforge", "quadforge-1.3.zip", zip)], {
      published_at: "2026-03-01T10:00:00Z",
    }),
  ];
  return data;
}

function clientFor(mock, env) {
  return github.createClient({
    baseUrl: mock.base,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
}

async function refreshWith(mock, env) {
  discovery.init({ github: clientFor(mock, env), emit: () => {}, afterRefresh: null });
  return discovery.refresh({ force: true });
}

/* ---------------- github.listReleases ---------------- */

test("listReleases returns the whole list, drops drafts and tolerates empty repos", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  const client = clientFor(mock, env);

  const list = await client.listReleases("nerdrx", "wivrn-nx");
  assert.strictEqual(list.length, 3, "the draft is not published to us");
  assert.ok(!list.some((r) => r.draft));
  assert.deepStrictEqual(
    list.map((r) => r.tag_name).sort(),
    ["v1.3.0", "v1.4.0", "v1.5.0-rc1"]
  );

  // "owner/repo" form works too, and a repo without releases resolves to []
  const same = await client.listReleases("nerdrx/wivrn-nx");
  assert.strictEqual(same.length, 3);
  assert.deepStrictEqual(await client.listReleases("nerdrx", "lonely-repo"), []);

  // second call is served from the ETag cache (304, no new body)
  const before = mock.stats.notModified;
  await client.listReleases("nerdrx", "wivrn-nx");
  assert.ok(mock.stats.notModified > before, "listReleases is ETag-cached");
});

/* ---------------- selection ---------------- */

test("selectRelease honours includePrereleases and never picks a draft", () => {
  const rel = (tag, when, extra) => Object.assign({ tag_name: tag, published_at: when, id: 1 }, extra);
  const list = [
    rel("v1.5.0-rc1", "2026-06-01T10:00:00Z", { prerelease: true }),
    rel("v1.4.0", "2026-05-01T10:00:00Z"),
    rel("v9.9.9", "2026-07-01T10:00:00Z", { draft: true }),
  ];

  assert.strictEqual(discovery.selectRelease(list, { includePrereleases: false }).tag_name, "v1.4.0");
  assert.strictEqual(discovery.selectRelease(list, { includePrereleases: true }).tag_name, "v1.5.0-rc1");
  assert.strictEqual(discovery.selectRelease(null, {}), null);
  assert.strictEqual(discovery.selectRelease([], {}), null);

  // a repo that only ever ships prereleases still shows its newest one
  const onlyPre = [rel("v0.2-beta", "2026-02-01T10:00:00Z", { prerelease: true })];
  assert.strictEqual(discovery.selectRelease(onlyPre, { includePrereleases: false }).tag_name, "v0.2-beta");

  // a single release object (pre-v0.2 shape) is still accepted
  assert.strictEqual(discovery.selectRelease(rel("v1.0", "2026-01-01T00:00:00Z"), {}).tag_name, "v1.0");
});

test("refresh picks the newest stable release; includePrereleases flips it globally", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [] });
  let apps = await refreshWith(mock, env);
  let wivrn = apps.find((a) => a.id === "wivrn-nx");
  assert.strictEqual(wivrn.latest.version, "1.4.0");
  assert.strictEqual(wivrn.latest.prerelease, false);
  assert.strictEqual(wivrn.includePrereleases, false);

  config.save({ includePrereleases: true });
  apps = await refreshWith(mock, env);
  wivrn = apps.find((a) => a.id === "wivrn-nx");
  assert.strictEqual(wivrn.latest.version, "1.5.0-rc1");
  assert.strictEqual(wivrn.latest.prerelease, true);
  assert.strictEqual(wivrn.includePrereleases, true);
});

test("appPrefs[app].includePrereleases overrides the global setting per app", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [], includePrereleases: false });
  config.setAppPref("quadforge", { includePrereleases: true });

  const apps = await refreshWith(mock, env);
  assert.strictEqual(apps.find((a) => a.id === "wivrn-nx").latest.version, "1.4.0", "global still applies");
  assert.strictEqual(apps.find((a) => a.id === "quadforge").latest.version, "2.0-beta", "per-app override wins");

  // flipping the app pref off re-selects the stable release without a network hit
  config.setAppPref("quadforge", { includePrereleases: false });
  const rebuilt = discovery.rebuild();
  assert.strictEqual(rebuilt.find((a) => a.id === "quadforge").latest.version, "1.3");
});

/* ---------------- skippedVersion / hidden ---------------- */

test("skippedVersion suppresses the update for exactly that version", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [] });
  await refreshWith(mock, env);
  const artifactId = discovery.findApp("wivrn-nx").artifacts[0].id;
  stateStore.recordInstall("wivrn-nx", artifactId, { version: "1.3.0", path: "/tmp/wivrn" });
  discovery.remerge();

  let artifact = discovery.findArtifact("wivrn-nx", artifactId).artifact;
  assert.strictEqual(artifact.updateAvailable, true);
  assert.strictEqual(artifact.updateSkipped, false);

  config.setAppPref("wivrn-nx", { skippedVersion: "1.4.0" });
  discovery.remerge();
  artifact = discovery.findArtifact("wivrn-nx", artifactId).artifact;
  assert.strictEqual(artifact.updateAvailable, false, "the skipped version raises no update");
  assert.strictEqual(artifact.updateSkipped, true);

  // a DIFFERENT version is not covered by the skip
  config.setAppPref("wivrn-nx", { skippedVersion: "1.3.9" });
  discovery.remerge();
  artifact = discovery.findArtifact("wivrn-nx", artifactId).artifact;
  assert.strictEqual(artifact.updateAvailable, true);
  assert.strictEqual(artifact.updateSkipped, false);
});

test("appPrefs.hidden keeps the app discovered but flags it localHidden", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [] });
  config.setAppPref("quadforge", { hidden: true, favorite: true });
  const apps = await refreshWith(mock, env);

  const qf = apps.find((a) => a.id === "quadforge");
  assert.ok(qf, "a locally hidden app is still discovered (the UI filters it)");
  assert.strictEqual(qf.localHidden, true);
  assert.strictEqual(qf.favorite, true);
  assert.strictEqual(apps.find((a) => a.id === "wivrn-nx").localHidden, false);

  // overlay-hidden repos remain filtered out entirely — that is a different thing
  assert.ok(!apps.some((a) => a.id === "petri"));
});

/* ---------------- release list + per-release artifacts ---------------- */

test("getReleases/findRelease/matchArtifactInRelease serve the version picker", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [] });
  await refreshWith(mock, env);

  const releases = discovery.getReleases("wivrn-nx");
  assert.strictEqual(releases.length, 3);
  assert.deepStrictEqual(
    releases.map((r) => r.tag),
    ["v1.5.0-rc1", "v1.4.0", "v1.3.0"],
    "newest first"
  );
  for (const key of ["tag", "version", "notes", "publishedAt", "prerelease", "assets"]) {
    assert.ok(key in releases[0], `release.${key} missing`);
  }
  assert.strictEqual(releases[0].version, "1.5.0-rc1");
  assert.ok(Array.isArray(releases[0].assets) && releases[0].assets[0].name);
  assert.deepStrictEqual(discovery.getReleases("nope-not-here"), []);

  const old = discovery.findRelease("wivrn-nx", "v1.3.0");
  assert.strictEqual(old.tag_name, "v1.3.0");
  assert.strictEqual(discovery.findRelease("wivrn-nx", "1.3.0").tag_name, "v1.3.0", "version form resolves too");
  assert.strictEqual(discovery.findRelease("wivrn-nx", "v0.0.0"), null);

  const live = discovery.findApp("wivrn-nx").artifacts[0];
  const match = discovery.matchArtifactInRelease("wivrn-nx", live.id, old, live);
  assert.ok(match, "the same artifact is found in an older release");
  assert.strictEqual(match.id, live.id);
  assert.match(match.assetName, /1\.3\.0/);
});

/* ---------------- rollback + readyToInstall flags ---------------- */

test("artifacts expose rollbackAvailable/prevVersion and readyToInstall", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: multiReleaseData });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });

  config.save({ owners: ["nerdrx"], extraRepos: [] });
  await refreshWith(mock, env);
  const app = discovery.findApp("wivrn-nx");
  const artifact = app.artifacts[0];
  assert.strictEqual(artifact.kind, "archive-dir", "fixture is a dir-based kind");

  const installDir = path.join(env.installRoot, "nx", "wivrn-nx", artifact.id);
  fs.mkdirSync(installDir, { recursive: true });
  stateStore.recordInstall("wivrn-nx", artifact.id, { version: "1.3.0", path: installDir });
  discovery.remerge();
  assert.strictEqual(discovery.findArtifact("wivrn-nx", artifact.id).artifact.rollbackAvailable, false);

  // a kept previous install makes rollback available and names the version
  fs.mkdirSync(`${installDir}.prev`, { recursive: true });
  fs.writeFileSync(
    path.join(`${installDir}.prev`, ".nx-manifest.json"),
    JSON.stringify({ version: "1.2.0", kind: "archive-dir" })
  );
  discovery.remerge();
  let merged = discovery.findArtifact("wivrn-nx", artifact.id).artifact;
  assert.strictEqual(merged.rollbackAvailable, true);
  assert.strictEqual(merged.prevVersion, "1.2.0");
  assert.strictEqual(merged.readyToInstall, false);

  // a pre-downloaded asset for the CURRENT latest flips readyToInstall
  const cachedFile = path.join(config.downloadsDir(), `wivrn-nx-${artifact.assetName}`);
  fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
  fs.writeFileSync(cachedFile, "payload");
  stateStore.recordDownload("wivrn-nx", artifact.id, { version: "1.4.0", path: cachedFile });
  discovery.remerge();
  merged = discovery.findArtifact("wivrn-nx", artifact.id).artifact;
  assert.strictEqual(merged.readyToInstall, true);
  assert.strictEqual(merged.readyPath, cachedFile);

  // a download for a version that is no longer latest does not count
  stateStore.recordDownload("wivrn-nx", artifact.id, { version: "1.3.5", path: cachedFile });
  discovery.remerge();
  assert.strictEqual(discovery.findArtifact("wivrn-nx", artifact.id).artifact.readyToInstall, false);
});
