"use strict";
// src/cli/render.js — list / info / versions / doctor / help, plain and styled.

const test = require("node:test");
const assert = require("node:assert");

const render = require("../../src/cli/render");
const { createStyle, strip, PALETTE } = require("../../src/cli/ansi");
const fx = require("./fixtures");

const plain = createStyle(false);
const color = createStyle(true);
const VIOLET = `38;2;${PALETTE.violet.join(";")}`;
const AMBER = `38;2;${PALETTE.amber.join(";")}`;

/* ---------------------------------------------------------------- list */

test("cli/render: list shows one row per installable app with status glyphs", () => {
  const out = render.renderList(fx.APPS, { style: plain });
  const lines = out.split("\n");

  const wivrn = lines.find((l) => l.includes("WiVRn NX"));
  assert.match(wivrn, /^\s*↑\s+WiVRn NX\s+1\.3\.2\s+1\.4\.0\s+wivrn-nx$/, "update pending → amber arrow row");

  const quad = lines.find((l) => l.includes("QuadForge"));
  assert.match(quad, /^\s*✓\s+QuadForge\s+1\.3\s+1\.3\s+quadforge$/, "installed and current → check");

  const limbo = lines.find((l) => l.includes("LIMBO PROTOCOL"));
  assert.match(limbo, /^\s*·\s+LIMBO PROTOCOL\s+—\s+2\.0\s+banish-protocol$/, "not installed → dot");
});

test("cli/render: list never uses emoji and stays ASCII-safe apart from the glyphs", () => {
  const out = render.renderList(fx.APPS, { style: plain });
  assert.ok(!/\p{Extended_Pictographic}/u.test(out), "no emoji anywhere");
});

test("cli/render: list summarises counts and the bottom section", () => {
  const out = render.renderList(fx.APPS, { style: plain });
  assert.match(out, /apps 6\s+installed 2\s+updates 1/);
  assert.match(out, /O T H E R {3}R E P O S/, "uppercase wide-tracked section label");
  assert.match(out, /lonely-repo, petri/);
  assert.ok(!out.includes("lonely-repo — no releases yet"), "reasons need --all");
});

test("cli/render: list --all spells out why each bottom app is down there", () => {
  const out = render.renderList(fx.APPS, { style: plain, showAll: true });
  assert.match(out, /lonely-repo — no releases yet/);
  assert.match(out, /petri — hidden by the overlay registry/);
});

test("cli/render: a foreign owner is named next to the app", () => {
  const out = render.renderList(fx.APPS, { style: plain });
  assert.match(out, /cool-tool \(someone-else\)/);
});

test("cli/render: the styled list carries violet headers and amber updates", () => {
  const out = render.renderList(fx.APPS, { style: color });
  assert.ok(out.includes(`\u001b[${VIOLET}m`), "violet section label");
  assert.ok(out.includes(`\u001b[${AMBER}m`), "amber for the pending update");
  assert.equal(strip(out), render.renderList(fx.APPS, { style: plain }), "colour changes nothing but the escapes");
});

test("cli/render: an empty model invites the next action instead of apologising", () => {
  const out = render.renderList([], { style: plain });
  assert.match(out, /Nothing discovered yet/);
  assert.match(out, /apps 0/);
});

/* ---------------------------------------------------------------- json */

