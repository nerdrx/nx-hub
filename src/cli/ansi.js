"use strict";
// NX terminal styling — 24-bit ANSI, hand-rolled (zero dependencies).
//
// The NX design language (docs/DESIGN.md §1 + §10) mapped onto a terminal:
//   violet  #7700FF  headers, primary accents, the filled part of a bar
//   cyan    #00e5ff  live values (versions, percentages, device state)
//   amber   #ffb300  "update available" / attention, never plain warnings
//   muted   #9a8fc0  secondary text, table headers, troughs
//   text    #efeaff  body
//   danger  #ff5470  failures only
//
// Everything degrades to plain ASCII-with-no-escapes when the stream is not a
// TTY, when NO_COLOR is set, or when --plain / --no-color is passed.

const PALETTE = {
  violet: [119, 0, 255],
  cyan: [0, 229, 255],
  amber: [255, 179, 0],
  muted: [154, 143, 192],
  text: [239, 234, 255],
  danger: [255, 84, 112],
};

const RESET = "\u001b[0m";
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function fg([r, g, b]) {
  return `\u001b[38;2;${r};${g};${b}m`;
}

/**
 * Should this stream get colour?
 * NO_COLOR (any value) and TERM=dumb win over everything, per convention.
 */
function supportsColor(stream, env = process.env) {
  if (!stream || !stream.isTTY) return false;
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  if (env.NX_HUB_FORCE_PLAIN === "1") return false;
  return true;
}

/** Visible width of a string (ANSI escapes do not count). */
function width(s) {
  return strip(s).length;
}

function strip(s) {
  return String(s == null ? "" : s).replace(ANSI_RE, "");
}

/** "Apps" → "A P P S" — the uppercase wide-tracked section label. */
function track(s) {
  return String(s || "")
    .toUpperCase()
    .split("")
    .join(" ");
}

function padEnd(s, n) {
  const pad = n - width(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function padStart(s, n) {
  const pad = n - width(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/**
 * @param {boolean} enabled colour on/off
 * @returns {object} style helpers — every one is (string) => string
 */
function createStyle(enabled) {
  const on = Boolean(enabled);
  const wrap = (open) => (s) => (on ? `${open}${s == null ? "" : s}${RESET}` : String(s == null ? "" : s));

  const style = {
    enabled: on,
    violet: wrap(fg(PALETTE.violet)),
    cyan: wrap(fg(PALETTE.cyan)),
    amber: wrap(fg(PALETTE.amber)),
    muted: wrap(fg(PALETTE.muted)),
    text: wrap(fg(PALETTE.text)),
    danger: wrap(fg(PALETTE.danger)),
    bold: wrap("\u001b[1m"),
    dim: wrap("\u001b[2m"),
    plain: (s) => String(s == null ? "" : s),
    width,
    strip,
    padEnd,
    padStart,
    track,
  };

  /** Section label: violet, bold, uppercase, wide-tracked. */
  style.section = (s) => style.bold(style.violet(track(s)));
  /** Column header inside a table: muted + uppercase (not tracked — keeps columns tight). */
  style.head = (s) => style.muted(String(s || "").toUpperCase());
  /** Key of a key/value line. */
  style.key = (s) => style.muted(s);
  /** A live value (version, count, percentage). */
  style.value = (s) => style.cyan(s);

  return style;
}

/** Convenience: the style a given stream deserves. */
function styleFor(stream, env = process.env, force) {
  if (force === true) return createStyle(true);
  if (force === false) return createStyle(false);
  return createStyle(supportsColor(stream, env));
}

module.exports = {
  PALETTE,
  RESET,
  createStyle,
  styleFor,
  supportsColor,
  strip,
  width,
  track,
  padEnd,
  padStart,
};
