"use strict";
// The vendored drop-in client (docs/connector/nx-connector.js) driven against
// the real bus. Every assertion here is also a check on the server's
// masked-frame handling, since this client masks everything it sends.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const path = require("path");

const h = require("./helpers");
const nx = require("../../docs/connector/nx-connector");

const { server } = h;

test.after(() => h.cleanupTempDirs());

test("the client round-trips against the bus: hello, status, bye", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const client = nx.connect({
    app: "PulseNX",
    version: "1.2.1",
    url: bus.url,
    tokenPath: bus.tokenFile,
  });
  t.after(() => client.close());

  const welcome = await h.once(client, "connected");
  assert.strictEqual(welcome.hub, "9.9.9", "the hub version comes back in welcome");
  assert.strictEqual(client.connected(), true);

  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");
  const [entry] = server.getClients();
  assert.strictEqual(entry.app, "pulsenx");
  assert.strictEqual(entry.version, "1.2.1");
  assert.strictEqual(entry.pid, process.pid);
  assert.deepStrictEqual(entry.caps, ["status"]);

  assert.strictEqual(client.sendStatus({ hr: 72, connected: true }), true);
  await h.waitUntil(() => server.getClients()[0].fields.hr === 72, 2000, "status");
  assert.deepStrictEqual(server.getClients()[0].fields, { hr: 72, connected: true });

  client.close();
  await h.waitUntil(() => !server.isPresent("pulsenx"), 2000, "bye landed");
});

test("sendStatus drops instead of buffering while disconnected", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const client = nx.connect({ app: "pulsenx", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => client.close());

  // Before the handshake finishes there is nowhere to put it.
  assert.strictEqual(client.sendStatus({ hr: 1 }), false);
  assert.strictEqual(client.connected(), false);

  await h.once(client, "connected");
  assert.strictEqual(client.sendStatus({ hr: 2 }), true);
  await h.waitUntil(() => server.getClients()[0].fields.hr === 2, 2000, "live status");

  // Nothing queued from the disconnected period may arrive late.
  assert.deepStrictEqual(server.getClients()[0].fields, { hr: 2 });
  assert.strictEqual(client.sendStatus(null), false, "junk is refused, not thrown");
});

test("the client answers hub pings and is never reaped", async (t) => {
  const bus = await h.startBus({ pingMs: 25, reapMs: 80 });
  t.after(() => bus.stop());

  const client = nx.connect({ app: "pulsenx", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => client.close());
  await h.once(client, "connected");

  await new Promise((r) => setTimeout(r, 350)); // several reap windows
  assert.strictEqual(server.isPresent("pulsenx"), true, "the pong keepalive held the slot");
  assert.strictEqual(client.connected(), true);
});

test("shutdown-request reaches the app", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const client = nx.connect({ app: "pulsenx", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => client.close());
  await h.once(client, "connected");
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  const asked = h.once(client, "shutdown-request");
  assert.strictEqual(server.requestShutdown("pulsenx"), true);
  await asked; // rejects on timeout
});

test("closing the hub gives the client a disconnected event", async (t) => {
  const bus = await h.startBus();
  const client = nx.connect({ app: "pulsenx", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => client.close());

  await h.once(client, "connected");
  const dropped = h.once(client, "disconnected");
  await bus.stop();
  await dropped;
  assert.strictEqual(client.connected(), false);
});

test("the client reconnects and re-hellos after the hub restarts", async (t) => {
  const port = await h.freePort();
  const dataDir = h.tempDataDir();

  const first = await h.startBus({ port, dataDir });
  const client = nx.connect({ app: "pulsenx", version: "1.2.1", url: `ws://127.0.0.1:${port}`, tokenPath: first.tokenFile });
  t.after(() => client.close());

  await h.once(client, "connected");
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "first presence");

  // Take the hub down for real — close() resolves once the port is released.
  const dropped = h.once(client, "disconnected");
  await first.stop();
  await dropped;
  assert.strictEqual(client.connected(), false);

  // Same port, same data dir, so the same token: the client must find its way
  // back on its own (default 1s backoff — no nudging from the test).
  const second = await h.startBus({ port, dataDir });
  t.after(() => second.stop());
  assert.strictEqual(second.token, first.token);

  await h.once(client, "connected", 8000);
  await h.waitUntil(() => server.isPresent("pulsenx"), 4000, "re-hello");
  const [entry] = server.getClients();
  assert.strictEqual(entry.version, "1.2.1", "the re-hello carries the same identity");

  // And it is a working connection, not just an open socket.
  client.sendStatus({ hr: 99 });
  await h.waitUntil(() => server.getClients()[0].fields.hr === 99, 3000, "status after reconnect");
});

test("an app may start before the hub has ever run (token read lazily)", async (t) => {
  const port = await h.freePort();
  const dataDir = h.tempDataDir();
  const tokenFile = path.join(dataDir, "connector.token");
  assert.strictEqual(fs.existsSync(tokenFile), false, "no token yet — no hub has ever run");

  const client = nx.connect({
    app: "pulsenx",
    url: `ws://127.0.0.1:${port}`,
    tokenPath: tokenFile,
    minBackoffMs: 40,
    maxBackoffMs: 120,
  });
  t.after(() => client.close());

  // Retrying against nothing at all for a while must be harmless.
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(client.connected(), false);

  const bus = await h.startBus({ port, dataDir });
  t.after(() => bus.stop());

  await h.once(client, "connected", 5000);
  await h.waitUntil(() => server.isPresent("pulsenx"), 3000, "late presence");
});

test("no hub means no noise: no throws, no events, no console output", async (t) => {
  const port = await h.freePort();
  const dataDir = h.tempDataDir();

  const seen = [];
  const client = nx.connect({
    app: "pulsenx",
    url: `ws://127.0.0.1:${port}`,
    tokenPath: path.join(dataDir, "connector.token"),
    minBackoffMs: 20,
    maxBackoffMs: 40,
  });
  t.after(() => client.close());
  for (const ev of ["connected", "disconnected", "shutdown-request", "error"]) {
    client.on(ev, () => seen.push(ev));
  }

  // A vendored library that chatters at a user's terminal is a bug.
  const real = { log: console.log, warn: console.warn, error: console.error };
  let noise = 0;
  console.log = console.warn = console.error = () => {
    noise += 1;
  };
  try {
    await new Promise((r) => setTimeout(r, 250)); // many retry rounds
  } finally {
    Object.assign(console, real);
  }

  assert.strictEqual(noise, 0, "the client must stay silent when no hub is running");
  assert.deepStrictEqual(seen, [], "and must not fire events it has no news for");
  assert.strictEqual(client.connected(), false);
});

test("a foreign listener on the port is rejected, quietly, and retried", async (t) => {
  const dataDir = h.tempDataDir();
  fs.writeFileSync(path.join(dataDir, "connector.token"), `${"a".repeat(32)}\n`);

  // Something that accepts TCP but is not the bus (wrong Sec-WebSocket-Accept).
  let hits = 0;
  const impostor = net.createServer((sock) => {
    hits += 1;
    sock.on("data", () => sock.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
    sock.on("error", () => {});
  });
  await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => impostor.close(r)));

  const client = nx.connect({
    app: "pulsenx",
    url: `ws://127.0.0.1:${impostor.address().port}`,
    tokenPath: path.join(dataDir, "connector.token"),
    minBackoffMs: 20,
    maxBackoffMs: 40,
  });
  t.after(() => client.close());

  await h.waitUntil(() => hits >= 2, 3000, "the client kept retrying");
  assert.strictEqual(client.connected(), false, "a non-WS responder is never treated as the hub");
});

