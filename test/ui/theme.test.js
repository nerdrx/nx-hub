// v0.14 "NX Clear" — the theme choice, the root stamp and the live follow.
//
// lib/theme.js takes the root and the window as arguments, so everything here
// runs against two-line fakes: no DOM install, no booted controller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  THEMES,
  DEFAULT_THEME,
  DARK_QUERY,
  normalizeTheme,
  themeLabel,
  stampTheme,
  systemPrefersDark,
  resolveTheme,
  watchSystemTheme,
} from '../../src/renderer/lib/theme.js';
import { renderThemeControl, renderSettingsPanel } from '../../src/renderer/views/settings.js';

/** The two methods stampTheme() touches, plus a peek at the result. */
function fakeRoot(initial = {}) {
  const attrs = new Map(Object.entries(initial));
  return {
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    has: (k) => attrs.has(k),
    get: (k) => (attrs.has(k) ? attrs.get(k) : null),
  };
}

/** A window whose matchMedia answers one query and can fire `change`. */
function fakeWindow({ dark = false, api = 'modern' } = {}) {
  const state = { dark, listeners: new Set(), queries: [] };
  const mq = {
    get matches() {
      return state.dark;
    },
  };
  if (api === 'modern') {
    mq.addEventListener = (type, fn) => {
      if (type === 'change') state.listeners.add(fn);
    };
    mq.removeEventListener = (type, fn) => state.listeners.delete(fn);
  } else if (api === 'legacy') {
    mq.addListener = (fn) => state.listeners.add(fn);
    mq.removeListener = (fn) => state.listeners.delete(fn);
  }
  return {
    win: {
      matchMedia: (q) => {
        state.queries.push(q);
        return mq;
      },
    },
    state,
    flip(dark) {
      state.dark = !!dark;
      for (const fn of [...state.listeners]) fn({ matches: state.dark });
    },
  };
}

/* -------------------------------------------------------------- the choices */

test('there are exactly three themes and system is the default', () => {
  assert.deepEqual(THEMES, ['light', 'dark', 'system']);
  assert.equal(DEFAULT_THEME, 'system');
  assert.equal(DARK_QUERY, '(prefers-color-scheme: dark)');
});

test('anything that is not one of the three normalizes to system', () => {
  for (const t of THEMES) assert.equal(normalizeTheme(t), t);
  for (const junk of [undefined, null, '', 'oled', 'Light', 7, {}, ['dark']]) {
    assert.equal(normalizeTheme(junk), 'system', `${JSON.stringify(junk)} is not a theme`);
  }
  assert.equal(themeLabel('dark'), 'Dark');
  assert.equal(themeLabel('nonsense'), 'System');
});

/* ---------------------------------------------------------------- the stamp */

test('light and dark stamp the root; system stamps nothing at all', () => {
  const root = fakeRoot();

  assert.equal(stampTheme(root, 'light'), 'light');
  assert.equal(root.get('data-theme'), 'light');

  assert.equal(stampTheme(root, 'dark'), 'dark');
  assert.equal(root.get('data-theme'), 'dark');

  // The whole point: no attribute means prefers-color-scheme decides.
  assert.equal(stampTheme(root, 'system'), 'system');
  assert.equal(root.has('data-theme'), false, 'the stamp is REMOVED, not set to "system"');

  // A junk value leaves the root unstamped rather than writing junk into it.
  stampTheme(root, 'dark');
  stampTheme(root, 'space');
  assert.equal(root.has('data-theme'), false);
});

test('stampTheme survives a missing root', () => {
  assert.equal(stampTheme(null, 'dark'), 'dark');
  assert.equal(stampTheme({}, 'dark'), 'dark');
});

/* ------------------------------------------------------------ system, live */

test('systemPrefersDark reads the media query, and false is the safe answer', () => {
  const dark = fakeWindow({ dark: true });
  assert.equal(systemPrefersDark(dark.win), true);
  assert.deepEqual(dark.state.queries, [DARK_QUERY]);

  assert.equal(systemPrefersDark(fakeWindow({ dark: false }).win), false);
  assert.equal(systemPrefersDark({}), false, 'no matchMedia → light');
  assert.equal(systemPrefersDark(null), false);
  assert.equal(
    systemPrefersDark({
      matchMedia() {
        throw new Error('blocked');
      },
    }),
    false,
    'a throwing matchMedia must not take the renderer with it'
  );
});

test('resolveTheme folds system into whatever the desktop currently says', () => {
  assert.equal(resolveTheme('light', true), 'light', 'an explicit choice ignores the desktop');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme(undefined, false), 'light');
});

