"use strict";
// SPEC v0.7 — `nx bisect`.
//
// Every transition in src/main/bisect.js is a pure function, so the search is
// tested the way a search should be: exhaustively. `converges from every
// starting point` walks EVERY (release count, first-bad index) pair up to 40
// releases — 860 complete bisections — and checks both the answer and the
// step budget.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const bisect = require("../../src/main/bisect");

/** n releases, one per day, oldest first. */
function tags(n, { from = 1 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    tag: `v${from + i}.0`,
    version: `${from + i}.0`,
    publishedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    prerelease: false,
    notes: `notes for v${from + i}.0`,
  }));
}

function start(n, extra = {}) {
  return bisect.startState(Object.assign({ appId: "demo", artifactId: "archive-dir-linux", tags: tags(n) }, extra));
}

/**
 * Drive a whole bisect with an oracle: everything from `firstBad` on is bad.
 * @returns {{state:object, steps:number}}
 */
function driveTo(state, firstBad, { skip = () => false } = {}) {
  let s = state;
  let steps = 0;
  while (!s.done) {
    steps += 1;
    assert.ok(steps < 100, "a bisect that never terminates is the bug this guards");
    const i = s.current;
    const verdict = skip(i, s) ? "skip" : i >= firstBad ? "bad" : "good";
    s = bisect.applyVerdict(s, verdict);
  }
  return { state: s, steps };
}

/* ------------------------------------------------------------------ */
/* the candidate list                                                  */
/* ------------------------------------------------------------------ */

test("bisect: orderTags is oldest-first by PUBLISH TIME, not by tag", () => {
  const rows = bisect.orderTags([
    { tag: "v1.9", publishedAt: "2026-03-01T00:00:00Z" },
    { tag: "v1.10", publishedAt: "2026-04-01T00:00:00Z" },
    { tag: "v1.2", publishedAt: "2026-01-01T00:00:00Z" },
  ]);
  assert.deepStrictEqual(
    rows.map((r) => r.tag),
    ["v1.2", "v1.9", "v1.10"],
    "v1.10 is newest even though it sorts before v1.9 as a string"
  );
});

test("bisect: drafts never bisect, prereleases only when asked for", () => {
  const list = [
    { tag: "a", publishedAt: "2026-01-01T00:00:00Z" },
    { tag: "b", publishedAt: "2026-01-02T00:00:00Z", prerelease: true },
    { tag: "c", publishedAt: "2026-01-03T00:00:00Z", draft: true },
  ];
  assert.deepStrictEqual(bisect.orderTags(list).map((r) => r.tag), ["a"]);
  assert.deepStrictEqual(bisect.orderTags(list, { includePrereleases: true }).map((r) => r.tag), ["a", "b"]);

  // a repo with nothing BUT prereleases still bisects — otherwise the command
  // would refuse to run on exactly the repos that need it most
  const onlyPre = [
    { tag: "x", publishedAt: "2026-01-01T00:00:00Z", prerelease: true },
    { tag: "y", publishedAt: "2026-01-02T00:00:00Z", prerelease: true },
  ];
  assert.deepStrictEqual(bisect.orderTags(onlyPre).map((r) => r.tag), ["x", "y"]);
});

test("bisect: releases without a usable date keep an ordinal, stable order", () => {
  const rows = bisect.orderTags([{ tag: "b" }, { tag: "a" }, { tag: "c", publishedAt: "junk" }]);
  assert.deepStrictEqual(rows.map((r) => r.tag), ["a", "b", "c"], "tie-break is ordinal on the tag");
  assert.deepStrictEqual(bisect.orderTags(null), []);
  assert.deepStrictEqual(bisect.orderTags([null, {}, { tag: "" }]), []);
});

/* ------------------------------------------------------------------ */
/* starting                                                            */
/* ------------------------------------------------------------------ */

