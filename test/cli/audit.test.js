"use strict";
// v0.10 [audit] — `nx doctor --deep [--repair] [--json] [-y]`.
//
// The audit module is faked here on purpose: this file is about what the CLI
// DOES with the rows (rendering, prompting, repairing, exit codes). The rows
// themselves are covered by test/core/audit.test.js against a real tree.

const test = require("node:test");
const assert = require("node:assert");

const cli = require("../../src/cli/index");
const auditCli = require("../../src/cli/audit");
const { createStyle } = require("../../src/cli/ansi");
const fx = require("./fixtures");

function fakeStream({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
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

function row(over = {}) {
  return Object.assign(
    {
      appId: "demo",
      artifactId: "archive-dir-linux",
      ok: true,
      kind: "archive-dir",
      version: "1.0.0",
      path: "/tmp/apps/nx/demo/archive-dir-linux",
      problems: [],
      notes: [],
    },
    over
  );
}

const BROKEN = row({
  appId: "wivrn-nx",
  artifactId: "tarball-prefix-linux",
  ok: false,
  kind: "tarball-prefix",
  version: "1.3.0",
  problems: [
    { kind: "missing-file", path: "/home/u/.local/bin/wivrn-server", detail: "not found" },
    { kind: "missing-desktop-entry", path: "/home/u/.local/share/applications/nx-wivrn.desktop", detail: "not found" },
  ],
});

const APK = row({
  appId: "wivrn-nx",
  artifactId: "apk-adb-android",
  kind: "apk-adb",
  version: "1.4.0",
  deviceResident: true,
  notes: ["apk-adb: installed on a device — files not checked here"],
});

/**
 * A stand-in for src/main/audit.js. `passes` is a list of what audit() answers
 * on each successive call, so a test can make a repair actually fix something.
 */
function fakeAudit(passes) {
  const calls = [];
  const list = Array.isArray(passes[0]) ? passes.slice() : [passes];
  return {
    calls,
    audit: async (appId) => {
      calls.push(appId === undefined ? null : appId);
      return list.length > 1 ? list.shift() : list[0];
    },
    repair: () => {
      throw new Error("the CLI repairs through runtime.install, not audit.repair()");
    },
  };
}

function fakeRuntime(over = {}) {
  const calls = [];
  return Object.assign(
    {
      calls,
      hubVersion: () => "0.3.6",
      boot() {},
      on: () => () => {},
      apps: async () => {
        calls.push(["apps"]);
        return fx.APPS;
      },
      cached: () => ({ apps: fx.APPS, errors: [], rateLimit: null }),
      doctor: async () => fx.DOCTOR,
      install: async (appId, artifactId, opts = {}) => {
        calls.push(["install", appId, artifactId]);
        if (opts.onProgress) opts.onProgress({ phase: "download", pct: 40, message: "fetching" });
        return { ok: true, message: `Installed ${appId}` };
      },
    },
    over
  );
}

async function runCli(argv, { runtime = fakeRuntime(), audit, confirm, env } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime,
    audit,
    stdout,
    stderr,
    confirm,
    env: Object.assign({ NO_COLOR: "1" }, env),
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text, runtime, audit };
}

/* ---------------------------------------------------------------- flags */

test("cli/audit: --deep and --repair are known flags", async () => {
  const r = await runCli(["doctor", "--deep", "--repair", "-y"], { audit: fakeAudit([row()]) });
  assert.doesNotMatch(r.err, /unknown option/);
  assert.notEqual(r.code, cli.EXIT_USER);
});

test("cli/audit: plain `nx doctor` is untouched — no audit, exit 0", async () => {
  const audit = fakeAudit([row({ ok: false, problems: [{ kind: "missing-dir", path: "/gone", detail: "not found" }] })]);
  const r = await runCli(["doctor"], { audit });
  assert.equal(r.code, cli.EXIT_OK);
  assert.deepEqual(audit.calls, [], "the audit only runs when it is asked for");
  assert.doesNotMatch(r.out, /A U D I T/);
  assert.match(r.out, /D O C T O R/);
});

/* ---------------------------------------------------------------- clean */

test("cli/audit: --deep on a healthy hub appends the section and exits 0", async () => {
  const audit = fakeAudit([[row(), APK]]);
  const r = await runCli(["doctor", "--deep"], { audit });

  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /D O C T O R/, "doctor's own report still comes first");
  assert.match(r.out, /A U D I T/);
  assert.match(r.out, /✓ demo\/archive-dir-linux/);
  assert.match(r.out, /· wivrn-nx\/apk-adb-android/, "a device-resident install is skipped, not ticked");
  assert.match(r.out, /files not checked here/);
  assert.match(r.out, /2 installs checked out/);
  assert.deepEqual(audit.calls, [null], "one pass, over every app");
  assert.ok(r.out.indexOf("D O C T O R") < r.out.indexOf("A U D I T"));
});

