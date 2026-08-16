"use strict";
// `nx dev` — rendering, matching, dispatch and exit codes (SPEC v0.7).
//
// The store underneath is the REAL one in a temp dataDir: it is pure node with
// no network, so faking it would only test the fake.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const helpers = require("../core/helpers");
const cli = require("../../src/cli/index");
const dev = require("../../src/cli/dev");
const devlinks = require("../../src/main/devlinks");
const { createStyle } = require("../../src/cli/ansi");

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

async function runCli(argv) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await cli.run(argv, {
    runtime: { hubVersion: () => "0.7.0", on: () => () => {} },
    stdout,
    stderr,
    env: { NO_COLOR: "1" },
    platform: "linux",
  });
  return { code, out: stdout.text, err: stderr.text };
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

/* ---------------------------------------------------------------- render */

const LINKS = [
  { appId: "wivrn-nx", path: "/home/u/src/wivrn-nx", exists: true },
  { appId: "quadforge", path: "/home/u/src/quadforge", launchCmd: "blender --python-expr x", exists: true },
  { appId: "gone", path: "/home/u/src/gone", exists: false },
];

test("cli dev: the list renders plain, with the launch column and the missing marker", () => {
  const out = dev.renderDevLinks(LINKS, { style: createStyle(false), home: "/home/u" });
  assert.match(out, /D E V {3}L I N K S/, "the tracked section label");
  assert.match(out, /ID\s+PATH\s+LAUNCH/);
  assert.match(out, /wivrn-nx\s+~\/src\/wivrn-nx\s+auto/, "no launchCmd reads as `auto`");
  assert.match(out, /quadforge\s+~\/src\/quadforge\s+blender --python-expr x/);
  assert.match(out, /1 linked directory is gone/);
  assert.ok(!/\[/.test(out), "plain style emits no escapes");

  const styled = dev.renderDevLinks(LINKS, { style: createStyle(true), home: "/home/u" });
  assert.ok(/\[38;2;119;0;255m/.test(styled), "the violet section header is NX violet");
});

test("cli dev: an empty list says how to make one", () => {
  const out = dev.renderDevLinks([], { style: createStyle(false) });
  assert.match(out, /No dev links yet/);
  assert.match(out, /nx dev link ~\/src\/my-app/);
});

test("cli dev: shortPath collapses only the real home prefix", () => {
  assert.strictEqual(dev.shortPath("/home/u/src/x", "/home/u"), path.join("~", "src", "x"));
  assert.strictEqual(dev.shortPath("/home/u", "/home/u"), "~");
  assert.strictEqual(dev.shortPath("/home/user2/src", "/home/u"), "/home/user2/src", "a prefix is not a parent");
  assert.strictEqual(dev.shortPath("/opt/x", "/home/u"), "/opt/x");
  assert.strictEqual(dev.shortPath(null, "/home/u"), "");
});

test("cli dev: the json projection is flat and stable", () => {
  assert.deepStrictEqual(dev.devLinksJson(LINKS), {
    links: [
      { appId: "wivrn-nx", name: null, path: "/home/u/src/wivrn-nx", launchCmd: null, exists: true },
      { appId: "quadforge", name: null, path: "/home/u/src/quadforge", launchCmd: "blender --python-expr x", exists: true },
      { appId: "gone", name: null, path: "/home/u/src/gone", launchCmd: null, exists: false },
    ],
  });
  assert.deepStrictEqual(dev.devLinksJson(null), { links: [] });
});

test("cli dev: links match on id, name and directory basename", () => {
  const links = [
    { appId: "wivrn-nx", path: "/src/wivrn-nx" },
    { appId: "wobble", path: "/src/wobble", name: "Wobbler" },
  ];
  assert.strictEqual(dev.matchLink(links, "wivrn-nx").link.appId, "wivrn-nx", "exact id");
  assert.strictEqual(dev.matchLink(links, "wivrn").link.appId, "wivrn-nx", "prefix");
  assert.strictEqual(dev.matchLink(links, "wobbler").link.appId, "wobble", "by name");
  assert.strictEqual(dev.matchLink(links, "w").link, null, "ambiguous");
  assert.match(dev.matchLink(links, "w").error, /matches 2 dev links/);
  assert.match(dev.matchLink(links, "zzz").error, /No dev link called "zzz"/);
  assert.match(dev.matchLink(links, "").error, /Name a dev link/);
});

/* -------------------------------------------------------------- dispatch */

test("cli dev: link → ls → unlink round trip, through the real store", async (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "my-tool");
  fs.mkdirSync(dir);

  const linked = await runCli(["dev", "link", dir]);
  assert.strictEqual(linked.code, cli.EXIT_OK);
  assert.match(linked.out, /Linked my-tool/);
  assert.match(linked.out, /nx dev run my-tool/);

  const listed = await runCli(["dev", "ls"]);
  assert.strictEqual(listed.code, cli.EXIT_OK);
  assert.match(listed.out, /my-tool/);

  const bare = await runCli(["dev"]);
  assert.match(bare.out, /my-tool/, "`nx dev` on its own lists");

  const json = await runCli(["dev", "ls", "--json"]);
  const parsed = JSON.parse(json.out);
  assert.strictEqual(parsed.links.length, 1);
  assert.strictEqual(parsed.links[0].path, dir);
  assert.strictEqual(parsed.links[0].exists, true);

  const removed = await runCli(["dev", "unlink", "my-tool"]);
  assert.strictEqual(removed.code, cli.EXIT_OK);
  assert.match(removed.out, /Unlinked my-tool/);
  assert.deepStrictEqual(JSON.parse((await runCli(["dev", "ls", "--json"])).out).links, []);
});

test("cli dev: --app and --cmd are carried into the store", async (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "some-checkout");
  fs.mkdirSync(dir);

  const r = await runCli(["dev", "link", dir, "--app", "WiVRn NX", "--cmd", "npm run dev"]);
  assert.strictEqual(r.code, cli.EXIT_OK);
  const stored = devlinks.list();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].appId, "wivrn-nx", "--app is slugged like every other app id");
  assert.strictEqual(stored[0].launchCmd, "npm run dev");
});