test("bisect: a fresh search spans everything and opens on the midpoint", () => {
  const s = start(9);
  assert.strictEqual(s.lo, 0);
  assert.strictEqual(s.hi, 8);
  assert.strictEqual(s.current, 4, "midpoint of an inclusive [0,8]");
  assert.strictEqual(s.done, false);
  assert.deepStrictEqual(s.skipped, []);
  assert.deepStrictEqual(s.verdicts, {});
  assert.strictEqual(bisect.currentTag(s).tag, "v5.0");
  assert.strictEqual(bisect.stepsLeft(s), 4, "ceil(log2(9))");
});

test("bisect: one release converges immediately, zero has nothing to blame", () => {
  const one = start(1);
  assert.ok(one.done);
  assert.strictEqual(one.outcome, "first-bad");
  assert.strictEqual(bisect.firstBadTag(one).tag, "v1.0", "with a single candidate there is nothing to search");
  assert.strictEqual(one.current, null, "nothing to install");
  assert.strictEqual(bisect.stepsLeft(one), 0);

  const none = bisect.startState({ appId: "a", artifactId: "b", tags: [] });
  assert.ok(none.done);
  assert.strictEqual(none.outcome, "all-good");
  assert.strictEqual(none.firstBad, null);
});

test("bisect: the version installed before the search is recorded for reset", () => {
  const s = start(4, { restore: { version: "2.0", tag: "v2.0" } });
  assert.deepStrictEqual(s.restore, { version: "2.0", tag: "v2.0" });
  assert.deepStrictEqual(bisect.summary(s).restore, { version: "2.0", tag: "v2.0" });

  const nothing = start(4);
  assert.strictEqual(nothing.restore, null, "nothing installed → reset uninstalls");
});

/* ------------------------------------------------------------------ */
/* narrowing                                                           */
/* ------------------------------------------------------------------ */

test("bisect: good moves the floor up, bad pulls the ceiling down", () => {
  const s = start(9); // current 4
  const afterGood = bisect.applyVerdict(s, "good");
  assert.strictEqual(afterGood.lo, 5, "everything up to and including 4 is good");
  assert.strictEqual(afterGood.hi, 8);
  assert.strictEqual(afterGood.current, 6);

  const afterBad = bisect.applyVerdict(s, "bad");
  assert.strictEqual(afterBad.lo, 0);
  assert.strictEqual(afterBad.hi, 4, "the break is at 4 or earlier");
  assert.strictEqual(afterBad.current, 2);

  assert.strictEqual(s.lo, 0, "applyVerdict is pure — the state passed in never moved");
  assert.strictEqual(s.current, 4);
  assert.deepStrictEqual(s.verdicts, {});
});

test("bisect: converges from every starting point, inside the log2 budget", () => {
  for (let n = 2; n <= 40; n += 1) {
    const budget = Math.ceil(Math.log2(n));
    for (let firstBad = 0; firstBad < n; firstBad += 1) {
      const { state, steps } = driveTo(start(n), firstBad);
      if (firstBad === 0) {
        assert.strictEqual(state.outcome, "first-bad", `n=${n}: the very first release is bad`);
        assert.strictEqual(state.firstBad, 0, `n=${n}: blamed the oldest release`);
      } else {
        assert.strictEqual(state.outcome, "first-bad", `n=${n} firstBad=${firstBad}`);
        assert.strictEqual(state.firstBad, firstBad, `n=${n}: blamed the wrong release`);
      }
      assert.ok(steps <= budget, `n=${n} firstBad=${firstBad}: ${steps} steps, budget ${budget}`);
    }
  }
});

