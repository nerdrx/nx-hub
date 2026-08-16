"use strict";
// v0.7 [fleet-fabric]: MAC capture, wake-on-LAN, and the two messages
// cross-hub stacks need — `probe`/`probe-result` and `stop`.
//
// Everything runs over REAL paired sessions on 127.0.0.1 with ephemeral ports.
// The three things that would otherwise touch the outside world are injected:
// the ARP lookup (a function, not /proc), the WOL destination (loopback, not
// the broadcast address, on ephemeral ports rather than the privileged 9/7),
// and process.kill (a recorder, so no test can ever signal a real pid).

const test = require("node:test");
const assert = require("node:assert");
const dgram = require("node:dgram");
const net = require("node:net");

const h = require("./helpers");
const wol = require("../../src/main/fleet/wol");

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

const MAC = "aa:bb:cc:dd:ee:ff";

/** Two paired hubs with live sessions in both directions. */
async function twoHubs({ aOpts = {}, bOpts = {} } = {}) {
  const a = await h.startFleet(aOpts);
  const b = await h.startFleet(bOpts);
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);
  return { a, b };
}

/* ------------------------------------------------------------------ */
/* MAC capture                                                         */
/* ------------------------------------------------------------------ */

test("a session teaches the hub the peer's MAC, and fleet.json keeps it", async () => {
  const asked = [];
  const { a, b } = await twoHubs({
    aOpts: {
      overrides: {
        arpLookup: (ip) => {
          asked.push(ip);
          return Promise.resolve(MAC);
        },
      },
    },
  });

  await h.waitUntil(() => {
    const peer = a.store.getPeer(b.localId);
    return peer && peer.mac === MAC;
  }, 4000, "the peer's MAC to be persisted");

  assert.ok(asked.includes("127.0.0.1"), "it looks up the address the socket actually used");
  // Straight off disk, not out of memory — a `nx fleet wake` in another
  // process has to see it too.
  const onDisk = h.store.createStore(a.dataDir).getPeer(b.localId);
  assert.strictEqual(onDisk.mac, MAC);
});

test("getPeers reports the MAC, so the UI knows when waking is possible", async () => {
  const { a, b } = await twoHubs({ aOpts: { overrides: { arpLookup: () => Promise.resolve(MAC) } } });
  await h.waitUntil(() => (a.getPeers().find((p) => p.id === b.localId) || {}).mac === MAC, 4000, "the mac on getPeers");
  const row = a.getPeers().find((p) => p.id === b.localId);
  assert.strictEqual(row.mac, MAC);
  // The other hub never resolved one, and says so honestly rather than guessing.
  const mirror = b.getPeers().find((p) => p.id === a.localId);
  assert.strictEqual(mirror.mac, null);
});

test("BOTH ends capture — whichever hub dialled", async () => {
  const { a, b } = await twoHubs({
    aOpts: { overrides: { arpLookup: () => Promise.resolve("11:22:33:44:55:66") } },
    bOpts: { overrides: { arpLookup: () => Promise.resolve("66:55:44:33:22:11") } },
  });
  await h.waitUntil(() => (a.store.getPeer(b.localId) || {}).mac, 4000, "A's capture");
  await h.waitUntil(() => (b.store.getPeer(a.localId) || {}).mac, 4000, "B's capture");
  assert.strictEqual(a.store.getPeer(b.localId).mac, "11:22:33:44:55:66");
  assert.strictEqual(b.store.getPeer(a.localId).mac, "66:55:44:33:22:11");
});

test("a failed lookup NEVER erases a MAC we already had", async () => {
  const dataDir = h.tempDataDir();
  const first = await twoHubs({
    aOpts: { dataDir, overrides: { arpLookup: () => Promise.resolve(MAC) } },
  });
  await h.waitUntil(() => (first.a.store.getPeer(first.b.localId) || {}).mac === MAC, 4000, "the first capture");
  const peerId = first.b.localId;
  await first.a.close();
  await first.b.close();

  // The peer moved behind a router (or the cache was cold): the lookup now
  // comes back null, twice — and the address that lets us wake it survives.
  const store = h.store.createStore(dataDir);
  store.touchPeer(peerId, { mac: null });
  store.touchPeer(peerId, { mac: "" });
  store.touchPeer(peerId, { mac: "00:00:00:00:00:00" });
  store.touchPeer(peerId, { host: "192.168.1.99", lastSeen: Date.now(), persist: true });
  assert.strictEqual(store.getPeer(peerId).mac, MAC, "the only field that is add-only");
});

