// Per-app preferences (SPEC v0.2 `settings.appPrefs`). Pure helpers: the shape
// normalizers, the policy resolution (per-app "inherit" → global) and the
// shell-ish parsing for launch args / launch env.
//
// Nothing here touches the DOM or window.nxhub, so every rule is unit-testable.

// v0.8 sandbox profiles live in guardian.js (they are shared with the app model
// and the overlay); prefs only needs the value tuple to sanitise the pref.
import { SANDBOX_VALUES as SANDBOX_PREF_VALUES } from './guardian.js';

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
  // Older releases may fill kind+platform gaps the newest release left empty.
  // Default on; off = only files from the newest release are offered.
  releaseFallback: true,
  launchArgs: [],
  launchEnv: {},
  // v0.8 — the watchdog is opt-in per app.
  keepAlive: false,
  // v0.8 — null (not '') is the "no per-app choice" write the bridge clears on.
  sandbox: null,
};

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** One app's prefs, filled in and sanitised. Never returns null. */
export function normalizeAppPref(pref) {
  const p = pref && typeof pref === 'object' ? pref : {};
  const policy = APP_POLICIES.includes(p.updatePolicy) ? p.updatePolicy : 'inherit';
  const out = {
    updatePolicy: policy,
    includePrereleases: !!p.includePrereleases,
    skippedVersion: str(p.skippedVersion).trim(),
    favorite: !!p.favorite,
    hidden: !!p.hidden,
    // Defaults to true — only an explicit false turns the fallback off.
    releaseFallback: p.releaseFallback !== false,
    launchArgs: Array.isArray(p.launchArgs) ? p.launchArgs.map(str).filter((a) => a !== '') : [],
    launchEnv: normalizeEnv(p.launchEnv),
    // v0.8 — watchdog + sandbox override. `sandbox` stays null unless it holds
    // one of the three real profiles, so a junk value clears rather than sticks.
    keepAlive: !!p.keepAlive,
    sandbox: SANDBOX_PREF_VALUES.includes(p.sandbox) ? p.sandbox : null,
  };
  // v0.6 auto-run: boolean or ABSENT — absent means "inherit the global
  // setting", and null/undefined/junk all read as absent.
  if (typeof p.autoRunCmd === 'boolean') out.autoRunCmd = p.autoRunCmd;
  return out;
}

/* --------------------------------------------- v0.6: auto-run post-install */

/** Tri-state, mirroring updatePolicy's inherit pattern. */
export const AUTO_RUN_CHOICES = ['inherit', 'on', 'off'];

/** Pref → the value the editor's select holds. */
export function autoRunChoice(pref) {
  if (!pref || typeof pref.autoRunCmd !== 'boolean') return 'inherit';
  return pref.autoRunCmd ? 'on' : 'off';
}

/**
 * Select value → what setAppPref should store. `null` (not undefined) is the
 * "inherit" write: it survives IPC as an explicit "no per-app choice", and
 * every normalizer here and in main reads a non-boolean as absent.
 */
export function autoRunFromChoice(choice) {
  if (choice === 'on') return true;
  if (choice === 'off') return false;
  return null;
}

/** Global default for auto-running post-install commands (SPEC default: off). */
export function globalAutoRun(settings) {
  return !!(settings && settings.autoRunPostInstallCmd);
}

/** Resolve the tri-state against the global setting. */
export function effectiveAutoRun(pref, settings) {
  if (pref && typeof pref.autoRunCmd === 'boolean') return pref.autoRunCmd;
  return globalAutoRun(settings);
}

/** Human label for one choice — "inherit" spells out what it resolves to. */
export function autoRunLabel(choice, settings) {
  if (choice === 'on') return 'Always run it';
  if (choice === 'off') return 'Never run it';
  return `Use the global setting (${globalAutoRun(settings) ? 'on' : 'off'})`;
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
