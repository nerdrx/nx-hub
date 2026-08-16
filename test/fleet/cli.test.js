"use strict";
// `nx fleet …` — the pure renderers, the peer matcher, and a real end-to-end
// pass against a live fleet hub on loopback.
//
// The CLI's whole premise is that it needs no local hub, so these tests never
// start one: they stand up ONE fleet (the "other machine") and drive the CLI
// against it with its own temp fleet.json.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");
const cli = require("../../src/cli/index");
const render = require("../../src/cli/render");
const { matchPeer } = require("../../src/cli/match");
const { createStyle } = require("../../src/cli/ansi");
const { createFleetCli } = require("../../src/cli/fleet");

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

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

const plain = createStyle(false);

/* ------------------------------------------------------------------ */
/* pure rendering                                                      */
/* ------------------------------------------------------------------ */

const ROWS = [
  {
    id: "ffffffffffffffff",
    name: "workshop",
    host: "192.168.1.20",
    port: 9023,
    online: true,
    hubVersion: "0.6.0",
    error: null,
    updates: 2,
    apps: [
      { id: "wivrn-nx", name: "WiVRn NX", latest: "0.6.1", updates: 1, installed: [{ artifactId: "linux", label: "Linux app", version: "0.6.0" }] },
      { id: "pulsenx", name: "PulseNX", latest: "1.2.0", updates: 1, installed: [{ artifactId: "linux", label: "Linux app", version: "1.1.0" }] },
    ],
  },
  {
    id: "0000000000000000",
    name: "laptop",
    host: "192.168.1.31",
    port: 9023,
    online: false,
    hubVersion: null,
    error: "fleet: 192.168.1.31:9023 did not answer",
    updates: 0,
    apps: [],
  },
];

