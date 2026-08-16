"use strict";
// `nx snapshots` / `nx restore` — rendering, selection, confirmation and exit
// codes (SPEC v0.8 "Config time machine").
//
// Like `nx dev`, the module underneath is the REAL one in a temp dataDir with
// a temp $HOME: it is pure node with no network, so faking it would only test
// the fake. Only discovery is stubbed, through the usual fake runtime.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const snapCli = require("../../src/cli/snapshots");
const snapshots = require("../../src/main/snapshots");
const { createStyle } = require("../../src/cli/ansi");
const fx = require("./fixtures");

function fakeStream({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns: 100,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

/** Temp dataDir + temp $HOME, both restored afterwards. */
function useEnv(t, { configPaths = null } = {}) {
  const env = helpers.useTempEnv();
  const home = path.join(env.root, "home");
  fs.mkdirSync(home, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    env.cleanup();
  });
  const app = Object.assign({}, fx.wivrn, { configPaths });
  return { env, home, app, apps: [app, fx.quadforge] };
}

function runtimeFor(apps) {
  return {
    hubVersion: () => "0.8.0",
    on: () => () => {},
    apps: async () => apps,
    cached: () => ({ apps, lastRefresh: null, errors: [] }),
  };
}

async function runCli(argv, { apps, confirm } = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime: runtimeFor(apps || fx.APPS),
    stdout,
    stderr,
    confirm,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text };
}

function seed(home, { text = "config v1", app = "wivrn-nx", version = "1.3.2", reason = "pre-update" } = {}) {
  const file = path.join(home, ".config", "wivrn-nx", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return snapshots
    .maybeSnapshot({ id: app, name: "WiVRn NX", configPaths: ["~/.config/wivrn-nx"] }, {}, reason, { version })
    .then((res) => {
      assert.equal(res.ok, true, res.error);
      return { file, snapshot: res };
    });
}

/* ---------------------------------------------------------------- render */

const ROWS = [
  { file: "2026-08-16T10-04-05.123Z-1.4.0-pre-update.tar.zst", ts: "2026-08-16T10:04:05.123Z", version: "1.4.0", reason: "pre-update", bytes: 2048 },
  { file: "2026-08-01T09-00-00.000Z-1.3.2-pre-uninstall.tar.zst", ts: "2026-08-01T09:00:00.000Z", version: "1.3.2", reason: "pre-uninstall", bytes: 900 },
];

test("nx snapshots: the table carries when / version / reason / size", () => {
  const text = snapCli.renderSnapshots(ROWS, { style: createStyle(false), app: fx.wivrn });
  assert.match(text, /WHEN\s+VERSION\s+REASON\s+SIZE\s+FILE/);
  assert.match(text, /2026-08-16 10:04/);
  assert.match(text, /1\.4\.0/);
  assert.match(text, /before update/);
  assert.match(text, /before uninstall/);
  assert.match(text, /2\.0 KB|2 KB|2048/);
  assert.match(text, /nx restore wivrn-nx/);
  // locale-independent: never a localised date
  assert.ok(!/\d{1,2}\/\d{1,2}\/\d{4}/.test(text));
});

test("nx snapshots: an empty list explains where snapshots come from", () => {
  const text = snapCli.renderSnapshots([], { style: createStyle(false), app: fx.wivrn });
  assert.match(text, /No snapshots yet/);
  assert.match(text, /before an update or an uninstall/);
});

test("nx snapshots: pickSnapshot takes the newest, an exact name, or a prefix", () => {
  assert.equal(snapCli.pickSnapshot(ROWS).snapshot.file, ROWS[0].file, "newest by default");
  assert.equal(snapCli.pickSnapshot(ROWS, ROWS[1].file).snapshot.file, ROWS[1].file, "exact");
  assert.equal(snapCli.pickSnapshot(ROWS, "2026-08-01").snapshot.file, ROWS[1].file, "a date is enough");
  assert.equal(snapCli.pickSnapshot(ROWS, "2026-08").snapshot, null, "an ambiguous prefix is refused");
  assert.match(snapCli.pickSnapshot(ROWS, "2026-08").error, /matches 2 snapshots/);
  assert.equal(snapCli.pickSnapshot(ROWS, "nope").snapshot, null);
  assert.match(snapCli.pickSnapshot([], "x").error, /no snapshots/i);
  assert.equal(snapCli.whenText("2026-08-16T10:04:05.123Z"), "2026-08-16 10:04");
  assert.equal(snapCli.whenText(null), "—");
});

/* -------------------------------------------------------------- listing */

test("nx snapshots <app>: lists what is on disk", async (t) => {
  const { home, apps } = useEnv(t);
  const { snapshot } = await seed(home);

  const r = await runCli(["snapshots", "wivrn-nx"], { apps });
  assert.equal(r.code, 0);
  // section titles are letter-spaced by the style (DESIGN §8)
  assert.match(r.out, /C O N F I G   S N A P S H O T S/);
  assert.match(r.out, /1\.3\.2/);
  assert.match(r.out, /before update/);
  assert.ok(r.out.includes(snapshot.file));
});

test("nx snapshots <app> --json: the machine-readable shape", async (t) => {
  const { home, apps } = useEnv(t);
  const { snapshot } = await seed(home);

  const r = await runCli(["snapshots", "wivrn-nx", "--json"], { apps });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.appId, "wivrn-nx");
  assert.equal(parsed.snapshots.length, 1);
  assert.deepEqual(Object.keys(parsed.snapshots[0]).sort(), ["bytes", "file", "reason", "ts", "version"]);
  assert.equal(parsed.snapshots[0].file, snapshot.file);
  assert.equal(parsed.snapshots[0].reason, "pre-update");
});

