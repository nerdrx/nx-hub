"use strict";
// SPEC v0.6 — the launch-side hook the crash watchdog hangs off.
//
// util.spawnDetached announces every child it starts, so the core can watch a
// launched app WITHOUT the engines changing their launch() return shape and
// WITHOUT weakening detachment.

const test = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs/promises");
const path = require("node:path");

const util = require("../../src/main/install/util");
const appimage = require("../../src/main/install/appimage");
const H = require("./helpers");

const app = { id: "pulsenx", name: "PulseNX", repo: "nerdrx/pulsenx" };
const artifact = {
  id: "appimage-linux",
  label: "Linux app",
  kind: "appimage",
  platform: "linux",
  assetName: "PulseNX-1.4.0.AppImage",
  version: "1.4.0",
};

function reap(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (_) {
    /* already gone */
  }
}

test("spawnDetached announces the child, and stays detached + unref'd", async (t) => {
  const seen = [];
  const off = util.onSpawn((child, info) => seen.push({ child, info }));
  t.after(() => off());

  const child = util.spawnDetached("sh", ["-c", "sleep 5"], { cwd: process.cwd() });
  t.after(() => reap(child.pid));

  assert.strictEqual(seen.length, 1, "the listener fired synchronously");
  assert.strictEqual(seen[0].child.pid, child.pid);
  assert.strictEqual(seen[0].info.cmd, "sh");
  assert.deepStrictEqual(seen[0].info.args, ["-c", "sleep 5"]);
  // detached === its own process group, which is what lets it outlive the hub.
  // Signalling the GROUP -pid only works when the child leads one of its own.
  assert.doesNotThrow(() => process.kill(-child.pid, 0), "the child leads its own process group");

  // and the exit code still reaches us despite the unref()
  const code = await new Promise((resolve) => {
    reap(child.pid);
    child.once("exit", (c, signal) => resolve(signal || c));
  });
  assert.strictEqual(code, "SIGKILL", "an unref'd detached child still reports how it died");
});

test("unsubscribing stops the notifications; a throwing listener never breaks a launch", async (t) => {
  const seen = [];
  const off = util.onSpawn((c) => seen.push(c.pid));
  const offBoom = util.onSpawn(() => {
    throw new Error("listener is broken");
  });
  t.after(() => {
    off();
    offBoom();
  });

  const a = util.spawnDetached("sh", ["-c", "exit 0"]);
  t.after(() => reap(a.pid));
  assert.deepStrictEqual(seen, [a.pid], "a broken co-listener did not stop ours");

  off();
  const b = util.spawnDetached("sh", ["-c", "exit 0"]);
  t.after(() => reap(b.pid));
  assert.deepStrictEqual(seen, [a.pid], "no notification after unsubscribe");
});

test("the appimage engine's launch is visible to the hook (real install, real spawn)", async (t) => {
  const box = await H.makeSandbox("spawn-hook");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const ctx = H.makeCtx(box);
  const file = path.join(box.downloads, artifact.assetName);
  await H.writeFakeAppImage(file);
  const res = await appimage.install({ app, artifact, filePath: file, ctx });

  // make AppRun a sleeper so the process is still alive when we inspect it
  await fsp.writeFile(path.join(res.path, "AppRun"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });

  const seen = [];
  const off = util.onSpawn((c) => seen.push(c));
  let launched;
  try {
    launched = await appimage.launch({ app, artifact, installedPath: res.path, ctx });
  } finally {
    off();
  }
  t.after(() => reap(launched.pid));

  const match = seen.find((c) => c.pid === launched.pid);
  assert.ok(match, "the pid the engine reports is the child the hook saw");
  assert.strictEqual(typeof match.once, "function", "a real ChildProcess, so exit events are available");
});
