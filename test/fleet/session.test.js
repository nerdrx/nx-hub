"use strict";
// Pairing and the HMAC session, over real loopback sockets on ephemeral ports.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");

const { protocol } = h;

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

/* ------------------------------------------------------------------ */
/* pairing                                                             */
/* ------------------------------------------------------------------ */

test("pairing with the right code stores the peer on BOTH hubs", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();

  const { code, expiresAt } = b.showCode();
  assert.match(code, /^[0-9]{6}$/);
  assert.ok(expiresAt > Date.now(), "the window must be in the future");
  assert.ok(
    b.events.some((e) => e.type === "fleet-pair-code" && e.code === code),
    "showCode() emits fleet-pair-code"
  );

  const peer = await a.pair("127.0.0.1", code, b.server.port);
  assert.strictEqual(peer.id, b.localId);

  // The initiator stored the responder…
  const storedOnA = a.store.getPeer(b.localId);
  assert.ok(storedOnA, "A knows B");
  assert.strictEqual(storedOnA.host, "127.0.0.1");
  assert.strictEqual(storedOnA.port, b.server.port);

  // …and the responder stored the initiator, learning the host from the socket.
  const storedOnB = b.store.getPeer(a.localId);
  assert.ok(storedOnB, "B knows A");
  assert.strictEqual(storedOnB.host, "127.0.0.1");

  // Same secret on both sides, derived, never transmitted.
  assert.strictEqual(storedOnA.secret, storedOnB.secret);
  assert.strictEqual(storedOnA.secret, protocol.deriveSecret(code, a.localId, b.localId));
});

test("a wrong code is refused and nothing is stored", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  b.showCode();

  await assert.rejects(() => a.pair("127.0.0.1", "000000", b.server.port), /not right|refused/i);
  assert.strictEqual(a.store.peers().length, 0);
  assert.strictEqual(b.store.peers().length, 0);
});

test("pairing without an open window is refused", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await assert.rejects(() => a.pair("127.0.0.1", "123456", b.server.port), /no pairing window/i);
  assert.strictEqual(a.store.peers().length, 0);
});

test("an expired code is refused even though it is the right code", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet({ overrides: { pairWindowMs: 20 } });
  const { code } = b.showCode();
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(() => a.pair("127.0.0.1", code, b.server.port), /expired|no pairing window/i);
  assert.strictEqual(b.store.peers().length, 0);
});

test("only one pairing window is live — showCode() twice invalidates the first", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  const first = b.showCode();
  const second = b.showCode();
  assert.notStrictEqual(first.code, second.code, "a fresh call mints a fresh code");
  await assert.rejects(() => a.pair("127.0.0.1", first.code, b.server.port), /not right/i);
  const peer = await a.pair("127.0.0.1", second.code, b.server.port);
  assert.strictEqual(peer.id, b.localId);
});

test("the code is consumed by nothing but time — the window survives a wrong guess", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  const { code } = b.showCode();
  await assert.rejects(() => a.pair("127.0.0.1", "999999", b.server.port), /not right/i);
  // A typo must not lock the human out of their own pairing window.
  const peer = await a.pair("127.0.0.1", code, b.server.port);
  assert.strictEqual(peer.id, b.localId);
});

test("code comparison is constant-time and length-blind", () => {
  assert.strictEqual(protocol.codeMatches("123456", "123456"), true);
  assert.strictEqual(protocol.codeMatches("123456", "123457"), false);
  // A shorter/longer candidate must not throw (timingSafeEqual demands equal
  // lengths — the hashing step is what makes this safe).
  assert.strictEqual(protocol.codeMatches("123456", ""), false);
  assert.strictEqual(protocol.codeMatches("123456", "12345678901234"), false);
  assert.strictEqual(protocol.codeMatches("123456", null), false);
});

/* ------------------------------------------------------------------ */
/* the authenticated session                                           */
/* ------------------------------------------------------------------ */

