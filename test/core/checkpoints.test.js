"use strict";
// src/main/checkpoints.js — ecosystem checkpoints (SPEC v0.10, [replay]).
//
// The reconstruction is a pure function of (journal, state, when), so the
// matrix below hands it synthetic journals rather than writing real ones: what
// is under test is the REASONING — install chains, rollbacks, uninstalls, and
// above all the cases where the journal cannot say, which must come back
// `uncertain` instead of guessed.
//
// The executor is driven with a fake `jobs` and a fake `snapshots`: nothing
// here downloads, unpacks or deletes anything.

const test = require("node:test");
const assert = require("node:assert");

const checkpoints = require("../../src/main/checkpoints");
const recorder = require("../../src/main/recorder");

const NOON = Date.parse("2026-08-15T12:00:00Z");
const HOUR = 3600000;
const DAY = 86400000;

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A journal entry shaped exactly like the one recorder.record() writes. */
function ev(ts, appId, artifactId, verb, version, over = {}) {
  const data = { jobId: "j", verb };
  if (version) data.version = version; // recorder's pick() drops empty values
  if (over.message) data.message = over.message;
  // v0.10: what the job replaced. pick() drops null but keeps `false`, which is
  // exactly the distinction these two fields rely on.
  if (over.previousVersion) data.previousVersion = over.previousVersion;
  if (typeof over.previouslyInstalled === "boolean") data.previouslyInstalled = over.previouslyInstalled;
  return Object.assign(
    {
      ts,
      type: "job-done",
      appId,
      artifactId,
      summary: `${verb} ${appId}${version ? ` v${version}` : ""}`,
      data,
    },
    over.entry || {}
  );
}

function install(appId, artifactId, version, installedAt) {
  return { appId, artifactId, version, path: `/apps/${appId}`, installedAt: new Date(installedAt).toISOString() };
}

/** A recorder stand-in: canned entries, the real time/message parsers. */
function fakeRecorder(entries = []) {
  const sorted = entries.slice().sort((a, b) => b.ts - a.ts); // query() is newest-first
  return {
    calls: [],
    query(q) {
      this.calls.push(q);
      const limit = Number(q && q.limit) > 0 ? Number(q.limit) : 200;
      const appId = q && q.appId ? String(q.appId) : null;
      return sorted.filter((e) => !appId || e.appId === appId).slice(0, limit);
    },
    parseSince: recorder.parseSince,
    parseJobMessage: recorder.parseJobMessage,
  };
}

/** Everything checkpointAt needs, with no disk and no discovery. */
function env(over = {}) {
  const entries = over.entries || [];
  const installs = over.installs || [];
  return Object.assign(
    {
      now: () => NOON,
      recorder: fakeRecorder(entries),
      state: { listInstalls: () => installs },
      snapshots: { list: () => over.snapshots || [] },
      findApp: (id) => ({ id, name: id.toUpperCase() }),
      releases: async (id) => (over.releases || {})[id] || [],
    },
    over.opts || {}
  );
}

function rowFor(plan, appId, artifactId) {
  return plan.apps.find((a) => a.appId === appId && (!artifactId || a.artifactId === artifactId)) || null;
}

/* ------------------------------------------------- parseWhen */

test("checkpoints: parseWhen speaks the recorder's time grammar, on our clock", () => {
  const opts = { now: () => NOON };
  assert.equal(checkpoints.parseWhen("now", opts), NOON);
  assert.equal(checkpoints.parseWhen("24h", opts), NOON - DAY);
  assert.equal(checkpoints.parseWhen("2d", opts), NOON - 2 * DAY);
  assert.equal(checkpoints.parseWhen("90m", opts), NOON - 90 * 60000);
  assert.equal(checkpoints.parseWhen("1w", opts), NOON - 7 * DAY);
  assert.equal(checkpoints.parseWhen(NOON, opts), NOON);
  assert.equal(checkpoints.parseWhen(new Date(NOON), opts), NOON);
  assert.equal(checkpoints.parseWhen("2026-08-15T10:00:00Z", opts), Date.parse("2026-08-15T10:00:00Z"));
  assert.equal(checkpoints.parseWhen(String(NOON), opts), NOON);
});

test("checkpoints: with no clock injected, relatives resolve against the real one", () => {
  // Regression: `deps.now` is null by default, and Number(null) is 0 — a clock
  // that reads as 1970 would silently move every checkpoint to the epoch.
  const before = Date.now();
  const at = checkpoints.parseWhen("2d");
  assert.ok(at >= before - 2 * DAY - 5000 && at <= Date.now() - 2 * DAY + 5000, `2d ago is ${new Date(at).toISOString()}`);
  assert.ok(checkpoints.parseWhen("now") > Date.parse("2026-01-01T00:00:00Z"));
});

