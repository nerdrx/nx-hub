"use strict";
// blender-addon, generic-zip and the windows kinds.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const windows = require("../../src/main/install/windows");
const H = require("./helpers");

// ---------------------------------------------------------------- blender ---

const blenderApp = {
  id: "quadforge",
  name: "QuadForge",
  tagline: "Auto-retopology for Blender",
  repo: "nerdrx/quadforge",
};

async function addonZip(box, name, version = "1.0.0") {
  const src = path.join(box.root, `addon-src-${name}`);
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, {
    "quadforge/__init__.py": `bl_info = {"name": "QuadForge", "version": (1, 0, 0)}\n# ${version}\n`,
    "quadforge/remesher.py": "def run(): pass\n",
    "quadforge/data/weights.bin": "WEIGHTS",
  });
  return H.zipWithModes(src, path.join(box.downloads, name));
}

test("blender-addon: unzips into addonsDir, records the folder, uninstalls it", async (t) => {
  const box = await H.makeSandbox("blender");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const addonsDir = path.join(box.home, ".config", "blender", "5.2", "scripts", "addons");
  const zip = await addonZip(box, "quadforge-1.0.0.zip");
  const ctx = H.makeCtx(box);
  const artifact = {
    id: "blender-addon-linux",
    label: "Blender addon",
    kind: "blender-addon",
    platform: "linux",
    addonsDir,
    assetName: "quadforge-1.0.0.zip",
    version: "1.0.0",
  };

  const res = await engine.install({ app: blenderApp, artifact, filePath: zip, ctx });

  assert.strictEqual(res.launchable, false, "blender addons are not launchable");
  assert.ok(await H.exists(path.join(addonsDir, "quadforge", "__init__.py")));
  assert.ok(await H.exists(path.join(addonsDir, "quadforge", "data", "weights.bin")));

  const m = H.readManifestSync(res.path);
  assert.strictEqual(m.kind, "blender-addon");
  assert.deepStrictEqual(m.files, [path.join(addonsDir, "quadforge")], "top-level folder recorded");
  assert.deepStrictEqual(m.desktopEntries, [], "no desktop entry");
  assert.strictEqual(m.addonsDir, addonsDir);

  await engine.uninstall({ app: blenderApp, artifact, installedPath: res.path, ctx });
  assert.strictEqual(await H.exists(path.join(addonsDir, "quadforge")), false, "addon removed");
  assert.ok(await H.exists(addonsDir), "the addons dir itself stays");
  assert.strictEqual(await H.exists(res.path), false);
});

test("blender-addon: reinstall replaces the folder without leaving stale files", async (t) => {
  const box = await H.makeSandbox("blender-update");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const addonsDir = path.join(box.home, ".config", "blender", "5.2", "scripts", "addons");
  const ctx = H.makeCtx(box);
  const artifact = {
    id: "blender-addon-linux",
    kind: "blender-addon",
    platform: "linux",
    addonsDir,
    assetName: "quadforge-1.0.0.zip",
    version: "1.0.0",
  };
  const first = await engine.install({
    app: blenderApp,
    artifact,
    filePath: await addonZip(box, "quadforge-1.0.0.zip"),
    ctx,
  });
  await fsp.writeFile(path.join(addonsDir, "quadforge", "removed_in_v2.py"), "old");

  const second = await engine.install({
    app: blenderApp,
    artifact: { ...artifact, assetName: "quadforge-1.1.0.zip", version: "1.1.0" },
    filePath: await addonZip(box, "quadforge-1.1.0.zip", "1.1.0"),
    ctx,
  });

  assert.strictEqual(second.path, first.path);
  assert.strictEqual(
    await H.exists(path.join(addonsDir, "quadforge", "removed_in_v2.py")),
    false,
    "stale file from the old version is gone"
  );
  assert.ok(await H.exists(path.join(addonsDir, "quadforge", "__init__.py")));
  assert.strictEqual(H.readManifestSync(second.path).version, "1.1.0");
});

test("blender-addon: launch is rejected with an explanation", async (t) => {
  const box = await H.makeSandbox("blender-launch");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const addonsDir = path.join(box.home, "addons");
  const ctx = H.makeCtx(box);
  const artifact = {
    id: "blender-addon-linux",
    kind: "blender-addon",
    addonsDir,
    assetName: "quadforge-1.0.0.zip",
    version: "1.0.0",
  };
  const res = await engine.install({
    app: blenderApp,
    artifact,
    filePath: await addonZip(box, "quadforge-1.0.0.zip"),
    ctx,
  });
  await assert.rejects(
    () => engine.launch({ app: blenderApp, artifact, installedPath: res.path, ctx }),
    /inside Blender/
  );
});

