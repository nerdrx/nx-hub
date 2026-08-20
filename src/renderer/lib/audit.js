// Deep audit, as the UI sees it (SPEC v0.10 [audit]).
//
// getAudit() walks every recorded install and answers
//   [{appId, artifactId, ok, problems: [{kind, path?, detail}]}]
// where `kind` names the check that failed. repairInstall(appId, artifactId)
// reinstalls through the normal pipeline and therefore reports through the
// NORMAL job events — which is why nothing in this file models a repair: the
// existing job bar already does, and inventing a second progress vocabulary for
// the same bytes would guarantee the two drift apart.
//
// Pure normalization + labels. The audit describes the filesystem, so every
// `path` in it is a real path from this machine — still escaped at render time,
// because a path can contain anything a filename can.

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Human labels for the checks SPEC lists. An unknown kind is humanized rather
 * than dropped: a newer main process that adds a check must show up as a
 * problem with a readable name, not as a blank row.
 */
const KIND_LABELS = {
  'missing-dir': 'Install folder is gone',
  'missing-install-dir': 'Install folder is gone',
  'missing-manifest': 'Manifest is missing',
  'bad-manifest': 'Manifest will not parse',
  'missing-binary': 'Program file is missing',
  'not-executable': 'Program file is not executable',
  'missing-file': 'A recorded file is missing',
  'missing-outside-file': 'A file installed outside the folder is missing',
  'hash-mismatch': 'Contents do not match the release',
  'checksum-mismatch': 'Contents do not match the release',
  'missing-desktop-entry': 'Desktop entry is missing',
};

export function problemLabel(kind) {
  const k = str(kind).trim();
  if (KIND_LABELS[k]) return KIND_LABELS[k];
  if (!k) return 'Problem';
  const words = k.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The uppercase micro-label chip — DESIGN §5. Short, never the whole label. */
export function problemChip(kind) {
  const k = str(kind).trim();
  if (!k) return 'PROBLEM';
  return k.replace(/[-_]+/g, ' ').toUpperCase().slice(0, 16);
}

export function normalizeProblem(raw) {
  if (typeof raw === 'string') return raw.trim() ? { kind: raw.trim(), path: '', detail: '' } : null;
  if (!isPlainObject(raw)) return null;
  const kind = str(raw.kind).trim();
  const path = str(raw.path);
  const detail = str(raw.detail || raw.message);
  // A problem with nothing in it at all cannot be shown or acted on.
  if (!kind && !path && !detail) return null;
  return { kind: kind || 'problem', path, detail };
}

export function normalizeAuditRow(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const appId = str(r.appId || r.id).trim().toLowerCase();
  if (!appId) return null;
  const problems = [];
  for (const p of Array.isArray(r.problems) ? r.problems : []) {
    const problem = normalizeProblem(p);
    if (problem) problems.push(problem);
  }
  // `ok` is main's verdict, but a row that lists problems is not clean whatever
  // the flag says — the list is the evidence, the flag is the summary.
  const ok = problems.length ? false : r.ok !== false;
  const notes = [];
  for (const n of Array.isArray(r.notes) ? r.notes : []) {
    const note = str(n).trim();
    if (note) notes.push(note);
  }
  return {
    appId,
    artifactId: str(r.artifactId),
    ok,
    problems,
    // [audit] badges kinds whose payload lives on a headset: "ok" there means
    // "nothing on this disk to check", not "verified". Claiming otherwise would
    // be the one lie a verify button must never tell.
    deviceResident: !!r.deviceResident,
    notes,
  };
}

export function normalizeAudit(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const row = normalizeAuditRow(entry);
    if (!row) continue;
    const key = auditKey(row.appId, row.artifactId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  // Broken first: the whole point of the button is to surface what is wrong.
  return out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? 1 : -1));
}

export function auditKey(appId, artifactId) {
  return `${appId || ''}::${artifactId || ''}`;
}

export function brokenRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && !r.ok);
}

export function auditSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const broken = brokenRows(list).length;
  const problems = list.reduce((n, r) => n + ((r && r.problems && r.problems.length) || 0), 0);
  const skipped = list.filter((r) => r && r.ok && r.deviceResident).length;
  return { total: list.length, broken, clean: list.length - broken, problems, skipped };
}

/** The line under the button. Empty states invite the next action — DESIGN §9. */
export function auditSummaryText(rows) {
  const s = auditSummary(rows);
  if (!s.total) return 'Nothing installed by the hub to check.';
  if (!s.broken) {
    const on = s.total - s.skipped;
    return s.skipped
      ? `All ${on} install${on === 1 ? '' : 's'} on this machine check out — ${s.skipped} live${
          s.skipped === 1 ? 's' : ''
        } on a device and cannot be checked from here.`
      : `All ${s.total} install${s.total === 1 ? '' : 's'} check out.`;
  }
  return `${s.broken} of ${s.total} install${s.total === 1 ? '' : 's'} ${
    s.broken === 1 ? 'has' : 'have'
  } a problem — repair reinstalls from the release.`;
}

/** A row's own one-liner, so the list reads without expanding anything. */
export function rowSummaryText(row) {
  if (!row) return '';
  if (row.deviceResident && row.ok) return 'Installed on a device — not checked here';
  if (row.ok) return 'No problems found';
  const n = row.problems.length;
  return `${n} problem${n === 1 ? '' : 's'}`;
}
