"use strict";
// src/main/recorder.js — the flight recorder (SPEC v0.8).
//
// The journal is a real file in a real temp dataDir: it is pure node with no
// network, so faking the filesystem would only test the fake. The clock IS
// faked (init({now})), because a day marker and a rotation are both things you
// have to be able to reach on demand.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const recorder = require("../../src/main/recorder");
const ipc = require("../../src/main/ipc");

const NOON = Date.parse("2026-08-15T12:00:00Z");

/** A recorder writing into a fresh temp dataDir, on a clock we own. */
function useRecorder(t, over = {}) {
  const env = helpers.useTempEnv();
  recorder._reset();
  let clock = over.start != null ? over.start : NOON;
  const logged = [];
  recorder.init(
    Object.assign(
      {
        dataDir: env.dataDir,
        log: (m) => logged.push(m),
        now: () => clock,
        flushMs: 0, // write through: a test should never wait on a timer
      },
      over.init || {}
    )
  );
  t.after(() => {
    recorder._reset();
    env.cleanup();
  });
  return {
    env,
    logged,
    now: () => clock,
    at(ms) {
      clock = ms;
      return clock;
    },
    advance(ms) {
      clock += ms;
      return clock;
    },
    lines() {
      return fs
        .readFileSync(path.join(env.dataDir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
    },
  };
}

/** The entries a single record() produced, day markers excluded. */
function rec(evt) {
  return recorder.record(evt);
}

/* ------------------------------------------------- normalization matrix */

test("recorder: job-done reads the verb, the app and the version out of the message", (t) => {
  const clock = useRecorder(t);

  const [installed] = rec({ type: "job-done", jobId: "j1", appId: "wivrn-nx", artifactId: "apk", message: "Installed WiVRn NX 1.4.0" });
  assert.equal(installed.type, "job-done");
  assert.equal(installed.ts, clock.now());
  assert.equal(installed.appId, "wivrn-nx");
  assert.equal(installed.artifactId, "apk");
  assert.equal(installed.summary, "installed WiVRn NX v1.4.0");
  assert.equal(installed.data.verb, "installed");
  assert.equal(installed.data.version, "1.4.0");
  assert.equal(installed.data.jobId, "j1");

  const [removed] = rec({ type: "job-done", appId: "wivrn-nx", message: "Removed WiVRn NX — Headset APK" });
  assert.equal(removed.summary, "uninstalled WiVRn NX", "the artifact label is not part of the sentence");

  const [restored] = rec({ type: "job-done", appId: "quadforge", message: "Restored QuadForge 1.2" });
  assert.equal(restored.summary, "rolled back QuadForge v1.2");

  // A post-install note is a note, not an app name — fall back to the id.
  const [noted] = rec({ type: "job-done", appId: "quadforge", message: "Installed. Enable the add-on in Blender" });
  assert.equal(noted.summary, "installed quadforge");

  // An emitter that knows more wins over the message parse.
  const [updated] = rec({
    type: "job-done",
    appId: "wivrn-nx",
    appName: "WiVRn NX",
    jobType: "install",
    previousVersion: "1.3.2",
    version: "v1.4.0",
    message: "Installed WiVRn NX 1.4.0",
  });
  assert.equal(updated.summary, "updated WiVRn NX v1.4.0", "an install over an existing one is an update");
});

test("recorder: job-error keeps the reason, and a cancellation says so", (t) => {
  useRecorder(t);
  const [failed] = rec({ type: "job-error", jobId: "j2", appId: "wivrn-nx", artifactId: "apk", message: "checksum mismatch", silent: true });
  assert.equal(failed.type, "job-error");
  assert.equal(failed.summary, "wivrn-nx failed — checksum mismatch");
  assert.equal(failed.data.silent, true);

  const [cancelled] = rec({ type: "job-error", appId: "wivrn-nx", message: "Cancelled" });
  assert.equal(cancelled.summary, "cancelled wivrn-nx");
});

test("recorder: update-available names the app and the version", (t) => {
  useRecorder(t);
  const [e] = rec({ type: "update-available", appId: "wivrn-nx", appName: "WiVRn NX", artifactId: "apk", version: "v1.5.0" });
  assert.equal(e.summary, "update available: WiVRn NX v1.5.0");
  assert.equal(e.data.version, "1.5.0");
  assert.equal(e.artifactId, "apk");
});

test("recorder: only a stack RUN's verdict is recorded, never a step's phase", (t) => {
  useRecorder(t);
  assert.deepEqual(rec({ type: "stack-progress", stackId: "vr", stepIndex: 0, appId: "wivrn-nx", phase: "launching" }), []);
  assert.deepEqual(rec({ type: "stack-progress", stackId: "vr", stepIndex: 1, appId: "x", phase: "healthy" }), []);
  assert.deepEqual(
    rec({ type: "stack-progress", stackId: "vr", stepIndex: 2, appId: "x", phase: "failed", message: "step died" }),
    [],
    "a per-step failure is noise — the run reports its own verdict"
  );

  const [done] = rec({ type: "stack-progress", stackId: "vr", stepIndex: null, appId: null, phase: "done" });
  assert.equal(done.type, "stack-progress");
  assert.equal(done.stackId, "vr");
  assert.equal(done.summary, "stack vr is up");

  const [failed] = rec({ type: "stack-progress", stackId: "vr", stepIndex: null, appId: "wivrn-nx", phase: "failed", message: "never came up", failedStep: 1 });
  assert.equal(failed.summary, "stack vr failed — never came up");
  assert.equal(failed.data.failedStep, 1);
  assert.equal(failed.appId, "wivrn-nx");

  const [stopped] = rec({ type: "stack-progress", stackId: "vr", stepIndex: null, phase: "stopped", count: 2 });
  assert.equal(stopped.summary, "stack vr stopped");

  const [triggered] = rec({ type: "stack-progress", stackId: "vr", stepIndex: null, phase: "triggered", reason: "wivrn-nx joined the bus" });
  assert.equal(triggered.summary, "stack vr triggered — wivrn-nx joined the bus");
});

test("recorder: fleet-progress records terminal events only", (t) => {
  useRecorder(t);
  assert.deepEqual(rec({ type: "fleet-progress", peerId: "p1", peerName: "attic", event: "job-progress", pct: 40 }), []);

  const [done] = rec({ type: "fleet-progress", peerId: "p1", peerName: "attic", event: "job-done", appId: "quadforge", appName: "QuadForge" });
  assert.equal(done.type, "fleet-progress");
  assert.equal(done.peerId, "p1");
  assert.equal(done.summary, "QuadForge finished on attic");

  const [failed] = rec({ type: "fleet-progress", peerId: "p1", peerName: "attic", event: "job-error", appId: "quadforge", message: "no space left" });
  assert.equal(failed.summary, "quadforge failed on attic — no space left");
});

test("recorder: supervisor events take [guardian]'s wording when it supplies one", (t) => {
  useRecorder(t);
  const [relaunch] = rec({ type: "supervisor", appId: "pulsenx", appName: "PulseNX", action: "relaunch", attempt: 2, delayMs: 4000 });
  assert.equal(relaunch.type, "supervisor");
  assert.equal(relaunch.summary, "relaunched PulseNX (attempt 2)");
  assert.equal(relaunch.data.attempt, 2);

  const [gaveUp] = rec({ type: "supervisor", appId: "pulsenx", appName: "PulseNX", action: "gave-up" });
  assert.equal(gaveUp.summary, "gave up relaunching PulseNX");

  const [own] = rec({ type: "supervisor", appId: "pulsenx", summary: "keep-alive suspended (crash loop)" });
  assert.equal(own.summary, "keep-alive suspended (crash loop)");
});

test("recorder: every other event type is ignored, and nothing malformed throws", (t) => {
  const clock = useRecorder(t);
  for (const evt of [
    null,
    undefined,
    "job-done",
    42,
    {},
    { type: 7 },
    { type: "toast", level: "info", message: "hi" },
    { type: "state-changed" },
    { type: "job-progress", pct: 10 },
    { type: "fleet-changed" },
    { type: "connector-changed" }, // no roster attached = nothing to diff
  ]) {
    assert.deepEqual(recorder.record(evt), [], `${JSON.stringify(evt)} should be ignored`);
  }
  assert.equal(recorder.query({ limit: 50 }).length, 0, "an ignored event writes no line");
  assert.equal(clock.now(), NOON);
});

test("recorder: a poisoned event is dropped, never thrown", (t) => {
  const clock = useRecorder(t);
  const poisoned = {
    type: "job-done",
    appId: "wivrn-nx",
    get message() {
      throw new Error("boom");
    },
  };
  assert.deepEqual(recorder.record(poisoned), []);

  // A cyclic `data` source is simply not carried (only primitives are).
  const cyclic = { type: "supervisor", appId: "x", action: "relaunch" };
  cyclic.reason = cyclic;
  const [e] = recorder.record(cyclic);
  assert.equal(e.summary, "relaunched x");
  assert.ok(!e.data || e.data.reason === undefined);

  // …and the journal still works afterwards.
  rec({ type: "job-done", appId: "quadforge", message: "Installed QuadForge 1.3" });
  assert.equal(recorder.query({ limit: 10 })[0].summary, "installed QuadForge v1.3");
  assert.equal(clock.now(), NOON);
});

test("recorder: the summary is one line and never longer than 160 chars", (t) => {
  useRecorder(t);
  const [e] = rec({ type: "job-error", appId: "wivrn-nx", message: `line one\nline two ${"x".repeat(400)}` });
  assert.ok(e.summary.length <= recorder.MAX_SUMMARY, `summary was ${e.summary.length}`);
  assert.ok(!/[\r\n]/.test(e.summary), "no newlines survive into a journal line");
  assert.ok(e.summary.endsWith("…"));
});

/* ------------------------------------------------- connector diffing */

test("recorder: connector-changed is diffed into joins and leaves", (t) => {
  const clock = useRecorder(t);
  const since = new Date(NOON - 90 * 1000).toISOString();

  const first = rec({
    type: "connector-changed",
    clients: [
      { app: "pulsenx", version: "2.0.0", pid: 4242, since },
      { app: "wivrn-nx", version: "1.4.0", pid: 4243, since },
    ],
  });
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((e) => e.type), ["connector-join", "connector-join"]);
  assert.equal(first[0].appId, "pulsenx");
  assert.equal(first[0].summary, "pulsenx connected v2.0.0");
  assert.equal(first[0].data.pid, 4242);

  // The same roster again says nothing at all.
  assert.deepEqual(rec({ type: "connector-changed", clients: [{ app: "pulsenx", since }, { app: "wivrn-nx", since }] }), []);

  clock.advance(10 * 60 * 1000);
  const moved = rec({
    type: "connector-changed",
    clients: [
      { app: "wivrn-nx", version: "1.4.0", since },
      { app: "quadforge", version: "1.3", since: new Date(clock.now()).toISOString() },
    ],
  });
  assert.equal(moved.length, 2);
  const join = moved.find((e) => e.type === "connector-join");
  const leave = moved.find((e) => e.type === "connector-leave");
  assert.equal(join.appId, "quadforge");
  assert.equal(leave.appId, "pulsenx");
  assert.match(leave.summary, /^pulsenx disconnected after 12m$/, "the leave line carries how long it was up");

  // Everything went to disk in order.
  const all = recorder.query({ limit: 50 });
  assert.deepEqual(all.map((e) => e.type), ["connector-leave", "connector-join", "connector-join", "connector-join", "day"]);
});

/* ------------------------------------------------- the journal file */

test("recorder: a day marker opens every new local day, exactly once", (t) => {
  const clock = useRecorder(t);
  rec({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  rec({ type: "job-done", appId: "b", message: "Installed B 1.0" });
  clock.advance(26 * 60 * 60 * 1000); // tomorrow, whatever the timezone
  rec({ type: "job-done", appId: "c", message: "Installed C 1.0" });

  const types = clock.lines().map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["day", "job-done", "job-done", "day", "job-done"]);

  const markers = recorder.query({ type: "day", limit: 10 });
  assert.equal(markers.length, 2);
  assert.equal(markers[1].summary, recorder.dayKey(NOON));
  assert.notEqual(markers[0].summary, markers[1].summary);
});

test("recorder: a restart inside the same day does not draw a second marker", (t) => {
  const clock = useRecorder(t);
  rec({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  const at = clock.now();

  recorder.init({ dataDir: clock.env.dataDir, log: () => {}, now: () => at + 1000, flushMs: 0 });
  recorder.record({ type: "job-done", appId: "b", message: "Installed B 1.0" });

  const types = clock.lines().map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["day", "job-done", "job-done"]);
});

test("recorder: the journal rotates at maxBytes and keeps exactly two behind it", (t) => {
  const clock = useRecorder(t, { init: { maxBytes: 700 } });
  for (let i = 0; i < 40; i += 1) {
    clock.advance(1000);
    rec({ type: "job-done", appId: `app-${i}`, message: `Installed App ${i} 1.0.${i}` });
  }
  const dir = clock.env.dataDir;
  for (const name of ["events.jsonl", "events.1.jsonl", "events.2.jsonl"]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} should exist`);
    assert.ok(fs.statSync(path.join(dir, name)).size <= 700 + 200, `${name} stayed near maxBytes`);
  }
  assert.ok(!fs.existsSync(path.join(dir, "events.3.jsonl")), "only two generations are kept");

  const kept = recorder.query({ limit: 1000 });
  assert.ok(kept.length < 40, "the oldest generation was dropped");
  assert.ok(kept.length > clock.lines().length, "the read-back spans more than the live file");
  assert.equal(kept[0].summary, "installed App 39 v1.0.39", "newest first, across the rotation");
  // Contiguous: whatever survived is a suffix of what was recorded.
  const numbers = kept.filter((e) => e.type === "job-done").map((e) => Number(e.appId.split("-")[1]));
  for (let i = 1; i < numbers.length; i += 1) assert.equal(numbers[i], numbers[i - 1] - 1);
});

test("recorder: a torn last line is skipped, wherever it sits", (t) => {
  const clock = useRecorder(t);
  rec({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  const file = path.join(clock.env.dataDir, "events.jsonl");

  // The process died mid-append: half a line, no newline.
  fs.appendFileSync(file, '{"ts":1755300000000,"type":"job-do');
  assert.equal(recorder.query({ limit: 10 }).length, 2, "the day marker and the one good entry");

  // …and the next incarnation heals the tail instead of gluing itself to it.
  recorder.init({ dataDir: clock.env.dataDir, log: () => {}, now: () => clock.now() + 1000, flushMs: 0 });
  recorder.record({ type: "job-done", appId: "b", message: "Installed B 2.0" });
  const back = recorder.query({ limit: 10 });
  assert.equal(back[0].summary, "installed B v2.0", "the entry after a torn write survives");
  assert.equal(back.filter((e) => e.type === "job-done").length, 2);

  // Junk in the MIDDLE of the file stops nothing either.
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good.replace("\n", "\nnot json at all\n"));
  assert.equal(recorder.query({ limit: 10 }).filter((e) => e.type === "job-done").length, 2);
});

/* ------------------------------------------------- query */

test("recorder: query filters on since/until, type and appId, newest first", (t) => {
  const clock = useRecorder(t);
  const t0 = clock.now();
  rec({ type: "job-done", appId: "wivrn-nx", message: "Installed WiVRn NX 1.4.0" });
  clock.at(t0 + 60 * 60 * 1000);
  rec({ type: "update-available", appId: "quadforge", appName: "QuadForge", version: "1.4" });
  clock.at(t0 + 2 * 60 * 60 * 1000);
  rec({ type: "job-error", appId: "wivrn-nx", message: "download failed" });

  const all = recorder.query({ limit: 100 });
  assert.deepEqual(all.map((e) => e.type), ["job-error", "update-available", "job-done", "day"]);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].ts <= all[i - 1].ts, "newest first");

  assert.deepEqual(recorder.query({ type: "job-error" }).map((e) => e.appId), ["wivrn-nx"]);
  assert.deepEqual(recorder.query({ type: "job-done,update-available" }).map((e) => e.type), ["update-available", "job-done"]);
  assert.deepEqual(recorder.query({ type: ["update-available"] }).map((e) => e.appId), ["quadforge"]);

  assert.deepEqual(recorder.query({ appId: "wivrn-nx" }).map((e) => e.type), ["job-error", "job-done"]);
  assert.deepEqual(recorder.query({ appId: "WIVRN-NX" }).map((e) => e.type), ["job-error", "job-done"], "app matching is case-insensitive");

  // since: absolute, and the relative string the CLI passes through
  assert.equal(recorder.query({ since: t0 + 30 * 60 * 1000 }).length, 2);
  clock.at(t0 + 2 * 60 * 60 * 1000);
  assert.equal(recorder.query({ since: "90m" }).length, 2, "relative to the injected clock");
  assert.equal(recorder.query({ since: "30m" }).length, 1, "…and it really moves the window");
  assert.equal(recorder.query({ until: t0 + 30 * 60 * 1000 }).length, 2, "the day marker and the install");
  assert.equal(recorder.query({ since: t0, until: t0 + 61 * 60 * 1000 }).length, 3);
});

test("recorder: the limit defaults to 200 and is clamped to 1000", (t) => {
  useRecorder(t);
  assert.equal(recorder.clampLimit(undefined), 200);
  assert.equal(recorder.clampLimit(0), 200);
  assert.equal(recorder.clampLimit(-5), 200);
  assert.equal(recorder.clampLimit("nope"), 200);
  assert.equal(recorder.clampLimit("50"), 50);
  assert.equal(recorder.clampLimit(1e9), 1000);

  for (let i = 0; i < 12; i += 1) rec({ type: "job-done", appId: `a${i}`, message: `Installed A${i} 1.0` });
  assert.equal(recorder.query({ limit: 5 }).length, 5);
  assert.equal(recorder.query({ limit: 5 })[0].appId, "a11", "the newest five");
  assert.equal(recorder.query({}).length, 13, "everything (12 + the day marker) under the default");
});

test("recorder: parseSince takes relatives, ISO dates and epoch ms — and nothing else", () => {
  const now = Date.parse("2026-08-15T12:00:00Z");
  assert.equal(recorder.parseSince("24h", now), now - 86400000);
  assert.equal(recorder.parseSince("2d", now), now - 2 * 86400000);
  assert.equal(recorder.parseSince("90m", now), now - 90 * 60000);
  assert.equal(recorder.parseSince("45s", now), now - 45000);
  assert.equal(recorder.parseSince("1w", now), now - 7 * 86400000);
  assert.equal(recorder.parseSince("now", now), now);
  assert.equal(recorder.parseSince(now, now), now);
  assert.equal(recorder.parseSince(String(now), now), now);
  assert.equal(recorder.parseSince("2026-08-15T00:00:00Z", now), Date.parse("2026-08-15T00:00:00Z"));

  // A bare date is LOCAL midnight, built from its parts — never Date.parse of
  // an ambiguous string, because the host may run any locale.
  const local = recorder.parseSince("2026-08-15", now);
  const d = new Date(local);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);

  for (const bad of ["yesterday", "24 hours", "15.08.2026", "", null, undefined, "abc", {}]) {
    assert.equal(recorder.parseSince(bad, now), null, `${JSON.stringify(bad)} is not a time`);
  }
});

test("recorder: buffered writes land on the timer and on close()", async (t) => {
  const env = helpers.useTempEnv();
  recorder._reset();
  t.after(() => {
    recorder._reset();
    env.cleanup();
  });
  recorder.init({ dataDir: env.dataDir, log: () => {}, flushMs: 20 });
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });

  const file = path.join(env.dataDir, "events.jsonl");
  assert.ok(!fs.existsSync(file), "nothing is written synchronously");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(fs.existsSync(file), "the timer flushed it");

  recorder.record({ type: "job-done", appId: "b", message: "Installed B 1.0" });
  assert.equal(recorder.close(), 1, "close() writes what is still buffered");
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
});

/* ------------------------------------------------- the ipc tap */

test("recorder: ipc's emit fan-out records, and the tap never throws through", (t) => {
  const clock = useRecorder(t);

  ipc.emit({ type: "job-done", jobId: "j9", appId: "quadforge", artifactId: "zip", message: "Installed QuadForge 1.3" });
  ipc.emit({ type: "toast", level: "info", message: "Launching…" });
  ipc.emit({ type: "job-progress", jobId: "j9", pct: 50 });
  ipc.emit({ type: "state-changed" });

  const entries = recorder.query({ limit: 20 });
  assert.equal(entries.filter((e) => e.type !== "day").length, 1, "only the job-done is history");
  assert.equal(entries[0].summary, "installed QuadForge v1.3");

  // The tap swallows anything the recorder somehow lets through.
  assert.doesNotThrow(() =>
    ipc.recordEvent({
      type: "job-error",
      appId: "x",
      get message() {
        throw new Error("boom");
      },
    })
  );
  assert.equal(clock.now(), NOON);
});

test("recorder: the tap hands connector-changed the CURRENT roster to diff", (t) => {
  useRecorder(t);
  let roster = [{ app: "pulsenx", version: "2.0.0", pid: 11, since: new Date(NOON - 1000).toISOString() }];
  t.after(() => ipc.setConnector(null));
  ipc.setConnector(
    { getClients: () => roster, onChange: () => () => {} },
    { snapshotDebounceMs: 10000, snapshotHeartbeatMs: 0 }
  );

  ipc.emit({ type: "connector-changed" });
  assert.equal(recorder.query({ type: "connector-join" })[0].appId, "pulsenx");

  roster = [];
  ipc.emit({ type: "connector-changed" });
  const leave = recorder.query({ type: "connector-leave" })[0];
  assert.equal(leave.appId, "pulsenx");
  assert.match(leave.summary, /^pulsenx disconnected/);
});

test("recorder: getEvents() validates the renderer's query and clamps the limit", (t) => {
  const clock = useRecorder(t);
  for (let i = 0; i < 5; i += 1) {
    clock.advance(1000);
    rec({ type: "job-done", appId: i % 2 ? "a" : "b", message: `Installed App${i} 1.0` });
  }

  assert.equal(ipc.getEvents({ limit: 999999 }).length, 6, "clamped, not refused");
  assert.equal(ipc.getEvents({ limit: 2 }).length, 2);
  assert.equal(ipc.getEvents().length, 6, "no query at all is the default window");
  assert.equal(ipc.getEvents("nonsense").length, 6, "a junk query degrades to the default");
  assert.deepEqual(ipc.getEvents({ appId: "a" }).map((e) => e.appId), ["a", "a"]);
  assert.equal(ipc.getEvents({ type: "job-done" }).length, 5);
  assert.equal(ipc.getEvents({ since: "10m" }).length, 6, "since takes the CLI's relative strings too");
  assert.equal(ipc.getEvents({ since: "1s" }).length, 2, "…and it is honoured against the recorder's clock");

  const [entry] = ipc.getEvents({ limit: 1 });
  for (const key of ["ts", "type", "summary"]) assert.ok(key in entry, `getEvents entry.${key} missing`);
  assert.equal(typeof entry.ts, "number");
});
