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
