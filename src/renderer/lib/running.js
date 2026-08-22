// v0.11 "stop" — the renderer's view of what is actually running.
//
// `getState().running` is SPEC's union of two truths: processes this hub
// launched (it knows their pid) and clients announced on the connector bus. It
// is promised to be present and to be an array — but this file assumes neither,
// because a hub one version behind sends nothing at all and everything in a row
// that came off the bus (`appName`, `version`) was written by another process.
//
// Nothing here builds markup: views/stop.js escapes every string that leaves.
//
// The two ideas worth naming:
//
//  * a row is what the UI can stop. `canStop` is the backend's own verdict — no
//    live pid and no bus presence means the hub has nothing to signal — and the
//    renderer never second-guesses it, it only hides the control.
//  * a stop is PENDING until presence drops. The ladder (ask politely → wait →
//    SIGTERM) takes up to 2.5s, so the control has to say "Stopping…" and mean
//    it; `prunePending` is what ends that state from the state that follows,
//    rather than from a timer that guesses.

/** How long a pending stop may sit before the UI gives the control back. */
export const STOP_TIMEOUT_MS = 12000;

/** The three ways SPEC's `running` row can have come to exist. */
export const SOURCES = ['hub', 'bus', 'both'];

/** Results that mean "there is nothing left to stop" — a success, not an error. */
export const QUIET_RESULTS = ['gone', 'not-running'];

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * One row, defensively. Returns null for anything without an app id — a row the
 * UI cannot attribute to a card is a row it must not draw a Stop button for.
 */
export function normalizeRunningRow(raw) {
  const r = isPlainObject(raw) ? raw : {};
  // The bus lowercases app ids; do it again so a hand-rolled client that shouted
  // its id still lands on the same card as its artifact.
  const appId = text(r.appId || r.app || r.id).trim().toLowerCase();
  if (!appId) return null;
  const pid = Math.round(Number(r.pid));
  const source = SOURCES.includes(r.source) ? r.source : 'hub';
  const known = Number.isFinite(pid) && pid > 0;
  return {
    appId,
    // App-supplied, and it is what the Stop tooltip says out loud.
    appName: text(r.appName || r.name).trim() || appId,
    // Null on purpose for a bus-only client: the hub did not start it and
    // genuinely cannot know which build it is. '' would read as "no artifact".
    artifactId: r.artifactId ? text(r.artifactId) : null,
    version: text(r.version),
    pid: known ? pid : null,
    // Epoch ms from a hub launch record, an ISO string off the bus, or null.
    // relativeTime() reads both; forcing a number through String() would turn
    // "3 min ago" into nothing, so the number is kept as a number.
    since: typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : text(r.since),
    source,
    // SPEC: false only when there is neither a live pid nor bus presence. A row
    // from a build that never sent the field is judged by the same rule rather
    // than assumed stoppable.
    canStop: typeof r.canStop === 'boolean' ? r.canStop : known || source !== 'hub',
  };
}

/**
 * The whole roster, newest first, one row per (appId, artifactId).
 * Anything unusable is dropped rather than rendered half-known.
 */
export function normalizeRunning(raw) {
  const byKey = new Map();
  for (const entry of asArray(raw)) {
    const row = normalizeRunningRow(entry);
    if (!row) continue;
    byKey.set(`${row.appId}::${row.artifactId || ''}`, row);
  }
  return [...byKey.values()];
}

/** appId → its rows, in roster order. */
export function runningByApp(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = map.get(row.appId) || [];
    list.push(row);
    map.set(row.appId, list);
  }
  return map;
}

/**
 * The row a card or tile should speak for.
 *
 * An exact artifact match wins; failing that a row that names no artifact (a
 * bus-only client) stands in, because that IS this app running — the hub just
 * cannot say which build. Only then does any row of the app do.
 */
export function runningFor(rows, appId, artifactId) {
  const id = text(appId).trim().toLowerCase();
  if (!id) return null;
  const list = Array.isArray(rows) ? rows : runningByApp(rows).get(id) || [];
  const mine = list.filter((r) => r && r.appId === id);
  if (!mine.length) return null;
  const art = text(artifactId);
  if (art) {
    const exact = mine.find((r) => r.artifactId === art);
    if (exact) return exact;
  }
  return mine.find((r) => !r.artifactId) || mine[0];
}

