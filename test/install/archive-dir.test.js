"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const H = require("./helpers");

const app = {
  id: "banish-protocol",
  name: "LIMBO PROTOCOL",
  tagline: "Co-op roguelite",
  repo: "nerdrx/banish-protocol",
};
const baseArtifact = {
  id: "archive-dir-linux",
  label: "Linux build",
  kind: "archive-dir",
  platform: "linux",
  version: "0.9.2",
};

/** A game-build-ish tree: a real launcher, a library, data, a helper. */
async function gameTree(dir) {
  return H.buildTree(dir, {
    "LimboProtocol-0.9.2-linux/banish-protocol": { content: H.elfBlob(2000), mode: 0o755 },
    "LimboProtocol-0.9.2-linux/crashhandler": { content: H.elfBlob(300), mode: 0o755 },
    "LimboProtocol-0.9.2-linux/lib/libgodot.so": { content: H.elfBlob(9000), mode: 0o755 },
    "LimboProtocol-0.9.2-linux/data/game.pck": { content: "PCKDATA".repeat(500) },
    "LimboProtocol-0.9.2-linux/icon.png": { content: "PNGDATA" },
    "LimboProtocol-0.9.2-linux/README.txt": { content: "read me" },
  });
}

test("archive-dir: tar.gz install picks the name-matching binary, flattens the wrapper dir", async (t) => {
  const box = await H.makeSandbox("archive-targz");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "src-targz");
  await fsp.mkdir(src, { recursive: true });
  await gameTree(src);
  const tarball = H.tarGz(src, path.join(box.downloads, "limbo-0.9.2-linux.tar.gz"));

  const ctx = H.makeCtx(box);
  const artifact = { ...baseArtifact, assetName: "limbo-0.9.2-linux.tar.gz" };
  const res = await engine.install({ app, artifact, filePath: tarball, ctx });

  const installDir = path.join(box.installRoot, "nx", "banish-protocol", "archive-dir-linux");
  assert.strictEqual(res.path, installDir);
  assert.strictEqual(res.launchable, true);

  // the single top-level wrapper dir was flattened away
  assert.ok(await H.exists(path.join(installDir, "banish-protocol")), "binary at the top level");
  assert.ok(await H.exists(path.join(installDir, "data", "game.pck")));

  const m = H.readManifestSync(installDir);
  assert.strictEqual(m.kind, "archive-dir");
  assert.strictEqual(m.binary, "banish-protocol", "name match beats the bigger .so and the helper");
  assert.strictEqual(m.desktopEntries.length, 1);

  const text = await fsp.readFile(m.desktopEntries[0], "utf8");
  assert.match(text, /^Name=LIMBO PROTOCOL$/m);
  assert.match(text, /^Exec=.*archive-dir-linux\/banish-protocol$/m);
  assert.match(text, /^Icon=.*icon\.png$/m);

  const st = await fsp.stat(path.join(installDir, m.binary));
  assert.ok(st.mode & 0o111, "launch binary is executable");

  await engine.uninstall({ app, artifact, installedPath: installDir, ctx });
  assert.strictEqual(await H.exists(installDir), false);
  assert.strictEqual(await H.exists(m.desktopEntries[0]), false);
});

test("archive-dir: zip that preserves modes, binHint wins over the heuristic", async (t) => {
  const box = await H.makeSandbox("archive-zip-hint");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "src-zip");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, {
    "bin/start-game.sh": { content: "#!/bin/sh\nexec ./engine\n", mode: 0o755 },
    "engine": { content: H.elfBlob(5000), mode: 0o755 },
    "assets/pack.dat": { content: "DATA".repeat(2000) },
  });
  const zip = H.zipWithModes(src, path.join(box.downloads, "limbo-linux.zip"));

  const ctx = H.makeCtx(box);
  const artifact = {
    ...baseArtifact,
    assetName: "limbo-linux.zip",
    binHint: "bin/start-game.sh",
  };
  const res = await engine.install({ app, artifact, filePath: zip, ctx });

  const m = H.readManifestSync(res.path);
  assert.strictEqual(m.binary, "bin/start-game.sh", "binHint respected over the ELF heuristic");
  assert.strictEqual(res.launchable, true);
});

