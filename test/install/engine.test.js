"use strict";
// Dispatcher contract + desktop-entry helpers + manifest layout.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const desktop = require("../../src/main/install/desktop");
const util = require("../../src/main/install/util");
const H = require("./helpers");

const app = { id: "pulsenx", name: "PulseNX", tagline: "Heart-rate bridge", repo: "nerdrx/pulsenx" };

test("engine: exports exactly the frozen interface", () => {
  for (const fn of ["install", "uninstall", "launch", "getAdbStatus"]) {
    assert.strictEqual(typeof engine[fn], "function", fn);
  }
  assert.strictEqual(engine.install.length, 1, "install takes a single options object");
  assert.deepStrictEqual(
    engine.KINDS.sort(),
    [
      "apk-adb",
      "appimage",
      "archive-dir",
      "blender-addon",
      "blender-theme",
      "generic-zip",
      "tarball-prefix",
      "windows-portable",
      "windows-zip",
    ].sort()
  );
  // every kind in the bundled overlay is dispatchable
  const overlay = require("../../registry/overrides.json");
  for (const cfg of Object.values(overlay.apps || {})) {
    for (const a of cfg.artifacts || []) {
      if (a.skip || !a.kind) continue;
      assert.ok(engine.supports(a.kind), `overlay kind "${a.kind}" is dispatchable`);
    }
  }
});

test("engine: unknown kind fails with a clear message and touches nothing", async (t) => {
  const box = await H.makeSandbox("engine-unknown");
  t.after(() => H.cleanup(box));
  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "thing.bin");
  await fsp.writeFile(file, "x");
  await assert.rejects(
    () =>
      engine.install({
        app,
        artifact: { id: "x", kind: "flatpak-someday" },
        filePath: file,
        ctx,
      }),
    /Unknown install kind "flatpak-someday"/
  );
  assert.deepStrictEqual(await fsp.readdir(box.installRoot), []);
});

test("engine: works with a bare ctx (no log/emitProgress supplied)", async (t) => {
  const box = await H.makeSandbox("engine-barectx");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const file = path.join(box.downloads, "Bare-1.0.AppImage");
  await H.writeFakeAppImage(file);
  const artifact = {
    id: "appimage-linux",
    kind: "appimage",
    assetName: "Bare-1.0.AppImage",
    version: "1.0",
  };
  const res = await engine.install({
    app,
    artifact,
    filePath: file,
    ctx: { installRoot: box.installRoot, dataDir: box.dataDir },
  });
  assert.strictEqual(res.launchable, true);
  assert.ok(await H.exists(path.join(res.path, "AppRun")));
});

test("engine: uninstall/launch honour the kind recorded in the manifest", async (t) => {
  const box = await H.makeSandbox("engine-manifest-kind");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "App-1.0.AppImage");
  await H.writeFakeAppImage(file);
  const artifact = {
    id: "appimage-linux",
    kind: "appimage",
    assetName: "App-1.0.AppImage",
    version: "1.0",
  };
  const res = await engine.install({ app, artifact, filePath: file, ctx });

  // overlay later reclassifies the artifact; the manifest still says appimage
  const reclassified = { ...artifact, kind: "generic-zip" };
  await engine.uninstall({ app, artifact: reclassified, installedPath: res.path, ctx });
  assert.strictEqual(await H.exists(res.path), false);
});

test("engine: install result shape is {version, path, launchable}", async (t) => {
  const box = await H.makeSandbox("engine-shape");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "Shape-2.0.AppImage");
  await H.writeFakeAppImage(file);
  const res = await engine.install({
    app,
    artifact: { id: "appimage-linux", kind: "appimage", assetName: "Shape-2.0.AppImage", version: "2.0" },
    filePath: file,
    ctx,
  });
  assert.deepStrictEqual(Object.keys(res).sort(), ["launchable", "path", "version"]);
  assert.strictEqual(typeof res.launchable, "boolean");
  assert.strictEqual(res.version, "2.0");
});

test("engine: install dir layout is <installRoot>/nx/<appId>/<artifactId>", () => {
  const dir = engine.installDirFor(
    { id: "wivrn-nx" },
    { id: "tarball-prefix-linux" },
    { installRoot: "/tmp/roots" }
  );
  assert.strictEqual(dir, path.join("/tmp/roots", "nx", "wivrn-nx", "tarball-prefix-linux"));
});

