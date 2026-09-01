// NX Clear theming (SPEC v0.14, DESIGN §14 v1.7).
//
// Three choices — light, dark, system — stamped on the document root as
// `data-theme`. `system` stamps NOTHING: the absence of the attribute is what
// hands the decision to `prefers-color-scheme`, so the OS switching at 21:00
// is a CSS event, not a JS one.
//
// The renderer still wants to KNOW which way system resolved (the Settings
// control says so), and that answer must not be sampled once at boot — hence
// watchSystemTheme(), a live `change` listener on the same media query.
//
// Pure functions over an injected root/window so the tests can drive them
// without a DOM.

export const THEMES = ['light', 'dark', 'system'];
export const DEFAULT_THEME = 'system';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

const LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

/** Anything that is not one of the three choices is `system`. */
export function normalizeTheme(value) {
  return typeof value === 'string' && THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function themeLabel(theme) {
  return LABELS[normalizeTheme(theme)];
}

/**
 * Stamp the choice on the document root.
 * light/dark set `data-theme`; system REMOVES it so the media query decides.
 * @returns {string} the normalized theme that was applied
 */
export function stampTheme(root, theme) {
  const t = normalizeTheme(theme);
  if (!root || typeof root.setAttribute !== 'function') return t;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  return t;
}

/** Does the desktop ask for dark right now? False when matchMedia is missing. */
export function systemPrefersDark(win) {
  try {
    if (!win || typeof win.matchMedia !== 'function') return false;
    return !!win.matchMedia(DARK_QUERY).matches;
  } catch {
    return false; // matchMedia unavailable — light is the documented default
  }
}

/** Which ground is actually painted: system folds into light or dark. */
export function resolveTheme(theme, systemDark) {
  const t = normalizeTheme(theme);
  if (t !== 'system') return t;
  return systemDark ? 'dark' : 'light';
}

/**
 * Follow `prefers-color-scheme` for as long as the window lives.
 * @param {object} win
 * @param {(dark: boolean) => void} onChange called with the new value
 * @returns {() => void} stop listening
 */
export function watchSystemTheme(win, onChange) {
  const noop = () => {};
  if (typeof onChange !== 'function') return noop;
  try {
    if (!win || typeof win.matchMedia !== 'function') return noop;
    const mq = win.matchMedia(DARK_QUERY);
    if (!mq) return noop;
    const handler = (ev) => onChange(!!(ev && typeof ev.matches === 'boolean' ? ev.matches : mq.matches));
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => {
        try {
          mq.removeEventListener('change', handler);
        } catch {
          /* gone with the window */
        }
      };
    }
    // Safari < 14 / old Electron: the deprecated listener API is all there is.
    if (typeof mq.addListener === 'function') {
      mq.addListener(handler);
      return () => {
        try {
          mq.removeListener(handler);
        } catch {
          /* gone with the window */
        }
      };
    }
    return noop;
  } catch {
    return noop; // no matchMedia — the stamp still works, it just cannot follow
  }
}
