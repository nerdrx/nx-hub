// Minimal, hand-rolled markdown renderer for GitHub release notes.
//
// Security model: the input is escaped FIRST, then our own markup is added on
// top. No raw HTML from the source ever survives, so a release note cannot
// inject script/img/onerror into the renderer. Supported: headings, ul/ol,
// blockquotes, fenced + inline code, links, bold/italic/strike, hr, paragraphs.

import { esc } from './html.js';

const SAFE_SCHEME = /^(https?:|mailto:)/i;
// Control characters + space, built without literal escapes in the source.
const CTRL = new RegExp('[\\u0000-\\u0020]', 'g');

/** Return a safe href, or '' when the URL must not be linkified. */
export function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  // Strip control chars/whitespace before scheme sniffing ("java\nscript:").
  const probe = trimmed.replace(CTRL, '').toLowerCase();
  if (!probe) return '';
  if (probe.startsWith('#') || probe.startsWith('/')) return trimmed;
  if (probe.includes(':')) return SAFE_SCHEME.test(probe) ? trimmed : '';
  // Scheme-less ("github.com/x") — treat as https.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(probe)) return `https://${trimmed}`;
  return '';
}

const CODE_OPEN = '@@nxcode';
const CODE_CLOSE = '@@';

function inline(escapedText) {
  let s = escapedText;

  // Inline code first so its contents are not touched by later rules.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, body) => {
    codes.push(body);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });

  // Links: [label](url "title")
  s = s.replace(/\[([^\]]*)\]\(([^()\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, url) => {
    const href = sanitizeUrl(url);
    if (!href) return label || m;
    return `<a href="${esc(href)}" data-ext="1" rel="noreferrer noopener">${label}</a>`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  s = s.replace(/@@nxcode(\d+)@@/g, (_m, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return s;
}

/**
 * Render markdown to a safe HTML string.
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const lines = esc(String(src).replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  let quote = [];
  let fence = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closePara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      quote = [];
    }
  };
  const closeAll = () => {
    closePara();
    closeQuote();
    closeList();
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence === null) {
        closeAll();
        fence = [];
      } else {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }

    if (!line.trim()) {
      closeAll();
      continue;
    }

    let m;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))) {
      closeAll();
      // Notes render inside a card, so demote headings to h3..h6.
      const level = Math.min(6, m[1].length + 2);
      out.push(`<h${level}>${inline(m[2].trim())}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeAll();
      out.push('<hr>');
      continue;
    }
    if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) {
      closePara();
      closeList();
      quote.push(m[1]);
      continue;
    }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      closePara();
      closeQuote();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      closePara();
      closeQuote();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }

    closeQuote();
    if (list) {
      // Continuation line of the previous bullet.
      const last = out.pop();
      out.push(last.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`));
      continue;
    }
    para.push(line.trim());
  }

  if (fence !== null && fence.length) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  closeAll();
  return out.join('');
}

/** First non-empty markdown line, as plain text, for collapsed previews. */
export function firstLine(src, max = 120) {
  if (!src) return '';
  const line = String(src)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^[`~]{3}/.test(l));
  if (!line) return '';
  const plain = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