test("checkpoints: a bare date is LOCAL midnight, built from its own parts", () => {
  const at = checkpoints.parseWhen("2026-08-15", { now: () => NOON });
  const d = new Date(at);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("checkpoints: what is not a time reads as null, and requireWhen says so", () => {
  const opts = { now: () => NOON };
  for (const bad of ["", null, undefined, "yesterday", "2d ago", "tuesday", "--configs", {}]) {
    assert.equal(checkpoints.parseWhen(bad, opts), null, `${JSON.stringify(bad)} is not a time`);
  }
  assert.throws(() => checkpoints.requireWhen("yesterday", opts), /cannot read "yesterday"/);
  try {
    checkpoints.requireWhen("yesterday", opts);
  } catch (e) {
    assert.match(e.hint, /24h/);
  }
});

/* ------------------------------------------------- derive */

test("checkpoints: an entry's verb and version come from the recorder's own derivation", () => {
  assert.deepEqual(checkpoints.derive(ev(NOON, "a", "x", "installed", "1.4.0")), {
    verb: "installed",
    version: "1.4.0",
    effect: "set",
    previousVersion: null,
    prior: "unknown", // a pre-v0.10 line says nothing about what came before
  });
  assert.equal(checkpoints.derive(ev(NOON, "a", "x", "updated", "2.0")).effect, "set");
  assert.equal(checkpoints.derive(ev(NOON, "a", "x", "rolled back", "1.3")).effect, "set");
  assert.equal(checkpoints.derive(ev(NOON, "a", "x", "uninstalled", null)).effect, "clear");
  // "Installed. <post-install note>" carries no version — unknown, not zero.
  const noted = ev(NOON, "a", "x", "installed", null, { message: "Installed. Re-run setcap" });
  assert.equal(checkpoints.derive(noted).effect, "unknown");
  assert.equal(checkpoints.derive(noted).version, null);
});

test("checkpoints: a journal line with only a summary still parses", () => {
  const entry = { ts: NOON, type: "job-done", appId: "a", artifactId: "x", summary: "installed WiVRn NX v1.4.0" };
  assert.deepEqual(checkpoints.derive(entry), {
    verb: "installed",
    version: "1.4.0",
    effect: "set",
    previousVersion: null,
    prior: "unknown",
  });
  const gone = { ts: NOON, type: "job-done", appId: "a", artifactId: "x", summary: "uninstalled WiVRn NX — Headset APK" };
  assert.equal(checkpoints.derive(gone).effect, "clear");
});

test("checkpoints: since v0.10 an entry also says what it REPLACED", () => {
  const updated = ev(NOON, "a", "x", "updated", "1.4.0", { previousVersion: "1.3.2", previouslyInstalled: true });
  assert.deepEqual(checkpoints.derive(updated), {
    verb: "updated",
    version: "1.4.0",
    effect: "set",
    previousVersion: "1.3.2",
    prior: "set",
  });

  // The load-bearing one: a first install states that nothing was there.
  const first = ev(NOON, "a", "x", "installed", "1.4.0", { previouslyInstalled: false });
  assert.equal(checkpoints.derive(first).prior, "clear");
  assert.equal(checkpoints.derive(first).previousVersion, null);

  // Something WAS there, but its record carried no version — that is not the
  // same claim as "nothing was there", and must not collapse into it.
  const overUnversioned = ev(NOON, "a", "x", "installed", "1.4.0", { previouslyInstalled: true });
  assert.equal(checkpoints.derive(overUnversioned).prior, "unknown");

  // An uninstall names the version it took away.
  const gone = ev(NOON, "a", "x", "uninstalled", null, { previousVersion: "1.4.0", previouslyInstalled: true });
  assert.equal(checkpoints.derive(gone).effect, "clear");
  assert.equal(checkpoints.derive(gone).prior, "set");
  assert.equal(checkpoints.derive(gone).previousVersion, "1.4.0");
});

/* ------------------------------------------------- reconstruction matrix */

test("checkpoints: nothing since `when` — what is installed now was installed then", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - 5 * DAY, "wivrn", "apk", "installed", "1.3.2")],
    installs: [install("wivrn", "apk", "1.3.2", NOON - 5 * DAY)],
    horizon: NOON - 6 * DAY,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    appId: "wivrn",
    artifactId: "apk",
    version: "1.3.2",
    currentVersion: "1.3.2",
    uncertain: false,
    why: null,
  });
});

