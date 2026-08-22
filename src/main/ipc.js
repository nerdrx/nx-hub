"use strict";
// NX Hub — the window.nxhub surface (main-process half). Requires electron
// objects only through init(deps), so buildState() stays unit-testable.

const fs = require("fs");
const path = require("path");

const config = require("./config");
const discovery = require("./discovery");
const jobs = require("./jobs");
const stateStore = require("./state");
const housekeeping = require("./housekeeping");
const stacks = require("./stacks");
const fleet = require("./fleet");
// v0.8 [recorder]: the flight recorder taps `emit` below. Requiring it here is
// free — it opens no file until something is actually worth remembering.
const recorder = require("./recorder");

/**
 * v0.5: the NX Connector bus module, once index.js managed to start it — or
 * null on every build/run without one (unit tests, a hub whose bus failed to
 * bind). Everything downstream of it is written empty-safe on purpose.
 */
let connector = null;
let snapshotTimer = null;
let snapshotHeartbeat = null;
let unsubscribeConnector = null;

let deps = {
  ipcMain: null,
  BrowserWindow: null,
  shell: null,
  app: null,
  // v0.2: electron's Notification class (injected — pure modules stay electron-free)
  Notification: null,
  onSettingsChanged: () => {},
};

function init(d = {}) {
  deps = Object.assign(deps, d);
  // v0.5: the stacks orchestrator drives the same jobs the GUI does and emits
  // through the same fan-out. The connector is passed as a getter so a bus that
  // only boots later (or not at all) still resolves correctly at run time.
  // v0.6: `engine` joins it on the same terms — the install engine is another
  // agent's module, so it is resolved lazily and a build without one simply
  // gets null (adb-device triggers then stay quiet instead of crashing).
  stacks.init({
    jobs,
    connector: getConnectorModule,
    config,
    emit,
    engine: getEngineModule,
    // v0.7: peered/wake steps — null while the fabric is off, so they fail
    // with "the fleet is not available" instead of an unknown-peer error.
    fleet: () => (fleet.isRunning && fleet.isRunning() ? fleet : null),
  });
  // v0.8 [recorder]: the journal lives beside the rest of the hub's data and
  // logs through the hub's own logger. Everything else about it is default.
  recorder.init({ dataDir: config.dataDir(), log: (m) => config.log(m) });
  register();
  return module.exports;
}

/**
 * SPEC v0.2: an `update-available` event also raises an OS notification when
 * settings.notifications is on. Guarded for platforms/builds without support;
 * the once-per-(app,version) bookkeeping lives in jobs/state, so this simply
 * mirrors whatever events actually get emitted.
 */
function notifyUpdate(evt) {
  try {
    const Notification = deps.Notification;
    if (!Notification || typeof Notification !== "function") return;
    if (typeof Notification.isSupported === "function" && !Notification.isSupported()) return;
    if (!config.load().notifications) return;
    const name = evt.appName || evt.appId;
    new Notification({
      title: `${name} ${evt.version} is available`,
      body: "Open NX Hub to install the update.",
      silent: false,
    }).show();
  } catch (e) {
    config.log(`notification failed: ${e.message}`);
  }
}

/**
 * v0.8 [recorder]: the flight-recorder tap.
 *
 * Runs BEFORE the fan-out (an event nobody is listening to is still history)
 * and is wrapped twice over: recorder.record() never throws by contract, and
 * this swallows anything that gets through anyway. A broken journal must never
 * cost the user a toast, a progress bar or a job.
 *
 * `connector-changed` says only "something moved" — the bus sends no roster —
 * so the CURRENT client list rides along and the recorder diffs it into
 * join/leave entries. clients() is itself empty-safe and never throws.
 */
function recordEvent(evt) {
  try {
    if (evt.type === "connector-changed") recorder.record(Object.assign({}, evt, { clients: clients() }));
    else recorder.record(evt);
  } catch (e) {
    config.log(`recorder tap failed: ${e.message}`);
  }
}

/** Fan-out to every renderer. Also used by discovery/jobs via init({emit}). */
function emit(evt) {
  if (!evt || !evt.type) return;
  recordEvent(evt); // v0.8: the flight recorder, before anyone else sees it
  if (evt.type === "update-available") notifyUpdate(evt);
  const BW = deps.BrowserWindow;
  if (!BW) return;
  for (const win of BW.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("nxhub:event", evt);
    } catch (_) {
      /* window going away */
    }
  }
}

function hubVersion() {
  try {
    if (deps.app && typeof deps.app.getVersion === "function") return deps.app.getVersion();
  } catch (_) {
    /* not in electron */
  }
  try {
    // eslint-disable-next-line global-require
    return require(path.join(__dirname, "..", "..", "package.json")).version;
  } catch (_) {
    return "0.0.0";
  }
}

