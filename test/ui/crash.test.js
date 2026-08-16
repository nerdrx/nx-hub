// v0.6 crash-aware rollback and delta savings — the amber banner matrix, its
// dismissal (and re-arming), the tile corner mark, and the Δ chip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAppCard,
  renderCrashBanner,
  renderJobBar,
  crashBannerText,
  crashingArtifacts,
  crashKey,
} from '../../src/renderer/views/card.js';
import { renderTile } from '../../src/renderer/views/tile.js';
import { normalizeApp, normalizeArtifact, CRASH_LOOP_AT } from '../../src/renderer/lib/model.js';
import { hasDelta, isDeltaApplied, progressLabel } from '../../src/renderer/lib/version.js';
import { launchTiles } from '../../src/renderer/lib/launcher.js';
import { createMock } from '../../src/renderer/mock.js';

function app(over = {}, artOver = {}) {
  return normalizeApp({
    id: 'ogb',
    repo: 'nerdrx/OscGoesBrrr-NX-Patches',
    name: 'OGB NX-Patches',
    latest: { version: '1.6.0', tag: 'v1.6.0' },
    artifacts: [
      {
        id: 'appimage-linux',
        label: 'Linux app',
        platform: 'linux',
        kind: 'appimage',
        installed: { version: '1.6.0', path: '/apps/ogb' },
        crashCount: 4,
        crashLoop: true,
        rollbackAvailable: true,
        prevVersion: '1.4.1',
        ...artOver,
      },
    ],
    ...over,
  });
}

const CTX = { settings: { owners: ['nerdrx'] }, platform: 'linux', now: Date.now() };

/* ------------------------------------------------------------------ model */

test('crash fields normalize defensively — an older main sets none of them', () => {
  const bare = normalizeArtifact({ id: 'a', installed: { version: '1.0.0' } });
  assert.equal(bare.crashCount, 0);
  assert.equal(bare.crashLoop, false);
  assert.equal(bare.lastCrashAt, '');

  assert.equal(normalizeArtifact({ id: 'a', crashCount: '7', installed: {} }).crashCount, 7);
  assert.equal(normalizeArtifact({ id: 'a', crashCount: -2, installed: {} }).crashCount, 0);
  assert.equal(normalizeArtifact({ id: 'a', crashCount: 'lots', installed: {} }).crashCount, 0);

  // The count alone is enough — SPEC's threshold is applied here too.
  assert.equal(normalizeArtifact({ id: 'a', crashCount: CRASH_LOOP_AT, installed: {} }).crashLoop, true);
  assert.equal(normalizeArtifact({ id: 'a', crashCount: CRASH_LOOP_AT - 1, installed: {} }).crashLoop, false);
  // …but an explicit flag from main wins in both directions.
  assert.equal(normalizeArtifact({ id: 'a', crashCount: 9, crashLoop: false, installed: {} }).crashLoop, false);
  assert.equal(normalizeArtifact({ id: 'a', crashCount: 0, crashLoop: true, installed: {} }).crashLoop, true);
  // Nothing installed cannot be crashing.
  assert.equal(normalizeArtifact({ id: 'a', crashCount: 9, crashLoop: true }).crashLoop, false);
});

test('the banner sentence names the count and the version', () => {
  assert.equal(
    crashBannerText({ crashCount: 4, installed: { version: '1.6.0' } }),
    'Crashed 4 times since updating to 1.6.0.'
  );
  assert.equal(
    crashBannerText({ crashCount: 1, installed: { version: '2.0' } }),
    'Crashed 1 time since updating to 2.0.',
    'no bare plural'
  );
  assert.match(crashBannerText({ installed: { version: '1.0' } }), /Crashed repeatedly since updating to 1\.0\./);
  assert.match(crashBannerText(null), /this version/);
});

/* ------------------------------------------------------------ the matrix */

test('crashLoop + a kept previous install → the roll-back CTA', () => {
  const a = app();
  const out = renderCrashBanner(a, a.artifacts[0]);
  assert.match(out, /banner banner-crash/);
  assert.match(out, /role="alert"/);
  assert.match(out, /Crashed 4 times since updating to 1\.6\.0\./);
  assert.match(out, /data-act="rollback"[^>]*data-app="ogb"[^>]*data-art="appimage-linux"/);
  assert.match(out, /Roll back to 1\.4\.1/);
  assert.ok(!out.includes('data-act="install"'), 'no second primary competing with it');
  assert.match(out, /data-act="dismiss-crash"[^>]*data-version="1\.6\.0"/);
});

