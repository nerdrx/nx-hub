"use strict";
// SPEC v0.8 — signed releases.
//
// Real ed25519 keys, the real scripts, real signatures over real files. The
// only thing faked here is GitHub (helpers' mock server) and the build step of
// release.sh, which would otherwise spend two minutes in electron-builder.
//
// The pinned key in src/main/provenance.js is checked against the ACTUAL
// private key at tools/nx-signing when that key is present, so a mis-pasted
// public key cannot survive a test run on the release machine.

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
const provenance = require("../../src/main/provenance");

const REPO_ROOT = path.resolve(__dirname, "../..");
const GEN_SCRIPT = path.join(REPO_ROOT, "scripts/gen-signing-key.sh");
const RELEASE_SCRIPT = path.join(REPO_ROOT, "scripts/release.sh");
const REAL_KEY_DIR = "/run/media/nerdrx/Lex/claude/tools/nx-signing";

/** node's own bin dir first, so the scripts find the same node running us. */
function scriptEnv(extra = {}) {
  return Object.assign({}, process.env, { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, extra);
}

function tempBox(t, prefix) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  return box;
}

/** An ephemeral signing identity: {privateKey, pubHex, sign(buffer|path)}. */
function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey,
    pubHex: der.subarray(der.length - 32).toString("hex"),
    sign(bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : fs.readFileSync(bytes);
      const digest = crypto.createHash("sha256").update(buf).digest();
      return crypto.sign(null, digest, privateKey).toString("hex");
    },
  };
}

/** Pin `hex` for `owner` for the duration of one test. */
function pin(t, owner, hex) {
  const had = Object.prototype.hasOwnProperty.call(provenance.PINNED_KEYS, owner);
  const before = provenance.PINNED_KEYS[owner];
  provenance.PINNED_KEYS[owner] = hex;
  t.after(() => {
    if (had) provenance.PINNED_KEYS[owner] = before;
    else delete provenance.PINNED_KEYS[owner];
  });
}

/* ------------------------------------------------------------------ */
/* the pinned key itself                                               */
/* ------------------------------------------------------------------ */

test("provenance: nerdrx is pinned, however the owner is spelled; nobody else is", () => {
  assert.ok(provenance.isPinnedOwner("nerdrx"));
  assert.ok(provenance.isPinnedOwner("NERDRX"), "owner logins are case-insensitive");
  assert.ok(provenance.isPinnedOwner("  nerdrx  "), "and whitespace-tolerant");
  assert.ok(provenance.isPinnedOwner("nerdrx/nx-hub"), "a full_name is accepted, the pin is on the owner");
  assert.ok(!provenance.isPinnedOwner("someone-else"));
  assert.ok(!provenance.isPinnedOwner(""));
  assert.ok(!provenance.isPinnedOwner(null));
  assert.ok(!provenance.isPinnedOwner("constructor"), "inherited Object keys are not pins");

  const hex = provenance.pinnedKeyHex("nerdrx");
  assert.match(hex, /^[0-9a-f]{64}$/, "a raw 32-byte ed25519 key, hex");
  assert.ok(provenance.publicKeyFor("nerdrx"), "and it imports as a KeyObject");
  assert.strictEqual(provenance.publicKeyFor("someone-else"), null);
});

test("provenance: the pinned key is the public half of the real signing key", (t) => {
  const priv = path.join(REAL_KEY_DIR, "nx-release.key");
  const pub = path.join(REAL_KEY_DIR, "nx-release.pub");
  if (!fs.existsSync(priv)) return t.skip(`no signing key at ${REAL_KEY_DIR} (not the release machine)`);

  // the .pub PEM and the pin agree
  const der = crypto.createPublicKey(fs.readFileSync(pub, "utf8")).export({ type: "spki", format: "der" });
  assert.ok(
    provenance.matchesPinnedKey("nerdrx", der.subarray(der.length - 32).toString("hex")),
    "PINNED_KEYS.nerdrx matches tools/nx-signing/nx-release.pub"
  );

  // and so does the PRIVATE half, which is what actually signs releases
  const derived = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(priv, "utf8")));
  const derivedDer = derived.export({ type: "spki", format: "der" });
  assert.ok(
    provenance.matchesPinnedKey("nerdrx", derivedDer.subarray(derivedDer.length - 32).toString("hex")),
    "PINNED_KEYS.nerdrx matches the private key releases are signed with"
  );

  const mode = fs.statSync(priv).mode & 0o777;
  assert.strictEqual(mode, 0o600, `the private key is 0600, not 0${mode.toString(8)}`);
});

