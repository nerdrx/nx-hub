// Version + formatting helpers. Locale-independent on purpose: the host may run
// under any locale (de_DE etc.) and the UI language is English per SPEC.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Strip release-tag noise: "v1.2.3", "nx-1.2.3", "release-1.2.3" → "1.2.3". */
export function stripTag(tag) {
  if (!tag) return '';
  return String(tag)
    .trim()
    .replace(/^(?:release[-_/]?|nx[-_]|[vV])+/, '')
    .trim();
}

function parseVersion(v) {
  const s = stripTag(v);
  const m = /^([0-9]+(?:\.[0-9]+)*)(?:[-+](.*))?$/.exec(s);
  if (!m) return { nums: [], pre: s.toLowerCase(), raw: s };
  return {
    nums: m[1].split('.').map((n) => parseInt(n, 10) || 0),
    pre: (m[2] || '').toLowerCase(),
    raw: s,
  };
}

/** semver-ish compare. -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa.nums.length && !pb.nums.length) {
    return pa.raw === pb.raw ? 0 : pa.raw < pb.raw ? -1 : 1;
  }
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // No prerelease sorts above a prerelease (1.0.0 > 1.0.0-rc1).
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** True when `latest` is strictly newer than `installed`. */
export function isNewer(latest, installed) {
  if (!latest) return false;
  if (!installed) return true;
  return compareVersions(latest, installed) > 0;
}

/**
 * updateAvailable per SPEC is computed in main, but the UI must not explode when
 * the flag is missing — fall back to a version comparison.
 */
export function artifactHasUpdate(artifact, latestVersion) {
  if (!artifact || !artifact.installed) return false;
  if (typeof artifact.updateAvailable === 'boolean') return artifact.updateAvailable;
  return isNewer(latestVersion, artifact.installed.version);
}

/** "2026-08-14T10:00:00Z" → "14 Aug 2026" (never locale-dependent). */
export function formatDate(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Coarse relative time: "today", "3 days ago", "2 months ago". */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** 12345678 → "11.8 MB". */
export function formatBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Pull a transfer rate out of a job message, if it mentions one. */
export function extractSpeed(message) {
  if (!message) return '';
  const m = /(\d+(?:[.,]\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB)\s*\/\s*s/i.exec(String(message));
  if (!m) return '';
  return `${m[1].replace(',', '.')} ${m[2]}/s`;
}

/**
 * v0.6 delta updates: jobs reconstruct an AppImage from a `.zpatch` instead of
 * downloading the whole asset.
 *
 * The bare word "delta" is NOT the trigger — app and asset names contain it
 * ([resilience] hit exactly that). The engine's own phrases are: "downloading
 * delta patch …", "delta patch — a / b", "applying delta patch …", "verifying
 * the delta result", "delta applied — …".
 */
export function hasDelta(message) {
  return /delta patch|delta applied|delta result/i.test(
    String(message === null || message === undefined ? '' : message)
  );
}

/** The closing line of a delta job: "delta applied — 18 MB instead of 96 MB". */
export function isDeltaApplied(message) {
  return /delta applied/i.test(String(message === null || message === undefined ? '' : message));
}

/**
 * v0.7 LAN asset seeding. SPEC promises the download path says
 * "from <peer name>" when the bytes came off another hub; the marker the UI
 * matches on is the parenthesised "(LAN)" that tags exactly those messages.
 *
 * The bare word LAN is NOT the trigger and must never become one — a message
 * naming the app being installed ("Downloading LAN party 2.0") would light the
 * chip on a GitHub download. The parentheses are the whole contract.
 */
export function isLanSeeded(message) {
  return /\(LAN\)/.test(String(message === null || message === undefined ? '' : message));
}

/** The hub that served it: "from workshop-pc (LAN)" → "workshop-pc". */
export function lanSeedPeer(message) {
  const m = /from\s+(.+?)\s*\(LAN\)/i.exec(String(message === null || message === undefined ? '' : message));
  return m ? m[1].trim() : '';
}

const PHASES = {
  download: 'Downloading',
  verify: 'Verifying',
  extract: 'Extracting',
  install: 'Installing',
  cleanup: 'Finishing up',
};

export function phaseLabel(phase) {
  return PHASES[phase] || (phase ? String(phase) : 'Working');
}

/** "download", 43, "12.3 MB/s at ..." → "Downloading 43% — 12.3 MB/s" */
export function progressLabel(phase, pct, message) {
  const parts = [phaseLabel(phase)];
  const p = Number(pct);
  if (Number.isFinite(p) && p >= 0) parts.push(`${Math.max(0, Math.min(100, Math.round(p)))}%`);
  const speed = extractSpeed(message);
  const label = parts.join(' ');
  return speed ? `${label} — ${speed}` : label;
}

/** Text for the installed → latest column of an artifact row. */
export function versionLabel(artifact, latestVersion) {
  const latest = latestVersion || '';
  if (!artifact || !artifact.installed) {
    return latest ? `not installed · ${latest} available` : 'not installed';
  }
  const cur = artifact.installed.version || 'unknown';
  if (artifactHasUpdate(artifact, latest)) return `${cur} → ${latest}`;
  return `${cur} · up to date`;
}
