// getDiskUsage() → the rows behind the Storage section: one bar per app, one for
// the download cache, and a total. Locale-independent formatting throughout.

import { formatBytes } from './version.js';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeDiskUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : null;
  if (!u) return null;
  const perApp = {};
  const src = u.perApp && typeof u.perApp === 'object' ? u.perApp : {};
  for (const [id, bytes] of Object.entries(src)) {
    if (!id) continue;
    perApp[id] = num(bytes);
  }
  const downloads = num(u.downloads);
  const summed = Object.values(perApp).reduce((a, b) => a + b, 0) + downloads;
  return { perApp, downloads, total: num(u.total) || summed };
}

/**
 * Bars for the Storage section, biggest first, download cache last.
 * @param {object} usage getDiskUsage() payload
 * @param {Array}  apps  normalized apps (for display names)
 */
export function usageRows(usage, apps) {
  const u = normalizeDiskUsage(usage);
  if (!u) return [];
  const names = new Map((Array.isArray(apps) ? apps : []).map((a) => [a.id, a.name]));
  const max = Math.max(
    u.downloads,
    ...Object.values(u.perApp),
    1
  );
  const rows = Object.entries(u.perApp)
    .filter(([, bytes]) => bytes > 0)
    .map(([id, bytes]) => ({
      id,
      name: names.get(id) || id,
      bytes,
      size: formatBytes(bytes),
      pct: Math.max(2, Math.round((bytes / max) * 100)),
      cache: false,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'en'));

  if (u.downloads > 0) {
    rows.push({
      id: '__downloads__',
      name: 'Download cache',
      bytes: u.downloads,
      size: formatBytes(u.downloads),
      pct: Math.max(2, Math.round((u.downloads / max) * 100)),
      cache: true,
    });
  }
  return rows;
}

export function usageTotalLabel(usage) {
  const u = normalizeDiskUsage(usage);
  if (!u || !u.total) return '';
  return formatBytes(u.total);
}

/** Result text for clearDownloadCache(); tolerates a bare number or a boolean. */
export function freedLabel(result) {
  if (result === null || result === undefined || result === false) return 'Download cache cleared';
  const bytes =
    typeof result === 'number'
      ? result
      : num(result.freed) || num(result.freedBytes) || num(result.bytes);
  if (!bytes) return 'Download cache cleared — nothing to remove';
  return `Download cache cleared — ${formatBytes(bytes)} freed`;
}

/** Normalize importSettings() into something renderable. */
export function normalizeImportResult(result) {
  if (result === null || result === undefined) {
    return { ok: false, message: 'Import failed — no answer from the hub.', warnings: [] };
  }
  if (result === true) return { ok: true, message: 'Settings imported.', warnings: [] };
  if (result === false) return { ok: false, message: 'Import failed.', warnings: [] };
  if (typeof result !== 'object') return { ok: true, message: String(result), warnings: [] };

  const ok = result.ok !== false && !result.error;
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String).filter(Boolean) : [];
  if (!ok) {
    return { ok: false, message: String(result.error || result.message || 'Import failed.'), warnings };
  }
  const counted = Number(result.imported);
  const message = result.message
    ? String(result.message)
    : Number.isFinite(counted)
      ? `Settings imported — ${counted} ${counted === 1 ? 'entry' : 'entries'} applied.`
      : 'Settings imported.';
  return { ok: true, message, warnings };
}