/* ------------------------------------------------------------------ */
/* verifyAsset                                                         */
/* ------------------------------------------------------------------ */

test("verifyAsset: a signature over sha256(file) round-trips from a file or a buffer", async (t) => {
  const id = makeIdentity();
  pin(t, "roundtrip", id.pubHex);
  const box = tempBox(t, "nxhub-prov-");
  const file = path.join(box, "app.AppImage");
  const bytes = crypto.randomBytes(4096);
  fs.writeFileSync(file, bytes);
  const sig = id.sign(bytes);

  assert.strictEqual(await provenance.verifyAsset("roundtrip", file, sig), true, "by path");
  assert.strictEqual(await provenance.verifyAsset("roundtrip", bytes, sig), true, "by buffer");
  assert.strictEqual(await provenance.verifyAsset("ROUNDTRIP", file, `${sig}\n`), true, "trailing newline is fine");
  assert.strictEqual(
    await provenance.verifyAsset("roundtrip", file, `  ${sig}  app.AppImage\n`),
    true,
    "sha256sum-shaped trailing filename is tolerated"
  );

  // the hash the download path already computed is accepted instead of re-reading
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.strictEqual(
    await provenance.verifyAsset("roundtrip", "/definitely/not/a/file", sig, { sha256: digest }),
    true,
    "a precomputed sha256 means the file is never read"
  );
});

test("verifyAsset: tampering with the file or the signature is rejected", async (t) => {
  const id = makeIdentity();
  pin(t, "tamper", id.pubHex);
  const box = tempBox(t, "nxhub-prov-");
  const file = path.join(box, "app.bin");
  const bytes = Buffer.from("the bytes that were signed\n");
  fs.writeFileSync(file, bytes);
  const sig = id.sign(bytes);
  assert.strictEqual(await provenance.verifyAsset("tamper", file, sig), true, "baseline");

  // one flipped byte in the payload
  const flipped = Buffer.from(bytes);
  flipped[4] ^= 0x01;
  assert.strictEqual(await provenance.verifyAsset("tamper", flipped, sig), false, "a flipped byte fails");

  // one flipped nibble in the signature
  const bad = `${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`;
  assert.strictEqual(await provenance.verifyAsset("tamper", file, bad), false, "a mangled signature fails");

  // a well-formed signature from the wrong key
  const other = makeIdentity();
  assert.strictEqual(await provenance.verifyAsset("tamper", file, other.sign(bytes)), false, "another key fails");

  // and every shape of junk answers false rather than throwing
  for (const junk of ["", "   ", "not hex at all", sig.slice(0, 100), `${sig}00`, null, undefined, 42, {}]) {
    assert.strictEqual(await provenance.verifyAsset("tamper", file, junk), false, `junk sig: ${String(junk)}`);
  }
  assert.strictEqual(await provenance.verifyAsset("tamper", path.join(box, "gone.bin"), sig), false, "missing file");
  fs.writeFileSync(file, flipped);
  assert.strictEqual(await provenance.verifyAsset("tamper", file, sig), false, "a rewritten file fails");
});

test("verifyAsset: an unpinned owner never verifies, even with a perfect signature", async (t) => {
  const id = makeIdentity();
  pin(t, "pinned-one", id.pubHex);
  const bytes = Buffer.from("payload");
  const sig = id.sign(bytes);
  assert.strictEqual(await provenance.verifyAsset("pinned-one", bytes, sig), true);
  assert.strictEqual(await provenance.verifyAsset("someone-else", bytes, sig), false);
  assert.strictEqual(await provenance.verifyAsset("", bytes, sig), false);
  assert.strictEqual(await provenance.verifyAsset(null, bytes, sig), false);
});

