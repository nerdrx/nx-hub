"use strict";
// fleet.json — minting, round-tripping, and refusing to keep junk.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const h = require("./helpers");

const { createStore, sanitize, sanitizePeer } = h.store;
const { protocol } = h;

test.after(() => h.cleanupTempDirs());

function peer(overrides = {}) {
  return Object.assign(
    {
      id: protocol.newId(),
      name: "workshop",
      host: "192.168.1.20",
      port: 9023,
      secret: protocol.deriveSecret("123456", protocol.newId(), protocol.newId()),
      lastSeen: Date.now(),
    },
    overrides
  );
}

test("the id is minted once and survives a reload", () => {
  const dir = h.tempDataDir();
  const store = createStore(dir);
  const first = store.load();
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.ok(first.name, "the hostname is the default name");
  assert.deepStrictEqual(first.peers, []);

  assert.strictEqual(createStore(dir).load().id, first.id, "a second process reads the same id");
  assert.strictEqual(store.load().id, first.id, "and so does a second call");
});

test("fleet.json is written 0600 — it holds shared secrets", { skip: process.platform === "win32" }, () => {
  const dir = h.tempDataDir();
  const store = createStore(dir);
  store.load();
  assert.strictEqual(fs.statSync(store.path).mode & 0o777, 0o600);
  store.upsertPeer(peer());
  assert.strictEqual(fs.statSync(store.path).mode & 0o777, 0o600);
});

test("a peer round-trips through disk unchanged", () => {
  const dir = h.tempDataDir();
  const store = createStore(dir);
  const p = peer();
  store.upsertPeer(p);

  const reread = createStore(dir).getPeer(p.id);
  assert.deepStrictEqual(reread, p);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, "fleet.json"), "utf8"));
  assert.strictEqual(raw.peers.length, 1);
  assert.strictEqual(raw.peers[0].secret, p.secret);
});

test("upsert replaces by id and keeps the list unique and sorted", () => {
  const store = createStore(h.tempDataDir());
  const a = peer({ id: "ffffffffffffffff", name: "attic" });
  const b = peer({ id: "0000000000000000", name: "basement" });
  store.upsertPeer(a);
  store.upsertPeer(b);
  store.upsertPeer(Object.assign({}, a, { name: "attic renamed", host: "10.0.0.9" }));

  const peers = store.peers();
  assert.strictEqual(peers.length, 2);
  assert.deepStrictEqual(
    peers.map((p) => p.id),
    ["0000000000000000", "ffffffffffffffff"],
    "ordinal sort, never localeCompare"
  );
  assert.strictEqual(store.getPeer(a.id).name, "attic renamed");
  assert.strictEqual(store.getPeer(a.id).host, "10.0.0.9");
});

test("touchPeer moves the address without touching the secret", () => {
  const store = createStore(h.tempDataDir());
  const p = peer();
  store.upsertPeer(p);
  store.touchPeer(p.id, { host: "10.0.0.5", port: 9999, name: "moved", persist: true });
  const after = store.getPeer(p.id);
  assert.strictEqual(after.host, "10.0.0.5");
  assert.strictEqual(after.port, 9999);
  assert.strictEqual(after.name, "moved");
  assert.strictEqual(after.secret, p.secret, "a secret is only ever set by pairing");
  assert.strictEqual(store.touchPeer("0123456789abcdef", { host: "x" }), null, "an unknown id is a no-op");
});

test("removePeer reports whether it did anything", () => {
  const store = createStore(h.tempDataDir());
  const p = peer();
  store.upsertPeer(p);
  assert.strictEqual(store.removePeer(p.id), true);
  assert.strictEqual(store.removePeer(p.id), false);
  assert.deepStrictEqual(store.peers(), []);
});

test("a malformed peer is never stored", () => {
  const store = createStore(h.tempDataDir());
  for (const bad of [
    null,
    {},
    peer({ id: "nope" }),
    peer({ secret: "short" }),
    peer({ secret: null }),
    peer({ host: "" }),
    peer({ host: null }),
  ]) {
    assert.throws(() => store.upsertPeer(bad), /malformed peer/);
  }
  assert.deepStrictEqual(store.peers(), []);
});

test("a corrupt or hostile fleet.json degrades to an empty, usable one", () => {
  const dir = h.tempDataDir();
  fs.writeFileSync(path.join(dir, "fleet.json"), "{ this is not json");
  const store = createStore(dir);
  const data = store.load();
  assert.match(data.id, /^[0-9a-f]{16}$/, "a fresh id rather than a dead hub");
  assert.deepStrictEqual(data.peers, []);
});

test("junk entries are dropped on load, good ones survive", () => {
  const dir = h.tempDataDir();
  const good = peer();
  fs.writeFileSync(
    path.join(dir, "fleet.json"),
    JSON.stringify({
      id: "0123456789abcdef",
      name: "bench",
      peers: [good, { id: "bad" }, null, "nonsense", Object.assign({}, good, { secret: "x" })],
    })
  );
  const store = createStore(dir);
  assert.strictEqual(store.load().id, "0123456789abcdef");
  assert.deepStrictEqual(store.peers(), [good]);
});

test("a duplicated id in the file collapses to one peer", () => {
  const dir = h.tempDataDir();
  const p = peer();
  fs.writeFileSync(
    path.join(dir, "fleet.json"),
    JSON.stringify({ id: protocol.newId(), name: "x", peers: [p, Object.assign({}, p, { host: "10.0.0.1" })] })
  );
  assert.strictEqual(createStore(dir).peers().length, 1);
});

test("sanitize/sanitizePeer are pure and defensive", () => {
  assert.deepStrictEqual(sanitize(null), { id: null, name: null, peers: [] });
  assert.deepStrictEqual(sanitize([]), { id: null, name: null, peers: [] });
  assert.deepStrictEqual(sanitize({ peers: "nope" }).peers, []);
  assert.strictEqual(sanitizePeer(peer({ port: 0 })).port, protocol.FLEET_PORT, "a junk port falls back to the default");
  assert.strictEqual(sanitizePeer(peer({ name: "" })).name.length, 16, "a nameless peer answers to its id");
  assert.strictEqual(sanitizePeer(peer({ name: "z".repeat(200) })).name.length, 64);
});