test("nx snapshots: an app with none is not an error", async (t) => {
  const { apps } = useEnv(t);
  const r = await runCli(["snapshots", "wivrn-nx"], { apps });
  assert.equal(r.code, 0);
  assert.match(r.out, /No snapshots yet/);
});

test("nx snapshots: no app / an unknown app is a user error", async (t) => {
  const { apps } = useEnv(t);
  const bare = await runCli(["snapshots"], { apps });
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Name an app/);

  const unknown = await runCli(["snapshots", "nonesuch"], { apps });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /nonesuch/);
});

test("nx snaps: the alias reaches the same command", async (t) => {
  const { home, apps } = useEnv(t);
  await seed(home);
  const r = await runCli(["snaps", "wivrn-nx"], { apps });
  assert.equal(r.code, 0);
  assert.match(r.out, /C O N F I G   S N A P S H O T S/);
});

/* -------------------------------------------------------------- restore */

test("nx restore <app>: confirms, then puts the newest snapshot back", async (t) => {
  const { home, apps } = useEnv(t);
  const { file } = await seed(home, { text: "config v1" });
  fs.writeFileSync(file, "config v2 — broken");

  const asked = [];
  const r = await runCli(["restore", "wivrn-nx"], {
    apps,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
  });
  assert.equal(r.code, 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Restore WiVRn NX's config from 2026-|Restore WiVRn NX's config from \d{4}-/);
  assert.match(asked[0], /overwritten/);
  assert.equal(fs.readFileSync(file, "utf8"), "config v1");
  assert.match(r.out, /Restored/);
  assert.match(r.out, /\.config\/wivrn-nx/);
});

test("nx restore: declining changes nothing and still exits 0", async (t) => {
  const { home, apps } = useEnv(t);
  const { file } = await seed(home, { text: "config v1" });
  fs.writeFileSync(file, "config v2");

  const r = await runCli(["restore", "wivrn-nx"], { apps, confirm: async () => false });
  assert.equal(r.code, 0);
  assert.match(r.err, /Nothing restored/);
  assert.equal(fs.readFileSync(file, "utf8"), "config v2");
});

