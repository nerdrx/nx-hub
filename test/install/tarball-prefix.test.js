"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const engine = require("../../src/main/install/engine");
const H = require("./helpers");

const app = {
  id: "wivrn-nx",
  name: "WiVRn NX",
  tagline: "OpenXR streaming to the Pico",
  repo: "nerdrx/wivrn-nx",
};

/** Shaped like the real wivrn-nx-server-*-linux-x86_64.tar.gz. */
async function wivrnTarball(box, name = "wivrn-nx-server-1.2.0-linux-x86_64.tar.gz", opts = {}) {
  const src = path.join(box.root, `src-${name}`);
  await fsp.mkdir(src, { recursive: true });
  const spec = {
    // root-level files that must NOT be installed (outside stripPrefix)
    "README-NX.md": "# WiVRn NX\nRun setcap after install.\n",
    "LICENSE": "GPL",
    "install.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
    // the payload
    "usr/bin/wivrn-server": { content: H.elfBlob(3000), mode: 0o755 },
    "usr/bin/wivrn-dashboard": { content: H.elfBlob(2000), mode: 0o755 },
    "usr/share/applications/io.github.wivrn.wivrn.desktop": "[Desktop Entry]\nName=WiVRn\n",
    "usr/share/icons/hicolor/256x256/apps/wivrn.png": "PNGDATA",
    "usr/lib/libwivrn.so.1": { content: H.elfBlob(1000), mode: 0o755 },
    "usr/share/wivrn/openxr.json": '{"runtime":{}}',
  };
  if (opts.extra) Object.assign(spec, opts.extra);
  await H.buildTree(src, spec);
  return H.tarGz(src, path.join(box.downloads, name));
}

function makeArtifact(over = {}) {
  return {
    id: "tarball-prefix-linux",
    label: "Linux server + dashboard",
    kind: "tarball-prefix",
    platform: "linux",
    stripPrefix: "usr/",
    prefix: null, // set per test to a sandbox path
    launchCmd: null,
    postInstallNote:
      "Re-run: sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server (required after every update)",
    assetName: "wivrn-nx-server-1.2.0-linux-x86_64.tar.gz",
    version: "1.2.0",
    ...over,
  };
}

test("tarball-prefix: installs only what is under stripPrefix, records every file", async (t) => {
  const box = await H.makeSandbox("tarball");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const prefix = path.join(box.home, ".local");
  const tarball = await wivrnTarball(box);
  const ctx = H.makeCtx(box);
  const artifact = makeArtifact({
    prefix,
    launchCmd: path.join(prefix, "bin", "wivrn-dashboard"),
  });

  const res = await engine.install({ app, artifact, filePath: tarball, ctx });

  const installDir = path.join(box.installRoot, "nx", "wivrn-nx", "tarball-prefix-linux");
  assert.strictEqual(res.path, installDir);
  assert.strictEqual(res.version, "1.2.0");
  assert.strictEqual(res.launchable, true, "launchCmd exists on disk after install");

  // the payload landed in the prefix WITHOUT the usr/ component
  const installed = await H.listTree(prefix);
  assert.ok(installed.includes(path.join("bin", "wivrn-server")));
  assert.ok(installed.includes(path.join("bin", "wivrn-dashboard")));
  assert.ok(installed.includes(path.join("share", "wivrn", "openxr.json")));
  assert.ok(installed.includes(path.join("lib", "libwivrn.so.1")));

  // nothing from outside stripPrefix
  assert.ok(!installed.some((f) => /README-NX\.md|LICENSE|install\.sh/.test(f)), installed.join(","));
  assert.ok(!installed.some((f) => f.startsWith("usr")), "usr/ component stripped");
  assert.ok(
    ctx.logs.some((l) => /skipping 3 entr/.test(l)),
    `skip is logged: ${ctx.logs.join(" | ")}`
  );

  // exec bits survive the copy
  const st = await fsp.stat(path.join(prefix, "bin", "wivrn-server"));
  assert.ok(st.mode & 0o111, "server keeps its exec bit");

  // manifest bookkeeping: absolute paths, all of them, outside the install dir
  const m = H.readManifestSync(installDir);
  assert.strictEqual(m.kind, "tarball-prefix");
  assert.strictEqual(m.files.length, 6, `one entry per installed file: ${m.files.join(",")}`);
  for (const f of m.files) {
    assert.ok(path.isAbsolute(f), `absolute: ${f}`);
    assert.ok(await H.exists(f), `recorded file exists: ${f}`);
    assert.ok(!f.startsWith(installDir), "recorded files live outside the install dir");
  }
  assert.ok(m.dirs.includes(path.join(prefix, "bin")));
  assert.ok(m.dirs.includes(path.join(prefix, "share", "icons", "hicolor", "256x256", "apps")));
  assert.deepStrictEqual(m.desktopEntries, [], "the tarball ships its own .desktop files");
  assert.strictEqual(m.prefix, prefix);
  assert.match(m.postInstallNote, /setcap/, "note passed through for core/UI to surface");

  // progress: entry-count driven, contracted phases only
  const phases = [...new Set(ctx.progress.map((p) => p.phase))];
  for (const p of phases) assert.ok(["verify", "extract", "install", "cleanup"].includes(p), p);
  assert.ok(ctx.progress.some((p) => /Installed \d+\/6 files/.test(p.message || "")));
});