test("cli/render: listJson is a stable, complete projection", () => {
  const doc = render.listJson(fx.APPS, { hubVersion: "0.3.6", platform: "linux" });
  assert.equal(doc.hubVersion, "0.3.6");
  assert.deepEqual(doc.summary, { total: 6, published: 4, bottom: 2, installed: 2, updates: 1 });

  const wivrn = doc.apps.find((a) => a.id === "wivrn-nx");
  assert.equal(wivrn.status, "update");
  assert.deepEqual(wivrn.installedVersions, ["1.3.2"]);
  assert.equal(wivrn.artifacts.length, 2);
  assert.deepEqual(wivrn.artifacts[0].installed, { version: "1.3.2", path: null, installedAt: "2026-04-02T00:00:00Z" });
  assert.equal(wivrn.artifacts[1].fromOlderRelease, true);
  assert.equal(wivrn.artifacts[1].sourceTag, "v1.3.0");

  // survives a round trip — the whole point of --json
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test("cli/render: statusOf covers every state", () => {
  assert.equal(render.statusOf(fx.wivrn), "update");
  assert.equal(render.statusOf(fx.quadforge), "installed");
  assert.equal(render.statusOf(fx.limbo), "available");
  assert.equal(render.statusOf(fx.lonely), "unpublished");
});

/* ---------------------------------------------------------------- info */

test("cli/render: info is a card in text form", () => {
  const out = render.renderInfo(fx.wivrn, { style: plain, platform: "linux" });
  assert.match(out, /W I V R N {3}N X/);
  assert.match(out, /repo\s+nerdrx\/wivrn-nx/);
  assert.match(out, /latest\s+1\.4\.0 {2}\(v1\.4\.0\) {2}2026-05-01/);
  assert.match(out, /status\s+update available/);
  assert.match(out, /A R T I F A C T S/);
  assert.match(out, /apk-adb-android\s+Headset APK\s+android/);
  assert.match(out, /tarball-prefix-linux\s+Linux server\s+linux/);
});

test("cli/render: info shows artifact provenance and the post-install note", () => {
  const out = render.renderInfo(fx.wivrn, { style: plain, platform: "linux" });
  assert.match(out, /1\.3\.0 \(older\)/, "the carried-over artifact names its own source version");
  assert.match(out, /\(older\) = carried over from v1\.3\.0/);
  assert.match(out, /note tarball-prefix-linux: Re-run: sudo setcap/);
});

test("cli/render: an offline device does not hide the pending APK update", () => {
  const offline = fx.app({
    name: "WiVRn NX",
    artifacts: [
      fx.artifact({
        id: "apk-adb-android",
        platform: "android",
        kind: "apk-adb",
        installed: { version: "1.3" },
        updateAvailable: true,
        deviceOffline: true,
      }),
    ],
  });
  assert.match(render.renderInfo(offline, { style: plain }), /update available \(device offline\)/);

  const current = fx.app({
    artifacts: [fx.artifact({ id: "apk-adb-android", platform: "android", kind: "apk-adb", deviceOffline: true })],
  });
  assert.match(render.renderInfo(current, { style: plain }), /not checked \(device offline\)/);
});

test("cli/render: info of an unreleased repo says so", () => {
  const out = render.renderInfo(fx.lonely, { style: plain });
  assert.match(out, /no releases yet/);
});

test("cli/render: info sizes are locale-independent", () => {
  const out = render.renderInfo(fx.limbo, { style: plain });
  assert.match(out, /3\.0 MB/, "hub's own fmtBytes, never toLocaleString");
});

/* ---------------------------------------------------------------- versions */

test("cli/render: versions marks latest, installed and prereleases", () => {
  const out = render.renderVersions(fx.wivrn, fx.RELEASES, { style: plain });
  assert.match(out, /v1\.4\.0\s+1\.4\.0\s+2026-05-01\s+2\s+latest/);
  assert.match(out, /v1\.5\.0-rc1\s+1\.5\.0-rc1\s+2026-05-10\s+0\s+prerelease/);
  assert.match(out, /nx install wivrn-nx --tag <tag>/);
});

test("cli/render: versions with nothing published", () => {
  assert.match(render.renderVersions(fx.lonely, [], { style: plain }), /No releases found/);
});

/* ---------------------------------------------------------------- doctor */

test("cli/render: doctor reports the environment", () => {
  const out = render.renderDoctor(fx.DOCTOR, { style: plain });
  assert.match(out, /D O C T O R/);
  assert.match(out, /hub version\s+0\.3\.6/);
  assert.match(out, /data dir\s+\/tmp\/nx\/data/);
  assert.match(out, /install root\s+\/tmp\/nx\/apps/);
  assert.match(out, /token\s+gh auth token/);
  assert.match(out, /adb\s+1 device — PA7X \(Pico 4 Ultra\)/);
  assert.match(out, /install engine\s+ready/);
  assert.match(out, /cli shim\s+\/home\/u\/\.local\/bin\/nx \(current\)/);
  assert.match(out, /rate limit\s+ok/);
});

test("cli/render: doctor is honest when things are missing", () => {
  const broken = Object.assign({}, fx.DOCTOR, {
    tokenSource: "",
    adb: { available: false, devices: [] },
    engine: false,
    engineError: "Install engine unavailable: boom",
    rateLimit: { resetAt: Date.parse("2026-08-15T23:30:00Z"), message: "rate limited" },
    shimState: "missing",
    lastRefresh: null,
    errors: [{ source: "nerdrx", message: "network unreachable" }],
  });
  const out = render.renderDoctor(broken, { style: plain });
  assert.match(out, /token\s+anonymous \(60 req\/h\)/);
  assert.match(out, /adb\s+not found \(settings\.adbPath = adb\)/);
  assert.match(out, /install engine\s+unavailable — Install engine unavailable: boom/);
  assert.match(out, /rate limit\s+throttled until 23:30 UTC/);
  assert.match(out, /last refresh\s+never/);
  assert.match(out, /discovery warnings/);
  assert.match(out, /nerdrx: network unreachable/);
});

/* ---------------------------------------------------------------- help */

test("cli/render: help lists every command and the exit codes", () => {
  const out = render.renderHelp({ style: plain, hubVersion: "0.3.6" });
  for (const [cmd] of render.COMMANDS) assert.ok(out.includes(cmd), `help mentions ${cmd}`);
  assert.match(out, /exit codes: 0 ok · 1 usage error · 2 operation failed/);
});

/* ---------------------------------------------------------------- pieces */

test("cli/render: table pads on visible width, not on escape bytes", () => {
  const rows = [
    [render.T("a", color.violet), render.T("longer-value", color.cyan)],
    [render.T("bbbbbb", color.amber), render.T("x", color.muted)],
  ];
  const lines = render.table(["one", "two"], rows, color);
  const widths = lines.map((l) => strip(l).indexOf("  ", 2));
  assert.equal(new Set(lines.map((l) => strip(l).slice(0, 10))).size, 3, "three distinct rows");
  assert.ok(widths.every((w) => w > 0));
  // the plain rendering of the same table lines up
  const plainLines = render.table(["one", "two"], [[render.T("a"), render.T("longer-value")], [render.T("bbbbbb"), render.T("x")]], plain);
  assert.equal(strip(lines[1]).replace(/\s+$/, ""), plainLines[1].replace(/\s+$/, ""));
});

test("cli/render: dateOnly keeps ISO, never a locale format", () => {
  assert.equal(render.dateOnly("2026-05-01T10:00:00Z"), "2026-05-01");
  assert.equal(render.dateOnly(null), "");
  assert.equal(render.dateOnly("nonsense"), "");
});
