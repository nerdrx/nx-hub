"use strict";
// v0.10 [fabric2] — fleet settings sync (SPEC "Fleet settings sync").
//
// Two real hubs on loopback, each with its OWN settings.json and stacks.json in
// a temp dir (see helpers.syncEnv — the sanitisers are the real modules', only
// the paths are the test's; the machine running this has a live hub whose
// settings must never be touched).
//
// What is being pinned down here is the part that is hard to get right: last
// writer wins per entry, the stamps travel rather than being reminted, a merge
// that changed nothing says nothing, and a peer's payload is data rather than
// instructions.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");

const sync = require("../../src/main/fleet/sync");
const realConfig = require("../../src/main/config");
const realStacks = require("../../src/main/stacks");

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

const T0 = 1_700_000_000_000;

function stackOf(id, appId, { at } = {}) {
  const s = { id, name: id.toUpperCase(), steps: [{ appId, health: { type: "delay", timeoutMs: 0 } }] };
  if (at != null) s.updatedAt = at;
  return s;
}

/** Two paired hubs, each with a real-ish settings store of its own. */
async function pair({ prefsDebounceMs = 15 } = {}) {
  const envA = h.syncEnv(h.tempDataDir("nxhub-sync-a-"));
  const envB = h.syncEnv(h.tempDataDir("nxhub-sync-b-"));
  const a = await h.startFleet({
    overrides: { syncConfig: envA.config, stacks: envA.stacks, prefsDebounceMs, rosterIntervalMs: 20 },
  });
  const b = await h.startFleet({
    overrides: { syncConfig: envB.config, stacks: envB.stacks, prefsDebounceMs, rosterIntervalMs: 20 },
  });
  return { a, b, envA, envB };
}

async function connect(a, b) {
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);
}

const prefOf = (env, id) => (env.config.load().appPrefs || {})[id] || null;

/* ------------------------------------------------------------ the merge */

test("LWW per entry: the newer stamp wins, a tie keeps what is already here", () => {
  const local = {
    both: { favorite: true, _ts: T0 + 100 },
    older: { hidden: true, _ts: T0 },
    tie: { favorite: true, _ts: T0 },
    mine: { favorite: true, _ts: T0 },
  };
  const remote = {
    both: { favorite: false, _ts: T0 }, // older → ignored
    older: { hidden: false, _ts: T0 + 100 }, // newer → wins
    tie: { favorite: false, _ts: T0 }, // same stamp → local stands
    theirs: { hidden: true, _ts: T0 - 5000 }, // unknown here → adopted anyway
    unstamped: { favorite: true }, // missing stamp = epoch 0, still new to us
  };

  const { merged, changed } = sync.mergeAppPrefs(local, remote);
  assert.deepStrictEqual(changed, ["older", "theirs", "unstamped"]);
  assert.strictEqual(merged.both.favorite, true, "the older copy does not win");
  assert.strictEqual(merged.older.hidden, false, "the newer copy does");
  assert.strictEqual(merged.tie.favorite, true, "a tie is not a change");
  assert.strictEqual(merged.mine.favorite, true, "an entry the peer never mentioned is untouched");
  assert.strictEqual(merged.theirs.hidden, true, "there is nothing to compare a new entry against");
  assert.strictEqual(sync.stampOf(remote.unstamped, "_ts"), 0, "a missing stamp reads as epoch 0");

  // and the stamp TRAVELS — the adopted entry keeps the peer's, not ours
  assert.strictEqual(merged.older._ts, T0 + 100);
});

test("a newer stamp over identical content is not a change (this is what stops the loop)", () => {
  const local = { app: { favorite: true, _ts: T0 } };
  const remote = { app: { favorite: true, _ts: T0 } };
  assert.deepStrictEqual(sync.mergeAppPrefs(local, remote).changed, []);

  // same content, later stamp: still nothing a user would see, so still silence
  assert.deepStrictEqual(sync.mergeAppPrefs(local, { app: { favorite: true, _ts: T0 } }).changed, []);
});

