"use strict";
// `nx status` and `nx stack` — the v0.5 CLI surface. Rendering is pure (model
// in, string out, plain and styled), dispatch runs against a faked runtime so
// this stays about the CLI's own decisions and its exit codes.

const test = require("node:test");
const assert = require("node:assert");

const cli = require("../../src/cli/index");
const render = require("../../src/cli/render");
const { matchStack } = require("../../src/cli/match");
const { createStyle, strip, PALETTE } = require("../../src/cli/ansi");

const plain = createStyle(false);
const color = createStyle(true);
const VIOLET = `38;2;${PALETTE.violet.join(";")}`;

const NOW = Date.parse("2026-08-16T12:00:00Z");

const STATUS_ONLINE = {
  host: "127.0.0.1",
  port: 9021,
  listening: true,
  online: true,
  stale: false,
  snapshotPath: "/tmp/data/connector-clients.json",
  snapshotExists: true,
  ts: "2026-08-16T11:59:58Z",
  ageMs: 2000,
  clients: [
    { app: "pulsenx", version: "1.2.1", pid: 4242, since: "2026-08-16T11:12:00Z", fields: { hr: 72, connected: true } },
    { app: "wivrn-nx", version: "1.4.0", pid: 91, since: "2026-08-16T11:58:00Z", fields: { fps: 90 } },
  ],
  fieldDefs: {
    pulsenx: [
      { key: "hr", label: "Heart rate", unit: "bpm", kind: "number" },
      { key: "connected", label: "Band", kind: "bool" },
    ],
  },
};

const STATUS_OFFLINE = {
  host: "127.0.0.1",
  port: 9021,
  listening: false,
  online: false,
  stale: true,
  snapshotPath: "/tmp/data/connector-clients.json",
  snapshotExists: false,
  ts: null,
  ageMs: null,
  clients: [],
  fieldDefs: {},
};

const STACKS = [
  {
    id: "vr",
    name: "VR Session",
    steps: [
      { appId: "wivrn-nx", artifactId: "server-linux", health: { type: "port", port: 9757, timeoutMs: 30000 }, optional: false },
      { appId: "pulsenx", artifactId: null, health: { type: "connector", timeoutMs: 15000 }, optional: false },
      { appId: "ogb", artifactId: null, health: { type: "delay", timeoutMs: 2000 }, optional: true },
    ],
  },
  { id: "audio", name: "Audio only", steps: [{ appId: "ogb", artifactId: null, health: { type: "delay", timeoutMs: 0 }, optional: false }] },
];

/* ------------------------------------------------------------ render */

test("cli/render: status shows the bus, the clients and their formatted fields", () => {
  const out = render.renderStatus(STATUS_ONLINE, { style: plain, now: NOW });
  assert.match(out, /C O N N E C T O R/, "uppercase wide-tracked section label");
  assert.match(out, /bus\s+127\.0\.0\.1:9021\s+online/);
  const pulse = out.split("\n").find((l) => l.includes("pulsenx"));
  // app · version · uptime · pid · the overlay-formatted status
  assert.match(pulse, /·\s+pulsenx\s+1\.2\.1\s+48m\s+4242\s+72 bpm · on$/);
  const wivrn = out.split("\n").find((l) => l.includes("wivrn-nx"));
  assert.match(wivrn, /fps: 90$/, "an app with no field definitions renders key: value");
  assert.ok(!/\p{Extended_Pictographic}/u.test(out), "no emoji anywhere");
});

test("cli/render: status says plainly when no hub is running", () => {
  const out = render.renderStatus(STATUS_OFFLINE, { style: plain, now: NOW });
  assert.match(out, /offline — no hub is running/);
  assert.match(out, /Start NX Hub to bring the bus up/);
  assert.match(out, /not written yet/);
});

test("cli/render: a listening bus with a stale snapshot is called out", () => {
  const out = render.renderStatus(
    Object.assign({}, STATUS_ONLINE, { online: false, stale: true, ageMs: 300000 }),
    { style: plain, now: NOW }
  );
  assert.match(out, /listening, but the hub published no fresh client list/);
  assert.match(out, /this list is stale/);
});

test("cli/render: status is violet-headed and cyan-valued when colour is on", () => {
  const out = render.renderStatus(STATUS_ONLINE, { style: color, now: NOW });
  assert.ok(out.includes(VIOLET), "the section label is violet");
  assert.match(strip(out), /pulsenx/, "stripping the escapes gives the plain rendering back");
});

test("cli/render: statusJson is the machine-readable twin", () => {
  const json = render.statusJson(STATUS_ONLINE, { now: NOW });
  assert.strictEqual(json.ok, true);
  assert.deepStrictEqual(json.bus, {
    host: "127.0.0.1",
    port: 9021,
    listening: true,
    online: true,
    stale: false,
    snapshot: "/tmp/data/connector-clients.json",
    snapshotAgeMs: 2000,
    ts: "2026-08-16T11:59:58Z",
  });
  assert.strictEqual(json.clients.length, 2);
  assert.strictEqual(json.clients[0].app, "pulsenx");
  assert.strictEqual(json.clients[0].uptimeMs, 48 * 60 * 1000);
  assert.deepStrictEqual(json.clients[0].fields, { hr: 72, connected: true });
  assert.strictEqual(render.statusJson(STATUS_OFFLINE).ok, false);
});

