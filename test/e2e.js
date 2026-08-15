"use strict";
// NX Hub end-to-end: launches the REAL Electron app against a mock GitHub API
// inside a virtual display, then drives it over the :9020 e2e hooks.
//
//   node test/e2e.js
//
// A window must never appear on the desktop, so the app is started under
// xvfb-run when available, otherwise inside headless gamescope (the same
// invocation scripts/headless_test.sh uses). With neither, the run SKIPS.
//
// Not part of `npm test` — run it explicitly.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const helpers = require("./core/helpers");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron");
const HOOK = "http://127.0.0.1:9020";
const SCRATCH =
  process.env.NX_HUB_E2E_OUT ||
  "/tmp/claude-1000/-run-media-nerdrx-Lex-claude/d80e60fb-eb14-4095-9596-a6f3d874b8e9/scratchpad";

const OVERLAY = {
  version: 1,
  hidden: ["petri"],
  apps: {
    "banish-protocol": {
      name: "LIMBO PROTOCOL",
      // distinctive on purpose: proves the LIVE overlay won over the bundled copy
      tagline: "served by the e2e overlay",
      order: 1,
      artifacts: [
        { assetPattern: "*linux*.zip", label: "Linux build", kind: "archive-dir", platform: "linux" },
        { assetPattern: "*windows*.zip", label: "Windows build", kind: "windows-zip", platform: "windows" },
      ],
    },
    "wivrn-nx": { name: "WiVRn NX", tagline: "OpenXR streaming to the Pico", order: 2 },
  },
};

let failures = 0;
function check(ok, label, extra) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
  return ok;
}

function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hook(pathname, { method = "GET", raw = false } = {}) {
  const res = await fetch(`${HOOK}${pathname}`, { method });
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (_) {
    return { status: res.status, body: text };
  }
}

