import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  freedLabel,
  normalizeDiskUsage,
  normalizeImportResult,
  usageRows,
  usageTotalLabel,
} from '../../src/renderer/lib/storage.js';
import { formatBytes } from '../../src/renderer/lib/version.js';
import {
  renderStorageSection,
  renderLogsSection,
  renderImportResult,
  renderBackupSection,
  renderSettingsPanel,
} from '../../src/renderer/views/settings.js';
import { createMock } from '../../src/renderer/mock.js';

const APPS = [
  { id: 'wivrn-nx', name: 'WiVRn NX' },
  { id: 'pulsenx', name: 'PulseNX' },
];
const USAGE = { perApp: { 'wivrn-nx': 486_000_000, pulsenx: 212_400_000, ghost: 4_000_000 }, downloads: 903_500_000 };

/* ---------------------------------------------------- human-unit formatting */

test('formatBytes is locale-independent all the way up to TB', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(12_345_678), '11.8 MB');
  assert.equal(formatBytes(13_300_000_000), '12.4 GB');
  assert.equal(formatBytes(1_500_000_000_000), '1.4 TB');
  // A de_DE host would print "12,4 GB" via toLocaleString — we never do.
  assert.ok(!formatBytes(13_300_000_000).includes(','));
  assert.equal(formatBytes('nonsense'), '');
  assert.equal(formatBytes(-5), '');
});

/* --------------------------------------------------------------- disk usage */

test('normalizeDiskUsage sums a missing total and drops junk', () => {
  assert.equal(normalizeDiskUsage(null), null);
  const u = normalizeDiskUsage({ perApp: { a: 100, b: '-3', '': 9 }, downloads: 50 });
  assert.deepEqual(u.perApp, { a: 100, b: 0 });
  assert.equal(u.downloads, 50);
  assert.equal(u.total, 150, 'total is derived when main did not send one');
  assert.equal(normalizeDiskUsage({ perApp: {}, downloads: 0, total: 999 }).total, 999);
});

test('usageRows are biggest-first with the download cache last', () => {
  const rows = usageRows(USAGE, APPS);
  assert.deepEqual(rows.map((r) => r.name), ['WiVRn NX', 'PulseNX', 'ghost', 'Download cache']);
  assert.equal(rows[0].size, '463 MB');
  assert.equal(rows[rows.length - 1].cache, true);
  // Bars are relative to the biggest row and never disappear entirely.
  assert.equal(rows[rows.length - 1].pct, 100);
  assert.ok(rows.every((r) => r.pct >= 2 && r.pct <= 100));
  assert.equal(usageTotalLabel(USAGE), formatBytes(486_000_000 + 212_400_000 + 4_000_000 + 903_500_000));
  assert.deepEqual(usageRows(null, APPS), []);
  assert.equal(usageTotalLabel(null), '');
});

test('freedLabel copes with every plausible answer shape', () => {
  assert.match(freedLabel({ freed: 903_500_000 }), /862 MB freed/);
  assert.match(freedLabel({ freedBytes: 1024 }), /1\.0 KB freed/);
  assert.match(freedLabel(2048), /2\.0 KB freed/);
  assert.match(freedLabel(true), /cleared/);
  assert.match(freedLabel({ ok: true }), /nothing to remove/);
  assert.match(freedLabel(null), /cleared/);
});

/* ------------------------------------------------------------ import result */

test('normalizeImportResult renders something useful for any answer', () => {
  assert.deepEqual(normalizeImportResult(true), { ok: true, message: 'Settings imported.', warnings: [] });
  assert.equal(normalizeImportResult(false).ok, false);
  assert.match(normalizeImportResult(null).message, /no answer/);
  assert.equal(normalizeImportResult({ ok: true, imported: 1 }).message, 'Settings imported — 1 entry applied.');
  assert.equal(normalizeImportResult({ ok: true, imported: 7 }).message, 'Settings imported — 7 entries applied.');
  const bad = normalizeImportResult({ error: 'broken json' });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'broken json');
  const warned = normalizeImportResult({ ok: true, imported: 2, warnings: ['token replaced', ''] });
  assert.deepEqual(warned.warnings, ['token replaced']);
});

test('the import result block escapes what main sent back', () => {
  const out = renderImportResult(normalizeImportResult({ error: '<script>x</script>' }));
  assert.match(out, /import-result bad/);
  assert.ok(!out.includes('<script>'));
  const ok = renderImportResult(normalizeImportResult({ ok: true, imported: 3, warnings: ['careful'] }));
  assert.match(ok, /import-result ok/);
  assert.match(ok, /<li>careful<\/li>/);
  assert.equal(renderImportResult(null), '');
});

/* ------------------------------------------------------------ settings view */

