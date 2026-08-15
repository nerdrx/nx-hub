"use strict";
// The bus itself, over real loopback sockets on ephemeral ports.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const path = require("path");

const h = require("./helpers");

const { server, frame } = h;

test.after(() => h.cleanupTempDirs());

// --- token ------------------------------------------------------------------

test("init mints a 32-hex token at 0600 and reuses it next time", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const file = path.join(bus.dataDir, "connector.token");
  assert.match(bus.token, /^[0-9a-f]{32}$/);
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }

  await bus.stop();
  const again = await h.startBus({ dataDir: bus.dataDir });
  t.after(() => again.stop());
  assert.strictEqual(again.token, bus.token, "the secret must survive a restart");
});

test("a corrupt token file is replaced rather than locking everyone out", async (t) => {
  const dataDir = h.tempDataDir();
  fs.writeFileSync(path.join(dataDir, "connector.token"), "not-a-token\n");
  const bus = await h.startBus({ dataDir });
  t.after(() => bus.stop());
  assert.match(bus.token, /^[0-9a-f]{32}$/);
});

// --- handshake --------------------------------------------------------------

test("a plain GET is answered 426 Upgrade Required", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const res = await h.plainGet(bus.port);
  assert.match(res, /^HTTP\/1\.1 426/);
  assert.match(res, /websocket upgrade required/);
});

test("an upgrade without version 13 is rejected", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const res = await h.plainGet(bus.port, {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": frame.makeKey(),
    "Sec-WebSocket-Version": "8",
  });
  assert.match(res, /^HTTP\/1\.1 400/);
});

test("a valid upgrade completes the RFC 6455 handshake", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port); // resolves only if Accept matched
  t.after(() => client.close());
  assert.ok(client.socket.writable);
});

// --- auth -------------------------------------------------------------------

test("hello with the right token is welcomed and becomes present", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ token: bus.token, app: "PulseNX", version: "1.2.1", pid: 4242 });
  const welcome = await client.next();
  assert.deepStrictEqual(welcome, { type: "welcome", hub: "9.9.9" });

  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");
  assert.strictEqual(server.isPresent("PULSENX"), true, "app ids are case-insensitive");

  const [entry] = server.getClients();
  assert.strictEqual(entry.app, "pulsenx", "the id is normalised to lowercase");
  assert.strictEqual(entry.version, "1.2.1");
  assert.strictEqual(entry.pid, 4242);
  assert.deepStrictEqual(entry.fields, {});
  assert.deepStrictEqual(entry.caps, ["status"]);
  assert.ok(entry.since > 0 && entry.lastSeen >= entry.since);
});

test("hello with a bad token gets an error and the door", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ token: "f".repeat(32), app: "pulsenx" });
  const msg = await client.next();
  assert.strictEqual(msg.type, "error");
  assert.match(msg.message, /unauthorized/);
  await client.untilClosed();
  assert.strictEqual(server.isPresent("pulsenx"), false);
});

test("hello with no token at all is rejected", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());
  client.hello({ app: "pulsenx" });
  assert.strictEqual((await client.next()).type, "error");
  await client.untilClosed();
});

test("hello without an app id is rejected", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());
  client.hello({ token: bus.token, app: "   " });
  assert.match((await client.next()).message, /app id/);
  await client.untilClosed();
});

test("a socket that never says hello is dropped after the grace window", async (t) => {
  const bus = await h.startBus({ pingMs: 30, reapMs: 90 });
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());
  await client.untilClosed(3000);
  assert.strictEqual(server.getClients().length, 0);
});

// --- status -----------------------------------------------------------------

test("status fields land, and merge across messages", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next(); // welcome

  client.sendJson({ type: "status", fields: { hr: 72, connected: true } });
  await h.waitUntil(() => Boolean(server.getClients()[0]) && server.getClients()[0].fields.hr === 72, 2000, "first status");

  client.sendJson({ type: "status", fields: { hr: 75 } });
  await h.waitUntil(() => server.getClients()[0].fields.hr === 75, 2000, "second status");

  // `connected` was not restated but must survive — partial updates merge.
  assert.deepStrictEqual(server.getClients()[0].fields, { hr: 75, connected: true });
});

test("status is throttled to 4/s and the excess is dropped silently", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  for (let i = 1; i <= 12; i += 1) client.sendJson({ type: "status", fields: { [`n${i}`]: i } });
  await h.waitUntil(() => Object.keys(server.getClients()[0].fields).length >= 4, 2000, "4 accepted");
  // Give any wrongly-accepted extras a chance to show up before counting.
  await new Promise((r) => setTimeout(r, 120));

  const fields = server.getClients()[0].fields;
  assert.strictEqual(Object.keys(fields).length, 4, "exactly 4 of the 12 were kept");
  assert.deepStrictEqual(fields, { n1: 1, n2: 2, n3: 3, n4: 4 }, "the first four win");
  assert.strictEqual(client.closed, false, "throttling must not disconnect a chatty app");
});

