"use strict";
// blender-theme: fan-out into every Blender config tree, exact uninstall.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const H = require("./helpers");

const app = {
  id: "nx-blender",
  name: "NX for Blender",
  tagline: "The NX design language as a Blender theme",
  repo: "nerdrx/nx-blender",
};

const PRESET_REL = path.join("scripts", "presets", "interface_theme");

/** A tarball holding one or more theme presets, as the release ships them. */
async function themeTarball(box, name, themes) {
  const src = path.join(box.root, `theme-src-${name}`);
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, themes);
  return H.tarGz(src, path.join(box.downloads, name));
}

/** Fake Blender config trees: versions that exist because Blender ran once. */
async function blenderVersions(box, versions) {
  const root = path.join(box.home, ".config", "blender");
  for (const v of versions) {
    await fsp.mkdir(path.join(root, v, "scripts", "addons"), { recursive: true });
  }
  return root;
}

function artifact(root, extra = {}) {
  return {
    id: "theme",
    kind: "blender-theme",
    version: "1.0.0",
    assetName: "nx-blender-1.0.0-theme.tar.gz",
    blenderConfigRoot: root,
    ...extra,
  };
}

test("blender-theme: installs into every Blender version found", async (t) => {
  const box = await H.makeSandbox("bltheme");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const root = await blenderVersions(box, ["4.2", "5.2"]);
  // A directory that is not a MAJOR.MINOR version must be ignored.
  await fsp.mkdir(path.join(root, "backup"), { recursive: true });

  const filePath = await themeTarball(box, "nx-theme.tar.gz", { "NX.xml": "<bpy><Theme/></bpy>\n" });
  const ctx = H.makeCtx(box);
  const art = artifact(root);

  const res = await engine.install({ app, artifact: art, filePath, ctx });
  assert.equal(res.launchable, false);

  for (const v of ["4.2", "5.2"]) {
    const installed = path.join(root, v, PRESET_REL, "NX.xml");
    assert.equal(await H.exists(installed), true, `missing preset for ${v}`);
  }
  assert.equal(await H.exists(path.join(root, "backup", PRESET_REL, "NX.xml")), false);

  const manifest = H.readManifestSync(res.path);
  assert.equal(manifest.kind, "blender-theme");
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest.blenderVersions, ["4.2", "5.2"]);

  await engine.uninstall({ app, artifact: art, installedPath: res.path, ctx });
  for (const v of ["4.2", "5.2"]) {
    assert.equal(await H.exists(path.join(root, v, PRESET_REL, "NX.xml")), false);
  }
  // The version tree itself is never ours to remove.
  assert.equal(await H.exists(path.join(root, "5.2")), true);
});

test("blender-theme: an update drops presets the new release no longer ships", async (t) => {
  const box = await H.makeSandbox("bltheme-up");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const root = await blenderVersions(box, ["5.2"]);
  const ctx = H.makeCtx(box);

  const v1 = await themeTarball(box, "v1.tar.gz", {
    "NX.xml": "<bpy>v1</bpy>\n",
    "NX Light.xml": "<bpy>light</bpy>\n",
  });
  const res1 = await engine.install({ app, artifact: artifact(root), filePath: v1, ctx });
  assert.equal(H.readManifestSync(res1.path).files.length, 2);

  const v2 = await themeTarball(box, "v2.tar.gz", { "NX.xml": "<bpy>v2</bpy>\n" });
  const res2 = await engine.install({
    app, artifact: artifact(root, { version: "1.1.0" }), filePath: v2, ctx,
  });

  const dest = path.join(root, "5.2", PRESET_REL);
  assert.equal(await fsp.readFile(path.join(dest, "NX.xml"), "utf8"), "<bpy>v2</bpy>\n");
  assert.equal(await H.exists(path.join(dest, "NX Light.xml")), false);
  assert.equal(H.readManifestSync(res2.path).files.length, 1);
});

test("blender-theme: accepts a bare .xml asset", async (t) => {
  const box = await H.makeSandbox("bltheme-xml");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const root = await blenderVersions(box, ["5.2"]);
  const filePath = path.join(box.downloads, "NX.xml");
  await fsp.writeFile(filePath, "<bpy>bare</bpy>\n");

  const res = await engine.install({
    app, artifact: artifact(root, { assetName: "NX.xml" }), filePath, ctx: H.makeCtx(box),
  });
  assert.equal(
    await fsp.readFile(path.join(root, "5.2", PRESET_REL, "NX.xml"), "utf8"),
    "<bpy>bare</bpy>\n"
  );
  assert.equal(H.readManifestSync(res.path).files.length, 1);
});

test("blender-theme: no config tree — tells the user to start Blender once", async (t) => {
  const box = await H.makeSandbox("bltheme-none");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const root = path.join(box.home, ".config", "blender");
  const filePath = await themeTarball(box, "none.tar.gz", { "NX.xml": "<bpy/>\n" });

  await assert.rejects(
    () => engine.install({ app, artifact: artifact(root), filePath, ctx: H.makeCtx(box) }),
    /start Blender once/i
  );

  // …unless the overlay names the version to create.
  const res = await engine.install({
    app,
    artifact: artifact(root, { defaultBlenderVersion: "5.2" }),
    filePath,
    ctx: H.makeCtx(box),
  });
  assert.equal(await H.exists(path.join(root, "5.2", PRESET_REL, "NX.xml")), true);
  assert.equal(H.readManifestSync(res.path).blenderVersions[0], "5.2");
});

test("blender-theme: rejects an asset with no theme in it, and cannot be launched", async (t) => {
  const box = await H.makeSandbox("bltheme-bad");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const root = await blenderVersions(box, ["5.2"]);
  const filePath = await themeTarball(box, "empty.tar.gz", { "README.md": "no themes here\n" });

  await assert.rejects(
    () => engine.install({ app, artifact: artifact(root), filePath, ctx: H.makeCtx(box) }),
    /No \.xml theme/i
  );

  await assert.rejects(
    () => engine.launch({ app, artifact: artifact(root), installedPath: box.root, ctx: H.makeCtx(box) }),
    /nothing to launch/i
  );
});
