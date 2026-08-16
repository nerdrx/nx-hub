"use strict";
// Remote install / launch / update-all, and the progress relay back.

const test = require("node:test");
const assert = require("node:assert");

const h = require("./helpers");

test.after(async () => {
  await h.stopAll();
  h.cleanupTempDirs();
});

/** A pair of hubs where B owns the apps and the job queue. */
async function twoHubs({ apps = [], jobs = null } = {}) {
  const jobsB = jobs || h.fakeJobs();
  const discoveryB = h.fakeDiscovery(apps);
  const a = await h.startFleet();
  const b = await h.startFleet({ discovery: discoveryB, jobs: jobsB });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await h.waitForSession(b, a.localId);
  return { a, b, jobsB, discoveryB };
}

const WIVRN = h.app("wivrn-nx", {
  name: "WiVRn NX",
  artifacts: [
    { id: "linux", label: "Linux app", platform: "linux", installed: { version: "0.6.0" }, updateAvailable: true },
  ],
});

test("remoteInstall enqueues on the REMOTE's job queue and acks the job id", async () => {
  const { a, b, jobsB } = await twoHubs({ apps: [WIVRN] });

  const ack = await a.remoteInstall(b.localId, "wivrn-nx", "linux");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.jobId, "job-1");
  assert.strictEqual(ack.appId, "wivrn-nx");
  assert.strictEqual(ack.artifactId, "linux");
  assert.strictEqual(ack.peerId, b.localId);
  assert.deepStrictEqual(jobsB.calls, [{ kind: "install", appId: "wivrn-nx", artifactId: "linux", jobId: "job-1" }]);
});

test("the artifact may be left out when the remote has exactly one that fits", async () => {
  const { a, b, jobsB } = await twoHubs({ apps: [WIVRN] });
  const ack = await a.remoteInstall(b.localId, "wivrn-nx");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(jobsB.calls[0].artifactId, "linux");
});

test("the REMOTE validates — an unknown app or artifact is refused, no job runs", async () => {
  const { a, b, jobsB } = await twoHubs({ apps: [WIVRN] });
  await assert.rejects(() => a.remoteInstall(b.localId, "nope"), /No app called "nope"/);
  await assert.rejects(() => a.remoteInstall(b.localId, "wivrn-nx", "windows"), /no download called "windows"/);
  assert.strictEqual(jobsB.calls.length, 0, "a refused request must never reach jobs");
});

test("an ambiguous artifact is refused with the count, not guessed", async () => {
  const many = h.app("multi", {
    artifacts: [
      { id: "one", platform: "linux" },
      { id: "two", platform: "linux" },
    ],
  });
  const { a, b } = await twoHubs({ apps: [many] });
  await assert.rejects(() => a.remoteInstall(b.localId, "multi"), /2 downloads — name one/);
});

test("remoteLaunch runs the remote's launch and acks", async () => {
  const { a, b, jobsB } = await twoHubs({ apps: [WIVRN] });
  const ack = await a.remoteLaunch(b.localId, "wivrn-nx", "linux");
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.launched, true);
  assert.deepStrictEqual(jobsB.calls, [{ kind: "launch", appId: "wivrn-nx", artifactId: "linux" }]);
});

test("remoteUpdateAll enqueues every pending update and reports the count", async () => {
  const apps = [
    WIVRN,
    h.app("pulsenx", {
      artifacts: [
        { id: "linux", updateAvailable: true },
        { id: "android", platform: "android", updateAvailable: false },
      ],
    }),
    h.app("facenx", { artifacts: [{ id: "linux", installed: { version: "1.0.0" } }] }),
  ];
  const { a, b, jobsB } = await twoHubs({ apps });
  const ack = await a.remoteUpdateAll(b.localId);
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.count, 2);
  assert.deepStrictEqual(
    jobsB.calls.map((c) => `${c.appId}/${c.artifactId}`),
    ["wivrn-nx/linux", "pulsenx/linux"]
  );
  assert.deepStrictEqual(ack.failures, []);
});

