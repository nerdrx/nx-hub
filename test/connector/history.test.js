"use strict";
// v0.10 [fabric2] — the bus's per-field history rings (SPEC "Field history →
// sparklines", server half).
//
// Real sockets, ephemeral ports, temp dirs: a history is only worth anything
// if it survives the actual status path, caps and throttle included.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");

const { server } = h;

test.after(() => h.cleanupTempDirs());

/** Send `n` status messages without tripping the 4/s throttle. */
async function stream(client, samples) {
  for (const fields of samples) {
    client.sendJson({ type: "status", fields });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 260));
  }
}

test("numeric fields grow a history; bools and text never do", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();

  await stream(client, [
    { hr: 71, connected: true, mode: "resting" },
    { hr: 72 },
    { hr: 74, battery: 88 },
  ]);
  await h.waitUntil(() => (server.getClients()[0] || {}).fields.hr === 74, 4000, "the last sample to land");

  const [entry] = server.getClients();
  assert.deepStrictEqual(Object.keys(entry.history).sort(), ["battery", "hr"], "only the numbers get a line");
  assert.deepStrictEqual(
    entry.history.hr.map((p) => p.v),
    [71, 72, 74]
  );
  assert.strictEqual(entry.history.battery.length, 1, "a field that started late starts its line late");
  for (const point of entry.history.hr) {
    assert.ok(Number.isInteger(point.ts) && point.ts > 0, "every sample is stamped");
    assert.deepStrictEqual(Object.keys(point).sort(), ["ts", "v"], "the wire shape is {ts, v}");
  }
  // the merged snapshot is unchanged — history is an ADDITION, not a rewrite
  assert.deepStrictEqual(entry.fields, { hr: 74, connected: true, mode: "resting", battery: 88 });
});

test("a field that stops being a number loses its line rather than lying", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();

  await stream(client, [{ hr: 70 }, { hr: 71 }, { hr: "n/a" }]);
  await h.waitUntil(() => (server.getClients()[0] || {}).fields.hr === "n/a", 4000, "the text sample");
  assert.deepStrictEqual(server.getClients()[0].history, {}, "half a line then a shrug is worse than no line");

  // …and it starts again cleanly when the numbers come back
  await stream(client, [{ hr: 69 }]);
  await h.waitUntil(() => (server.getClients()[0] || {}).fields.hr === 69, 4000, "the number to come back");
  assert.deepStrictEqual(
    server.getClients()[0].history.hr.map((p) => p.v),
    [69]
  );
});

test("a rejected status leaves no sample behind", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();
  client.sendJson({ type: "status", fields: { hr: 70 } });
  await h.waitUntil(() => (server.getClients()[0] || {}).fields.hr === 70, 4000, "the good sample");

  // over the 2KB cap → the connection is closed and nothing was recorded
  client.sendJson({ type: "status", fields: { hr: 999, padding: "x".repeat(3000) } });
  await client.untilClosed();
  assert.deepStrictEqual(server.getClients(), [], "the client went with its history");
});

test("a re-hello starts the lines again — the old run's numbers are not this one's", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();
  await stream(client, [{ hr: 70 }, { hr: 71 }]);
  await h.waitUntil(() => (server.getClients()[0] || {}).history.hr, 4000, "a line");

  client.hello({ app: "pulsenx", token: bus.token, version: "2.0.0" });
  await client.next();
  await h.waitUntil(() => server.getClients()[0].version === "2.0.0", 4000, "the new run");
  assert.deepStrictEqual(server.getClients()[0].history, {}, "a fresh process gets a fresh line");
});

test("history dies with the client", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();
  await stream(client, [{ hr: 70 }]);
  await h.waitUntil(() => (server.getClients()[0] || {}).history.hr, 4000, "a line");

  client.close();
  await h.waitUntil(() => server.getClients().length === 0, 4000, "the client to go");

  const again = await h.rawConnect(bus.port);
  t.after(() => again.close());
  again.hello({ app: "pulsenx", token: bus.token });
  await again.next();
  await h.waitUntil(() => server.getClients().length === 1, 4000, "the reconnect");
  assert.deepStrictEqual(server.getClients()[0].history, {}, "nothing was kept for a client that left");
});