test("cli/render: durations are locale-independent and coarse", () => {
  assert.strictEqual(render.fmtDuration(0), "0s");
  assert.strictEqual(render.fmtDuration(42_000), "42s");
  assert.strictEqual(render.fmtDuration(12 * 60_000), "12m");
  assert.strictEqual(render.fmtDuration(3 * 3600_000 + 4 * 60_000), "3h 04m");
  assert.strictEqual(render.fmtDuration(51 * 3600_000), "2d 3h");
  assert.strictEqual(render.fmtDuration(null), "—");
  assert.strictEqual(render.sinceMs("nonsense"), null);
});

test("cli/render: stack ls lists the flow and each step's health rule", () => {
  const out = render.renderStacks(STACKS, { style: plain });
  assert.match(out, /S T A C K S/);
  const row = out.split("\n").find((l) => l.includes("VR Session") && l.includes("→"));
  assert.match(row, /vr\s+VR Session\s+3\s+wivrn-nx → pulsenx → ogb\?/, "optional steps are marked with ?");
  assert.match(out, /1 wivrn-nx \/ server-linux port 9757/);
  assert.match(out, /2 pulsenx connector/);
  assert.match(out, /3 ogb wait 2s optional/);
  assert.match(out, /nx stack run <id>/);
});

test("cli/render: stack ls has something to say with no stacks at all", () => {
  const out = render.renderStacks([], { style: plain });
  assert.match(out, /No stacks yet/);
  assert.deepStrictEqual(render.stacksJson(STACKS).stacks.map((s) => s.id), ["vr", "audio"]);
});

test("cli/render: every stack-progress phase renders as one line", () => {
  const line = (evt) => render.renderStackPhase(evt, { style: plain });
  assert.strictEqual(line({ stepIndex: 0, appId: "wivrn-nx", phase: "launching" }), "   1 launching wivrn-nx");
  assert.strictEqual(line({ stepIndex: 1, appId: "pulsenx", phase: "waiting", health: "connector" }), "   2 waiting   pulsenx (connector)");
  assert.strictEqual(line({ stepIndex: 1, appId: "pulsenx", phase: "healthy" }), "   2 healthy   pulsenx");
  assert.strictEqual(
    line({ stepIndex: 1, appId: "pulsenx", phase: "failed", message: "no bus" }),
    "   2 failed    pulsenx — no bus"
  );
  assert.strictEqual(line({ stepIndex: 0, appId: "ogb", phase: "stopped", how: "sigterm" }), "   1 stopped   ogb (sigterm)");
  // the run's own verdict carries no step index
  assert.strictEqual(line({ stepIndex: null, appId: null, phase: "done" }), "  ✓ done      stack up");
  assert.strictEqual(line({ stepIndex: null, appId: "pulsenx", phase: "failed", message: "gave up" }), "  ✗ failed    pulsenx — gave up");
  for (const phase of ["launching", "waiting", "healthy", "failed", "done", "stopping", "stopped"]) {
    assert.ok(render.PHASE_PAINT[phase], `phase ${phase} has no paint`);
  }
});

/* ------------------------------------------------------------- match */

test("cli/match: stacks resolve by id, name and unambiguous prefix", () => {
  assert.strictEqual(matchStack(STACKS, "vr").stack.id, "vr");
  assert.strictEqual(matchStack(STACKS, "VR Session").stack.id, "vr");
  assert.strictEqual(matchStack(STACKS, "au").stack.id, "audio");
  const none = matchStack(STACKS, "zzz");
  assert.strictEqual(none.stack, null);
  assert.match(none.error, /No stack called "zzz"/);
  const ambiguous = matchStack([{ id: "a-one", name: "A one" }, { id: "a-two", name: "A two" }], "a-");
  assert.strictEqual(ambiguous.stack, null);
  assert.match(ambiguous.error, /matches 2 stacks/);
  assert.match(matchStack(STACKS, "").error, /Name a stack/);
});

/* ---------------------------------------------------------- dispatch */

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

function fakeRuntime(over = {}) {
  const calls = [];
  const listeners = new Set();
  const base = {
    calls,
    listeners,
    hubVersion: () => "0.5.0",
    boot() {},
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(evt) {
      for (const fn of [...listeners]) fn(evt);
    },
    apps: async (opts) => {
      calls.push(["apps", opts || {}]);
      return [];
    },
    connectorStatus: async () => {
      calls.push(["connectorStatus"]);
      return STATUS_ONLINE;
    },
    stackList: () => {
      calls.push(["stackList"]);
      return STACKS;
    },
    runStack: async (id) => {
      calls.push(["runStack", id]);
      return { ok: true, stackId: id, started: [] };
    },
    stopStack: async (id) => {
      calls.push(["stopStack", id]);
      return { ok: true, stackId: id, stopped: [{ stepIndex: 0, appId: "wivrn-nx", pid: 12, how: "shutdown-request" }] };
    },
  };
  return Object.assign(base, over);
}

