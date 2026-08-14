"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const H = require("./helpers");

const app = { id: "pulsenx", name: "PulseNX", tagline: "Heart-rate bridge", repo: "nerdrx/pulsenx" };
const artifact = {
  id: "appimage-linux",
  label: "PC dashboard (Linux)",
  kind: "appimage",
  platform: "linux",
  assetName: "PulseNX-1.4.0-linux.AppImage",
  version: "1.4.0",
};

test("appimage: end-to-end install, desktop entry, launch target, uninstall", async (t) => {
  const box = await H.makeSandbox("appimage");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, artifact.assetName);
  await H.writeFakeAppImage(file);

  const res = await engine.install({ app, artifact, filePath: file, ctx });

  const installDir = path.join(box.installRoot, "nx", "pulsenx", "appimage-linux");
  assert.strictEqual(res.path, installDir, "installs into <installRoot>/nx/<appId>/<artifactId>");
  assert.strictEqual(res.version, "1.4.0");
  assert.strictEqual(res.launchable, true);

  // extracted tree is the install dir itself (squashfs-root moved in)
  const appRun = path.join(installDir, "AppRun");
  const st = await fsp.stat(appRun);
  assert.ok(st.mode & 0o111, "AppRun is executable");
  assert.ok(await H.exists(path.join(installDir, "usr", "bin", "realbin")));

  // original .AppImage kept alongside for FUSE-capable machines
  assert.ok(
    await H.exists(path.join(installDir, artifact.assetName)),
    "original AppImage kept alongside"
  );

  // no leftover staging/work dirs
  const appDir = path.dirname(installDir);
  const siblings = await fsp.readdir(appDir);
  assert.deepStrictEqual(siblings, ["appimage-linux"], `no scratch dirs left: ${siblings}`);

  // manifest
  const m = H.readManifestSync(installDir);
  assert.strictEqual(m.kind, "appimage");
  assert.strictEqual(m.version, "1.4.0");
  assert.strictEqual(m.binary, "AppRun");
  assert.deepStrictEqual(m.files, [], "appimage writes nothing outside the install dir");
  assert.strictEqual(m.desktopEntries.length, 1);
  assert.ok(m.installedAt);

  // desktop entry
  const entry = m.desktopEntries[0];
  assert.strictEqual(
    entry,
    path.join(box.xdgDataHome, "applications", "nx-pulsenx-appimage-linux.desktop")
  );
  const text = await fsp.readFile(entry, "utf8");
  assert.match(text, /^\[Desktop Entry\]$/m);
  assert.match(text, /^Name=PulseNX$/m);
  assert.match(text, new RegExp(`^Exec=${appRun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(text, /^Icon=.+/m, "icon extracted from the AppImage");
  assert.ok(!/ELECTRON_DISABLE_SANDBOX/.test(text), "no sandbox workaround without chrome-sandbox");

  // icon points at a real file inside the tree
  const icon = text.match(/^Icon=(.+)$/m)[1];
  assert.ok(await H.exists(icon), `icon exists: ${icon}`);

  // progress phases are the contracted ones
  const phases = [...new Set(ctx.progress.map((p) => p.phase))];
  for (const p of phases) assert.ok(["verify", "extract", "install", "cleanup"].includes(p), p);
  assert.ok(phases.includes("extract"));
  assert.strictEqual(ctx.progress.at(-1).pct, 100);

  // uninstall removes the install dir and the desktop entry
  await engine.uninstall({ app, artifact, installedPath: installDir, ctx });
  assert.strictEqual(await H.exists(installDir), false, "install dir gone");
  assert.strictEqual(await H.exists(entry), false, "desktop entry gone");
});

test("appimage: electron tree gets the ELECTRON_DISABLE_SANDBOX workaround", async (t) => {
  const box = await H.makeSandbox("appimage-electron");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "OGB-linux.AppImage");
  await H.writeFakeAppImage(file, { electron: true });

  const a = { ...artifact, id: "appimage-linux", assetName: "OGB-linux.AppImage" };
  const res = await engine.install({ app, artifact: a, filePath: file, ctx });

  const m = H.readManifestSync(res.path);
  assert.strictEqual(m.sandboxed, true, "chrome-sandbox detected");
  const text = await fsp.readFile(m.desktopEntries[0], "utf8");
  assert.match(text, /^Exec=env ELECTRON_DISABLE_SANDBOX=1 .*AppRun$/m);
});

test("appimage: a failing extraction leaves no partial install and keeps the old one", async (t) => {
  const box = await H.makeSandbox("appimage-fail");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const installDir = path.join(box.installRoot, "nx", "pulsenx", "appimage-linux");

  // first: a good install
  const good = path.join(box.downloads, "good.AppImage");
  await H.writeFakeAppImage(good);
  await engine.install({ app, artifact, filePath: good, ctx });
  assert.ok(await H.exists(path.join(installDir, "AppRun")));

  // then: a broken "update"
  const bad = path.join(box.downloads, "bad.AppImage");
  await H.writeFakeAppImage(bad, { broken: true });
  await assert.rejects(
    () => engine.install({ app, artifact: { ...artifact, version: "2.0.0" }, filePath: bad, ctx }),
    /extraction failed/i
  );

  // old install still intact, no scratch dirs, manifest still the old version
  assert.ok(await H.exists(path.join(installDir, "AppRun")), "previous install survived");
  assert.strictEqual(H.readManifestSync(installDir).version, "1.4.0");
  const siblings = await fsp.readdir(path.dirname(installDir));
  assert.deepStrictEqual(siblings, ["appimage-linux"], `no partial dirs: ${siblings}`);
});

test("appimage: fresh install failure leaves no install dir at all", async (t) => {
  const box = await H.makeSandbox("appimage-fresh-fail");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const bad = path.join(box.downloads, "bad.AppImage");
  await H.writeFakeAppImage(bad, { broken: true });

  await assert.rejects(() => engine.install({ app, artifact, filePath: bad, ctx }));

  const installDir = path.join(box.installRoot, "nx", "pulsenx", "appimage-linux");
  assert.strictEqual(await H.exists(installDir), false, "no install dir created");
  const appDir = path.dirname(installDir);
  const leftovers = (await H.exists(appDir)) ? await fsp.readdir(appDir) : [];
  assert.deepStrictEqual(leftovers, [], `no scratch left behind: ${leftovers}`);
});

test("appimage: extraction without AppRun is rejected", async (t) => {
  const box = await H.makeSandbox("appimage-noapprun");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });
  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, "noapprun.AppImage");
  await H.writeFakeAppImage(file, { noAppRun: true });
  await assert.rejects(
    () => engine.install({ app, artifact, filePath: file, ctx }),
    /no AppRun/i
  );
});

test("appimage: update replaces the tree in place and keeps one desktop entry", async (t) => {
  const box = await H.makeSandbox("appimage-update");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const v1 = path.join(box.downloads, "v1.AppImage");
  await H.writeFakeAppImage(v1);
  const first = await engine.install({ app, artifact, filePath: v1, ctx });
  await fsp.writeFile(path.join(first.path, "STALE"), "old");

  const v2 = path.join(box.downloads, "v2.AppImage");
  await H.writeFakeAppImage(v2);
  const second = await engine.install({
    app,
    artifact: { ...artifact, version: "1.5.0", assetName: "PulseNX-1.5.0-linux.AppImage" },
    filePath: v2,
    ctx,
  });

  assert.strictEqual(second.path, first.path);
  assert.strictEqual(H.readManifestSync(second.path).version, "1.5.0");
  assert.strictEqual(await H.exists(path.join(second.path, "STALE")), false, "old tree replaced");
  const entries = (await fsp.readdir(path.join(box.xdgDataHome, "applications"))).filter((f) =>
    f.endsWith(".desktop")
  );
  assert.deepStrictEqual(entries, ["nx-pulsenx-appimage-linux.desktop"]);
});