test("nx restore -y: skips the confirmation and names a specific snapshot", async (t) => {
  const { home, apps } = useEnv(t);
  const older = await seed(home, { text: "oldest", version: "1.0.0" });
  await seed(home, { text: "newest", version: "1.3.2" });
  fs.writeFileSync(older.file, "whatever is there now");

  let asked = 0;
  const r = await runCli(["restore", "wivrn-nx", older.snapshot.file, "-y"], {
    apps,
    confirm: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(r.code, 0);
  assert.equal(asked, 0, "-y means no question");
  assert.equal(fs.readFileSync(older.file, "utf8"), "oldest");
});

test("nx restore --json: reports the archive, its paths and the safety copy", async (t) => {
  const { home, apps } = useEnv(t, { configPaths: ["~/.config/wivrn-nx"] });
  const { file, snapshot } = await seed(home, { text: "config v1" });
  fs.writeFileSync(file, "current");

  const r = await runCli(["restore", "wivrn-nx", "-y", "--json"], { apps });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.file, snapshot.file);
  assert.ok(parsed.restored.some((p) => p.endsWith("config.json")));
  assert.ok(parsed.preRestore, "the app declares configPaths, so a pre-restore archive was taken");
  assert.equal(snapshots.list("wivrn-nx").find((s) => s.file === parsed.preRestore).reason, "pre-restore");
});

test("nx restore: nothing to restore, and an unknown archive, are user errors", async (t) => {
  const { home, apps } = useEnv(t);
  await seed(home);

  const none = await runCli(["restore", "quadforge", "-y"], { apps });
  assert.equal(none.code, 1);
  assert.match(none.err, /no snapshots/i);

  const wrong = await runCli(["restore", "wivrn-nx", "2026-01-01T00-00-00.000Z-9.9.9-manual.tar.zst", "-y"], { apps });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /No snapshot called/);

  // a traversal never even reaches the module: it matches no listed archive
  const evil = await runCli(["restore", "wivrn-nx", "../../etc/passwd", "-y"], { apps });
  assert.equal(evil.code, 1);
  assert.match(evil.err, /No snapshot called/);
});

test("nx restore --json: a failure is json on stdout with exit 2", async (t) => {
  const { home, apps } = useEnv(t);
  const { snapshot } = await seed(home);
  // truncate the archive: tar will refuse it, which is an operation failure
  fs.writeFileSync(path.join(snapshots.snapshotDir("wivrn-nx"), snapshot.file), "not a zstd stream");

  const r = await runCli(["restore", "wivrn-nx", "-y", "--json"], { apps });
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error);
});

/* ------------------------------------------------------------------ rm */

test("nx snapshots rm <app> <file>: deletes exactly that archive", async (t) => {
  const { home, apps } = useEnv(t);
  const a = await seed(home, { version: "1.0.0" });
  const b = await seed(home, { version: "1.3.2" });

  const r = await runCli(["snapshots", "rm", "wivrn-nx", a.snapshot.file], { apps });
  assert.equal(r.code, 0);
  assert.match(r.out, /Deleted/);
  assert.deepEqual(
    snapshots.list("wivrn-nx").map((s) => s.file),
    [b.snapshot.file]
  );
});

test("nx snapshots rm: without a file, or with an unknown one, exits 1", async (t) => {
  const { home, apps } = useEnv(t);
  const a = await seed(home);

  const bare = await runCli(["snapshots", "rm", "wivrn-nx"], { apps });
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Name the snapshot/);

  const evil = await runCli(["snapshots", "rm", "wivrn-nx", "../../../etc/passwd"], { apps });
  assert.equal(evil.code, 1);
  assert.equal(snapshots.list("wivrn-nx").length, 1);
  assert.ok(fs.existsSync(path.join(snapshots.snapshotDir("wivrn-nx"), a.snapshot.file)));
});

test("nx help: lists snapshots and restore", async (t) => {
  const { apps } = useEnv(t);
  const r = await runCli(["help"], { apps });
  assert.match(r.out, /snapshots\s+<app> \| rm <app> <file>/);
  assert.match(r.out, /restore\s+<app> \[file\]/);
});
