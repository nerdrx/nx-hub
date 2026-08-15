"use strict";
// src/cli/shim.js — ~/.local/bin/nx generation. Every test writes into its own
// temp bin dir; the real one is never touched.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const shim = require("../../src/cli/shim");

const APP_DIR = path.join(__dirname, "..", "..");
const BINARY = "/opt/NX Hub/squashfs-root/nx-hub";

function tempBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-shim-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("cli/shim: the rendered shim carries the marker, both paths and the entry point", () => {
  const text = shim.renderShim({ binary: BINARY, appDir: "/opt/app" });
  assert.equal(text.split("\n")[0], "#!/bin/sh");
  assert.equal(text.split("\n")[1], "# nx-hub-shim");
  assert.ok(text.includes(`NX_HUB_BINARY='/opt/NX Hub/squashfs-root/nx-hub'`), "binary is single-quoted");
  assert.ok(text.includes("NX_HUB_APP_DIR='/opt/app'"));
  assert.match(text, /ELECTRON_RUN_AS_NODE=1 exec "\$NX_HUB_BINARY" "\$NX_HUB_APP_DIR\/src\/cli\/index\.js" "\$@"/);
  assert.ok(shim.isOurs(text));
});

test("cli/shim: single quotes inside a path cannot break out", () => {
  const text = shim.renderShim({ binary: "/home/o'brien/nx-hub", appDir: "/opt/app" });
  assert.ok(text.includes(`NX_HUB_BINARY='/home/o'\\''brien/nx-hub'`), text);
});

test("cli/shim: refuses to render without both paths", () => {
  assert.throws(() => shim.renderShim({ binary: BINARY }), /app directory/);
});

test("cli/shim: sync writes an executable shim, then does nothing on a repeat", () => {
  const { dir, cleanup } = tempBin();
  try {
    const first = shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "linux" });
    assert.equal(first.action, "written");
    assert.equal(first.path, path.join(dir, "nx"));

    const stat = fs.statSync(first.path);
    assert.equal(stat.mode & 0o777, 0o755, "0755");
    const body = fs.readFileSync(first.path, "utf8");
    assert.ok(body.includes(`NX_HUB_APP_DIR='${APP_DIR}'`));

    const second = shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "linux" });
    assert.equal(second.action, "unchanged", "idempotent");
    assert.equal(fs.readFileSync(first.path, "utf8"), body);
  } finally {
    cleanup();
  }
});

test("cli/shim: a moved hub rewrites the baked paths (self-update stays fresh)", () => {
  const { dir, cleanup } = tempBin();
  try {
    shim.sync({ cliShim: true }, { binary: "/old/nx-hub", appDir: APP_DIR, binDir: dir, platform: "linux" });
    const result = shim.sync({ cliShim: true }, { binary: "/new/nx-hub", appDir: APP_DIR, binDir: dir, platform: "linux" });
    assert.equal(result.action, "updated");
    const body = fs.readFileSync(result.path, "utf8");
    assert.ok(body.includes("NX_HUB_BINARY='/new/nx-hub'"));
    assert.ok(!body.includes("/old/nx-hub"));
  } finally {
    cleanup();
  }
});

test("cli/shim: a foreign nx on the PATH is never overwritten", () => {
  const { dir, cleanup } = tempBin();
  try {
    const file = path.join(dir, "nx");
    fs.writeFileSync(file, "#!/bin/sh\n# somebody else's nx\necho hi\n");
    const result = shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "linux" });
    assert.equal(result.action, "foreign");
    assert.match(fs.readFileSync(file, "utf8"), /somebody else's nx/);
    // …and it is not deleted when the setting is turned off either
    const off = shim.sync({ cliShim: false }, { binDir: dir, platform: "linux" });
    assert.equal(off.action, "foreign");
    assert.ok(fs.existsSync(file));
  } finally {
    cleanup();
  }
});

test("cli/shim: turning the setting off removes our own shim", () => {
  const { dir, cleanup } = tempBin();
  try {
    shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "linux" });
    const removed = shim.sync({ cliShim: false }, { binDir: dir, platform: "linux" });
    assert.equal(removed.action, "removed");
    assert.equal(fs.existsSync(path.join(dir, "nx")), false);
    assert.equal(shim.sync({ cliShim: false }, { binDir: dir, platform: "linux" }).action, "absent");
  } finally {
    cleanup();
  }
});

