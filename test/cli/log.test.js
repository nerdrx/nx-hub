"use strict";
// `nx log` — rendering, filters, exit codes and `--follow` (SPEC v0.8).
//
// The journal underneath is the REAL recorder in a temp dataDir: it is pure
// node with no network, so faking it would only test the fake.

const test = require("node:test");
const assert = require("node:assert");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const log = require("../../src/cli/log");
const recorder = require("../../src/main/recorder");
const { createStyle } = require("../../src/cli/ansi");

function fakeStream({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns: 100,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

async function runCli(argv, opts = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(
    argv,
    Object.assign(
      {
        runtime: { hubVersion: () => "0.8.0", on: () => () => {} },
        stdout,
        stderr,
        env: { NO_COLOR: "1" },
        platform: "linux",
      },
      opts
    )
  );
  return { code, out: stdout.text, err: stderr.text };
}

/** A real recorder on a clock we own, writing into a temp dataDir. */
function useJournal(t, start) {
  const env = helpers.useTempEnv();
  recorder._reset();
  let clock = start != null ? start : new Date(2026, 7, 15, 14, 30, 0, 0).getTime();
  recorder.init({ dataDir: env.dataDir, log: () => {}, now: () => clock, flushMs: 0 });
  t.after(() => {
    recorder._reset();
    env.cleanup();
  });
  return {
    env,
    now: () => clock,
    advance(ms) {
      clock += ms;
      return clock;
    },
  };
}

const AT = new Date(2026, 7, 15, 14, 32, 0, 0).getTime();
const ROWS = [
  { ts: AT + 120000, type: "job-error", appId: "wivrn-nx", summary: "wivrn-nx failed — checksum mismatch" },
  { ts: AT + 60000, type: "update-available", appId: "quadforge", summary: "update available: QuadForge v1.4" },
  { ts: AT, type: "job-done", appId: "wivrn-nx", summary: "installed WiVRn NX v1.4.0" },
  { ts: AT - 3600000, type: "day", summary: "2026-08-15" },
];

/* ---------------------------------------------------------------- render */

test("cli log: the table is time, type chip and one summary line — oldest first", () => {
  const out = log.renderLog(ROWS, { style: createStyle(false) });
  assert.match(out, /A C T I V I T Y/, "the tracked section label");
  assert.match(out, /── 2026-08-15 ─+/, "the day marker is a divider, not a row");
  assert.match(out, /14:32\s+done\s+installed WiVRn NX v1\.4\.0/);
  assert.match(out, /14:33\s+update\s+update available: QuadForge v1\.4/);
  assert.match(out, /14:34\s+error\s+wivrn-nx failed — checksum mismatch/);
  assert.match(out, /3 events/, "the day marker is not counted as an event");

  // Chronological: the newest line sits closest to the prompt.
  const lines = out.split("\n").filter((l) => /\d\d:\d\d/.test(l));
  assert.match(lines[0], /installed WiVRn NX/);
  assert.match(lines[lines.length - 1], /checksum mismatch/);
});

test("cli log: styled output paints the chip, and every type has one", () => {
  const st = createStyle(true);
  const painted = log.renderRow(ROWS[0], { style: st });
  assert.match(painted, /\u001b\[38;2;255;84;112m/, "an error chip is danger red");
  assert.ok(log.renderRow(ROWS[2], { style: st }).includes("\u001b["), "and a done chip is coloured too");

  for (const type of recorder.ENTRY_TYPES) {
    if (type === "day") continue;
    const [label] = log.chipOf(type);
    assert.ok(label && label.length <= log.CHIP_WIDTH, `${type} needs a chip that fits the column`);
  }
});

test("cli log: an empty journal says so instead of drawing an empty table", () => {
  assert.match(log.renderLog([], { style: createStyle(false) }), /Nothing recorded yet/);
  assert.match(log.renderLog([], { style: createStyle(false), filtered: true }), /Nothing in the journal matches that/);
});

test("cli log: day dividers are derived, so a filter cannot lose them", () => {
  const noon = new Date(2026, 7, 15, 12, 0, 0, 0).getTime();
  const rows = [
    { ts: noon + 26 * 3600 * 1000, type: "job-done", appId: "a", summary: "installed A v2.0" },
    { ts: noon, type: "job-done", appId: "a", summary: "installed A v1.0" },
  ];
  const out = log.renderLog(rows, { style: createStyle(false) });
  assert.match(out, /── 2026-08-15 ─+/);
  assert.match(out, /── 2026-08-16 ─+/);
  // …and a stored marker is not doubled up by a derived one.
  const withMarker = log.renderLog([rows[1], { ts: noon - 1000, type: "day", summary: "2026-08-15" }], {
    style: createStyle(false),
  });
  assert.equal((withMarker.match(/── 2026-08-15/g) || []).length, 1);
});

test("cli log: HH:MM is built by hand, so the host's locale cannot reword it", () => {
  assert.equal(log.hhmm(new Date(2026, 7, 15, 9, 5, 0, 0).getTime()), "09:05");
  assert.equal(log.hhmm(new Date(2026, 7, 15, 23, 59, 0, 0).getTime()), "23:59");
});

/* ---------------------------------------------------------------- command */

test("cli log: `nx log` prints what the hub has been doing", async (t) => {
  const j = useJournal(t);
  recorder.record({ type: "job-done", appId: "wivrn-nx", message: "Installed WiVRn NX 1.4.0" });
  j.advance(60000);
  recorder.record({ type: "job-error", appId: "quadforge", message: "download failed" });

  const r = await runCli(["log"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /installed WiVRn NX v1\.4\.0/);
  assert.match(r.out, /quadforge failed — download failed/);
  assert.match(r.out, /2 events/);
});

test("cli log: an empty journal is still a success", async (t) => {
  useJournal(t);
  const r = await runCli(["log"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.match(r.out, /Nothing recorded yet/);
});

test("cli log: --json is the only thing on stdout, and carries the query back", async (t) => {
  const j = useJournal(t);
  recorder.record({ type: "job-done", appId: "wivrn-nx", message: "Installed WiVRn NX 1.4.0" });
  j.advance(1000);
  recorder.record({ type: "update-available", appId: "quadforge", appName: "QuadForge", version: "1.4" });

  const r = await runCli(["log", "--json", "--type", "job-done", "--limit", "10"]);
  assert.equal(r.code, cli.EXIT_OK);
  const payload = JSON.parse(r.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.query.type, ["job-done"]);
  assert.equal(payload.query.limit, 10);
  assert.equal(payload.events[0].summary, "installed WiVRn NX v1.4.0");
  assert.equal(typeof payload.events[0].ts, "number");
});

test("cli log: --since, --type, --app and --limit narrow the window", async (t) => {
  const j = useJournal(t);
  const t0 = j.now();
  recorder.record({ type: "job-done", appId: "wivrn-nx", message: "Installed WiVRn NX 1.4.0" });
  j.advance(3 * 60 * 60 * 1000);
  recorder.record({ type: "job-done", appId: "quadforge", message: "Installed QuadForge 1.3" });
  j.advance(60 * 1000);
  recorder.record({ type: "job-error", appId: "quadforge", message: "launch failed" });

  const bySince = JSON.parse((await runCli(["log", "--since", "2h", "--json"])).out);
  assert.equal(bySince.count, 2, "only what happened inside the window");
  assert.equal(bySince.query.since, j.now() - 2 * 60 * 60 * 1000, "the relative window is resolved against the clock");
  assert.ok(bySince.events.every((e) => e.ts > t0));

  const byApp = JSON.parse((await runCli(["log", "--app", "quadforge", "--json"])).out);
  assert.equal(byApp.count, 2);
  assert.ok(byApp.events.every((e) => e.appId === "quadforge"));

  const byType = JSON.parse((await runCli(["log", "--type", "job-error,job-done", "--json"])).out);
  assert.equal(byType.count, 3);

  const limited = JSON.parse((await runCli(["log", "--limit", "1", "--json"])).out);
  assert.equal(limited.count, 1);
  assert.equal(limited.events[0].summary, "quadforge failed — launch failed", "the newest one");

  // A bare ISO date is read as local midnight — every event above is after it.
  const byDate = JSON.parse((await runCli(["log", "--since", "2026-08-15", "--json"])).out);
  assert.ok(byDate.count >= 3);
});

test("cli log: --limit is clamped to 1000 rather than refused", async (t) => {
  useJournal(t);
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  const r = await runCli(["log", "--limit", "99999", "--json"]);
  assert.equal(r.code, cli.EXIT_OK);
  assert.equal(JSON.parse(r.out).query.limit, 1000);
});

test("cli log: a time it cannot read is a user error, not a crash", async (t) => {
  useJournal(t);
  const bad = await runCli(["log", "--since", "yesterday"]);
  assert.equal(bad.code, cli.EXIT_USER);
  assert.match(bad.err, /cannot read "yesterday" as a time/);
  assert.match(bad.err, /24h, 2d, 90m/);

  const badLimit = await runCli(["log", "--limit", "lots"]);
  assert.equal(badLimit.code, cli.EXIT_USER);
  assert.match(badLimit.err, /--limit wants a positive number/);

  const badType = await runCli(["log", "--type", "job-doneish"]);
  assert.equal(badType.code, cli.EXIT_USER);
  assert.match(badType.err, /nothing is recorded under the type "job-doneish"/);
  assert.match(badType.err, /known types: .*job-done/);
});

test("cli log: --json reports its own errors as json", async (t) => {
  useJournal(t);
  const r = await runCli(["log", "--since", "whenever", "--json"]);
  assert.equal(r.code, cli.EXIT_USER);
  assert.equal(JSON.parse(r.out).ok, false);
});

test("cli log: `nx logs` and `nx activity` are the same command", async (t) => {
  useJournal(t);
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  for (const alias of ["logs", "activity"]) {
    const r = await runCli([alias, "--json"]);
    assert.equal(r.code, cli.EXIT_OK, alias);
    assert.equal(JSON.parse(r.out).count, 1, alias);
  }
});

test("cli log: help lists it", async () => {
  const r = await runCli(["help"]);
  assert.match(r.out, /log\s+\[--since 24h\]/);
});

/* ---------------------------------------------------------------- follow */

test("cli log: the follower prints only what is new, once each", (t) => {
  const j = useJournal(t);
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });
  const seeded = recorder.query({ limit: 10 });
  const written = [];
  const follower = log.createFollower({
    recorder,
    write: (line) => written.push(line),
    style: createStyle(false),
    from: seeded[0].ts,
    seenKeys: seeded.filter((e) => e.ts === seeded[0].ts).map((e) => `${e.ts}|${e.type}|${e.summary}`),
  });

  assert.equal(follower.tick(), 0, "nothing new yet");
  assert.equal(written.length, 0);

  recorder.record({ type: "job-done", appId: "b", message: "Installed B 2.0" }); // same ms
  assert.equal(follower.tick(), 1, "an event inside the same millisecond is still new");
  assert.match(written[0], /installed B v2\.0/);

  j.advance(5000);
  recorder.record({ type: "job-error", appId: "b", message: "it broke" });
  assert.equal(follower.tick(), 1);
  assert.equal(follower.tick(), 0, "and nothing comes round twice");
  assert.equal(written.length, 2);
});

test("cli log: --follow tails the journal and Ctrl-C leaves with 0", async (t) => {
  const j = useJournal(t);
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });

  const controller = new AbortController();
  const stdout = fakeStream();
  const stderr = fakeStream();
  const running = cli.run(["log", "--follow"], {
    runtime: { hubVersion: () => "0.8.0", on: () => () => {} },
    stdout,
    stderr,
    env: { NO_COLOR: "1" },
    platform: "linux",
    follow: { intervalMs: 10, signal: controller.signal, unref: true },
  });

  await new Promise((r) => setTimeout(r, 30));
  j.advance(1000);
  recorder.record({ type: "job-done", appId: "b", message: "Installed B 2.0" });
  await new Promise((r) => setTimeout(r, 60));
  controller.abort();

  const code = await running;
  assert.equal(code, cli.EXIT_OK, "^C on a tail is not a failure");
  assert.match(stdout.text, /installed A v1\.0/, "the seeded batch");
  assert.match(stdout.text, /installed B v2\.0/, "and what arrived while following");
  assert.equal(stdout.text.match(/installed A v1\.0/g).length, 1, "the seeded batch is not repeated");
  assert.match(stderr.text, /following/);
});

test("cli log: --json --follow keeps emitting json, one object per line", async (t) => {
  const j = useJournal(t);
  recorder.record({ type: "job-done", appId: "a", message: "Installed A 1.0" });

  const controller = new AbortController();
  const stdout = fakeStream();
  const running = cli.run(["log", "--json", "--follow"], {
    runtime: { hubVersion: () => "0.8.0", on: () => () => {} },
    stdout,
    stderr: fakeStream(),
    env: { NO_COLOR: "1" },
    platform: "linux",
    follow: { intervalMs: 10, signal: controller.signal, unref: true },
  });

  await new Promise((r) => setTimeout(r, 30));
  j.advance(1000);
  recorder.record({ type: "job-error", appId: "b", message: "it broke" });
  await new Promise((r) => setTimeout(r, 60));
  controller.abort();

  assert.equal(await running, cli.EXIT_OK);
  const last = stdout.text.trim().split("\n").pop();
  const entry = JSON.parse(last);
  assert.equal(entry.type, "job-error");
  assert.equal(entry.summary, "b failed — it broke");
});