/* ------------------------------------------------------------------ */
/* v0.5: the NX Connector bus, as seen from the hub                    */
/* ------------------------------------------------------------------ */

/**
 * `<dataDir>/connector-clients.json` — the bus's client list, mirrored to disk
 * so OUT-OF-PROCESS readers can see it. The CLI runs in its own process and the
 * wire protocol has no query message, so `nx status` reads this snapshot rather
 * than pretending to be a client. Written atomically, debounced, and stamped:
 * a reader treats anything older than ~2 minutes as "the hub is not running".
 */
function connectorSnapshotPath() {
  return path.join(config.dataDir(), "connector-clients.json");
}

function clients() {
  if (!connector || typeof connector.getClients !== "function") return [];
  try {
    const list = connector.getClients();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    config.log(`connector.getClients failed: ${e.message}`);
    return [];
  }
}

function writeConnectorSnapshot() {
  try {
    config.ensureDir(config.dataDir());
    config.writeJsonAtomic(connectorSnapshotPath(), { ts: new Date().toISOString(), clients: clients() });
  } catch (e) {
    config.log(`connector snapshot failed: ${e.message}`);
  }
}

/** Read the snapshot from any process. Never throws. */
function readConnectorSnapshot(maxAgeMs = 120000) {
  const file = connectorSnapshotPath();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return { path: file, exists: false, stale: true, ageMs: null, ts: null, clients: [] };
  }
  const ts = raw && raw.ts ? String(raw.ts) : null;
  const at = ts ? Date.parse(ts) : NaN;
  const ageMs = Number.isFinite(at) ? Math.max(0, Date.now() - at) : null;
  return {
    path: file,
    exists: true,
    ts,
    ageMs,
    stale: ageMs == null || ageMs > maxAgeMs,
    clients: raw && Array.isArray(raw.clients) ? raw.clients : [],
  };
}

/**
 * Adopt the bus module (index.js hands it over once `init()` succeeded) and
 * keep the on-disk snapshot in step with it, debounced so a chatty app cannot
 * turn status updates into disk writes.
 */
function setConnector(mod, { snapshotDebounceMs = 1000, snapshotHeartbeatMs = 60000 } = {}) {
  if (typeof unsubscribeConnector === "function") {
    try {
      unsubscribeConnector();
    } catch (_) {
      /* ignore */
    }
  }
  unsubscribeConnector = null;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  if (snapshotHeartbeat) clearInterval(snapshotHeartbeat);
  snapshotHeartbeat = null;
  connector = mod || null;

  if (connector && typeof connector.onChange === "function") {
    const schedule = () => {
      if (snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        writeConnectorSnapshot();
      }, Math.max(0, snapshotDebounceMs));
      if (snapshotTimer.unref) snapshotTimer.unref();
    };
    try {
      const off = connector.onChange(schedule);
      if (typeof off === "function") unsubscribeConnector = off;
    } catch (e) {
      config.log(`connector.onChange failed: ${e.message}`);
    }
    // A quiet bus must not look like a dead hub: the snapshot's timestamp is
    // the CLI's proof of life, so it is re-stamped well inside the staleness
    // window even when nobody connects or disconnects.
    if (snapshotHeartbeatMs > 0) {
      snapshotHeartbeat = setInterval(writeConnectorSnapshot, snapshotHeartbeatMs);
      if (snapshotHeartbeat.unref) snapshotHeartbeat.unref();
    }
  }
  writeConnectorSnapshot(); // an empty list is itself news: "the hub is up"
  return connector;
}

function getConnectorModule() {
  return connector;
}

/**
 * v0.6: the install engine, resolved lazily and never fatally. jobs.getEngine()
 * already does the lazy require and throws a tagged error when the module is
 * not in this build; the trigger watcher only wants "is there one, and what
 * does getAdbStatus say", so null is a perfectly good answer.
 */
function getEngineModule() {
  try {
    return jobs.getEngine();
  } catch (_) {
    return null;
  }
}

/* ==== v0.10 [fabric2]: the federated bus (SPEC "Bus federation") ==== */

/**
 * Every PEER's connector bus, as it was last relayed over the fleet:
 *
 *   [{ peerId, peerName, clients: [{app, version, since, fields, history}] }]
 *
 * Same three empty-safe cases as getFleet(): the setting is off, the fleet
 * never came up, or this build has no fleet at all — all of them `[]`, so the
 * renderer only ever has one shape to draw.
 */
