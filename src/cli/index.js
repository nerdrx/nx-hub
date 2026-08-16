"use strict";
// nx — NX Hub from the terminal.
//
// Runs on the hub's own runtime (see bin/nx: ELECTRON_RUN_AS_NODE=1), drives the
// same pure-node modules the GUI drives, and never opens a window. Safe to use
// while the hub is running: state.json writes are atomic, last writer wins.
//
// Exit codes:  0 ok · 1 usage / user error · 2 operation failed

const readline = require("readline");

const { parseArgv } = require("./args");
const { styleFor } = require("./ansi");
const { matchApp, matchStack, matchPeer, pickArtifact, hostPlatform } = require("./match");
const { createProgress } = require("./progress");
const render = require("./render");
const shim = require("./shim");
// v0.7 [dev-tools]: `nx dev` and `nx bisect` are self-contained shells over
// src/main/devlinks.js and src/main/bisect.js.
const dev = require("./dev");
const bisect = require("./bisect");
// v0.8 [recorder]: `nx log` reads the flight recorder's journal off disk — it
// needs neither a running hub nor a discovery pass.
const logCmd = require("./log");
// v0.8 [timemachine]: `nx snapshots` / `nx restore` over src/main/snapshots.js.
const snapshotsCli = require("./snapshots");

const EXIT_OK = 0;
const EXIT_USER = 1;
const EXIT_FAIL = 2;

const ALIASES = {
  ls: "list",
  apps: "list",
  show: "info",
  i: "install",
  add: "install",
  rm: "uninstall",
  remove: "uninstall",
  up: "update",
  upgrade: "update",
  run: "launch",
  start: "launch",
  sync: "refresh",
  logs: "log", // v0.8: the flight recorder
  activity: "log",
  // v0.5: `status` is the connector view now (SPEC "NX Connector → IPC
  // additions": `nx status` = bus clients). The environment report kept its
  // own name, `nx doctor`, which is what every doc and every script used.
  stacks: "stack",
  peers: "fleet", // v0.6
  // v0.8 [timemachine]
  snapshot: "snapshots",
  snaps: "snapshots",
  "--help": "help",
  "-h": "help",
};

/** A problem the user can fix by typing something else → exit 1. */
class UserError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "UserError";
    this.hint = hint || null;
    this.exitCode = EXIT_USER;
  }
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string[]} argv arguments after the program name
 * @param {object} [opts] injection points for tests
 * @returns {Promise<number>} exit code
 */