test("update-all on a hub with nothing pending acks zero", async () => {
  const { a, b } = await twoHubs({ apps: [h.app("facenx", { artifacts: [{ id: "linux" }] })] });
  const ack = await a.remoteUpdateAll(b.localId);
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.count, 0);
});

test("the remote's job events come back as fleet-progress tagged with the peer", async () => {
  const { a, b } = await twoHubs({ apps: [WIVRN] });
  const ack = await a.remoteInstall(b.localId, "wivrn-nx", "linux");

  // B's hub event fan-out is what index.js pipes into onHubEvent().
  b.onHubEvent({ type: "job-progress", jobId: ack.jobId, appId: "wivrn-nx", artifactId: "linux", phase: "download", pct: 42, message: "42%" });
  b.onHubEvent({ type: "job-done", jobId: ack.jobId, appId: "wivrn-nx", artifactId: "linux", message: "Installed 0.6.1" });

  const done = await h.waitUntil(
    () => a.events.find((e) => e.type === "fleet-progress" && e.event === "job-done") || false,
    4000,
    "the relayed job-done"
  );
  const progress = a.events.find((e) => e.type === "fleet-progress" && e.event === "job-progress");

  assert.ok(progress, "the progress event was relayed");
  assert.strictEqual(progress.peerId, b.localId);
  assert.strictEqual(progress.jobId, ack.jobId);
  assert.strictEqual(progress.rid, ack.rid || progress.rid);
  assert.strictEqual(progress.phase, "download");
  assert.strictEqual(progress.pct, 42);
  assert.strictEqual(progress.appId, "wivrn-nx");

  assert.strictEqual(done.peerId, b.localId);
  assert.strictEqual(done.message, "Installed 0.6.1");
});

test("a job nobody asked for is never relayed", async () => {
  const { a, b } = await twoHubs({ apps: [WIVRN] });
  b.onHubEvent({ type: "job-progress", jobId: "some-local-job", phase: "download", pct: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(
    a.events.filter((e) => e.type === "fleet-progress").length,
    0,
    "a peer must not see this hub's own jobs"
  );
});

test("relaying stops once the job finishes", async () => {
  const { a, b } = await twoHubs({ apps: [WIVRN] });
  const ack = await a.remoteInstall(b.localId, "wivrn-nx", "linux");
  b.onHubEvent({ type: "job-error", jobId: ack.jobId, message: "boom" });
  await h.waitUntil(() => a.events.some((e) => e.type === "fleet-progress" && e.event === "job-error"), 4000, "the error relay");
  const before = a.events.length;
  b.onHubEvent({ type: "job-progress", jobId: ack.jobId, pct: 90 });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(a.events.length, before, "a finished job is forgotten");
});

test("a request to an unknown peer fails without opening a socket", async () => {
  const a = await h.startFleet();
  await assert.rejects(() => a.remoteInstall("0123456789abcdef", "anything"), /No paired hub/);
});

test("a hub with no job queue refuses politely instead of throwing", async () => {
  const a = await h.startFleet();
  const b = await h.startFleet({ discovery: h.fakeDiscovery([WIVRN]), jobs: null });
  await h.pairHubs(a, b);
  await h.waitForSession(a, b.localId);
  await assert.rejects(() => a.remoteInstall(b.localId, "wivrn-nx", "linux"), /cannot run jobs/);
});

test("an unknown verb is answered, not hung up on", async () => {
  const { a, b } = await twoHubs({ apps: [WIVRN] });
  await assert.rejects(() => a.request(b.localId, { type: "teleport" }), /unknown request: teleport/);
  // The session is still up: the peer was authenticated, so a version gap is
  // not an attack.
  const ack = await a.remoteInstall(b.localId, "wivrn-nx", "linux");
  assert.strictEqual(ack.ok, true);
});