test('watchSystemTheme follows the query live instead of sampling once', () => {
  const w = fakeWindow({ dark: false });
  const seen = [];
  const stop = watchSystemTheme(w.win, (dark) => seen.push(dark));

  w.flip(true);
  w.flip(false);
  w.flip(true);
  assert.deepEqual(seen, [true, false, true], 'every change arrived');

  stop();
  w.flip(false);
  assert.deepEqual(seen, [true, false, true], 'and stopped when told to');
});

test('watchSystemTheme falls back to the legacy listener API', () => {
  const w = fakeWindow({ dark: false, api: 'legacy' });
  const seen = [];
  const stop = watchSystemTheme(w.win, (dark) => seen.push(dark));
  w.flip(true);
  assert.deepEqual(seen, [true]);
  stop();
  w.flip(false);
  assert.deepEqual(seen, [true]);
});

test('watchSystemTheme is a no-op when there is nothing to watch', () => {
  for (const win of [null, {}, { matchMedia: () => null }, fakeWindow({ api: 'none' }).win]) {
    const stop = watchSystemTheme(win, () => assert.fail('nothing should fire'));
    assert.equal(typeof stop, 'function');
    stop();
  }
  const w = fakeWindow();
  const stop = watchSystemTheme(w.win, 'not a function');
  assert.equal(typeof stop, 'function');
  stop();
});

/* ------------------------------------------------------------- the control */

test('the segmented control marks the current choice and offers the other two', () => {
  const out = renderThemeControl('dark', false);
  for (const t of THEMES) assert.ok(out.includes(`data-theme="${t}"`), `${t} is reachable`);
  assert.match(out, /data-act="set-theme"/);
  assert.match(out, /role="radiogroup"/);
  assert.match(out, /data-theme-choice="dark"/);
  assert.match(out, /data-theme-resolved="dark"/);
  // Exactly one segment is checked, and it is the one the sheet paints.
  assert.equal((out.match(/aria-checked="true"/g) || []).length, 1);
  assert.equal((out.match(/seg-btn is-on/g) || []).length, 1);
  assert.match(out, /class="seg"/, 'the trough the sheet styles');
  assert.match(out, /Always dark, whatever the desktop does/);
});

test('under system the control says which way the desktop resolved', () => {
  const light = renderThemeControl('system', false);
  assert.match(light, /data-theme-resolved="light"/);
  assert.match(light, /Following the desktop — light right now/);

  const dark = renderThemeControl('system', true);
  assert.match(dark, /data-theme-resolved="dark"/);
  assert.match(dark, /Following the desktop — dark right now/);

  // An unknown stored value renders as system rather than as nothing.
  assert.match(renderThemeControl('nebula', false), /data-theme-choice="system"/);
});

/* ------------------------------------------------- nothing left of the sky */

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the page ships no deep-space layers', () => {
  const html = read('../../src/renderer/index.html');
  for (const gone of ['id="nebula"', 'id="stars"', 'id="stars-near"', 'class="neb', 'star-layer', 'star-glow']) {
    assert.ok(!html.includes(gone), `index.html still carries ${gone}`);
  }
  assert.ok(!/<canvas/i.test(html), 'no canvas is drawn at all any more');
  // The parts that are not decoration are untouched.
  assert.ok(html.includes('id="header"') && html.includes('id="grid"') && html.includes('id="panel-root"'));
});

test('the renderer runs no starfield loop, no sheen writer, no parked-sky flag', () => {
  const src = read('../../src/renderer/app.js');
  for (const gone of ['starfield', 'sky-parked', 'skyFrame', "'--mx'", 'pointermove', 'visibilitychange']) {
    assert.ok(!src.includes(gone), `app.js still carries ${gone}`);
  }
  // One rAF call site survives on purpose: the single-shot render scheduler.
  assert.equal((src.match(/requestAnimationFrame\(/g) || []).length, 1, 'no animation loop is left');
  assert.ok(!src.includes('cancelAnimationFrame'), 'nothing to cancel, because nothing loops');
});

test('Settings carries the theme control in its own Appearance section', () => {
  const out = renderSettingsPanel({ owners: [], extraRepos: [] }, { theme: 'light', systemDark: true, caps: {} });
  assert.ok(out.includes('<h3>Appearance</h3>'), 'the section exists');
  assert.ok(out.includes('data-act="set-theme"'), 'with the control in it');
  assert.match(out, /data-theme-choice="light"/);
  // The theme is a renderer preference: it must not ride the settings draft,
  // which readPanelInputs() collects by data-field.
  assert.ok(!out.includes('data-field="theme"'), 'the theme is not a settings field');
  // A panel rendered without any theme ctx still renders, defaulted.
  assert.match(renderSettingsPanel({}, {}), /data-theme-choice="system"/);
});