test("checkpoints: an install chain is walked back one link at a time", () => {
  const entries = [
    ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.2.0"),
    ev(NOON - 4 * DAY, "wivrn", "apk", "updated", "1.3.0"),
    ev(NOON - 2 * HOUR, "wivrn", "apk", "updated", "1.4.0"),
  ];
  const installs = [install("wivrn", "apk", "1.4.0", NOON - 2 * HOUR)];
  const horizon = NOON - 7 * DAY;

  const at = (when) => checkpoints.reconstruct(when, { entries, installs, horizon })[0];
  assert.equal(at(NOON).version, "1.4.0"); // after the last update
  assert.equal(at(NOON - 3 * HOUR).version, "1.3.0"); // between them
  assert.equal(at(NOON - 3 * DAY).version, "1.3.0");
  assert.equal(at(NOON - 5 * DAY).version, "1.2.0");
  assert.equal(at(NOON - 3 * HOUR).uncertain, false);
  // Behind the app's FIRST entry the honest answer is "I do not know": these
  // are pre-v0.10 lines, and those say "Installed <app> <version>" for a first
  // install and an update alike, so one cannot prove there was nothing before
  // it. (The v0.10 entries below can, and do.)
  assert.equal(at(NOON - 6.5 * DAY).uncertain, true);
  assert.equal(at(NOON - 6.5 * DAY).version, null);
  assert.match(at(NOON - 6.5 * DAY).why, /nothing was recorded/);
});

test("checkpoints: a rollback is just another version-setting entry", () => {
  const entries = [
    ev(NOON - 3 * DAY, "wivrn", "apk", "updated", "1.4.0"),
    ev(NOON - 2 * DAY, "wivrn", "apk", "rolled back", "1.3.0"),
    ev(NOON - HOUR, "wivrn", "apk", "updated", "1.5.0"),
  ];
  const installs = [install("wivrn", "apk", "1.5.0", NOON - HOUR)];
  const horizon = NOON - 5 * DAY;
  const at = (when) => checkpoints.reconstruct(when, { entries, installs, horizon })[0];
  assert.equal(at(NOON - 2.5 * DAY).version, "1.4.0");
  assert.equal(at(NOON - DAY).version, "1.3.0"); // the rolled-back build
  assert.equal(at(NOON).version, "1.5.0");
});

test("checkpoints: an app removed since `when` reconstructs to the version it had", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [
      ev(NOON - 4 * DAY, "quadforge", "addon", "installed", "1.3"),
      ev(NOON - 2 * HOUR, "quadforge", "addon", "uninstalled", null),
    ],
    installs: [],
    horizon: NOON - 5 * DAY,
  });
  assert.deepEqual(rows[0], {
    appId: "quadforge",
    artifactId: "addon",
    version: "1.3",
    currentVersion: null,
    uncertain: false,
    why: null,
  });
});

test("checkpoints: an app installed since `when` reconstructs to 'not installed'", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [
      ev(NOON - 3 * DAY, "limbo", "linux", "uninstalled", null),
      ev(NOON - 2 * HOUR, "limbo", "linux", "installed", "2.0"),
    ],
    installs: [install("limbo", "linux", "2.0", NOON - 2 * HOUR)],
    horizon: NOON - 4 * DAY,
  });
  assert.equal(rows[0].version, null);
  assert.equal(rows[0].currentVersion, "2.0");
  assert.equal(rows[0].uncertain, false);
});

test("checkpoints: past the journal's horizon everything is uncertain, not guessed", () => {
  const rows = checkpoints.reconstruct(NOON - 30 * DAY, {
    entries: [ev(NOON - 2 * HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - 2 * HOUR)],
    horizon: NOON - 3 * DAY,
  });
  assert.equal(rows[0].uncertain, true);
  assert.equal(rows[0].version, null); // never a guess
  assert.equal(rows[0].currentVersion, "1.4.0");
  assert.match(rows[0].why, /does not reach back/);
});

test("checkpoints: an untouched app is certain past the horizon — its install record proves it", () => {
  // Nothing in the journal for this app at all, but state.json says it was
  // installed BEFORE `when` and nothing has rewritten the record since.
  const rows = checkpoints.reconstruct(NOON - 30 * DAY, {
    entries: [ev(NOON - 2 * HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("quadforge", "addon", "1.3", NOON - 90 * DAY), install("wivrn", "apk", "1.4.0", NOON - 2 * HOUR)],
    horizon: NOON - 3 * DAY,
  });
  const qf = rows.find((r) => r.appId === "quadforge");
  assert.equal(qf.uncertain, false);
  assert.equal(qf.version, "1.3");
  assert.equal(rows.find((r) => r.appId === "wivrn").uncertain, true);
});

test("checkpoints: an install with no version before `when` cannot be undone to anything", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [
      ev(NOON - 3 * DAY, "wivrn", "srv", "installed", null, { message: "Installed. Re-run setcap" }),
      ev(NOON - HOUR, "wivrn", "srv", "updated", "1.4.0"),
    ],
    installs: [install("wivrn", "srv", "1.4.0", NOON - HOUR)],
    horizon: NOON - 5 * DAY,
  });
  assert.equal(rows[0].uncertain, true);
  assert.match(rows[0].why, /recorded no version/);
});