test("a bad token leaves the client disconnected without throwing", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const wrongDir = h.tempDataDir();
  const wrongToken = path.join(wrongDir, "connector.token");
  fs.writeFileSync(wrongToken, `${"b".repeat(32)}\n`);

  const client = nx.connect({
    app: "pulsenx",
    url: bus.url,
    tokenPath: wrongToken,
    minBackoffMs: 30,
    maxBackoffMs: 60,
  });
  t.after(() => client.close());

  const failed = h.once(client, "error", 3000);
  const err = await failed;
  assert.match(err.message, /unauthorized/);
  assert.strictEqual(client.connected(), false);
  assert.strictEqual(server.isPresent("pulsenx"), false);
});

test("close() is idempotent and stops the reconnect loop for good", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const client = nx.connect({ app: "pulsenx", url: bus.url, tokenPath: bus.tokenFile, minBackoffMs: 20 });
  await h.once(client, "connected");
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "presence");

  client.close();
  client.close(); // must not throw
  await h.waitUntil(() => !server.isPresent("pulsenx"), 2000, "gone");

  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(server.isPresent("pulsenx"), false, "a closed client never comes back");
  assert.strictEqual(client.connected(), false);
  assert.strictEqual(client.sendStatus({ hr: 1 }), false);
});

test("two apps share the bus without stepping on each other", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const a = nx.connect({ app: "pulsenx", version: "1.0.0", url: bus.url, tokenPath: bus.tokenFile });
  const b = nx.connect({ app: "quadforge", version: "2.0.0", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => {
    a.close();
    b.close();
  });

  await Promise.all([h.once(a, "connected"), h.once(b, "connected")]);
  await h.waitUntil(() => server.getClients().length === 2, 2000, "both present");

  a.sendStatus({ hr: 72 });
  b.sendStatus({ faces: 1200 });
  await h.waitUntil(() => {
    const list = server.getClients();
    return list.length === 2 && list[0].fields.hr === 72 && list[1].fields.faces === 1200;
  }, 2000, "both statuses");

  // getClients is sorted by app id, ordinally (the host may be de_DE).
  assert.deepStrictEqual(
    server.getClients().map((c) => c.app),
    ["pulsenx", "quadforge"]
  );

  a.close();
  await h.waitUntil(() => !server.isPresent("pulsenx"), 2000, "one left");
  assert.strictEqual(server.isPresent("quadforge"), true, "the other is untouched");
});

test("the default token path points at the hub data dir", () => {
  const prev = process.env.NX_HUB_DATA_DIR;
  process.env.NX_HUB_DATA_DIR = "/tmp/nx-hub-fake";
  try {
    assert.strictEqual(nx.defaultTokenPath(), path.join("/tmp/nx-hub-fake", "connector.token"));
  } finally {
    if (prev === undefined) delete process.env.NX_HUB_DATA_DIR;
    else process.env.NX_HUB_DATA_DIR = prev;
  }
});

test("a client that reconnects supersedes its own stale slot", async (t) => {
  const bus = await h.startBus();
  t.after(() => bus.stop());

  const first = nx.connect({ app: "pulsenx", version: "1.0.0", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => first.close());
  await h.once(first, "connected");
  await h.waitUntil(() => server.isPresent("pulsenx"), 2000, "first");

  // A second process for the same app: latest hello wins, presence never blinks.
  const second = nx.connect({ app: "pulsenx", version: "1.1.0", url: bus.url, tokenPath: bus.tokenFile });
  t.after(() => second.close());
  await h.once(second, "connected");
  await h.waitUntil(() => server.getClients()[0].version === "1.1.0", 3000, "superseded");

  assert.strictEqual(server.getClients().length, 1, "still exactly one slot");
  assert.strictEqual(server.isPresent("pulsenx"), true);
});