test("tarball-prefix: uninstall removes exactly the recorded files and prunes only empty dirs", async (t) => {
  const box = await H.makeSandbox("tarball-uninstall");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const prefix = path.join(box.home, ".local");
  // pre-existing, foreign content in the shared prefix — must survive
  await fsp.mkdir(path.join(prefix, "bin"), { recursive: true });
  await fsp.writeFile(path.join(prefix, "bin", "some-other-tool"), "not ours");
  await fsp.mkdir(path.join(prefix, "share", "fonts"), { recursive: true });
  await fsp.writeFile(path.join(prefix, "share", "fonts", "x.ttf"), "font");

  const tarball = await wivrnTarball(box);
  const ctx = H.makeCtx(box);
  const artifact = makeArtifact({ prefix });

  const res = await engine.install({ app, artifact, filePath: tarball, ctx });
  const m = H.readManifestSync(res.path);

  await engine.uninstall({ app, artifact, installedPath: res.path, ctx });

  // every recorded file is gone
  for (const f of m.files) assert.strictEqual(await H.exists(f), false, `removed: ${f}`);
  assert.strictEqual(await H.exists(res.path), false, "install dir removed");

  // foreign files untouched, and their dirs survive
  assert.ok(await H.exists(path.join(prefix, "bin", "some-other-tool")), "foreign binary kept");
  assert.ok(await H.exists(path.join(prefix, "share", "fonts", "x.ttf")), "foreign font kept");
  assert.ok(await H.exists(prefix), "the prefix itself is never removed");
  assert.ok(await H.exists(path.join(prefix, "bin")), "pre-existing bin/ kept (not ours to delete)");

  // dirs we created and that are now empty are pruned
  assert.strictEqual(
    await H.exists(path.join(prefix, "share", "wivrn")),
    false,
    "empty dir we created is pruned"
  );
  assert.strictEqual(
    await H.exists(path.join(prefix, "share", "icons")),
    false,
    "empty dir tree we created is pruned bottom-up"
  );
  assert.ok(await H.exists(path.join(prefix, "share")), "shared parent kept — it still has fonts/");
});

test("tarball-prefix: uninstall keeps dirs that still hold foreign files", async (t) => {
  const box = await H.makeSandbox("tarball-conservative");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const prefix = path.join(box.home, ".local");
  const tarball = await wivrnTarball(box);
  const ctx = H.makeCtx(box);
  const artifact = makeArtifact({ prefix });
  const res = await engine.install({ app, artifact, filePath: tarball, ctx });

  // user drops something into a dir we created
  await fsp.writeFile(path.join(prefix, "share", "wivrn", "user-config.json"), "{}");

  await engine.uninstall({ app, artifact, installedPath: res.path, ctx });

  assert.ok(
    await H.exists(path.join(prefix, "share", "wivrn", "user-config.json")),
    "user file survives"
  );
  assert.ok(await H.exists(path.join(prefix, "share", "wivrn")), "non-empty dir is never removed");
});

test("tarball-prefix: update removes files the new version dropped", async (t) => {
  const box = await H.makeSandbox("tarball-update");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const prefix = path.join(box.home, ".local");
  const ctx = H.makeCtx(box);

  const v1 = await wivrnTarball(box, "wivrn-1.0.tar.gz", {
    extra: { "usr/bin/wivrn-legacy-tool": { content: H.elfBlob(100), mode: 0o755 } },
  });
  const first = await engine.install({
    app,
    artifact: makeArtifact({ prefix, version: "1.0.0" }),
    filePath: v1,
    ctx,
  });
  assert.ok(await H.exists(path.join(prefix, "bin", "wivrn-legacy-tool")));

  const v2 = await wivrnTarball(box, "wivrn-1.2.tar.gz");
  const second = await engine.install({
    app,
    artifact: makeArtifact({ prefix, version: "1.2.0" }),
    filePath: v2,
    ctx,
  });

  assert.strictEqual(second.path, first.path);
  assert.strictEqual(
    await H.exists(path.join(prefix, "bin", "wivrn-legacy-tool")),
    false,
    "file dropped by the new version is cleaned up"
  );
  assert.ok(await H.exists(path.join(prefix, "bin", "wivrn-server")), "current files still there");
  assert.strictEqual(H.readManifestSync(second.path).version, "1.2.0");
});

test("tarball-prefix: handles a tarball wrapped in a versioned top-level dir", async (t) => {
  const box = await H.makeSandbox("tarball-wrapped");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "wrapped");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, {
    "wivrn-nx-server-1.3.0/README-NX.md": "readme",
    "wivrn-nx-server-1.3.0/usr/bin/wivrn-server": { content: H.elfBlob(500), mode: 0o755 },
    "wivrn-nx-server-1.3.0/usr/share/wivrn/openxr.json": "{}",
  });
  const tarball = H.tarGz(src, path.join(box.downloads, "wrapped.tar.gz"));

  const prefix = path.join(box.home, ".local");
  const ctx = H.makeCtx(box);
  const res = await engine.install({
    app,
    artifact: makeArtifact({ prefix, version: "1.3.0" }),
    filePath: tarball,
    ctx,
  });

  assert.ok(await H.exists(path.join(prefix, "bin", "wivrn-server")));
  assert.strictEqual(await H.exists(path.join(prefix, "README-NX.md")), false);
  assert.strictEqual(H.readManifestSync(res.path).files.length, 2);
});