test("provenance: parseSignature and the constant-time hex compare", () => {
  const hex = "ab".repeat(64);
  assert.strictEqual(provenance.parseSignature(`${hex}\n`), hex);
  assert.strictEqual(provenance.parseSignature(`  ${hex.toUpperCase()}  `), hex, "normalized to lowercase");
  assert.strictEqual(provenance.parseSignature(Buffer.from(hex)), hex, "a Buffer is fine");
  assert.strictEqual(provenance.parseSignature(`${hex}  asset.AppImage`), hex);
  assert.strictEqual(provenance.parseSignature("ab".repeat(63)), null, "too short");
  assert.strictEqual(provenance.parseSignature("zz".repeat(64)), null, "not hex");
  assert.strictEqual(provenance.parseSignature(null), null);

  assert.ok(provenance.timingSafeHexEqual("00ff", "00FF"));
  assert.ok(!provenance.timingSafeHexEqual("00ff", "00fe"));
  assert.ok(!provenance.timingSafeHexEqual("00ff", "00ff00"), "length mismatch is not a throw");
  assert.ok(!provenance.timingSafeHexEqual("", ""));
  assert.ok(!provenance.timingSafeHexEqual("nothex!!", "nothex!!"), "non-hex never compares equal");
  assert.ok(!provenance.timingSafeHexEqual(null, null));
});

/* ------------------------------------------------------------------ */
/* the policy table                                                    */
/* ------------------------------------------------------------------ */

test("decide: the requireSignatures matrix", () => {
  const row = (owner, hasSignature, requireSignatures) => provenance.decide({ owner, hasSignature, requireSignatures });

  assert.strictEqual(row("nerdrx", true, false).action, "verify", "pinned + signed → verify");
  assert.strictEqual(row("nerdrx", true, true).action, "verify", "requireSignatures does not change that");
  assert.strictEqual(row("nerdrx", false, false).action, "skip", "pinned + unsigned → installs by default");
  assert.strictEqual(row("nerdrx", false, true).action, "refuse", "pinned + unsigned + require → refuse");
  assert.match(row("nerdrx", false, true).reason, /unsigned asset from a pinned owner/);

  assert.strictEqual(row("someone-else", true, false).action, "skip", "unpinned + signed → nothing to check against");
  assert.strictEqual(row("someone-else", true, true).action, "skip", "…even with requireSignatures on");
  assert.strictEqual(row("someone-else", false, true).action, "skip", "requireSignatures only binds pinned owners");
  assert.strictEqual(row("someone-else", false, false).action, "skip");

  assert.strictEqual(provenance.decide({}).action, "skip", "an empty question is not an error");
  assert.strictEqual(row("nerdrx", true, false).pinned, true);
  assert.strictEqual(row("someone-else", true, false).pinned, false);
});

test("config: requireSignatures defaults to false and sanitizes like every other flag", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(config.defaults().requireSignatures, false);
  assert.strictEqual(config.load().requireSignatures, false, "absent from settings.json → false");
  assert.strictEqual(config.save({ requireSignatures: true }).requireSignatures, true);
  assert.strictEqual(config.load().requireSignatures, true, "and it persists");
  assert.strictEqual(config.sanitize({ requireSignatures: "true" }).requireSignatures, true, "string true");
  assert.strictEqual(config.sanitize({ requireSignatures: "yes" }).requireSignatures, false, "junk → the default");
});

/* ------------------------------------------------------------------ */
/* discovery: the .sig sibling                                         */
/* ------------------------------------------------------------------ */