test("stacks merge by updatedAt, keeping the local order", () => {
  const local = [stackOf("vr", "wivrn-nx", { at: T0 + 100 }), stackOf("audio", "ogb", { at: T0 })];
  const remote = [
    Object.assign(stackOf("vr", "something-else", { at: T0 }), {}), // older → ignored
    Object.assign(stackOf("audio", "pulsenx", { at: T0 + 100 }), {}), // newer → wins
    stackOf("desk", "quadforge", { at: T0 }), // new here → adopted
  ];
  const { merged, changed } = sync.mergeStacks(local, remote);
  assert.deepStrictEqual(changed, ["audio", "desk"]);
  assert.deepStrictEqual(merged.map((s) => s.id), ["vr", "audio", "desk"], "order follows the local list");
  assert.strictEqual(merged[0].steps[0].appId, "wivrn-nx");
  assert.strictEqual(merged[1].steps[0].appId, "pulsenx");
  assert.strictEqual(merged[1].updatedAt, T0 + 100, "the peer's stamp travels with the stack");

  assert.deepStrictEqual(sync.mergeStacks(null, null).merged, []);
  assert.deepStrictEqual(sync.mergeStacks([], [{ noId: true }]).changed, [], "a stack without an id is not a stack");
});

/* --------------------------------------------------- the untrusted payload */

test("a peer's payload is size-capped before anything else happens", () => {
  const huge = { appPrefs: {}, stacks: [] };
  for (let i = 0; i < 20000; i += 1) huge.appPrefs[`app-${i}`] = { skippedVersion: "1.0.0-".padEnd(40, "x") };
  const out = sync.sanitizePayload(huge, { sanitizeAppPrefs: realConfig.sanitizeAppPrefs });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /max 262144/);
  assert.strictEqual(sync.MAX_SYNC_BYTES, 256 * 1024);
});

test("junk in a payload is dropped, not adopted", () => {
  const out = sync.sanitizePayload(
    {
      type: "prefs-sync",
      appPrefs: {
        good: { favorite: true, hidden: false, nonsense: 1, updatePolicy: "install", _ts: T0 },
        bad: "not an object",
        alsoBad: [1, 2, 3],
        junky: { updatePolicy: "obliterate", launchArgs: "not an array" },
      },
      stacks: [
        stackOf("vr", "wivrn-nx", { at: T0 }),
        { id: "empty", steps: [] }, // no usable step → not a stack
        { steps: [{ appId: "x", health: {} }] }, // no id → not a stack
        stackOf("vr", "duplicate", { at: T0 }), // duplicate id
        "not a stack",
      ],
    },
    { sanitizeAppPrefs: realConfig.sanitizeAppPrefs, sanitizeStack: realStacks.sanitizeStack }
  );

  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(Object.keys(out.appPrefs).sort(), ["good", "junky"]);
  assert.deepStrictEqual(out.appPrefs.good, { _ts: T0, updatePolicy: "install", favorite: true, hidden: false });
  assert.ok(!("nonsense" in out.appPrefs.good), "the hub's own whitelist has the last word");
  assert.deepStrictEqual(out.appPrefs.junky, {}, "impossible values leave an entry with nothing in it");
  assert.deepStrictEqual(out.stacks.map((s) => s.id), ["vr"]);
  assert.strictEqual(out.stacks[0].steps[0].appId, "wivrn-nx", "the FIRST of a duplicated id wins");

  for (const junk of [null, "text", [1], 7]) {
    assert.strictEqual(sync.sanitizePayload(junk, {}).ok, false, JSON.stringify(junk));
  }
});

test("a token-shaped key is refused outright rather than cleaned up", () => {
  const shapes = [
    { appPrefs: {}, stacks: [], token: "ghp_x" },
    { appPrefs: {}, stacks: [], connectorToken: "deadbeef" },
    { appPrefs: {}, stacks: [], secret: "s" },
  ];
  for (const raw of shapes) {
    const out = sync.sanitizePayload(raw, { sanitizeAppPrefs: realConfig.sanitizeAppPrefs });
    assert.strictEqual(out.ok, false, JSON.stringify(Object.keys(raw)));
    assert.match(out.reason, /token-shaped/);
  }

  // one entry carrying one is dropped; the rest of the payload still merges
  const mixed = sync.sanitizePayload(
    { appPrefs: { fine: { favorite: true }, sneaky: { favorite: true, apiKey: "x" } }, stacks: [] },
    { sanitizeAppPrefs: realConfig.sanitizeAppPrefs }
  );
  assert.strictEqual(mixed.ok, true);
  assert.deepStrictEqual(Object.keys(mixed.appPrefs), ["fine"]);

  assert.ok(sync.isTokenish("token") && sync.isTokenish("API_KEY") && sync.isTokenish("my_password"));
  assert.ok(!sync.isTokenish("favorite") && !sync.isTokenish("launchArgs"));
});