/* --------------------------------------------------------- the ring itself */

test("the ring keeps 120 samples over a 10 minute window, newest first out", () => {
  const down = server._downsample;
  const now = 1_700_000_000_000;

  // the window is the outer bound: anything older than 10min is simply gone
  const ring = [
    { ts: now - 11 * 60 * 1000, v: 1 },
    { ts: now - 60 * 1000, v: 2 },
    { ts: now, v: 3 },
  ];
  assert.deepStrictEqual(
    down(ring, 60, now).map((p) => p.v),
    [2, 3],
    "the sample from eleven minutes ago is outside the window"
  );
  assert.strictEqual(server.HISTORY_MAX_SAMPLES, 120);
  assert.strictEqual(server.HISTORY_WINDOW_MS, 10 * 60 * 1000);
  assert.strictEqual(server.HISTORY_POINTS, 60);
  assert.strictEqual(server.ROSTER_HISTORY_POINTS, 20);

  // …and the count is the inner bound: 130 samples inside the window still
  // leave 120, the oldest going first
  const busy = [];
  for (let i = 0; i < 130; i += 1) busy.push({ ts: now - (129 - i) * 100, v: i });
  server._pruneRing(busy, now);
  assert.strictEqual(busy.length, 120);
  assert.strictEqual(busy[0].v, 10, "the ten oldest fell off the front");
  assert.strictEqual(busy[119].v, 129);

  // both bounds at once: stale samples go before the count is even considered
  const mixed = [{ ts: now - 20 * 60 * 1000, v: -1 }, { ts: now - 500, v: 1 }, { ts: now, v: 2 }];
  server._pruneRing(mixed, now);
  assert.deepStrictEqual(mixed.map((p) => p.v), [1, 2]);
});

test("downsampling is an even stride that always keeps the newest point", () => {
  const down = server._downsample;
  const now = 1_700_000_000_000;
  const full = [];
  for (let i = 0; i < 120; i += 1) full.push({ ts: now - (119 - i) * 1000, v: i });

  const sixty = down(full, 60, now);
  assert.strictEqual(sixty.length, 60);
  assert.strictEqual(sixty[sixty.length - 1].v, 119, "the newest sample is always in");
  assert.deepStrictEqual(
    sixty.slice(0, 3).map((p) => p.v),
    [1, 3, 5],
    "an even stride, counted back from the newest"
  );
  for (let i = 1; i < sixty.length; i += 1) {
    assert.ok(sixty[i].ts > sixty[i - 1].ts, "time only goes forwards");
  }

  const twenty = down(full, 20, now);
  assert.strictEqual(twenty.length, 20, "the roster's 20-point cap");
  assert.strictEqual(twenty[twenty.length - 1].v, 119);

  // under the limit is passed through untouched (but copied)
  const few = full.slice(-5);
  const out = down(few, 60, now);
  assert.deepStrictEqual(out, few.map((p) => ({ ts: p.ts, v: p.v })));
  assert.notStrictEqual(out[0], few[0], "callers never get the live ring");
});

test("getClients({historyLimit}) is what the fleet asks with", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ app: "pulsenx", token: bus.token });
  await client.next();
  await stream(client, [{ hr: 70 }, { hr: 71 }, { hr: 72 }]);
  await h.waitUntil(() => ((server.getClients()[0] || {}).history.hr || []).length === 3, 4000, "three samples");

  assert.strictEqual(server.getClients({ historyLimit: 1 })[0].history.hr.length, 1);
  assert.strictEqual(server.getClients({ historyLimit: 1 })[0].history.hr[0].v, 72, "the newest one");
  // junk limits fall back to the default rather than emptying the chart
  for (const junk of [0, -5, "60", null, NaN]) {
    assert.strictEqual(server.getClients({ historyLimit: junk })[0].history.hr.length, 3, `limit ${junk}`);
  }
  assert.deepStrictEqual(server.getClients()[0].history.hr.length, 3, "no argument at all is fine too");
});

test("with no bus running, getClients() is still empty and still takes options", () => {
  // (the module-level passthrough — every other consumer relies on this)
  assert.deepStrictEqual(server.getClients({ historyLimit: 20 }), []);
});
