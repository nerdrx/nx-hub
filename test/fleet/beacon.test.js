"use strict";
// The UDP beacon, over real datagrams — on 127.0.0.1 with EPHEMERAL ports.
//
// Production broadcasts to 255.255.255.255:9022; here two beacons unicast to
// each other's ephemeral loopback ports instead. That is the same send/receive
// path with SO_BROADCAST off, and it keeps the user's own hub (which owns the
// real :9022 on this machine) completely undisturbed.

const test = require("node:test");
const assert = require("node:assert");
const dgram = require("dgram");

const { createBeacon } = require("../../src/main/fleet/beacon");
const protocol = require("../../src/main/fleet/protocol");

const open = [];

test.after(() => {
  while (open.length) {
    try {
      open.pop().close();
    } catch (_) {
      /* ignore */
    }
  }
});

/** A loopback beacon on an ephemeral port, sending to `sendPort`. */
async function beaconOn({ id, name = "hub", port = 9023, sendPort = 0, intervalMs = 20, onPeer, ttlMs } = {}) {
  const seen = [];
  const b = createBeacon({
    port: 0,
    sendPort,
    bindAddress: "127.0.0.1",
    broadcastAddress: "127.0.0.1",
    broadcast: false, // loopback unicast — no SO_BROADCAST needed or wanted
    intervalMs,
    ttlMs,
    message: () => ({ id, name, hubVersion: "0.6.0", port }),
    onPeer: (entry, isNew) => {
      seen.push({ entry, isNew });
      if (onPeer) onPeer(entry, isNew);
    },
  });
  const ready = await b.ready;
  assert.strictEqual(ready.ok, true, "the beacon must bind");
  open.push(b);
  b.seen = seen;
  return b;
}

async function waitUntil(pred, ms = 4000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = pred();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("two beacons find each other and record host, port and name", async () => {
  const idA = protocol.newId();
  const idB = protocol.newId();
  const a = await beaconOn({ id: idA, name: "attic", port: 11111 });
  const b = await beaconOn({ id: idB, name: "bench", port: 22222, sendPort: a.port });
  // A only learns where to send once B exists, so it is wired up second.
  const a2 = await beaconOn({ id: idA, name: "attic", port: 11111, sendPort: b.port });

  const heard = await waitUntil(() => b.get(idA), 4000, "B to hear A");
  assert.strictEqual(heard.id, idA);
  assert.strictEqual(heard.name, "attic");
  assert.strictEqual(heard.port, 11111);
  assert.strictEqual(heard.host, "127.0.0.1");
  assert.strictEqual(b.isFresh(idA), true);

  await waitUntil(() => a.get(idB) || a2.get(idB), 4000, "A to hear B");
});

test("a beacon never discovers itself", async () => {
  const id = protocol.newId();
  const a = await beaconOn({ id });
  // Point it at its own port: every datagram it sends comes straight back.
  const loop = await beaconOn({ id, sendPort: a.port });
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(a.get(id), null, "our own id is never a peer");
  assert.strictEqual(a.list().length, 0);
  assert.strictEqual(loop.list().length, 0);
});

test("repeat beacons dedupe: one record per id, onPeer only on real news", async () => {
  const idA = protocol.newId();
  const b = await beaconOn({ id: protocol.newId() });
  await beaconOn({ id: idA, name: "attic", port: 11111, sendPort: b.port, intervalMs: 10 });

  await waitUntil(() => b.get(idA), 4000, "the first beacon");
  await new Promise((r) => setTimeout(r, 120)); // ~12 more heartbeats

  assert.strictEqual(b.list().length, 1, "one record per id, however many beacons arrive");
  assert.strictEqual(b.seen.length, 1, "a heartbeat that changes nothing is not news");
  assert.strictEqual(b.seen[0].isNew, true);
  assert.ok(b.get(idA).at >= b.get(idA).firstSeen, "the record still tracks the latest sighting");
});

test("onPeer fires again when a peer actually moves", async () => {
  const idA = protocol.newId();
  const b = await beaconOn({ id: protocol.newId() });
  await beaconOn({ id: idA, name: "attic", port: 11111, sendPort: b.port, intervalMs: 10 });
  await waitUntil(() => b.seen.length === 1, 4000, "the first sighting");

  // Same id, new WS port — that is the one thing a listener has to hear about.
  await beaconOn({ id: idA, name: "attic", port: 33333, sendPort: b.port, intervalMs: 10 });
  const second = await waitUntil(() => b.seen.length >= 2 && b.seen[1], 4000, "the move");
  assert.strictEqual(second.isNew, false);
  assert.strictEqual(second.entry.port, 33333);
  assert.strictEqual(b.list().length, 1, "still one record — it moved, it did not multiply");
});

test("isFresh expires a peer once its beacons stop", async () => {
  const idA = protocol.newId();
  const b = await beaconOn({ id: protocol.newId(), ttlMs: 40 });
  const a = await beaconOn({ id: idA, sendPort: b.port, intervalMs: 10 });
  await waitUntil(() => b.isFresh(idA), 4000, "A to look online");

  a.close();
  await waitUntil(() => !b.isFresh(idA), 4000, "A to go stale");
  assert.ok(b.get(idA), "the record survives — we still know where it was");
});

test("junk on the beacon port is ignored without a murmur", async () => {
  const b = await beaconOn({ id: protocol.newId() });
  const noise = dgram.createSocket("udp4");
  const payloads = [
    Buffer.from("hello"),
    Buffer.from("{}"),
    Buffer.from(JSON.stringify({ nx: "something-else", id: protocol.newId(), port: 1 })),
    Buffer.from(JSON.stringify({ nx: "fleet-beacon", id: "short", port: 1 })),
    Buffer.alloc(4096, 0x41),
  ];
  for (const payload of payloads) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => noise.send(payload, b.port, "127.0.0.1", () => resolve()));
  }
  await new Promise((r) => setTimeout(r, 80));
  noise.close();
  assert.strictEqual(b.list().length, 0);
  assert.strictEqual(b.seen.length, 0);
});

test("a beacon that cannot bind fails soft instead of throwing", async () => {
  const holder = dgram.createSocket({ type: "udp4", reuseAddr: false });
  await new Promise((resolve) => holder.bind(0, "127.0.0.1", resolve));
  const busy = holder.address().port;

  const logs = [];
  const b = createBeacon({
    port: busy,
    bindAddress: "127.0.0.1",
    broadcast: false,
    message: () => ({ id: protocol.newId(), name: "x", hubVersion: "0", port: 9023 }),
    log: (m) => logs.push(String(m)),
  });
  const ready = await b.ready;
  holder.close();
  assert.strictEqual(ready.ok, false);
  assert.ok(logs.some((l) => /busy|failed/i.test(l)), "it says so in the log");
  assert.strictEqual(b.send(), false, "an unbound beacon sends nothing");
  b.close();
  b.close(); // idempotent
});

test("close() stops the heartbeat", async () => {
  const idA = protocol.newId();
  const b = await beaconOn({ id: protocol.newId() });
  const a = await beaconOn({ id: idA, sendPort: b.port, intervalMs: 10 });
  await waitUntil(() => b.get(idA), 4000, "the first sighting");
  a.close();
  const at = b.get(idA).at;
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(b.get(idA).at, at, "nothing arrived after close()");
});
