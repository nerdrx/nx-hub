"use strict";
// SPEC v0.7 — dev links (`nx dev`).
//
// The launch heuristic runs against REAL temp trees with real permission bits,
// and the detachment test spawns a real grandchild: those two are exactly the
// places where a unit test with a mocked fs would prove nothing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const helpers = require("./helpers");
const config = require("../../src/main/config");
const devlinks = require("../../src/main/devlinks");

/** A directory tree from a {relPath: {content, exec}} description. */
function tree(root, spec) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, entry] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.content == null ? "x" : entry.content);
    fs.chmodSync(abs, entry.exec ? 0o755 : 0o644);
  }
  return root;
}

function useEnv(t) {
  const env = helpers.useTempEnv();
  devlinks._reset();
  t.after(() => {
    devlinks._reset();
    env.cleanup();
  });
  return env;
}

/* ------------------------------------------------------------------ */
/* the store: CRUD                                                     */
/* ------------------------------------------------------------------ */

test("devlinks: link → list → get → unlink, through a real dev.json", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "my-app");
  fs.mkdirSync(dir);

  assert.deepStrictEqual(devlinks.list(), [], "nothing is linked to begin with");

  const rec = devlinks.link({ path: dir });
  assert.strictEqual(rec.appId, "my-app", "the id defaults to the directory's basename");
  assert.strictEqual(rec.path, dir);
  assert.ok(!("launchCmd" in rec), "no launchCmd was asked for, so none is stored");

  assert.strictEqual(devlinks.list().length, 1);
  assert.deepStrictEqual(devlinks.get("my-app"), rec);
  assert.strictEqual(devlinks.get("nope"), null);

  // it really is on disk, in the shape SPEC v0.7 names
  const raw = JSON.parse(fs.readFileSync(path.join(env.dataDir, "dev.json"), "utf8"));
  assert.strictEqual(raw.version, 1);
  assert.deepStrictEqual(raw.links, [{ appId: "my-app", path: dir }]);

  assert.strictEqual(devlinks.unlink("my-app"), true);
  assert.strictEqual(devlinks.unlink("my-app"), false, "unlinking twice is not an error, just false");
  assert.deepStrictEqual(devlinks.list(), []);
});

test("devlinks: a second link on the same id replaces the first", (t) => {
  const env = useEnv(t);
  const a = path.join(env.root, "a");
  const b = path.join(env.root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);

  devlinks.link({ path: a, appId: "wivrn-nx" });
  devlinks.link({ path: b, appId: "wivrn-nx", launchCmd: "./run.sh --dev" });

  const list = devlinks.list();
  assert.strictEqual(list.length, 1, "one id, one link");
  assert.strictEqual(list[0].path, b);
  assert.strictEqual(list[0].launchCmd, "./run.sh --dev");
});

test("devlinks: ids are slugged, paths are absolute, ~ expands", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "Weird Name!");
  fs.mkdirSync(dir);

  const rec = devlinks.link({ path: `${dir}/`, appId: "  My APP!! " });
  assert.strictEqual(rec.appId, "my-app", "slugify: ordinal, lowercase, dashes");
  assert.strictEqual(rec.path, dir, "the trailing separator is normalised away");

  assert.strictEqual(devlinks.slugify("My VR Stack!"), "my-vr-stack");
  assert.strictEqual(devlinks.slugify(""), "");
  assert.strictEqual(devlinks.normalizePath("~"), os.homedir());
  assert.strictEqual(devlinks.normalizePath("~/src/x"), path.join(os.homedir(), "src", "x"));
});

test("devlinks: linking validates that the path exists AND is a directory", (t) => {
  const env = useEnv(t);
  const missing = path.join(env.root, "nope");
  const file = path.join(env.root, "file.txt");
  fs.writeFileSync(file, "hi");

  assert.throws(() => devlinks.link({ path: missing }), /No such directory/);
  assert.throws(() => devlinks.link({ path: file }), /Not a directory/);
  assert.throws(() => devlinks.link({}), /needs a path/);
  // a path that slugs to nothing cannot become an id
  const odd = path.join(env.root, "!!!");
  fs.mkdirSync(odd);
  assert.throws(() => devlinks.link({ path: odd }), /--app/);
  assert.deepStrictEqual(devlinks.list(), [], "nothing invalid ever reached the store");
});

test("devlinks: a junk or hand-edited dev.json degrades to what is still readable", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "good");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(env.dataDir, "dev.json"),
    JSON.stringify({
      version: 1,
      links: [
        null,
        "nonsense",
        { path: "" },
        { appId: "good", path: dir, launchCmd: "  ", name: "  Good  " },
        { appId: "good", path: "/somewhere/else" }, // duplicate id: first wins
        { appId: 42, path: dir },
      ],
    })
  );

  const list = devlinks.list();
  assert.deepStrictEqual(
    list.map((l) => l.appId),
    ["good", "42"],
    "nulls, strings, path-less entries and the duplicate id are gone; a numeric id is legal"
  );
  assert.deepStrictEqual(list[0], { appId: "good", path: dir, name: "Good" });
  assert.ok(!("launchCmd" in list[0]), "a whitespace-only launchCmd is not a launchCmd");

  fs.writeFileSync(path.join(env.dataDir, "dev.json"), "{ this is not json");
  assert.deepStrictEqual(devlinks.list(), [], "an unparseable store reads as empty, it does not throw");
});

