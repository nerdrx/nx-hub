"use strict";
// The production discovery path: beacons wired into a live fleet, and the
// arbitration sweep that keeps exactly one session up.
//
// Ports are reserved and released first (the same trick test/connector uses
// for TCP), so two fleets can point their beacons at each other on loopback
// without either of them ever touching the real :9022 / :9023.

const test = require("node:test");
const assert = require("node:assert");
const dgram = require("dgram");

const h = require("./helpers");
const { createBeacon } = require("../../src/main/fleet/beacon");

const { protocol } = h;

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

/** A UDP port that is free right now — released before we return it. */
function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket("udp4");
    probe.on("error", reject);
    probe.bind(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Beacon options that keep everything on loopback and off the wire. */
function loopbackBeacon(bindPort, sendPort, intervalMs = 20) {
  return {
    beaconPort: bindPort,
    beaconSendPort: sendPort,
    beaconBindAddress: "127.0.0.1",
    beaconBroadcastAddress: "127.0.0.1",
    beaconBroadcast: false, // no SO_BROADCAST: this is unicast loopback
    beaconIntervalMs: intervalMs,
    beaconTtlMs: 400,
  };
}

test("two beaconing hubs see each other as online and keep one session", async () => {
  const portA = await freeUdpPort();
  const portB = await freeUdpPort();

  const a = await h.startFleet({
    overrides: Object.assign({ beacon: true }, loopbackBeacon(portA, portB)),
  });
  const b = await h.startFleet({
    overrides: Object.assign({ beacon: true }, loopbackBeacon(portB, portA)),
  });

  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);

  // Both hubs hear the other's beacon, on top of the live session.
  const heardOnA = await h.waitUntil(() => a.getPeers().find((p) => p.beacon) || false, 4000, "B's beacon on A");
  const heardOnB = await h.waitUntil(() => b.getPeers().find((p) => p.beacon) || false, 4000, "A's beacon on B");
  assert.strictEqual(heardOnA.id, b.localId);
  assert.strictEqual(heardOnA.online, true);
  assert.strictEqual(heardOnA.connected, true);
  assert.strictEqual(heardOnB.id, a.localId);

  // The beacon advertises the WS port, so each side knows where to dial.
  assert.strictEqual(a.beacon.get(b.localId).port, b.server.port);
  assert.strictEqual(b.beacon.get(a.localId).port, a.server.port);

  // Beacons must not turn into a second session.
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(a.sessions.size, 1);
  assert.strictEqual(b.sessions.size, 1);

  // Exactly one of them is the dialer, and both agree which.
  const peerOnA = a.getPeers()[0];
  const peerOnB = b.getPeers()[0];
  assert.notStrictEqual(peerOnA.dialsUs, peerOnB.dialsUs, "arbitration is antisymmetric");
});

test("a paired peer that only beacons reads as online but not connected", async () => {
  const port = await freeUdpPort();
  const beaconPort = await freeUdpPort();
  const ghostId = "ffffffffffffffff";

  const a = await h.startFleet({
    overrides: Object.assign({ beacon: true }, loopbackBeacon(beaconPort, port)),
  });

  // Teach A about a peer that will never answer a dial…
  a.store.upsertPeer({
    id: ghostId,
    name: "ghost",
    host: "127.0.0.1",
    port: 1, // nothing listens there
    secret: protocol.deriveSecret("123456", ghostId, a.localId),
  });

  // …and beacon at A on its behalf.
  const ghost = createBeacon({
    port,
    sendPort: beaconPort,
    bindAddress: "127.0.0.1",
    broadcastAddress: "127.0.0.1",
    broadcast: false,
    intervalMs: 20,
    message: () => ({ id: ghostId, name: "ghost", hubVersion: "0.6.0", port: 9023 }),
  });
  await ghost.ready;

  const seen = await h.waitUntil(
    () => {
      const p = a.getPeers().find((x) => x.id === ghostId);
      return p && p.online ? p : false;
    },
    4000,
    "the ghost to look online"
  );
  assert.strictEqual(seen.beacon, true, "online because of the beacon");
  assert.strictEqual(seen.connected, false, "…but no session ever came up");
  assert.strictEqual(seen.name, "ghost");
  assert.strictEqual(seen.port, 9023, "the beacon's WS port wins over the stored one");
  assert.strictEqual(seen.summary, null);
  assert.strictEqual(seen.updates, 0);

  ghost.close();

  // Once the beacons stop, the freshness window closes and so does "online".
  await h.waitUntil(
    () => {
      const p = a.getPeers().find((x) => x.id === ghostId);
      return p && !p.online;
    },
    4000,
    "the ghost to go offline"
  );
});

test("the dial sweep brings a dropped session back", async () => {
  const a = await h.startFleet({ dialIntervalMs: 25 });
  const b = await h.startFleet({ dialIntervalMs: 25 });
  await h.pairHubs(a, b);

  // Only the dialling side retries, so that is the side to watch — waiting on
  // the other one would be a race, not a test.
  const dialer = protocol.shouldDial(a.localId, b.localId) ? a : b;
  const other = dialer === a ? b : a;
  const victim = await h.waitForSession(dialer, other.localId);

  // Kill it the way a flaky network would: from underneath, no close frame.
  victim.channel.destroy("cable unplugged");
  await h.waitUntil(() => !dialer.sessions.has(other.localId), 4000, "the session to drop");

  const again = await h.waitForSession(dialer, other.localId, 4000);
  assert.ok(again.alive);
  assert.notStrictEqual(again, victim, "it is a NEW session, not the corpse");
  assert.strictEqual(dialer.sessions.size, 1, "and still only one");
});

test("an unpaired neighbour's beacon is noise — never a peer, never a dial", async () => {
  const port = await freeUdpPort();
  const beaconPort = await freeUdpPort();
  const a = await h.startFleet({
    overrides: Object.assign({ beacon: true }, loopbackBeacon(beaconPort, port)),
  });

  const stranger = createBeacon({
    port,
    sendPort: beaconPort,
    bindAddress: "127.0.0.1",
    broadcastAddress: "127.0.0.1",
    broadcast: false,
    intervalMs: 15,
    message: () => ({ id: protocol.newId(), name: "someone-elses-hub", hubVersion: "0.6.0", port: 9023 }),
  });
  await stranger.ready;
  await new Promise((r) => setTimeout(r, 120));
  stranger.close();

  assert.deepStrictEqual(a.getPeers(), [], "discovery does not imply trust");
  assert.strictEqual(a.sessions.size, 0);
  assert.strictEqual(a.store.peers().length, 0);
});

test("the fleet closes cleanly: beacon, server and sessions all go", async () => {
  const portA = await freeUdpPort();
  const portB = await freeUdpPort();
  const a = await h.startFleet({ overrides: Object.assign({ beacon: true }, loopbackBeacon(portA, portB)) });
  const b = await h.startFleet({ overrides: Object.assign({ beacon: true }, loopbackBeacon(portB, portA)) });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);

  await a.close();
  assert.strictEqual(a.sessions.size, 0);
  // B notices the far end going away rather than holding a zombie session.
  await h.waitUntil(() => !b.sessions.has(a.localId), 4000, "B to drop the dead session");
  await a.close(); // idempotent
});
