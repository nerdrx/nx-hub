"use strict";
// NX Hub — fleet: settings sync (SPEC v0.10 "Fleet settings sync").
//
// Two hubs the same person owns should not disagree about which apps are
// favourites, which are hidden, what a stack looks like or which update policy
// an app is on. Everything else about a machine — its token, its install root,
// its adb path, whether it runs a fleet at all — is nobody else's business and
// is NEVER on the wire.
//
// The rule is last-writer-wins per ENTRY, not per file: one app's prefs, one
// stack. Every entry carries a stamp (`_ts` on an app's prefs, `updatedAt` on a
// stack), a missing stamp reads as epoch 0, and a tie keeps what is already
// here — so the merge is deterministic and two hubs that exchange payloads in
// either order end up identical.
//
// LOOPS. A hub re-broadcasts only when a merge actually CHANGED something, and
// "changed" includes the stamp. So the second time the same entry arrives it is
// byte-identical, nothing changed, and the conversation stops. That is the only
// thing standing between two hubs and an infinite exchange, which is why the
// comparison here is on the merged entry rather than on "did we apply it".
//
// TRUST. The session is authenticated: the sender is a hub the user paired at a
// keyboard. That makes it trustworthy about its own preferences and about
// nothing else. This file therefore treats the payload as data to be parsed,
// not as settings to be adopted: it is size-capped, it goes through the hub's
// OWN sanitizers (config.sanitizeAppPrefs / stacks.sanitizeStack — the exact
// whitelists a hand-edited settings.json faces), and any entry carrying a
// token-shaped key is dropped whole rather than cleaned up.
//
// Pure node: no fs, no sockets, no config module. Everything is passed in.

const crypto = require("crypto");

/** SPEC: a peer's sync payload is size-capped before anything else happens. */
const MAX_SYNC_BYTES = 256 * 1024;
/** More apps / stacks than a real hub has, and a hard ceiling either way. */
const MAX_ENTRIES = 256;

/**
 * Keys that must never travel, checked by NAME rather than by whitelist.
 *
 * The sanitizers already drop everything they do not recognise, so this is the
 * second lock on the same door: if a future key called `syncToken` is ever
 * added to appPrefs, this catches it before the whitelist is widened by
 * accident. Deliberately NOT applied to launchEnv's inner keys — those are
 * environment variable names the user chose, they are part of appPrefs by
 * SPEC, and refusing to sync an app because a variable is called AUTH_MODE
 * would be a silent, baffling failure.
 */
const TOKENISH = /(token|secret|password|passwd|credential|api[-_]?key|\bauth\b|privkey|private[-_]?key)/i;

function isTokenish(key) {
  return TOKENISH.test(String(key == null ? "" : key));
}

/** True when any OWN key of `obj` is token-shaped. Not recursive by design. */
function hasTokenishKey(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Object.keys(obj).some(isTokenish);
}

/** A stamp as a number. Missing, junk or negative all read as epoch 0. */
function stampOf(entry, key) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return 0;
  const raw = entry[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw);
}

