"use strict";
// SPEC v0.6 — delta updates.
//
// Real files, real `zstd --patch-from` round trips, real sha256 verification;
// the patch and its sidecar are served by the mock GitHub like any other asset.
// Every failure mode must fall back to the full download, silently.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const jobs = require("../../src/main/jobs");
const stateStore = require("../../src/main/state");

const OWNER_REPO = "nerdrx/deltapp";
const APP_ID = "deltapp";
const ARTIFACT_ID = "appimage-linux";
const OLD_VERSION = "1.0.0";
const NEW_VERSION = "2.0.0";
const NEW_ASSET = `DeltaApp-${NEW_VERSION}-linux.AppImage`;
const OLD_ASSET = `DeltaApp-${OLD_VERSION}-linux.AppImage`;

const HAS_ZSTD = spawnSync("zstd", ["--version"]).status === 0;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Two "AppImages" that share most of their bytes, plus a real zstd patch. */
function makeFixture(dir) {
  const shared = crypto.createHash("sha512").update("nx-delta-seed").digest();
  const body = Buffer.concat(Array.from({ length: 400 }, (_, i) => Buffer.concat([shared, Buffer.from(`:${i}:`)])));
  const prev = Buffer.concat([body, Buffer.from("\n--- version 1.0.0 payload ---\n")]);
  const next = Buffer.concat([body, Buffer.from("\n--- version 2.0.0 payload, longer than before ---\n")]);
  const prevFile = path.join(dir, "prev.bin");
  const nextFile = path.join(dir, "next.bin");
  const patchFile = path.join(dir, "patch.zpatch");
  fs.writeFileSync(prevFile, prev);
  fs.writeFileSync(nextFile, next);
  execFileSync("zstd", ["-q", "-f", "--patch-from", prevFile, "--long=27", nextFile, "-o", patchFile]);
  return { prev, next, patch: fs.readFileSync(patchFile), prevFile, nextFile, dir };
}

/**
 * Mock release universe: one repo, one AppImage, its .sha256 sidecar and the
 * `<asset>.from-1.0.0.zpatch` patch. `opts` bends it for the failure cases.
 */
function makeData(fx, opts = {}) {
  return (base) => {
    const assets = [helpers.asset(base, OWNER_REPO, NEW_ASSET, fx.next)];
    if (!opts.noSidecar) {
      assets.push(
        helpers.asset(base, OWNER_REPO, `${NEW_ASSET}.sha256`, Buffer.from(`${sha256(fx.next)}  ${NEW_ASSET}\n`))
      );
    }
    if (!opts.noPatch) {
      const bytes = opts.corruptPatch ? Buffer.from("not a zstd patch at all, sorry") : opts.patchBytes || fx.patch;
      assets.push(helpers.asset(base, OWNER_REPO, `${NEW_ASSET}.from-${opts.patchFrom || OLD_VERSION}.zpatch`, bytes));
    }
    return {
      repos: { nerdrx: [helpers.repo("nerdrx", "deltapp", { description: "delta test app" })] },
      releases: { [OWNER_REPO]: helpers.release(`v${NEW_VERSION}`, assets) },
      overlay: null,
    };
  };
}

function appFromMock(mock) {
  const release = mock.data.releases[OWNER_REPO];
  return {
    id: APP_ID,
    repo: OWNER_REPO,
    name: "DeltaApp",
    latest: { tag: release.tag_name, version: NEW_VERSION, publishedAt: null, notes: "", prerelease: false },
    artifacts: discovery.buildArtifacts(release, {}),
  };
}

/** jobs wired to the mock GitHub and an engine that just reports what it got. */
function harness(mock, env) {
  const events = [];
  const listeners = [];
  const got = {};
  const emit = (evt) => {
    events.push(evt);
    for (const l of [...listeners]) l(evt);
  };
  const client = github.createClient({
    baseUrl: mock.base,
    cacheDir: path.join(env.dataDir, "cache"),
    getToken: async () => null,
  });
  const app = appFromMock(mock);
  jobs._reset();
  jobs.init({
    emit,
    github: client,
    relaunch: null,
    engineLoader: null,
    engine: {
      async install({ artifact, filePath, ctx }) {
        got.bytes = fs.readFileSync(filePath);
        got.assetName = artifact.assetName;
        const dest = path.join(ctx.installRoot, "nx", APP_ID, artifact.id);
        fs.mkdirSync(dest, { recursive: true });
        return { version: artifact.version, path: dest, launchable: true };
      },
    },
    resolve: (appId, artifactId) => ({
      app,
      artifact: app.artifacts.find((a) => a.id === artifactId) || null,
    }),
  });
  return {
    app,
    events,
    got,
    wait(jobId) {
      return new Promise((resolve) => {
        const done = events.find((e) => (e.type === "job-done" || e.type === "job-error") && e.jobId === jobId);
        if (done) return resolve(done);
        const l = (evt) => {
          if ((evt.type === "job-done" || evt.type === "job-error") && evt.jobId === jobId) {
            listeners.splice(listeners.indexOf(l), 1);
            resolve(evt);
          }
        };
        listeners.push(l);
      });
    },
    messages() {
      return events.filter((e) => e.type === "job-progress").map((e) => e.message || "");
    },
  };
}

