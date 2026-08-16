"use strict";
// `nx bisect` — rendering, dispatch, the install pipeline it drives, and exit
// codes (SPEC v0.7). The state machine itself is exercised in
// test/core/bisect.test.js; here it is about what the CLI does with it.

const test = require("node:test");
const assert = require("node:assert");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const bisectCli = require("../../src/cli/bisect");
const bisect = require("../../src/main/bisect");
const fx = require("./fixtures");
const { createStyle } = require("../../src/cli/ansi");

function fakeStream() {
  const chunks = [];
  return {
    isTTY: false,
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

/** Eight releases, oldest first, with notes worth printing. */
function releases() {
  return Array.from({ length: 8 }, (_, i) => ({
    tag: `v1.${i}`,
    version: `1.${i}`,
    publishedAt: `2026-0${i + 1}-01T00:00:00Z`,
    prerelease: false,
    notes: `What changed in 1.${i}\n- a thing\n- another thing`,
  }));
}

/** One app, one linux artifact, installed at 1.2 — so `reset` has a target. */
const APP = fx.app({
  id: "demo",
  name: "Demo",
  artifacts: [
    fx.artifact({
      id: "archive-dir-linux",
      installed: { version: "1.2", path: "/tmp/demo", installedAt: "2026-03-01T00:00:00Z" },
    }),
  ],
});

function fakeRuntime(over = {}) {
  const calls = [];
  return Object.assign(
    {
      calls,
      hubVersion: () => "0.7.0",
      on: () => () => {},
      apps: async () => [APP],
      cached: () => ({ apps: [APP], errors: [] }),
      releases: async (id) => {
        calls.push(["releases", id]);
        return releases();
      },
      install: async (appId, artifactId, opts = {}) => {
        calls.push(["install", appId, artifactId, opts.tag || null]);
        return { ok: true, message: `Installed ${opts.tag || "latest"}` };
      },
      uninstall: async (appId, artifactId) => {
        calls.push(["uninstall", appId, artifactId]);
        return { ok: true, message: "Removed" };
      },
    },
    over
  );
}

async function runCli(argv, runtime) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime,
    stdout,
    stderr,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text, runtime };
}

function useEnv(t) {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());
  return env;
}

/** The tag the CLI last asked to install. */
function lastInstalled(runtime) {
  const installs = runtime.calls.filter((c) => c[0] === "install");
  return installs.length ? installs[installs.length - 1][3] : null;
}

/* ---------------------------------------------------------------- render */

test("cli bisect: the candidate line names the tag, its date and the budget", () => {
  const s = bisect.startState({ appId: "demo", artifactId: "a", tags: bisect.orderTags(releases()) });
  const line = bisectCli.renderCandidate(bisect.summary(s), { style: createStyle(false) });
  assert.match(line, /testing v1\.3/, "the midpoint of eight");
  assert.match(line, /2026-04-01/, "ISO date, never a locale one");
  assert.match(line, /8 left, ~3 steps/);
  assert.ok(!/\[/.test(line), "plain style emits no escapes");
});

test("cli bisect: status shows the remaining range and the steps left", () => {
  let s = bisect.startState({
    appId: "demo",
    artifactId: "archive-dir-linux",
    tags: bisect.orderTags(releases()),
    restore: { version: "1.2", tag: "v1.2" },
  });
  s = bisect.applyVerdict(s, "good"); // v1.3 good → lo climbs
  const out = bisectCli.renderStatus(bisect.summary(s), { style: createStyle(false) });
  assert.match(out, /B I S E C T/);
  assert.match(out, /app\s+demo \/ archive-dir-linux/);
  assert.match(out, /range\s+v1\.4 … v1\.7/);
  assert.match(out, /remaining\s+4 of 8/);
  assert.match(out, /steps left\s+2/);
  assert.match(out, /testing\s+v1\.5/);
  assert.match(out, /restore to\s+v1\.2/);
  assert.match(out, /nx bisect good \| bad \| skip/);
});

test("cli bisect: the convergence report carries the tag, the date and ten lines of notes", () => {
  const tags = bisect.orderTags(releases());
  let s = bisect.startState({ appId: "demo", artifactId: "a", tags });
  while (!s.done) s = bisect.applyVerdict(s, s.current >= 5 ? "bad" : "good");

  const bad = bisect.firstBadTag(s);
  const out = bisectCli.renderResult(bisect.summary(s), bisect.notesHead(bad.notes), { style: createStyle(false) });
  assert.match(out, /v1\.5 is the first bad release/);
  assert.match(out, /published\s+2026-06-01/);
  assert.match(out, /What changed in 1\.5/);
  assert.match(out, /- another thing/);
  assert.match(out, /nx bisect reset/);
});

test("cli bisect: a release blamed without ever being installed says so", () => {
  const tags = bisect.orderTags(releases());
  let s = bisect.startState({ appId: "demo", artifactId: "a", tags });
  while (!s.done) s = bisect.applyVerdict(s, "good"); // nothing ever tests bad

  const sum = bisect.summary(s);
  assert.strictEqual(sum.confirmed, false);
  const out = bisectCli.renderResult(sum, [], { style: createStyle(false) });
  assert.match(out, /v1\.7 is the first bad release/, "the newest, by elimination");
  assert.match(out, /assumed — it was never installed/);

  // a properly cornered release carries no such caveat
  let proven = bisect.startState({ appId: "demo", artifactId: "a", tags });
  while (!proven.done) proven = bisect.applyVerdict(proven, proven.current >= 2 ? "bad" : "good");
  const provenOut = bisectCli.renderResult(bisect.summary(proven), [], { style: createStyle(false) });
  assert.ok(!/assumed/.test(provenOut));
});

test("cli bisect: status after convergence still prints the answer and its notes", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  await runCli(["bisect", "demo"], runtime);
  await runCli(["bisect", "bad"], runtime);
  await runCli(["bisect", "bad"], runtime);
  await runCli(["bisect", "bad"], runtime);

  const r = await runCli(["bisect", "status"], runtime);
  assert.strictEqual(r.code, cli.EXIT_OK);
  assert.match(r.out, /is the first bad release/);
  assert.match(r.out, /What changed in 1\./, "the notes come with `status` too, not only with the verdict");
});