test("cli/audit: --deep with nothing installed says so", async () => {
  const r = await runCli(["doctor", "--deep"], { audit: fakeAudit([[]]) });
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /nothing installed/);
});

/* -------------------------------------------------------------- problems */

test("cli/audit: --deep with problems prints them typed and exits 2", async () => {
  const r = await runCli(["doctor", "--deep"], { audit: fakeAudit([[row(), BROKEN]]) });

  assert.equal(r.code, cli.EXIT_FAIL);
  assert.match(r.out, /✕ wivrn-nx\/tarball-prefix-linux/);
  assert.match(r.out, /missing-file\s+\/home\/u\/\.local\/bin\/wivrn-server — not found/);
  assert.match(r.out, /missing-desktop-entry/);
  assert.match(r.out, /1 of 2 installs need attention .*2 problems/);
  assert.match(r.out, /nx doctor --deep --repair/, "the fix is offered, not assumed");
});

test("cli/audit: --deep --json embeds the rows in doctor's payload", async () => {
  const r = await runCli(["doctor", "--deep", "--json"], { audit: fakeAudit([[row(), BROKEN]]) });

  assert.equal(r.code, cli.EXIT_FAIL);
  const payload = JSON.parse(r.out);
  assert.equal(payload.hubVersion, fx.DOCTOR.hubVersion, "doctor's own keys survive");
  assert.equal(payload.auditOk, false);
  assert.equal(payload.audit.length, 2);
  assert.equal(payload.audit[1].problems[0].kind, "missing-file");
  assert.deepEqual(payload.repairs, []);
  assert.doesNotMatch(r.out, /A U D I T/, "--json writes JSON and nothing else");
});

test("cli/audit: a clean --deep --json exits 0 with auditOk true", async () => {
  const r = await runCli(["doctor", "--deep", "--json"], { audit: fakeAudit([[row()]]) });
  assert.equal(r.code, cli.EXIT_OK);
  assert.equal(JSON.parse(r.out).auditOk, true);
});

/* --------------------------------------------------------------- repair */

test("cli/audit: --repair prompts per broken install and reinstalls on yes", async () => {
  const asked = [];
  const audit = fakeAudit([[row(), BROKEN], [row(), row({ appId: "wivrn-nx", artifactId: "tarball-prefix-linux" })]]);
  const r = await runCli(["doctor", "--deep", "--repair"], {
    audit,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
  });

  assert.equal(asked.length, 1, "only the broken one is offered");
  assert.match(asked[0], /Reinstall wivrn-nx\/tarball-prefix-linux/);
  assert.deepEqual(
    r.runtime.calls.filter((c) => c[0] === "install"),
    [["install", "wivrn-nx", "tarball-prefix-linux"]]
  );
  assert.equal(audit.calls.length, 2, "the tree is re-audited after a repair");
  assert.match(r.out, /A F T E R {3}R E P A I R/);
  assert.equal(r.code, cli.EXIT_OK, "everything is healthy again");
});

test("cli/audit: declining the prompt changes nothing and still exits 2", async () => {
  const audit = fakeAudit([[BROKEN]]);
  const r = await runCli(["doctor", "--deep", "--repair"], { audit, confirm: async () => false });

  assert.deepEqual(r.runtime.calls.filter((c) => c[0] === "install"), []);
  assert.equal(audit.calls.length, 1, "nothing was repaired, so nothing is re-audited");
  assert.match(r.err, /skipped wivrn-nx\/tarball-prefix-linux/);
  assert.equal(r.code, cli.EXIT_FAIL);
});

