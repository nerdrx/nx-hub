"use strict";
// The pure protocol layer: codes, secrets, envelopes, beacons, summaries.
// No sockets in this file — that is the point of keeping it pure.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const protocol = require("../../src/main/fleet/protocol");

/* ------------------------------------------------------------------ */
/* identities and codes                                                */
/* ------------------------------------------------------------------ */

test("newId mints 16 lowercase hex chars and isId agrees", () => {
  for (let i = 0; i < 32; i += 1) {
    const id = protocol.newId();
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.strictEqual(protocol.isId(id), true);
  }
  for (const bad of ["", null, 42, "ABCDEF0123456789", "0123456789abcde", "0123456789abcdef0", "zzzzzzzzzzzzzzzz"]) {
    assert.strictEqual(protocol.isId(bad), false, `isId(${JSON.stringify(bad)})`);
  }
});

test("ids do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(protocol.newId());
  assert.strictEqual(seen.size, 500);
});

test("newCode is six digits, leading zeros kept", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = protocol.newCode();
    assert.strictEqual(code.length, 6);
    assert.match(code, /^[0-9]{6}$/);
    assert.strictEqual(protocol.isCode(code), true);
  }
  for (const bad of ["12345", "1234567", "12345a", "", null, 123456]) {
    assert.strictEqual(protocol.isCode(bad), false, `isCode(${JSON.stringify(bad)})`);
  }
});

test("deriveSecret is 64 hex, order-sensitive and code-sensitive", () => {
  const a = "1111111111111111";
  const b = "2222222222222222";
  const secret = protocol.deriveSecret("123456", a, b);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.strictEqual(secret, protocol.deriveSecret("123456", a, b), "deterministic");
  assert.notStrictEqual(secret, protocol.deriveSecret("123456", b, a), "the id order matters");
  assert.notStrictEqual(secret, protocol.deriveSecret("123457", a, b), "the code matters");
  // It is exactly sha256(code + idA + idB), as SPEC states.
  assert.strictEqual(secret, crypto.createHash("sha256").update(`123456${a}${b}`).digest("hex"));
});

/* ------------------------------------------------------------------ */
/* MACs and envelopes                                                  */
/* ------------------------------------------------------------------ */

test("verifyMac accepts the real tag and refuses everything else", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ type: "summary", apps: [] });
  const mac = protocol.macFor(secret, 7, body);
  assert.strictEqual(protocol.verifyMac(secret, 7, body, mac), true);
  assert.strictEqual(protocol.verifyMac(secret, 8, body, mac), false, "the seq is covered");
  assert.strictEqual(protocol.verifyMac(secret, 7, `${body} `, mac), false, "the body is covered");
  assert.strictEqual(protocol.verifyMac("b".repeat(64), 7, body, mac), false, "the secret is covered");
  // Malformed tags are wrong answers, never exceptions.
  for (const bad of ["", "zz", null, 42, "0".repeat(63), "0".repeat(65), `${mac}00`]) {
    assert.strictEqual(protocol.verifyMac(secret, 7, body, bad), false, `verifyMac(${JSON.stringify(bad)})`);
  }
});

test("an envelope round-trips and carries the body VERBATIM", () => {
  const secret = protocol.deriveSecret("424242", protocol.newId(), protocol.newId());
  const payload = { type: "install", appId: "wivrn-nx", artifactId: "linux", rid: "r1" };
  const text = protocol.encodeEnvelope(secret, 1, payload);
  const parsed = JSON.parse(text);
  assert.strictEqual(typeof parsed.body, "string", "the body travels as text, so the MAC covers the bytes");
  assert.strictEqual(parsed.seq, 1);

  const out = protocol.decodeEnvelope(secret, text, { lastSeq: 0 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.seq, 1);
  assert.deepStrictEqual(out.payload, payload);
});

test("decodeEnvelope refuses a tampered body, seq, or mac", () => {
  const secret = "c".repeat(64);
  const text = protocol.encodeEnvelope(secret, 3, { type: "summary", apps: [] });
  const env = JSON.parse(text);

  const swapped = JSON.stringify(Object.assign({}, env, { body: JSON.stringify({ type: "install", appId: "x" }) }));
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, swapped), { ok: false, reason: "bad mac" });

  const bumped = JSON.stringify(Object.assign({}, env, { seq: 4 }));
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, bumped), { ok: false, reason: "bad mac" });

  const forged = JSON.stringify(Object.assign({}, env, { mac: "d".repeat(64) }));
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, forged), { ok: false, reason: "bad mac" });

  assert.deepStrictEqual(protocol.decodeEnvelope("e".repeat(64), text), { ok: false, reason: "bad mac" });
});