async function run(argv, opts = {}) {
  const parsed = parseArgv(argv);
  const flags = parsed.flags;
  const env = opts.env || process.env;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;

  const colorForce = flags.plain === true || flags.color === false ? false : opts.color;
  const st = styleFor(stdout, env, colorForce);
  const stErr = styleFor(stderr, env, colorForce);
  const out = (text) => stdout.write(`${text}\n`);
  const err = (text) => stderr.write(`${text}\n`);
  const json = Boolean(flags.json);

  // The hub logs generously to stdout; a CLI must not. --verbose lets it back in
  // (the file log at <dataDir>/logs/nx-hub.log always keeps everything).
  if (!flags.verbose) env.NX_HUB_QUIET = "1";

  const command = ALIASES[parsed.command] || parsed.command;

  if (parsed.unknown.length) {
    err(`${stErr.danger("nx:")} unknown option ${parsed.unknown.join(", ")}`);
    err(stErr.dim("try `nx help`"));
    return EXIT_USER;
  }

  const runtime = opts.runtime || require("./runtime").createRuntime();

  if (flags.version && !command) {
    out(runtime.hubVersion ? runtime.hubVersion() : "0.0.0");
    return EXIT_OK;
  }
  if (!command || command === "help" || flags.help) {
    out(render.renderHelp({ style: st, hubVersion: runtime.hubVersion ? runtime.hubVersion() : null }));
    return command || flags.help ? EXIT_OK : EXIT_USER;
  }

  const ctx = {
    runtime,
    flags,
    args: parsed.args,
    st,
    stErr,
    out,
    err,
    json,
    stdout,
    stderr,
    stdin: opts.stdin || process.stdin,
    env,
    platform: opts.platform || process.platform,
    confirm: opts.confirm || defaultConfirm,
    // v0.6: `nx fleet` talks to peers directly, so it gets its own tiny
    // runtime rather than the hub-shaped one. Injectable for tests.
    fleet: opts.fleet || null,
    prompt: opts.prompt || defaultPrompt,
    // v0.8 [recorder]: the journal module (real one unless a test injects one)
    // and `--follow`'s knobs — {intervalMs, signal, unref} — so a test can
    // drive the tail without waiting on wall-clock seconds.
    recorder: opts.recorder || null,
    follow: opts.follow || null,
  };

  // v0.7 [dev-tools]: the shared helpers, reachable from ./dev.js and
  // ./bisect.js without importing this module back (that would close a cycle).
  ctx.loadApps = (opts2) => loadApps(ctx, opts2);
  ctx.withStatus = (message, fn) => withStatus(ctx, message, fn);
  ctx.requireApp = (apps, query) => requireApp(ctx, apps, query);
  ctx.requireArtifact = (app, query, mode) => requireArtifact(ctx, app, query, mode);
  ctx.jobHooks = () => jobHooks(ctx);

  const handlers = {
    list: cmdList,
    info: cmdInfo,
    install: cmdInstall,
    uninstall: cmdUninstall,
    update: cmdUpdate,
    launch: cmdLaunch,
    rollback: cmdRollback,
    versions: cmdVersions,
    refresh: cmdRefresh,
    doctor: cmdDoctor,
    status: cmdStatus,
    stack: cmdStack,
    fleet: cmdFleet,
    // v0.7 [dev-tools]
    dev: dev.cmdDev,
    bisect: bisect.cmdBisect,
    // v0.8 [recorder]
    log: logCmd.cmdLog,
    // v0.8 [timemachine]
    snapshots: snapshotsCli.cmdSnapshots,
    restore: snapshotsCli.cmdRestore,
    shim: cmdShim,
  };

  const handler = handlers[command];
  if (!handler) {
    err(`${stErr.danger("nx:")} unknown command "${parsed.command}"`);
    err(stErr.dim("try `nx help`"));
    return EXIT_USER;
  }

  try {
    const code = await handler(ctx);
    return typeof code === "number" ? code : EXIT_OK;
  } catch (e) {
    const code = e && e.exitCode ? e.exitCode : EXIT_FAIL;
    if (json) out(JSON.stringify({ ok: false, error: e.message || String(e) }, null, 2));
    else {
      err(`${stErr.danger("nx:")} ${e.message || String(e)}`);
      if (e && e.hint) err(stErr.dim(`  ${e.hint}`));
    }
    return code;
  }
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Run `fn` behind a transient "checking…" line on stderr (TTY only). */
async function withStatus(ctx, message, fn) {
  const show = ctx.stderr.isTTY && !ctx.json;
  if (show) ctx.stderr.write(`${ctx.stErr.dim(message)}\r`);
  try {
    return await fn();
  } finally {
    if (show) ctx.stderr.write(`${" ".repeat(ctx.stErr.strip(message).length)}\r`);
  }
}

async function loadApps(ctx, { force = false } = {}) {
  return withStatus(ctx, "checking sources…", () => ctx.runtime.apps({ force }));
}

/** Resolve the app named by the first positional, or throw a UserError. */
function requireApp(ctx, apps, query) {
  const { app, candidates, error } = matchApp(apps, query);
  if (app) return app;
  const hint = candidates.length
    ? `did you mean: ${candidates.slice(0, 8).map((a) => a.id).join(", ")}`
    : "run `nx list` to see every app";
  throw new UserError(error, { hint });
}

function requireArtifact(ctx, app, query, mode) {
  const { artifact, candidates, error } = pickArtifact(app, query, { mode, platform: ctx.platform });
  if (artifact) return artifact;
  const hint = candidates.length
    ? `available: ${candidates.map((a) => `${a.id}${a.platform ? ` (${a.platform})` : ""}`).join(", ")}`
    : `nx info ${app.id}`;
  throw new UserError(error, { hint });
}

/** Progress + toast plumbing shared by install/uninstall/update/rollback. */
function jobHooks(ctx) {
  const progress = createProgress({ stream: ctx.stderr, style: ctx.stErr, tty: ctx.stderr.isTTY });
  return {
    progress,
    onProgress: (evt) => progress.update(evt),
    onToast: (evt) => {
      if (evt.level === "error" || evt.level === "warn") progress.note(evt.message, evt.level);
      else progress.note(evt.message, "info");
    },
  };
}

async function defaultConfirm(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  // Non-interactive (pipes, CI, scripts) proceeds — the caller asked for it.
  if (!stdin.isTTY) return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Read one line from stdin. Used by `nx fleet pair` for the six digits the
 * other hub is showing — a secret typed by a human, never a command-line
 * argument (those land in shell history and in `ps`).
 */
async function defaultPrompt(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

function versionLabel(app, artifact) {
  const v = artifact.sourceVersion || (app.latest && app.latest.version);
  return v ? ` ${v}` : "";
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdList(ctx) {
  const apps = await loadApps(ctx, { force: Boolean(ctx.flags.force) });
  const state = ctx.runtime.cached();
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        render.listJson(apps, {
          hubVersion: ctx.runtime.hubVersion(),
          platform: hostPlatform(ctx.platform),
          lastRefresh: state.lastRefresh || null,
        }),
        null,
        2
      )
    );
    return EXIT_OK;
  }
  ctx.out(render.renderList(apps, { style: ctx.st, showAll: Boolean(ctx.flags.all) }));
  warnAboutErrors(ctx, state);
  return EXIT_OK;
}

async function cmdInfo(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  if (ctx.json) {
    ctx.out(JSON.stringify(render.appJson(app), null, 2));
    return EXIT_OK;
  }
  ctx.out(render.renderInfo(app, { style: ctx.st, platform: ctx.platform }));
  return EXIT_OK;
}

async function cmdInstall(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  if (app.unpublished) throw new UserError(`${app.name} has no release the hub can install.`, { hint: `nx info ${app.id}` });
  const artifact = requireArtifact(ctx, app, ctx.args[1], "install");
  const tag = ctx.flags.tag || null;

  const { progress, onProgress, onToast } = jobHooks(ctx);
  ctx.err(`${ctx.stErr.violet("installing")} ${ctx.stErr.text(`${app.name} — ${artifact.label}`)}${ctx.stErr.dim(tag ? ` (${tag})` : versionLabel(app, artifact))}`);
  const result = await ctx.runtime.install(app.id, artifact.id, { tag, onProgress, onToast });
  progress.finish(result.message);
  return EXIT_OK;
}

async function cmdUninstall(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  const artifact = requireArtifact(ctx, app, ctx.args[1], "installed");

  if (!ctx.flags.yes) {
    const where = artifact.installed && artifact.installed.path ? ` from ${artifact.installed.path}` : "";
    const okay = await ctx.confirm(`Remove ${app.name} — ${artifact.label}${where}?`);
    if (!okay) {
      ctx.err(ctx.stErr.muted("Nothing removed."));
      return EXIT_OK;
    }
  }

  const { progress, onProgress, onToast } = jobHooks(ctx);
  const result = await ctx.runtime.uninstall(app.id, artifact.id, { onProgress, onToast });
  progress.finish(result.message);
  return EXIT_OK;
}

async function cmdUpdate(ctx) {
  const apps = await loadApps(ctx, { force: Boolean(ctx.flags.force) });
  const targets = [];

  if (ctx.args[0]) {
    const app = requireApp(ctx, apps, ctx.args[0]);
    const pending = (app.artifacts || []).filter((a) => a.updateAvailable);
    if (!pending.length) {
      ctx.out(`${ctx.st.cyan("✓")} ${app.name} is up to date.`);
      return EXIT_OK;
    }
    for (const artifact of pending) targets.push({ app, artifact });
  } else {
    for (const app of apps) {
      for (const artifact of app.artifacts || []) {
        if (artifact.updateAvailable) targets.push({ app, artifact });
      }
    }
    if (!targets.length) {
      ctx.out(`${ctx.st.cyan("✓")} Everything is up to date.`);
      return EXIT_OK;
    }
    if (!ctx.flags.all) {
      ctx.out(
        `${ctx.st.amber("↑")} ${targets.length} update${targets.length > 1 ? "s" : ""} pending: ${targets
          .map((t) => `${t.app.id}/${t.artifact.id}`)
          .join(", ")}`
      );
      ctx.out(ctx.st.dim("  install them with `nx update --all`, or name one app: `nx update <app>`"));
      return EXIT_OK;
    }
  }

  let failed = 0;
  for (const { app, artifact } of targets) {
    const { progress, onProgress, onToast } = jobHooks(ctx);
    ctx.err(
      `${ctx.stErr.violet("updating")} ${ctx.stErr.text(`${app.name} — ${artifact.label}`)} ${ctx.stErr.dim(
        `${(artifact.installed && artifact.installed.version) || "?"} → ${artifact.sourceVersion || (app.latest && app.latest.version) || "?"}`
      )}`
    );
    try {
      const result = await ctx.runtime.install(app.id, artifact.id, { onProgress, onToast });
      progress.finish(result.message);
    } catch (e) {
      failed += 1;
      progress.finish(`${app.name} — ${artifact.label}: ${e.message}`, "error");
    }
  }
  return failed ? EXIT_FAIL : EXIT_OK;
}

async function cmdLaunch(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  const artifact = requireArtifact(ctx, app, ctx.args[1], "launch");
  await ctx.runtime.launch(app.id, artifact.id);
  ctx.out(`${ctx.st.cyan("✓")} Launched ${app.name} — ${artifact.label}`);
  return EXIT_OK;
}

async function cmdRollback(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  const artifact = requireArtifact(ctx, app, ctx.args[1], "rollback");
  if (!ctx.flags.yes) {
    const okay = await ctx.confirm(
      `Roll ${app.name} — ${artifact.label} back to ${artifact.prevVersion || "the previous version"}?`
    );
    if (!okay) {
      ctx.err(ctx.stErr.muted("Nothing changed."));
      return EXIT_OK;
    }
  }
  const { progress, onProgress, onToast } = jobHooks(ctx);
  const result = await ctx.runtime.rollback(app.id, artifact.id, { onProgress, onToast });
  progress.finish(result.message);
  return EXIT_OK;
}

async function cmdVersions(ctx) {
  const apps = await loadApps(ctx);
  const app = requireApp(ctx, apps, ctx.args[0]);
  const releases = await withStatus(ctx, "loading releases…", () => ctx.runtime.releases(app.id));
  if (ctx.json) {
    ctx.out(JSON.stringify({ id: app.id, name: app.name, repo: app.repo, releases }, null, 2));
    return EXIT_OK;
  }
  ctx.out(render.renderVersions(app, releases, { style: ctx.st }));
  return EXIT_OK;
}

async function cmdRefresh(ctx) {
  const started = Date.now();
  const state = await withStatus(ctx, "refreshing…", () => ctx.runtime.refresh({ force: Boolean(ctx.flags.force) }));
  const apps = state.apps || [];
  const summary = render.summarize(apps);
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { ok: true, ms: Date.now() - started, lastRefresh: state.lastRefresh || null, summary, errors: state.errors || [] },
        null,
        2
      )
    );
    return EXIT_OK;
  }
  ctx.out(
    `${ctx.st.cyan("✓")} ${ctx.st.text(`${summary.total} apps`)} ${ctx.st.dim(
      `(${summary.published} installable, ${summary.installed} installed)`
    )}  ${summary.updates ? ctx.st.amber(`${summary.updates} update${summary.updates > 1 ? "s" : ""}`) : ctx.st.muted("no updates")}  ${ctx.st.dim(
      `${Date.now() - started} ms`
    )}`
  );
  warnAboutErrors(ctx, state);
  return (state.errors || []).length && !apps.length ? EXIT_FAIL : EXIT_OK;
}