function remoteClients() {
  if (!fleet || typeof fleet.getRemoteClients !== "function") return [];
  try {
    const list = fleet.getRemoteClients();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    config.log(`fleet.getRemoteClients failed: ${e.message}`);
    return [];
  }
}

/** The connector block the renderer reads, local bus + federated peers. */
function connectorView() {
  return { clients: clients(), remote: remoteClients() };
}

/* ==== end v0.10 [fabric2] ==== */

/* ==== v0.11 [stopper]: what is running, and stopping it ============ */

// eslint-disable-next-line global-require
const running = require("./running");

let runningWired = false;

/**
 * src/main/running.js, wired the same way stacks is: the bus and the fleet
 * arrive as GETTERS, because either may come up (or not) long after this
 * module was loaded. Wiring is idempotent and lazy so the whole feature lives
 * in one block instead of leaking a line into init().
 */
function runningMod() {
  if (!runningWired) {
    running.init({
      connector: getConnectorModule,
      jobs,
      config,
      discovery,
      fleet: () => (fleet.isRunning && fleet.isRunning() ? fleet : null),
    });
    runningWired = true;
  }
  return running;
}

/**
 * `getState().running` — SPEC: always present, always an array, so a renderer
 * never has to ask whether this build can stop things.
 */
function runningView() {
  try {
    const rows = runningMod().list();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    config.log(`running.list failed: ${e.message}`);
    return [];
  }
}

/** `stopApp(appId, artifactId?, opts?)` — the ladder. Never rejects. */
async function stopApp(appId, artifactId, opts) {
  const result = await runningMod().stop(appId, artifactId || null, opts || {});
  if (result && result.ok === false && result.how === "not-running") {
    emit({ type: "toast", level: "info", message: `${result.appName || appId} was not running.` });
  }
  // Presence and launch tracking both just moved — let the UI re-read them.
  emit({ type: "state-changed" });
  return result;
}

/* ==== end v0.11 [stopper] ========================================== */

/** `getConnector()` — SPEC IPC addition. Empty-safe with no bus at all. */
function getConnector() {
  return connectorView(); // v0.10 [fabric2]
}

/**
 * A live tray/card suffix for one client: the overlay's `connector.fields`
 * decide what is worth showing ("PulseNX · 72 bpm"); an app with no field
 * definitions still gets a presence marker.
 */
function formatFields(defs, values) {
  const fields = Array.isArray(defs) ? defs : [];
  const vals = values && typeof values === "object" ? values : {};
  const out = [];
  for (const def of fields) {
    if (!def || !def.key) continue;
    const raw = vals[def.key];
    if (raw == null || raw === "") continue;
    let text;
    if (def.kind === "bool" || typeof raw === "boolean") text = raw ? "on" : "off";
    else if (typeof raw === "number") text = String(raw);
    else text = String(raw);
    out.push(`${text}${def.unit ? ` ${def.unit}` : ""}`);
    if (out.length === 2) break; // a tray line, not a dashboard
  }
  if (out.length) return out.join(" · ");
  // Nothing declared (or nothing sent yet) — fall back to generic key: value.
  const generic = Object.keys(vals)
    .slice(0, 2)
    .map((k) => `${k}: ${typeof vals[k] === "boolean" ? (vals[k] ? "on" : "off") : vals[k]}`);
  return generic.join(" · ");
}

/** The overlay's connector block for an app, by id or repo name. */
function connectorOverlayFields(appId) {
  const cached = discovery.getCached() || {};
  const apps = (cached.overlay && cached.overlay.apps) || {};
  const app = (cached.apps || []).find((a) => a.id === appId);
  const keys = [appId];
  if (app && app.repo) keys.push(String(app.repo).split("/").pop());
  for (const key of keys) {
    const entry = apps[String(key).toLowerCase()];
    if (entry && entry.connector && Array.isArray(entry.connector.fields)) return entry.connector.fields;
  }
  return [];
}

/**
 * "PulseNX · 72 bpm" for a present app, "" for one that is not on the bus.
 * `·` alone is the plain presence marker (the cyan dot the cards draw).
 */
function liveSuffix(appId, clientList) {
  const list = Array.isArray(clientList) ? clientList : clients();
  const client = list.find((c) => c && String(c.app).toLowerCase() === String(appId).toLowerCase());
  if (!client) return "";
  const text = formatFields(connectorOverlayFields(appId), client.fields);
  return text ? ` · ${text}` : " ·";
}

/* ------------------------------------------------------------------ */
/* v0.6: the fleet, as seen from the renderer                          */
/* ------------------------------------------------------------------ */