test("discovery: a .sig sibling becomes artifact fields, never an artifact", () => {
  const base = "http://example.invalid";
  const assets = [
    helpers.asset(base, "nerdrx/app", "App-1.0-linux.AppImage", Buffer.from("appimage")),
    helpers.asset(base, "nerdrx/app", "App-1.0-linux.AppImage.sha256", Buffer.from("hash")),
    helpers.asset(base, "nerdrx/app", "App-1.0-linux.AppImage.sig", Buffer.from("ab".repeat(64))),
    helpers.asset(base, "nerdrx/app", "App-1.0-windows-portable.exe", Buffer.from("exe")),
  ];
  const artifacts = discovery.buildArtifacts(helpers.release("v1.0", assets), {});

  assert.deepStrictEqual(
    artifacts.map((a) => a.assetName),
    ["App-1.0-linux.AppImage", "App-1.0-windows-portable.exe"],
    ".sig and .sha256 are classifier-ignored"
  );
  assert.strictEqual(discovery.classifyAsset({ name: "App-1.0-linux.AppImage.sig" }), null);

  const signed = artifacts[0];
  assert.strictEqual(signed.hasSignature, true, "the model field [ui-8] renders its shield chip from");
  assert.strictEqual(signed.signatureName, "App-1.0-linux.AppImage.sig");
  assert.ok(signed.signatureUrl, "with a fetchable url");
  assert.strictEqual(signed.signatureId, assets[2].id);
  assert.ok(signed.checksumName, "and the checksum sidecar is still captured alongside");

  const unsigned = artifacts[1];
  assert.strictEqual(unsigned.hasSignature, false, "an unsigned artifact says so explicitly");
  assert.strictEqual(unsigned.signatureUrl, undefined);
});

/* ------------------------------------------------------------------ */
/* scripts/gen-signing-key.sh                                          */
/* ------------------------------------------------------------------ */

test("gen-signing-key.sh: writes a 0600 private key, a 0644 public key and a README", (t) => {
  const box = tempBox(t, "nxhub-keygen-");
  const keyDir = path.join(box, "nx-signing");

  const out = execFileSync("bash", [GEN_SCRIPT, "--dir", keyDir], {
    encoding: "utf8",
    env: scriptEnv({ HOME: box, NX_SIGNING_DIR: path.join(box, "unused") }),
    timeout: 60000,
  });

  const priv = path.join(keyDir, "nx-release.key");
  const pub = path.join(keyDir, "nx-release.pub");
  assert.strictEqual(fs.statSync(priv).mode & 0o777, 0o600, "the private key is owner-read-only");
  assert.strictEqual(fs.statSync(pub).mode & 0o777, 0o644);
  assert.ok((fs.statSync(keyDir).mode & 0o077) === 0, "and the directory itself is not group/world readable");
  assert.match(fs.readFileSync(priv, "utf8"), /^-----BEGIN PRIVATE KEY-----/);
  assert.match(fs.readFileSync(pub, "utf8"), /^-----BEGIN PUBLIC KEY-----/);

  const printed = out.match(/\b([0-9a-f]{64})\b/);
  assert.ok(printed, `the raw public key is printed for pinning:\n${out}`);
  const hex = printed[1];

  // --print-public reads the same value back out of the PEM
  const again = execFileSync("bash", [GEN_SCRIPT, "--dir", keyDir, "--print-public"], {
    encoding: "utf8",
    env: scriptEnv({ HOME: box }),
  }).trim();
  assert.strictEqual(again, hex, "--print-public agrees with what generation printed");

  const readme = fs.readFileSync(path.join(keyDir, "README.md"), "utf8");
  assert.ok(readme.includes(hex), "the README records the key to pin");
  assert.match(readme, /provenance\.js/, "and points at where it is pinned");

  // the generated pair is usable by the hub exactly as pinned
  pin(t, "generated", hex);
  const bytes = Buffer.from("a release asset\n");
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const sig = crypto.sign(null, digest, crypto.createPrivateKey(fs.readFileSync(priv, "utf8"))).toString("hex");
  return provenance.verifyAsset("generated", bytes, sig).then((ok) => {
    assert.strictEqual(ok, true, "a key born from the script verifies through provenance");
  });
});

test("gen-signing-key.sh: refuses to overwrite an existing key", (t) => {
  const box = tempBox(t, "nxhub-keygen-");
  const keyDir = path.join(box, "nx-signing");
  const env = scriptEnv({ HOME: box });

  execFileSync("bash", [GEN_SCRIPT, "--dir", keyDir], { encoding: "utf8", env, timeout: 60000 });
  const before = fs.readFileSync(path.join(keyDir, "nx-release.key"), "utf8");

  const res = spawnSync("bash", [GEN_SCRIPT, "--dir", keyDir], { encoding: "utf8", env, timeout: 60000 });
  assert.notStrictEqual(res.status, 0, "a second run fails");
  assert.match(res.stderr, /refusing to overwrite/i);
  assert.strictEqual(
    fs.readFileSync(path.join(keyDir, "nx-release.key"), "utf8"),
    before,
    "and the existing key is untouched — regenerating would invalidate every published signature"
  );
});