async function cmdDoctor(ctx) {
  // A CLI process starts with an empty discovery cache, so doctor runs one pass
  // first — that is what makes "rate limit", "sources" and the app counts mean
  // anything. `--offline` reports only what is on disk. discovery.refresh()
  // swallows its own failures, so this never turns doctor into an error.
  const info = await withStatus(ctx, "checking…", async () => {
    if (!ctx.flags.offline) {
      try {
        await ctx.runtime.apps({ force: Boolean(ctx.flags.force) });
      } catch (_) {
        /* an unreachable GitHub is a finding, not a crash */
      }
    }
    return ctx.runtime.doctor();
  });
  if (ctx.json) {
    ctx.out(JSON.stringify(info, null, 2));
    return EXIT_OK;
  }
  ctx.out(render.renderDoctor(info, { style: ctx.st }));
  return EXIT_OK;
}

/* ------------------------------------------------------------------ */
/* v0.5: the NX Connector bus and stacks                               */
/* ------------------------------------------------------------------ */

/**
 * `nx status` — who is live on the bus.
 *
 * The CLI is a SEPARATE PROCESS from the GUI hub and the wire protocol has no
 * query message, so this never joins the bus as a client. It reads the hub's
 * own snapshot (`<dataDir>/connector-clients.json`) and cross-checks it by
 * trying to bind the port: bindable = nothing is listening = no hub.
 */
