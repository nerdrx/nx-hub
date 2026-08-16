// Config snapshots, as the UI sees them (SPEC v0.8 [timemachine]).
//
// getSnapshots(appId) answers newest-first with
// {file, ts (ISO), version, reason ∈ pre-update|pre-uninstall|pre-restore|manual,
//  bytes}. restoreSnapshot(appId, file) toasts itself and hands back
// {ok, restored, preRestore}; deleteSnapshot(appId, file) hands back the fresh
// list.
//
// Pure helpers only: normalization, the rollback-affinity rule, and the exact
// words the two confirms say. The semantics those words promise come from
// [timemachine]: a restore untars over $HOME in place — it OVERWRITES what is
// there and does NOT delete files that appeared since the snapshot. Both halves
// have to be in the copy, because "restore" alone reads as "revert", and a user
// who expects a revert will be surprised by whatever survived.

import { formatBytes, formatDate } from './version.js';

export const REASONS = ['pre-update', 'pre-uninstall', 'pre-restore', 'manual'];

const REASON_LABEL = {
  'pre-update': 'before an update',
  'pre-uninstall': 'before uninstalling',
  'pre-restore': 'before a restore',
  manual: 'taken by hand',
};

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Human words for a reason; an unknown one survives as itself. */
export function reasonLabel(reason) {
  const r = str(reason);
  return REASON_LABEL[r] || r || 'snapshot';
}

export function normalizeSnapshot(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const bytes = Number(s.bytes);
  return {
    file: str(s.file),
    ts: str(s.ts),
    version: str(s.version),
    reason: str(s.reason),
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
  };
}

/**
 * Newest first. The bridge already sorts, but a list this UI deletes from and
 * re-reads has to be self-consistent no matter which answer it got.
 */
export function normalizeSnapshots(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .filter(Boolean)
    .map(normalizeSnapshot)
    .filter((s) => s.file)
    .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
}

/** "14 Aug 2026 · 1.9.1 · before an update · 4.2 MB" */
export function snapshotLabel(snapshot) {
  const s = normalizeSnapshot(snapshot);
  return [formatDate(s.ts) || s.ts, s.version, reasonLabel(s.reason), formatBytes(s.bytes)]
    .filter(Boolean)
    .join(' · ');
}

/**
 * THE ROLLBACK AFFINITY RULE, verbatim from [timemachine]: when offering
 * "Roll back to V", a pre-update snapshot whose version is V is the config as
 * it stood before the update that is being undone. Newest wins — an app
 * updated away from V twice has two candidates and the recent one is the one
 * whose config the user actually lost.
 *
 * Anything else (a pre-uninstall at V, a pre-update at another version) is NOT
 * a hit: offering it would restore a config the user never asked to go back to.
 */
export function rollbackSnapshot(snapshots, version) {
  const v = str(version).trim();
  if (!v) return null;
  const list = normalizeSnapshots(snapshots);
  return list.find((s) => s.reason === 'pre-update' && s.version === v) || null;
}

/** The checkbox label offered next to a rollback that has an affinity hit. */
export const AFFINITY_LABEL = 'also restore the config from before the update';

export function affinityNote(snapshot) {
  const s = normalizeSnapshot(snapshot);
  const when = formatDate(s.ts);
  return `Taken ${when || 'before the update'}${s.bytes ? ` · ${formatBytes(s.bytes)}` : ''} — written back over the current config. Files added since then are left alone.`;
}

/** Text for the confirm() before restoring a snapshot on its own. */
export function restoreConfirmText(app, snapshot) {
  const name = (app && app.name) || (app && app.id) || 'this app';
  const s = normalizeSnapshot(snapshot);
  const when = formatDate(s.ts) || s.ts;
  return (
    `Restore ${name}’s config from ${when}?\n\n` +
    `${snapshotLabel(s)}\n\n` +
    'The files in the snapshot are written back over the current ones. ' +
    'Anything created since then stays where it is — this is not a full revert. ' +
    'The current config is snapshotted first, so this is undoable.'
  );
}

/** Text for the confirm() before deleting one. */
export function deleteConfirmText(app, snapshot) {
  const name = (app && app.name) || (app && app.id) || 'this app';
  const s = normalizeSnapshot(snapshot);
  return `Delete this ${name} snapshot?\n\n${snapshotLabel(s)}\n\nThe archive is removed from disk. Nothing else changes.`;
}

/** Empty-state line for the section. */
export const EMPTY_TEXT = 'Snapshots are taken automatically before updates.';

/** What restoreSnapshot() answered, as one sentence. */
export function restoreResultText(app, result) {
  const name = (app && app.name) || (app && app.id) || 'the app';
  const r = result && typeof result === 'object' ? result : {};
  if (r.ok === false) return `Could not restore ${name}’s config.`;
  const restored = Array.isArray(r.restored) ? r.restored.filter(Boolean) : [];
  const n = restored.length;
  const what = n ? `${n} path${n === 1 ? '' : 's'}` : 'the config';
  return `Restored ${what} for ${name}${r.preRestore ? ' — the previous config was snapshotted first' : ''}`;
}
