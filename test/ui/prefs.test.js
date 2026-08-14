import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_POLICIES,
  DEFAULT_APP_PREF,
  effectivePolicy,
  envFromRows,
  envRows,
  globalPolicy,
  isHiddenApp,
  isSkipped,
  joinArgs,
  normalizeAppPref,
  normalizeAppPrefs,
  normalizeEnv,
  parseEnvLine,
  policyLabel,
  policyShortLabel,
  prefFor,
  splitArgs,
  validateEnvKey,
} from '../../src/renderer/lib/prefs.js';

/* -------------------------------------------------------------- normalizing */

test('normalizeAppPref fills every field and rejects junk', () => {
  assert.deepEqual(normalizeAppPref(null), DEFAULT_APP_PREF);
  assert.deepEqual(normalizeAppPref('nope'), DEFAULT_APP_PREF);

  const p = normalizeAppPref({
    updatePolicy: 'sideways',
    includePrereleases: 1,
    skippedVersion: '  1.2.3 ',
    favorite: 'yes',
    hidden: 0,
    launchArgs: ['--a', '', 7, null],
    launchEnv: { OK: 'x', 'BAD KEY': 'y', '': 'z', NUM: 5 },
  });
  assert.equal(p.updatePolicy, 'inherit', 'unknown policies fall back to inherit');
  assert.equal(p.includePrereleases, true);
  assert.equal(p.skippedVersion, '1.2.3');
  assert.equal(p.favorite, true);
  assert.equal(p.hidden, false);
  assert.deepEqual(p.launchArgs, ['--a', '7']);
  assert.deepEqual(p.launchEnv, { OK: 'x', NUM: '5' });
});

test('normalizeAppPrefs tolerates arrays, null and empty keys', () => {
  assert.deepEqual(normalizeAppPrefs(null), {});
  assert.deepEqual(normalizeAppPrefs([1, 2]), {});
  const out = normalizeAppPrefs({ '': { favorite: true }, a: { favorite: true } });
  assert.deepEqual(Object.keys(out), ['a']);
  assert.equal(out.a.favorite, true);
});

test('prefFor never returns null, even for unknown apps', () => {
  const settings = { appPrefs: { a: { favorite: true } } };
  assert.equal(prefFor(settings, 'a').favorite, true);
  assert.equal(prefFor(settings, 'nope').favorite, false);
  assert.equal(prefFor(null, 'x').updatePolicy, 'inherit');
});

/* ------------------------------------------------------------------ policy */

test('policy resolution: inherit defers to the global setting', () => {
  assert.equal(globalPolicy({}), 'notify');
  assert.equal(globalPolicy({ updatePolicy: 'sideways' }), 'notify');
  assert.equal(globalPolicy({ updatePolicy: 'install' }), 'install');

  const settings = { updatePolicy: 'download' };
  assert.equal(effectivePolicy({ updatePolicy: 'inherit' }, settings), 'download');
  assert.equal(effectivePolicy({ updatePolicy: 'install' }, settings), 'install');
  assert.equal(effectivePolicy(null, settings), 'download');
  assert.equal(effectivePolicy({ updatePolicy: 'nonsense' }, {}), 'notify');
});

test('policy labels are English and name what inherit resolves to', () => {
  assert.equal(policyLabel('notify', {}), 'Notify me');
  assert.equal(policyLabel('download', {}), 'Download in the background');
  assert.equal(policyLabel('install', {}), 'Install automatically');
  assert.equal(policyLabel('inherit', { updatePolicy: 'install' }), 'Use the global setting (Install automatically)');
  assert.equal(policyLabel('inherit', {}), 'Use the global setting (Notify me)');
  // unknown input never renders undefined
  assert.equal(policyLabel('???', {}), 'Notify me');
  assert.equal(policyShortLabel('inherit'), 'Inherited');
  assert.deepEqual(APP_POLICIES, ['inherit', 'notify', 'download', 'install']);
});

/* ------------------------------------------------------------ hidden / skip */