test("gen-signing-key.sh: NX_SIGNING_DIR is the default location", (t) => {
  const box = tempBox(t, "nxhub-keygen-");
  const keyDir = path.join(box, "from-env");
  execFileSync("bash", [GEN_SCRIPT], {
    encoding: "utf8",
    env: scriptEnv({ HOME: box, NX_SIGNING_DIR: keyDir }),
    timeout: 60000,
  });
  assert.ok(fs.existsSync(path.join(keyDir, "nx-release.key")));
});

/* ------------------------------------------------------------------ */
/* scripts/release.sh                                                  */
/* ------------------------------------------------------------------ */

/**
 * A throwaway checkout with the REAL release.sh, a no-op `npm` and a `gh` that
 * records every call it gets. The asset is pre-written where the build would
 * have put it.
 */
function fakeRepo(box, version, assetBytes) {
  const repoDir = path.join(box, "repo");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "nx-hub", version }));
  fs.copyFileSync(RELEASE_SCRIPT, path.join(repoDir, "scripts/release.sh"));
  fs.chmodSync(path.join(repoDir, "scripts/release.sh"), 0o755);
  const assetName = `NX-Hub-${version}-linux.AppImage`;
  fs.writeFileSync(path.join(repoDir, "dist", assetName), assetBytes);

  const binDir = path.join(box, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const ghLog = path.join(box, "gh.log");
  fs.writeFileSync(path.join(binDir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\nexit 1\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(binDir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return { repoDir, binDir, ghLog, assetName, dist: path.join(repoDir, "dist") };
}

test("release.sh --dry-run signs every asset and publishes nothing", async (t) => {
  const box = tempBox(t, "nxhub-release-sign-");
  const version = "9.9.9";
  const assetBytes = crypto.randomBytes(9000);
  const repo = fakeRepo(box, version, assetBytes);

  // a real keypair from the real keygen script, in a throwaway directory
  const keyDir = path.join(box, "nx-signing");
  const keygenOut = execFileSync("bash", [GEN_SCRIPT, "--dir", keyDir], {
    encoding: "utf8",
    env: scriptEnv({ HOME: box }),
    timeout: 60000,
  });
  const pubHex = keygenOut.match(/\b([0-9a-f]{64})\b/)[1];

  const out = execFileSync("bash", [path.join(repo.repoDir, "scripts/release.sh"), "--skip-win", "--dry-run"], {
    cwd: repo.repoDir,
    encoding: "utf8",
    timeout: 60000,
    env: scriptEnv({ HOME: box, NX_SIGNING_DIR: keyDir, PATH: `${repo.binDir}:${path.dirname(process.execPath)}:${process.env.PATH}` }),
  });

  const sigFile = path.join(repo.dist, `${repo.assetName}.sig`);
  assert.ok(fs.existsSync(sigFile), `release.sh wrote the signature:\n${out}`);
  const sigText = fs.readFileSync(sigFile, "utf8");
  assert.match(sigText, /^[0-9a-f]{128}\n$/, "one line of hex, nothing else");

  // the hub's verifier accepts what the release script produced — the whole point
  pin(t, "releasesh", pubHex);
  assert.strictEqual(
    await provenance.verifyAsset("releasesh", path.join(repo.dist, repo.assetName), sigText),
    true,
    "the signature verifies against the pinned public half"
  );
  assert.strictEqual(
    await provenance.verifyAsset("releasesh", crypto.randomBytes(9000), sigText),
    false,
    "and not against other bytes"
  );

  assert.ok(out.includes("signing assets"), "the sign step announces itself");
  assert.ok(out.includes(`${repo.assetName}.sig`), "and the .sig is listed among the dry-run artifacts");
  assert.ok(fs.existsSync(path.join(repo.dist, `${repo.assetName}.sha256`)), "checksums still happen");
  assert.ok(
    !fs.existsSync(path.join(repo.dist, `${repo.assetName}.sha256.sig`)),
    "the .sha256 gets no signature of its own — signing the digest already vouches for it"
  );
  assert.ok(!fs.existsSync(repo.ghLog), "a dry run never invokes gh at all");
});

test("release.sh: a machine without the signing key still cuts an unsigned release", (t) => {
  const box = tempBox(t, "nxhub-release-nokey-");
  const repo = fakeRepo(box, "9.9.9", Buffer.from("payload"));

  const out = execFileSync("bash", [path.join(repo.repoDir, "scripts/release.sh"), "--skip-win", "--dry-run"], {
    cwd: repo.repoDir,
    encoding: "utf8",
    timeout: 60000,
    env: scriptEnv({
      HOME: box,
      NX_SIGNING_DIR: path.join(box, "no-key-here"),
      PATH: `${repo.binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    }),
  });

  assert.match(out, /unsigned release/, "it says so plainly");
  assert.ok(!fs.existsSync(path.join(repo.dist, `${repo.assetName}.sig`)), "and writes no signature");
  assert.ok(fs.existsSync(path.join(repo.dist, `${repo.assetName}.sha256`)), "the release is otherwise complete");
});

/* ------------------------------------------------------------------ */
/* the download path                                                   */
/* ------------------------------------------------------------------ */

const OWNER_REPO = "nerdrx/signapp";
const APP_ID = "signapp";
const ARTIFACT_ID = "appimage-linux";
const VERSION = "2.0.0";
const ASSET = `SignApp-${VERSION}-linux.AppImage`;
const PAYLOAD = Buffer.from("#!/bin/sh\n# a signed AppImage\n".repeat(64));

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * One repo, one AppImage, its .sha256 and (unless told otherwise) its .sig.
 * `opts.sigText` replaces the signature body — that is the tampering hook.
 */
function makeData(identity, opts = {}) {
  const payload = opts.payload || PAYLOAD;
  return (base) => {
    const assets = [
      helpers.asset(base, OWNER_REPO, ASSET, payload),
      helpers.asset(base, OWNER_REPO, `${ASSET}.sha256`, Buffer.from(`${sha256(payload)}  ${ASSET}\n`)),
    ];
    if (!opts.noSig) {
      const body = opts.sigText != null ? opts.sigText : `${identity.sign(payload)}\n`;
      assets.push(helpers.asset(base, OWNER_REPO, `${ASSET}.sig`, Buffer.from(body)));
    }
    return {
      repos: { nerdrx: [helpers.repo("nerdrx", "signapp", { description: "signed test app" })] },
      releases: { [OWNER_REPO]: helpers.release(`v${VERSION}`, assets) },
      overlay: null,
    };
  };
}

function harness(mock, env, { owner = "nerdrx" } = {}) {
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
  const release = mock.data.releases[OWNER_REPO];
  const app = {
    id: APP_ID,
    repo: OWNER_REPO,
    owner,
    name: "SignApp",
    latest: { tag: release.tag_name, version: VERSION, publishedAt: null, notes: "", prerelease: false },
    artifacts: discovery.buildArtifacts(release, {}),
  };
  jobs._reset();
  jobs.init({
    emit,
    github: client,
    relaunch: null,
    engineLoader: null,
    engine: {
      async install({ artifact, filePath, ctx }) {
        got.bytes = fs.readFileSync(filePath);
        const dest = path.join(ctx.installRoot, "nx", APP_ID, artifact.id);
        fs.mkdirSync(dest, { recursive: true });
        return { version: artifact.version, path: dest, launchable: true };
      },
    },
    resolve: (appId, artifactId) => ({ app, artifact: app.artifacts.find((a) => a.id === artifactId) || null }),
  });
  return {
    app,
    got,
    events,
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

async function scaffold(t, identity, opts = {}) {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ makeData: makeData(identity, opts) });
  t.after(async () => {
    jobs._reset();
    await mock.close();
    env.cleanup();
  });
  return { env, mock };
}

test("install: a valid signature verifies and the install proceeds", async (t) => {
  const id = makeIdentity();
  pin(t, "nerdrx", id.pubHex);
  const { env, mock } = await scaffold(t, id);
  const h = harness(mock, env);

  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-done", `job failed: ${done.message}`);
  assert.strictEqual(sha256(h.got.bytes), sha256(PAYLOAD), "the engine got the real asset");
  assert.ok(
    h.messages().some((m) => /signature verified/i.test(m)),
    `the verification is visible in the job messages: ${JSON.stringify(h.messages())}`
  );
  assert.strictEqual(h.app.artifacts[0].hasSignature, true);
});

test("install: a signature that does not match hard-fails the job, with no fallback", async (t) => {
  const id = makeIdentity();
  const impostor = makeIdentity();
  pin(t, "nerdrx", id.pubHex);
  // correctly formed, signs the right bytes, wrong key — the whole attack, in one line
  const { env, mock } = await scaffold(t, id, { sigText: `${impostor.sign(PAYLOAD)}\n` });
  const h = harness(mock, env);

  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-error", "the job fails");
  assert.match(done.message || done.error || "", /signature verification failed — refusing to install/);
  assert.strictEqual(h.got.bytes, undefined, "the engine was never handed the file");
  const leftovers = fs.existsSync(config.downloadsDir()) ? fs.readdirSync(config.downloadsDir()) : [];
  assert.deepStrictEqual(leftovers, [], "and the rejected bytes are deleted, not left to be reused");
});

test("install: a garbled .sig is a failure, not a shrug", async (t) => {
  const id = makeIdentity();
  pin(t, "nerdrx", id.pubHex);
  const { env, mock } = await scaffold(t, id, { sigText: "not a signature\n" });
  const h = harness(mock, env);
  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-error");
  assert.match(done.message || done.error || "", /signature verification failed/);
});

test("install: an unsigned release installs by default and refuses under requireSignatures", async (t) => {
  const id = makeIdentity();
  pin(t, "nerdrx", id.pubHex);
  const { env, mock } = await scaffold(t, id, { noSig: true });

  const h = harness(mock, env);
  assert.strictEqual(h.app.artifacts[0].hasSignature, false);
  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-done", `unsigned installs by default: ${done.message}`);
  assert.ok(!h.messages().some((m) => /signature/i.test(m)), "and says nothing about signatures");

  // now demand them
  config.save({ requireSignatures: true });
  const h2 = harness(mock, env);
  const done2 = await h2.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done2.type, "job-error", "requireSignatures refuses the same release");
  assert.match(done2.message || done2.error || "", /unsigned asset from a pinned owner/);
  assert.strictEqual(h2.got.bytes, undefined);
});

test("install: an unpinned owner's signature is neither trusted nor an obstacle", async (t) => {
  const id = makeIdentity();
  pin(t, "nerdrx", id.pubHex);
  const { env, mock } = await scaffold(t, id, { sigText: `${makeIdentity().sign(PAYLOAD)}\n` });

  // same release, same bad signature — but the app belongs to someone we do not pin
  const h = harness(mock, env, { owner: "someone-else" });
  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-done", "a signature we cannot judge is not a verdict");
  assert.ok(!h.messages().some((m) => /signature verified/i.test(m)), "and nothing claims it was verified");

  // requireSignatures binds pinned owners only — an unpinned owner is unaffected
  config.save({ requireSignatures: true });
  const h2 = harness(mock, env, { owner: "someone-else" });
  const done2 = await h2.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done2.type, "job-done");
});

test("install: a delta-reconstructed file is signature-checked like any other", async (t) => {
  if (spawnSync("zstd", ["--version"]).status !== 0) return t.skip("zstd not installed");

  const id = makeIdentity();
  pin(t, "nerdrx", id.pubHex);

  // two builds that share most of their bytes, and a real zstd patch between them
  const box = tempBox(t, "nxhub-sign-delta-");
  const shared = crypto.createHash("sha512").update("nx-sign-delta").digest();
  const body = Buffer.concat(Array.from({ length: 300 }, (_, i) => Buffer.concat([shared, Buffer.from(`:${i}:`)])));
  const prev = Buffer.concat([body, Buffer.from("\n--- 1.0.0 ---\n")]);
  const next = Buffer.concat([body, Buffer.from("\n--- 2.0.0, the signed one ---\n")]);
  const prevFile = path.join(box, "prev.bin");
  const nextFile = path.join(box, "next.bin");
  const patchFile = path.join(box, "patch.zpatch");
  fs.writeFileSync(prevFile, prev);
  fs.writeFileSync(nextFile, next);
  execFileSync("zstd", ["-q", "-f", "--patch-from", prevFile, "--long=27", nextFile, "-o", patchFile]);
  const patchBytes = fs.readFileSync(patchFile);

  const env = helpers.useTempEnv();
  const stateStore = require("../../src/main/state");
  const mock = await helpers.startMockGitHub({
    makeData: (base) => {
      const assets = [
        helpers.asset(base, OWNER_REPO, ASSET, next),
        helpers.asset(base, OWNER_REPO, `${ASSET}.sha256`, Buffer.from(`${sha256(next)}  ${ASSET}\n`)),
        helpers.asset(base, OWNER_REPO, `${ASSET}.sig`, Buffer.from(`${id.sign(next)}\n`)),
        helpers.asset(base, OWNER_REPO, `${ASSET}.from-1.0.0.zpatch`, patchBytes),
      ];
      return {
        repos: { nerdrx: [helpers.repo("nerdrx", "signapp", {})] },
        releases: { [OWNER_REPO]: helpers.release(`v${VERSION}`, assets) },
        overlay: null,
      };
    },
  });
  t.after(async () => {
    jobs._reset();
    await mock.close();
    env.cleanup();
  });

  // pretend 1.0.0 is installed, with the kept original the appimage engine records
  const installDir = path.join(env.installRoot, "nx", APP_ID, ARTIFACT_ID);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "SignApp-1.0.0-linux.AppImage"), prev);
  fs.writeFileSync(
    path.join(installDir, ".nx-manifest.json"),
    JSON.stringify({ version: "1.0.0", kind: "appimage", appImageFile: "SignApp-1.0.0-linux.AppImage" })
  );
  stateStore.recordInstall(APP_ID, ARTIFACT_ID, { version: "1.0.0", path: installDir, launchable: true });

  const h = harness(mock, env);
  const done = await h.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done.type, "job-done", `job failed: ${done.message}`);
  const msgs = h.messages();
  assert.ok(msgs.some((m) => /delta applied/i.test(m)), `the delta path ran: ${JSON.stringify(msgs)}`);
  assert.ok(msgs.some((m) => /signature verified/i.test(m)), "and the reconstruction was still signature-checked");
  assert.strictEqual(sha256(h.got.bytes), sha256(next));

  // and a reconstruction the signature does not cover is refused just the same
  const env2 = helpers.useTempEnv();
  const impostor = makeIdentity();
  const mock2 = await helpers.startMockGitHub({
    makeData: (base) => ({
      repos: { nerdrx: [helpers.repo("nerdrx", "signapp", {})] },
      releases: {
        [OWNER_REPO]: helpers.release(`v${VERSION}`, [
          helpers.asset(base, OWNER_REPO, ASSET, next),
          helpers.asset(base, OWNER_REPO, `${ASSET}.sha256`, Buffer.from(`${sha256(next)}  ${ASSET}\n`)),
          helpers.asset(base, OWNER_REPO, `${ASSET}.sig`, Buffer.from(`${impostor.sign(next)}\n`)),
          helpers.asset(base, OWNER_REPO, `${ASSET}.from-1.0.0.zpatch`, patchBytes),
        ]),
      },
      overlay: null,
    }),
  });
  t.after(async () => {
    jobs._reset();
    await mock2.close();
    env2.cleanup();
  });
  const installDir2 = path.join(env2.installRoot, "nx", APP_ID, ARTIFACT_ID);
  fs.mkdirSync(installDir2, { recursive: true });
  fs.writeFileSync(path.join(installDir2, "SignApp-1.0.0-linux.AppImage"), prev);
  fs.writeFileSync(
    path.join(installDir2, ".nx-manifest.json"),
    JSON.stringify({ version: "1.0.0", kind: "appimage", appImageFile: "SignApp-1.0.0-linux.AppImage" })
  );
  stateStore.recordInstall(APP_ID, ARTIFACT_ID, { version: "1.0.0", path: installDir2, launchable: true });

  const h2 = harness(mock2, env2);
  const done2 = await h2.wait(jobs.install(APP_ID, ARTIFACT_ID));
  assert.strictEqual(done2.type, "job-error", "a perfectly reconstructed file with a bad signature is still refused");
  assert.match(done2.message || done2.error || "", /signature verification failed/);
});