test("checkpoints: a change after `when` with nothing recorded before it is uncertain", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    horizon: NOON - 2 * DAY, // covered, but this app's history starts later
  });
  assert.equal(rows[0].uncertain, true);
  assert.match(rows[0].why, /nothing was recorded/);
});

test("checkpoints: a v0.10 entry settles `when` on its own, however shallow the journal", () => {
  // One entry, nothing before it, and a horizon that does not even reach
  // `when` — and the answer is still exact, because the entry itself says what
  // it covered up. This is the case that used to come back `uncertain`.
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0", { previousVersion: "1.3.2", previouslyInstalled: true })],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    horizon: NOON - 2 * HOUR,
  });
  assert.deepEqual(rows[0], {
    appId: "wivrn",
    artifactId: "apk",
    version: "1.3.2",
    currentVersion: "1.4.0",
    uncertain: false,
    why: null,
  });

  // …and a FIRST install is just as exact in the other direction.
  const fresh = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - HOUR, "limbo", "linux", "installed", "2.0", { previouslyInstalled: false })],
    installs: [install("limbo", "linux", "2.0", NOON - HOUR)],
    horizon: NOON - 2 * HOUR,
  });
  assert.equal(fresh[0].uncertain, false);
  assert.equal(fresh[0].version, null, "nothing was installed at `when`");
  assert.equal(fresh[0].currentVersion, "2.0");
});

test("checkpoints: an install with no version of its own is undone by the NEXT entry", () => {
  // The counterpart to the pre-v0.10 case above: the entry at `when` recorded
  // no version ("Installed. Re-run setcap"), but the update that followed it
  // names what it replaced, which is the same fact from the other side.
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [
      ev(NOON - 3 * DAY, "wivrn", "srv", "installed", null, { message: "Installed. Re-run setcap" }),
      ev(NOON - HOUR, "wivrn", "srv", "updated", "1.4.0", { previousVersion: "1.3.0", previouslyInstalled: true }),
    ],
    installs: [install("wivrn", "srv", "1.4.0", NOON - HOUR)],
    horizon: NOON - 5 * DAY,
  });
  assert.equal(rows[0].uncertain, false);
  assert.equal(rows[0].version, "1.3.0");
});

test("checkpoints: an install over an unversioned record stays uncertain, not guessed", () => {
  // `previouslyInstalled: true` with no previousVersion is the one v0.10 shape
  // that still cannot answer: something was there, and nobody wrote down what.
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - HOUR, "wivrn", "apk", "installed", "1.4.0", { previouslyInstalled: true })],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    horizon: NOON - 2 * DAY,
  });
  assert.equal(rows[0].uncertain, true);
  assert.equal(rows[0].version, null);
  assert.match(rows[0].why, /nothing was recorded/);
});

test("checkpoints: an install record written after `when` with no journal entry is uncertain", () => {
  // Something installed this behind the hub's back (or the journal lost the
  // line). The record is newer than `when`, so it cannot vouch for `when`.
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - 4 * DAY, "other", "x", "installed", "1.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    horizon: NOON - 5 * DAY,
  });
  const row = rows.find((r) => r.appId === "wivrn");
  assert.equal(row.uncertain, true);
  assert.match(row.why, /left no journal entry/);
});

test("checkpoints: with an empty journal only the install records can speak", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [],
    installs: [install("quadforge", "addon", "1.3", NOON - 10 * DAY), install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    horizon: null,
  });
  assert.equal(rows.find((r) => r.appId === "quadforge").uncertain, false);
  assert.equal(rows.find((r) => r.appId === "wivrn").uncertain, true);
});

test("checkpoints: artifacts of one app are reconstructed independently", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [
      ev(NOON - 5 * DAY, "wivrn", "apk", "installed", "1.3.0"),
      ev(NOON - 5 * DAY, "wivrn", "srv", "installed", "1.3.0"),
      ev(NOON - HOUR, "wivrn", "srv", "updated", "1.4.0"),
    ],
    installs: [install("wivrn", "apk", "1.3.0", NOON - 5 * DAY), install("wivrn", "srv", "1.4.0", NOON - HOUR)],
    horizon: NOON - 6 * DAY,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.artifactId === "apk").version, "1.3.0");
  assert.equal(rows.find((r) => r.artifactId === "srv").version, "1.3.0");
  assert.equal(rows.find((r) => r.artifactId === "srv").currentVersion, "1.4.0");
});