test("cli bisect: the two non-converging outcomes read as what they are", () => {
  const st = createStyle(false);
  const exhausted = bisectCli.outcomeLines(
    { outcome: "exhausted", loTag: "v1.4", hiTag: "v1.5", firstBad: null },
    st
  ).join("\n");
  assert.match(exhausted, /Only skipped releases are left/);
  assert.match(exhausted, /v1\.4 … v1\.5/);

  const allGood = bisectCli.outcomeLines({ outcome: "all-good", firstBad: null }, st).join("\n");
  assert.match(allGood, /Every release tested good/);
});

/* -------------------------------------------------------------- dispatch */

test("cli bisect: start installs the midpoint and writes the state file", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  const r = await runCli(["bisect", "demo"], runtime);

  assert.strictEqual(r.code, cli.EXIT_OK);
  assert.deepStrictEqual(runtime.calls[0], ["releases", "demo"]);
  assert.deepStrictEqual(
    runtime.calls.find((c) => c[0] === "install"),
    ["install", "demo", "archive-dir-linux", "v1.3"],
    "the midpoint goes through the ordinary installVersion pipeline"
  );
  assert.match(r.out, /testing v1\.3/);
  assert.match(r.err, /bisecting Demo/);

  const state = bisect.read();
  assert.strictEqual(state.appId, "demo");
  assert.strictEqual(state.artifactId, "archive-dir-linux");
  assert.strictEqual(state.tags.length, 8);
  assert.strictEqual(state.lo, 0);
  assert.strictEqual(state.hi, 7);
  assert.strictEqual(state.current, 3);
  assert.deepStrictEqual(state.restore, { version: "1.2", tag: "v1.2" }, "what was installed before the search");
});

test("cli bisect: verdicts narrow, install the next candidate, and converge", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  await runCli(["bisect", "demo"], runtime); // installs v1.3

  const good = await runCli(["bisect", "good"], runtime);
  assert.strictEqual(good.code, cli.EXIT_OK);
  assert.strictEqual(lastInstalled(runtime), "v1.5");
  assert.match(good.out, /testing v1\.5/);

  const bad = await runCli(["bisect", "bad"], runtime);
  assert.strictEqual(lastInstalled(runtime), "v1.4");
  assert.match(bad.out, /testing v1\.4/);

  const done = await runCli(["bisect", "bad"], runtime);
  assert.strictEqual(done.code, cli.EXIT_OK);
  assert.match(done.out, /v1\.4 is the first bad release/);
  assert.match(done.out, /What changed in 1\.4/, "the notes head comes with the answer");
  assert.match(done.out, /nx bisect reset/);
  assert.strictEqual(lastInstalled(runtime), "v1.4", "a converged search installs nothing more");
  assert.ok(bisect.read().done, "the state stays until reset, so `status` still answers");
});

test("cli bisect: skip moves to a neighbour without narrowing", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  await runCli(["bisect", "demo"], runtime); // v1.3

  const skipped = await runCli(["bisect", "skip"], runtime);
  assert.strictEqual(skipped.code, cli.EXIT_OK);
  assert.strictEqual(lastInstalled(runtime), "v1.2", "the nearest untested neighbour");
  const state = bisect.read();
  assert.strictEqual(state.lo, 0, "the window did not move");
  assert.strictEqual(state.hi, 7);
  assert.deepStrictEqual(state.skipped, [3]);
});

test("cli bisect: status is read-only and installs nothing", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  await runCli(["bisect", "demo"], runtime);
  const before = runtime.calls.length;

  const r = await runCli(["bisect", "status"], runtime);
  assert.strictEqual(r.code, cli.EXIT_OK);
  assert.match(r.out, /range\s+v1\.0 … v1\.7/);
  assert.match(r.out, /steps left\s+3/);
  assert.strictEqual(runtime.calls.length, before, "status touched nothing");
});