test("devlinks: linkFor() caches but never goes stale across a write", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "app");
  fs.mkdirSync(dir);

  assert.strictEqual(devlinks.linkFor("app"), null);
  devlinks.link({ path: dir });
  assert.strictEqual(devlinks.linkFor("app").path, dir, "the write invalidated the memo");
  assert.strictEqual(devlinks.linkFor("app"), devlinks.linkFor("app"), "a repeat read is served from the memo");
  devlinks.unlink("app");
  assert.strictEqual(devlinks.linkFor("app"), null);
});

/* ------------------------------------------------------------------ */
/* resolving what to run                                               */
/* ------------------------------------------------------------------ */

test("devlinks: the heuristic prefers a name match, then shallow, then large", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "wivrn-nx"), {
    "build/bin/wivrn-nx": { content: "x".repeat(100), exec: true },
    "tools/helper": { content: "x".repeat(9000), exec: true },
    "README.md": { content: "docs", exec: false },
  });

  const chosen = devlinks.pickDevBinary(dir, { names: ["wivrn-nx"] });
  assert.strictEqual(chosen.rel, path.join("build", "bin", "wivrn-nx"), "the name match beats the bigger, shallower file");

  // with no name to match on, depth and size decide
  const plain = devlinks.pickDevBinary(dir, { names: [] });
  assert.strictEqual(plain.rel, path.join("tools", "helper"));
});

test("devlinks: the walk skips node_modules/.git, non-executables and libraries", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "proj"), {
    "node_modules/.bin/eslint": { content: "x".repeat(50000), exec: true },
    ".git/hooks/pre-commit": { content: "x".repeat(50000), exec: true },
    "libfoo.so": { content: "x".repeat(50000), exec: true },
    "notes.txt": { content: "x".repeat(50000), exec: true },
    "run.sh": { content: "#!/bin/sh\n", exec: true },
    "src/main.c": { content: "int main(){}", exec: false },
  });

  const rels = devlinks.candidates(dir).map((f) => f.rel).sort();
  assert.deepStrictEqual(rels, ["run.sh"], "only the one plausible launch target survives the filters");
});

test("devlinks: the walk is depth-limited, so a source tree cannot run away with it", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "deep"), {
    "a/b/c/d/e/buried": { content: "x", exec: true },
    "a/b/shallow": { content: "x", exec: true },
  });
  const rels = devlinks.candidates(dir).map((f) => f.rel);
  assert.ok(rels.includes(path.join("a", "b", "shallow")));
  assert.ok(!rels.some((r) => r.includes("buried")), `depth ${devlinks.MAX_DEPTH} is the limit`);
});

test("devlinks: the heuristic leaves the working tree exactly as it found it", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "readonly-ish"), {
    "app": { content: "x", exec: true },
    "data.bin": { content: "x", exec: false },
  });
  const before = fs.statSync(path.join(dir, "data.bin")).mode;
  devlinks.pickDevBinary(dir, { names: ["app"] });
  assert.strictEqual(fs.statSync(path.join(dir, "data.bin")).mode, before, "no chmod inside the user's repo");
});

test("devlinks: resolveLaunch prefers an explicit launchCmd and resolves it against the tree", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "app"), { "app": { content: "x", exec: true }, "run.sh": { content: "x", exec: true } });

  const explicit = devlinks.resolveLaunch({ appId: "app", path: dir, launchCmd: "./run.sh --dev" });
  assert.strictEqual(explicit.source, "launchCmd");
  assert.strictEqual(explicit.cmd, path.join(dir, "run.sh"), "a relative command means the LINKED tree's file");
  assert.deepStrictEqual(explicit.args, ["--dev"]);
  assert.strictEqual(explicit.cwd, dir);

  // a bare name stays a bare name — PATH lookup is the point of `npm run dev`
  const viaPath = devlinks.resolveLaunch({ appId: "app", path: dir, launchCmd: "npm run dev" });
  assert.strictEqual(viaPath.cmd, "npm");
  assert.deepStrictEqual(viaPath.args, ["run", "dev"]);

  const heuristic = devlinks.resolveLaunch({ appId: "app", path: dir });
  assert.strictEqual(heuristic.source, "heuristic");
  assert.strictEqual(heuristic.cmd, path.join(dir, "app"));
});

test("devlinks: with nothing runnable, the error names what WAS found", (t) => {
  const env = useEnv(t);
  const dir = tree(path.join(env.root, "docs-only"), { "README.md": { content: "x", exec: false } });
  assert.throws(
    () => devlinks.resolveLaunch({ appId: "docs-only", path: dir }),
    (e) => e.message.includes("Nothing executable") && Array.isArray(e.candidates) && e.candidates.length === 0
  );

  const gone = path.join(env.root, "vanished");
  assert.throws(() => devlinks.resolveLaunch({ appId: "vanished", path: gone }), /is gone/);
});