test("engine: missing downloaded file is rejected per kind", async (t) => {
  const box = await H.makeSandbox("engine-missing-file");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);
  const ghost = path.join(box.downloads, "not-there.AppImage");
  for (const kind of ["appimage", "archive-dir", "generic-zip", "blender-addon"]) {
    await assert.rejects(
      () =>
        engine.install({
          app,
          artifact: { id: `${kind}-x`, kind, assetName: "not-there.zip", version: "1", addonsDir: box.home },
          filePath: ghost,
          ctx,
        }),
      /Downloaded file missing/,
      kind
    );
  }
});

test("engine: an aborted ctx.signal cancels the install and leaves nothing behind", async (t) => {
  const box = await H.makeSandbox("engine-abort");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const controller = new AbortController();
  controller.abort();
  const ctx = H.makeCtx(box, { signal: controller.signal });

  const file = path.join(box.downloads, "Abort-1.0.AppImage");
  await H.writeFakeAppImage(file);

  await assert.rejects(() =>
    engine.install({
      app,
      artifact: { id: "appimage-linux", kind: "appimage", assetName: "Abort-1.0.AppImage", version: "1.0" },
      filePath: file,
      ctx,
    })
  );

  const installDir = path.join(box.installRoot, "nx", "pulsenx", "appimage-linux");
  assert.strictEqual(await H.exists(installDir), false, "no install dir after cancellation");
  const parent = path.dirname(installDir);
  const left = (await H.exists(parent)) ? await fsp.readdir(parent) : [];
  assert.deepStrictEqual(left, [], `no scratch dirs after cancellation: ${left}`);
});

// ---------------------------------------------------------------- desktop ---

test("desktop: entry naming, creation and removal", async (t) => {
  const box = await H.makeSandbox("desktop");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const artifact = { id: "appimage-linux", label: "PC dashboard" };
  assert.strictEqual(
    desktop.desktopFileName(app, artifact),
    "nx-pulsenx-appimage-linux.desktop"
  );
  assert.strictEqual(
    desktop.desktopFilePath(app, artifact),
    path.join(box.xdgDataHome, "applications", "nx-pulsenx-appimage-linux.desktop")
  );

  const ctx = H.makeCtx(box);
  const file = await desktop.writeDesktopEntry({
    app,
    artifact,
    exec: "/opt/app/AppRun",
    icon: "/opt/app/.DirIcon",
    ctx,
  });
  const text = await fsp.readFile(file, "utf8");
  assert.match(text, /^\[Desktop Entry\]$/m);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^Name=PulseNX$/m);
  assert.match(text, /^Comment=Heart-rate bridge$/m);
  assert.match(text, /^Exec=\/opt\/app\/AppRun$/m);
  assert.match(text, /^Icon=\/opt\/app\/\.DirIcon$/m);
  assert.match(text, /^Terminal=false$/m);
  assert.match(text, /^X-NX-Hub=pulsenx\/appimage-linux$/m);

  assert.strictEqual(await desktop.removeDesktopEntry(file, ctx), true);
  assert.strictEqual(await H.exists(file), false);
  assert.strictEqual(await desktop.removeDesktopEntry(file, ctx), true, "removal is idempotent");
});

test("desktop: paths with spaces are quoted in Exec", async (t) => {
  const box = await H.makeSandbox("desktop-spaces");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);
  const target = "/home/me/My Apps/nx/thing/AppRun";
  const file = await desktop.writeDesktopEntry({
    app,
    artifact: { id: "a" },
    exec: desktop.execArg(target),
    icon: null,
    ctx,
  });
  const text = await fsp.readFile(file, "utf8");
  assert.match(text, /^Exec="\/home\/me\/My Apps\/nx\/thing\/AppRun"$/m);
  assert.ok(!/^Icon=/m.test(text), "no Icon key when there is no icon");
});