test("bisect: when every tested release is good, the newest is blamed — but unconfirmed", () => {
  // Starting a bisect asserts "it is broken now", so the newest release is the
  // believed-bad end and is never installed. If nothing else tests bad, it is
  // the answer by elimination — and the report has to say it was never tested.
  const { state, steps } = driveTo(start(16), 16); // the oracle never says bad
  assert.ok(state.done);
  assert.strictEqual(state.outcome, "first-bad");
  assert.strictEqual(state.firstBad, 15, "the newest release, the one nobody could rule out");
  assert.strictEqual(bisect.summary(state).confirmed, false, "it was assumed bad, never marked bad");
  assert.ok(steps <= 4, `${steps} steps for 16 releases`);

  // and a search that really did mark it bad says so
  const { state: proven } = driveTo(start(16), 8);
  assert.strictEqual(bisect.summary(proven).confirmed, true);
});

test("bisect: stepsLeft shrinks monotonically and hits zero exactly at the end", () => {
  let s = start(32);
  let previous = bisect.stepsLeft(s);
  assert.strictEqual(previous, 5);
  while (!s.done) {
    s = bisect.applyVerdict(s, s.current >= 21 ? "bad" : "good");
    const now = bisect.stepsLeft(s);
    assert.ok(now <= previous, `steps left went up: ${previous} → ${now}`);
    previous = now;
  }
  assert.strictEqual(bisect.stepsLeft(s), 0);
  assert.strictEqual(s.firstBad, 21);
});

/* ------------------------------------------------------------------ */
/* skip                                                                */
/* ------------------------------------------------------------------ */

test("bisect: skip does not narrow the window — it moves to a neighbour", () => {
  const s = start(9); // current 4, window [0,8]
  const skipped = bisect.applyVerdict(s, "skip");
  assert.strictEqual(skipped.lo, 0, "skip is not a verdict about the code");
  assert.strictEqual(skipped.hi, 8);
  assert.deepStrictEqual(skipped.skipped, [4]);
  assert.strictEqual(skipped.current, 3, "the nearest untested neighbour of the midpoint");
  assert.strictEqual(skipped.verdicts["v5.0"], "skip");

  // skipping again walks further out, alternating sides
  const twice = bisect.applyVerdict(skipped, "skip");
  assert.deepStrictEqual(twice.skipped, [3, 4]);
  assert.strictEqual(twice.current, 5);
});

test("bisect: skipping a release that is not the culprit costs nothing", () => {
  const { state, steps } = driveTo(start(20), 13, { skip: (i) => i === 9 });
  assert.strictEqual(state.outcome, "first-bad");
  assert.strictEqual(state.firstBad, 13, "the neighbour answered for the skipped one");
  assert.ok(steps <= Math.ceil(Math.log2(20)) + 1, `${steps} steps`);
});

test("bisect: skipping the culprit itself narrows honestly, then stops", () => {
  // A release that will not install (broken asset, wrong platform) can never be
  // ruled in or out. The search still shrinks the window as far as the OTHER
  // releases allow, then says so instead of guessing between the survivors.
  const { state } = driveTo(start(20), 13, { skip: (i) => i === 13 });
  assert.strictEqual(state.outcome, "exhausted");
  assert.strictEqual(state.firstBad, null);
  const sum = bisect.summary(state);
  assert.deepStrictEqual(sum.remainingTags, ["v14.0", "v15.0"], "it is one of these two, and nothing can say which");
  assert.deepStrictEqual(sum.skipped, ["v14.0"]);
});

test("bisect: no release is ever installed twice, whatever the verdicts", () => {
  for (const n of [2, 3, 7, 16, 31]) {
    for (let firstBad = 0; firstBad < n; firstBad += 1) {
      const seen = new Set();
      driveTo(start(n), firstBad, {
        skip: (i) => {
          assert.ok(!seen.has(i), `n=${n} firstBad=${firstBad}: release ${i} came round again`);
          seen.add(i);
          return i % 3 === 0; // skip a third of them, arbitrarily
        },
      });
    }
  }
});