async function cmdStatus(ctx) {
  const info = await withStatus(ctx, "asking the bus…", () => ctx.runtime.connectorStatus());
  if (ctx.json) {
    ctx.out(JSON.stringify(render.statusJson(info), null, 2));
    return EXIT_OK;
  }
  ctx.out(render.renderStatus(info, { style: ctx.st }));
  return EXIT_OK;
}

const STACK_SUBS = ["ls", "list", "run", "stop"];

/**
 * `nx stack ls | run <id> | stop <id>`.
 *
 * A run driven from here happens IN THIS PROCESS: the apps become children of
 * the `nx` process, so their pids are unknown to the GUI hub (its `stop` can
 * still reach them over the bus, but not by signal). Documented in SPEC.
 */
async function cmdStack(ctx) {
  const sub = String(ctx.args[0] || "ls").toLowerCase();
  if (!STACK_SUBS.includes(sub)) {
    throw new UserError(`unknown stack command "${ctx.args[0]}"`, { hint: "nx stack ls | run <id> | stop <id>" });
  }
  const stacks = ctx.runtime.stackList();

  if (sub === "ls" || sub === "list") {
    if (ctx.json) {
      ctx.out(JSON.stringify(render.stacksJson(stacks), null, 2));
      return EXIT_OK;
    }
    ctx.out(render.renderStacks(stacks, { style: ctx.st }));
    return EXIT_OK;
  }

  const { stack, candidates, error } = matchStack(stacks, ctx.args[1]);
  if (!stack) {
    throw new UserError(error, {
      hint: candidates.length ? `did you mean: ${candidates.map((s) => s.id).join(", ")}` : "nx stack ls",
    });
  }

  if (sub === "stop") {
    const result = await ctx.runtime.stopStack(stack.id);
    if (ctx.json) {
      ctx.out(JSON.stringify(result, null, 2));
      return result.ok ? EXIT_OK : EXIT_FAIL;
    }
    if (!result.ok) {
      ctx.err(`${ctx.stErr.muted(result.reason || "nothing to stop")}`);
      return EXIT_OK;
    }
    for (const entry of result.stopped) {
      ctx.out(render.renderStackPhase({ stepIndex: entry.stepIndex, appId: entry.appId, phase: "stopped", how: entry.how }, { style: ctx.st }));
    }
    ctx.out(`${ctx.st.cyan("✓")} Stopped ${stack.name} ${ctx.st.dim(`(${result.stopped.length} step(s))`)}`);
    return EXIT_OK;
  }

  // A step may name no artifact, and that is resolved against the discovery
  // model at run time — a CLI process starts with an empty one, so fill it
  // before the first launch rather than failing on "Unknown artifact".
  await loadApps(ctx);

  // run — phases stream out as they happen, on stderr so stdout stays pipeable
  const events = [];
  const off = ctx.runtime.on((evt) => {
    if (!evt || evt.type !== "stack-progress" || evt.stackId !== stack.id) return;
    events.push(evt);
    if (!ctx.json) ctx.err(render.renderStackPhase(evt, { style: ctx.stErr }));
  });
  try {
    ctx.err(`${ctx.stErr.violet("running")} ${ctx.stErr.text(stack.name)} ${ctx.stErr.dim(`${stack.steps.length} steps`)}`);
    const result = await ctx.runtime.runStack(stack.id);
    if (ctx.json) {
      ctx.out(JSON.stringify(Object.assign({}, result, { phases: events }), null, 2));
    } else if (result.ok) {
      ctx.out(`${ctx.st.cyan("✓")} ${stack.name} is up`);
    } else {
      ctx.out(`${ctx.st.danger("✗")} ${stack.name} ${ctx.st.dim(result.failed ? `— ${result.failed.message}` : "stopped")}`);
    }
    return result.ok ? EXIT_OK : EXIT_FAIL;
  } finally {
    off();
  }
}