test("renderFleet lays out name, host, state, hub version and update counts", () => {
  const text = render.renderFleet(ROWS, { style: plain, identity: { id: "abcdef0123456789", name: "bench" } });
  assert.match(text, /this hub\s+bench/);
  assert.match(text, /NAME\s+HOST\s+STATE\s+HUB\s+UPD\s+APPS/);
  assert.match(text, /workshop\s+192\.168\.1\.20\s+online\s+0\.6\.0\s+2/);
  assert.match(text, /laptop\s+192\.168\.1\.31\s+offline/);
  // The glyph vocabulary matches `nx list`: ↑ pending, ✓ current, · silent.
  assert.match(text, /↑\s+workshop/);
  assert.match(text, /·\s+laptop/);
  // A peer that would not answer says why, once, dimly.
  assert.match(text, /laptop: fleet: 192\.168\.1\.31:9023 did not answer/);
  assert.doesNotMatch(text, /\[/, "--plain output carries no escapes");
});

test("renderFleet marks a reachable, up-to-date peer with the ✓ glyph", () => {
  const rows = [Object.assign({}, ROWS[0], { updates: 0, apps: [ROWS[0].apps[0]] })];
  const text = render.renderFleet(rows, { style: plain });
  assert.match(text, /✓\s+workshop/);
});

test("renderFleet has an empty state that tells you what to do next", () => {
  const text = render.renderFleet([], { style: plain });
  assert.match(text, /No paired hubs yet/);
  assert.match(text, /nx fleet pair <host>/);
});

test("renderFleet survives junk without throwing", () => {
  for (const input of [null, undefined, [], [{}]]) {
    assert.strictEqual(typeof render.renderFleet(input, { style: plain }), "string");
  }
});

test("fleetAppSummary lists the installed versions and caps the tail", () => {
  assert.strictEqual(render.fleetAppSummary(ROWS[0]), "wivrn-nx 0.6.0 ↑, pulsenx 1.1.0 ↑");
  assert.strictEqual(render.fleetAppSummary(ROWS[1]), "");
  const many = { apps: Array.from({ length: 6 }, (_, i) => ({ id: `app${i}`, installed: [], updates: 0 })) };
  assert.strictEqual(render.fleetAppSummary(many), "app0, app1, app2, +3");
});

test("fleetJson is stable, plain and carries no secrets", () => {
  const json = render.fleetJson(ROWS, { identity: { id: "abcdef0123456789", name: "bench" } });
  assert.deepStrictEqual(json.hub, { id: "abcdef0123456789", name: "bench" });
  assert.strictEqual(json.peers.length, 2);
  assert.strictEqual(json.peers[0].updates, 2);
  assert.strictEqual(json.peers[0].apps[0].installed[0].version, "0.6.0");
  assert.strictEqual(json.peers[1].online, false);
  // Round-trips through JSON, and never mentions a secret.
  const text = JSON.stringify(json);
  assert.deepStrictEqual(JSON.parse(text), json);
  assert.doesNotMatch(text, /secret/i);
});

test("renderFleetEvent words progress, success and failure differently", () => {
  const progress = render.renderFleetEvent(
    { event: "job-progress", appId: "wivrn-nx", artifactId: "linux", phase: "download", pct: 42.4, message: "42%" },
    { style: plain }
  );
  assert.match(progress, /wivrn-nx\/linux/);
  assert.match(progress, /download/);
  assert.match(progress, /42%/);

  assert.match(render.renderFleetEvent({ event: "job-done", appId: "wivrn-nx", message: "Installed" }, { style: plain }), /✓/);
  assert.match(render.renderFleetEvent({ event: "job-error", appId: "wivrn-nx", message: "boom" }, { style: plain }), /✗/);
  assert.strictEqual(typeof render.renderFleetEvent(null, { style: plain }), "string");
});

/* ------------------------------------------------------------------ */
/* peer matching                                                       */
/* ------------------------------------------------------------------ */

const PEERS = [
  { id: "ffffffffffffffff", name: "workshop", host: "192.168.1.20" },
  { id: "0000000000000000", name: "workbench", host: "192.168.1.31" },
  { id: "1111111111111111", name: "laptop", host: "10.0.0.7" },
];

test("matchPeer resolves by id, name, host, prefix and substring", () => {
  assert.strictEqual(matchPeer(PEERS, "laptop").peer.id, "1111111111111111");
  assert.strictEqual(matchPeer(PEERS, "LAPTOP").peer.id, "1111111111111111", "case-insensitive");
  assert.strictEqual(matchPeer(PEERS, "ffffffffffffffff").peer.name, "workshop");
  assert.strictEqual(matchPeer(PEERS, "10.0.0.7").peer.name, "laptop");
  assert.strictEqual(matchPeer(PEERS, "lap").peer.name, "laptop", "unambiguous prefix");
  assert.strictEqual(matchPeer(PEERS, "0.0.7").peer.name, "laptop", "unambiguous substring");
});

test("matchPeer refuses an ambiguous or absent peer with a usable message", () => {
  const ambiguous = matchPeer(PEERS, "work");
  assert.strictEqual(ambiguous.peer, null);
  assert.strictEqual(ambiguous.candidates.length, 2);
  assert.match(ambiguous.error, /matches 2 peers/);

  const missing = matchPeer(PEERS, "attic");
  assert.strictEqual(missing.peer, null);
  assert.deepStrictEqual(missing.candidates, []);
  assert.match(missing.error, /No paired hub called "attic"/);

  assert.match(matchPeer(PEERS, "").error, /Name a peer/);
  assert.match(matchPeer(null, "x").error, /No paired hub/);
});

/* ------------------------------------------------------------------ */
/* end to end, against a live hub                                      */
/* ------------------------------------------------------------------ */

/** A CLI fleet client with its own fleet.json, plus a peer hub to talk to. */
async function cliAgainstHub({ apps = [], jobs = null } = {}) {
  const jobsB = jobs || h.fakeJobs();
  const hub = await h.startFleet({ discovery: h.fakeDiscovery(apps), jobs: jobsB });
  const fleet = createFleetCli({ dataDir: h.tempDataDir("nxhub-fleetcli-") });
  return { hub, fleet, jobsB };
}

/** Run the CLI with fake streams and the injected fleet client. */
async function runCli(argv, { fleet, prompt } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    fleet,
    prompt: prompt || (async () => ""),
    stdout,
    stderr,
    color: false,
    confirm: async () => true,
  });
  return { code, out: stdout.text, err: stderr.text };
}

test("`nx fleet pair` reads the code from stdin and stores the peer", async () => {
  const { hub, fleet } = await cliAgainstHub();
  const { code } = hub.showCode();

  const asked = [];
  const result = await runCli(["fleet", "pair", "127.0.0.1", "--port", String(hub.server.port)], {
    fleet,
    prompt: async (question) => {
      asked.push(question);
      return `${code}\n`;
    },
  });

  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(asked, ["code: "], "the code is prompted for, never an argument");
  assert.match(result.out, /Paired with/);
  assert.match(result.err, /six-digit code/);

  const stored = fleet.peers();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].id, hub.localId);
  assert.strictEqual(stored[0].port, hub.server.port);
  // The other side stored us too, learning the host from the socket.
  assert.ok(hub.store.getPeer(fleet.identity().id));
});