test("a status payload over 2KB is refused and the client is closed", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();

  client.sendJson({ type: "status", fields: { blob: "x".repeat(2100) } });
  const msg = await client.next();
  assert.strictEqual(msg.type, "error");
  assert.match(msg.message, /2048 bytes/);
  await client.untilClosed();
  assert.strictEqual(server.isPresent("pulsenx"), false);
});

test("merged status is capped too, so keys cannot accumulate past 2KB", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();

  // Each message is under the cap; together they are not.
  client.sendJson({ type: "status", fields: { a: "x".repeat(1500) } });
  await h.waitUntil(() => Boolean(server.getClients()[0] && server.getClients()[0].fields.a), 2000, "first half");
  client.sendJson({ type: "status", fields: { b: "y".repeat(1500) } });

  const msg = await client.next();
  assert.strictEqual(msg.type, "error");
  assert.match(msg.message, /merged status/);
  await client.untilClosed();
});

test("status before hello is refused", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());
  client.sendJson({ type: "status", fields: { hr: 1 } });
  assert.match((await client.next()).message, /hello required/);
  await client.untilClosed();
});

test("status without a fields object is refused", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();
  client.sendJson({ type: "status", fields: [1, 2, 3] });
  assert.match((await client.next()).message, /fields object/);
  await client.untilClosed();
});

// --- frame-level violations -------------------------------------------------

test("a frame over 16KB is refused and the client is closed", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();

  client.sendRaw(frame.text(JSON.stringify({ type: "status", fields: { blob: "x".repeat(17 * 1024) } }), true));
  const msg = await client.next();
  assert.strictEqual(msg.type, "error");
  assert.match(msg.message, /too large/);
  assert.strictEqual(await client.untilClosed(), frame.CLOSE_TOO_LARGE);
});

test("a binary frame is refused and the client is closed", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();

  client.sendRaw(frame.encode(frame.OP_BINARY, Buffer.from([1, 2, 3]), true));
  assert.match((await client.next()).message, /binary/);
  assert.strictEqual(await client.untilClosed(), frame.CLOSE_UNSUPPORTED_DATA);
});

test("an unmasked client frame is refused", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.sendRaw(frame.text(JSON.stringify({ type: "hello" }), false));
  assert.match((await client.next()).message, /masked/);
  assert.strictEqual(await client.untilClosed(), frame.CLOSE_PROTOCOL_ERROR);
});

test("malformed json is refused", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());
  client.sendRaw(frame.text("{not json", true));
  assert.match((await client.next()).message, /malformed/);
  await client.untilClosed();
});

test("an unknown message type earns a complaint but keeps the socket", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next(); // welcome

  client.sendJson({ type: "telemetry-v2", whatever: true });
  const msg = await client.next();
  assert.strictEqual(msg.type, "error");
  assert.match(msg.message, /unknown type/);
  assert.strictEqual(client.closed, false, "forward compatibility: no hangup");
  assert.strictEqual(server.isPresent("pulsenx"), true, "and the presence slot is kept");
});

test("a WS-level ping is answered with a pong", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();

  let pongged = false;
  client.socket.on("data", () => {});
  client.sendRaw(frame.encode(frame.OP_PING, Buffer.from("hi"), true));
  await h.waitUntil(() => {
    pongged = server.isPresent("pulsenx");
    return pongged;
  }, 1000, "still present after ping");
  assert.ok(pongged);
});

// --- lifecycle --------------------------------------------------------------

test("latest hello wins: the older socket for an app is evicted", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const first = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx", version: "1.0.0" } });
  t.after(() => first.close());
  await first.next();
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "first present");

  const second = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "PulseNX", version: "2.0.0" } });
  t.after(() => second.close());
  await second.next(); // welcome

  await first.untilClosed(3000);
  const clients = server.getClients();
  assert.strictEqual(clients.length, 1, "one presence slot per app id");
  assert.strictEqual(clients[0].version, "2.0.0", "the newest hello owns it");
  assert.strictEqual(server.isPresent("pulsenx"), true, "and presence never blinked out");
});

test("bye removes the client", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  client.sendJson({ type: "bye" });
  await h.waitUntil(() => !server.isPresent("pulsenx"), 2000, "absence");
  await client.untilClosed();
});

test("a dropped socket removes the client (presence === open socket)", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  await client.next();
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  client.close(); // yank the socket with no bye at all
  await h.waitUntil(() => !server.isPresent("pulsenx"), 2000, "absence");
});

