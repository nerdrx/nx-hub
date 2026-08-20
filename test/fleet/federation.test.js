"use strict";
// v0.10 [fabric2] — bus federation over the fleet (SPEC "Bus federation").
//
// Two real hubs on loopback + ephemeral ports, paired the way a human pairs
// them, with a fake connector bus behind each. The roster has to cross the
// authenticated session, land sanitised, drive `connector-changed`, and vanish
// the moment the session does.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");

const roster = require("../../src/main/fleet/roster");

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

/** Two paired hubs with a bus each. Returns {a, b, busA, busB}. */
async function pair({ aClients = [], bClients = [], overrides = {} } = {}) {
  const busA = h.fakeBus({ clients: aClients });
  const busB = h.fakeBus({ clients: bClients });
  const a = await h.startFleet({ overrides: Object.assign({ connector: busA, rosterIntervalMs: 20 }, overrides) });
  const b = await h.startFleet({ overrides: Object.assign({ connector: busB, rosterIntervalMs: 20 }, overrides) });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);
  return { a, b, busA, busB };
}

function appsSeenBy(hub, peerId) {
  const entry = hub.getRemoteClients().find((r) => r.peerId === peerId);
  return entry ? entry.clients.map((c) => c.app) : null;
}

test("a peer's bus roster crosses the session on open and shows up in getRemoteClients()", async () => {
  const { a, b } = await pair({
    aClients: [h.busClient("wivrn-nx", { fields: { fps: 90 }, history: { fps: [{ ts: Date.now(), v: 90 }] } })],
    bClients: [h.busClient("pulsenx", { version: "2.1.0", fields: { hr: 72 } })],
  });

  // SPEC: pushed on session open — neither side has to ask
  await h.waitUntil(() => appsSeenBy(a, b.localId), 4000, "A to see B's bus");
  await h.waitUntil(() => appsSeenBy(b, a.localId), 4000, "B to see A's bus");

  const seen = a.getRemoteClients();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].peerId, b.localId);
  assert.strictEqual(seen[0].peerName, b.snapshot().name, "the strip has a name to tag the row with");

  const fromB = seen[0].clients[0];
  assert.deepStrictEqual(Object.keys(fromB).sort(), ["app", "fields", "history", "since", "version"]);
  assert.strictEqual(fromB.app, "pulsenx");
  assert.strictEqual(fromB.version, "2.1.0");
  assert.deepStrictEqual(fromB.fields, { hr: 72 });
  assert.deepStrictEqual(fromB.history, {}, "no numbers sent yet, no line");
  assert.ok(Number.isInteger(fromB.since) && fromB.since > 0, "the peer's `since` travels");

  // …and the history came with it, capped at the roster's 20 points
  const fromA = b.getRemoteClients()[0].clients[0];
  assert.strictEqual(fromA.app, "wivrn-nx");
  assert.strictEqual(fromA.history.fps.length, 1);
  assert.strictEqual(fromA.history.fps[0].v, 90);
});

test("the fleet asks the bus for 20 points, never 60", async () => {
  const { busA } = await pair({ aClients: [h.busClient("wivrn-nx")] });
  await h.waitUntil(() => busA.calls.length > 0, 4000, "the bus to be read");
  for (const call of busA.calls) {
    assert.deepStrictEqual(call, { historyLimit: roster.MAX_ROSTER_HISTORY });
  }
  assert.strictEqual(roster.MAX_ROSTER_HISTORY, 20);
});

test("an app arriving on one hub's bus reaches the other, and fires connector-changed", async () => {
  const { a, b, busB } = await pair({ bClients: [] });
  await h.waitUntil(() => appsSeenBy(a, b.localId), 4000, "the first (empty) roster");
  assert.deepStrictEqual(appsSeenBy(a, b.localId), []);

  a.events.length = 0;
  busB.set([h.busClient("pulsenx", { fields: { hr: 68 } })]);

  await h.waitUntil(() => (appsSeenBy(a, b.localId) || []).length === 1, 4000, "the arrival to cross");
  assert.deepStrictEqual(appsSeenBy(a, b.localId), ["pulsenx"]);
  // SPEC: ONE event type — the renderer listens for connector-changed and
  // nothing else, whether the app is local or three metres away.
  assert.ok(
    a.events.some((e) => e.type === "connector-changed"),
    "a remote roster moving is a connector change"
  );

  // …and leaving crosses the same way
  a.events.length = 0;
  busB.set([]);
  await h.waitUntil(() => (appsSeenBy(a, b.localId) || ["x"]).length === 0, 4000, "the departure to cross");
  assert.ok(a.events.some((e) => e.type === "connector-changed"));
});

