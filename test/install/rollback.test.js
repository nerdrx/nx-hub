"use strict";
// v0.2: staged installs keep the replaced version as <installdir>.prev, and
// rollback swaps it back through a staging rename so a failure can never
// destroy both copies.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const util = require("../../src/main/install/util");
const H = require("./helpers");

const app = { id: "banish-protocol", name: "LIMBO PROTOCOL", repo: "nerdrx/banish-protocol" };
const artifact = {
  id: "archive-dir-linux",
  label: "Linux build",
  kind: "archive-dir",
  platform: "linux",
  assetName: "limbo-linux.tar.gz",
};

/** Build a tar.gz whose launcher prints `marker`, tagged with `version`. */
async function buildArchive(box, version, marker) {
  const src = path.join(box.root, `src-${version}`);
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, {
    "banish-protocol": { content: H.elfBlob(1200), mode: 0o755 },
    "VERSION.txt": marker,
  });
  return H.tarGz(src, path.join(box.downloads, `limbo-${version}-linux.tar.gz`));
}

async function installVersion(box, ctx, version, marker) {
  const filePath = await buildArchive(box, version, marker);
  return engine.install({ app, artifact: { ...artifact, version }, filePath, ctx });
}

test("a dir-based reinstall keeps the replaced version as .prev", async (t) => {
  const box = await H.makeSandbox("rollback-keep");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);

  const first = await installVersion(box, ctx, "1.0.0", "one");
  const installDir = first.path;
  const prevDir = `${installDir}.prev`;
  assert.strictEqual(await H.exists(prevDir), false, "the first install has nothing to keep");

  await installVersion(box, ctx, "2.0.0", "two");
  assert.strictEqual(await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"), "two");
  assert.strictEqual(await H.exists(prevDir), true, "the replaced install is kept");
  assert.strictEqual(await fsp.readFile(path.join(prevDir, "VERSION.txt"), "utf8"), "one");
  assert.strictEqual(H.readManifestSync(prevDir).version, "1.0.0", "and its manifest names the version");

  // a third install replaces the OLD .prev — only one level is kept
  await installVersion(box, ctx, "3.0.0", "three");
  assert.strictEqual(await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"), "three");
  assert.strictEqual(await fsp.readFile(path.join(prevDir, "VERSION.txt"), "utf8"), "two");
  const siblings = await fsp.readdir(path.dirname(installDir));
  assert.deepStrictEqual(
    siblings.filter((n) => n.includes(".prev")),
    [`${path.basename(installDir)}.prev`],
    "exactly one .prev is kept"
  );
  assert.ok(!siblings.some((n) => n.includes(".old-")), "no staging leftovers");
});

test("rollback swaps .prev back in and lets you roll forward again", async (t) => {
  const box = await H.makeSandbox("rollback-swap");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);

  await installVersion(box, ctx, "1.0.0", "one");
  const { path: installDir } = await installVersion(box, ctx, "2.0.0", "two");

  const result = await engine.rollback({ app, artifact, installedPath: installDir, ctx });
  assert.strictEqual(result.path, installDir);
  assert.strictEqual(result.version, "1.0.0", "the restored version is reported back to core");
  assert.strictEqual(await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"), "one");

  // the version we just replaced is now the .prev — rolling again returns to 2.0.0
  assert.strictEqual(await fsp.readFile(path.join(`${installDir}.prev`, "VERSION.txt"), "utf8"), "two");
  const again = await engine.rollback({ app, artifact, installedPath: installDir, ctx });
  assert.strictEqual(again.version, "2.0.0");
  assert.strictEqual(await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"), "two");
});

test("rollback without a kept version fails without touching the install", async (t) => {
  const box = await H.makeSandbox("rollback-none");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);

  const { path: installDir } = await installVersion(box, ctx, "1.0.0", "one");
  await assert.rejects(
    () => engine.rollback({ app, artifact, installedPath: installDir, ctx }),
    /no previous version/i
  );
  assert.strictEqual(await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"), "one", "install untouched");
});

test("a failed swap restores the current install — never loses both copies", async (t) => {
  const box = await H.makeSandbox("rollback-safe");
  t.after(() => H.cleanup(box));

  const installDir = path.join(box.installRoot, "nx", "demo", "archive-dir-linux");
  await H.buildTree(installDir, { "VERSION.txt": "current" });
  await H.buildTree(`${installDir}.prev`, { "VERSION.txt": "previous" });

  // make the .prev un-renameable by turning it into a broken source: we simulate
  // the failure by locking the parent directory against writes
  const parent = path.dirname(installDir);
  const originalRename = fsp.rename;
  let calls = 0;
  const patched = async (from, to) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("EXDEV: simulated failure"), { code: "EXDEV" });
    return originalRename(from, to);
  };
  const fspModule = require("node:fs/promises");
  fspModule.rename = patched;
  try {
    await assert.rejects(() => util.rollbackDir(installDir), /Rollback failed/i);
  } finally {
    fspModule.rename = originalRename;
  }

  assert.strictEqual(
    await fsp.readFile(path.join(installDir, "VERSION.txt"), "utf8"),
    "current",
    "the working install was put straight back"
  );
  assert.strictEqual(await H.exists(`${installDir}.prev`), true, "and the kept copy is still there");
  const leftovers = (await fsp.readdir(parent)).filter((n) => n.includes(".rollback-"));
  assert.deepStrictEqual(leftovers, [], "no staging directory left behind");
});