test("a MAC that changed (new NIC, new machine) is taken over", async () => {
  const { a, b } = await twoHubs({ aOpts: { overrides: { arpLookup: () => Promise.resolve(MAC) } } });
  await h.waitUntil(() => (a.store.getPeer(b.localId) || {}).mac === MAC, 4000, "the first capture");
  a.store.touchPeer(b.localId, { mac: "00:11:22:33:44:55" });
  assert.strictEqual(a.store.getPeer(b.localId).mac, "00:11:22:33:44:55");
});

test("a lookup that throws is logged, not fatal to the session", async () => {
  const { a, b } = await twoHubs({
    aOpts: { overrides: { arpLookup: () => Promise.reject(new Error("no /proc here")) } },
  });
  await h.waitUntil(() => a.logs.some((l) => /could not read .* MAC/.test(l)), 4000, "the complaint");
  assert.strictEqual(a.store.getPeer(b.localId).mac, undefined);
  // And the session is entirely unbothered.
  assert.ok(a.sessions.get(b.localId).alive);
});

/* ------------------------------------------------------------------ */
/* wake                                                                */
/* ------------------------------------------------------------------ */

/** A udp4 socket on 127.0.0.1 that collects whatever lands on it. */
function listener() {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const packets = [];
  socket.on("message", (msg) => packets.push(Buffer.from(msg)));
  return new Promise((resolve) => {
    socket.bind(0, "127.0.0.1", () =>
      resolve({ port: socket.address().port, packets, close: () => socket.close() })
    );
  });
}

test("wake(peerId) sends the peer's magic packets", async () => {
  const sink = await listener();
  try {
    const { a, b } = await twoHubs({
      aOpts: {
        overrides: {
          arpLookup: () => Promise.resolve(MAC),
          wolAddress: "127.0.0.1",
          wolPorts: [sink.port],
        },
      },
    });
    await h.waitUntil(() => (a.store.getPeer(b.localId) || {}).mac === MAC, 4000, "the capture");

    assert.strictEqual(await a.wake(b.localId), true);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(sink.packets.length, wol.REPEATS);
    assert.deepStrictEqual(sink.packets[0], wol.magicPacket(MAC));
  } finally {
    sink.close();
  }
});

test("waking a peer with no MAC is a false and a helpful log, not a throw", async () => {
  const { a, b } = await twoHubs({ aOpts: { overrides: { arpLookup: () => Promise.resolve(null) } } });
  assert.strictEqual(await a.wake(b.localId), false);
  assert.ok(
    a.logs.some((l) => /no MAC learned yet/.test(l)),
    "and it says how to fix it"
  );
});

test("waking a hub we never paired with is false", async () => {
  const a = await h.startFleet();
  assert.strictEqual(await a.wake("0123456789abcdef"), false);
  assert.strictEqual(await a.wake(""), false);
  assert.strictEqual(await a.wake(null), false);
});

/* ------------------------------------------------------------------ */
/* probe / probe-result                                                */
/* ------------------------------------------------------------------ */

/** A TCP listener on 127.0.0.1 — what a "healthy" peered step looks like. */
function openPort() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })
    );
  });
}

test("probePeerPort is true for a port open on the REMOTE's loopback", async () => {
  const service = await openPort();
  try {
    const { a, b } = await twoHubs();
    assert.strictEqual(await a.probePeerPort(b.localId, service.port), true);
  } finally {
    await service.close();
  }
});

test("probePeerPort is false for a shut port, and does not throw", async () => {
  const service = await openPort();
  const port = service.port;
  await service.close(); // nothing is listening there any more

  const { a, b } = await twoHubs();
  assert.strictEqual(await a.probePeerPort(b.localId, port, { timeoutMs: 1000 }), false);
});

test("a nonsense port is refused by the remote without a connect attempt", async () => {
  const { a, b } = await twoHubs();
  for (const port of [0, -1, 70000, "http", null]) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await a.probePeerPort(b.localId, port), false, `port ${port}`);
  }
});

test("probing an unreachable peer is false, never a rejection", async () => {
  const a = await h.startFleet();
  assert.strictEqual(await a.probePeerPort("0123456789abcdef", 8080), false);
});

test("a probe round-trip leaves the session healthy for the next request", async () => {
  const service = await openPort();
  try {
    const { a, b } = await twoHubs({ bOpts: { discovery: h.fakeDiscovery([h.app("wivrn-nx", { artifacts: [{ id: "linux" }] })]), jobs: h.fakeJobs() } });
    assert.strictEqual(await a.probePeerPort(b.localId, service.port), true);
    assert.strictEqual(await a.probePeerPort(b.localId, service.port), true);
    const ack = await a.remoteInstall(b.localId, "wivrn-nx", "linux");
    assert.strictEqual(ack.ok, true, "sequencing survived the out-of-band probe replies");
  } finally {
    await service.close();
  }
});