test("a roster that has not changed is not re-announced", async () => {
  const { a, b, busB } = await pair({ bClients: [h.busClient("pulsenx", { fields: { hr: 70 } })] });
  await h.waitUntil(() => (appsSeenBy(a, b.localId) || []).length === 1, 4000, "the first roster");

  a.events.length = 0;
  // the same roster, announced three times over
  for (let i = 0; i < 3; i += 1) {
    b.pushRoster();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.strictEqual(
    a.events.filter((e) => e.type === "connector-changed").length,
    0,
    "nothing moved, so nothing was said"
  );
});

test("a peer's roster is dropped when the session drops", async () => {
  const { a, b } = await pair({ bClients: [h.busClient("pulsenx")] });
  await h.waitUntil(() => (appsSeenBy(a, b.localId) || []).length === 1, 4000, "the roster");

  a.events.length = 0;
  await b.close();
  await h.waitUntil(() => a.getRemoteClients().length === 0, 4000, "the roster to be forgotten");
  assert.deepStrictEqual(a.getRemoteClients(), [], "a hub that is gone is not running anything");
  assert.ok(
    a.events.some((e) => e.type === "connector-changed"),
    "the strip has to be told to clear itself"
  );
});

test("a peer that was running nothing still clears its row when it goes", async () => {
  const { a, b } = await pair({ bClients: [] });
  await h.waitUntil(() => appsSeenBy(a, b.localId), 4000, "an empty roster");

  a.events.length = 0;
  await b.close();
  await h.waitUntil(() => a.getRemoteClients().length === 0, 4000, "the peer to go");
  assert.ok(
    a.events.some((e) => e.type === "connector-changed"),
    "the strip draws a row per PEER, so a peer leaving is a change even with no apps on it"
  );
});

test("unpairing forgets the roster too", async () => {
  const { a, b } = await pair({ bClients: [h.busClient("pulsenx")] });
  await h.waitUntil(() => (appsSeenBy(a, b.localId) || []).length === 1, 4000, "the roster");
  a.unpair(b.localId);
  assert.deepStrictEqual(a.getRemoteClients(), []);
});

test("a hub with no bus at all federates an empty roster rather than failing", async () => {
  const a = await h.startFleet({ overrides: { connector: null, rosterIntervalMs: 20 } });
  const b = await h.startFleet({ overrides: { connector: null, rosterIntervalMs: 20 } });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitUntil(() => a.getRemoteClients().length === 1, 4000, "an (empty) roster");
  assert.deepStrictEqual(a.getRemoteClients()[0].clients, []);
});

test("a bus that throws does not take the fleet down", async () => {
  const busA = {
    getClients() {
      throw new Error("bus exploded");
    },
  };
  const a = await h.startFleet({ overrides: { connector: busA, rosterIntervalMs: 20 } });
  const b = await h.startFleet({ overrides: { connector: null, rosterIntervalMs: 20 } });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitUntil(() => b.getRemoteClients().length === 1, 4000, "an empty roster from A");
  assert.deepStrictEqual(b.getRemoteClients()[0].clients, []);
  assert.ok(a.logs.some((l) => /could not read the bus roster/.test(l)));
});

/* ------------------------------------------------------ the sanitizer */

test("an inbound roster is parsed as hostile input", () => {
  const dirty = {
    clients: [
      null,
      "not a client",
      { app: "" },
      { app: "  PulseNX  ", version: 42, since: "yesterday", fields: "nope", history: [] },
      { app: "pulsenx", fields: { dup: 1 } }, // duplicate id → dropped
      {
        app: "wivrn-nx",
        version: "  1.2.3  ",
        since: 1_700_000_000_000,
        fields: { fps: 90, on: true, mode: "vr", nested: { a: 1 }, list: [1], nan: NaN },
        history: {
          fps: [{ ts: 1_700_000_000_002, v: 91 }, { ts: 1_700_000_000_001, v: 90 }, { ts: "x", v: 1 }, { v: 3 }, null],
          mode: [{ ts: 1_700_000_000_000, v: "vr" }],
        },
      },
    ],
  };
  const clean = roster.sanitizeRoster(dirty.clients);
  assert.deepStrictEqual(
    clean.map((c) => c.app),
    ["pulsenx", "wivrn-nx"],
    "ids are lower-cased, trimmed, deduplicated and ordinally sorted"
  );

  const [pulse, wivrn] = clean;
  assert.strictEqual(pulse.version, null, "a version that is not a string is no version");
  assert.strictEqual(pulse.since, null, "and a date that is not a number is no date");
  assert.deepStrictEqual(pulse.fields, {}, "fields that are not an object become none");
  assert.deepStrictEqual(pulse.history, {});

  assert.strictEqual(wivrn.version, "1.2.3");
  assert.deepStrictEqual(wivrn.fields, { fps: 90, on: true, mode: "vr" }, "scalars only — no objects, no arrays, no NaN");
  assert.deepStrictEqual(
    wivrn.history.fps.map((p) => p.v),
    [90, 91],
    "junk samples dropped, and time only goes forwards whatever the sender did"
  );
  assert.ok(!("mode" in wivrn.history), "text has no history, however hard a peer insists");
});

test("an inbound roster cannot make this hub allocate", () => {
  const fields = {};
  const history = {};
  for (let i = 0; i < 500; i += 1) {
    fields[`f${i}`] = i;
    history[`f${i}`] = Array.from({ length: 500 }, (_, n) => ({ ts: 1_700_000_000_000 + n, v: n }));
  }
  const many = Array.from({ length: 500 }, (_, i) => ({ app: `app-${i}`, fields, history }));

  const clean = roster.sanitizeRoster(many);
  assert.strictEqual(clean.length, roster.MAX_ROSTER_CLIENTS);
  assert.strictEqual(Object.keys(clean[0].fields).length, roster.MAX_ROSTER_FIELDS);
  assert.strictEqual(Object.keys(clean[0].history).length, roster.MAX_ROSTER_FIELDS);
  assert.strictEqual(clean[0].history.f0.length, roster.MAX_ROSTER_HISTORY, "20 points per field, newest kept");
  assert.strictEqual(clean[0].history.f0[19].v, 499);

  assert.deepStrictEqual(roster.sanitizeRoster("not an array"), []);
  assert.deepStrictEqual(roster.sanitizeRoster(null), []);

  // …and an over-long string is clipped rather than stored
  const long = roster.sanitizeRoster([{ app: "a", version: "v".repeat(5000), fields: { s: "x".repeat(5000) } }]);
  assert.strictEqual(long[0].version.length, 128);
  assert.strictEqual(long[0].fields.s.length, 128);
});

test("buildRoster sheds history, then clients, rather than sending an unsendable frame", () => {
  const heavy = [];
  for (let i = 0; i < 30; i += 1) {
    const history = {};
    for (let f = 0; f < 40; f += 1) {
      history[`field-number-${f}`] = Array.from({ length: 20 }, (_, n) => ({ ts: 1_700_000_000_000 + n, v: n / 3 }));
    }
    heavy.push({ app: `app-${i}`, version: "1.0.0", since: 1_700_000_000_000, fields: {}, history });
  }

  const built = roster.buildRoster(heavy);
  assert.strictEqual(built.type, "bus-roster");
  assert.ok(Buffer.byteLength(JSON.stringify(built), "utf8") <= roster.MAX_ROSTER_BYTES);
  assert.ok(built.clients.length >= 1, "the list is what the user asked for — it is never emptied");
  assert.deepStrictEqual(built.clients[0].history, {}, "decoration goes before information");

  // a small roster is untouched
  const small = roster.buildRoster([{ app: "pulsenx", fields: { hr: 70 }, history: { hr: [{ ts: 1, v: 70 }] } }]);
  assert.deepStrictEqual(small.clients[0].history.hr, [{ ts: 1, v: 70 }]);
});