/** Pretend v1.0.0 is installed, with the kept original the engine records. */
function installOldVersion(env, fx, opts = {}) {
  const installDir = path.join(env.installRoot, "nx", APP_ID, ARTIFACT_ID);
  fs.mkdirSync(installDir, { recursive: true });
  if (!opts.noKept) fs.writeFileSync(path.join(installDir, OLD_ASSET), opts.keptBytes || fx.prev);
  if (!opts.noManifest) {
    fs.writeFileSync(
      path.join(installDir, ".nx-manifest.json"),
      JSON.stringify({
        version: OLD_VERSION,
        kind: "appimage",
        binary: "AppRun",
        appImageFile: opts.manifestName === null ? undefined : opts.manifestName || OLD_ASSET,
      })
    );
  }
  stateStore.recordInstall(APP_ID, ARTIFACT_ID, { version: OLD_VERSION, path: installDir, launchable: true });
  return installDir;
}

/** Was this named asset's download endpoint hit? */
function fetched(mock, name) {
  const a = mock.assetNamed(OWNER_REPO, name);
  if (!a) return false;
  return mock.stats.requests.some((r) => r.endsWith(`/releases/assets/${a.id}`));
}

async function runInstall(mock, env) {
  const h = harness(mock, env);
  const jobId = jobs.install(APP_ID, ARTIFACT_ID);
  const done = await h.wait(jobId);
  return { h, done };
}

/** One test scaffold: temp env + mock server + fixture, all torn down. */
async function scaffold(t, dataOpts = {}) {
  const env = helpers.useTempEnv();
  const fxDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-delta-fx-"));
  const fx = makeFixture(fxDir);
  const mock = await helpers.startMockGitHub({ makeData: makeData(fx, dataOpts) });
  t.after(async () => {
    jobs._reset();
    await mock.close();
    fs.rmSync(fxDir, { recursive: true, force: true });
    env.cleanup();
  });
  return { env, fx, mock };
}

/* ------------------------------------------------------------------ */
/* the happy path                                                      */
/* ------------------------------------------------------------------ */

test("delta: updating from the installed version downloads the patch, not the asset", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  installOldVersion(env, fx);

  const { h, done } = await runInstall(mock, env);
  assert.strictEqual(done.type, "job-done", `job failed: ${done.message}`);

  assert.ok(h.got.bytes, "the engine was handed a file");
  assert.strictEqual(sha256(h.got.bytes), sha256(fx.next), "the reconstruction is byte-identical to the full asset");
  assert.ok(fetched(mock, `${NEW_ASSET}.from-${OLD_VERSION}.zpatch`), "the patch was downloaded");
  assert.ok(!fetched(mock, NEW_ASSET), "the full asset was never downloaded");
  assert.ok(fetched(mock, `${NEW_ASSET}.sha256`), "the sidecar was fetched to verify the result");

  const msgs = h.messages();
  assert.ok(
    msgs.some((m) => /downloading delta patch/i.test(m)),
    `a "delta" download message is emitted: ${JSON.stringify(msgs)}`
  );
  assert.ok(msgs.some((m) => /applying delta patch/i.test(m)), "an apply message is emitted");
  assert.ok(
    msgs.some((m) => /delta applied — .* instead of /i.test(m)),
    `the savings are reported: ${JSON.stringify(msgs)}`
  );

  assert.strictEqual(stateStore.getInstall(APP_ID, ARTIFACT_ID).version, NEW_VERSION);
  const leftovers = fs.readdirSync(config.downloadsDir()).filter((f) => f.endsWith(".zpatch"));
  assert.deepStrictEqual(leftovers, [], "the patch file is cleaned up");
});

test("delta: the patch asset is not an installable artifact", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { mock } = await scaffold(t);
  const app = appFromMock(mock);
  assert.deepStrictEqual(
    app.artifacts.map((a) => a.assetName),
    [NEW_ASSET],
    "only the AppImage is an artifact — .sha256 and .zpatch are ignored"
  );
  assert.ok(discovery.IGNORE_RE.test("Anything-1.0.AppImage.from-0.9.zpatch"));
  assert.strictEqual(discovery.classifyAsset({ name: `${NEW_ASSET}.from-1.0.0.zpatch` }), null);

  const [artifact] = app.artifacts;
  assert.deepStrictEqual(
    artifact.deltaPatches.map((p) => p.fromVersion),
    [OLD_VERSION],
    "the patch is attached to the artifact it patches"
  );
  assert.ok(artifact.deltaPatches[0].url, "with a download url");
});