test("devlinks: parseCommand splits like the install engine's launchCmd does", () => {
  assert.strictEqual(devlinks.parseCommand("", "/tmp"), null);
  assert.strictEqual(devlinks.parseCommand(null, "/tmp"), null);
  assert.deepStrictEqual(devlinks.parseCommand("/usr/bin/foo -a  -b", "/tmp"), {
    cmd: "/usr/bin/foo",
    args: ["-a", "-b"],
  });
  assert.strictEqual(devlinks.parseCommand("~/bin/foo", "/tmp").cmd, path.join(os.homedir(), "bin", "foo"));
});

/* ------------------------------------------------------------------ */
/* the spawn really is detached                                        */
/* ------------------------------------------------------------------ */

test("devlinks: a dev run outlives the process that started it", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "sleeper");
  fs.mkdirSync(dir);
  const bin = path.join(dir, "sleeper");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(bin, 0o755);

  const marker = path.join(env.root, "child.pid");
  const helper = path.join(env.root, "helper.js");
  // A stand-in `nx dev run`: link, run, write the pid down, exit. If the spawn
  // were not detached (or kept a referenced handle), this process would sit
  // here for the child's full 30 seconds.
  fs.writeFileSync(
    helper,
    `const devlinks = require(${JSON.stringify(path.resolve(__dirname, "../../src/main/devlinks.js"))});
const fs = require("fs");
devlinks.link({ path: ${JSON.stringify(dir)} });
const res = devlinks.run("sleeper");
fs.writeFileSync(${JSON.stringify(marker)}, String(res.pid));
`
  );

  const started = Date.now();
  execFileSync(process.execPath, [helper], { timeout: 15000, env: process.env });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `the launcher exited on its own (${elapsed}ms)`);

  const pid = Number(fs.readFileSync(marker, "utf8"));
  assert.ok(pid > 0, "the run reported a pid");
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (_) {
    alive = false;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (_) {
    /* already gone */
  }
  assert.ok(alive, "the dev build outlives `nx dev run`");
});

test("devlinks: running an unknown id is an error, not a silent no-op", (t) => {
  useEnv(t);
  assert.throws(() => devlinks.run("nothing-here"), /No dev link called/);
});

/* ------------------------------------------------------------------ */
/* discovery only ever learns that a link exists                       */
/* ------------------------------------------------------------------ */

test("devlinks: the store lives in dataDir and follows it", (t) => {
  const env = useEnv(t);
  assert.strictEqual(devlinks.storePath(), path.join(env.dataDir, "dev.json"));
  assert.strictEqual(path.dirname(devlinks.storePath()), config.dataDir());
});

/* ------------------------------------------------------------------ */
/* the IPC surface the launcher renders from                           */
/* ------------------------------------------------------------------ */

/** Minimal ipcMain double, same shape as test/core/ipc-v02.test.js uses. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

test("devlinks: getDevLinks / devRun / devUnlink are on the ipc surface", async (t) => {
  const env = useEnv(t);
  const ipc = require("../../src/main/ipc");
  const discovery = require("../../src/main/discovery");
  const ipcMain = fakeIpcMain();
  ipc.init({ ipcMain, BrowserWindow: null, shell: null, app: null, onSettingsChanged: () => {} });
  for (const name of ["getDevLinks", "devRun", "devUnlink"]) {
    assert.ok(ipcMain.handlers.has(`nxhub:${name}`), `channel nxhub:${name} not registered`);
  }

  const dir = path.join(env.root, "quadforge");
  fs.mkdirSync(dir);
  const bin = path.join(dir, "quadforge");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 20\n");
  fs.chmodSync(bin, 0o755);
  devlinks.link({ path: dir, name: "QuadForge (dev)" });

  // discovery knows an app under this id → the tile can say so
  discovery._setCached({ apps: [{ id: "quadforge", name: "QuadForge", artifacts: [] }] });
  t.after(() => discovery._setCached({ apps: [] }));

  const links = await ipcMain.invoke("nxhub:getDevLinks");
  assert.strictEqual(links.length, 1);
  assert.deepStrictEqual(links[0], {
    appId: "quadforge",
    name: "QuadForge (dev)",
    path: dir,
    launchCmd: null,
    exists: true,
    known: true,
    appName: "QuadForge",
  });

  const ran = await ipcMain.invoke("nxhub:devRun", "quadforge");
  assert.strictEqual(ran.ok, true);
  assert.ok(ran.pid > 0);
  assert.strictEqual(ran.cwd, dir);
  t.after(() => {
    try {
      process.kill(ran.pid, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  await assert.rejects(() => ipcMain.invoke("nxhub:devRun", "not-linked"), /No dev link called/);

  const removed = await ipcMain.invoke("nxhub:devUnlink", "quadforge");
  assert.deepStrictEqual(removed, { ok: true, links: [] });
  assert.deepStrictEqual(await ipcMain.invoke("nxhub:getDevLinks"), []);
});
