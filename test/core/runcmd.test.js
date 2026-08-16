"use strict";
// Post-install command runner: privilege rewrite + shell execution semantics.

const test = require("node:test");
const assert = require("node:assert");

const { rewriteForPrivilege, runShell, shellQuote } = require("../../src/main/runcmd");

test("sudo commands are rewritten to pkexec with the payload quoted", () => {
  const r = rewriteForPrivilege("sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server");
  assert.strictEqual(r.privileged, true);
  assert.match(r.cmd, /^pkexec sh -c 'setcap cap_sys_nice\+ep/);

  const flags = rewriteForPrivilege("sudo -E -H systemctl restart foo");
  assert.match(flags.cmd, /^pkexec sh -c 'systemctl restart foo'$/, "sudo flags are stripped");
});

test("plain commands run as-is; empty is null", () => {
  assert.deepStrictEqual(rewriteForPrivilege("systemctl --user restart plasma-plasmashell.service"), {
    cmd: "systemctl --user restart plasma-plasmashell.service",
    privileged: false,
  });
  assert.strictEqual(rewriteForPrivilege("   "), null);
});

test("shellQuote survives embedded single quotes", () => {
  assert.strictEqual(shellQuote("echo 'hi'"), `'echo '\\''hi'\\'''`);
});

test("runShell reports success, failure with output tail, and timeouts", async () => {
  const ok = await runShell("echo works && exit 0");
  assert.deepStrictEqual({ ok: ok.ok, code: ok.code, output: ok.output }, { ok: true, code: 0, output: "works" });

  const bad = await runShell("echo oops >&2; exit 3");
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 3);
  assert.match(bad.output, /oops/);

  const slow = await runShell("sleep 5", { timeout: 300 });
  assert.strictEqual(slow.ok, false);
  assert.strictEqual(slow.timedOut, true);
});

test("auto-run: fires on install when enabled, skips privileged on policy installs, off by default", async (t) => {
  const helpers = require("./helpers");
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const config = require("../../src/main/config");
  const jobsMod = require("../../src/main/jobs");
  const fs = require("fs");
  const path = require("path");
  const marker = path.join(env.root, "ran.txt");

  const events = [];
  jobsMod._reset();
  const app = { id: "demo", name: "Demo", latest: { version: "2.0" } };
  const artifact = {
    id: "a", kind: "archive-dir", platform: "linux", label: "A",
    assetName: "a.zip", assetUrl: "u", sourceVersion: "2.0",
    postInstallCmd: `touch ${marker}`,
  };
  jobsMod.init({
    emit: (e) => events.push(e),
    engine: { install: async () => ({ version: "2.0", path: env.root, launchable: false }) },
    github: { downloadAsset: async () => ({ sha256: "x", verified: false }) },
    resolve: () => ({ app, artifact }),
  });

  // default off → no marker
  config.save({});
  jobsMod.install("demo", "a");
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(fs.existsSync(marker), false, "off by default");

  // enabled → runs
  config.save({ autoRunPostInstallCmd: true });
  jobsMod.install("demo", "a");
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(fs.existsSync(marker), true, "auto-ran when enabled");
  fs.rmSync(marker, { force: true });

  // privileged + policy origin → skipped
  artifact.postInstallCmd = `sudo touch ${marker}`;
  jobsMod.install("demo", "a", { origin: "policy" });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(fs.existsSync(marker), false, "privileged background install leaves the note");

  // per-app override wins over global
  config.save({ autoRunPostInstallCmd: true, appPrefs: { demo: { autoRunCmd: false } } });
  artifact.postInstallCmd = `touch ${marker}`;
  jobsMod.install("demo", "a");
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(fs.existsSync(marker), false, "per-app off overrides global on");
});