test("the payload this hub SENDS carries only appPrefs and stacks", () => {
  const payload = sync.buildPayload({
    appPrefs: { wivrn: { favorite: true, _ts: T0 } },
    stacks: [stackOf("vr", "wivrn-nx", { at: T0 })],
    now: T0,
  });
  assert.deepStrictEqual(Object.keys(payload).sort(), ["appPrefs", "sentAt", "stacks", "type"]);
  assert.strictEqual(payload.type, "prefs-sync");
  assert.strictEqual(payload.sentAt, T0);

  // …and the hash deliberately ignores sentAt, or every push would look new
  const later = sync.buildPayload({
    appPrefs: { wivrn: { favorite: true, _ts: T0 } },
    stacks: [stackOf("vr", "wivrn-nx", { at: T0 })],
    now: T0 + 99999,
  });
  assert.strictEqual(sync.payloadHash(payload), sync.payloadHash(later));
});

/* ------------------------------------------------------- over a real pair */

test("a favourite set on one hub arrives on the other, stamp and all", async () => {
  const { a, b, envA, envB } = await pair();
  await connect(a, b);

  envA.config.setAppPref("wivrn-nx", { favorite: true, updatePolicy: "install" }, T0 + 1000);
  a.notePrefsChange();

  await h.waitUntil(() => prefOf(envB, "wivrn-nx"), 4000, "B to take the pref");
  assert.deepStrictEqual(prefOf(envB, "wivrn-nx"), {
    _ts: T0 + 1000,
    updatePolicy: "install",
    favorite: true,
  });
  assert.strictEqual(prefOf(envB, "wivrn-nx")._ts, T0 + 1000, "the stamp travelled — B is not the author");

  // …and the other direction works the same way over the same session
  envB.config.setAppPref("pulsenx", { hidden: true }, T0 + 2000);
  b.notePrefsChange();
  await h.waitUntil(() => prefOf(envA, "pulsenx"), 4000, "A to take B's pref");
  assert.deepStrictEqual(prefOf(envA, "pulsenx"), { _ts: T0 + 2000, hidden: true });
});

test("the newer edit wins whichever hub made it, and the loser is corrected", async () => {
  const { a, b, envA, envB } = await pair();

  // both hubs edit the same app while apart — B's edit is the later one
  envA.config.setAppPref("wivrn-nx", { updatePolicy: "notify" }, T0 + 1000);
  envB.config.setAppPref("wivrn-nx", { updatePolicy: "install" }, T0 + 9000);

  await connect(a, b);
  await h.waitUntil(() => prefOf(envA, "wivrn-nx").updatePolicy === "install", 4000, "A to be corrected");
  assert.strictEqual(prefOf(envA, "wivrn-nx")._ts, T0 + 9000);
  // …and B is NOT dragged backwards by A's older copy
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(prefOf(envB, "wivrn-nx").updatePolicy, "install", "the older edit never wins");
  assert.strictEqual(prefOf(envB, "wivrn-nx")._ts, T0 + 9000);
});

test("stacks sync by updatedAt, and the applying hub does not re-stamp them", async () => {
  const { a, b, envA, envB } = await pair();
  envA.stacks.save(stackOf("vr", "wivrn-nx"), { at: T0 + 5000 });
  await connect(a, b);

  await h.waitUntil(() => envB.stacks.list().length === 1, 4000, "B to take the stack");
  const [got] = envB.stacks.list();
  assert.strictEqual(got.id, "vr");
  assert.strictEqual(got.steps[0].appId, "wivrn-nx");
  assert.strictEqual(got.updatedAt, T0 + 5000, "the stamp is the author's, not the receiver's");
});

