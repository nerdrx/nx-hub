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
  stacks.init({ jobs, connector: getConnectorModule, config, emit, engine: getEngineModule });
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

/** Fan-out to every renderer. Also used by discovery/jobs via init({emit}). */
function emit(evt) {
  if (!evt || !evt.type) return;
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

/** `getConnector()` — SPEC IPC addition. Empty-safe with no bus at all. */
function getConnector() {
  return { clients: clients() };
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
    connector: { clients: clients() },
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
  // v0.6: fleet
  getFleet,
  getEngineModule,
};