/* ------------------------------------------------------------------ */
/* remote stop                                                         */
/* ------------------------------------------------------------------ */

test("remoteStop asks the bus first when the app is on it", async () => {
  const connector = h.fakeConnector({ present: ["wivrn-nx"] });
  const killed = [];
  const { a, b } = await twoHubs({
    bOpts: {
      jobs: h.fakeJobs({ tracked: [{ appId: "wivrn-nx", pid: 4242 }] }),
      overrides: { connector, kill: (pid, sig) => killed.push([pid, sig]), stopWaitMs: 500 },
    },
  });

  const ack = await a.remoteStop(b.localId, "wivrn-nx");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.appId, "wivrn-nx");
  assert.strictEqual(ack.how, "shutdown-request");
  assert.deepStrictEqual(connector.calls, ["wivrn-nx"]);
  assert.deepStrictEqual(killed, [], "an app that left politely is never signalled");
});

test("remoteStop falls back to SIGTERM on the tracked pid", async () => {
  // On the bus, but it ignores the request — the classic hung app.
  const connector = h.fakeConnector({ present: ["wivrn-nx"], honourShutdown: false });
  const killed = [];
  const { a, b } = await twoHubs({
    bOpts: {
      jobs: h.fakeJobs({ tracked: [{ appId: "wivrn-nx", pid: 4242 }, { appId: "pulsenx", pid: 99 }] }),
      overrides: { connector, kill: (pid, sig) => killed.push([pid, sig]), stopWaitMs: 100 },
    },
  });

  const ack = await a.remoteStop(b.localId, "wivrn-nx");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.how, "sigterm");
  assert.deepStrictEqual(killed, [[4242, "SIGTERM"]], "SIGTERM, never SIGKILL — and only that app's pid");
  assert.deepStrictEqual(ack.pids, [4242]);
});

test("a hub with no bus at all goes straight to the tracked pid", async () => {
  const killed = [];
  const { a, b } = await twoHubs({
    bOpts: {
      jobs: h.fakeJobs({ tracked: [{ appId: "wivrn-nx", pid: 777 }] }),
      overrides: { connector: null, kill: (pid, sig) => killed.push([pid, sig]) },
    },
  });
  const ack = await a.remoteStop(b.localId, "wivrn-nx");
  assert.strictEqual(ack.how, "sigterm");
  assert.deepStrictEqual(killed, [[777, "SIGTERM"]]);
});

test("stopping something that is not running acks 'gone' rather than failing", async () => {
  const { a, b } = await twoHubs({
    bOpts: { jobs: h.fakeJobs(), overrides: { connector: null, kill: () => {} } },
  });
  const ack = await a.remoteStop(b.localId, "nothing-here");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.how, "gone");
  assert.deepStrictEqual(ack.pids, []);
});

test("a stop with no appId is refused, and a dead pid is not an error", async () => {
  const { a, b } = await twoHubs({
    bOpts: {
      jobs: h.fakeJobs({ tracked: [{ appId: "wivrn-nx", pid: 4242 }] }),
      overrides: {
        connector: null,
        kill: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      },
    },
  });
  await assert.rejects(() => a.remoteStop(b.localId, ""), /stop needs an appId/);
  const ack = await a.remoteStop(b.localId, "wivrn-nx");
  assert.strictEqual(ack.how, "gone", "the process had already exited");
});

/* ------------------------------------------------------------------ */
/* peer-online (the gate a wake step falls through to)                 */
/* ------------------------------------------------------------------ */

test("isPeerOnline follows the live session", async () => {
  const { a, b } = await twoHubs();
  assert.strictEqual(a.isPeerOnline(b.localId), true);
  assert.strictEqual(a.isPeerOnline("0123456789abcdef"), false, "a hub we never paired with");
  assert.strictEqual(a.isPeerOnline(""), false);

  await b.close();
  await h.waitUntil(() => a.isPeerOnline(b.localId) === false, 4000, "the peer to go offline");
  assert.strictEqual(a.isPeerOnline(b.localId), false);
});

test("isPeerOnline agrees with getPeers().online", async () => {
  const { a, b } = await twoHubs();
  const row = a.getPeers().find((p) => p.id === b.localId);
  assert.strictEqual(a.isPeerOnline(b.localId), row.online);
});