test('the storage section draws a bar per app plus a total', () => {
  const out = renderStorageSection(USAGE, APPS, {});
  assert.match(out, /WiVRn NX/);
  assert.match(out, /usage-cache/);
  assert.match(out, /Total <strong>/);
  assert.match(out, /data-act="clear-cache"/);
  assert.match(out, /data-act="disk-usage"/);
  assert.match(renderStorageSection(null, APPS, { loading: true }), /Measuring…/);
  assert.match(renderStorageSection(null, APPS, {}), /Not measured yet/);
  assert.ok(!renderStorageSection(USAGE, APPS, { caps: { clearDownloadCache: false } }).includes('clear-cache'));
});

test('the logs section is monospace, on demand, with a copy button', () => {
  assert.match(renderLogsSection({}), /Show last 200 lines/);
  assert.ok(!renderLogsSection({}).includes('data-act="copy-logs"'));
  const shown = renderLogsSection({ text: 'line one\n<script>' });
  assert.match(shown, /<pre class="logbox"/);
  assert.match(shown, /data-act="copy-logs"/);
  assert.ok(!shown.includes('<script>'));
  assert.match(renderLogsSection({ loading: true }), /Reading the log/);
  assert.match(renderLogsSection({ error: 'no log' }), /field-error/);
});

test('backup buttons disappear with their bridge methods', () => {
  assert.match(renderBackupSection({}), /data-act="export-settings"/);
  assert.match(renderBackupSection({}), /data-act="import-settings"/);
  assert.equal(renderBackupSection({ caps: { exportSettings: false, importSettings: false } }), '');
});

test('the settings panel gained the v0.2 sections and keeps the old ones', () => {
  const out = renderSettingsPanel(
    {
      owners: ['nerdrx'],
      extraRepos: [],
      updatePolicy: 'download',
      includePrereleases: true,
      notifications: false,
      autostart: true,
      startMinimized: false,
      createDesktopEntries: true,
      maxConcurrentDownloads: 3,
      checkIntervalHours: 6,
    },
    { hubVersion: '0.2.0', apps: APPS, diskUsage: USAGE, logs: { text: 'hello' } }
  );
  // old
  assert.match(out, /data-act="add-owner"/);
  assert.match(out, /data-act="save-settings"/);
  // new
  assert.match(out, /data-field="updatePolicy"/);
  assert.match(out, /value="download"\s+selected/);
  assert.match(out, /data-field="includePrereleases"[^>]*checked/);
  assert.ok(!/data-field="notifications"[^>]*checked/.test(out), 'notifications=false renders unchecked');
  assert.match(out, /data-field="autostart"[^>]*checked/);
  assert.match(out, /data-field="createDesktopEntries"[^>]*checked/);
  assert.match(out, /data-act="step"[^>]*data-delta="1"/);
  assert.match(out, /class="input input-num stepper-value"[^>]*value="3"/);
  assert.match(out, /data-act="load-logs"/);
  assert.match(out, /data-act="export-settings"/);
  assert.ok(!out.includes('<script'));
});

test('a build without the v0.2 methods hides those sections entirely', () => {
  const out = renderSettingsPanel(
    { owners: [], extraRepos: [] },
    { caps: { getDiskUsage: false, getLogs: false, exportSettings: false, importSettings: false } }
  );
  assert.ok(!out.includes('data-act="disk-usage"'));
  assert.ok(!out.includes('data-act="load-logs"'));
  assert.ok(!out.includes('data-act="export-settings"'));
  assert.match(out, /data-act="add-owner"/, 'the frozen v1 sections survive');
});

/* ------------------------------------------------------------ mock bridge */

test('the mock measures, clears, logs, exports and imports', async () => {
  const { nxhub, dev } = createMock();

  const usage = await nxhub.getDiskUsage();
  assert.ok(usage.total > 0);
  assert.ok(Object.keys(usage.perApp).length >= 3);
  assert.ok(usage.downloads > 0);

  const cleared = await nxhub.clearDownloadCache();
  assert.equal(cleared.freed > 0, true);
  assert.equal((await nxhub.getDiskUsage()).downloads, 0);

  dev.populateDisk();
  assert.ok((await nxhub.getDiskUsage()).downloads > 0, 'the dev button refills the cache');

  const logs = await nxhub.getLogs(200);
  assert.equal(logs.split('\n').length, 200);
  assert.match(logs, /discovery|github|jobs|adb|install|state|scheduler/);

  const json = await nxhub.exportSettings();
  const parsed = JSON.parse(json);
  assert.ok(parsed.settings.owners.includes('nerdrx'));

  const good = await nxhub.importSettings(json);
  assert.equal(good.ok, true);
  assert.ok(good.imported > 0);
  const bad = await nxhub.importSettings('{not json');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Could not parse/);
  const wrong = await nxhub.importSettings('[]');
  assert.equal(wrong.ok, false);
  dev.stop();
});