test("checkpoints: reconstruction does not care what order the entries arrive in", () => {
  const entries = [
    ev(NOON - HOUR, "a", "x", "updated", "3.0"),
    ev(NOON - 5 * DAY, "a", "x", "installed", "1.0"),
    ev(NOON - 3 * DAY, "a", "x", "updated", "2.0"),
  ];
  const installs = [install("a", "x", "3.0", NOON - HOUR)];
  const forward = checkpoints.reconstruct(NOON - DAY, { entries, installs, horizon: NOON - 6 * DAY });
  const backward = checkpoints.reconstruct(NOON - DAY, {
    entries: entries.slice().reverse(),
    installs,
    horizon: NOON - 6 * DAY,
  });
  assert.deepEqual(forward, backward);
  assert.equal(forward[0].version, "2.0");
});

test("checkpoints: a leading v never makes two equal versions look different", () => {
  const rows = checkpoints.reconstruct(NOON - DAY, {
    entries: [ev(NOON - 3 * DAY, "a", "x", "installed", "v1.4.0")],
    installs: [install("a", "x", "1.4.0", NOON - 3 * DAY)],
    horizon: NOON - 4 * DAY,
  });
  assert.equal(rows[0].version, "1.4.0");
  assert.equal(checkpoints.actionFor(rows[0]), "none");
});

/* ------------------------------------------------- the plan */

test("checkpoints: the plan for NOW is empty", async () => {
  const plan = await checkpointNow();
  assert.equal(plan.apps.length, 0);
  assert.equal(plan.uncertain, false);
  assert.equal(plan.actionable, 0);
});

async function checkpointNow() {
  return checkpoints.checkpointAt(
    "now",
    env({
      entries: [ev(NOON - 3 * DAY, "wivrn", "apk", "installed", "1.3.2"), ev(NOON - HOUR, "quadforge", "addon", "uninstalled", null)],
      installs: [install("wivrn", "apk", "1.3.2", NOON - 3 * DAY)],
    })
  );
}

test("checkpoints: the plan names the version, the tag and the action per artifact", async () => {
  const plan = await checkpoints.checkpointAt(
    "2d",
    env({
      entries: [
        ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
        ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
        ev(NOON - 5 * DAY, "quadforge", "addon", "installed", "1.3"),
        ev(NOON - 2 * HOUR, "quadforge", "addon", "uninstalled", null),
        ev(NOON - 4 * DAY, "limbo", "linux", "uninstalled", null),
        ev(NOON - 4 * DAY, "limbo", "linux", "uninstalled", null),
      ev(NOON - 3 * HOUR, "limbo", "linux", "installed", "2.0"),
      ],
      installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR), install("limbo", "linux", "2.0", NOON - 3 * HOUR)],
      releases: {
        wivrn: [{ tag: "v1.4.0", version: "1.4.0" }, { tag: "v1.3.0", version: "1.3.0" }],
        quadforge: [{ tag: "nx-1.3", version: "1.3" }],
      },
    })
  );

  const wivrn = rowFor(plan, "wivrn");
  assert.equal(wivrn.action, "install");
  assert.equal(wivrn.version, "1.3.0");
  assert.equal(wivrn.currentVersion, "1.4.0");
  assert.equal(wivrn.tag, "v1.3.0"); // the tag, not the version
  assert.equal(wivrn.appName, "WIVRN");
  assert.equal(wivrn.skipReason, null);

  const qf = rowFor(plan, "quadforge");
  assert.equal(qf.action, "install"); // it was there then, it is gone now
  assert.equal(qf.tag, "nx-1.3");

  const limbo = rowFor(plan, "limbo");
  assert.equal(limbo.action, "remove"); // installed after the checkpoint
  assert.equal(limbo.version, null);
  assert.equal(limbo.tag, null);

  assert.equal(plan.actionable, 3);
  assert.equal(plan.iso, new Date(NOON - 2 * DAY).toISOString());
});

test("checkpoints: a version whose release is gone is planned but flagged, never installed blind", async () => {
  const plan = await checkpoints.checkpointAt(
    "2d",
    env({
      entries: [
        ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
        ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
      ],
      installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
      releases: { wivrn: [{ tag: "v1.4.0", version: "1.4.0" }] }, // 1.3.0 was deleted
    })
  );
  const row = rowFor(plan, "wivrn");
  assert.equal(row.action, "install");
  assert.equal(row.tag, null);
  assert.equal(row.skipReason, "unknown-tag");
  assert.equal(plan.actionable, 0);
  assert.equal(plan.skipped, 1);
  assert.match(checkpoints.reasonText(row), /no published release/);
});