test("bisect: a window with nothing testable left is exhausted, not converged", () => {
  let s = start(4); // answer window [0,3], testable [0,2], current 1
  assert.strictEqual(s.current, 1);
  s = bisect.applyVerdict(s, "skip"); // → 0
  assert.strictEqual(s.current, 0);
  s = bisect.applyVerdict(s, "skip"); // → 2
  assert.strictEqual(s.current, 2);
  s = bisect.applyVerdict(s, "skip"); // nothing testable is left
  assert.ok(s.done);
  assert.strictEqual(s.outcome, "exhausted");
  assert.strictEqual(s.firstBad, null, "the culprit is in the window, but nothing can say where");
  assert.strictEqual(s.current, null);
  assert.deepStrictEqual(s.skipped, [0, 1, 2]);

  const sum = bisect.summary(s);
  assert.strictEqual(sum.remaining, 4, "all four are still suspects");
  assert.strictEqual(sum.testable, 0);
  assert.deepStrictEqual(sum.skipped, ["v1.0", "v2.0", "v3.0"]);

  // and further verdicts change nothing
  assert.strictEqual(bisect.applyVerdict(s, "bad").outcome, "exhausted");
});

test("bisect: a skipped release can still be named, when its neighbours corner it", () => {
  let s = start(3); // answer [0,2], testable [0,1], current 1
  assert.strictEqual(s.current, 1);
  s = bisect.applyVerdict(s, "skip"); // 1 skipped → 0 is the only testable left
  assert.strictEqual(s.current, 0);
  s = bisect.applyVerdict(s, "bad"); // hi = 0 = lo → converged on 0
  assert.ok(s.done);
  assert.strictEqual(bisect.firstBadTag(s).tag, "v1.0");

  // the other way round: `good` on 0 leaves [1,2] with 1 skipped and nothing
  // testable — honest exhaustion rather than a guess between the two
  let t = start(3);
  t = bisect.applyVerdict(t, "skip");
  t = bisect.applyVerdict(t, "good");
  assert.strictEqual(t.outcome, "exhausted");
  assert.strictEqual(t.lo, 1);
  assert.strictEqual(t.hi, 2);
});

/* ------------------------------------------------------------------ */
/* misuse                                                              */
/* ------------------------------------------------------------------ */

test("bisect: a finished search absorbs further verdicts instead of moving", () => {
  const { state } = driveTo(start(8), 3);
  const again = bisect.applyVerdict(state, "bad");
  assert.strictEqual(again.firstBad, state.firstBad);
  assert.strictEqual(again.outcome, "first-bad");
  assert.notStrictEqual(again, state, "still a copy — nobody gets a shared reference");
});

test("bisect: an unknown verdict is refused", () => {
  assert.throws(() => bisect.applyVerdict(start(4), "maybe"), /good, bad or skip/);
  assert.throws(() => bisect.applyVerdict(start(4), ""), /good, bad or skip/);
  assert.throws(() => bisect.applyVerdict(null, "good"), /No bisect in progress/);
});

test("bisect: nextCandidate and midpoint are honest about an empty window", () => {
  assert.strictEqual(bisect.midpoint(0, 8), 4);
  assert.strictEqual(bisect.midpoint(3, 4), 3);
  assert.strictEqual(bisect.nextCandidate({ lo: 3, hi: 2, skipped: [] }), null);
  assert.strictEqual(bisect.nextCandidate({ lo: 0, hi: 2, skipped: [0, 1, 2] }), null);
  assert.strictEqual(bisect.nextCandidate({ lo: 0, hi: 2, skipped: [1] }), 0);
});

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

test("bisect: summary is everything `nx bisect status` prints", () => {
  let s = start(16, { restore: { version: "3.0", tag: "v3.0" } });
  s = bisect.applyVerdict(s, "good"); // 7 good → lo 8
  const sum = bisect.summary(s);
  assert.strictEqual(sum.appId, "demo");
  assert.strictEqual(sum.total, 16);
  assert.strictEqual(sum.loTag, "v9.0");
  assert.strictEqual(sum.hiTag, "v16.0");
  assert.strictEqual(sum.remaining, 8);
  assert.strictEqual(sum.stepsLeft, 3);
  assert.strictEqual(sum.tested, 1);
  assert.strictEqual(sum.current.tag, "v12.0");
  assert.strictEqual(sum.done, false);
  assert.strictEqual(sum.outcome, null);
  assert.deepStrictEqual(sum.restore, { version: "3.0", tag: "v3.0" });
});

