import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, sanitizeUrl, firstLine } from '../../src/renderer/lib/markdown.js';
import { esc, html, raw } from '../../src/renderer/lib/html.js';

/* ------------------------------------------------------------ XSS safety */

const ALLOWED_TAGS = new Set([
  'p', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'code', 'pre', 'a',
  'strong', 'em', 'del', 'blockquote', 'hr',
]);

/** Every tag the renderer emits must come from our own whitelist. */
function tagsOf(html) {
  return [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
}

test('raw HTML in release notes is escaped, never executed', () => {
  const out = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
  assert.ok(!out.includes('<script'), 'no script tag survives');
  assert.ok(!out.includes('<img'), 'no img tag survives');
  for (const tag of tagsOf(out)) assert.ok(ALLOWED_TAGS.has(tag), `unexpected tag <${tag}>`);
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(2)&gt;'), 'it survives as inert text');
});

test('a note built entirely of hostile markup emits only whitelisted tags', () => {
  const hostile = [
    '<iframe src=javascript:alert(1)></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<style>body{display:none}</style>',
    '<svg/onload=alert(1)>',
    '[link](javascript:alert(1))',
    '`<script>`',
  ].join('\n\n');
  const out = renderMarkdown(hostile);
  for (const tag of tagsOf(out)) assert.ok(ALLOWED_TAGS.has(tag), `unexpected tag <${tag}>`);
  assert.ok(!/href="javascript/i.test(out));
});

test('javascript: and data: links are not linkified', () => {
  const out = renderMarkdown('[click](javascript:alert(1)) and [x](data:text/html,<b>)');
  assert.ok(!out.includes('href="javascript'), out);
  assert.ok(!out.includes('href="data:'), out);
  assert.ok(out.includes('click'));
});

test('obfuscated javascript URLs are rejected', () => {
  assert.equal(sanitizeUrl('java\nscript:alert(1)'), '');
  assert.equal(sanitizeUrl('  JaVaScRiPt:alert(1)'), '');
  assert.equal(sanitizeUrl('vbscript:msgbox'), '');
  assert.equal(sanitizeUrl('file:///etc/passwd'), '');
  assert.equal(sanitizeUrl(''), '');
});

test('safe URLs pass through', () => {
  assert.equal(sanitizeUrl('https://github.com/nerdrx/nx-hub'), 'https://github.com/nerdrx/nx-hub');
  assert.equal(sanitizeUrl('http://127.0.0.1:9020/dom'), 'http://127.0.0.1:9020/dom');
  assert.equal(sanitizeUrl('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(sanitizeUrl('github.com/x/y'), 'https://github.com/x/y');
});

test('a quote inside a link label cannot break out of the href attribute', () => {
  const out = renderMarkdown('[t](https://x.dev/"onmouseover="alert(1))');
  assert.ok(!/href="[^"]*"\s*onmouseover/.test(out), out);
});

/* ---------------------------------------------------------------- markup */

test('headings are demoted into the card hierarchy', () => {
  assert.equal(renderMarkdown('# Title'), '<h3>Title</h3>');
  assert.equal(renderMarkdown('### Deep'), '<h5>Deep</h5>');
  assert.equal(renderMarkdown('###### Deepest'), '<h6>Deepest</h6>');
});

test('lists, both flavours', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('* a\n\nplain'), '<ul><li>a</li></ul><p>plain</p>');
});

test('inline code keeps surrounding spacing', () => {
  assert.equal(renderMarkdown('run `foo bar` now'), '<p>run <code>foo bar</code> now</p>');
});

test('fenced code blocks are preserved verbatim (escaped)', () => {
  const out = renderMarkdown('```\nsudo setcap cap_sys_nice+ep <bin>\n```');
  assert.equal(out, '<pre><code>sudo setcap cap_sys_nice+ep &lt;bin&gt;</code></pre>');
});

test('emphasis, links, quotes and rules', () => {
  assert.equal(renderMarkdown('**bold** and *it*'), '<p><strong>bold</strong> and <em>it</em></p>');
  assert.ok(renderMarkdown('[a](https://x.dev)').includes('<a href="https://x.dev"'));
  assert.equal(renderMarkdown('> note'), '<blockquote>note</blockquote>');
  assert.equal(renderMarkdown('---'), '<hr>');
});

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('firstLine gives a plain-text preview', () => {
  assert.equal(firstLine('## WiVRn NX 1.9.2\n\nbody'), 'WiVRn NX 1.9.2');
  assert.equal(firstLine('- **fix** the [thing](https://x.dev)'), 'fix the thing');
  assert.equal(firstLine('x'.repeat(200), 20).length, 20);
  assert.equal(firstLine(''), '');
});

/* ------------------------------------------------------------- html.js */

test('esc covers every dangerous character', () => {
  assert.equal(esc(`<a href="x" foo='y'>&</a>`), '&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('html template escapes interpolations unless raw()', () => {
  assert.equal(html`<p>${'<b>'}</p>`, '<p>&lt;b&gt;</p>');
  assert.equal(html`<p>${raw('<b>ok</b>')}</p>`, '<p><b>ok</b></p>');
  assert.equal(html`<p>${['<', 'x']}</p>`, '<p>&lt;x</p>');
  assert.equal(html`<p>${null}${false}${undefined}</p>`, '<p></p>');
});