test("cli/audit: -y repairs every broken install without asking", async () => {
  let asked = 0;
  const audit = fakeAudit([
    [BROKEN, row({ appId: "demo", ok: false, problems: [{ kind: "missing-dir", path: "/gone", detail: "not found" }] })],
    [row(), row({ appId: "wivrn-nx", artifactId: "tarball-prefix-linux" })],
  ]);
  const r = await runCli(["doctor", "--deep", "--repair", "-y"], {
    audit,
    confirm: async () => {
      asked += 1;
      return true;
    },
  });

  assert.equal(asked, 0, "-y is the answer");
  assert.deepEqual(
    r.runtime.calls.filter((c) => c[0] === "install").map((c) => c[1]),
    ["wivrn-nx", "demo"]
  );
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.err, /repairing/);
});

test("cli/audit: a repair that fails is reported and keeps the exit code at 2", async () => {
  const audit = fakeAudit([[BROKEN]]);
  const runtime = fakeRuntime({
    install: async () => {
      throw new Error("GitHub is unreachable");
    },
  });
  const r = await runCli(["doctor", "--deep", "--repair", "-y"], { audit, runtime });

  assert.equal(r.code, cli.EXIT_FAIL);
  assert.match(r.err, /GitHub is unreachable/);
});

test("cli/audit: repairs fill the discovery model first (jobs.install needs it)", async () => {
  const audit = fakeAudit([[BROKEN], [row()]]);
  const r = await runCli(["doctor", "--deep", "--repair", "-y"], { audit });
  const order = r.runtime.calls.map((c) => c[0]);
  assert.ok(order.indexOf("apps") < order.indexOf("install"), `apps must be loaded first: ${order.join(",")}`);
});

test("cli/audit: --repair on a healthy hub installs nothing", async () => {
  const audit = fakeAudit([[row()]]);
  const r = await runCli(["doctor", "--deep", "--repair", "-y"], { audit });
  assert.deepEqual(r.runtime.calls.filter((c) => c[0] === "install"), []);
  assert.equal(audit.calls.length, 1);
  assert.equal(r.code, cli.EXIT_OK);
});

test("cli/audit: --deep --json --repair keeps stdout parseable", async () => {
  const audit = fakeAudit([[BROKEN], [row()]]);
  const r = await runCli(["doctor", "--deep", "--json", "--repair", "-y"], { audit });
  const payload = JSON.parse(r.out);
  assert.equal(payload.auditOk, true);
  assert.equal(payload.repairs.length, 1);
  assert.equal(payload.repairs[0].ok, true);
  assert.equal(payload.repairs[0].appId, "wivrn-nx");
  assert.equal(r.code, cli.EXIT_OK);
});

/* ------------------------------------------------------------ rendering */

test("cli/audit: renderAudit is plain when it has to be and styled when it can be", () => {
  const plain = auditCli.renderAudit([row(), BROKEN], { style: createStyle(false) });
  assert.doesNotMatch(plain, /\[/);
  assert.match(plain, /✓ demo\/archive-dir-linux\s+1\.0\.0 {2}archive-dir/);

  const styled = auditCli.renderAudit([BROKEN], { style: createStyle(true) });
  assert.match(styled, /\[38;2;255;84;112m/, "problems are painted in NX danger");
  assert.equal(createStyle(true).strip(styled).includes("missing-file"), true);
});

test("cli/audit: ids and versions line up in columns however long they get", () => {
  // short id + short version against a long id + long version
  const text = auditCli.renderAudit([row({ appId: "a", artifactId: "b", version: "2.0" }), BROKEN], {
    style: createStyle(false),
  });
  const lines = text.split("\n").filter((l) => /^ {2}[✓✕·] /.test(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].indexOf("2.0"), lines[1].indexOf("1.3.0"), "version columns are aligned");
  // lastIndexOf: "tarball-prefix" also occurs inside the artifact id
  assert.equal(
    lines[0].lastIndexOf("archive-dir"),
    lines[1].lastIndexOf("tarball-prefix"),
    "kind columns are aligned even when the versions differ in width"
  );
});

test("cli/audit: summarize counts installs and problems, not rows", () => {
  assert.deepEqual(auditCli.summarize([row(), BROKEN]), { total: 2, ok: 1, broken: 1, problems: 2 });
  assert.deepEqual(auditCli.summarize(null), { total: 0, ok: 0, broken: 0, problems: 0 });
});