test("desktop: findIcon prefers .DirIcon, then share/icons, then loose images", async (t) => {
  const box = await H.makeSandbox("desktop-icons");
  t.after(() => H.cleanup(box));

  const tree = path.join(box.root, "tree");
  await H.buildTree(tree, {
    ".DirIcon": "PNG",
    "usr/share/icons/hicolor/256x256/apps/thing.png": "PNG256",
    "logo.png": "PNGLOGO",
  });
  assert.strictEqual(await desktop.findIcon(tree, ["thing"]), path.join(tree, ".DirIcon"));

  await fsp.rm(path.join(tree, ".DirIcon"));
  assert.strictEqual(
    await desktop.findIcon(tree, ["thing"]),
    path.join(tree, "usr/share/icons/hicolor/256x256/apps/thing.png")
  );

  const bare = path.join(box.root, "bare");
  await H.buildTree(bare, { "readme.txt": "no images here" });
  assert.strictEqual(await desktop.findIcon(bare, ["x"]), null);
});

// ------------------------------------------------------------------- util ---

test("util: stagedInstall swaps atomically and cleans up on failure", async (t) => {
  const box = await H.makeSandbox("util-staged");
  t.after(() => H.cleanup(box));

  const target = path.join(box.installRoot, "nx", "app", "artifact");
  await util.stagedInstall(target, async (stage) => {
    await fsp.writeFile(path.join(stage, "v1"), "one");
  });
  assert.ok(await H.exists(path.join(target, "v1")));

  await assert.rejects(
    () =>
      util.stagedInstall(target, async (stage) => {
        await fsp.writeFile(path.join(stage, "v2"), "two");
        throw new Error("boom");
      }),
    /boom/
  );
  assert.ok(await H.exists(path.join(target, "v1")), "old content survives a failure");
  assert.strictEqual(await H.exists(path.join(target, "v2")), false);
  assert.deepStrictEqual(
    await fsp.readdir(path.dirname(target)),
    ["artifact"],
    "no staging leftovers"
  );
});

test("util: pickBinary heuristics", async (t) => {
  const box = await H.makeSandbox("util-pick");
  t.after(() => H.cleanup(box));

  const tree = path.join(box.root, "tree");
  await H.buildTree(tree, {
    "lib/libbig.so": { content: H.elfBlob(50000), mode: 0o755 },
    "mytool": { content: H.elfBlob(1000), mode: 0o755 },
    "extras/other": { content: H.elfBlob(2000), mode: 0o755 },
  });
  assert.strictEqual(await util.pickBinary(tree, { names: ["mytool"] }), "mytool");
  assert.strictEqual(
    await util.pickBinary(tree, { hint: "extras/other", names: ["mytool"] }),
    "extras/other",
    "hint wins"
  );
  assert.strictEqual(
    await util.pickBinary(tree, { hint: "other", names: ["mytool"] }),
    "extras/other",
    "hint by basename is found anywhere in the tree"
  );
  const empty = path.join(box.root, "empty");
  await H.buildTree(empty, { "notes.md": "hi" });
  assert.strictEqual(await util.pickBinary(empty, { names: ["x"] }), null);
});

test("util: run() never throws for a missing binary and captures output", async () => {
  const missing = await util.run("nx-hub-definitely-not-a-binary", ["--version"]);
  assert.strictEqual(missing.missing, true);
  assert.notStrictEqual(missing.code, 0);

  const ok = await util.run("printf", ["hello"]);
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.stdout, "hello");
});

test("util: manifest round-trip keeps the contracted fields", async (t) => {
  const box = await H.makeSandbox("util-manifest");
  t.after(() => H.cleanup(box));
  const dir = path.join(box.root, "m");
  await util.writeManifest(dir, {
    version: "1.2.3",
    kind: "archive-dir",
    files: ["/abs/one"],
    dirs: ["/abs"],
    desktopEntries: ["/abs/x.desktop"],
    binary: "bin/app",
  });
  const m = await util.readManifest(dir);
  assert.strictEqual(m.version, "1.2.3");
  assert.strictEqual(m.kind, "archive-dir");
  assert.deepStrictEqual(m.files, ["/abs/one"]);
  assert.deepStrictEqual(m.desktopEntries, ["/abs/x.desktop"]);
  assert.strictEqual(m.binary, "bin/app");
  assert.ok(!Number.isNaN(Date.parse(m.installedAt)));
  assert.strictEqual(await util.readManifest(path.join(box.root, "nope")), null);
});