/**
 * SPEC v0.6 `getFleet()`.
 *
 * Empty-safe in three separate ways, because all three happen: the setting is
 * off, the module never started (busy port, no network), or the hub is a unit
 * test with no fleet at all. The renderer gets the same shape every time and
 * only has to look at `enabled` / `running` to word the empty state.
 *
 *   {
 *     enabled, running,          // the setting, and whether it actually came up
 *     id, name, port, hubVersion,
 *     peers: [{ id, name, host, port, online, connected, beacon, lastSeen,
 *               hubVersion, apps, updates, dialsUs, summary }],
 *     pairing: { code, expiresAt } | null,   // a window this hub has open
 *     summary                                // what WE would push to a peer
 *   }
 */
function getFleet() {
  const enabled = config.load().fleet !== false;
  let snap = null;
  try {
    snap = fleet.snapshot();
  } catch (e) {
    config.log(`fleet.snapshot failed: ${e.message}`);
  }
  if (!snap) {
    return {
      enabled,
      running: false,
      id: null,
      name: null,
      port: null,
      hubVersion: hubVersion(),
      peers: [],
      pairing: null,
      summary: null,
    };
  }
  return Object.assign({ enabled, running: true }, snap);
}

/* ------------------------------------------------------------------ */
/* v0.8: the flight recorder, as seen from the renderer                */
/* ------------------------------------------------------------------ */

/**
 * SPEC v0.8 `getEvents(q)` — the Activity sheet's data source.
 *
 * Everything about the query is validated here, because it arrives from the
 * renderer: the limit is clamped to 1000 (a sheet that asks for a million
 * lines gets a thousand), `since`/`until` accept epoch ms or the same strings
 * the CLI takes ("24h", "2026-08-15"), and a junk query degrades to the
 * default window rather than throwing.
 *
 * @returns {object[]} entries, NEWEST FIRST:
 *   {ts, type, appId?, artifactId?, peerId?, stackId?, summary, data?}
 */
function getEvents(q) {
  const query = q && typeof q === "object" ? q : {};
  try {
    return recorder.query({
      since: query.since,
      until: query.until,
      type: query.type,
      appId: query.appId,
      limit: recorder.clampLimit(query.limit),
    });
  } catch (e) {
    config.log(`getEvents failed: ${e.message}`);
    return [];
  }
}

/** SPEC: getState() → { apps, settings, jobs, adb, hubVersion, refreshing } */
async function buildState() {
  const settings = config.load();
  const cached = discovery.getCached();
  // "settings" | "gh" | "" — the UI uses this for the "private repos need a token" hint
  let tokenSource = "";
  if (settings.token) tokenSource = "settings";
  else {
    try {
      tokenSource = (await config.resolveToken(settings)) ? "gh" : "";
    } catch (_) {
      tokenSource = "";
    }
  }
  const adb = cached.adb || {};
  return {
    apps: cached.apps,
    settings: Object.assign({}, settings, { tokenSource }),
    tokenSource, // top-level: where the renderer reads it
    jobs: jobs.list(),
    adb: {
      available: Boolean(adb.available),
      devices: adb.devices || [],
      versions: adb.versions || adb.apkVersions || {},
      // v0.2: the device the hub acts on (settings.preferredDeviceSerial when online)
      selected: adb.selected || settings.preferredDeviceSerial || null,
    },
    hubVersion: hubVersion(),
    // v0.5: whoever is on the bus right now (empty when the hub runs without one)
    // v0.10 [fabric2]: plus `remote` — the same, on every paired hub
    connector: connectorView(),
    // v0.11 [stopper]: hub launches ∪ bus clients, newest first — always an array
    running: runningView(),
    refreshing: cached.refreshing,
    rateLimit: cached.rateLimit || null,
    errors: cached.errors || [],
    lastRefresh: cached.lastRefresh,
  };
}