test("uninstall removes the kept .prev as well", async (t) => {
  const box = await H.makeSandbox("rollback-uninstall");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);

  await installVersion(box, ctx, "1.0.0", "one");
  const { path: installDir } = await installVersion(box, ctx, "2.0.0", "two");
  assert.strictEqual(await H.exists(`${installDir}.prev`), true);

  await engine.uninstall({ app, artifact, installedPath: installDir, ctx });
  assert.strictEqual(await H.exists(installDir), false);
  assert.strictEqual(await H.exists(`${installDir}.prev`), false, "nothing is left behind on disk");
});

test("kinds that write outside their install dir do not offer rollback", () => {
  assert.strictEqual(engine.canRollback("archive-dir"), true);
  assert.strictEqual(engine.canRollback("appimage"), true);
  assert.strictEqual(engine.canRollback("windows-portable"), true);
  assert.strictEqual(engine.canRollback("windows-zip"), true);
  assert.strictEqual(engine.canRollback("tarball-prefix"), false, "writes into a shared prefix");
  assert.strictEqual(engine.canRollback("apk-adb"), false, "lives on the device");
  assert.strictEqual(engine.canRollback("blender-addon"), false);
  assert.strictEqual(engine.canRollback("generic-zip"), false);
});

test("engine.rollback refuses an unsupported kind with a clear message", async (t) => {
  const box = await H.makeSandbox("rollback-refuse");
  t.after(() => H.cleanup(box));
  const ctx = H.makeCtx(box);
  const installDir = path.join(box.installRoot, "nx", "wivrn-nx", "apk-adb-android");
  await H.buildTree(installDir, { ".nx-manifest.json": JSON.stringify({ kind: "apk-adb", version: "1.0" }) });

  await assert.rejects(
    () =>
      engine.rollback({
        app: { id: "wivrn-nx", name: "WiVRn NX" },
        artifact: { id: "apk-adb-android", kind: "apk-adb", label: "APK" },
        installedPath: installDir,
        ctx,
      }),
    /cannot be rolled back/i
  );
});

test("tarball-prefix installs keep no .prev copy", async (t) => {
  const box = await H.makeSandbox("rollback-tarball");
  t.after(() => H.cleanup(box));
  const ctx = H.makeCtx(box);

  const src = path.join(box.root, "src-tar");
  await H.buildTree(path.join(src, "usr", "bin"), { tool: { content: H.elfBlob(200), mode: 0o755 } });
  const tarball = H.tarGz(src, path.join(box.downloads, "tool-1.0.tar.gz"));
  const prefixArtifact = {
    id: "tarball-prefix-linux",
    label: "Server",
    kind: "tarball-prefix",
    platform: "linux",
    stripPrefix: "usr/",
    prefix: path.join(box.root, "prefix"),
    assetName: "tool-1.0.tar.gz",
    version: "1.0",
  };
  const tarApp = { id: "wivrn-nx", name: "WiVRn NX", repo: "nerdrx/wivrn-nx" };

  const first = await engine.install({ app: tarApp, artifact: prefixArtifact, filePath: tarball, ctx });
  await engine.install({
    app: tarApp,
    artifact: { ...prefixArtifact, version: "1.1" },
    filePath: tarball,
    ctx,
  });
  assert.strictEqual(await H.exists(`${first.path}.prev`), false, "no rollback copy for a prefix install");
});