// ------------------------------------------------------------ generic-zip ---

test("generic-zip: parks the asset in nx/downloads and cleans it up on uninstall", async (t) => {
  const box = await H.makeSandbox("generic-zip");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const app = { id: "petri", name: "Petri", repo: "nerdrx/petri" };
  const artifact = {
    id: "generic-zip-linux",
    kind: "generic-zip",
    platform: "linux",
    assetName: "petri-assets.zip",
    version: "3.1",
  };
  const src = path.join(box.downloads, "petri-assets.zip");
  await fsp.writeFile(src, "PK not really a zip but never extracted");

  const ctx = H.makeCtx(box);
  const res = await engine.install({ app, artifact, filePath: src, ctx });

  const dest = path.join(box.installRoot, "nx", "downloads", "petri-assets.zip");
  assert.strictEqual(res.launchable, false);
  assert.strictEqual(res.downloadPath, dest);
  assert.ok(await H.exists(dest), "asset copied into nx/downloads");

  const m = H.readManifestSync(res.path);
  assert.deepStrictEqual(m.files, [dest], "the download is recorded as an outside file");
  assert.strictEqual(m.binary, null);
  assert.deepStrictEqual(m.desktopEntries, []);

  // no stray .part files
  const dl = await fsp.readdir(path.dirname(dest));
  assert.deepStrictEqual(dl, ["petri-assets.zip"]);

  await assert.rejects(
    () => engine.launch({ app, artifact, installedPath: res.path, ctx }),
    /download-only/
  );

  await engine.uninstall({ app, artifact, installedPath: res.path, ctx });
  assert.strictEqual(await H.exists(dest), false, "download removed");
  assert.strictEqual(await H.exists(res.path), false);
});

// ---------------------------------------------------------------- windows ---

const winApp = { id: "pulsenx", name: "PulseNX", repo: "nerdrx/pulsenx" };

test("windows kinds: refuse to install on Linux with the contracted message", async (t) => {
  const box = await H.makeSandbox("windows-refuse");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "PulseNX-windows-portable.exe");
  await fsp.writeFile(file, "MZ fake exe");

  for (const kind of ["windows-portable", "windows-zip"]) {
    const artifact = { id: `${kind}-windows`, kind, platform: "windows", assetName: path.basename(file), version: "1.4.0" };
    await assert.rejects(
      () => engine.install({ app: winApp, artifact, filePath: file, ctx }),
      /^Error: Windows artifact — install from the hub on Windows$/,
      kind
    );
    await assert.rejects(
      () => engine.launch({ app: winApp, artifact, installedPath: null, ctx }),
      /Windows artifact/,
      `${kind} launch`
    );
    assert.strictEqual(
      await H.exists(path.join(box.installRoot, "nx", "pulsenx", `${kind}-windows`)),
      false,
      "nothing written on refusal"
    );
  }
  assert.strictEqual(windows.REFUSAL, "Windows artifact — install from the hub on Windows");
});

test("windows kinds: uninstall stays tolerant on Linux (clears leftover state)", async (t) => {
  const box = await H.makeSandbox("windows-uninstall");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const artifact = { id: "windows-zip-windows", kind: "windows-zip", platform: "windows", version: "1" };
  const dir = path.join(box.installRoot, "nx", "pulsenx", "windows-zip-windows");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, ".nx-manifest.json"),
    JSON.stringify({ kind: "windows-zip", files: [], dirs: [], desktopEntries: [], binary: "app.exe" })
  );

  await engine.uninstall({ app: winApp, artifact, installedPath: dir, ctx });
  assert.strictEqual(await H.exists(dir), false);
});

test("windows: exe heuristic prefers the app-named exe over uninstallers and helpers", () => {
  const files = [
    { rel: "PulseNX.exe", size: 40_000_000 },
    { rel: "unins000.exe", size: 3_000_000 },
    { rel: "resources/helper.exe", size: 90_000_000 },
    { rel: "vcredist_x64.exe", size: 20_000_000 },
  ];
  assert.strictEqual(windows.pickExe(files, ["pulsenx", "PulseNX"]), "PulseNX.exe");
  assert.strictEqual(windows.pickExe([{ rel: "a.txt", size: 10 }], ["x"]), null);
});

test("windows: shortcut path lands under the Start-menu NX Hub folder", () => {
  const p = windows.shortcutPath({ id: "pulsenx", name: "PulseNX" }, { label: "PC dashboard" });
  assert.ok(p.endsWith(path.join("Programs", "NX Hub", "PulseNX (PC dashboard).lnk")), p);
});
