"use strict";
// SPEC v0.8 "Sandbox profiles" — bubblewrap wrappers for appimage/archive-dir.
//
// The live half of this suite runs REAL bwrap sandboxes (this is a Linux hub;
// bwrap is the whole feature) and checks the properties that matter with the
// kernel's own answers: $HOME is a fresh tmpfs, the install dir and the overlay
// configPaths are writable, `confined` reaches the network and `offline` does
// not, and the sandbox dies with its bwrap. Machines without bwrap skip those
// tests — the argv/profile half still runs everywhere.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const sandbox = require("../../src/main/install/sandbox");
const engine = require("../../src/main/install/engine");
const H = require("./helpers");

const HAVE_BWRAP = sandbox.available();
const SKIP = HAVE_BWRAP ? false : "bwrap is not installed on this machine";

/* ------------------------------------------------------------------ */
/* profile resolution                                                  */
/* ------------------------------------------------------------------ */

test("the profile resolves appPrefs → artifact → app → none", () => {
  const app = { id: "demo", sandbox: "confined" };
  const artifact = { id: "appimage-linux", kind: "appimage" };

  assert.strictEqual(sandbox.resolveProfile({ app, artifact, appPrefs: {} }), "confined", "overlay app value");
  assert.strictEqual(
    sandbox.resolveProfile({ app, artifact, appPrefs: { sandbox: "offline" } }),
    "offline",
    "the user's pref wins"
  );
  assert.strictEqual(
    sandbox.resolveProfile({ app, artifact, appPrefs: { sandbox: "inherit" } }),
    "confined",
    '"inherit" falls through to the overlay'
  );
  assert.strictEqual(
    sandbox.resolveProfile({ app, artifact: Object.assign({ sandbox: "offline" }, artifact), appPrefs: {} }),
    "offline",
    "an artifact-level profile beats the app-level one"
  );
  assert.strictEqual(sandbox.resolveProfile({ app: {}, artifact, appPrefs: {} }), "none", "nothing set → none");
  assert.strictEqual(
    sandbox.resolveProfile({ app, artifact, appPrefs: { sandbox: "banana" } }),
    "confined",
    "junk in the pref is ignored, not obeyed"
  );

  // SPEC: never sandbox the kinds that do not launch a plain binary.
  for (const kind of ["tarball-prefix", "apk-adb", "windows-portable", "windows-zip", "blender-addon"]) {
    assert.strictEqual(
      sandbox.resolveProfile({ app, artifact: { id: "x", kind }, appPrefs: { sandbox: "confined" } }),
      "none",
      `${kind} is never wrapped`
    );
  }
});

test("configPaths come from the artifact first, then the app", () => {
  const app = { configPaths: ["~/.config/demo", "  ", 7] };
  assert.deepStrictEqual(sandbox.resolveConfigPaths({ app }), ["~/.config/demo"]);
  assert.deepStrictEqual(
    sandbox.resolveConfigPaths({ app, artifact: { configPaths: ["~/.local/share/demo"] } }),
    ["~/.local/share/demo"]
  );
  assert.deepStrictEqual(sandbox.resolveConfigPaths({}), []);
});

/* ------------------------------------------------------------------ */
/* argv construction                                                   */
/* ------------------------------------------------------------------ */

function argsFor(profile, extra = {}) {
  const home = extra.home || "/home/tester";
  return sandbox.buildBwrapArgs(profile, Object.assign({ home, env: { HOME: home } }, extra));
}

/** index of `flag value` pairs, so order-sensitive checks stay readable */
function hasPair(argv, flag, a, b) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    if (argv[i + 1] === a && (b === undefined || argv[i + 2] === b)) return true;
  }
  return false;
}

test("none / inherit / junk build no wrapper at all", () => {
  for (const profile of ["none", "inherit", "", null, undefined, "nope"]) {
    assert.strictEqual(argsFor(profile), null, `${String(profile)} → unwrapped`);
  }
});