test("decodeEnvelope refuses replays and rewinds, but accepts the next seq", () => {
  const secret = "f".repeat(64);
  const text = protocol.encodeEnvelope(secret, 5, { type: "summary", apps: [] });
  assert.strictEqual(protocol.decodeEnvelope(secret, text, { lastSeq: 4 }).ok, true);
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, text, { lastSeq: 5 }), { ok: false, reason: "replayed seq" });
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, text, { lastSeq: 9 }), { ok: false, reason: "replayed seq" });
});

test("decodeEnvelope refuses structurally broken input without throwing", () => {
  const secret = "0".repeat(64);
  const cases = [
    ["{not json", "malformed envelope"],
    ["[]", "malformed envelope"],
    ['"a string"', "malformed envelope"],
    ["null", "malformed envelope"],
    [JSON.stringify({ seq: 1, mac: "x" }), "missing body"],
    [JSON.stringify({ seq: 0, mac: "x", body: "{}" }), "bad seq"],
    [JSON.stringify({ seq: -1, mac: "x", body: "{}" }), "bad seq"],
    [JSON.stringify({ seq: 1.5, mac: "x", body: "{}" }), "bad seq"],
    [JSON.stringify({ seq: "1", mac: "x", body: "{}" }), "bad seq"],
    // A nested OBJECT body is refused too — that is the shape a naive
    // implementation would have used, and it is exactly the one that lets key
    // order decide whether a MAC verifies.
    [JSON.stringify({ seq: 1, mac: "x", body: { type: "summary" } }), "missing body"],
  ];
  for (const [text, reason] of cases) {
    assert.deepStrictEqual(protocol.decodeEnvelope(secret, text), { ok: false, reason }, text);
  }
});

test("a payload with no type is refused even when perfectly signed", () => {
  const secret = "1".repeat(64);
  const body = JSON.stringify({ appId: "wivrn-nx" });
  const text = JSON.stringify({ seq: 1, mac: protocol.macFor(secret, 1, body), body });
  assert.deepStrictEqual(protocol.decodeEnvelope(secret, text), { ok: false, reason: "missing type" });
});

test("a signed but non-object body is refused", () => {
  const secret = "2".repeat(64);
  for (const body of ["[1,2,3]", '"hello"', "7", "null", "{oops"]) {
    const text = JSON.stringify({ seq: 1, mac: protocol.macFor(secret, 1, body), body });
    const out = protocol.decodeEnvelope(secret, text);
    assert.strictEqual(out.ok, false, body);
    assert.match(out.reason, /malformed body/);
  }
});

/* ------------------------------------------------------------------ */
/* beacon                                                              */
/* ------------------------------------------------------------------ */

test("a beacon round-trips", () => {
  const id = protocol.newId();
  const buf = protocol.beaconMessage({ id, name: "workshop", hubVersion: "0.6.0", port: 9023 });
  assert.ok(Buffer.isBuffer(buf));
  assert.deepStrictEqual(protocol.parseBeacon(buf), { id, name: "workshop", hubVersion: "0.6.0", port: 9023 });
  // The magic marker is what keeps a stray datagram out.
  assert.strictEqual(JSON.parse(buf.toString("utf8")).nx, "fleet-beacon");
});