/* ------------------------------------------------------------------ */
/* the fallback matrix — every one of these must install successfully  */
/* ------------------------------------------------------------------ */

async function assertFullDownloadFallback(mock, env, fx, why) {
  const { h, done } = await runInstall(mock, env);
  assert.strictEqual(done.type, "job-done", `${why}: job failed: ${done.message}`);
  assert.strictEqual(sha256(h.got.bytes), sha256(fx.next), `${why}: the engine still got the real asset`);
  assert.ok(fetched(mock, NEW_ASSET), `${why}: fell back to the full download`);
  return h;
}

test("fallback: no zstd on PATH", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  installOldVersion(env, fx);

  const realPath = process.env.PATH;
  process.env.PATH = path.join(env.root, "empty-bin"); // exists but holds no zstd
  fs.mkdirSync(process.env.PATH, { recursive: true });
  t.after(() => {
    process.env.PATH = realPath;
  });
  assert.strictEqual(jobs.findZstd(), null, "findZstd honours PATH");

  const h = await assertFullDownloadFallback(mock, env, fx, "no zstd");
  assert.ok(!fetched(mock, `${NEW_ASSET}.from-${OLD_VERSION}.zpatch`), "no patch download was even attempted");
  assert.ok(!h.messages().some((m) => /delta patch/i.test(m)), "and the UI never mentions a delta");
});

test("fallback: the patch asset 404s", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  installOldVersion(env, fx);

  // point the patch at an id the server does not know
  const h = harness(mock, env);
  const artifact = h.app.artifacts[0];
  artifact.deltaPatches[0].id = 424242;
  artifact.deltaPatches[0].url = `${mock.base}/repos/${OWNER_REPO}/releases/assets/424242`;
  const jobId = jobs.install(APP_ID, ARTIFACT_ID);
  const done = await h.wait(jobId);

  assert.strictEqual(done.type, "job-done", `job failed: ${done.message}`);
  assert.strictEqual(sha256(h.got.bytes), sha256(fx.next));
  assert.ok(fetched(mock, NEW_ASSET), "fell back to the full download");
});

test("fallback: the patch is corrupt (zstd exits non-zero)", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t, { corruptPatch: true });
  installOldVersion(env, fx);
  await assertFullDownloadFallback(mock, env, fx, "corrupt patch");
});

test("fallback: the reconstruction does not match the sidecar", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  // a VALID patch that rebuilds something else entirely — the sidecar catches it
  const strayDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-delta-stray-"));
  t.after(() => fs.rmSync(strayDir, { recursive: true, force: true }));

  const env = helpers.useTempEnv();
  const fxDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-delta-fx-"));
  const fx = makeFixture(fxDir);
  const stray = path.join(strayDir, "stray.bin");
  fs.writeFileSync(stray, Buffer.concat([fx.prev, Buffer.from("\n--- a build nobody published ---\n")]));
  const strayPatch = path.join(strayDir, "stray.zpatch");
  execFileSync("zstd", ["-q", "-f", "--patch-from", fx.prevFile, "--long=27", stray, "-o", strayPatch]);

  const mock = await helpers.startMockGitHub({
    makeData: makeData(fx, { patchBytes: fs.readFileSync(strayPatch) }),
  });
  t.after(async () => {
    jobs._reset();
    await mock.close();
    fs.rmSync(fxDir, { recursive: true, force: true });
    env.cleanup();
  });

  installOldVersion(env, fx);
  const h = await assertFullDownloadFallback(mock, env, fx, "hash mismatch");
  assert.ok(h.messages().some((m) => /delta patch/i.test(m)), "the delta attempt was visible before it fell back");
});

test("fallback: the kept original is missing, or the manifest does not name one", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  installOldVersion(env, fx, { noKept: true });
  await assertFullDownloadFallback(mock, env, fx, "no kept original");

  // and with no manifest at all
  const env2 = helpers.useTempEnv();
  const mock2 = await helpers.startMockGitHub({ makeData: makeData(fx) });
  t.after(async () => {
    jobs._reset();
    await mock2.close();
    env2.cleanup();
  });
  installOldVersion(env2, fx, { noManifest: true });
  await assertFullDownloadFallback(mock2, env2, fx, "no manifest");
});

test("fallback: the release ships no .sha256 sidecar — no sidecar, no delta", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t, { noSidecar: true });
  installOldVersion(env, fx);
  const h = await assertFullDownloadFallback(mock, env, fx, "no sidecar");
  assert.ok(!fetched(mock, `${NEW_ASSET}.from-${OLD_VERSION}.zpatch`), "the patch is not even fetched");
  assert.ok(!h.messages().some((m) => /delta patch/i.test(m)), "no delta was attempted");
});