test("confined shares the network, offline unshares it — everything else is identical", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nxsbx-argv-"));
  const home = path.join(root, "home");
  const installDir = path.join(home, "Applications/nx/demo/appimage-linux");
  const cfg = path.join(home, ".config/demo");
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.mkdir(cfg, { recursive: true });

  const opts = { home, installDir, configPaths: ["~/.config/demo", "~/.config/never-created"], env: { HOME: home } };
  const confined = sandbox.buildBwrapArgs("confined", opts);
  const offline = sandbox.buildBwrapArgs("offline", opts);

  assert.ok(!confined.includes("--die-with-parent"), "quitting the hub must never kill a running app");
  assert.ok(confined.includes("--unshare-all"));
  assert.ok(confined.includes("--share-net"), "confined keeps the network");
  assert.ok(!offline.includes("--share-net"), "offline does not");
  assert.deepStrictEqual(
    confined.filter((a) => a !== "--share-net"),
    offline,
    "offline IS confined minus the network"
  );

  assert.ok(hasPair(confined, "--tmpfs", home), "$HOME is a fresh tmpfs");
  assert.ok(hasPair(confined, "--setenv", "HOME", home));
  assert.ok(hasPair(confined, "--ro-bind", "/usr", "/usr"), "the system is read-only");
  assert.ok(hasPair(confined, "--bind", installDir, installDir), "the install dir is writable");
  assert.ok(hasPair(confined, "--bind", cfg, cfg), "an existing configPath is bound rw");
  assert.ok(
    !confined.some((a) => a.includes("never-created")),
    "a configPath that does not exist is skipped (bwrap would refuse to start)"
  );
  assert.ok(hasPair(confined, "--proc", "/proc") && hasPair(confined, "--dev", "/dev"));

  // The tmpfs must be pushed BEFORE anything under it is bound, or the bind
  // would be hidden by the mount.
  assert.ok(confined.indexOf(home) < confined.indexOf(installDir), "tmpfs $HOME precedes the binds under it");

  await fsp.rm(root, { recursive: true, force: true });
});

