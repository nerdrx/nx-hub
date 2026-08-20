"use strict";
// SPEC v0.10 [daemon] — `nx daemon run | install | uninstall | status`.
//
// The unit-file half is pure file management and is driven directly. The
// command half goes through the real dispatcher with a FAKE src/main/daemon.js,
// so nothing here ever composes a hub — except the last test, which spawns the
// real CLI as a child process to prove SIGTERM really is a clean shutdown.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const cli = require("../../src/cli/index");
const daemonCli = require("../../src/cli/daemon");
const shim = require("../../src/cli/shim");

const ROOT = path.join(__dirname, "..", "..");

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const tempDirs = [];
function tempDir(prefix = "nxhub-daemon-cli-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
});

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

/** A src/main/daemon.js stand-in. */
function fakeDaemon(over = {}) {
  return Object.assign(
    {
      portBusy: async () => false,
      portBusyMessage: (what, port) => `the ${what} port ${port} is already in use`,
      start: async () => ({ stop: async () => {} }),
    },
    over
  );
}

/** Run the real dispatcher with the daemon module faked out. */
async function runCli(argv, { daemon = fakeDaemon(), env = {} } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    daemon,
    stdout,
    stderr,
    env: Object.assign({ NO_COLOR: "1" }, env),
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text };
}

/** The ctx shape index.js builds, for the pieces that need process/signals. */
function makeCtx({ args = [], flags = {}, env = {}, daemon = fakeDaemon(), proc = null, signals = null, log = null } = {}) {
  // eslint-disable-next-line global-require
  const { createStyle } = require("../../src/cli/ansi");
  const st = createStyle(false);
  const stdout = fakeStream();
  const stderr = fakeStream();
  return {
    args,
    flags,
    json: Boolean(flags.json),
    st,
    stErr: st,
    stdout,
    stderr,
    out: (t) => stdout.write(`${t}\n`),
    err: (t) => stderr.write(`${t}\n`),
    env,
    platform: "linux",
    daemon,
    process: proc,
    signals,
    // `daemon run` would otherwise log through config.log — into the REAL
    // ~/.local/share/nx-hub/logs. Every test that runs it injects a sink.
    log,
    withStatus: (_m, fn) => fn(),
  };
}