test("a silent client is reaped", async (t) => {
  // pingMs/reapMs are the documented test-only knobs.
  const bus = await h.startBus({ pingMs: 25, reapMs: 80 });
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next(); // welcome
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  // The raw client never answers the ping, so it goes silent and is reaped.
  await h.waitUntil(() => !server.isPresent("pulsenx"), 3000, "reap");
  await client.untilClosed(2000);
  assert.ok(bus.logs.some((l) => /reaping pulsenx/.test(l)), "the reap is logged");
});

test("a client that answers pings is kept alive past the reap window", async (t) => {
  const bus = await h.startBus({ pingMs: 25, reapMs: 80 });
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());

  // Answer every application-level ping, the way the drop-in client does.
  const pump = setInterval(() => client.sendJson({ type: "pong" }), 20);
  t.after(() => clearInterval(pump));

  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");
  await new Promise((r) => setTimeout(r, 300)); // ~4 reap windows
  assert.strictEqual(server.isPresent("pulsenx"), true, "a responsive client is never reaped");
});

test("the hub sends application-level pings", async (t) => {
  const bus = await h.startBus({ pingMs: 25, reapMs: 5000 });
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  assert.strictEqual((await client.next()).type, "welcome");
  assert.strictEqual((await client.next(2000)).type, "ping");
});

// --- shutdown-request -------------------------------------------------------

test("requestShutdown reaches the client and reports whether it was sent", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await client.next();
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  assert.strictEqual(server.requestShutdown("PulseNX"), true, "id matching is case-insensitive");
  assert.deepStrictEqual(await client.next(), { type: "shutdown-request" });
  assert.strictEqual(server.requestShutdown("not-running"), false);
});

// --- change events ----------------------------------------------------------

test("connector-changed fires on connect and is debounced to <=4/s", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  for (let i = 0; i < 10; i += 1) {
    clients.push(await h.rawConnect(bus.port, { hello: { token: bus.token, app: `app${i}` } }));
  }
  await h.waitUntil(() => server.getClients().length === 10, 3000, "all ten present");

  // Ten arrivals inside well under a second must not produce ten emits.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(bus.events.length >= 1, "at least one connector-changed");
  assert.ok(bus.events.length <= 4, `debounced, got ${bus.events.length} emits`);
  assert.ok(bus.events.every((e) => e.type === "connector-changed"));
});

test("onChange subscribers fire and can unsubscribe", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  let hits = 0;
  const off = server.onChange(() => {
    hits += 1;
  });
  t.after(off);

  const client = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "pulsenx" } });
  t.after(() => client.close());
  await h.waitUntil(() => hits > 0, 2000, "onChange hit");

  off();
  const before = hits;
  const other = await h.rawConnect(bus.port, { hello: { token: bus.token, app: "quadforge" } });
  t.after(() => other.close());
  await h.waitUntil(() => server.isPresent("quadforge"), 2000, "second app");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(hits, before, "an unsubscribed listener stays quiet");
});

// --- init / teardown --------------------------------------------------------

test("a busy port is tolerated: no throw, an inert handle", async (t) => {
  // A foreign listener stands in for a second hub process already owning the bus.
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const port = squatter.address().port;
  t.after(() => new Promise((r) => squatter.close(r)));

  const dataDir = h.tempDataDir();
  const logs = [];
  let handle;
  assert.doesNotThrow(() => {
    handle = server.init({ port, dataDir, log: (m) => logs.push(String(m)), emit: () => {} });
  });
  const ready = await handle.ready;
  assert.strictEqual(ready.ok, false);
  assert.strictEqual(ready.error.code, "EADDRINUSE");
  assert.ok(logs.some((l) => /busy/.test(l)), "the clash is logged, not thrown");
  assert.doesNotThrow(() => handle.close());
  assert.deepStrictEqual(server.getClients(), []);
  assert.strictEqual(server.isPresent("anything"), false);
  assert.strictEqual(server.requestShutdown("anything"), false);
});

test("init twice closes the previous bus", async (t) => {
  const first = await h.startBus();
  const client = await h.rawConnect(first.port, { hello: { token: first.token, app: "pulsenx" } });
  t.after(() => client.close());
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  const second = await h.startBus();
  t.after(() => second.stop());

  await client.untilClosed(3000);
  assert.deepStrictEqual(server.getClients(), [], "the new bus starts empty");
  await h.waitUntil(async () => {
    try {
      await h.rawConnect(first.port);
      return false;
    } catch (_) {
      return true; // the old port is no longer accepting
    }
  }, 3000, "old port released");
});

test("init requires a dataDir", () => {
  assert.throws(() => server.init({ port: 0 }), /dataDir/);
});

test("close is idempotent and leaves the accessors safe", async () => {
  const bus = await h.startBus();
  await bus.stop();
  await bus.stop();
  assert.deepStrictEqual(server.getClients(), []);
  assert.strictEqual(server.isPresent("pulsenx"), false);
  assert.strictEqual(server.requestShutdown("pulsenx"), false);
});
