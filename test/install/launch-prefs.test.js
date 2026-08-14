"use strict";
// v0.2: launch() honours appPrefs.launchArgs / launchEnv, and desktop-entry
// creation follows settings.createDesktopEntries.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const util = require("../../src/main/install/util");
const desktop = require("../../src/main/install/desktop");
const H = require("./helpers");

const app = { id: "banish-protocol", name: "LIMBO PROTOCOL", tagline: "Co-op roguelite", repo: "nerdrx/banish-protocol" };
const artifact = {
  id: "archive-dir-linux",
  label: "Linux build",
  kind: "archive-dir",
  platform: "linux",
  assetName: "limbo-linux.tar.gz",
  version: "1.0.0",
};

/** A launcher script that records its argv and a couple of env vars. */
function recorder(outFile) {
  return `#!/bin/sh
printf 'args=%s\\n' "$*" > ${JSON.stringify(outFile)}
printf 'NX_MODE=%s\\n' "$NX_MODE" >> ${JSON.stringify(outFile)}
printf 'NX_EXTRA=%s\\n' "$NX_EXTRA" >> ${JSON.stringify(outFile)}
printf 'PATH_SET=%s\\n' "$([ -n "$PATH" ] && echo yes || echo no)" >> ${JSON.stringify(outFile)}
`;
}

async function waitForFile(file, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const text = await fsp.readFile(file, "utf8");
      if (text.includes("PATH_SET=")) return text;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`launcher never wrote ${file}`);
}

async function installRecorder(box, ctx, outFile) {
  const src = path.join(box.root, "src-launch");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, { "banish-protocol": { content: recorder(outFile), mode: 0o755 } });
  const tarball = H.tarGz(src, path.join(box.downloads, "limbo-1.0.0-linux.tar.gz"));
  return engine.install({ app, artifact, filePath: tarball, ctx });
}

/* ---------------- the merge itself ---------------- */

test("launchExtras appends args and layers env over the inherited one", () => {
  const base = { args: ["--from-overlay"], env: { KEEP: "1", NX_MODE: "default" } };
  const merged = util.launchExtras(
    { appPrefs: { launchArgs: ["--user", "--flags"], launchEnv: { NX_MODE: "vr", NX_EXTRA: "2" } } },
    base
  );
  assert.deepStrictEqual(merged.args, ["--from-overlay", "--user", "--flags"], "user args are APPENDED");
  assert.strictEqual(merged.env.KEEP, "1", "inherited env survives");
  assert.strictEqual(merged.env.NX_MODE, "vr", "user env wins");
  assert.strictEqual(merged.env.NX_EXTRA, "2");

  // no prefs at all → nothing changes, and the process env is inherited
  const bare = util.launchExtras({}, {});
  assert.deepStrictEqual(bare.args, []);
  assert.strictEqual(bare.env.PATH, process.env.PATH);

  // junk prefs are ignored rather than crashing a launch
  const junk = util.launchExtras({ appPrefs: { launchArgs: "not-an-array", launchEnv: [1, 2] } }, { args: ["a"] });
  assert.deepStrictEqual(junk.args, ["a"]);
  assert.strictEqual(util.normCtx({}).appPrefs && typeof util.normCtx({}).appPrefs, "object");
});

/* ---------------- real launches ---------------- */

test("archive-dir launch passes appPrefs launchArgs and launchEnv to the binary", async (t) => {
  const box = await H.makeSandbox("launch-archive");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const outFile = path.join(box.root, "launch-record.txt");
  const ctx = H.makeCtx(box, {
    appPrefs: { launchArgs: ["--fullscreen", "--seed=7"], launchEnv: { NX_MODE: "vr", NX_EXTRA: "yes" } },
  });
  const res = await installRecorder(box, ctx, outFile);

  const result = await engine.launch({ app, artifact, installedPath: res.path, ctx });
  assert.deepStrictEqual(result.args, ["--fullscreen", "--seed=7"]);

  const text = await waitForFile(outFile);
  assert.match(text, /^args=--fullscreen --seed=7$/m);
  assert.match(text, /^NX_MODE=vr$/m);
  assert.match(text, /^NX_EXTRA=yes$/m);
  assert.match(text, /^PATH_SET=yes$/m, "the normal environment is still inherited");
});

test("no launch prefs → the binary is started exactly as before", async (t) => {
  const box = await H.makeSandbox("launch-plain");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const outFile = path.join(box.root, "plain-record.txt");
  const ctx = H.makeCtx(box);
  const res = await installRecorder(box, ctx, outFile);
  const result = await engine.launch({ app, artifact, installedPath: res.path, ctx });
  assert.deepStrictEqual(result.args, []);

  const text = await waitForFile(outFile);
  assert.match(text, /^args=$/m);
  assert.match(text, /^NX_MODE=$/m);
});