test("parseBeacon refuses everything that is not one", () => {
  const id = protocol.newId();
  const cases = [
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({ id, port: 9023 }), // no marker
    JSON.stringify({ nx: "something-else", id, port: 9023 }),
    JSON.stringify({ nx: "fleet-beacon", port: 9023 }), // no id
    JSON.stringify({ nx: "fleet-beacon", id: "nope", port: 9023 }),
    JSON.stringify({ nx: "fleet-beacon", id, port: 0 }),
    JSON.stringify({ nx: "fleet-beacon", id, port: 70000 }),
    JSON.stringify({ nx: "fleet-beacon", id, port: "9023" }),
    JSON.stringify({ nx: "fleet-beacon", id }),
  ];
  for (const text of cases) assert.strictEqual(protocol.parseBeacon(Buffer.from(text)), null, text);
  // An oversized datagram is dropped before JSON.parse ever sees it.
  assert.strictEqual(protocol.parseBeacon(Buffer.alloc(2048, 0x20)), null);
});

test("beacon strings are clamped, so a peer cannot bloat our records", () => {
  const id = protocol.newId();
  const parsed = protocol.parseBeacon(
    Buffer.from(JSON.stringify({ nx: "fleet-beacon", id, name: "x".repeat(500), hubVersion: "y".repeat(200), port: 1 }))
  );
  assert.strictEqual(parsed.name.length, 64);
  assert.strictEqual(parsed.hubVersion.length, 32);
});

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

const model = [
  {
    id: "wivrn-nx",
    name: "WiVRn NX",
    latest: { version: "0.6.1" },
    artifacts: [
      { id: "linux", label: "Linux app", installed: { version: "0.6.0" }, updateAvailable: true },
      { id: "android", label: "Quest APK", installed: null, updateAvailable: false },
    ],
  },
  {
    id: "facenx",
    name: "FaceNX",
    latest: { version: "1.2.0" },
    artifacts: [{ id: "linux", installed: { version: "1.2.0" }, updateAvailable: false }],
  },
  // Nothing installed and nothing pending: not worth a peer's attention.
  { id: "quadforge", name: "QuadForge", latest: { version: "0.1.0" }, artifacts: [{ id: "addon" }] },
];

test("buildSummary lists installed versions and update counts, ordinally sorted", () => {
  const summary = protocol.buildSummary(model, { hubVersion: "0.6.0", name: "workshop", id: "abc" });
  assert.strictEqual(summary.type, "summary");
  assert.strictEqual(summary.hubVersion, "0.6.0");
  assert.strictEqual(summary.name, "workshop");
  assert.deepStrictEqual(
    summary.apps.map((a) => a.id),
    ["facenx", "wivrn-nx"],
    "sorted by id, ordinally"
  );
  const wivrn = summary.apps.find((a) => a.id === "wivrn-nx");
  assert.strictEqual(wivrn.name, "WiVRn NX");
  assert.strictEqual(wivrn.latest, "0.6.1");
  assert.strictEqual(wivrn.updates, 1);
  assert.deepStrictEqual(wivrn.installed, [{ artifactId: "linux", label: "Linux app", version: "0.6.0" }]);
  assert.strictEqual(protocol.summaryUpdates(summary), 1);
});

test("buildSummary survives an empty or junk model", () => {
  for (const input of [[], null, undefined, [null, {}, { id: "" }]]) {
    const summary = protocol.buildSummary(input, {});
    assert.deepStrictEqual(summary.apps, []);
    assert.strictEqual(protocol.summaryUpdates(summary), 0);
  }
});

test("summaryHash tracks the apps and nothing else", () => {
  const one = protocol.buildSummary(model, { hubVersion: "0.6.0", name: "a", id: "1" });
  const same = protocol.buildSummary(model, { hubVersion: "9.9.9", name: "b", id: "2" });
  assert.strictEqual(protocol.summaryHash(one), protocol.summaryHash(same), "only the apps decide");

  const moved = JSON.parse(JSON.stringify(model));
  moved[0].artifacts[0].installed.version = "0.6.1";
  assert.notStrictEqual(protocol.summaryHash(one), protocol.summaryHash(protocol.buildSummary(moved, {})));
});

test("normalizeHost unwraps IPv4-mapped IPv6", () => {
  assert.strictEqual(protocol.normalizeHost("::ffff:192.168.1.5"), "192.168.1.5");
  assert.strictEqual(protocol.normalizeHost("192.168.1.5"), "192.168.1.5");
  assert.strictEqual(protocol.normalizeHost("::1"), "::1");
  assert.strictEqual(protocol.normalizeHost(null), "");
});