test("cli dev: a bad path, a bad subcommand and an unknown id are all exit 1", async (t) => {
  const env = useEnv(t);

  const missing = await runCli(["dev", "link", path.join(env.root, "nope")]);
  assert.strictEqual(missing.code, cli.EXIT_USER);
  assert.match(missing.err, /No such directory/);

  const noPath = await runCli(["dev", "link"]);
  assert.strictEqual(noPath.code, cli.EXIT_USER);
  assert.match(noPath.err, /Name a directory/);

  const bogus = await runCli(["dev", "frobnicate"]);
  assert.strictEqual(bogus.code, cli.EXIT_USER);
  assert.match(bogus.err, /unknown dev command "frobnicate"/);

  const unknown = await runCli(["dev", "run", "nothing-here"]);
  assert.strictEqual(unknown.code, cli.EXIT_USER);
  assert.match(unknown.err, /No dev link called/);
});

test("cli dev: run spawns the tree's binary and reports the pid", async (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "sleepy");
  fs.mkdirSync(dir);
  const bin = path.join(dir, "sleepy");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 20\n");
  fs.chmodSync(bin, 0o755);

  await runCli(["dev", "link", dir]);
  const r = await runCli(["dev", "run", "sleepy", "--json"]);
  assert.strictEqual(r.code, cli.EXIT_OK);
  const out = JSON.parse(r.out);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.cmd, bin);
  assert.strictEqual(out.cwd, dir, "a dev build runs from its own tree");
  assert.strictEqual(out.source, "heuristic");
  assert.ok(out.pid > 0);
  t.after(() => {
    try {
      process.kill(out.pid, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });

  const plain = await runCli(["dev", "run", "sleepy"]);
  assert.match(plain.out, /Launched sleepy pid \d+/);
  const pid2 = Number(/pid (\d+)/.exec(plain.out)[1]);
  t.after(() => {
    try {
      process.kill(pid2, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });
});

test("cli dev: a tree with nothing runnable points at --cmd, and exits 1", async (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "docs");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "hi");

  await runCli(["dev", "link", dir]);
  const r = await runCli(["dev", "run", "docs"]);
  assert.strictEqual(r.code, cli.EXIT_USER);
  assert.match(r.err, /Nothing executable found/);
  assert.match(r.err, /--cmd/);
});

test("cli dev: an explicit launchCmd wins over the heuristic", async (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "two-ways");
  fs.mkdirSync(dir);
  for (const name of ["two-ways", "start.sh"]) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nsleep 20\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  }

  await runCli(["dev", "link", dir, "--cmd", "./start.sh --dev"]);
  const r = await runCli(["dev", "run", "two-ways", "--json"]);
  const out = JSON.parse(r.out);
  assert.strictEqual(out.source, "launchCmd");
  assert.strictEqual(out.cmd, path.join(dir, "start.sh"));
  assert.deepStrictEqual(out.args, ["--dev"]);
  t.after(() => {
    try {
      process.kill(out.pid, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  });
});

test("cli dev: the help text lists the command", async () => {
  const r = await runCli(["help"]);
  assert.match(r.out, /dev\s+ls \| link <path>/);
  assert.match(r.out, /bisect/);
});

/* ------------------------------------------------ discovery's model flag */

test("cli dev: a linked id gives the discovery model a devLink flag, and nothing else", (t) => {
  const env = useEnv(t);
  const dir = path.join(env.root, "quadforge");
  fs.mkdirSync(dir);
  devlinks.link({ path: dir });

  const discovery = require("../../src/main/discovery");
  const build = () =>
    discovery.buildApp({
      repo: { name: "quadforge", full_name: "nerdrx/quadforge", owner: { login: "nerdrx" } },
      release: { tag_name: "v1.0", assets: [], published_at: "2026-01-01T00:00:00Z" },
      overlay: { apps: {} },
      installedState: {},
      adb: { available: false, devices: [] },
      primaryOwner: "nerdrx",
      settings: { owners: ["nerdrx"] },
    });

  assert.deepStrictEqual(build().devLink, { path: dir });

  devlinks.unlink("quadforge");
  assert.strictEqual(build().devLink, undefined, "no link, no flag — not a false one");

  // and a store that cannot be read at all must not break discovery
  fs.writeFileSync(devlinks.storePath(), "{{{ broken");
  devlinks._reset();
  assert.strictEqual(build().devLink, undefined);
  assert.strictEqual(build().id, "quadforge", "the app is discovered exactly as before");
  assert.ok(os.homedir());
});
