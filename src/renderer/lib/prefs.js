// Per-app preferences (SPEC v0.2 `settings.appPrefs`). Pure helpers: the shape
// normalizers, the policy resolution (per-app "inherit" → global) and the
// shell-ish parsing for launch args / launch env.
//
// Nothing here touches the DOM or window.nxhub, so every rule is unit-testable.

/** Policies the global setting accepts. */
export const GLOBAL_POLICIES = ['notify', 'download', 'install'];
/** Policies a single app accepts — "inherit" defers to the global setting. */
export const APP_POLICIES = ['inherit', ...GLOBAL_POLICIES];

const POLICY_TEXT = {
  notify: 'Notify me',
  download: 'Download in the background',
  install: 'Install automatically',
};

export const DEFAULT_APP_PREF = {
  updatePolicy: 'inherit',
  includePrereleases: false,
  skippedVersion: '',
  favorite: false,
  hidden: false,
  launchArgs: [],
  launchEnv: {},
};

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** One app's prefs, filled in and sanitised. Never returns null. */
export function normalizeAppPref(pref) {
  const p = pref && typeof pref === 'object' ? pref : {};
  const policy = APP_POLICIES.includes(p.updatePolicy) ? p.updatePolicy : 'inherit';
  return {
    updatePolicy: policy,
    includePrereleases: !!p.includePrereleases,
    skippedVersion: str(p.skippedVersion).trim(),
    favorite: !!p.favorite,
    hidden: !!p.hidden,
    launchArgs: Array.isArray(p.launchArgs) ? p.launchArgs.map(str).filter((a) => a !== '') : [],
    launchEnv: normalizeEnv(p.launchEnv),
  };
}

/** The whole appPrefs map, normalized. Tolerates junk and missing entries. */
export function normalizeAppPrefs(prefs) {
  const out = {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return out;
  for (const [appId, pref] of Object.entries(prefs)) {
    if (!appId) continue;
    out[appId] = normalizeAppPref(pref);
  }
  return out;
}

/** Prefs for one app — always a complete object, even for unknown apps. */
export function prefFor(settings, appId) {
  const map = (settings && settings.appPrefs) || {};
  return normalizeAppPref(map[appId]);
}

/** Global default policy, sanitised. */
export function globalPolicy(settings) {
  const p = settings && settings.updatePolicy;
  return GLOBAL_POLICIES.includes(p) ? p : 'notify';
}

/** Resolve "inherit" against the global setting. */
export function effectivePolicy(pref, settings) {
  const p = pref && pref.updatePolicy;
  if (GLOBAL_POLICIES.includes(p)) return p;
  return globalPolicy(settings);
}

/**
 * Human label for a policy. "inherit" spells out what it resolves to so the
 * options sheet never makes the user guess.
 */
export function policyLabel(policy, settings) {
  if (policy === 'inherit') {
    return `Use the global setting (${POLICY_TEXT[globalPolicy(settings)]})`;
  }
  return POLICY_TEXT[policy] || POLICY_TEXT.notify;
}

/** Short form for chips/summaries: "notify" → "Notify me". */
export function policyShortLabel(policy) {
  return POLICY_TEXT[policy] || (policy === 'inherit' ? 'Inherited' : POLICY_TEXT.notify);
}

/** True when this app should not appear anywhere in the UI. */
export function isHiddenApp(app, prefs) {
  if (!app) return false;
  if (app.localHidden) return true;
  const map = prefs || {};
  const pref = map[app.id];
  return !!(pref && pref.hidden);
}

/** True when the user asked to skip exactly this version of this app. */
export function isSkipped(pref, version) {
  const v = str(version).trim();
  return !!(v && pref && pref.skippedVersion && pref.skippedVersion === v);
}

/* -------------------------------------------------------------- launch args */

/**
 * POSIX-ish word split for the launch-args input: honours single quotes, double
 * quotes and backslash escapes. Returns the parsed words plus a soft error for
 * the preview (never throws — the user is mid-typing).
 */
export function splitArgs(input) {
  const s = str(input);
  const args = [];
  let cur = '';
  let started = false;
  let quote = '';
  let error = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else cur += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === '"') {
        quote = '';
      } else {
        cur += ch;
      }
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }

  if (quote) error = 'Unbalanced quote — everything after it counts as one argument.';
  if (started) args.push(cur);
  return { args, error };
}

/** Turn a parsed arg list back into an editable one-liner. */
export function joinArgs(args) {
  if (!Array.isArray(args)) return '';
  return args
    .map((a) => {
      const v = str(a);
      if (v === '') return "''";
      if (/[\s"'\\$`]/.test(v)) return `'${v.replace(/'/g, `'\\''`)}'`;
      return v;
    })
    .join(' ');
}

/* --------------------------------------------------------------- launch env */

export function validateEnvKey(key) {
  const k = str(key).trim();
  if (!k) return 'Name cannot be empty.';
  if (/[=\s]/.test(k)) return 'Names cannot contain spaces or “=”.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return 'Use letters, digits and underscore only.';
  return '';
}

/** {K:'v'} in, {K:'v'} out — non-string values stringified, bad keys dropped. */
export function normalizeEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [k, v] of Object.entries(env)) {
    const key = str(k).trim();
    if (!key || validateEnvKey(key)) continue;
    out[key] = str(v);
  }
  return out;
}

/** Editable rows for the options sheet (stable order: insertion, then name). */
export function envRows(env) {
  return Object.entries(normalizeEnv(env)).map(([key, value]) => ({ key, value }));
}

/** Rows back to an object; blank names are dropped, later rows win. */
export function envFromRows(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = str(row && row.key).trim();
    if (!key || validateEnvKey(key)) continue;
    out[key] = str(row && row.value);
  }
  return out;
}

/** "KEY=value" → {key, value}; used by paste-friendly single-field entry. */
export function parseEnvLine(line) {
  const s = str(line);
  const i = s.indexOf('=');
  if (i < 0) return { key: s.trim(), value: '' };
  return { key: s.slice(0, i).trim(), value: s.slice(i + 1) };
}