test('hidden covers both the per-app pref and main’s localHidden mirror', () => {
  const prefs = { a: { hidden: true }, b: { hidden: false } };
  assert.equal(isHiddenApp({ id: 'a' }, prefs), true);
  assert.equal(isHiddenApp({ id: 'b' }, prefs), false);
  assert.equal(isHiddenApp({ id: 'c' }, prefs), false);
  assert.equal(isHiddenApp({ id: 'c', localHidden: true }, prefs), true);
  assert.equal(isHiddenApp(null, prefs), false);
  assert.equal(isHiddenApp({ id: 'a' }, null), false);
});

test('skipping matches one exact version only', () => {
  const pref = normalizeAppPref({ skippedVersion: '1.9.2' });
  assert.equal(isSkipped(pref, '1.9.2'), true);
  assert.equal(isSkipped(pref, '1.9.3'), false);
  assert.equal(isSkipped(pref, ''), false);
  assert.equal(isSkipped(normalizeAppPref({}), '1.9.2'), false);
});

/* ------------------------------------------------------------- launch args */

test('splitArgs handles quotes, escapes and runs of whitespace', () => {
  assert.deepEqual(splitArgs('--no-gpu --profile "living room"').args, ['--no-gpu', '--profile', 'living room']);
  assert.deepEqual(splitArgs("  -a   -b  ").args, ['-a', '-b']);
  assert.deepEqual(splitArgs("--path=/home/x/my\\ games").args, ['--path=/home/x/my games']);
  assert.deepEqual(splitArgs(`--msg 'it is "fine"'`).args, ['--msg', 'it is "fine"']);
  assert.deepEqual(splitArgs('--json "{\\"a\\":1}"').args, ['--json', '{"a":1}']);
  assert.deepEqual(splitArgs('').args, []);
  assert.deepEqual(splitArgs(null).args, []);
  assert.deepEqual(splitArgs('""').args, [''], 'an explicit empty argument survives');
});

test('splitArgs reports an unbalanced quote instead of throwing', () => {
  const r = splitArgs('--profile "living room');
  assert.match(r.error, /Unbalanced quote/);
  assert.deepEqual(r.args, ['--profile', 'living room']);
  assert.equal(splitArgs('--ok').error, '');
});

test('joinArgs round-trips through splitArgs', () => {
  for (const args of [
    ['--no-gpu'],
    ['--profile', 'living room'],
    ['--path', '/home/x/my games'],
    ['--msg', `it's fine`],
    [''],
    [],
  ]) {
    assert.deepEqual(splitArgs(joinArgs(args)).args, args, JSON.stringify(args));
  }
  assert.equal(joinArgs(null), '');
});

/* --------------------------------------------------------------- launch env */

test('env keys are validated the way a shell would want them', () => {
  assert.equal(validateEnvKey('WIVRN_BITRATE'), '');
  assert.equal(validateEnvKey('_x9'), '');
  assert.match(validateEnvKey(''), /empty/);
  assert.match(validateEnvKey('has space'), /spaces/);
  assert.match(validateEnvKey('A=B'), /spaces|“=”/);
  assert.match(validateEnvKey('9LIVES'), /letters/);
});

test('env rows round-trip and drop invalid names', () => {
  const env = normalizeEnv({ A: '1', B: 2, 'bad key': 'x' });
  assert.deepEqual(env, { A: '1', B: '2' });
  const rows = envRows(env);
  assert.deepEqual(rows, [{ key: 'A', value: '1' }, { key: 'B', value: '2' }]);
  assert.deepEqual(envFromRows(rows), env);
  assert.deepEqual(envFromRows([{ key: '', value: 'x' }, { key: 'C', value: '' }]), { C: '' });
  assert.deepEqual(envFromRows(null), {});
  assert.deepEqual(normalizeEnv(['A=1']), {});
});

test('parseEnvLine splits on the first equals sign only', () => {
  assert.deepEqual(parseEnvLine('KEY=a=b'), { key: 'KEY', value: 'a=b' });
  assert.deepEqual(parseEnvLine(' KEY = v'), { key: 'KEY', value: ' v' });
  assert.deepEqual(parseEnvLine('KEY'), { key: 'KEY', value: '' });
});