test("paired hubs bring a session up and exchange summaries", async () => {
  const discoveryA = h.fakeDiscovery([
    h.app("wivrn-nx", { name: "WiVRn NX", artifacts: [{ id: "linux", installed: { version: "0.6.1" } }] }),
  ]);
  const a = await h.startFleet({ discovery: discoveryA });
  const b = await h.startFleet({
    discovery: h.fakeDiscovery([h.app("pulsenx", { artifacts: [{ id: "linux", updateAvailable: true }] })]),
  });

  await h.pairHubs(a, b);

  // Whichever way arbitration fell, both hubs end up with one live session.
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);

  const onA = await h.waitUntil(() => a.getPeers().find((p) => p.summary) || false, 4000, "B's summary on A");
  assert.strictEqual(onA.id, b.localId);
  assert.strictEqual(onA.online, true);
  assert.strictEqual(onA.connected, true);
  assert.strictEqual(onA.summary.apps[0].id, "pulsenx");
  assert.strictEqual(onA.updates, 1);

  const onB = await h.waitUntil(() => b.getPeers().find((p) => p.summary) || false, 4000, "A's summary on B");
  assert.strictEqual(onB.summary.apps[0].installed[0].version, "0.6.1");
  assert.strictEqual(onB.updates, 0);
});

test("exactly one session per peer — the greater id dials, the lesser waits", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);

  // Give the dial sweep (25ms here) several chances to add a second one.
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(a.sessions.size, 1, "A holds one session");
  assert.strictEqual(b.sessions.size, 1, "B holds one session");

  const dialer = protocol.shouldDial(a.localId, b.localId) ? a : b;
  const waiter = dialer === a ? b : a;
  assert.strictEqual(dialer.sessions.get(waiter.localId).role, "client");
  assert.strictEqual(waiter.sessions.get(dialer.localId).role, "server");
});

test("shouldDial is deterministic, antisymmetric and never true for a tie", () => {
  assert.strictEqual(protocol.shouldDial("ffff000000000000", "0000000000000000"), true);
  assert.strictEqual(protocol.shouldDial("0000000000000000", "ffff000000000000"), false);
  assert.strictEqual(protocol.shouldDial("abcdef0123456789", "abcdef0123456789"), false);
});

test("a session survives the peer's summary changing", async () => {
  const discoveryB = h.fakeDiscovery([h.app("pulsenx", { artifacts: [{ id: "linux" }] })]);
  const a = await h.startFleet();
  const b = await h.startFleet({ discovery: discoveryB });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);

  discoveryB._set([
    h.app("pulsenx", { artifacts: [{ id: "linux", installed: { version: "2.0.0" } }] }),
    h.app("facenx", { artifacts: [{ id: "linux", updateAvailable: true }] }),
  ]);

  const peer = await h.waitUntil(
    () => {
      const p = a.getPeers().find((x) => x.id === b.localId);
      return p && p.summary && p.summary.apps.length === 2 ? p : false;
    },
    4000,
    "the changed summary to arrive"
  );
  assert.deepStrictEqual(
    peer.summary.apps.map((x) => x.id),
    ["facenx", "pulsenx"]
  );
  assert.strictEqual(peer.updates, 1);
});

/* ------------------------------------------------------------------ */
/* authentication, tampering, replay                                   */
/* ------------------------------------------------------------------ */

test("an unknown secret never gets past the challenge", async () => {
  const b = await h.startFleet();
  const a = await h.startFleet();
  await h.pairHubs(a, b);

  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  assert.strictEqual(challenge.type, "challenge");

  raw.sendPlain({
    type: "auth",
    id: a.localId,
    mac: protocol.authMac("f".repeat(64), challenge.nonce, a.localId),
  });
  const answer = await raw.next();
  assert.strictEqual(answer.type, "error");
  assert.match(answer.message, /unauthorized/i);
  await raw.untilClosed();
});