function same(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* the payload                                                         */
/* ------------------------------------------------------------------ */

/**
 * `prefs-sync {appPrefs, stacks, sentAt}` — the two synced key-spaces and
 * nothing else. Built from whatever the caller reads off disk; the caller is
 * responsible for handing over `config.load().appPrefs` and `stacks.list()`,
 * because this file has no business knowing where either lives.
 */
function buildPayload({ appPrefs = {}, stacks = [], now = Date.now() } = {}) {
  const prefs = {};
  if (appPrefs && typeof appPrefs === "object" && !Array.isArray(appPrefs)) {
    for (const id of Object.keys(appPrefs).sort()) {
      if (isTokenish(id)) continue;
      const entry = appPrefs[id];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (hasTokenishKey(entry)) continue;
      prefs[id] = entry;
    }
  }
  const list = (Array.isArray(stacks) ? stacks : []).filter((s) => s && s.id && !hasTokenishKey(s)).slice(0, MAX_ENTRIES);
  return { type: "prefs-sync", appPrefs: prefs, stacks: list, sentAt: now };
}

/**
 * What "nothing moved since last time" compares. `sentAt` is deliberately NOT
 * in it: a payload whose only difference is when it was built is not news, and
 * hashing it would make every push a change.
 */
function payloadHash(payload) {
  const body = { appPrefs: (payload && payload.appPrefs) || {}, stacks: (payload && payload.stacks) || [] };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Turn a PEER's payload into something safe to merge, or explain why not.
 *
 * @param {object} raw            the decoded `prefs-sync` message
 * @param {object} o
 * @param {function} o.sanitizeAppPrefs  config.sanitizeAppPrefs
 * @param {function} o.sanitizeStack     stacks.sanitizeStep's sibling
 * @returns {{ok:true, appPrefs:object, stacks:object[]}|{ok:false, reason:string}}
 */
function sanitizePayload(raw, { sanitizeAppPrefs, sanitizeStack } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };

  // Size first — before any traversal, so a hostile payload cannot make us walk
  // it in order to find out it was too big.
  let size = Infinity;
  try {
    size = Buffer.byteLength(JSON.stringify({ appPrefs: raw.appPrefs, stacks: raw.stacks }), "utf8");
  } catch (_) {
    return { ok: false, reason: "not serialisable" };
  }
  if (size > MAX_SYNC_BYTES) return { ok: false, reason: `payload is ${size} bytes (max ${MAX_SYNC_BYTES})` };

  if (hasTokenishKey(raw)) return { ok: false, reason: "payload carries a token-shaped key" };

  const inPrefs = raw.appPrefs && typeof raw.appPrefs === "object" && !Array.isArray(raw.appPrefs) ? raw.appPrefs : {};
  const keep = {};
  let n = 0;
  for (const id of Object.keys(inPrefs)) {
    if (n >= MAX_ENTRIES) break;
    if (isTokenish(id)) continue;
    const entry = inPrefs[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (hasTokenishKey(entry)) continue;
    keep[id] = entry;
    n += 1;
  }
  // The hub's own whitelist has the last word: unknown keys, wrong types and
  // impossible values all die here, exactly as they would in settings.json.
  const appPrefs = typeof sanitizeAppPrefs === "function" ? sanitizeAppPrefs(keep) : {};

  const stacks = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.stacks) ? raw.stacks : []) {
    if (stacks.length >= MAX_ENTRIES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (hasTokenishKey(entry)) continue;
    const stack = typeof sanitizeStack === "function" ? sanitizeStack(entry) : null;
    if (!stack || !stack.id || seen.has(stack.id)) continue;
    // A stack with no usable step is not a stack — stacks.save refuses one, so
    // the wire does not get to smuggle one in either.
    if (!Array.isArray(stack.steps) || !stack.steps.length) continue;
    seen.add(stack.id);
    stacks.push(stack);
  }

  return { ok: true, appPrefs, stacks };
}

/* ------------------------------------------------------------------ */
/* the merge                                                           */
/* ------------------------------------------------------------------ */

/**
 * LWW per app entry by `_ts`.
 *
 * An entry this hub has never heard of is taken whatever its stamp says —
 * there is nothing to compare it against, and "a favourite was added over
 * there" is precisely what sync is for. A tie keeps the local copy, so the
 * merge is a no-op when both sides already agree.
 *
 * @returns {{merged:object, changed:string[]}}
 */
function mergeAppPrefs(local, remote) {
  const merged = Object.assign({}, local && typeof local === "object" ? local : {});
  const changed = [];
  const incoming = remote && typeof remote === "object" && !Array.isArray(remote) ? remote : {};
  for (const id of Object.keys(incoming)) {
    const theirs = incoming[id];
    const ours = merged[id];
    if (ours !== undefined && stampOf(theirs, "_ts") <= stampOf(ours, "_ts")) continue;
    if (same(ours, theirs)) continue; // same content, newer stamp: not news
    merged[id] = theirs;
    changed.push(id);
  }
  changed.sort();
  return { merged, changed };
}

/** LWW per stack by `updatedAt`, same rules. Order follows the local list. */
function mergeStacks(local, remote) {
  const merged = (Array.isArray(local) ? local : []).slice();
  const index = new Map();
  merged.forEach((s, i) => {
    if (s && s.id) index.set(s.id, i);
  });
  const changed = [];
  for (const theirs of Array.isArray(remote) ? remote : []) {
    if (!theirs || !theirs.id) continue;
    const at = index.get(theirs.id);
    if (at === undefined) {
      index.set(theirs.id, merged.length);
      merged.push(theirs);
      changed.push(theirs.id);
      continue;
    }
    const ours = merged[at];
    if (stampOf(theirs, "updatedAt") <= stampOf(ours, "updatedAt")) continue;
    if (same(ours, theirs)) continue;
    merged[at] = theirs;
    changed.push(theirs.id);
  }
  changed.sort();
  return { merged, changed };
}

module.exports = {
  MAX_SYNC_BYTES,
  MAX_ENTRIES,
  TOKENISH,
  isTokenish,
  hasTokenishKey,
  stampOf,
  buildPayload,
  payloadHash,
  sanitizePayload,
  mergeAppPrefs,
  mergeStacks,
};