test("appimage launch merges prefs on top of the sandbox environment", async (t) => {
  const box = await H.makeSandbox("launch-appimage");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const appImageApp = { id: "ogb", name: "OGB NX-Patches", repo: "nerdrx/OscGoesBrrr-NX-Patches" };
  const appImageArtifact = {
    id: "appimage-linux",
    label: "Linux app",
    kind: "appimage",
    platform: "linux",
    assetName: "OGB-3.1.0-linux.AppImage",
    version: "3.1.0",
  };
  const file = await H.writeFakeAppImage(path.join(box.downloads, "OGB-3.1.0-linux.AppImage"), { electron: true });
  const ctx = H.makeCtx(box, { appPrefs: { launchArgs: ["--debug"], launchEnv: { NX_MODE: "osc" } } });
  const res = await engine.install({ app: appImageApp, artifact: appImageArtifact, filePath: file, ctx });

  // swap AppRun for a recorder so the launch is observable
  const outFile = path.join(box.root, "apprun-record.txt");
  const appRun = path.join(res.path, "AppRun");
  await fsp.writeFile(appRun, `${recorder(outFile)}printf 'SANDBOX=%s\\n' "$ELECTRON_DISABLE_SANDBOX" >> ${JSON.stringify(outFile)}\n`);
  await fsp.chmod(appRun, 0o755);

  const result = await engine.launch({ app: appImageApp, artifact: appImageArtifact, installedPath: res.path, ctx });
  assert.deepStrictEqual(result.args, ["--debug"]);
  const text = await waitForFile(outFile);
  assert.match(text, /^args=--debug$/m);
  assert.match(text, /^NX_MODE=osc$/m);
  assert.match(text, /^SANDBOX=1$/m, "the chrome-sandbox workaround is not lost");
});

test("tarball-prefix launch appends user args after the overlay's own", async (t) => {
  const box = await H.makeSandbox("launch-tarball");
  t.after(() => H.cleanup(box));

  const outFile = path.join(box.root, "prefix-record.txt");
  const prefix = path.join(box.root, "prefix");
  const src = path.join(box.root, "src-prefix");
  await H.buildTree(path.join(src, "usr", "bin"), { "wivrn-dashboard": { content: recorder(outFile), mode: 0o755 } });
  const tarball = H.tarGz(src, path.join(box.downloads, "wivrn-1.4.0.tar.gz"));

  const wivrn = { id: "wivrn-nx", name: "WiVRn NX", repo: "nerdrx/wivrn-nx" };
  const prefixArtifact = {
    id: "tarball-prefix-linux",
    label: "Linux server",
    kind: "tarball-prefix",
    platform: "linux",
    stripPrefix: "usr/",
    prefix,
    launchCmd: `${path.join(prefix, "bin", "wivrn-dashboard")} --overlay-arg`,
    assetName: "wivrn-1.4.0.tar.gz",
    version: "1.4.0",
  };
  const ctx = H.makeCtx(box, { appPrefs: { launchArgs: ["--user-arg"], launchEnv: { NX_MODE: "dash" } } });

  const res = await engine.install({ app: wivrn, artifact: prefixArtifact, filePath: tarball, ctx });
  const result = await engine.launch({ app: wivrn, artifact: prefixArtifact, installedPath: res.path, ctx });
  assert.deepStrictEqual(result.args, ["--overlay-arg", "--user-arg"]);

  const text = await waitForFile(outFile);
  assert.match(text, /^args=--overlay-arg --user-arg$/m);
  assert.match(text, /^NX_MODE=dash$/m);
});

/* ---------------- desktop entries ---------------- */

test("createDesktopEntries=false skips the .desktop file entirely", async (t) => {
  const box = await H.makeSandbox("desktop-off");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box, { settings: { createDesktopEntries: false } });
  const res = await installRecorder(box, ctx, path.join(box.root, "unused.txt"));

  const entry = desktop.desktopFilePath(app, artifact);
  assert.strictEqual(await H.exists(entry), false, "no menu entry was created");
  assert.deepStrictEqual(H.readManifestSync(res.path).desktopEntries, [], "and none is recorded");
  assert.strictEqual(res.launchable, true, "the app is still launchable from the hub");
  assert.ok(ctx.logs.some((l) => /createDesktopEntries is off/.test(l)));
});

test("createDesktopEntries=true (default) still writes the entry, uninstall removes it", async (t) => {
  const box = await H.makeSandbox("desktop-on");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box); // no setting → default behaviour
  const res = await installRecorder(box, ctx, path.join(box.root, "unused.txt"));
  const entry = desktop.desktopFilePath(app, artifact);
  assert.strictEqual(await H.exists(entry), true);
  assert.deepStrictEqual(H.readManifestSync(res.path).desktopEntries, [entry]);

  // turning the setting off later must not strand the entry on uninstall
  const offCtx = H.makeCtx(box, { settings: { createDesktopEntries: false } });
  await engine.uninstall({ app, artifact, installedPath: res.path, ctx: offCtx });
  assert.strictEqual(await H.exists(entry), false, "an existing entry is still removed");
});