test("`nx fleet pair` rejects a code that is not six digits, without dialling", async () => {
  const { hub, fleet } = await cliAgainstHub();
  hub.showCode();
  const result = await runCli(["fleet", "pair", "127.0.0.1", "--port", String(hub.server.port)], {
    fleet,
    prompt: async () => "12ab",
  });
  assert.strictEqual(result.code, 1, "a user error, not an operation failure");
  assert.match(result.err, /six digits/);
  assert.strictEqual(fleet.peers().length, 0);
});

test("`nx fleet pair` reports a wrong code as an operation failure", async () => {
  const { hub, fleet } = await cliAgainstHub();
  hub.showCode();
  const result = await runCli(["fleet", "pair", "127.0.0.1", "--port", String(hub.server.port)], {
    fleet,
    prompt: async () => "000000",
  });
  assert.strictEqual(result.code, 2);
  assert.match(result.err, /not right/);
  assert.strictEqual(fleet.peers().length, 0);
});

test("`nx fleet ls --json` reports the live peer's apps and update count", async () => {
  const apps = [
    h.app("wivrn-nx", { name: "WiVRn NX", artifacts: [{ id: "linux", installed: { version: "0.6.0" }, updateAvailable: true }] }),
    h.app("facenx", { artifacts: [{ id: "linux", installed: { version: "1.2.0" } }] }),
  ];
  const { hub, fleet } = await cliAgainstHub({ apps });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const result = await runCli(["fleet", "ls", "--json"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  const json = JSON.parse(result.out);
  assert.strictEqual(json.peers.length, 1);
  const peer = json.peers[0];
  assert.strictEqual(peer.online, true);
  assert.strictEqual(peer.id, hub.localId);
  assert.strictEqual(peer.hubVersion, "9.9.9");
  assert.strictEqual(peer.updates, 1);
  assert.deepStrictEqual(
    peer.apps.map((a) => a.id),
    ["facenx", "wivrn-nx"]
  );
  assert.doesNotMatch(result.out, /secret/i, "fleet.json's secrets never reach stdout");
});

test("`nx fleet ls` renders the same peer as a table", async () => {
  const apps = [h.app("wivrn-nx", { name: "WiVRn NX", artifacts: [{ id: "linux", installed: { version: "0.6.0" } }] })];
  const { hub, fleet } = await cliAgainstHub({ apps });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const result = await runCli(["fleet", "ls", "--plain"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.out, /online/);
  assert.match(result.out, /wivrn-nx 0\.6\.0/);
});

test("`nx fleet ls` shows a peer that has gone away as offline, with the reason", async () => {
  const { hub, fleet } = await cliAgainstHub();
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);
  await hub.close();

  const result = await runCli(["fleet", "ls", "--json"], { fleet });
  assert.strictEqual(result.code, 0);
  const json = JSON.parse(result.out);
  assert.strictEqual(json.peers[0].online, false);
  assert.ok(json.peers[0].error, "the dial failure is reported, not swallowed");
});

test("`nx fleet install` enqueues on the peer and follows the job to the end", async () => {
  const apps = [h.app("wivrn-nx", { name: "WiVRn NX", artifacts: [{ id: "linux", updateAvailable: true }] })];
  const { hub, fleet, jobsB } = await cliAgainstHub({ apps });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  // The peer's job finishes as soon as it starts — drive its fan-out by hand.
  const originalInstall = jobsB.install;
  jobsB.install = (appId, artifactId) => {
    const jobId = originalInstall.call(jobsB, appId, artifactId);
    setTimeout(() => {
      hub.onHubEvent({ type: "job-progress", jobId, appId, artifactId, phase: "download", pct: 50, message: "50%" });
      hub.onHubEvent({ type: "job-done", jobId, appId, artifactId, message: `Installed ${appId}` });
    }, 10);
    return jobId;
  };

  const result = await runCli(["fleet", "install", hub.localId, "wivrn-nx", "--plain"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(jobsB.calls, [{ kind: "install", appId: "wivrn-nx", artifactId: "linux", jobId: "job-1" }]);
  assert.match(result.err, /installing wivrn-nx/);
  assert.match(result.err, /download/, "relayed progress goes to stderr");
  assert.match(result.out, /WiVRn NX installed on/);
});

test("`nx fleet install` exits 2 when the remote job fails", async () => {
  const apps = [h.app("wivrn-nx", { artifacts: [{ id: "linux" }] })];
  const { hub, fleet, jobsB } = await cliAgainstHub({ apps });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const originalInstall = jobsB.install;
  jobsB.install = (appId, artifactId) => {
    const jobId = originalInstall.call(jobsB, appId, artifactId);
    setTimeout(() => hub.onHubEvent({ type: "job-error", jobId, appId, artifactId, message: "no disk space" }), 10);
    return jobId;
  };

  const result = await runCli(["fleet", "install", hub.localId, "wivrn-nx", "--plain"], { fleet });
  assert.strictEqual(result.code, 2);
  assert.match(result.err, /no disk space/);
});

test("`nx fleet install` refuses an app the peer does not have", async () => {
  const { hub, fleet } = await cliAgainstHub({ apps: [h.app("facenx", { artifacts: [{ id: "linux" }] })] });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const result = await runCli(["fleet", "install", hub.localId, "wivrn-nx"], { fleet });
  assert.strictEqual(result.code, 2);
  assert.match(result.err, /No app called "wivrn-nx"/);
});

test("`nx fleet update` installs every pending update on the peer", async () => {
  const apps = [
    h.app("wivrn-nx", { artifacts: [{ id: "linux", updateAvailable: true }] }),
    h.app("pulsenx", { artifacts: [{ id: "linux", updateAvailable: true }] }),
    h.app("facenx", { artifacts: [{ id: "linux" }] }),
  ];
  const { hub, fleet, jobsB } = await cliAgainstHub({ apps });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const originalInstall = jobsB.install;
  jobsB.install = (appId, artifactId) => {
    const jobId = originalInstall.call(jobsB, appId, artifactId);
    setTimeout(() => hub.onHubEvent({ type: "job-done", jobId, appId, artifactId, message: `Installed ${appId}` }), 10);
    return jobId;
  };

  const result = await runCli(["fleet", "update", hub.localId, "--plain"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(jobsB.calls.length, 2);
  assert.match(result.out, /2 updates installed/);
});

test("`nx fleet update` says so when the peer has nothing pending", async () => {
  const { hub, fleet } = await cliAgainstHub({ apps: [h.app("facenx", { artifacts: [{ id: "linux" }] })] });
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);

  const result = await runCli(["fleet", "update", hub.localId, "--plain"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.out, /is up to date/);
});

test("`nx fleet unpair` forgets the peer", async () => {
  const { hub, fleet } = await cliAgainstHub();
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);
  assert.strictEqual(fleet.peers().length, 1);

  const result = await runCli(["fleet", "unpair", hub.localId, "-y", "--plain"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.out, /Forgot/);
  assert.strictEqual(fleet.peers().length, 0);
});

test("an unknown fleet subcommand and an unknown peer are user errors", async () => {
  const { fleet } = await cliAgainstHub();
  const bad = await runCli(["fleet", "teleport"], { fleet });
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /unknown fleet command "teleport"/);

  const missing = await runCli(["fleet", "install", "nowhere", "wivrn-nx"], { fleet });
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /No paired hub called "nowhere"/);
});

test("`nx fleet install` without an app name is a user error", async () => {
  const { hub, fleet } = await cliAgainstHub();
  const { code } = hub.showCode();
  await fleet.pair("127.0.0.1", code, hub.server.port);
  const result = await runCli(["fleet", "install", hub.localId], { fleet });
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /Name an app/);
});

test("the CLI mints a hub id when this machine has never run one", () => {
  const fleet = createFleetCli({ dataDir: h.tempDataDir("nxhub-fleetcli-") });
  const me = fleet.identity();
  assert.match(me.id, /^[0-9a-f]{16}$/);
  assert.ok(me.name);
  // Persisted, so the hub and the CLI can never disagree about who we are.
  assert.strictEqual(createFleetCli({ dataDir: fleet.store.dir }).identity().id, me.id);
});

/* ------------------------------------------------------------------ */
/* v0.7: `nx fleet wake`                                               */
/* ------------------------------------------------------------------ */

test("fleet.wake sends the magic packets straight out of fleet.json", async () => {
  const dgram = require("node:dgram");
  const wol = require("../../src/main/fleet/wol");
  const sink = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const packets = [];
  sink.on("message", (m) => packets.push(Buffer.from(m)));
  const port = await new Promise((r) => sink.bind(0, "127.0.0.1", () => r(sink.address().port)));

  try {
    const fleet = createFleetCli({ dataDir: h.tempDataDir("nxhub-fleetcli-") });
    // Exactly what a paired-then-connected peer looks like on disk.
    fleet.store.upsertPeer({
      id: "abcdef0123456789",
      name: "workshop",
      host: "192.168.1.20",
      port: 9023,
      secret: "a".repeat(64),
      mac: "AA:BB:CC:DD:EE:FF",
    });
    const peer = fleet.peers()[0];
    assert.strictEqual(peer.mac, "aa:bb:cc:dd:ee:ff", "stored lowercase, whatever the ARP cache spelled");

    const result = await fleet.wake(peer, { address: "127.0.0.1", ports: [port] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mac, "aa:bb:cc:dd:ee:ff");

    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(packets.length, 3);
    assert.deepStrictEqual(packets[0], wol.magicPacket("aa:bb:cc:dd:ee:ff"));
  } finally {
    sink.close();
  }
});

test("fleet.wake needs a MAC, and says which of the two things went wrong", async () => {
  const fleet = createFleetCli({ dataDir: h.tempDataDir("nxhub-fleetcli-") });
  fleet.store.upsertPeer({
    id: "abcdef0123456789",
    name: "workshop",
    host: "192.168.1.20",
    port: 9023,
    secret: "a".repeat(64),
  });
  assert.deepStrictEqual(await fleet.wake(fleet.peers()[0]), {
    ok: false,
    sent: false,
    mac: null,
    reason: "no-mac",
  });
  assert.strictEqual((await fleet.wake(null)).reason, "unknown-peer");
});

/** A CLI fleet-client double: peers on disk, wake without any datagrams. */
function wakeStub({ mac = "aa:bb:cc:dd:ee:ff", ok = true } = {}) {
  const calls = [];
  return {
    calls,
    identity: () => ({ id: "0".repeat(16), name: "here" }),
    peers: () => [{ id: "abcdef0123456789", name: "workshop", host: "192.168.1.20", port: 9023, mac }],
    wake(peer) {
      calls.push(peer.id);
      if (!mac) return Promise.resolve({ ok: false, sent: false, mac: null, reason: "no-mac" });
      return Promise.resolve({ ok, sent: ok, mac, reason: ok ? null : "send-failed" });
    },
  };
}

test("`nx fleet wake <peer>` matches the peer by name and reports the MAC", async () => {
  const fleet = wakeStub();
  const result = await runCli(["fleet", "wake", "work"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(fleet.calls, ["abcdef0123456789"], "the prefix matcher found it");
  assert.match(result.out, /Woke workshop/);
  assert.match(result.out, /aa:bb:cc:dd:ee:ff/);
  assert.match(result.out, /nx fleet ls/, "and it says how to check whether it worked");
});

test("`nx fleet wake --json` is the only thing on stdout", async () => {
  const fleet = wakeStub();
  const result = await runCli(["fleet", "wake", "workshop", "--json"], { fleet });
  assert.strictEqual(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.id, "abcdef0123456789");
  assert.strictEqual(parsed.name, "workshop");
  assert.strictEqual(parsed.mac, "aa:bb:cc:dd:ee:ff");
});

test("`nx fleet wake` on a peer with no MAC exits 2 and explains itself", async () => {
  const fleet = wakeStub({ mac: null });
  const result = await runCli(["fleet", "wake", "workshop"], { fleet });
  assert.strictEqual(result.code, 2, "an operation failure, not a usage error");
  assert.match(result.out, /No hardware address/);
  assert.match(result.out, /while it is awake/, "and how to fix it");
});

test("`nx fleet wake` reports a send that did not go out", async () => {
  const fleet = wakeStub({ ok: false });
  const result = await runCli(["fleet", "wake", "workshop"], { fleet });
  assert.strictEqual(result.code, 2);
  assert.match(result.out, /Could not send the wake packets/);
});

test("`nx fleet wake` still needs to know WHICH peer", async () => {
  const fleet = wakeStub();
  const result = await runCli(["fleet", "wake", "nowhere"], { fleet });
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /No paired hub called "nowhere"/);
  assert.deepStrictEqual(fleet.calls, [], "nothing is woken on a guess");
});

test("`nx help` lists wake among the fleet subcommands", () => {
  const text = render.renderHelp({ style: plain, version: "0.7.0" });
  assert.match(text, /wake <peer>/);
});