test("archive-dir: zip without exec bits recovers them from ELF/shebang magic", async (t) => {
  const box = await H.makeSandbox("archive-zip-noexec");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "src-noexec");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, {
    "banish-protocol": { content: H.elfBlob(4000), mode: 0o644 },
    "notes.txt": { content: "plain text, definitely not a binary" },
    "data/blob.dat": { content: "X".repeat(9000) },
  });
  const zip = H.zipNoModes(src, path.join(box.downloads, "limbo-nomodes.zip"));

  // sanity: the zip really did drop the exec bits
  const probe = path.join(box.root, "probe");
  await fsp.mkdir(probe, { recursive: true });
  await require("../../src/main/install/util").extractArchive(zip, probe, null);
  const probeSt = await fsp.stat(path.join(probe, "banish-protocol"));
  assert.strictEqual(probeSt.mode & 0o111, 0, "fixture zip has no exec bits");

  const ctx = H.makeCtx(box);
  const artifact = { ...baseArtifact, assetName: "limbo-nomodes.zip" };
  const res = await engine.install({ app, artifact, filePath: zip, ctx });

  const m = H.readManifestSync(res.path);
  assert.strictEqual(m.binary, "banish-protocol");
  const st = await fsp.stat(path.join(res.path, "banish-protocol"));
  assert.ok(st.mode & 0o111, "exec bit restored on the launcher");
  assert.ok(
    ctx.logs.some((l) => /restored exec bit/.test(l)),
    "recovery is logged"
  );
});

test("archive-dir: archive with nothing executable installs but is not launchable", async (t) => {
  const box = await H.makeSandbox("archive-nobin");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "src-nobin");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, { "docs/readme.md": "# docs", "docs/notes.txt": "notes" });
  const tarball = H.tarGz(src, path.join(box.downloads, "docs-linux.tar.gz"));

  const ctx = H.makeCtx(box);
  const artifact = { ...baseArtifact, assetName: "docs-linux.tar.gz" };
  const res = await engine.install({ app, artifact, filePath: tarball, ctx });

  assert.strictEqual(res.launchable, false);
  const m = H.readManifestSync(res.path);
  assert.strictEqual(m.binary, null);
  assert.deepStrictEqual(m.desktopEntries, [], "no desktop entry without a launch target");
  await assert.rejects(
    () => engine.launch({ app, artifact, installedPath: res.path, ctx }),
    /No launch binary/
  );
});

test("archive-dir: a corrupt archive leaves no install dir behind", async (t) => {
  const box = await H.makeSandbox("archive-corrupt");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const bad = path.join(box.downloads, "broken-linux.tar.gz");
  await fsp.writeFile(bad, "this is not a tarball at all");

  const ctx = H.makeCtx(box);
  const artifact = { ...baseArtifact, assetName: "broken-linux.tar.gz" };
  await assert.rejects(() => engine.install({ app, artifact, filePath: bad, ctx }), /tar/i);

  const installDir = path.join(box.installRoot, "nx", "banish-protocol", "archive-dir-linux");
  assert.strictEqual(await H.exists(installDir), false);
  const parent = path.dirname(installDir);
  const left = (await H.exists(parent)) ? await fsp.readdir(parent) : [];
  assert.deepStrictEqual(left, [], `no staging dirs left: ${left}`);
});

test("archive-dir: unsupported extension is rejected with a clear message", async (t) => {
  const box = await H.makeSandbox("archive-unsupported");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const f = path.join(box.downloads, "thing.rar");
  await fsp.writeFile(f, "rar!");
  const ctx = H.makeCtx(box);
  await assert.rejects(
    () =>
      engine.install({
        app,
        artifact: { ...baseArtifact, assetName: "thing.rar" },
        filePath: f,
        ctx,
      }),
    /Unsupported archive format/
  );
});

test("archive-dir: update replaces the tree and drops stale files", async (t) => {
  const box = await H.makeSandbox("archive-update");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const src1 = path.join(box.root, "v1");
  await fsp.mkdir(src1, { recursive: true });
  await H.buildTree(src1, {
    "banish-protocol": { content: H.elfBlob(1000), mode: 0o755 },
    "old-asset.dat": "gone in v2",
  });
  const t1 = H.tarGz(src1, path.join(box.downloads, "v1.tar.gz"));
  const first = await engine.install({
    app,
    artifact: { ...baseArtifact, assetName: "v1.tar.gz" },
    filePath: t1,
    ctx,
  });
  assert.ok(await H.exists(path.join(first.path, "old-asset.dat")));

  const src2 = path.join(box.root, "v2");
  await fsp.mkdir(src2, { recursive: true });
  await H.buildTree(src2, {
    "banish-protocol": { content: H.elfBlob(1200), mode: 0o755 },
    "new-asset.dat": "hello",
  });
  const t2 = H.tarGz(src2, path.join(box.downloads, "v2.tar.gz"));
  const second = await engine.install({
    app,
    artifact: { ...baseArtifact, assetName: "v2.tar.gz", version: "1.0.0" },
    filePath: t2,
    ctx,
  });

  assert.strictEqual(second.path, first.path);
  assert.strictEqual(await H.exists(path.join(second.path, "old-asset.dat")), false);
  assert.ok(await H.exists(path.join(second.path, "new-asset.dat")));
  assert.strictEqual(H.readManifestSync(second.path).version, "1.0.0");
});
