"use strict";
// `nx manifest check|init` + the doctor's manifest line — SPEC v0.12.
//
// `check` is what an app repo runs in CI, so its EXIT CODE is the feature:
// 0 clean, 1 anything else. Everything here works off a real file in a temp
// dir; nothing touches the network or needs a hub.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cli = require("../../src/cli/index");
const render = require("../../src/cli/render");
const { createStyle } = require("../../src/cli/ansi");
const manifestMod = require("../../src/main/manifest");
const fx = require("./fixtures");

function fakeStream() {
  const chunks = [];
  return {
    isTTY: false,
    columns: 100,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

async function runCli(argv, { runtime } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime: runtime || { hubVersion: () => "0.12.0", boot() {}, on: () => () => {} },
    stdout,
    stderr,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text };
}

/** Run inside a scratch cwd — `nx manifest check` resolves paths against it. */
function inTempCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-manifest-cli-"));
  const before = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(before);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
  return dir;
}

/* ---------------------------------------------------------------- check */

test("cli: `nx manifest check` passes a clean file and exits 0", async (t) => {
  inTempCwd(t);
  fs.writeFileSync(
    manifestMod.MANIFEST_FILE,
    JSON.stringify({
      nxApp: 1,
      name: "Selfy",
      tagline: "describes itself",
      artifacts: [{ assetPattern: "*.AppImage", label: "Linux app", postInstallNote: "Log out once." }],
    })
  );
  const r = await runCli(["manifest", "check", "--plain"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Selfy/);
  assert.match(r.out, /1 artifact/);
});

test("cli: `nx manifest check` on the example we ship for our own repo", async (t) => {
  const dir = inTempCwd(t);
  const generated = manifestMod.fromOverlayEntry("wivrn-nx");
  fs.writeFileSync(path.join(dir, "nx-app.json"), `${JSON.stringify(generated, null, 2)}\n`);
  const r = await runCli(["manifest", "check", "--plain"]);
  assert.equal(r.code, 0, "the manifest `init` prints validates cleanly");
  // …and it tells the author which half of it needs a trusted owner.
  assert.match(r.out, /needs a trusted owner/);
  assert.match(r.out, /postInstallCmd/);
});

test("cli: `nx manifest check` fails on problems, and names them", async (t) => {
  inTempCwd(t);
  fs.writeFileSync("nx-app.json", JSON.stringify({ name: "Typo", tagLine: "wrong key", artifacts: [] }));
  const r = await runCli(["manifest", "check", "--plain"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /tagLine/);
  assert.match(r.out, /unknown field/);
});

test("cli: `nx manifest check` fails on a file that is not a manifest at all", async (t) => {
  inTempCwd(t);
  fs.writeFileSync("nx-app.json", "{ not json");
  const r = await runCli(["manifest", "check", "--plain"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not a usable nx-app.json/);
});

test("cli: `nx manifest check --file` reads elsewhere, and --json is machine-readable", async (t) => {
  const dir = inTempCwd(t);
  const file = path.join(dir, "packaging", "app.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: "Rogue",
      artifacts: [{ assetPattern: "*.AppImage", label: "Linux", postInstallCmd: "sudo setcap x /usr/bin/rogue" }],
    })
  );
  const r = await runCli(["manifest", "check", "--file", "packaging/app.json", "--json"]);
  assert.equal(r.code, 0, "a clean manifest with trusted-only fields is still valid");
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.name, "Rogue");
  assert.deepEqual(parsed.droppedForUntrustedOwner, ["postInstallCmd"]);
  assert.equal(parsed.file, file);
});

test("cli: `nx manifest check` on a missing file is a user error, not a crash", async (t) => {
  inTempCwd(t);
  const r = await runCli(["manifest", "check", "--plain"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /could not read/);
  assert.match(r.err, /manifest init/);
});

/* ----------------------------------------------------------------- init */

test("cli: `nx manifest init wivrn-nx` prints the setcap note WiVRn needs today", async () => {
  const r = await runCli(["manifest", "init", "wivrn-nx"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.name, "WiVRn NX");
  const server = parsed.artifacts.find((a) => a.kind === "tarball-prefix");
  assert.match(server.postInstallNote, /sudo setcap cap_sys_nice\+ep ~\/\.local\/bin\/wivrn-server/);
  assert.equal(server.postInstallCmd, "sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server");
  assert.match(r.err, /save as nx-app.json/, "the hint goes to stderr so stdout stays pasteable");
});

test("cli: `nx manifest init --json` keeps stdout clean for a redirect", async () => {
  const r = await runCli(["manifest", "init", "wivrn-nx", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.ok(JSON.parse(r.out).artifacts.length);
});

test("cli: `nx manifest init` on an unknown app lists what the hub does curate", async () => {
  const r = await runCli(["manifest", "init", "nothing-like-this"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no overlay entry/);
  assert.match(r.err, /wivrn-nx/);
});

test("cli: `nx manifest` without a subcommand says what it takes", async () => {
  const r = await runCli(["manifest"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a subcommand/);
  const bad = await runCli(["manifest", "frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown manifest command/);
});

test("cli: help lists the manifest command", () => {
  assert.ok(render.COMMANDS.some(([c]) => c === "manifest"));
  assert.match(render.renderHelp({}), /manifest/);
});

/* --------------------------------------------------------------- doctor */

test("cli/render: doctor reports how many apps ship a manifest", () => {
  const plain = createStyle(false);
  const info = Object.assign({}, fx.DOCTOR, { appCount: 6, manifestCount: 2 });
  assert.match(render.renderDoctor(info, { style: plain }), /manifests\s+2 of 6 discovered apps ship nx-app\.json/);

  const offline = Object.assign({}, fx.DOCTOR, { lastRefresh: null });
  assert.match(render.renderDoctor(offline, { style: plain }), /manifests\s+not checked \(--offline\)/);
});

test("cli: `nx doctor` prints the manifest count from the runtime", async () => {
  const runtime = {
    hubVersion: () => "0.12.0",
    boot() {},
    on: () => () => {},
    apps: async () => fx.APPS,
    cached: () => ({ apps: fx.APPS, lastRefresh: null, errors: [], rateLimit: null }),
    doctor: async () => Object.assign({}, fx.DOCTOR, { appCount: 3, manifestCount: 1 }),
  };
  const r = await runCli(["doctor", "--plain"], { runtime });
  assert.equal(r.code, 0);
  assert.match(r.out, /manifests\s+1 of 3 discovered apps ship nx-app\.json/);
});