/* ------------------------------------------------------------------ */
/* v0.6: the fleet                                                     */
/* ------------------------------------------------------------------ */

const FLEET_SUBS = ["ls", "list", "pair", "unpair", "install", "update", "launch", "wake"];

/** The CLI's fleet client — created on demand so `nx list` never touches it. */
function fleetOf(ctx) {
  if (!ctx.fleet) ctx.fleet = require("./fleet").createFleetCli();
  return ctx.fleet;
}

function requirePeer(ctx, peers, query) {
  const { peer, candidates, error } = matchPeer(peers, query);
  if (peer) return peer;
  throw new UserError(error, {
    hint: candidates.length ? `did you mean: ${candidates.map((p) => p.name).join(", ")}` : "nx fleet ls",
  });
}

/**
 * `nx fleet ls | pair <host> | install <peer> <app> [artifact] | update <peer>
 *  | unpair <peer> | launch <peer> <app> [artifact]`
 *
 * Every one of these dials the peer DIRECTLY from this process (secrets come
 * from fleet.json), so none of them needs the local hub to be running.
 */
async function cmdFleet(ctx) {
  const sub = String(ctx.args[0] || "ls").toLowerCase();
  if (!FLEET_SUBS.includes(sub)) {
    throw new UserError(`unknown fleet command "${ctx.args[0]}"`, {
      hint: "nx fleet ls | pair <host> | install <peer> <app> | update <peer> | unpair <peer> | wake <peer>",
    });
  }
  const fleet = fleetOf(ctx);

  if (sub === "ls" || sub === "list") return fleetList(ctx, fleet);
  if (sub === "pair") return fleetPair(ctx, fleet);

  const peer = requirePeer(ctx, fleet.peers(), ctx.args[1]);
  if (sub === "unpair") return fleetUnpair(ctx, fleet, peer);
  if (sub === "wake") return fleetWake(ctx, fleet, peer);
  if (sub === "launch") return fleetLaunch(ctx, fleet, peer);
  if (sub === "install") return fleetInstall(ctx, fleet, peer);
  return fleetUpdate(ctx, fleet, peer);
}