test("a stranger's id with nobody's secret is refused", async () => {
  const b = await h.startFleet();
  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  raw.sendPlain({ type: "auth", id: "0123456789abcdef", mac: "0".repeat(64) });
  const answer = await raw.next();
  assert.strictEqual(answer.type, "error");
  await raw.untilClosed();
  assert.ok(challenge.nonce);
});

test("a valid secret but somebody else's claimed id is refused", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  const secret = a.store.getPeer(b.localId).secret;

  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  // The MAC is computed correctly — but over an id that is not the one the
  // secret belongs to. identify() must not accept it.
  raw.sendPlain({
    type: "auth",
    id: "0123456789abcdef",
    mac: protocol.authMac(secret, challenge.nonce, "0123456789abcdef"),
  });
  const answer = await raw.next();
  assert.strictEqual(answer.type, "error");
  await raw.untilClosed();
});

test("a tampered message closes the session", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  const peer = a.store.getPeer(b.localId);

  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  raw.sendPlain({ type: "auth", id: a.localId, mac: protocol.authMac(peer.secret, challenge.nonce, a.localId) });
  const ready = await raw.next();
  assert.strictEqual(ready.type, "ready");

  // A well-formed envelope whose body was edited after the MAC was computed.
  const body = JSON.stringify({ type: "summary", apps: [] });
  const mac = protocol.macFor(peer.secret, 1, body);
  raw.sendRaw(JSON.stringify({ seq: 1, mac, body: JSON.stringify({ type: "install", appId: "anything" }) }));
  await raw.untilClosed();
});

test("a replayed message closes the session", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  const peer = a.store.getPeer(b.localId);

  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  raw.sendPlain({ type: "auth", id: a.localId, mac: protocol.authMac(peer.secret, challenge.nonce, a.localId) });
  await raw.next(); // ready

  const envelope = protocol.encodeEnvelope(peer.secret, 1, { type: "summary", id: a.localId, name: "a", apps: [] });
  raw.sendRaw(envelope);
  await new Promise((r) => setTimeout(r, 30));
  raw.sendRaw(envelope); // byte-identical replay: correct MAC, stale seq
  await raw.untilClosed();
});

test("a rewound sequence number closes the session too", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  const peer = a.store.getPeer(b.localId);

  const raw = await h.rawClient(b.server.port);
  const challenge = await raw.next();
  raw.sendPlain({ type: "auth", id: a.localId, mac: protocol.authMac(peer.secret, challenge.nonce, a.localId) });
  await raw.next();

  raw.sendRaw(protocol.encodeEnvelope(peer.secret, 9, { type: "summary", id: a.localId, name: "a", apps: [] }));
  await new Promise((r) => setTimeout(r, 30));
  raw.sendRaw(protocol.encodeEnvelope(peer.secret, 8, { type: "summary", id: a.localId, name: "a", apps: [] }));
  await raw.untilClosed();
});

test("a connection that says nothing is dropped when the grace expires", async () => {
  const b = await h.startFleet({ overrides: { authGraceMs: 60 } });
  const raw = await h.rawClient(b.server.port);
  await raw.next(); // the challenge
  await raw.untilClosed(2000);
});

test("garbage before authentication is a protocol error, not a crash", async () => {
  const b = await h.startFleet();
  const raw = await h.rawClient(b.server.port);
  await raw.next();
  raw.sendRaw("{not json");
  const answer = await raw.next();
  assert.strictEqual(answer.type, "error");
  await raw.untilClosed();
});

test("unpair drops the session and forgets the secret", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet();
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);

  assert.strictEqual(a.unpair(b.localId), true);
  assert.strictEqual(a.store.getPeer(b.localId), null);
  assert.strictEqual(a.sessions.size, 0);
  assert.strictEqual(a.getPeers().length, 0);
  assert.strictEqual(a.unpair(b.localId), false, "unpairing twice is a no-op");
});