async function runCli(argv, { runtime = fakeRuntime() } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, { runtime, stdout, stderr, env: { NO_COLOR: "1" }, platform: "linux" });
  return { code, out: stdout.text, err: stderr.text, runtime };
}

test("cli: `nx status` asks the bus and prints the client table", async () => {
  const { code, out, runtime } = await runCli(["status"]);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(runtime.calls, [["connectorStatus"]]);
  assert.match(out, /pulsenx/);
  assert.match(out, /72 bpm/);
});

test("cli: `nx status --json` puts nothing but json on stdout", async () => {
  const { code, out } = await runCli(["status", "--json"]);
  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.bus.port, 9021);
  assert.strictEqual(parsed.clients[0].app, "pulsenx");
});

test("cli: `status` is the connector view now, not an alias for doctor", () => {
  assert.strictEqual(cli.ALIASES.status, undefined);
  assert.strictEqual(cli.ALIASES.stacks, "stack");
  assert.ok(render.COMMANDS.some(([c]) => c === "status"), "help lists status");
  assert.ok(render.COMMANDS.some(([c]) => c === "stack"), "help lists stack");
});

test("cli: `nx stack ls` renders the stacks, bare `nx stack` does the same", async () => {
  const bare = await runCli(["stack"]);
  assert.strictEqual(bare.code, 0);
  assert.match(bare.out, /VR Session/);

  const ls = await runCli(["stack", "ls", "--json"]);
  assert.deepStrictEqual(JSON.parse(ls.out).stacks.map((s) => s.id), ["vr", "audio"]);
});

test("cli: `nx stack run` streams the phases and exits 0 when the stack comes up", async () => {
  const runtime = fakeRuntime();
  runtime.runStack = async (id) => {
    runtime.calls.push(["runStack", id]);
    runtime.emit({ type: "stack-progress", stackId: id, stepIndex: 0, appId: "wivrn-nx", phase: "launching" });
    runtime.emit({ type: "stack-progress", stackId: id, stepIndex: 0, appId: "wivrn-nx", phase: "healthy" });
    runtime.emit({ type: "stack-progress", stackId: "other", stepIndex: 0, appId: "nope", phase: "failed" });
    runtime.emit({ type: "job-progress", stackId: id }); // not ours either
    runtime.emit({ type: "stack-progress", stackId: id, stepIndex: null, appId: null, phase: "done" });
    return { ok: true, stackId: id, started: [] };
  };

  const { code, out, err } = await runCli(["stack", "run", "vr"], { runtime });
  assert.strictEqual(code, 0);
  assert.ok(
    runtime.calls.some(([name]) => name === "apps"),
    "the catalogue is loaded first — steps may name no artifact"
  );
  assert.match(err, /launching wivrn-nx/);
  assert.match(err, /healthy   wivrn-nx/);
  assert.ok(!err.includes("nope"), "another stack's events are not ours to print");
  assert.match(out, /VR Session is up/);
  assert.strictEqual(runtime.listeners.size, 0, "the listener is always detached again");
});

test("cli: a stack that fails exits 2 and says why", async () => {
  const runtime = fakeRuntime({
    runStack: async (id) => ({ ok: false, stackId: id, failed: { stepIndex: 1, appId: "pulsenx", message: "the connector bus is not running" } }),
  });
  const { code, out } = await runCli(["stack", "run", "vr"], { runtime });
  assert.strictEqual(code, 2);
  assert.match(out, /VR Session — the connector bus is not running/);
});

test("cli: `nx stack stop` reports what it stopped, and how", async () => {
  const { code, out } = await runCli(["stack", "stop", "vr"]);
  assert.strictEqual(code, 0);
  assert.match(out, /stopped\s+wivrn-nx \(shutdown-request\)/);
  assert.match(out, /Stopped VR Session/);
});

test("cli: stopping a stack that is not running is not an error", async () => {
  const runtime = fakeRuntime({ stopStack: async () => ({ ok: false, stackId: "vr", stopped: [], reason: "that stack is not running" }) });
  const { code, err } = await runCli(["stack", "stop", "vr"], { runtime });
  assert.strictEqual(code, 0);
  assert.match(err, /that stack is not running/);
});

test("cli: unknown stacks and unknown subcommands are user errors (exit 1)", async () => {
  const missing = await runCli(["stack", "run", "zzz"]);
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /No stack called "zzz"/);

  const sub = await runCli(["stack", "frobnicate"]);
  assert.strictEqual(sub.code, 1);
  assert.match(sub.err, /unknown stack command/);
  assert.match(sub.err, /nx stack ls \| run <id> \| stop <id>/);

  const noId = await runCli(["stack", "run"]);
  assert.strictEqual(noId.code, 1);
  assert.match(noId.err, /Name a stack/);
});