async function fleetList(ctx, fleet) {
  const identity = fleet.identity();
  const rows = await withStatus(ctx, "asking the fleet…", () => fleet.list({ probe: !ctx.flags.offline }));
  if (ctx.json) {
    ctx.out(JSON.stringify(render.fleetJson(rows, { identity }), null, 2));
    return EXIT_OK;
  }
  ctx.out(render.renderFleet(rows, { style: ctx.st, identity }));
  return EXIT_OK;
}

async function fleetPair(ctx, fleet) {
  const host = ctx.args[1];
  if (!host) throw new UserError("Name the other hub's address.", { hint: "nx fleet pair 192.168.1.20" });
  const port = Number(ctx.flags.port) > 0 ? Number(ctx.flags.port) : undefined;

  // The code is READ from stdin, never taken as an argument: arguments end up
  // in shell history and in `ps` output, and this one seeds a shared secret.
  ctx.err(ctx.stErr.dim(`On ${host}, open NX Hub → Fleet → Pair. It shows a six-digit code.`));
  const code = String(await ctx.prompt("code: ", { stdin: ctx.stdin, stdout: ctx.stderr })).trim();
  if (!/^[0-9]{6}$/.test(code)) throw new UserError("A pairing code is six digits.");

  const peer = await withStatus(ctx, "pairing…", () => fleet.pair(host, code, port));
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, peer: { id: peer.id, name: peer.name, host: peer.host, port: peer.port } }, null, 2));
    return EXIT_OK;
  }
  ctx.out(`${ctx.st.cyan("✓")} Paired with ${ctx.st.text(peer.name)} ${ctx.st.dim(`(${peer.host} · ${peer.id})`)}`);
  return EXIT_OK;
}