test("checkpoints: an app discovery no longer knows is a skip of its own", async () => {
  const opts = env({
    entries: [ev(NOON - 6 * DAY, "ghost", "x", "installed", "1.0"), ev(NOON - HOUR, "ghost", "x", "updated", "2.0")],
    installs: [install("ghost", "x", "2.0", NOON - HOUR)],
  });
  opts.findApp = () => null;
  const plan = await checkpoints.checkpointAt("2d", opts);
  assert.equal(rowFor(plan, "ghost").skipReason, "unknown-app");
  assert.equal(rowFor(plan, "ghost").appName, "ghost");
});

test("checkpoints: an uncertain app stays in the plan with no action at all", async () => {
  const plan = await checkpoints.checkpointAt(
    "30d",
    env({
      entries: [ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0")],
      installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    })
  );
  const row = rowFor(plan, "wivrn");
  assert.equal(row.uncertain, true);
  assert.equal(row.action, "none");
  assert.equal(row.skipReason, "uncertain");
  assert.equal(row.version, null);
  assert.equal(plan.uncertain, true);
  assert.equal(plan.actionable, 0);
});

test("checkpoints: the plan carries the newest config snapshot at or before `when`", async () => {
  const snaps = [
    { file: "2026-08-15T11-00-00.000Z-1.4.0-pre-update.tar.zst", ts: "2026-08-15T11:00:00.000Z", version: "1.4.0", reason: "pre-update" },
    { file: "2026-08-13T09-00-00.000Z-1.3.0-pre-update.tar.zst", ts: "2026-08-13T09:00:00.000Z", version: "1.3.0", reason: "pre-update" },
    { file: "2026-08-01T09-00-00.000Z-1.2.0-manual.tar.zst", ts: "2026-08-01T09:00:00.000Z", version: "1.2.0", reason: "manual" },
  ];
  const plan = await checkpoints.checkpointAt(
    "2d", // 2026-08-13T12:00Z
    env({
      entries: [
        ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
        ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
      ],
      installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
      releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
      snapshots: snaps,
    })
  );
  const row = rowFor(plan, "wivrn");
  assert.equal(row.snapshot, snaps[1].file); // the 08-13 one, not the 08-15 one
  assert.equal(row.snapshotAt, snaps[1].ts);
});

test("checkpoints: an unreadable `when` never reaches the journal", async () => {
  await assert.rejects(() => checkpoints.checkpointAt("tuesday", env()), /cannot read "tuesday"/);
});

test("checkpoints: tagForVersion matches on the parsed version first, the raw tag second", () => {
  const releases = [{ tag: "nx-1.3", version: "1.3" }, { tag: "v1.4.0", version: "1.4.0" }, { tag: "weird", version: null }];
  assert.equal(checkpoints.tagForVersion(releases, "1.3"), "nx-1.3");
  assert.equal(checkpoints.tagForVersion(releases, "v1.4.0"), "v1.4.0");
  assert.equal(checkpoints.tagForVersion(releases, "9.9"), null);
  assert.equal(checkpoints.tagForVersion(releases, null), null);
  assert.equal(checkpoints.tagForVersion([{ tag: "1.2.3" }], "1.2.3"), "1.2.3");
});

/* ------------------------------------------------- the executor */

/** A jobs stand-in whose jobs are done the moment they are queued. */
function fakeJobs(over = {}) {
  const calls = [];
  const table = new Map();
  let seq = 0;
  const push = (type, appId, artifactId, tag) => {
    seq += 1;
    const id = `job-${seq}`;
    calls.push({ type, appId, artifactId, tag: tag || null });
    const fail = over.fail && over.fail(appId, artifactId, type);
    table.set(id, {
      id,
      status: fail ? "error" : "done",
      message: `${type} ${appId}`,
      error: fail || null,
    });
    return id;
  };
  return {
    calls,
    installVersion: (appId, artifactId, tag) => push("install", appId, artifactId, tag),
    uninstall: (appId, artifactId) => push("remove", appId, artifactId),
    list: () => [...table.values()],
  };
}

function executorEnv(over = {}) {
  const opts = env(over);
  opts.jobs = over.jobs || fakeJobs();
  opts.pollMs = 0;
  opts.events = [];
  opts.emit = (evt) => opts.events.push(evt);
  return opts;
}

test("checkpoints: restore removes first, installs second, configs last", async (t) => {
  t.after(() => checkpoints._reset());
  const restored = [];
  const opts = executorEnv({
    entries: [
      ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
      ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
      ev(NOON - 4 * DAY, "limbo", "linux", "uninstalled", null),
      ev(NOON - 3 * HOUR, "limbo", "linux", "installed", "2.0"),
    ],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR), install("limbo", "linux", "2.0", NOON - 3 * HOUR)],
    releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
    snapshots: [{ file: "snap.tar.zst", ts: "2026-08-13T09:00:00.000Z", version: "1.3.0", reason: "pre-update" }],
  });
  opts.snapshots = {
    list: () => [{ file: "snap.tar.zst", ts: "2026-08-13T09:00:00.000Z", version: "1.3.0", reason: "pre-update" }],
    restore: async (appId, file) => {
      restored.push([appId, file]);
      return { ok: true, file, restored: ["~/.config/x"] };
    },
  };

  const result = await checkpoints.restore("2d", Object.assign({ configs: true }, opts));

  assert.equal(result.ok, true);
  assert.deepEqual(
    opts.jobs.calls.map((c) => `${c.type} ${c.appId}${c.tag ? ` ${c.tag}` : ""}`),
    ["remove limbo", "install wivrn v1.3.0"]
  );
  assert.deepEqual(restored, [["wivrn", "snap.tar.zst"]]); // only the app we touched
  assert.equal(result.counts.done, 3);
  assert.equal(result.counts.failed, 0);

  const phases = opts.events.map((e) => `${e.phase}${e.appId ? `:${e.appId}` : ""}`);
  assert.deepEqual(phases, ["planning", "removing:limbo", "installing:wivrn", "restoring-config:wivrn", "done"]);
  for (const evt of opts.events) assert.equal(evt.type, checkpoints.EVENT);
});