test("a host symlink (/lib → usr/lib) is recreated rather than bound", () => {
  const argv = argsFor("confined");
  for (const p of ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/sys"]) {
    let type = null;
    try {
      type = fs.lstatSync(p).isSymbolicLink() ? "symlink" : "dir";
    } catch (_) {
      continue; // not on this host — must not appear at all
    }
    if (type === "symlink") {
      const target = fs.readlinkSync(p);
      assert.ok(hasPair(argv, "--symlink", target, p), `${p} is recreated as a symlink to ${target}`);
    } else {
      assert.ok(hasPair(argv, "--ro-bind", p, p), `${p} is bound read-only`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* wrapLaunch composition                                              */
/* ------------------------------------------------------------------ */

test("wrapLaunch keeps the command and its args, in that order, after the prefix", () => {
  const logs = [];
  const ctx = { sandboxProfile: "offline", sandboxConfigPaths: [], log: (m) => logs.push(m) };
  const spec = { cmd: "/opt/app/AppRun", args: ["--fullscreen", "--seed=7"], installDir: "/opt/app" };

  const plain = sandbox.wrapLaunch({ sandboxProfile: "none", log: () => {} }, spec);
  assert.deepStrictEqual(plain, { cmd: spec.cmd, args: spec.args, wrapped: false, profile: "none" });

  if (!HAVE_BWRAP) return;
  const run = sandbox.wrapLaunch(ctx, spec);
  assert.strictEqual(run.wrapped, true);
  assert.match(run.cmd, /bwrap$/);
  assert.deepStrictEqual(
    run.args.slice(-3),
    ["/opt/app/AppRun", "--fullscreen", "--seed=7"],
    "appPrefs.launchArgs still trail the command INSIDE the sandbox"
  );
  assert.ok(logs.some((l) => l.includes("offline")), "the profile is logged");
});

test("no bwrap on PATH → unwrapped launch and one log line", (t) => {
  const prev = process.env.NX_HUB_BWRAP;
  process.env.NX_HUB_BWRAP = "/nonexistent/bwrap";
  sandbox._reset();
  t.after(() => {
    if (prev === undefined) delete process.env.NX_HUB_BWRAP;
    else process.env.NX_HUB_BWRAP = prev;
    sandbox._reset();
  });

  assert.strictEqual(sandbox.available(), false);
  const logs = [];
  const run = sandbox.wrapLaunch(
    { sandboxProfile: "confined", log: (m) => logs.push(m) },
    { cmd: "/opt/app/AppRun", args: ["--x"], installDir: "/opt/app" }
  );
  assert.deepStrictEqual(run, { cmd: "/opt/app/AppRun", args: ["--x"], wrapped: false, profile: "none" });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /bwrap is not on PATH/);
});

/* ------------------------------------------------------------------ */
/* live sandboxes                                                      */
/* ------------------------------------------------------------------ */

/** A probe script that reports what it can see, into the (bound) install dir. */
function probeScript({ installDir, cfgDir }) {
  return `#!/usr/bin/bash
out="${installDir}/report.txt"
: > "$out"
echo "args=$*" >> "$out"
echo "env=$NX_PROBE" >> "$out"
echo "home=$HOME" >> "$out"
echo "canary=$( [ -e "$HOME/canary.txt" ] && echo visible || echo hidden )" >> "$out"
echo "homewrite=$( (echo x > "$HOME/inside.txt") 2>/dev/null && echo ok || echo fail )" >> "$out"
echo "installwrite=$( (echo x > "${installDir}/wrote.txt") 2>/dev/null && echo ok || echo fail )" >> "$out"
echo "cfg=$(cat "${cfgDir}/settings.txt" 2>/dev/null || echo missing)" >> "$out"
echo "cfgwrite=$( (echo y > "${cfgDir}/new.txt") 2>/dev/null && echo ok || echo fail )" >> "$out"
if exec 3<>/dev/tcp/127.0.0.1/$NX_PORT; then echo "net=ok" >> "$out"; else echo "net=refused" >> "$out"; fi
echo "done=1" >> "$out"
`;
}

async function makeProbeBox(label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const home = path.join(root, "home");
  const installDir = path.join(home, "Applications/nx/demo/archive-dir-linux");
  const cfgDir = path.join(home, ".config/demo");
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.mkdir(cfgDir, { recursive: true });
  await fsp.writeFile(path.join(home, "canary.txt"), "the user's real home\n");
  await fsp.writeFile(path.join(cfgDir, "settings.txt"), "hello-from-config\n");
  const script = path.join(installDir, "probe.sh");
  await fsp.writeFile(script, probeScript({ installDir, cfgDir }), { mode: 0o755 });
  return { root, home, installDir, cfgDir, script };
}

/** A loopback listener on the HOST, so "network" means something checkable. */
function listener() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.end("hi\n"));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function parseReport(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

test("confined: tmpfs $HOME, writable install dir + configPaths, network up", { skip: SKIP }, async (t) => {
  const box = await makeProbeBox("nxsbx-confined");
  const { server, port } = await listener();
  t.after(async () => {
    server.close();
    await fsp.rm(box.root, { recursive: true, force: true });
  });

  const argv = sandbox.buildBwrapArgs("confined", {
    installDir: box.installDir,
    configPaths: ["~/.config/demo"],
    home: box.home,
    cwd: box.installDir,
    env: { HOME: box.home },
  });
  const res = spawnSync(sandbox.bwrapPath(), [...argv, "/usr/bin/bash", box.script, "--flag"], {
    env: { PATH: "/usr/bin:/bin", HOME: box.home, NX_PORT: String(port), NX_PROBE: "value" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.strictEqual(res.status, 0, `bwrap failed: ${res.stderr}`);

  const report = parseReport(await fsp.readFile(path.join(box.installDir, "report.txt"), "utf8"));
  assert.strictEqual(report.done, "1", "the probe ran to the end");
  assert.strictEqual(report.args, "--flag", "args reach the program inside the sandbox");
  assert.strictEqual(report.env, "value", "so does the environment");
  assert.strictEqual(report.home, box.home, "$HOME keeps its path…");
  assert.strictEqual(report.canary, "hidden", "…but the real home's contents are invisible");
  assert.strictEqual(report.homewrite, "ok", "the tmpfs home is writable");
  assert.strictEqual(
    fs.existsSync(path.join(box.home, "inside.txt")),
    false,
    "what it wrote to $HOME never touched the real one"
  );
  assert.strictEqual(report.installwrite, "ok", "the install dir is bound rw");
  assert.ok(fs.existsSync(path.join(box.installDir, "wrote.txt")), "…and that write is real");
  assert.strictEqual(report.cfg, "hello-from-config", "the configPath is readable");
  assert.strictEqual(report.cfgwrite, "ok");
  assert.ok(fs.existsSync(path.join(box.cfgDir, "new.txt")), "config writes land on the host");
  assert.strictEqual(report.net, "ok", "confined keeps loopback/network reachable");
});

test("offline: same sandbox, but the host's listener is unreachable", { skip: SKIP }, async (t) => {
  const box = await makeProbeBox("nxsbx-offline");
  const { server, port } = await listener();
  t.after(async () => {
    server.close();
    await fsp.rm(box.root, { recursive: true, force: true });
  });

  const argv = sandbox.buildBwrapArgs("offline", {
    installDir: box.installDir,
    configPaths: ["~/.config/demo"],
    home: box.home,
    cwd: box.installDir,
    env: { HOME: box.home },
  });
  const res = spawnSync(sandbox.bwrapPath(), [...argv, "/usr/bin/bash", box.script], {
    env: { PATH: "/usr/bin:/bin", HOME: box.home, NX_PORT: String(port), NX_PROBE: "value" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.strictEqual(res.status, 0, `bwrap failed: ${res.stderr}`);

  const report = parseReport(await fsp.readFile(path.join(box.installDir, "report.txt"), "utf8"));
  assert.strictEqual(report.net, "refused", "--unshare-net cuts it off from the host's loopback");
  assert.strictEqual(report.canary, "hidden", "the rest of the confinement is unchanged");
  assert.strictEqual(report.cfg, "hello-from-config");
});

test("group-killing the tracked pid tears the sandbox down (stop-path behavior)", { skip: SKIP }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nxsbx-die-"));
  const home = path.join(root, "home");
  const installDir = path.join(home, "app");
  await fsp.mkdir(installDir, { recursive: true });
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const beat = path.join(installDir, "beat.txt");
  const script = path.join(installDir, "heartbeat.sh");
  await fsp.writeFile(
    script,
    `#!/usr/bin/bash\nwhile true; do date +%s%N > ${JSON.stringify(beat)}; sleep 0.05; done\n`,
    { mode: 0o755 }
  );

  const argv = sandbox.buildBwrapArgs("offline", { installDir, home, cwd: installDir, env: { HOME: home } });
  const child = spawn(sandbox.bwrapPath(), [...argv, "/usr/bin/bash", script], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdio: "ignore",
    detached: true, // like spawnDetached: the group leader the stop paths target
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < 100 && !fs.existsSync(beat); i += 1) await wait(20);
  assert.ok(fs.existsSync(beat), "the heartbeat started inside the sandbox");
  const first = fs.readFileSync(beat, "utf8");
  await wait(200);
  assert.notStrictEqual(fs.readFileSync(beat, "utf8"), first, "it is really beating");

  // The stop paths use util.killTree — the process GROUP, not bwrap alone
  // (without --die-with-parent, killing only bwrap leaves the app running).
  require("../../src/main/install/util").killTree(child.pid, "SIGKILL");
  await wait(400);
  const afterKill = fs.readFileSync(beat, "utf8");
  await wait(400);
  assert.strictEqual(fs.readFileSync(beat, "utf8"), afterKill, "the sandboxed process died with its bwrap");
});

/* ------------------------------------------------------------------ */
/* through the real engine                                             */
/* ------------------------------------------------------------------ */

test("archive-dir.launch runs the app inside the sandbox, prefs included", { skip: SKIP }, async (t) => {
  const box = await H.makeSandbox("launch-sandboxed");
  const restoreXdg = H.withXdg(box);
  t.after(async () => {
    restoreXdg();
    await H.cleanup(box);
  });

  const app = { id: "demo", name: "Demo", repo: "nerdrx/demo", configPaths: ["~/.config/demo"] };
  const artifact = {
    id: "archive-dir-linux",
    label: "Linux build",
    kind: "archive-dir",
    platform: "linux",
    assetName: "demo-linux.tar.gz",
    version: "1.0.0",
  };

  // install a probe binary through the real engine
  const src = path.join(box.root, "src");
  await fsp.mkdir(src, { recursive: true });
  const ctx = H.makeCtx(box, {
    appPrefs: { launchArgs: ["--from-prefs"], launchEnv: { NX_PROBE: "from-prefs" } },
    sandboxProfile: "offline",
    sandboxConfigPaths: ["~/.config/demo"],
  });
  // the install dir is only known after the install, so the probe discovers
  // its own directory at run time
  await H.buildTree(src, {
    demo: {
      mode: 0o755,
      content: `#!/usr/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/report.txt"
: > "$out"
echo "args=$*" >> "$out"
echo "env=$NX_PROBE" >> "$out"
echo "canary=$( [ -e "$HOME/canary.txt" ] && echo visible || echo hidden )" >> "$out"
echo "installwrite=$( (echo x > "$here/wrote.txt") 2>/dev/null && echo ok || echo fail )" >> "$out"
echo "done=1" >> "$out"
`,
    },
  });
  const tarball = H.tarGz(src, path.join(box.downloads, "demo-1.0.0-linux.tar.gz"));
  const res = await engine.install({ app, artifact, filePath: tarball, ctx });

  // a canary in the REAL home the launch inherits
  const realHome = process.env.HOME;
  const canary = path.join(realHome, ".nx-sandbox-canary.txt");
  const hadCanary = fs.existsSync(canary);
  if (!hadCanary) await fsp.writeFile(canary, "canary\n");
  t.after(async () => {
    if (!hadCanary) await fsp.rm(canary, { force: true });
  });

  const launch = await engine.launch({ app, artifact, installedPath: res.path, ctx });
  assert.strictEqual(launch.sandbox, "offline", "the engine reports which profile it used");

  const report = path.join(res.path, "report.txt");
  for (let i = 0; i < 200 && !fs.existsSync(report); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const parsed = parseReport(await fsp.readFile(report, "utf8"));
  assert.strictEqual(parsed.done, "1", `probe never finished (log: ${ctx.logs.join(" | ")})`);
  assert.strictEqual(parsed.args, "--from-prefs", "launchArgs apply inside the sandbox");
  assert.strictEqual(parsed.env, "from-prefs", "so does launchEnv");
  assert.strictEqual(parsed.canary, "hidden", "$HOME is the sandbox's, not the user's");
  assert.strictEqual(parsed.installwrite, "ok");
  assert.ok(
    ctx.logs.some((l) => l.includes("sandbox: offline")),
    "the launch log says which profile ran"
  );
});