async function fleetUnpair(ctx, fleet, peer) {
  if (!ctx.flags.yes) {
    const okay = await ctx.confirm(`Forget ${peer.name} (${peer.host})?`);
    if (!okay) {
      ctx.err(ctx.stErr.muted("Nothing changed."));
      return EXIT_OK;
    }
  }
  const removed = fleet.unpair(peer.id);
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: removed, id: peer.id }, null, 2));
    return removed ? EXIT_OK : EXIT_FAIL;
  }
  ctx.out(`${ctx.st.cyan("✓")} Forgot ${peer.name}. ${ctx.st.dim("Pair again to reconnect — the secret is gone.")}`);
  return EXIT_OK;
}

/**
 * `nx fleet wake <peer>` (SPEC v0.7) — the only fleet command that talks to a
 * machine which is, by design, not listening. Magic packets go out from this
 * process; nothing comes back, so the command reports what it SENT and points
 * at `nx fleet ls` for the answer.
 */
async function fleetWake(ctx, fleet, peer) {
  const result = await fleet.wake(peer);
  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({ id: peer.id, name: peer.name }, result), null, 2));
    return result.ok ? EXIT_OK : EXIT_FAIL;
  }
  if (result.reason === "no-mac") {
    ctx.out(
      `${ctx.st.danger("✗")} No hardware address for ${ctx.st.text(peer.name)} yet. ` +
        ctx.st.dim("Connect to it once while it is awake — the hub learns the MAC from the session.")
    );
    return EXIT_FAIL;
  }
  if (!result.ok) {
    ctx.out(`${ctx.st.danger("✗")} Could not send the wake packets ${ctx.st.dim("(no broadcast permission?)")}`);
    return EXIT_FAIL;
  }
  ctx.out(
    `${ctx.st.cyan("✓")} Woke ${ctx.st.text(peer.name)} ${ctx.st.dim(`(${result.mac})`)}\n` +
      ctx.st.muted("  It takes a moment. `nx fleet ls` will show it when it is up.")
  );
  return EXIT_OK;
}

async function fleetLaunch(ctx, fleet, peer) {
  const appId = ctx.args[2];
  if (!appId) throw new UserError("Name an app to launch.", { hint: `nx fleet launch ${peer.name} <app>` });
  const ack = await withStatus(ctx, "asking…", () => fleet.launch(peer, appId, ctx.args[3]));
  if (ctx.json) {
    ctx.out(JSON.stringify(ack, null, 2));
    return EXIT_OK;
  }
  ctx.out(`${ctx.st.cyan("✓")} Launched ${ack.appId}${ack.artifactId ? `/${ack.artifactId}` : ""} on ${peer.name}`);
  return EXIT_OK;
}

/** Progress from a remote job streams to stderr, so stdout stays pipeable. */
function fleetEventSink(ctx) {
  const events = [];
  return {
    events,
    onEvent: (evt) => {
      events.push(evt);
      if (!ctx.json) ctx.err(render.renderFleetEvent(evt, { style: ctx.stErr }));
    },
  };
}