function safeExternal(url) {
  const u = String(url || "");
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

/* ------------------------------------------------------------------ */
/* v0.2 helpers                                                        */
/* ------------------------------------------------------------------ */

/** ctx for the engine's adb entry points (same shape jobs builds). */
function engineCtx() {
  const settings = config.load();
  return {
    dataDir: config.dataDir(),
    installRoot: config.installRoot(settings),
    settings,
    log: (m) => config.log(`[adb] ${m}`),
    emitProgress: () => {},
  };
}

function engineOrThrow() {
  const engine = jobs.getEngine();
  if (!engine) throw new Error("Install engine unavailable");
  return engine;
}

/** SPEC v0.2 getReleases(appId): cached list, fetched live when we have none. */
async function getReleases(appId) {
  const cachedList = discovery.getReleases(appId);
  if (cachedList.length) return cachedList;
  try {
    return await discovery.fetchReleases(appId);
  } catch (e) {
    config.log(`getReleases(${appId}) failed: ${e.message}`);
    return [];
  }
}

function register() {
  const { ipcMain } = deps;
  if (!ipcMain) return;

  const handle = (channel, fn) => {
    try {
      ipcMain.removeHandler(channel);
    } catch (_) {
      /* ignore */
    }
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        config.log(`ipc ${channel} failed: ${err.stack || err.message}`);
        emit({ type: "toast", level: "error", message: err.message || String(err) });
        throw err;
      }
    });
  };

  handle("nxhub:getState", () => buildState());

  handle("nxhub:refresh", async (force) => {
    await discovery.refresh({ force: Boolean(force) });
    return buildState();
  });

  handle("nxhub:install", (appId, artifactId) => jobs.install(appId, artifactId));
  handle("nxhub:uninstall", (appId, artifactId) => jobs.uninstall(appId, artifactId));
  handle("nxhub:launch", async (appId, artifactId) => {
    await jobs.launch(appId, artifactId);
    emit({ type: "toast", level: "info", message: "Launching…" });
    return true;
  });
  handle("nxhub:cancelJob", (jobId) => jobs.cancelJob(jobId));

  // Post-install command, by ID ONLY — the executed string is the artifact's
  // own overlay-curated postInstallCmd, resolved here, never renderer input.
  handle("nxhub:runPostInstallCmd", async (appId, artifactId) => {
    const { artifact, app } = discovery.findArtifact(appId, artifactId) || {};
    const cmd = artifact && artifact.postInstallCmd;
    if (!cmd) throw new Error("This artifact has no post-install command");
    const runcmd = require("./runcmd");
    const spec = runcmd.rewriteForPrivilege(cmd);
    config.log(`post-install cmd for ${appId}/${artifactId}: ${spec.cmd}`);
    const res = await runcmd.runShell(spec.cmd);
    if (res.ok) {
      emit({ type: "toast", level: "info", message: `Done: ${cmd}` });
    } else if (res.timedOut) {
      emit({ type: "toast", level: "error", message: `Timed out: ${cmd}` });
    } else {
      const tail = res.output ? ` — ${res.output.split("\n").slice(-2).join(" · ").slice(0, 200)}` : "";
      emit({ type: "toast", level: "error", message: `Failed (exit ${res.code})${tail}` });
    }
    return { ok: res.ok, code: res.code, output: res.output, privileged: spec.privileged, app: app && app.id };
  });

  handle("nxhub:setSettings", async (patch) => {
    const before = config.load();
    const next = config.save(patch || {});
    emit({ type: "state-changed" });
    const sourcesChanged =
      JSON.stringify(before.owners) !== JSON.stringify(next.owners) ||
      JSON.stringify(before.extraRepos) !== JSON.stringify(next.extraRepos) ||
      before.token !== next.token;
    try {
      deps.onSettingsChanged(next, { sourcesChanged });
    } catch (e) {
      config.log(`onSettingsChanged failed: ${e.message}`);
    }
    if (sourcesChanged) discovery.refresh({ force: true }).catch(() => {});
    return buildState();
  });

  /* ---------------- v0.2 surface ---------------- */

  handle("nxhub:getReleases", (appId) => getReleases(appId));

  handle("nxhub:installVersion", (appId, artifactId, tag) => jobs.installVersion(appId, artifactId, tag));

  handle("nxhub:rollback", (appId, artifactId) => jobs.rollback(appId, artifactId));

  handle("nxhub:setAppPref", async (appId, patch) => {
    config.setAppPref(appId, patch || {});
    // hidden / includePrereleases change what the model looks like — rebuild
    try {
      discovery.rebuild();
    } catch (e) {
      config.log(`setAppPref rebuild failed: ${e.message}`);
    }
    emit({ type: "state-changed" });
    return buildState();
  });

  handle("nxhub:adbConnect", async (hostPort) => {
    const result = await engineOrThrow().adbConnect(engineCtx(), hostPort);
    await discovery.refreshAdb().catch(() => {});
    emit({ type: "toast", level: "info", message: result.message || `Connected to ${result.target}` });
    emit({ type: "state-changed" });
    return result;
  });

  handle("nxhub:adbSelectDevice", async (serial) => {
    config.save({ preferredDeviceSerial: serial ? String(serial) : null });
    const adb = await discovery.refreshAdb().catch(() => null);
    emit({ type: "state-changed" });
    return { selected: config.load().preferredDeviceSerial, adb: adb || null };
  });

  handle("nxhub:getDeviceInfo", async () => {
    try {
      // The devices sheet calls this on open — rescan the device list in the
      // same breath so the list and the info tiles can never disagree (seen
      // in the field: freshly authorized phone showed info but "No device").
      await discovery.refreshAdb().catch(() => {});
      emit({ type: "state-changed" });
      return await engineOrThrow().getDeviceInfo(engineCtx());
    } catch (e) {
      config.log(`getDeviceInfo: ${e.message}`);
      return { serial: null, model: null, batteryPct: null, storageFreeBytes: null, available: false };
    }
  });

  handle("nxhub:getDiskUsage", (force) => housekeeping.getDiskUsage({ force: Boolean(force) }));

  handle("nxhub:clearDownloadCache", async () => {
    const result = await housekeeping.clearDownloadCache();
    try {
      discovery.remerge();
    } catch (_) {
      /* cache may be empty */
    }
    emit({ type: "state-changed" });
    return result;
  });

  handle("nxhub:getLogs", (tailLines) => housekeeping.getLogs(tailLines));

  handle("nxhub:exportSettings", () => config.exportSettings());

  handle("nxhub:importSettings", async (json) => {
    const result = config.importSettings(json);
    try {
      discovery.rebuild();
    } catch (_) {
      /* no cache yet */
    }
    emit({ type: "state-changed" });
    try {
      deps.onSettingsChanged(result.settings, { sourcesChanged: true });
    } catch (e) {
      config.log(`onSettingsChanged failed: ${e.message}`);
    }
    discovery.refresh({ force: true }).catch(() => {});
    return result;
  });

  /* ---------------- v0.5: connector + stacks ---------------- */

  handle("nxhub:getConnector", () => getConnector());

  // v0.11 [stopper]
  handle("nxhub:stopApp", (appId, artifactId, opts) => stopApp(appId, artifactId, opts));

  handle("nxhub:getStacks", () => stacks.list());

  handle("nxhub:saveStack", async (stack) => {
    const saved = stacks.save(stack);
    emit({ type: "state-changed" });
    return { ok: true, stack: saved, stacks: stacks.list() };
  });

  handle("nxhub:deleteStack", async (id) => {
    const removed = stacks.remove(id);
    emit({ type: "state-changed" });
    return { ok: removed, stacks: stacks.list() };
  });

  // A run outlives any reasonable IPC round trip (a gate alone may wait 30s),
  // so this starts it and returns — the renderer follows the stack-progress
  // events, exactly like it follows job progress.
  handle("nxhub:runStack", async (id) => {
    const busy = stacks.running();
    if (busy) throw new Error(`"${busy.stackId}" is still running`);
    const started = stacks.run(id);
    started.catch((e) => {
      config.log(`stack ${id} failed: ${e.message}`);
      emit({ type: "toast", level: "error", message: e.message || String(e) });
    });
    return { started: true, stackId: String(id) };
  });

  handle("nxhub:stopStack", (id) => stacks.stop(id));

  /* ---------------- v0.6: fleet ---------------- */

  handle("nxhub:getFleet", () => getFleet());

  // Arms the 120s pairing window on THIS hub and returns the six digits the
  // human has to read out. The same code also goes out as `fleet-pair-code`,
  // so a second window (or the tray) can show it without asking again.
  handle("nxhub:fleetShowCode", () => fleet.showCode());

  handle("nxhub:fleetPair", async (host, code, port) => {
    const peer = await fleet.pair(host, code, port);
    emit({ type: "toast", level: "info", message: `Paired with ${peer.name}` });
    return { ok: true, peer: { id: peer.id, name: peer.name, host: peer.host, port: peer.port }, fleet: getFleet() };
  });

  handle("nxhub:fleetUnpair", async (peerId) => {
    const removed = fleet.unpair(peerId);
    return { ok: removed, fleet: getFleet() };
  });

  // The three remote actions all resolve to the REMOTE's ack — {jobId} for an
  // install, {count, jobIds} for update-all — and the job's progress then
  // arrives as `fleet-progress` events, exactly like a local job's.
  handle("nxhub:fleetInstall", (peerId, appId, artifactId) => fleet.remoteInstall(peerId, appId, artifactId));

  handle("nxhub:fleetLaunch", (peerId, appId, artifactId) => fleet.remoteLaunch(peerId, appId, artifactId));

  handle("nxhub:fleetUpdateAll", (peerId) => fleet.remoteUpdateAll(peerId));

  // v0.7: wake a sleeping peer (SPEC "WOL + peer MAC"). Resolves to whether
  // the magic packets LEFT this machine — never to "the peer woke up", which
  // nothing on this side can know. The UI should follow it with the peer's
  // online state, not treat `true` as success.
  handle("nxhub:fleetWake", async (peerId) => {
    const sent = await fleet.wake(peerId);
    const peer = (getFleet().peers || []).find((p) => p && p.id === peerId) || null;
    if (!sent && peer && !peer.mac) {
      return { ok: false, sent: false, reason: "no-mac", peerId, name: peer.name || null };
    }
    return { ok: sent, sent, peerId, name: peer ? peer.name : null, mac: peer ? peer.mac : null };
  });

  /* ---- v0.8 [recorder]: the flight recorder (SPEC "Flight recorder") ---- */
  //
  // getEvents({since, until, type, appId, limit}) → newest-first entries.
  handle("nxhub:getEvents", (q) => getEvents(q));

  /* ---- v0.7 [dev-tools]: dev links (SPEC "nx dev") ---- */
  //
  // getDevLinks() → [{appId, name, path, launchCmd, exists, appName, known}]
  //   `appName`/`known` say whether discovery has an app under that id, so the
  //   launcher can badge a real app's tile instead of inventing a name.
  // devRun(id)    → {ok, pid, cmd, args, cwd, source}
  // devUnlink(id) → {ok, links} (the fresh list, so no second round trip)
  handle("nxhub:getDevLinks", () => devLinks());

  handle("nxhub:devRun", async (appId) => {
    const devlinks = require("./devlinks");
    const link = devlinks.get(appId);
    if (!link) throw new Error(`No dev link called "${appId}"`);
    const app = discovery.findApp(link.appId);
    const result = devlinks.run(link.appId, { names: app ? [app.name, app.repo] : [] });
    emit({ type: "toast", level: "info", message: `Launching ${link.name || (app && app.name) || link.appId} (dev)…` });
    return Object.assign({ ok: true }, result);
  });

  handle("nxhub:devUnlink", (appId) => {
    const devlinks = require("./devlinks");
    const ok = devlinks.unlink(appId);
    if (ok) emit({ type: "state-changed" }); // the app model loses its devLink flag
    return { ok, links: devLinks() };
  });

  handle("nxhub:openExternal", async (url) => {
    const safe = safeExternal(url);
    if (!safe) throw new Error("Refusing to open a non-web URL");
    if (deps.shell) await deps.shell.openExternal(safe);
    return true;
  });

  handle("nxhub:showInFolder", (p) => {
    if (!p) return false;
    if (deps.shell) deps.shell.showItemInFolder(String(p));
    return true;
  });

  /* ---- v0.8 [timemachine]: config time machine (SPEC "Config time machine") ----
   *
   * getSnapshots(appId)          → [{file, ts, version, reason, bytes}] newest first
   * restoreSnapshot(appId, file) → {ok, file, restored:[…], preRestore}
   * deleteSnapshot(appId, file)  → {ok, file}
   *
   * `file` is always a bare archive name from getSnapshots — snapshots.js
   * rejects anything else (a path, a traversal) rather than touching it.
   * Failures reach the user through the wrapper's error toast above; the
   * success toast is the only one worth adding here.
   */
  handle("nxhub:getSnapshots", (appId) => require("./snapshots").list(appId));

  handle("nxhub:restoreSnapshot", async (appId, file) => {
    const snapshots = require("./snapshots");
    const app = discovery.findApp(appId);
    const meta = snapshots.get(appId, file);
    const result = await snapshots.restore(appId, file, { app: app || null });
    const name = (app && app.name) || appId;
    const when = meta && meta.ts ? ` from ${meta.ts.slice(0, 16).replace("T", " ")}` : "";
    emit({ type: "toast", level: "info", message: `Restored ${name}'s config${when}` });
    return result;
  });

  handle("nxhub:deleteSnapshot", (appId, file) => {
    const snapshots = require("./snapshots");
    const result = snapshots.remove(appId, file);
    return Object.assign({}, result, { snapshots: snapshots.list(appId) });
  });

  /* ---- v0.10 [audit]: the deep audit (SPEC "Deep audit") ----------------
   *
   * getAudit(appId?)              → [{appId, artifactId, ok, kind, version,
   *                                   path, deviceResident, notes:[…],
   *                                   problems:[{kind, path?, detail}]}] — one
   *   row per recorded install, in state.json order. `problems` is empty
   *   exactly when `ok`.
   *   Kinds: missing-dir · bad-manifest · missing-binary · not-executable ·
   *   missing-file · missing-desktop-entry · hash-mismatch.
   *   deviceResident (apk-adb) rows come back ok with a note — their files
   *   live on a headset, so there is nothing on this disk to check.
   *   It never rejects: an unreadable install is a problem, not an error.
   * repairInstall(appId, artifactId) → the JOB ID of an ordinary install job.
   *   Watch it through the usual job-progress / job-done events; the row goes
   *   green on the next getAudit().
   */
  handle("nxhub:getAudit", (appId) => require("./audit").audit(appId || null));

  handle("nxhub:repairInstall", (appId, artifactId) => {
    const jobId = require("./audit").repair(appId, artifactId);
    const app = discovery.findApp(appId);
    emit({ type: "toast", level: "info", message: `Repairing ${(app && app.name) || appId}…` });
    return jobId;
  });

  /* ---- v0.10 [replay]: ecosystem checkpoints (SPEC "Ecosystem checkpoints") --
   *
   * getCheckpoint(when) → {ts, iso, apps:[{appId, appName, artifactId,
   *   version, currentVersion, action: none|install|remove, tag, snapshot,
   *   snapshotAt, uncertain, why, skipReason}], uncertain, actionable,
   *   skipped, horizon}. `when` takes epoch ms or the recorder's own strings
   *   ("24h", "2d", "2026-08-15"); an unreadable one rejects.
   *   `version` is what was installed THEN (null = not installed then, or
   *   unknown when `uncertain` — the two are told apart by the flag, never
   *   guessed). Rows with nothing to do AND nothing in doubt are left out, so
   *   a checkpoint on `now` comes back with an empty `apps`.
   * restoreCheckpoint(when, {configs}) → the verdict {ok, ts, results, counts}
   *   AFTER the whole plan has run. Watch it live through `checkpoint-progress`
   *   {phase: planning|installing|removing|restoring-config|done|failed,
   *   appId, artifactId} — the run's own verdict carries `appId: null`.
   *   Uncertain rows and deleted releases are skipped and reported, never
   *   acted on; one restore runs at a time (a second call rejects).
   */
  handle("nxhub:getCheckpoint", (when) => require("./checkpoints").checkpointAt(when));

  handle("nxhub:restoreCheckpoint", async (when, opts) => {
    const checkpoints = require("./checkpoints");
    const result = await checkpoints.restore(when, { configs: Boolean(opts && opts.configs), emit });
    const c = result.counts;
    emit({
      type: "toast",
      level: c.failed ? "error" : "info",
      message: `Checkpoint applied — ${c.done} done${c.failed ? `, ${c.failed} failed` : ""}${
        c.skipped ? `, ${c.skipped} skipped` : ""
      }`,
    });
    return result;
  });
}