async function waitFor(fn, { timeout = 60000, interval = 400, label = "condition" } = {}) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ` (${lastErr.message})` : ""}`);
}

/** Pick a virtual-display launcher; null → nothing safe available. */
function displayLauncher() {
  if (has("xvfb-run")) {
    return {
      name: "xvfb-run",
      argv: (env) => ["xvfb-run", ["-a", ELECTRON, ".", "--no-sandbox", "--disable-dev-shm-usage"], env],
    };
  }
  if (has("gamescope")) {
    // same shape as scripts/headless_test.sh, but kept alive so we can drive it
    return {
      name: "gamescope (headless)",
      argv: (env) => [
        "gamescope",
        [
          "--backend",
          "headless",
          "-W",
          "1400",
          "-H",
          "900",
          "-w",
          "1400",
          "-h",
          "900",
          "--",
          ELECTRON,
          ".",
          "--no-sandbox",
          "--disable-gpu-sandbox",
          "--disable-dev-shm-usage",
        ],
        Object.assign({ GAMESCOPE_WAYLAND_DISPLAY: "" }, env),
      ],
    };
  }
  return null;
}

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.log("SKIP: electron binary missing — run npm install");
    return 0;
  }
  const launcher = displayLauncher();
  if (!launcher) {
    console.log("SKIP: no virtual display available (need xvfb-run or gamescope).");
    console.log("      GUI e2e must never open a window on the desktop — refusing to run.");
    return 0;
  }
  console.log(`NX Hub e2e — display: ${launcher.name}`);

  // ---- temp environment -------------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-e2e-"));
  const dataDir = path.join(root, "data");
  const installRoot = path.join(root, "apps");
  const fakeHome = path.join(root, "home");
  for (const d of [dataDir, installRoot, fakeHome]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({ owners: ["nerdrx"], extraRepos: [], checkIntervalHours: 6, installRoot, adbPath: "adb", token: null }, null, 2)
  );

  const mock = await helpers.startMockGitHub({ overlay: OVERLAY });
  console.log(`mock GitHub at ${mock.base}`);

  const env = Object.assign({}, process.env, {
    NX_HUB_E2E: "1",
    NX_HUB_DATA_DIR: dataDir,
    NX_HUB_INSTALL_ROOT: installRoot,
    NX_HUB_GITHUB_BASE: mock.base,
    NX_HUB_GITHUB_RAW_BASE: `${mock.base}/raw`,
    NX_HUB_NO_GH: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    HOME: fakeHome, // keep desktop entries / caches out of the real home
    XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
    XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
  });
  // requiring the test helpers set these for THIS process — the app must not inherit
  // them, or it would skip the live overlay fetch we want to exercise.
  delete env.NX_HUB_NO_LIVE_OVERLAY;
  delete env.NX_HUB_QUIET;
  delete env.NX_HUB_OVERLAY_FILE;

  const [cmd, args, spawnEnv] = launcher.argv(env);
  const child = spawn(cmd, args, { cwd: ROOT, env: spawnEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const logLines = [];
  const capture = (buf) => {
    const s = String(buf);
    logLines.push(s);
    if (process.env.NX_HUB_E2E_VERBOSE === "1") process.stdout.write(s);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    if (process.env.NX_HUB_E2E_VERBOSE === "1") console.log(`app exited: ${code}`);
  });

  // The compositor must never outlive the test: SIGTERM the whole group, then
  // SIGKILL whatever is still standing (gamescope can ignore a plain TERM).
  const signalAll = (sig) => {
    for (const target of [() => process.kill(-child.pid, sig), () => child.kill(sig)]) {
      try {
        target();
      } catch (_) {
        /* already gone */
      }
    }
  };
  const cleanup = async () => {
    signalAll("SIGTERM");
    for (let i = 0; i < 20 && !exited; i += 1) await sleep(150);
    if (!exited) {
      signalAll("SIGKILL");
      await sleep(300);
    }
  };
  process.on("exit", () => signalAll("SIGKILL"));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      signalAll("SIGKILL");
      process.exit(1);
    });
  }

  try {
    // ---- boot ----------------------------------------------------------
    await waitFor(
      async () => {
        if (exited) throw new Error(`app exited early:\n${logLines.join("").slice(-2000)}`);
        const r = await hook("/health");
        return r.status === 200;
      },
      { label: "e2e hooks on :9020", timeout: 90000 }
    );
    console.log("app is up\n");

    // ---- discovery -----------------------------------------------------
    console.log("discovery:");
    const state = await waitFor(
      async () => {
        const r = await hook("/state");
        return r.body && r.body.apps && r.body.apps.length ? r.body : null;
      },
      { label: "discovery results", timeout: 60000 }
    );
    const ids = state.apps.map((a) => a.id);
    check(ids.includes("wivrn-nx"), "wivrn-nx discovered", ids.join(","));
    check(ids.includes("banish-protocol"), "banish-protocol discovered");
    check(ids.includes("quadforge"), "quadforge discovered");
    const petri = state.apps.find((a) => a.id === "petri");
    check(Boolean(petri && petri.overlayHidden), "hidden repo listed with the overlayHidden flag");

    const limbo = state.apps.find((a) => a.id === "banish-protocol");
    check(limbo.name === "LIMBO PROTOCOL", "overlay name applied", limbo.name);
    check(limbo.tagline === "served by the e2e overlay", "LIVE overlay fetched (not the bundled fallback)", limbo.tagline);
    check(limbo.order === 1, "overlay order applied", String(limbo.order));
    check(limbo.latest && limbo.latest.version === "2.0", "version parsed from tag");
    const linux = limbo.artifacts.find((a) => a.id === "archive-dir-linux");
    check(Boolean(linux), "linux artifact classified", JSON.stringify(limbo.artifacts.map((a) => a.id)));
    check(limbo.artifacts.some((a) => a.platform === "windows"), "windows artifact present");

    const lonely = state.apps.find((a) => a.id === "lonely-repo");
    check(lonely && lonely.unpublished === true, "repo without releases is unpublished");
    check(typeof state.hubVersion === "string", "hubVersion reported", state.hubVersion);

    // shapes the renderer normalizes against
    check(state.tokenSource === "" || state.tokenSource === "gh" || state.tokenSource === "settings", "tokenSource published", JSON.stringify(state.tokenSource));
    check(state.adb && typeof state.adb.versions === "object" && Array.isArray(state.adb.devices), "adb {available, devices, versions}", JSON.stringify(state.adb));
    check(Array.isArray(state.jobs), "jobs is an array");
    check(state.rateLimit === null, "rateLimit null while healthy", JSON.stringify(state.rateLimit));
    check(
      limbo.artifacts.every((a) => typeof a.launchable === "boolean"),
      "every artifact has a launchable flag"
    );
    check(
      limbo.artifacts.find((a) => a.platform === "windows").launchable === false,
      "windows artifact is not launchable on linux"
    );

    // ---- renderer ------------------------------------------------------
    console.log("\nrenderer:");
    const dom = await hook("/dom", { raw: false });
    const html = typeof dom.body === "string" ? dom.body : JSON.stringify(dom.body);
    check(html.length > 200, "DOM served", `${html.length} bytes`);
    // the renderer is ESM over file:// with a strict CSP — prove the module graph
    // actually executed, not just that a body was served
    const painted = await waitFor(
      async () => {
        const d = await hook("/dom");
        return typeof d.body === "string" && /class="card[ "]/.test(d.body) ? d.body : null;
      },
      { label: "app cards rendered", timeout: 30000 }
    ).catch(() => null);
    check(Boolean(painted), "renderer painted real .card elements (ESM loaded under file://)");
    check(Boolean(painted) && /LIMBO PROTOCOL/i.test(painted), "card content comes from discovery");
    check(Boolean(painted) && !/card-skel/.test(painted), "skeleton replaced by real cards");

    const shot = await hook("/screenshot", { raw: true });
    const shotPath = path.join(SCRATCH, "nx-hub-e2e.png");
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(shotPath, shot.buffer);
    check(shot.status === 200 && shot.buffer.length > 1000, `screenshot saved → ${shotPath}`, `${shot.buffer.length} bytes`);

    // ---- install -------------------------------------------------------
    console.log("\ninstall:");
    const started = await hook("/install?appId=banish-protocol&artifactId=archive-dir-linux", { method: "POST" });
    check(started.status === 200 && started.body.jobId, "install job queued", JSON.stringify(started.body));
    const job = await waitFor(
      async () => {
        const r = await hook(`/job?id=${started.body.jobId}`);
        return r.body && ["done", "error", "cancelled"].includes(r.body.status) ? r.body : null;
      },
      { label: "install job to finish", timeout: 60000 }
    );
    check(job.status === "done", "install job completed", job.error || job.message);

    const installDir = path.join(installRoot, "nx", "banish-protocol", "archive-dir-linux");
    check(fs.existsSync(installDir), "install dir created", installDir);
    check(fs.existsSync(path.join(installDir, "run.sh")), "archive contents extracted");

    const afterInstall = (await hook("/state")).body;
    const installedArtifact = afterInstall.apps
      .find((a) => a.id === "banish-protocol")
      .artifacts.find((a) => a.id === "archive-dir-linux");
    check(installedArtifact.installed && installedArtifact.installed.version === "2.0", "state reports the install", JSON.stringify(installedArtifact.installed));
    check(installedArtifact.updateAvailable === false, "no update pending right after install");
    const stateJson = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
    check(Boolean(stateJson.installed["banish-protocol"]["archive-dir-linux"]), "state.json persisted");

    const shot2 = await hook("/screenshot", { raw: true });
    const shot2Path = path.join(SCRATCH, "nx-hub-e2e-installed.png");
    fs.writeFileSync(shot2Path, shot2.buffer);
    check(shot2.buffer.length > 1000, `post-install screenshot → ${shot2Path}`);

    // ---- uninstall -----------------------------------------------------
    console.log("\nuninstall:");
    const rm = await hook("/uninstall?appId=banish-protocol&artifactId=archive-dir-linux", { method: "POST" });
    const rmJob = await waitFor(
      async () => {
        const r = await hook(`/job?id=${rm.body.jobId}`);
        return r.body && ["done", "error", "cancelled"].includes(r.body.status) ? r.body : null;
      },
      { label: "uninstall job to finish", timeout: 60000 }
    );
    check(rmJob.status === "done", "uninstall job completed", rmJob.error || rmJob.message);
    check(!fs.existsSync(installDir), "install dir removed");
    const afterRemove = (await hook("/state")).body;
    const gone = afterRemove.apps
      .find((a) => a.id === "banish-protocol")
      .artifacts.find((a) => a.id === "archive-dir-linux");
    check(gone.installed === null, "state cleared after uninstall", JSON.stringify(gone.installed));

    // ---- refresh -------------------------------------------------------
    console.log("\nrefresh:");
    const refreshed = await hook("/refresh", { method: "POST" });
    check(refreshed.status === 200 && refreshed.body.apps > 0, "forced refresh re-ran discovery", JSON.stringify(refreshed.body));
  } catch (err) {
    failures += 1;
    console.log(`\nERROR: ${err.message}`);
    console.log(logLines.join("").slice(-3000));
  } finally {
    await cleanup();
    await mock.close();
    await sleep(300);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  console.log(`\n${failures === 0 ? "e2e PASSED" : `e2e FAILED (${failures} check(s))`}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