test("bisect: notesHead keeps the first ten lines and says there are more", () => {
  const notes = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const head = bisect.notesHead(notes);
  assert.strictEqual(head.length, 11, "10 lines plus the continuation mark");
  assert.strictEqual(head[0], "line 1");
  assert.strictEqual(head[9], "line 10");
  assert.strictEqual(head[10], "…");

  assert.deepStrictEqual(bisect.notesHead("one\ntwo"), ["one", "two"], "short notes are printed whole");
  assert.deepStrictEqual(bisect.notesHead(""), []);
  assert.deepStrictEqual(bisect.notesHead(null), []);
  assert.deepStrictEqual(bisect.notesHead("a\r\nb"), ["a", "b"], "CRLF from a GitHub body");
});

test("bisect: the converged report carries the tag, its date and its notes", () => {
  const { state } = driveTo(start(8), 5);
  const bad = bisect.firstBadTag(state);
  assert.strictEqual(bad.tag, "v6.0");
  assert.strictEqual(bad.publishedAt, "2026-01-06T00:00:00Z");
  assert.deepStrictEqual(bisect.notesHead(bad.notes), ["notes for v6.0"]);
});

/* ------------------------------------------------------------------ */
/* the state file                                                      */
/* ------------------------------------------------------------------ */

test("bisect: the state survives a round trip through dataDir/bisect.json", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(bisect.statePath(), path.join(env.dataDir, "bisect.json"));
  assert.strictEqual(bisect.read(), null, "no file, no bisect");

  let s = start(12, { restore: { version: "2.0", tag: "v2.0" } });
  s = bisect.applyVerdict(s, "bad");
  s = bisect.applyVerdict(s, "skip");
  bisect.write(s);

  const back = bisect.read();
  assert.strictEqual(back.lo, s.lo);
  assert.strictEqual(back.hi, s.hi);
  assert.strictEqual(back.current, s.current);
  assert.deepStrictEqual(back.skipped, s.skipped);
  assert.deepStrictEqual(back.verdicts, s.verdicts);
  assert.deepStrictEqual(back.restore, s.restore);
  assert.strictEqual(back.tags.length, 12);
  // and it keeps narrowing from where it left off
  const resumed = bisect.applyVerdict(back, "good");
  assert.ok(resumed.lo > back.lo);

  assert.strictEqual(bisect.clear(), true);
  assert.strictEqual(bisect.read(), null);
});

test("bisect: a truncated or hand-edited state file reads as 'no bisect'", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  const file = bisect.statePath();

  const bad = [
    "{ not json",
    JSON.stringify({}),
    JSON.stringify({ appId: "demo", artifactId: "x", tags: [] }),
    JSON.stringify({ tags: tags(3) }), // no app
    JSON.stringify({ appId: "demo", tags: tags(3) }), // no artifact
  ];
  for (const raw of bad) {
    fs.writeFileSync(file, raw);
    assert.strictEqual(bisect.read(), null, `refused: ${raw.slice(0, 40)}`);
  }

  // out-of-range indices are clamped rather than trusted
  fs.writeFileSync(
    file,
    JSON.stringify({ appId: "demo", artifactId: "x", tags: tags(3), lo: -5, hi: 99, current: 42, skipped: [1, 900] })
  );
  const s = bisect.read();
  assert.strictEqual(s.lo, 0);
  assert.strictEqual(s.hi, 2);
  assert.strictEqual(s.current, null);
  assert.deepStrictEqual(s.skipped, [1]);
});
