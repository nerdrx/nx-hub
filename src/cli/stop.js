"use strict";
// `nx stop <app> [artifact] [--peer <name>] [--json]` — SPEC v0.11 "stop".
//
// A thin shell over src/main/running.js: the ladder, the verdict and the
// never-SIGKILL rule all live there. This file resolves what the user typed,
// prints one line, and picks an exit code (0 stopped or already gone, 2 when
// the process survived the ladder).
//
// ONE thing is CLI-specific. The GUI hub owns the only connector server and the
// wire protocol has no message a third process could inject, so `nx stop`
// cannot ask an app politely. It reads presence from the hub's own snapshot
// (<dataDir>/connector-clients.json, the same file `nx status` reads) and
// signals the pid the client reported at hello — the ladder simply starts one
// rung lower. The GUI's own Stop button, and `--peer`, still ask first.

const config = require("../main/config");
const discovery = require("../main/discovery");
const jobs = require("../main/jobs");
const ipc = require("../main/ipc");
const running = require("../main/running");
const { matchPeer, pickArtifact } = require("./match");

const EXIT_OK = 0;
const EXIT_FAIL = 2;

/** Structurally index.js's UserError — see the same note in ./dev.js. */
function userError(message, hint) {
  const e = new Error(message);
  e.name = "UserError";
  e.hint = hint || null;
  e.exitCode = 1;
  return e;
}

/* ------------------------------------------------------------------ */
/* the CLI's view of the bus                                           */
/* ------------------------------------------------------------------ */

const SNAPSHOT_MAX_AGE_MS = 120000;

/**
 * A read-only `connector` built from the hub's on-disk client snapshot. Re-read
 * on every call, so presence really does change under a poll.
 */
function snapshotBus({ maxAgeMs = SNAPSHOT_MAX_AGE_MS, readSnapshot = null } = {}) {
  const read = typeof readSnapshot === "function" ? readSnapshot : (ms) => ipc.readConnectorSnapshot(ms);
  const clients = () => {
    try {
      const snap = read(maxAgeMs);
      if (!snap || snap.stale || !Array.isArray(snap.clients)) return [];
      return snap.clients;
    } catch (_) {
      return []; // a missing or unreadable snapshot means "no bus", never a crash
    }
  };
  return {
    getClients: () => clients(),
    isPresent: (appId) => {
      const wanted = String(appId == null ? "" : appId).trim().toLowerCase();
      return clients().some((c) => c && String(c.app == null ? "" : c.app).trim().toLowerCase() === wanted);
    },
    // Not a rung this process can climb: see the header.
    requestShutdown: () => false,
  };
}

/** src/main/running.js, wired for a CLI process. */
function createCliRunning(opts = {}) {
  running.init({
    connector: opts.connector || snapshotBus(opts),
    jobs,
    config,
    discovery,
    fleet: opts.fleet || null,
    timing: opts.timing || {},
  });
  return running;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * One line for one verdict. `peer` only decorates the remote sentence.
 * @returns {{text:string, level:"ok"|"muted"|"fail"}}
 */
function stopLine(result, { name, peer } = {}) {
  const label = name || (result && result.appName) || (result && result.appId) || "that app";
  const how = result ? result.how : "not-running";
  if (result && result.ok) {
    if (how === "shutdown-request") return { text: `${label} stopped (asked politely)`, level: "ok" };
    if (how === "sigterm") return { text: `${label} stopped (SIGTERM)`, level: "ok" };
    if (how === "remote") return { text: `${label} stopped on ${peer || "the peer"}`, level: "ok" };
    return { text: `${label} had already stopped`, level: "ok" }; // "gone"
  }
  if (how === "not-running") return { text: `${label} was not running`, level: "muted" };
  if (how === "remote") {
    const why = (result && result.error) || "the peer refused the stop";
    return { text: `${label} was not stopped on ${peer || "the peer"} — ${why}`, level: "fail" };
  }
  return { text: `${label} is still running — it ignored the request`, level: "fail" };
}

function paint(ctx, line) {
  if (line.level === "ok") return `${ctx.st.cyan("✓")} ${ctx.st.text(line.text)}`;
  if (line.level === "muted") return `${ctx.st.dim("·")} ${ctx.st.muted(line.text)}`;
  return `${ctx.st.danger("✗")} ${ctx.st.text(line.text)}`;
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

async function cmdStop(ctx) {
  const apps = await ctx.loadApps();
  const app = ctx.requireApp(apps, ctx.args[0]);

  // With an explicit query the matcher runs over ALL artifacts, so an id always
  // works whatever the artifact's install state is.
  let artifactId = null;
  if (ctx.args[1]) {
    const { artifact, candidates, error } = pickArtifact(app, ctx.args[1], { mode: "any", platform: ctx.platform });
    if (!artifact) {
      throw userError(error, candidates.length ? `available: ${candidates.map((a) => a.id).join(", ")}` : `nx info ${app.id}`);
    }
    artifactId = artifact.id;
  }

  const peerFlag = ctx.flags.peer;
  if (peerFlag != null && String(peerFlag).trim() === "") {
    throw userError("--peer needs the name of a paired hub.", "nx fleet ls");
  }

  const mod = ctx.running || null;
  if (peerFlag) return stopOnPeer(ctx, app, artifactId, String(peerFlag).trim(), mod);

  const runner = mod || createCliRunning(ctx.stopOptions || {});
  const result = await runner.stop(app.id, artifactId, {});
  return report(ctx, result, { name: app.name });
}

/** `--peer <name>`: the one route that reaches another machine. */
async function stopOnPeer(ctx, app, artifactId, peerQuery, injected) {
  // eslint-disable-next-line global-require
  const fleetCli = ctx.fleet || (ctx.fleet = require("./fleet").createFleetCli());
  const { peer, candidates, error } = matchPeer(fleetCli.peers(), peerQuery);
  if (!peer) {
    throw userError(error, candidates.length ? `did you mean: ${candidates.map((p) => p.name).join(", ")}` : "nx fleet ls");
  }

  // The remote hub runs its OWN polite ladder over there (fleet `stop`); this
  // side only asks and reports. Adapting it to running.js's `fleet.remoteStop`
  // keeps one verdict shape for every route.
  const adapter = {
    remoteStop: async (peerId, appId) => {
      // eslint-disable-next-line global-require
      const { ask } = require("./fleet");
      return fleetCli.withPeer(peer, (session) => ask(session, { type: "stop", appId }));
    },
  };
  const runner = injected || createCliRunning(Object.assign({}, ctx.stopOptions, { fleet: adapter }));
  const result = await runner.stop(app.id, artifactId, { peer: peer.id });
  return report(ctx, result, { name: app.name, peer: peer.name });
}

function report(ctx, result, { name, peer } = {}) {
  const verdict = result || { ok: false, how: "not-running" };
  if (ctx.json) {
    ctx.out(JSON.stringify(Object.assign({ peer: peer || null }, verdict), null, 2));
  } else {
    ctx.out(paint(ctx, stopLine(verdict, { name, peer })));
  }
  // SPEC: 0 when it stopped or was already gone, 2 when a stop was attempted
  // and the process is still there.
  if (verdict.ok || verdict.how === "not-running") return EXIT_OK;
  return EXIT_FAIL;
}

module.exports = {
  cmdStop,
  // exported for tests
  stopLine,
  snapshotBus,
  createCliRunning,
  SNAPSHOT_MAX_AGE_MS,
};