test('crashLoop with nothing kept → a Reinstall CTA, never a dead end', () => {
  const a = app({}, { rollbackAvailable: false, prevVersion: '' });
  const out = renderCrashBanner(a, a.artifacts[0]);
  assert.ok(!out.includes('data-act="rollback"'), 'there is nothing to roll back to');
  assert.match(out, /data-act="install"[^>]*data-app="ogb"[^>]*data-art="appimage-linux"/);
  assert.match(out, /Reinstall/);
  assert.match(out, /Crashed 4 times/, 'it still informs');
  assert.match(out, /data-act="dismiss-crash"/);
});

test('a build whose bridge has no rollback() falls back to Reinstall as well', () => {
  const a = app();
  const out = renderCrashBanner(a, a.artifacts[0], { caps: { rollback: false } });
  assert.ok(!out.includes('data-act="rollback"'));
  assert.match(out, /Reinstall/);
});

test('a healthy artifact has no banner at all', () => {
  const a = app({}, { crashLoop: false, crashCount: 0 });
  assert.deepEqual(crashingArtifacts(a), []);
  assert.ok(!renderAppCard(a, CTX).includes('banner-crash'));
  assert.equal(renderCrashBanner(null, null), '');
});

test('the card carries the banner, and a dismissal removes it', () => {
  const a = app();
  const key = crashKey('ogb', 'appimage-linux', '1.6.0');
  assert.equal(key, 'ogb::appimage-linux@1.6.0');

  const shown = renderAppCard(a, CTX);
  assert.match(shown, /banner-crash/);
  assert.ok(shown.indexOf('banner-crash') < shown.indexOf('class="arts"'), 'it sits above the artifacts');

  const hidden = renderAppCard(a, { ...CTX, dismissedCrashes: new Set([key]) });
  assert.ok(!hidden.includes('banner-crash'), 'dismissed for this version');

  // A plain array or object works too — storage shapes come and go.
  assert.ok(!renderAppCard(a, { ...CTX, dismissedCrashes: [key] }).includes('banner-crash'));
});

test('a new version re-arms a dismissed banner', () => {
  const dismissed = new Set([crashKey('ogb', 'appimage-linux', '1.6.0')]);
  const updated = app({}, { installed: { version: '1.6.1', path: '/apps/ogb' } });
  const out = renderAppCard(updated, { ...CTX, dismissedCrashes: dismissed });
  assert.match(out, /banner-crash/, 'the old dismissal does not silence the new version');
  assert.match(out, /Crashed 4 times since updating to 1\.6\.1\./);
  assert.match(out, /data-act="dismiss-crash"[^>]*data-version="1\.6\.1"/);
});