test("cli/shim: windows gets no POSIX shim", () => {
  const { dir, cleanup } = tempBin();
  try {
    const result = shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "win32" });
    assert.equal(result.action, "unsupported");
    assert.equal(fs.existsSync(path.join(dir, "nx")), false);
  } finally {
    cleanup();
  }
});

test("cli/shim: a hub running from a temporary AppImage mount writes nothing", () => {
  const { dir, cleanup } = tempBin();
  try {
    assert.equal(shim.isEphemeral("/tmp/.mount_NX-Hubabc123/nx-hub"), true);
    assert.equal(shim.isEphemeral("/opt/nx-hub/squashfs-root/nx-hub"), false);
    const result = shim.sync(
      { cliShim: true },
      { binary: "/tmp/.mount_NX-Hubabc/nx-hub", appDir: "/tmp/.mount_NX-Hubabc/resources/app", binDir: dir, platform: "linux" }
    );
    assert.equal(result.action, "skipped");
    assert.match(result.reason, /temporary AppImage mount/);
    assert.equal(fs.existsSync(path.join(dir, "nx")), false);
  } finally {
    cleanup();
  }
});

test("cli/shim: an app dir without the CLI is not shimmed", () => {
  const { dir, cleanup } = tempBin();
  try {
    const result = shim.sync({ cliShim: true }, { binary: BINARY, appDir: "/nowhere/at/all", binDir: dir, platform: "linux" });
    assert.equal(result.action, "skipped");
    assert.match(result.reason, /no CLI at/);
  } finally {
    cleanup();
  }
});

test("cli/shim: inspect reports missing / current / stale / foreign", () => {
  const { dir, cleanup } = tempBin();
  try {
    assert.equal(shim.inspect({ binDir: dir, binary: BINARY, appDir: APP_DIR }).state, "missing");
    shim.sync({ cliShim: true }, { binary: BINARY, appDir: APP_DIR, binDir: dir, platform: "linux" });
    assert.equal(shim.inspect({ binDir: dir, binary: BINARY, appDir: APP_DIR }).state, "current");
    assert.equal(shim.inspect({ binDir: dir, binary: "/elsewhere/nx-hub", appDir: APP_DIR }).state, "stale");
    fs.writeFileSync(path.join(dir, "nx"), "#!/bin/sh\necho nope\n");
    assert.equal(shim.inspect({ binDir: dir, binary: BINARY, appDir: APP_DIR }).state, "foreign");
  } finally {
    cleanup();
  }
});

test("cli/shim: onPath only matches a real PATH entry", () => {
  assert.equal(shim.onPath("/home/u/.local/bin", { PATH: "/usr/bin:/home/u/.local/bin/:/bin" }), true);
  assert.equal(shim.onPath("/home/u/.local/bin", { PATH: "/usr/bin:/bin" }), false);
});

test("cli/shim: the generated script is valid POSIX sh and runs the CLI", (t) => {
  const { dir, cleanup } = tempBin();
  try {
    const result = shim.sync(
      { cliShim: true },
      { binary: process.execPath, appDir: APP_DIR, binDir: dir, platform: "linux" }
    );
    assert.equal(result.action, "written");
    const { spawnSync } = require("child_process");

    const syntax = spawnSync("/bin/sh", ["-n", result.path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    // …and it really starts the CLI (help needs no network and no hub state)
    const run = spawnSync(result.path, ["help"], {
      encoding: "utf8",
      env: Object.assign({}, process.env, { NO_COLOR: "1", NX_HUB_QUIET: "1" }),
      timeout: 30000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nx <command>/);
  } finally {
    cleanup();
  }
});

test("cli/shim: a shim whose binary vanished fails loudly with exit 2", () => {
  const { dir, cleanup } = tempBin();
  try {
    const file = path.join(dir, "nx");
    fs.writeFileSync(file, shim.renderShim({ binary: "/gone/nx-hub", appDir: APP_DIR }), { mode: 0o755 });
    const { spawnSync } = require("child_process");
    const run = spawnSync(file, ["list"], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no longer at \/gone\/nx-hub/);
  } finally {
    cleanup();
  }
});
