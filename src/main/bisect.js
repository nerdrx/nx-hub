"use strict";
// NX Hub — release bisect (SPEC v0.7 "nx bisect").
//
// "It worked in 1.2 and it is broken now" → binary-search the published
// releases of one artifact, installing each candidate through the ORDINARY
// install pipeline (jobs.installVersion), until the first bad release is
// isolated.
//
// EVERY state transition in here is a pure function of (state, verdict). The
// CLI is a shell: it installs, asks the human, calls applyVerdict(), writes the
// result to `<dataDir>/bisect.json`. Nothing in this module touches GitHub,
// jobs, or the install engine — which is what makes the search exhaustively
// testable without a network or a filesystem.
//
// The search window [lo, hi] is INCLUSIVE and holds every release that could
// still be the first bad one:
//
//   good at i  →  the break is later          →  lo = i + 1
//   bad  at i  →  the break is at or before i →  hi = i
//   skip at i  →  i is untestable; the window does not move, i leaves the
//                 TESTABLE set and a neighbour is tried instead
//
// lo === hi → converged: tags[lo] is the first bad release.
//
// Two windows, and the difference matters. [lo, hi] is the ANSWER window —
// which release is to blame. [lo, hi - 1] is what is worth INSTALLING: `hi` is
// already believed bad (either because a verdict said so, or because the user
// started a bisect at all, which asserts the newest release is broken), so
// testing it can never narrow anything. Searching the answer window instead
// would let a `bad` verdict on `hi` set hi = hi and loop forever.
//
// Every release in [lo, hi-1] skipped → exhausted: the break is somewhere in
// [lo, hi] and nothing testable is left to say where (git bisect words it the
// same way).
//
// The implicit "the newest release is bad" is the same assumption git bisect
// makes you state explicitly, and it means the search always names someone.
// `summary().confirmed` says whether that release was actually TESTED bad, so
// the report can be honest when it was only assumed.

const path = require("path");

const config = require("./config");

const STATE_NAME = "bisect.json";
const VERDICTS = ["good", "bad", "skip"];
const OUTCOMES = ["first-bad", "all-good", "exhausted"];
/** How much of a release's notes the convergence report prints. */
const NOTES_LINES = 10;

/* ------------------------------------------------------------------ */
/* the candidate list                                                  */
/* ------------------------------------------------------------------ */

