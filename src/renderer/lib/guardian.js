// The watchdog and the sandbox picker (SPEC v0.8 [guardian]).
//
// Two per-app prefs and one event type:
//
//  * appPrefs.keepAlive (bool) — relaunch this app when it dies unexpectedly.
//  * appPrefs.sandbox ('none'|'confined'|'offline', null clears) — overrides
//    the overlay's own profile. Absent = inherit the overlay, which itself
//    defaults to none.
//  * supervisor events {appId, appName, artifactId, action:'restarting'|
//    'gave-up', attempt, delayMs?} — a restart is transient news, a give-up is
//    standing news.
//
// Main ALREADY toasts the give-up. This module exists so the card can carry the
// same fact without the renderer toasting it a second time.

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Profiles the overlay and the pref both accept. */
export const SANDBOX_VALUES = ['none', 'confined', 'offline'];
/** …plus the editor's "defer to the overlay" choice. */
export const SANDBOX_CHOICES = ['inherit', ...SANDBOX_VALUES];

const SANDBOX_TEXT = {
  none: 'None',
  confined: 'Confined',
  offline: 'Offline',
};

const SANDBOX_NOTE = {
  none: 'runs with the same access as any other program you start',
  confined: 'a fresh home with only this app’s own folders; network still works',
  offline: 'confined, and the network is cut',
};

/** A profile string, sanitised. Junk and absence both read as ''. */
export function sandboxValue(value) {
  const v = str(value);
  return SANDBOX_VALUES.includes(v) ? v : '';
}

/** What the overlay asks for; absent means "none". */
export function overlaySandbox(app) {
  return sandboxValue(app && app.sandbox) || 'none';
}

/** The value the editor's select holds: the user's own choice, or "inherit". */
export function sandboxChoice(app) {
  return sandboxValue(app && app.sandboxPref) || 'inherit';
}

/**
 * Select value → what setAppPref should store. `null` (not undefined) is the
 * "inherit" write: it survives IPC as an explicit "no per-app choice", exactly
 * like autoRunCmd's tri-state.
 */
export function sandboxFromChoice(choice) {
  return sandboxValue(choice) || null;
}

/** What actually happens at launch: the pref wins, else the overlay. */
export function effectiveSandbox(app) {
  return sandboxValue(app && app.sandboxPref) || overlaySandbox(app);
}

/**
 * Label for one option. "Inherit" spells out what it resolves to, so the sheet
 * never makes the user guess — the same courtesy policyLabel() pays.
 */
export function sandboxLabel(choice, app) {
  if (choice === 'inherit') return `Inherit (overlay: ${overlaySandbox(app)})`;
  return SANDBOX_TEXT[choice] || SANDBOX_TEXT.none;
}

export function sandboxNote(choice, app) {
  const value = choice === 'inherit' ? overlaySandbox(app) : sandboxValue(choice) || 'none';
  return SANDBOX_NOTE[value];
}

/** True when this app is sandboxed at all — the card's own marker keys on it. */
export function isSandboxed(app) {
  return effectiveSandbox(app) !== 'none';
}

/* ------------------------------------------------------- supervisor state */

/**
 * How long a "restarting" line lingers when nothing else clears it. The
 * supervisor's own backoff tops out at 60s, but the line is news about a
 * relaunch that already happened — after twenty seconds it is either back up
 * (and the bus will say so) or the next event supersedes it.
 */
export const RESTART_CLEAR_MS = 20000;

/** One entry per artifact — the same key shape the crash banner uses. */
export function supervisorKey(appId, artifactId) {
  return `${str(appId)}::${str(artifactId)}`;
}

/**
 * Fold one supervisor event into the map. A give-up replaces a restarting line
 * (the story ended); a restarting event after a give-up replaces it back (the
 * user relaunched and it is trying again), which is why neither case is
 * special-cased into "keep the worst".
 */
export function foldSupervisor(map, event, now = Date.now()) {
  const ev = event && typeof event === 'object' ? event : {};
  const action = ev.action === 'gave-up' || ev.action === 'restarting' ? ev.action : '';
  const appId = str(ev.appId);
  if (!action || !appId) return map || {};
  const attempt = Math.round(Number(ev.attempt));
  const delayMs = Math.round(Number(ev.delayMs));
  const key = supervisorKey(appId, ev.artifactId);
  return {
    ...(map || {}),
    [key]: {
      key,
      appId,
      artifactId: str(ev.artifactId),
      appName: str(ev.appName),
      action,
      attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 0,
      delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0,
      at: Number(now) || 0,
    },
  };
}

/**
 * Is this app's bus presence evidence that the relaunch worked?
 *
 * A Map (the real bus roster) carries each client's `since`, and only a
 * presence that STARTED at or after the restart event proves anything — an app
 * that was already announced before the watchdog fired is a stale client
 * record, not a successful relaunch. A bare Set has no timestamps and means
 * "treat presence as proof", which is what unit tests want to say.
 */
function relaunchConfirmed(live, entry) {
  if (!live) return false;
  if (live instanceof Map) {
    const client = live.get(entry.appId);
    if (!client) return false;
    const since = Date.parse(client.since || '') || 0;
    return since >= (entry.at || 0);
  }
  if (live instanceof Set) return live.has(entry.appId);
  return Array.isArray(live) && live.includes(entry.appId);
}

/**
 * Drop what should no longer be on screen: a "restarting" line goes when the
 * app turns up alive on the bus (the relaunch worked — that IS the next state
 * pull showing it live) or when it has simply aged out. A give-up stays until
 * the user dismisses it.
 */
export function pruneSupervisor(map, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const out = {};
  for (const [key, entry] of Object.entries(map || {})) {
    if (!entry) continue;
    if (entry.action === 'restarting') {
      if (relaunchConfirmed(ctx.live, entry)) continue;
      if (now - (entry.at || 0) >= RESTART_CLEAR_MS) continue;
    }
    out[key] = entry;
  }
  return out;
}

export function dismissSupervisor(map, key) {
  const out = { ...(map || {}) };
  delete out[key];
  return out;
}

/** Entries belonging to one app, restarting lines first. */
export function supervisorFor(map, appId) {
  const id = str(appId);
  return Object.values(map || {})
    .filter((e) => e && e.appId === id)
    .sort((a, b) => (a.action === b.action ? b.at - a.at : a.action === 'restarting' ? -1 : 1));
}

/** "Restarting — attempt 2…" */
export function restartingLine(entry) {
  const n = entry && entry.attempt;
  return n ? `Restarting — attempt ${n}…` : 'Restarting…';
}

/**
 * The give-up banner's sentence. DESIGN §9: say what happened AND what to do
 * next, so the count is followed by the only two things that help.
 */
export function gaveUpText(entry) {
  const name = (entry && entry.appName) || (entry && entry.appId) || 'This app';
  const n = entry && entry.attempt;
  const tries = n ? ` after ${n} attempt${n === 1 ? '' : 's'}` : '';
  return `${name} kept exiting, so the watchdog stopped restarting it${tries}. Start it by hand, or turn Keep alive off under App options.`;
}

/** Help text under the Keep alive toggle. */
export const KEEP_ALIVE_NOTE = 'restart this app if it exits unexpectedly';