test("checkpoints: --configs off leaves every config alone", async (t) => {
  t.after(() => checkpoints._reset());
  const opts = executorEnv({
    entries: [ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"), ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
  });
  let touched = 0;
  opts.snapshots = {
    list: () => [{ file: "snap.tar.zst", ts: "2026-08-13T09:00:00.000Z", version: "1.3.0", reason: "pre-update" }],
    restore: async () => {
      touched += 1;
      return { ok: true };
    },
  };
  const result = await checkpoints.restore("2d", opts);
  assert.equal(touched, 0);
  assert.equal(result.configs, false);
  assert.ok(!opts.events.some((e) => e.phase === "restoring-config"));
});

test("checkpoints: uncertain apps and dead releases are skipped and reported, never acted on", async (t) => {
  t.after(() => checkpoints._reset());
  const opts = executorEnv({
    entries: [
      // ghost: uncertain (nothing recorded before `when`)
      ev(NOON - HOUR, "ghost", "x", "updated", "2.0"),
      // wivrn: certain, but 1.3.0 is no longer published
      ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
      ev(NOON - 2 * HOUR, "wivrn", "apk", "updated", "1.4.0"),
    ],
    installs: [install("ghost", "x", "2.0", NOON - HOUR), install("wivrn", "apk", "1.4.0", NOON - 2 * HOUR)],
    releases: { wivrn: [{ tag: "v1.4.0", version: "1.4.0" }] },
  });
  const result = await checkpoints.restore("2d", opts);
  assert.equal(opts.jobs.calls.length, 0);
  assert.equal(result.ok, true); // a skip is not a failure
  assert.equal(result.counts.skipped, 2);
  assert.equal(result.counts.done, 0);
  const ghost = result.results.find((r) => r.appId === "ghost");
  assert.equal(ghost.skipped, true);
  assert.equal(ghost.reason, "uncertain");
  assert.equal(result.results.find((r) => r.appId === "wivrn").reason, "unknown-tag");
  assert.equal(opts.events[opts.events.length - 1].phase, "done");
});

test("checkpoints: one failing step is reported and the rest still run", async (t) => {
  t.after(() => checkpoints._reset());
  const opts = executorEnv({
    entries: [
      ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"),
      ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
      ev(NOON - 4 * DAY, "limbo", "linux", "uninstalled", null),
      ev(NOON - 3 * HOUR, "limbo", "linux", "installed", "2.0"),
    ],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR), install("limbo", "linux", "2.0", NOON - 3 * HOUR)],
    releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
    jobs: fakeJobs({ fail: (appId) => (appId === "limbo" ? "adb is not connected" : null) }),
  });
  const result = await checkpoints.restore("2d", opts);
  assert.equal(result.ok, false);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.done, 1); // wivrn still went through
  assert.equal(result.results.find((r) => r.appId === "limbo").error, "adb is not connected");
  const phases = opts.events.map((e) => e.phase);
  assert.deepEqual(phases, ["planning", "removing", "failed", "installing", "failed"]);
  const verdict = opts.events[opts.events.length - 1];
  assert.equal(verdict.appId, null); // the RUN's own verdict
  assert.equal(verdict.counts.failed, 1);
});