/**
 * v0.7 [dev-tools]: the dev-link tiles the launcher renders.
 * Never throws — a missing/broken dev.json reads as "no links".
 */
function devLinks() {
  try {
    // eslint-disable-next-line global-require
    const devlinks = require("./devlinks");
    return devlinks.list().map((link) => {
      const app = discovery.findApp(link.appId);
      return {
        appId: link.appId,
        name: link.name || (app && app.name) || link.appId,
        path: link.path,
        launchCmd: link.launchCmd || null,
        exists: devlinks.isDir(link.path),
        known: Boolean(app),
        appName: (app && app.name) || null,
      };
    });
  } catch (_) {
    return [];
  }
}

/** Installed + launchable artifacts, for the tray menu. */
function launchables() {
  const apps = discovery.getCached().apps || [];
  const st = stateStore.load();
  const live = clients();
  const out = [];
  for (const app of apps) {
    for (const artifact of app.artifacts || []) {
      const rec = (st.installed[app.id] || {})[artifact.id];
      if (!rec) continue;
      if (artifact.launchable === false) continue; // discovery decides (kind + engine result)
      out.push({
        appId: app.id,
        artifactId: artifact.id,
        appName: app.name,
        label: artifact.label,
        // v0.5: "" when the app is not on the bus, " · 72 bpm" when it is
        live: liveSuffix(app.id, live),
      });
    }
  }
  return out;
}

module.exports = {
  init,
  emit,
  buildState,
  launchables,
  hubVersion,
  getReleases,
  engineCtx,
  // v0.5: connector
  setConnector,
  getConnectorModule,
  getConnector,
  clients,
  liveSuffix,
  formatFields,
  connectorOverlayFields,
  connectorSnapshotPath,
  readConnectorSnapshot,
  writeConnectorSnapshot,
  // v0.10 [fabric2]: the federated bus
  remoteClients,
  connectorView,
  // v0.11 [stopper]
  runningView,
  stopApp,
  // v0.6: fleet
  getFleet,
  getEngineModule,
  // v0.7: dev links
  devLinks,
  // v0.8: the flight recorder
  getEvents,
  recordEvent,
};