test('a card with several artifacts names the one that is crashing', () => {
  const many = normalizeApp({
    id: 'ogb',
    repo: 'nerdrx/ogb',
    name: 'OGB',
    latest: { version: '1.6.0' },
    artifacts: [
      { id: 'appimage-linux', label: 'Linux app', installed: { version: '1.6.0' }, crashLoop: true, crashCount: 3 },
      { id: 'windows-portable-windows', label: 'Windows portable', platform: 'windows' },
    ],
  });
  const out = renderCrashBanner(many, many.artifacts[0]);
  assert.match(out, /crash-art">Linux app</);
  assert.equal(crashingArtifacts(many).length, 1);
});

/* ------------------------------------------------------------ tile mark */

test('a crash-looping launch tile gets an amber corner mark', () => {
  const [tile] = launchTiles([app()], { platform: 'linux' });
  assert.equal(tile.crashLoop, true);
  assert.equal(tile.crashCount, 4);
  const out = renderTile(tile);
  assert.match(out, /class="tile-crash"/);
  assert.match(out, /crashed 4× right after launching/);

  const [calm] = launchTiles([app({}, { crashLoop: false, crashCount: 0 })], { platform: 'linux' });
  assert.ok(!renderTile(calm).includes('tile-crash'));
});

/* ----------------------------------------------------------- delta chip */

test('the Δ chip follows the engine’s vocabulary, not the bare word', () => {
  assert.equal(hasDelta('downloading delta patch (18.2 MB instead of 96.4 MB)'), true);
  assert.equal(hasDelta('delta patch — 8.1 MB / 18.2 MB'), true);
  assert.equal(hasDelta('applying delta patch (zstd, from 1.4.1)'), true);
  assert.equal(hasDelta('verifying the delta result'), true);
  assert.equal(hasDelta('delta applied — 18.2 MB downloaded instead of 96.4 MB (81% saved)'), true);

  // An app or asset whose NAME contains the word must not light the chip.
  assert.equal(hasDelta('12.4 MB/s'), false);
  assert.equal(hasDelta('downloading DeltaChat-1.44.0.AppImage'), false);
  assert.equal(hasDelta('delta'), false);
  assert.equal(hasDelta('Delta Force'), false);
  assert.equal(hasDelta(''), false);
  assert.equal(hasDelta(null), false);

  assert.equal(isDeltaApplied('delta applied — 18.2 MB downloaded instead of 96.4 MB'), true);
  assert.equal(isDeltaApplied('applying delta patch (zstd)'), false);
});

test('a delta job bar appends the chip to its phase label', () => {
  const out = renderJobBar({
    id: 'j1',
    phase: 'download',
    pct: 43,
    message: 'downloading delta patch (18.2 MB instead of 96.4 MB)',
  });
  assert.match(out, /class="job-phase">Downloading 43%<span class="delta-chip"/);
  assert.match(out, /Δ<\/span>/);
  assert.match(out, /title="delta update/);
  assert.match(out, /width:43%/);
  assert.ok(!out.includes('job-note'), 'the closing line has not landed yet');
});

test('a plain job bar has no chip, and a plain speed still reads', () => {
  const out = renderJobBar({ id: 'j2', phase: 'download', pct: 12, message: '12.4 MB/s' });
  assert.ok(!out.includes('delta-chip'));
  assert.match(out, /Downloading 12% — 12\.4 MB\/s/);
  assert.equal(progressLabel('download', 12, '12.4 MB/s'), 'Downloading 12% — 12.4 MB/s');
});

test('the closing "delta applied" line is surfaced under the bar', () => {
  const message = 'delta applied — 18.2 MB downloaded instead of 96.4 MB (81% saved)';
  const out = renderJobBar({ id: 'j3', phase: 'cleanup', pct: 100, message });
  assert.match(out, /delta-chip/);
  assert.match(out, /class="job-note">delta applied — 18\.2 MB downloaded instead of 96\.4 MB \(81% saved\)/);
});

test('a job message is escaped like everything else', () => {
  const out = renderJobBar({
    id: 'j4',
    phase: 'download',
    pct: 5,
    message: 'delta patch <script>alert(1)</script>',
  });
  assert.ok(!out.includes('<script>'));
  assert.match(out, /delta-chip/);
});

/* ------------------------------------------------------------------ mock */

test('the mock ships a crash-looping app and can cycle its states', async () => {
  const { nxhub, dev } = createMock();
  const state = await nxhub.getState();
  const art = state.apps
    .find((a) => a.id === 'oscgoesbrrr-nx-patches')
    .artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(art.crashLoop, true);
  assert.equal(art.crashCount, 4);
  assert.equal(art.rollbackAvailable, true);
  assert.ok(art.lastCrashAt, 'and it says when it last died');

  assert.equal(dev.cycleCrashLoop(), 'no-rollback');
  const next = (await nxhub.getState()).apps
    .find((a) => a.id === 'oscgoesbrrr-nx-patches')
    .artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(next.crashLoop, true);
  assert.equal(next.rollbackAvailable, false, 'the banner now only informs + reinstalls');

  assert.equal(dev.cycleCrashLoop(), 'healthy');
  const calm = (await nxhub.getState()).apps
    .find((a) => a.id === 'oscgoesbrrr-nx-patches')
    .artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(calm.crashLoop, false);
  assert.equal(calm.crashCount, 0);
  assert.equal(dev.cycleCrashLoop(), 'looping', 'and round again');
  dev.stop();
});

test('the mock delta job speaks the real vocabulary and resets the crash count', async () => {
  const { nxhub, dev } = createMock();
  const messages = [];
  nxhub.onEvent((ev) => {
    if (ev.type === 'job-progress' && ev.message) messages.push(ev.message);
  });
  assert.ok(dev.simulateDeltaJob(), 'the job started');
  await new Promise((r) => setTimeout(r, 4400));

  assert.ok(messages.some((m) => /downloading delta patch/.test(m)), messages.join(' | '));
  assert.ok(messages.some((m) => /applying delta patch/.test(m)), messages.join(' | '));
  assert.ok(messages.some((m) => /delta applied/.test(m)), messages.join(' | '));
  assert.ok(messages.every((m) => hasDelta(m)), 'every message of a delta job lights the chip');

  const art = (await nxhub.getState()).apps
    .find((a) => a.id === 'oscgoesbrrr-nx-patches')
    .artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(art.installed.version, '1.6.0', 'the install landed');
  assert.equal(art.crashLoop, false, 'new bytes, fresh crash counter');
  assert.equal(art.crashCount, 0);
  dev.stop();
});