async function fleetInstall(ctx, fleet, peer) {
  const appId = ctx.args[2];
  if (!appId) throw new UserError("Name an app to install.", { hint: `nx fleet install ${peer.name} <app>` });
  const sink = fleetEventSink(ctx);
  ctx.err(`${ctx.stErr.violet("installing")} ${ctx.stErr.text(appId)} ${ctx.stErr.dim(`on ${peer.name}`)}`);
  const result = await fleet.install(peer, appId, ctx.args[3], { onEvent: sink.onEvent });
  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({ ok: result.ok !== false }, result, { events: sink.events }), null, 2));
    return result.ok === false ? EXIT_FAIL : EXIT_OK;
  }
  if (result.ok === false) {
    ctx.out(`${ctx.st.danger("✗")} ${appId} failed on ${peer.name}`);
    return EXIT_FAIL;
  }
  ctx.out(`${ctx.st.cyan("✓")} ${result.appName || appId} installed on ${peer.name}`);
  return EXIT_OK;
}

async function fleetUpdate(ctx, fleet, peer) {
  const sink = fleetEventSink(ctx);
  const result = await fleet.updateAll(peer, { onEvent: sink.onEvent });
  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({ ok: result.ok !== false }, result, { events: sink.events }), null, 2));
    return result.ok === false ? EXIT_FAIL : EXIT_OK;
  }
  if (!result.count) {
    ctx.out(`${ctx.st.cyan("✓")} ${peer.name} is up to date.`);
    return EXIT_OK;
  }
  const failed = (result.failures || []).length;
  if (failed) {
    ctx.out(`${ctx.st.danger("✗")} ${peer.name}: ${failed} of ${result.count} updates failed`);
    return EXIT_FAIL;
  }
  ctx.out(`${ctx.st.cyan("✓")} ${peer.name}: ${result.count} update${result.count > 1 ? "s" : ""} installed`);
  return EXIT_OK;
}

/** Hidden helper: `nx shim` reports (and with --force rewrites) ~/.local/bin/nx. */
async function cmdShim(ctx) {
  const info = shim.inspect({ binary: process.execPath, appDir: require("./runtime").ROOT });
  if (ctx.flags.force) {
    const result = shim.sync(
      { cliShim: true },
      { binary: process.execPath, appDir: require("./runtime").ROOT, platform: ctx.platform }
    );
    ctx.out(`${ctx.st.cyan("✓")} ${result.action} ${ctx.st.dim(result.path)}${result.reason ? ` — ${result.reason}` : ""}`);
    return result.action === "error" ? EXIT_FAIL : EXIT_OK;
  }
  ctx.out(`${ctx.st.text(info.path)} ${ctx.st.muted(info.state)}`);
  return EXIT_OK;
}

function warnAboutErrors(ctx, state) {
  const errors = (state && state.errors) || [];
  if (!errors.length) return;
  const limited = errors.find((e) => e.rateLimited);
  if (limited) ctx.err(ctx.stErr.amber(limited.message));
  else ctx.err(ctx.stErr.dim(`${errors.length} source${errors.length > 1 ? "s" : ""} could not be read — nx doctor for details`));
}

/* ------------------------------------------------------------------ */

/** Write everything out, then leave — keep-alive sockets must not stall us. */
function exitWhenFlushed(code) {
  process.exitCode = code;
  const hard = setTimeout(() => process.exit(code), 3000);
  Promise.all(
    [process.stdout, process.stderr].map(
      (s) =>
        new Promise((resolve) => {
          try {
            s.write("", resolve);
          } catch (_) {
            resolve();
          }
        })
    )
  ).then(() => {
    clearTimeout(hard);
    process.exit(code);
  });
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(exitWhenFlushed)
    .catch((e) => {
      process.stderr.write(`nx: ${(e && e.stack) || e}\n`);
      exitWhenFlushed(EXIT_FAIL);
    });
}

module.exports = { run, UserError, EXIT_OK, EXIT_USER, EXIT_FAIL, ALIASES };