test("checkpoints: a failed config restore fails the run without touching the installs", async (t) => {
  t.after(() => checkpoints._reset());
  const opts = executorEnv({
    entries: [ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"), ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
  });
  opts.snapshots = {
    list: () => [{ file: "snap.tar.zst", ts: "2026-08-13T09:00:00.000Z", version: "1.3.0", reason: "pre-update" }],
    restore: async () => {
      throw new Error("zstd is not installed");
    },
  };
  const result = await checkpoints.restore("2d", Object.assign({ configs: true }, opts));
  assert.equal(result.ok, false);
  assert.equal(result.counts.done, 1);
  assert.equal(result.results.find((r) => r.action === "config").error, "zstd is not installed");
});

test("checkpoints: only one restore runs at a time", async (t) => {
  t.after(() => checkpoints._reset());
  const opts = executorEnv({
    entries: [ev(NOON - 6 * DAY, "wivrn", "apk", "installed", "1.3.0"), ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0")],
    installs: [install("wivrn", "apk", "1.4.0", NOON - HOUR)],
    releases: { wivrn: [{ tag: "v1.3.0", version: "1.3.0" }] },
  });
  opts.runJob = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20));
  const first = checkpoints.restore("2d", opts);
  await assert.rejects(() => checkpoints.restore("2d", opts), /already running/);
  await first;
  // …and the guard is released again afterwards.
  await checkpoints.restore("2d", opts);
});

test("checkpoints: the default runner waits for the queue and reports what it did", async (t) => {
  t.after(() => checkpoints._reset());
  const jobs = fakeJobs();
  const result = await checkpoints.defaultRunJob("install", { appId: "wivrn", artifactId: "apk", tag: "v1.3.0" }, { jobs, pollMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(jobs.calls[0], { type: "install", appId: "wivrn", artifactId: "apk", tag: "v1.3.0" });

  await assert.rejects(
    () => checkpoints.defaultRunJob("remove", { appId: "a", artifactId: "x" }, { jobs: fakeJobs({ fail: () => "boom" }), pollMs: 0 }),
    /boom/
  );
  await assert.rejects(
    () =>
      checkpoints.defaultRunJob(
        "install",
        { appId: "a", artifactId: "x" },
        { jobs: { installVersion: () => "job-9", list: () => [] }, pollMs: 0 }
      ),
    /never queued/
  );
  await assert.rejects(
    () =>
      checkpoints.defaultRunJob(
        "install",
        { appId: "a", artifactId: "x" },
        {
          jobs: {
            installVersion: () => {
              throw new Error("Unknown artifact x for a");
            },
            list: () => [],
          },
          pollMs: 0,
        }
      ),
    /Unknown artifact/
  );
});

test("checkpoints: the default runner polls a job that is still running", async (t) => {
  t.after(() => checkpoints._reset());
  let polls = 0;
  const jobs = {
    installVersion: () => "job-1",
    list: () => {
      polls += 1;
      return [{ id: "job-1", status: polls < 3 ? "running" : "done", message: "Installed a 1.0" }];
    },
  };
  const result = await checkpoints.defaultRunJob("install", { appId: "a", artifactId: "x", tag: "v1" }, { jobs, pollMs: 0 });
  assert.equal(result.message, "Installed a 1.0");
  assert.ok(polls >= 3);
});

/* ------------------------------------------------- timeline */

test("checkpoints: timeline hands back the derived history, newest first", () => {
  const rec = fakeRecorder([
    ev(NOON - 5 * DAY, "wivrn", "apk", "installed", "1.3.0"),
    ev(NOON - HOUR, "wivrn", "apk", "updated", "1.4.0"),
    ev(NOON - 2 * HOUR, "quadforge", "addon", "uninstalled", null),
  ]);
  const all = checkpoints.timeline(null, { recorder: rec });
  assert.deepEqual(all.map((r) => `${r.appId} ${r.verb} ${r.version || "—"}`), [
    "wivrn updated 1.4.0",
    "quadforge uninstalled —",
    "wivrn installed 1.3.0",
  ]);
  assert.equal(all[0].effect, "set");
  assert.equal(all[1].effect, "clear");

  const one = checkpoints.timeline("wivrn", { recorder: rec });
  assert.equal(one.length, 2);
  assert.equal(rec.calls[rec.calls.length - 1].appId, "wivrn");
  assert.equal(rec.calls[0].type, "job-done");
});

test("checkpoints: readJournal reports the horizon it can vouch for", () => {
  const entries = [ev(NOON - 5 * DAY, "a", "x", "installed", "1.0"), ev(NOON - HOUR, "a", "x", "updated", "2.0")];
  const read = checkpoints.readJournal({ recorder: fakeRecorder(entries) });
  assert.equal(read.horizon, NOON - 5 * DAY);
  assert.equal(read.truncated, false);
  assert.equal(checkpoints.readJournal({ recorder: fakeRecorder([]) }).horizon, null);
  // A scan that hit the limit cannot claim to have seen the oldest entry.
  const many = checkpoints.readJournal({ recorder: fakeRecorder(entries), limit: 2 });
  assert.equal(many.truncated, true);
});