test("a merge that changed nothing is silent — the exchange terminates", async () => {
  const { a, b, envA, envB } = await pair();
  await connect(a, b);
  envA.config.setAppPref("wivrn-nx", { favorite: true }, T0 + 1000);
  a.notePrefsChange();
  await h.waitUntil(() => prefOf(envB, "wivrn-nx"), 4000, "the pref to land");

  // Both hubs now agree. Nudge them at each other repeatedly: every payload is
  // a no-op merge, so nobody has anything to re-broadcast and nothing changes.
  const beforeA = JSON.stringify(envA.config.load().appPrefs);
  const beforeB = JSON.stringify(envB.config.load().appPrefs);
  for (let i = 0; i < 5; i += 1) {
    a.pushPrefs();
    b.pushPrefs();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(JSON.stringify(envA.config.load().appPrefs), beforeA);
  assert.strictEqual(JSON.stringify(envB.config.load().appPrefs), beforeB);
  assert.ok(
    !a.logs.some((l) => /took \d+ app pref/.test(l)) || a.logs.filter((l) => /took \d+ app pref/.test(l)).length <= 1,
    "at most the one real adoption, never a conversation"
  );
});

test("keys outside the two synced spaces stay exactly where they are", async () => {
  const { a, b, envA, envB } = await pair();
  // the machine-local settings SPEC says are never synced
  envA.config.save({
    token: "ghp_only_on_a",
    installRoot: "/tmp/a-apps",
    adbPath: "/usr/bin/adb-a",
    extraRepos: ["a/one"],
    owners: ["a-owner"],
    checkIntervalHours: 12,
    fleet: true,
    cliShim: false,
    autostart: true,
  });
  envB.config.save({ token: "ghp_only_on_b", installRoot: "/tmp/b-apps", adbPath: "adb", checkIntervalHours: 6 });

  envA.config.setAppPref("wivrn-nx", { favorite: true }, T0 + 1000);
  await connect(a, b);
  await h.waitUntil(() => prefOf(envB, "wivrn-nx"), 4000, "the one thing that IS synced");

  const bAfter = envB.config.load();
  assert.strictEqual(bAfter.token, "ghp_only_on_b", "a token never crosses the fleet");
  assert.strictEqual(bAfter.installRoot, "/tmp/b-apps");
  assert.strictEqual(bAfter.adbPath, "adb");
  assert.strictEqual(bAfter.checkIntervalHours, 6);
  assert.deepStrictEqual(bAfter.extraRepos, []);
  assert.deepStrictEqual(bAfter.owners, realConfig.defaults().owners);
  assert.strictEqual(bAfter.cliShim, true, "a machine-local boolean is B's own business");
  assert.strictEqual(bAfter.autostart, false);
});

test("fleetSync off means silence in BOTH directions", async () => {
  const envA = h.syncEnv(h.tempDataDir("nxhub-nosync-a-"));
  const envB = h.syncEnv(h.tempDataDir("nxhub-nosync-b-"));
  envB.config.save({ fleetSync: false });

  const a = await h.startFleet({
    overrides: { syncConfig: envA.config, stacks: envA.stacks, prefsDebounceMs: 15, rosterIntervalMs: 20 },
  });
  const b = await h.startFleet({
    overrides: { syncConfig: envB.config, stacks: envB.stacks, prefsDebounceMs: 15, rosterIntervalMs: 20 },
  });

  envA.config.setAppPref("wivrn-nx", { favorite: true }, T0 + 1000);
  envB.config.setAppPref("pulsenx", { hidden: true }, T0 + 1000);
  await connect(a, b);
  await new Promise((r) => setTimeout(r, 300));

  // B refuses to RECEIVE …
  assert.strictEqual(prefOf(envB, "wivrn-nx"), null, "B does not take A's preferences");
  // … and refuses to SEND
  assert.strictEqual(prefOf(envA, "pulsenx"), null, "B does not push its own either");
  assert.strictEqual(b.syncEnabled(), false);
  assert.strictEqual(b.pushPrefs(), null);

  // the default is ON, though — a hub that never heard of the setting syncs
  assert.strictEqual(realConfig.defaults().fleetSync, true);
  assert.strictEqual(realConfig.sanitize({}).fleetSync, true);
  assert.strictEqual(realConfig.sanitize({ fleetSync: "false" }).fleetSync, false);
  assert.strictEqual(realConfig.sanitize({ fleetSync: "nonsense" }).fleetSync, true);
});

test("a hostile payload over a real session is refused without disturbing the session", async () => {
  const { a, b, envB } = await pair();
  await connect(a, b);
  const session = a.sessions.get(b.localId);

  // a real favourite smuggled in alongside a token-shaped key: the whole
  // payload goes, not just the offending key
  session.send({ type: "prefs-sync", appPrefs: { x: { favorite: true } }, token: "ghp_x", sentAt: Date.now() });
  // …and outright junk merges to nothing rather than throwing
  session.send({ type: "prefs-sync", appPrefs: "nope", stacks: "nope", sentAt: Date.now() });
  session.send({ type: "prefs-sync", sentAt: Date.now() });

  await h.waitUntil(() => b.logs.some((l) => /refused .* settings .* token-shaped/.test(l)), 4000, "the refusal");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(envB.config.load().appPrefs, {}, "nothing hostile was adopted");
  assert.ok(b.sessions.get(a.localId).alive, "a bad payload is refused, not answered with a hangup");

  // …and the session still works afterwards
  const peer = a.getPeers().find((p) => p.id === b.localId);
  assert.strictEqual(peer.connected, true);
});