/** A stand-in for `process` that records signal handlers. */
function fakeProcess() {
  const handlers = new Map();
  return {
    env: {},
    handlers,
    on(sig, fn) {
      if (!handlers.has(sig)) handlers.set(sig, []);
      handlers.get(sig).push(fn);
    },
    removeListener(sig, fn) {
      const list = handlers.get(sig) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    /** Deliver a signal exactly as node would. */
    raise(sig) {
      return Promise.all((handlers.get(sig) || []).slice().map((fn) => fn()));
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ */
/* the unit file                                                       */
/* ------------------------------------------------------------------ */

test("the unit carries the marker, an ExecStart and Restart=on-failure", () => {
  const text = daemonCli.renderUnit({ exec: "/home/x/.local/bin/nx daemon run", environment: null });
  const lines = text.split("\n");
  assert.strictEqual(lines[0], "# nx-hub-daemon", "the marker is the very first line");
  assert.ok(daemonCli.isOurs(text));
  assert.match(text, /^\[Unit\]$/m);
  assert.match(text, /^\[Service\]$/m);
  assert.match(text, /^\[Install\]$/m);
  assert.match(text, /^ExecStart=\/home\/x\/\.local\/bin\/nx daemon run$/m);
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.ok(!/^Environment=/m.test(text), "no Environment line when the shim is doing the work");
  assert.throws(() => daemonCli.renderUnit({}), /ExecStart/);
});

test("a foreign file at that path is not ours, whatever it says", () => {
  assert.strictEqual(daemonCli.isOurs("[Unit]\nDescription=someone else's daemon\n"), false);
  assert.strictEqual(daemonCli.isOurs(""), false);
  // The marker only counts near the top — not buried in a Description=.
  assert.strictEqual(daemonCli.isOurs(["", "", "", "", "", "", "# nx-hub-daemon"].join("\n")), false);
});

test("ExecStart prefers the hub's own shim and falls back to this runtime", () => {
  const binDir = tempDir();
  const appDir = ROOT;

  // No shim yet → the longhand ELECTRON_RUN_AS_NODE form.
  const fallback = daemonCli.execStartFor({ binary: "/opt/nx-hub/nx-hub", appDir, binDir });
  assert.strictEqual(fallback.via, "runtime");
  assert.strictEqual(fallback.environment, "ELECTRON_RUN_AS_NODE=1");
  assert.match(fallback.exec, /nx-hub .*src\/cli\/index\.js daemon run$/);
  assert.match(daemonCli.renderUnit(fallback), /^Environment=ELECTRON_RUN_AS_NODE=1$/m);

  // Once the hub has written ~/.local/bin/nx, point the unit at that instead:
  // it is rewritten on every self-update, so the unit survives one.
  shim.sync({ cliShim: true }, { binary: process.execPath, appDir, binDir, platform: "linux" });
  const viaShim = daemonCli.execStartFor({ binary: process.execPath, appDir, binDir });
  assert.strictEqual(viaShim.via, "shim");
  assert.strictEqual(viaShim.environment, null);
  assert.strictEqual(viaShim.exec, `${path.join(binDir, "nx")} daemon run`);

  // A stranger's `nx` is not ours to lean on.
  fs.writeFileSync(path.join(binDir, "nx"), "#!/bin/sh\necho not the hub\n");
  assert.strictEqual(daemonCli.execStartFor({ binary: process.execPath, appDir, binDir }).via, "runtime");
});

test("paths with spaces are quoted the way systemd parses them", () => {
  assert.strictEqual(daemonCli.unitQuote("/opt/nx/nx"), "/opt/nx/nx");
  assert.strictEqual(daemonCli.unitQuote("/opt/my apps/nx"), '"/opt/my apps/nx"');
  assert.strictEqual(daemonCli.unitQuote('/opt/we"ird'), '"/opt/we\\"ird"');
});

test("install writes, refreshes, and refuses a file it did not write", () => {
  const cfgHome = tempDir();
  const env = { XDG_CONFIG_HOME: cfgHome };
  const file = daemonCli.unitPath(env);
  assert.strictEqual(daemonCli.inspectUnit({ env }).state, "missing");

  const first = daemonCli.installUnit({ binary: "/opt/a/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  assert.strictEqual(first.action, "written");
  assert.strictEqual(first.path, file);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(daemonCli.inspectUnit({ env }).state, "ours");

  // Idempotent: the same paths produce the same text.
  const again = daemonCli.installUnit({ binary: "/opt/a/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  assert.strictEqual(again.action, "unchanged");

  // Moved hub → the unit is refreshed in place, exactly like the cli shim.
  const moved = daemonCli.installUnit({ binary: "/opt/b/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  assert.strictEqual(moved.action, "updated");
  assert.match(fs.readFileSync(file, "utf8"), /\/opt\/b\/nx-hub/);

  // Someone else's unit of the same name is left completely alone.
  const foreign = "[Unit]\nDescription=hand written\n";
  fs.writeFileSync(file, foreign);
  const refused = daemonCli.installUnit({ binary: "/opt/a/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  assert.strictEqual(refused.action, "foreign");
  assert.strictEqual(fs.readFileSync(file, "utf8"), foreign, "not one byte was touched");
  assert.strictEqual(daemonCli.inspectUnit({ env }).state, "foreign");
});

test("uninstall removes only our own unit", () => {
  const cfgHome = tempDir();
  const env = { XDG_CONFIG_HOME: cfgHome };
  const file = daemonCli.unitPath(env);

  assert.strictEqual(daemonCli.removeUnit({ env }).action, "absent");

  daemonCli.installUnit({ binary: "/opt/a/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  assert.strictEqual(daemonCli.removeUnit({ env }).action, "removed");
  assert.strictEqual(fs.existsSync(file), false);

  const foreign = "[Unit]\nDescription=hand written\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, foreign);
  assert.strictEqual(daemonCli.removeUnit({ env }).action, "foreign");
  assert.strictEqual(fs.readFileSync(file, "utf8"), foreign);
});

test("install is a Linux-only affair", () => {
  const env = { XDG_CONFIG_HOME: tempDir() };
  const result = daemonCli.installUnit({ binary: "/x", appDir: ROOT, env, platform: "win32" });
  assert.strictEqual(result.action, "unsupported");
  assert.strictEqual(fs.existsSync(daemonCli.unitPath(env)), false);
});

/* ------------------------------------------------------------------ */
/* status                                                             */
/* ------------------------------------------------------------------ */

test("the verdict reconciles the port with the snapshot", () => {
  const fresh = { exists: true, stale: false };
  const cold = { exists: true, stale: true };
  const never = { exists: false, stale: true };

  assert.strictEqual(daemonCli.verdict({ listening: true, snapshot: fresh }), "running");
  // Bound, but nothing is re-stamping the roster: something owns :9021 that is
  // not a healthy hub.
  assert.strictEqual(daemonCli.verdict({ listening: true, snapshot: cold }), "stale");
  assert.strictEqual(daemonCli.verdict({ listening: true, snapshot: never }), "stale");
  // A fresh roster with a free port = a hub that died between heartbeats.
  assert.strictEqual(daemonCli.verdict({ listening: false, snapshot: fresh }), "stale");
  assert.strictEqual(daemonCli.verdict({ listening: false, snapshot: cold }), "stopped");
  assert.strictEqual(daemonCli.verdict({ listening: false, snapshot: never }), "stopped");
});

test("ageText stays locale-independent", () => {
  assert.strictEqual(daemonCli.ageText(8000), "8s");
  assert.strictEqual(daemonCli.ageText(4 * 60 * 1000), "4m");
  assert.strictEqual(daemonCli.ageText(3 * 3600 * 1000), "3h");
  assert.strictEqual(daemonCli.ageText(null), "never");
});

/** Point config/ipc at a temp data dir carrying a snapshot of a given age. */
function withSnapshot(ageMs, clients = []) {
  const dataDir = tempDir();
  if (ageMs != null) {
    fs.writeFileSync(
      path.join(dataDir, "connector-clients.json"),
      JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), clients })
    );
  }
  const previous = process.env.NX_HUB_DATA_DIR;
  process.env.NX_HUB_DATA_DIR = dataDir;
  return {
    dataDir,
    restore() {
      if (previous === undefined) delete process.env.NX_HUB_DATA_DIR;
      else process.env.NX_HUB_DATA_DIR = previous;
    },
  };
}

test("`nx daemon status --json` reports running / stopped / stale", async (t) => {
  const cfgHome = tempDir();
  const env = { XDG_CONFIG_HOME: cfgHome, NO_COLOR: "1" };

  // --- running: the port answers and the roster is seconds old ------
  let snap = withSnapshot(4000, [{ app: "pulsenx", version: "1.2.1" }]);
  t.after(() => snap.restore());
  let res = await runCli(["daemon", "status", "--json"], { daemon: fakeDaemon({ portBusy: async () => true }), env });
  assert.strictEqual(res.code, 0);
  let info = JSON.parse(res.out);
  assert.strictEqual(info.state, "running");
  assert.strictEqual(info.listening, true);
  assert.deepStrictEqual(info.clients, ["pulsenx"]);
  assert.strictEqual(info.clientCount, 1);
  assert.strictEqual(info.enableCommand, "systemctl --user enable --now nx-hub-daemon");
  assert.strictEqual(info.unit.state, "missing", "no unit installed in this temp config home");
  snap.restore();

  // --- stopped: nothing on the port, no snapshot --------------------
  snap = withSnapshot(null);
  res = await runCli(["daemon", "status", "--json"], { daemon: fakeDaemon({ portBusy: async () => false }), env });
  info = JSON.parse(res.out);
  assert.strictEqual(info.state, "stopped");
  assert.strictEqual(info.snapshotExists, false);
  snap.restore();

  // --- stale: a roster from an hour ago, port free ------------------
  snap = withSnapshot(60 * 60 * 1000, [{ app: "pulsenx" }]);
  res = await runCli(["daemon", "status", "--json"], { daemon: fakeDaemon({ portBusy: async () => true }), env });
  info = JSON.parse(res.out);
  assert.strictEqual(info.state, "stale");
  snap.restore();
});

test("`nx daemon status` prints the three signals in plain text", async () => {
  const env = { XDG_CONFIG_HOME: tempDir(), NO_COLOR: "1" };
  const snap = withSnapshot(3000, [{ app: "pulsenx" }, { app: "quadforge" }]);
  const res = await runCli(["daemon", "status"], { daemon: fakeDaemon({ portBusy: async () => true }), env });
  snap.restore();

  assert.strictEqual(res.code, 0);
  assert.match(res.out, /nx daemon\s+running/);
  assert.match(res.out, /connector\s+127\.0\.0\.1:9021 bound/);
  assert.match(res.out, /roster\s+2 clients .*pulsenx, quadforge/);
  assert.match(res.out, /unit\s+.*nx-hub-daemon\.service \(missing\)/);
});

test("a stopped daemon is told how to start", async () => {
  const cfgHome = tempDir();
  const env = { XDG_CONFIG_HOME: cfgHome, NO_COLOR: "1" };
  const snap = withSnapshot(null);

  let res = await runCli(["daemon", "status"], { daemon: fakeDaemon({ portBusy: async () => false }), env });
  assert.match(res.out, /nx daemon install/, "no unit yet → install it");

  daemonCli.installUnit({ binary: "/opt/a/nx-hub", appDir: ROOT, binDir: tempDir(), env });
  res = await runCli(["daemon", "status"], { daemon: fakeDaemon({ portBusy: async () => false }), env });
  snap.restore();
  assert.match(res.out, /systemctl --user enable --now nx-hub-daemon/, "unit present → enable it");
});

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

test("`nx daemon install` prints the enable command rather than running it", async () => {
  const env = { XDG_CONFIG_HOME: tempDir(), NO_COLOR: "1" };
  const res = await runCli(["daemon", "install"], { env });
  assert.strictEqual(res.code, 0);
  assert.match(res.out, /written .*nx-hub-daemon\.service/);
  assert.match(res.out, /systemctl --user enable --now nx-hub-daemon/);
  assert.match(res.out, /journalctl --user -u nx-hub-daemon/);
  assert.ok(fs.existsSync(daemonCli.unitPath(env)));

  const removed = await runCli(["daemon", "uninstall"], { env });
  assert.strictEqual(removed.code, 0);
  assert.match(removed.out, /removed/);
  assert.strictEqual(fs.existsSync(daemonCli.unitPath(env)), false);
});

test("`nx daemon install --json` over a foreign unit fails without touching it", async () => {
  const env = { XDG_CONFIG_HOME: tempDir(), NO_COLOR: "1" };
  const file = daemonCli.unitPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[Unit]\nDescription=mine\n");

  const res = await runCli(["daemon", "install", "--json"], { env });
  assert.strictEqual(res.code, 2);
  assert.strictEqual(JSON.parse(res.out).ok, false);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "[Unit]\nDescription=mine\n");

  const removed = await runCli(["daemon", "uninstall", "--json"], { env });
  assert.strictEqual(removed.code, 2);
  assert.strictEqual(JSON.parse(removed.out).action, "foreign");
});

test("an unknown daemon subcommand is a usage error", async () => {
  const res = await runCli(["daemon", "restart"], { env: { XDG_CONFIG_HOME: tempDir() } });
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /unknown daemon command "restart"/);
  assert.match(res.err, /run \| install \| uninstall \| status/);
});

test("bare `nx daemon` is `nx daemon status`", async () => {
  const env = { XDG_CONFIG_HOME: tempDir(), NO_COLOR: "1" };
  const snap = withSnapshot(null);
  const res = await runCli(["daemon"], { daemon: fakeDaemon({ portBusy: async () => false }), env });
  snap.restore();
  assert.strictEqual(res.code, 0);
  assert.match(res.out, /nx daemon\s+stopped/);
});

test("`daemon` is in the help text", async () => {
  const res = await runCli(["help"], { env: {} });
  assert.match(res.out, /daemon run \| install \| uninstall \| status/);
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

test("`nx daemon run` surfaces the port refusal as exit 2, no stack", async () => {
  const proc = fakeProcess();
  const ctx = makeCtx({
    args: ["run"],
    proc,
    daemon: fakeDaemon({
      start: async () => {
        const e = new Error("the connector port 9021 is already in use — an NX Hub is already running");
        e.operational = true;
        throw e;
      },
    }),
  });
  const code = await daemonCli.cmdDaemon(ctx);
  assert.strictEqual(code, 2);
  assert.match(ctx.stderr.text, /connector port 9021 is already in use/);
  assert.ok(!/at Object\./.test(ctx.stderr.text), "no stack trace");
  assert.strictEqual(proc.handlers.size, 0, "nothing was left listening for signals");
});

test("`nx daemon run` stops gracefully on SIGTERM and returns 0", async () => {
  const proc = fakeProcess();
  proc.env.NX_HUB_QUIET = "1";
  const lines = [];
  let stopped = 0;
  const ctx = makeCtx({
    args: ["run"],
    proc,
    signals: ["SIGTERM", "SIGINT"],
    log: (m) => lines.push(m),
    daemon: fakeDaemon({
      start: async () => ({
        stop: async () => {
          stopped += 1;
        },
      }),
    }),
  });

  const running = daemonCli.cmdDaemon(ctx);
  // start() is awaited before the handlers go on, so give the microtasks a turn.
  await new Promise((r) => setImmediate(r));
  assert.ok(proc.handlers.has("SIGTERM") && proc.handlers.has("SIGINT"), "both signals are handled");
  assert.strictEqual(proc.env.NX_HUB_QUIET, undefined, "the log is unmuted while the daemon runs");

  await proc.raise("SIGTERM");
  assert.strictEqual(await running, 0);
  assert.strictEqual(stopped, 1, "the daemon was stopped exactly once");
  assert.ok(
    lines.some((l) => l === "SIGTERM received — stopping"),
    "the shutdown is announced through the hub's own logger (stdout + the log file)"
  );
  assert.strictEqual((proc.handlers.get("SIGTERM") || []).length, 0, "handlers were removed on the way out");
  assert.strictEqual(proc.env.NX_HUB_QUIET, "1", "and the CLI's muting was put back");
});

/* ------------------------------------------------------------------ */
/* the real thing, in a child process                                  */
/* ------------------------------------------------------------------ */

test("a spawned `nx daemon run` really shuts down on SIGTERM", async (t) => {
  const dataDir = tempDir();
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    // No owners → discovery has nothing to fetch. No fleet → no LAN listener.
    JSON.stringify({ owners: [], extraRepos: [], fleet: false, cliShim: false, autostart: false })
  );
  const port = await freePort();

  const child = spawn(process.execPath, [path.join(ROOT, "src", "cli", "index.js"), "daemon", "run", "--port", String(port)], {
    env: Object.assign({}, process.env, {
      NX_HUB_DATA_DIR: dataDir,
      NX_HUB_INSTALL_ROOT: path.join(dataDir, "apps"),
      NX_HUB_NO_GH: "1",
      NX_HUB_NO_LIVE_OVERLAY: "1",
      // Belt and braces: even if the jittered first pass somehow fired, it
      // would go to a closed loopback port, never to github.com.
      NX_HUB_GITHUB_BASE: "http://127.0.0.1:1",
      NO_COLOR: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  let output = "";
  child.stdout.on("data", (c) => {
    output += c.toString();
  });
  child.stderr.on("data", (c) => {
    output += c.toString();
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  // Wait for the bus to come up on OUR ephemeral port.
  const deadline = Date.now() + 15000;
  while (!/connector listening on 127\.0\.0\.1:/.test(output)) {
    if (Date.now() > deadline) throw new Error(`daemon never reported a bus — output:\n${output}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(output, new RegExp(`connector listening on 127\\.0\\.0\\.1:${port}`));

  child.kill("SIGTERM");
  const result = await exited;
  assert.strictEqual(result.signal, null, "it handled the signal instead of dying from it");
  assert.strictEqual(result.code, 0, `a clean shutdown exits 0 — output:\n${output}`);
  assert.match(output, /SIGTERM received — stopping/);
  assert.match(output, /nx daemon stopped/);

  // And the port really is free again: systemd restarting the unit must not
  // race its own predecessor.
  const rebind = net.createServer();
  await new Promise((resolve, reject) => {
    rebind.once("error", reject);
    rebind.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => rebind.close(resolve));
});