/** appId → the one row that speaks for it (what the cards index into). */
export function runningMap(rows) {
  const map = new Map();
  for (const [appId, list] of runningByApp(rows)) map.set(appId, runningFor(list, appId));
  return map;
}

/* ------------------------------------------------------------ the pending set */

/**
 * The identity of one in-flight stop. The peer is part of it: the same app can
 * be running here and on another hub, and stopping one must not grey out the
 * other's button.
 */
export function stopKey(appId, artifactId, peer) {
  return `${text(appId)}::${text(artifactId)}::${text(peer)}`;
}

/** Is this key mid-stop? Tolerates a Set, a Map, an array or a plain object. */
export function isStopping(pending, key) {
  if (!pending || !key) return false;
  if (typeof pending.has === 'function') return pending.has(key);
  if (Array.isArray(pending)) return pending.includes(key);
  return !!pending[key];
}

/**
 * End the pending stops that the world has already answered.
 *
 * SPEC says the control "resolves when presence drops", so presence — not a
 * timer — is the primary rule: an app that is no longer in `running`, no longer
 * on the local bus and no longer in the peer's relayed roster has stopped,
 * whatever `stopApp` is still doing. The age cap is only a floor, so a bridge
 * that never answers cannot wedge a control at "Stopping…" forever.
 *
 * @param {Map<string,{appId,artifactId,peer,at}>} pending
 * @param {{running?:Array, clients?:Map, remote?:Map, now?:number, timeoutMs?:number}} ctx
 * @returns {Map} a NEW map — callers assign it, so a prune is one statement.
 */
export function prunePending(pending, ctx = {}) {
  const out = new Map();
  if (!pending || typeof pending.entries !== 'function') return out;
  const now = Number(ctx.now) || Date.now();
  const timeout = Number(ctx.timeoutMs) || STOP_TIMEOUT_MS;
  const rows = Array.isArray(ctx.running) ? ctx.running : [];
  const clients = ctx.clients instanceof Map ? ctx.clients : new Map();
  const remote = ctx.remote instanceof Map ? ctx.remote : new Map();

  for (const [key, entry] of pending.entries()) {
    const e = isPlainObject(entry) ? entry : {};
    if (now - (Number(e.at) || 0) > timeout) continue;
    const appId = text(e.appId).toLowerCase();
    if (!appId) continue;
    if (e.peer) {
      // A peer's app is present only while that peer is still relaying it.
      const seen = (remote.get(appId) || []).some((r) => r && r.peerId === e.peer);
      if (!seen) continue;
    } else if (!clients.has(appId) && !runningFor(rows, appId, e.artifactId)) {
      continue;
    }
    out.set(key, e);
  }
  return out;
}

/* ------------------------------------------------------------- stopApp result */

/**
 * What to say about `{ok, how}`.
 *
 * `gone` and `not-running` are the whole reason this function exists: the app
 * died on its own somewhere between the click and the signal, which is exactly
 * what the user asked for. Toasting an error there would teach people that Stop
 * is unreliable when it did its job.
 */
export function stopOutcome(res, appName) {
  const name = text(appName).trim() || 'the app';
  const r = isPlainObject(res) ? res : {};
  const how = text(r.how);
  if (QUIET_RESULTS.includes(how)) return { quiet: true, level: '', message: '' };
  // A null result means the bridge call already said its piece (call() toasts).
  if (res === null || res === undefined) return { quiet: true, level: '', message: '' };
  if (r.ok === false) {
    return {
      quiet: false,
      level: 'error',
      message: `Could not stop ${name} — it is still running. Close it from its own window.`,
    };
  }
  return { quiet: true, level: '', message: '' };
}

/* -------------------------------------------------------------- view plumbing */

/**
 * The `stop` bundle the strips and tiles take, or null when no control belongs
 * on screen at all.
 *
 * Two ways to get null, and they are different things: a build whose bridge has
 * no `stopApp` (the caps probe writes `false`) can never stop anything, and a
 * row the backend marked `canStop: false` is a process this hub has no handle
 * on. An ABSENT caps object still means "everything available" — that is the
 * house rule every other optional surface follows (see lib/actions.js).
 */
export function stopOptions(app, row, ctx = {}) {
  const caps = ctx.caps || {};
  if (caps.stopApp === false) return null;
  if (row && row.canStop === false) return null;
  return {
    appName: text(app && app.name).trim() || (row && row.appName) || text(app && app.id),
    artifactId: (row && row.artifactId) || '',
    pending: ctx.stopping || null,
  };
}