test("cli bisect: reset reinstalls what was there before, and forgets the search", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();
  await runCli(["bisect", "demo"], runtime);
  await runCli(["bisect", "bad"], runtime);

  const r = await runCli(["bisect", "reset"], runtime);
  assert.strictEqual(r.code, cli.EXIT_OK);
  assert.strictEqual(lastInstalled(runtime), "v1.2", "the version installed before the bisect began");
  assert.match(r.out, /Bisect reset/);
  assert.match(r.out, /back on v1\.2/);
  assert.strictEqual(bisect.read(), null, "the state file is gone");

  const after = await runCli(["bisect", "status"], runtime);
  assert.strictEqual(after.code, cli.EXIT_USER);
  assert.match(after.err, /No bisect in progress/);
});

test("cli bisect: reset uninstalls when nothing was installed to begin with", async (t) => {
  useEnv(t);
  const bare = fx.app({ id: "demo", name: "Demo", artifacts: [fx.artifact({ id: "archive-dir-linux" })] });
  const runtime = fakeRuntime({ apps: async () => [bare] });

  await runCli(["bisect", "demo"], runtime);
  assert.strictEqual(bisect.read().restore, null);

  const r = await runCli(["bisect", "reset"], runtime);
  assert.strictEqual(r.code, cli.EXIT_OK);
  assert.ok(
    runtime.calls.some((c) => c[0] === "uninstall" && c[1] === "demo"),
    "nothing to restore → the bisect's install is removed again"
  );
  assert.match(r.out, /nothing installed/);
  assert.strictEqual(bisect.read(), null);
});

test("cli bisect: --json is the only thing on stdout, at every stage", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();

  const started = await runCli(["bisect", "demo", "--json"], runtime);
  const a = JSON.parse(started.out);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.bisect.current.tag, "v1.3");
  assert.strictEqual(a.bisect.total, 8);
  assert.strictEqual(a.bisect.stepsLeft, 3);

  const status = JSON.parse((await runCli(["bisect", "status", "--json"], runtime)).out);
  assert.strictEqual(status.bisect.loTag, "v1.0");
  assert.strictEqual(status.bisect.hiTag, "v1.7");

  // drive it home and check the terminal payload
  let last = null;
  for (let i = 0; i < 5 && (last === null || !last.bisect.done); i += 1) {
    last = JSON.parse((await runCli(["bisect", "bad", "--json"], runtime)).out);
  }
  assert.strictEqual(last.bisect.done, true);
  assert.strictEqual(last.bisect.outcome, "first-bad");
  assert.strictEqual(last.bisect.firstBad.tag, "v1.0");
  assert.ok(Array.isArray(last.bisect.notes) && last.bisect.notes.length);
});

test("cli bisect: usage errors are exit 1 and never touch the state file", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime();

  const nothing = await runCli(["bisect"], runtime);
  assert.strictEqual(nothing.code, cli.EXIT_USER);
  assert.match(nothing.err, /Name an app to bisect/);

  const unknown = await runCli(["bisect", "no-such-app"], runtime);
  assert.strictEqual(unknown.code, cli.EXIT_USER);
  assert.match(unknown.err, /No app matches/);

  const noState = await runCli(["bisect", "good"], runtime);
  assert.strictEqual(noState.code, cli.EXIT_USER);
  assert.match(noState.err, /No bisect in progress/);

  assert.strictEqual(bisect.read(), null);
});

test("cli bisect: an app with fewer than two releases cannot be bisected", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime({ releases: async () => releases().slice(0, 1) });
  const r = await runCli(["bisect", "demo"], runtime);
  assert.strictEqual(r.code, cli.EXIT_USER);
  assert.match(r.err, /1 bisectable release/);
  assert.strictEqual(bisect.read(), null, "no half-started search left behind");
});

test("cli bisect: prereleases join the search only when they are opted into", async (t) => {
  useEnv(t);
  const withPre = releases().concat({
    tag: "v2.0-rc1",
    version: "2.0-rc1",
    publishedAt: "2026-09-01T00:00:00Z",
    prerelease: true,
    notes: "",
  });

  const plain = fakeRuntime({ releases: async () => withPre });
  await runCli(["bisect", "demo"], plain);
  assert.strictEqual(bisect.read().tags.length, 8, "the rc is out by default");
  bisect.clear();

  const all = fakeRuntime({ releases: async () => withPre });
  await runCli(["bisect", "demo", "--all"], all);
  assert.strictEqual(bisect.read().tags.length, 9, "--all lets prereleases in");
});

test("cli bisect: a job failure surfaces as exit 2, with the state kept", async (t) => {
  useEnv(t);
  const runtime = fakeRuntime({
    install: async () => {
      const e = new Error("download failed");
      e.operational = true;
      throw e;
    },
  });
  const r = await runCli(["bisect", "demo"], runtime);
  assert.strictEqual(r.code, cli.EXIT_FAIL, "an operation that failed is not a usage error");
  assert.match(r.err, /download failed/);
  assert.ok(bisect.read(), "the search is still there to retry or reset");
});