test("tarball-prefix: missing stripPrefix fails and rolls back every written file", async (t) => {
  const box = await H.makeSandbox("tarball-nostrip");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const src = path.join(box.root, "nostrip");
  await fsp.mkdir(src, { recursive: true });
  await H.buildTree(src, { "opt/thing/bin/tool": { content: "x", mode: 0o755 } });
  const tarball = H.tarGz(src, path.join(box.downloads, "nostrip.tar.gz"));

  const prefix = path.join(box.home, ".local");
  const ctx = H.makeCtx(box);
  await assert.rejects(
    () => engine.install({ app, artifact: makeArtifact({ prefix }), filePath: tarball, ctx }),
    /does not contain "usr"/
  );

  const installDir = path.join(box.installRoot, "nx", "wivrn-nx", "tarball-prefix-linux");
  assert.strictEqual(await H.exists(installDir), false, "no install dir on failure");
  const left = (await H.exists(prefix)) ? await H.listTree(prefix) : [];
  assert.deepStrictEqual(left, [], `prefix untouched: ${left}`);
});

test("tarball-prefix: launchable=false when launchCmd is absent after install", async (t) => {
  const box = await H.makeSandbox("tarball-nolaunch");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const prefix = path.join(box.home, ".local");
  const tarball = await wivrnTarball(box);
  const ctx = H.makeCtx(box);

  const noCmd = await engine.install({
    app,
    artifact: makeArtifact({ prefix, launchCmd: null }),
    filePath: tarball,
    ctx,
  });
  assert.strictEqual(noCmd.launchable, false, "no launchCmd → not launchable");

  const ghost = await engine.install({
    app,
    artifact: makeArtifact({ prefix, launchCmd: path.join(prefix, "bin", "does-not-exist") }),
    filePath: tarball,
    ctx,
  });
  assert.strictEqual(ghost.launchable, false, "launchCmd not on disk → not launchable");
  await assert.rejects(
    () =>
      engine.launch({
        app,
        artifact: makeArtifact({ prefix, launchCmd: path.join(prefix, "bin", "does-not-exist") }),
        installedPath: ghost.path,
        ctx,
      }),
    /not found/
  );
});

test("tarball-prefix: ~ in prefix and launchCmd is expanded", async (t) => {
  const { expandUser } = require("../../src/main/install/util");
  const os = require("node:os");
  assert.strictEqual(expandUser("~/.local"), path.join(os.homedir(), ".local"));
  assert.strictEqual(
    expandUser("~/.local/bin/wivrn-dashboard"),
    path.join(os.homedir(), ".local/bin/wivrn-dashboard")
  );
  assert.strictEqual(expandUser("/abs/path"), "/abs/path");
  assert.strictEqual(expandUser("~"), os.homedir());

  const { resolveLaunch, normStrip } = require("../../src/main/install/tarball-prefix");
  const spec = resolveLaunch("~/.local/bin/wivrn-dashboard --no-gui");
  assert.strictEqual(spec.cmd, path.join(os.homedir(), ".local/bin/wivrn-dashboard"));
  assert.deepStrictEqual(spec.args, ["--no-gui"]);
  assert.strictEqual(normStrip("usr/"), "usr");
  assert.strictEqual(normStrip("./usr//"), "usr");
});

test("copyEntry replaces a RUNNING executable instead of dying with ETXTBSY", async (t) => {
  // The exact shape of the nx-recall 0.5.0 → 0.5.2 update failure: the daemon
  // is running from the installed binary while the engine copies the new one
  // over it. Writing through the name is ETXTBSY; unlink-then-copy is not.
  const { copyEntry } = require("../../src/main/install/util");
  const fsp = require("node:fs/promises");
  const os = require("node:os");
  const { spawn, execFileSync } = require("node:child_process");

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nxhub-etxtbsy-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const running = path.join(dir, "daemon");
  await fsp.copyFile("/bin/sleep", running);
  await fsp.chmod(running, 0o755);
  const child = spawn(running, ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => child.once("spawn", r));

  // Sanity: the kernel really does refuse a plain write-through while it runs
  // (skip the assertion rather than fail on filesystems that allow it).
  const plain = await fsp
    .copyFile("/bin/true", running)
    .then(() => "allowed", (e) => e.code);
  if (plain !== "allowed") assert.strictEqual(plain, "ETXTBSY");

  const src = path.join(dir, "new-daemon");
  await fsp.copyFile("/bin/true", src);
  await copyEntry(src, running); // must not throw
  execFileSync(running); // /bin/true exits 0 — the new inode is in place
  assert.strictEqual(child.exitCode, null, "the old process kept running on its old inode");
});