function releaseTime(release) {
  const raw = (release && (release.publishedAt || release.published_at || release.created_at)) || "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Discovery's release summaries → the bisect candidate list, OLDEST FIRST.
 *
 * Publish time is the ordering, not the tag: a tag is a string a human chose,
 * and "v1.10" vs "v1.9" is exactly the comparison that goes wrong. Ties break
 * on the tag, ordinally (never localeCompare — the host locale must not decide
 * which release gets bisected first).
 *
 * Drafts never appear; prereleases only with `includePrereleases`.
 */
function orderTags(releases, { includePrereleases = false } = {}) {
  const rows = (Array.isArray(releases) ? releases : []).filter((r) => r && (r.tag || r.tag_name) && !r.draft);
  const kept = includePrereleases ? rows : rows.filter((r) => !r.prerelease);
  const list = kept.length ? kept : rows; // a repo with ONLY prereleases still bisects
  return list
    .map((r) => ({
      tag: String(r.tag || r.tag_name),
      version: r.version != null ? String(r.version) : null,
      publishedAt: r.publishedAt || r.published_at || r.created_at || null,
      prerelease: Boolean(r.prerelease),
      notes: typeof r.notes === "string" ? r.notes : typeof r.body === "string" ? r.body : "",
    }))
    .sort((a, b) => releaseTime(a) - releaseTime(b) || (a.tag === b.tag ? 0 : a.tag < b.tag ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* pure state transitions                                              */
/* ------------------------------------------------------------------ */

/** The index halfway through an inclusive window. */
function midpoint(lo, hi) {
  return Math.floor((lo + hi) / 2);
}

function isSkipped(state, i) {
  return (state.skipped || []).includes(i);
}

/**
 * The next release to install, or null when nothing testable is left.
 *
 * Searches [lo, hi - 1] — see the header: `hi` is the believed-bad end and
 * installing it can never narrow the window. The midpoint first; when that one
 * was skipped, the nearest neighbour on either side (classic `git bisect skip`:
 * try something close, do not narrow).
 */
function nextCandidate(state) {
  const lo = state.lo;
  const top = state.hi - 1; // the believed-bad end is never worth installing
  if (lo > top) return null;
  const mid = midpoint(lo, state.hi); // always within [lo, top] while lo < hi
  const span = Math.max(mid - lo, top - mid);
  for (let d = 0; d <= span; d += 1) {
    const left = mid - d;
    if (left >= lo && !isSkipped(state, left)) return left;
    const right = mid + d;
    if (d > 0 && right <= top && !isSkipped(state, right)) return right;
  }
  return null;
}

/** Releases that could still be the culprit — INCLUDING skipped ones. */
function remainingIndices(state) {
  const out = [];
  for (let i = state.lo; i <= state.hi; i += 1) out.push(i);
  return out;
}

/** Releases still worth installing: the answer window minus its top and skips. */
function testableIndices(state) {
  const out = [];
  for (let i = state.lo; i <= state.hi - 1; i += 1) if (!isSkipped(state, i)) out.push(i);
  return out;
}

/** Tests still needed in the worst case — the log2 the SPEC asks `status` for. */
function stepsLeft(state) {
  if (state.done) return 0;
  const n = state.hi - state.lo + 1; // suspects, halved by each verdict
  return n <= 1 ? 0 : Math.ceil(Math.log2(n));
}

function tagAt(state, i) {
  return i == null || !state.tags ? null : state.tags[i] || null;
}

function currentTag(state) {
  return tagAt(state, state.current);
}

function firstBadTag(state) {
  return tagAt(state, state.firstBad);
}

function cloneState(state) {
  return Object.assign({}, state, {
    tags: state.tags,
    skipped: (state.skipped || []).slice(),
    verdicts: Object.assign({}, state.verdicts),
  });
}

/**
 * Decide what a (already narrowed) state means: converged, exhausted, or
 * "install this next". The single place `done`/`outcome`/`current` are set.
 */
function settle(state) {
  const s = state;
  if (!s.tags.length) {
    s.done = true;
    s.outcome = "all-good";
    s.firstBad = null;
    s.current = null;
    return s;
  }
  if (s.lo > s.hi) {
    // Only reachable from a hand-edited state file: `good` never moves lo past
    // hi, because a candidate is never the believed-bad end of the window.
    s.done = true;
    s.outcome = "all-good";
    s.firstBad = null;
    s.current = null;
    return s;
  }
  if (s.lo === s.hi) {
    // one candidate left: it is the first bad one, by deduction (this holds
    // even if it was itself skipped — the neighbours proved it)
    s.done = true;
    s.outcome = "first-bad";
    s.firstBad = s.lo;
    s.current = null;
    return s;
  }
  const next = nextCandidate(s);
  if (next == null) {
    // the window still spans several releases and every testable one is skipped
    s.done = true;
    s.outcome = "exhausted";
    s.firstBad = null;
    s.current = null;
    return s;
  }
  s.current = next;
  return s;
}

/**
 * A fresh bisect over `tags` (oldest first).
 *
 * @param {object} o
 * @param {string} o.appId
 * @param {string} o.artifactId
 * @param {object[]} o.tags        from orderTags()
 * @param {object|null} [o.restore] {version, tag} installed BEFORE the bisect
 *        began — `nx bisect reset` puts exactly this back (null = nothing was
 *        installed, so reset uninstalls)
 * @returns {object} state, already carrying the first release to install
 */
function startState({ appId, artifactId, tags, restore = null, startedAt = null }) {
  const list = Array.isArray(tags) ? tags : [];
  const state = {
    version: 1,
    appId: String(appId),
    artifactId: String(artifactId),
    tags: list,
    lo: 0,
    hi: list.length - 1,
    current: null,
    skipped: [],
    verdicts: {},
    restore: restore ? { version: restore.version || null, tag: restore.tag || null } : null,
    startedAt: startedAt || new Date().toISOString(),
    done: false,
    outcome: null,
    firstBad: null,
  };
  return settle(state);
}

/**
 * Record the verdict for whatever is under test and pick the next candidate.
 * Pure: returns a NEW state, never mutates the one passed in.
 *
 * @param {object} state
 * @param {"good"|"bad"|"skip"} verdict
 */
function applyVerdict(state, verdict) {
  const v = String(verdict || "").toLowerCase();
  if (!VERDICTS.includes(v)) throw new Error(`Unknown verdict "${verdict}" — good, bad or skip`);
  if (!state || !Array.isArray(state.tags)) throw new Error("No bisect in progress");
  if (state.done) return cloneState(state); // terminal states absorb everything
  const cur = state.current;
  if (cur == null) throw new Error("No release is under test");

  const next = cloneState(state);
  const tag = state.tags[cur];
  if (tag) next.verdicts[tag.tag] = v;

  if (v === "good") next.lo = cur + 1;
  else if (v === "bad") next.hi = cur;
  else if (!next.skipped.includes(cur)) next.skipped = next.skipped.concat(cur).sort((a, b) => a - b);

  return settle(next);
}

/** Everything `nx bisect status` prints, as data. */
function summary(state) {
  if (!state || !Array.isArray(state.tags)) return null;
  const remaining = remainingIndices(state);
  const bad = firstBadTag(state);
  return {
    // Was the blamed release actually installed and marked bad, or is it only
    // the believed-bad end of the window nobody ever tested? The report says so.
    confirmed: Boolean(bad && (state.verdicts || {})[bad.tag] === "bad"),
    appId: state.appId,
    artifactId: state.artifactId,
    total: state.tags.length,
    lo: state.lo,
    hi: state.hi,
    loTag: (tagAt(state, state.lo) || {}).tag || null,
    hiTag: (tagAt(state, state.hi) || {}).tag || null,
    remaining: remaining.length,
    remainingTags: remaining.map((i) => state.tags[i].tag),
    testable: testableIndices(state).length,
    stepsLeft: stepsLeft(state),
    tested: Object.keys(state.verdicts || {}).length,
    skipped: (state.skipped || []).map((i) => (state.tags[i] || {}).tag).filter(Boolean),
    current: currentTag(state),
    done: Boolean(state.done),
    outcome: state.outcome || null,
    firstBad: bad,
    restore: state.restore || null,
    startedAt: state.startedAt || null,
  };
}

/** The head of a release body — SPEC: 10 lines on convergence. */
function notesHead(notes, lines = NOTES_LINES) {
  const text = String(notes == null ? "" : notes).replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const all = text.split("\n");
  const head = all.slice(0, Math.max(0, lines));
  if (all.length > head.length) head.push("…");
  return head;
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function statePath() {
  return path.join(config.dataDir(), STATE_NAME);
}

function clampIndex(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < lo || v > hi) return fallback;
  return v;
}

/**
 * Whatever is on disk → a state we can act on, or null. Defensive on purpose:
 * a truncated or hand-edited bisect.json must read as "no bisect in progress",
 * never as a corrupt search that installs the wrong release.
 */
function sanitizeState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tags = orderTagsPassthrough(raw.tags);
  if (!tags.length) return null;
  const last = tags.length - 1;
  const lo = clampIndex(raw.lo, 0, last, 0);
  const hi = clampIndex(raw.hi, 0, last, last);
  const state = {
    version: 1,
    appId: String(raw.appId || ""),
    artifactId: String(raw.artifactId || ""),
    tags,
    lo,
    hi: hi < lo ? lo : hi,
    current: clampIndex(raw.current, 0, last, null),
    skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((i) => Number.isInteger(i) && i >= 0 && i <= last) : [],
    verdicts: raw.verdicts && typeof raw.verdicts === "object" ? Object.assign({}, raw.verdicts) : {},
    restore:
      raw.restore && typeof raw.restore === "object"
        ? { version: raw.restore.version || null, tag: raw.restore.tag || null }
        : null,
    startedAt: raw.startedAt || null,
    done: Boolean(raw.done),
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : null,
    firstBad: clampIndex(raw.firstBad, 0, last, null),
  };
  if (!state.appId || !state.artifactId) return null;
  // `lo > hi` on disk means the file was written by an older/other writer than
  // this one; settle() is the authority on what a window means.
  if (raw.lo > raw.hi) {
    state.lo = lo;
    state.hi = hi;
    state.done = true;
    state.outcome = "all-good";
  }
  return state;
}

/** Keep the stored tag rows as-is (they were already ordered when written). */
function orderTagsPassthrough(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => t && t.tag)
    .map((t) => ({
      tag: String(t.tag),
      version: t.version != null ? String(t.version) : null,
      publishedAt: t.publishedAt || null,
      prerelease: Boolean(t.prerelease),
      notes: typeof t.notes === "string" ? t.notes : "",
    }));
}

function read() {
  return sanitizeState(config.readJson(statePath(), null));
}

function write(state) {
  config.ensureDir(config.dataDir());
  config.writeJsonAtomic(statePath(), state);
  return state;
}

function clear() {
  try {
    require("fs").rmSync(statePath(), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  STATE_NAME,
  VERDICTS,
  OUTCOMES,
  NOTES_LINES,
  orderTags,
  releaseTime,
  midpoint,
  nextCandidate,
  remainingIndices,
  testableIndices,
  stepsLeft,
  tagAt,
  currentTag,
  firstBadTag,
  settle,
  startState,
  applyVerdict,
  summary,
  notesHead,
  statePath,
  sanitizeState,
  read,
  write,
  clear,
};