test("fallback: a fresh install (nothing to patch from) and a patch from another version", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  // nothing installed at all
  await assertFullDownloadFallback(mock, env, fx, "fresh install");

  // installed, but the release only carries a patch from a version we do not run
  const env2 = helpers.useTempEnv();
  const mock2 = await helpers.startMockGitHub({ makeData: makeData(fx, { patchFrom: "0.9.0" }) });
  t.after(async () => {
    jobs._reset();
    await mock2.close();
    env2.cleanup();
  });
  installOldVersion(env2, fx);
  await assertFullDownloadFallback(mock2, env2, fx, "patch from another version");
});

test("fallback: non-appimage kinds never take the delta path", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const { env, fx, mock } = await scaffold(t);
  installOldVersion(env, fx);
  const h = harness(mock, env);
  h.app.artifacts[0].kind = "archive-dir"; // v1 is appimage-only, by SPEC
  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-done");
  assert.ok(fetched(mock, NEW_ASSET), "full download");
  assert.ok(!fetched(mock, `${NEW_ASSET}.from-${OLD_VERSION}.zpatch`));
});

/* ------------------------------------------------------------------ */
/* the release side                                                    */
/* ------------------------------------------------------------------ */

test("release.sh --delta --dry-run emits a usable patch against the previous release", async (t) => {
  if (!HAS_ZSTD) return t.skip("zstd not installed");
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-release-"));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));

  const version = "9.9.9";
  const prevVersion = "9.9.8";
  const fxDir = path.join(box, "fx");
  fs.mkdirSync(fxDir, { recursive: true });
  const fx = makeFixture(fxDir);

  // a repo checkout with the real release.sh and no-op build scripts
  const repoDir = path.join(box, "repo");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "nx-hub", version }));
  fs.copyFileSync(path.resolve(__dirname, "../../scripts/release.sh"), path.join(repoDir, "scripts/release.sh"));
  fs.chmodSync(path.join(repoDir, "scripts/release.sh"), 0o755);
  const newAsset = `NX-Hub-${version}-linux.AppImage`;
  fs.writeFileSync(path.join(repoDir, "dist", newAsset), fx.next);

  // the previous release, as `gh release download` would hand it over
  const ghStore = path.join(box, "gh-assets");
  fs.mkdirSync(ghStore, { recursive: true });
  const prevAsset = `NX-Hub-${prevVersion}-linux.AppImage`;
  fs.writeFileSync(path.join(ghStore, prevAsset), fx.prev);

  // fake gh + fake npm, so the script touches neither GitHub nor a real build
  const binDir = path.join(box, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(path.join(box, "gh.log"))}
case "$1 $2" in
"release list") echo "v${prevVersion}" ;;
"release download")
  dir="."; pattern=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -f ${JSON.stringify(ghStore)}/"$pattern" ] || exit 1
  cp ${JSON.stringify(ghStore)}/"$pattern" "$dir/$pattern" ;;
"auth status") exit 0 ;;
*) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(binDir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const out = execFileSync("bash", [path.join(repoDir, "scripts/release.sh"), "--skip-win", "--dry-run", "--delta"], {
    cwd: repoDir,
    env: Object.assign({}, process.env, {
      PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    }),
    encoding: "utf8",
    timeout: 60000,
  });

  const patchFile = path.join(repoDir, "dist", `${newAsset}.from-${prevVersion}.zpatch`);
  assert.ok(fs.existsSync(patchFile), `release.sh wrote the patch:\n${out}`);
  assert.ok(out.includes(`${newAsset}.from-${prevVersion}.zpatch`), "and lists it among the dry-run artifacts");
  assert.ok(fs.existsSync(path.join(repoDir, "dist", `${newAsset}.sha256`)), "the full asset still gets its sidecar");
  assert.ok(
    !fs.existsSync(`${patchFile}.sha256`),
    "patches deliberately get no checksum of their own — the full asset's is the proof"
  );
  assert.ok(fs.statSync(patchFile).size < fx.next.length / 4, "the patch is much smaller than the asset");
  assert.ok(!fs.readFileSync(path.join(box, "gh.log"), "utf8").includes("release create"), "dry run published nothing");

  // and the hub's own reconstruct command turns it back into the asset
  const rebuilt = path.join(box, "rebuilt.AppImage");
  const res = spawnSync("zstd", [
    "-d",
    "-f",
    "-q",
    "--long=27",
    `--patch-from=${path.join(ghStore, prevAsset)}`,
    patchFile,
    "-o",
    rebuilt,
  ]);
  assert.strictEqual(res.status, 0, `zstd reconstruct failed: ${res.stderr}`);
  assert.strictEqual(sha256(fs.readFileSync(rebuilt)), sha256(fx.next), "byte-identical to the built asset");
});
