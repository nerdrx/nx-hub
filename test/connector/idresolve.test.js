"use strict";
// v0.12: the bus translates the name a client calls itself into the hub's own
// app id at hello.
//
// Why this exists: a repo discovered from a non-primary source is keyed
// "<owner>--<name>", but its app announces itself as the name it knows — the
// bare repo name. Everything downstream (presence, Stop, stack connector gates,
// the federated roster, the LIVE strip) matches on the hub's id, so without the
// translation an app of any non-primary owner is on the bus and invisible.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");
const server = h.server;

test.after(() => h.cleanupTempDirs());

test("hello resolves a client's own name to the hub's app id", async (t) => {
  const bus = await h.startBus({
    resolveAppId: (id) => (id === "vrcx-modschnitstelle" ? "arikazei--vrcx-modschnitstelle" : id),
  });
  t.after(() => bus.stop());
  const client = await h.rawConnect(bus.port);
  t.after(() => client.close());

  client.hello({ token: bus.token, app: "vrcx-modschnitstelle", version: "1.0.0", pid: 4242 });
  assert.strictEqual((await client.next()).type, "welcome");
  await h.waitUntil(() => server.isPresent("arikazei--vrcx-modschnitstelle"), 4000, "presence");

  assert.ok(server.isPresent("arikazei--vrcx-modschnitstelle"), "found under the id the HUB uses");
  assert.ok(!server.isPresent("vrcx-modschnitstelle"), "not under the name the client sent");

  const entry = server.getClients().find((c) => c.app === "arikazei--vrcx-modschnitstelle");
  assert.ok(entry, "the roster carries the resolved id");
  assert.strictEqual(entry.pid, 4242, "everything else about the client is untouched");
  assert.strictEqual(entry.version, "1.0.0");
  assert.ok(
    bus.logs.some((l) => l.includes("vrcx-modschnitstelle -> arikazei--vrcx-modschnitstelle")),
    `the translation is logged: ${bus.logs.join(" | ")}`
  );
});

// A bus that cannot reach discovery — the CLI's, an older build, a resolver that
// throws on an id it has never heard of — must behave exactly as it always did.
for (const [label, opts] of [
  ["unwired", {}],
  [
    "throwing",
    {
      resolveAppId: () => {
        throw new Error("discovery is empty");
      },
    },
  ],
  ["answering with nothing", { resolveAppId: () => "" }],
]) {
  test(`a ${label} resolver leaves the client's own name alone`, async (t) => {
    const bus = await h.startBus(opts);
    t.after(() => bus.stop());
    const client = await h.rawConnect(bus.port);
    t.after(() => client.close());

    client.hello({ token: bus.token, app: "pulsenx", version: "2.0.0" });
    assert.strictEqual((await client.next()).type, "welcome");
    await h.waitUntil(() => server.isPresent("pulsenx"), 4000, `${label} presence`);
    assert.ok(server.isPresent("pulsenx"), "the app keeps its bus either way");
  });
}
