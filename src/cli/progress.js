"use strict";
// Single-line job progress for the terminal.
//
// TTY   → one line, rewritten with \r: violet filled bar on a dim trough,
//         percentage in cyan, phase + message in muted lavender (DESIGN §10).
// plain → one line per phase change, no escapes, no carriage returns (so logs
//         and pipes stay readable).

const { createStyle } = require("./ansi");

const FILLED = "█"; // █
const TROUGH = "░"; // ░
const BAR_WIDTH = 22;

const PHASES = ["download", "verify", "extract", "install", "cleanup"];

function clampPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** The bar itself — violet filled, dim trough. */
function renderBar(pct, { style, width = BAR_WIDTH } = {}) {
  const st = style || createStyle(false);
  const filled = Math.round((clampPct(pct) / 100) * width);
  return st.violet(FILLED.repeat(filled)) + st.dim(TROUGH.repeat(Math.max(0, width - filled)));
}

/**
 * One progress line (no carriage return, no newline).
 * @param {{phase:string,pct:number,message:string}} evt
 */
function renderProgressLine(evt = {}, { style, columns = 0, width = BAR_WIDTH } = {}) {
  const st = style || createStyle(false);
  const pct = clampPct(evt.pct);
  const phase = String(evt.phase || "").toLowerCase();
  const parts = [
    renderBar(pct, { style: st, width }),
    st.value(`${String(pct).padStart(3)}%`),
    st.muted(phase.padEnd(8)),
    st.dim(String(evt.message || "")),
  ];
  const line = parts.join(" ");
  if (!columns || columns < 20) return line;
  return truncate(line, columns - 1, st);
}

/** Cut a styled line to `max` VISIBLE columns (escapes are kept intact). */
function truncate(line, max, st) {
  if (st.width(line) <= max) return line;
  let out = "";
  let seen = 0;
  const re = /(\u001b\[[0-9;]*m)|([\s\S])/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    if (seen >= max - 1) break;
    out += m[2];
    seen += 1;
  }
  return `${out}…${st.enabled ? "\u001b[0m" : ""}`;
}

/**
 * @param {object} o
 * @param {NodeJS.WriteStream} o.stream where the bar goes (stderr by default —
 *        so `nx install … > file` keeps a clean stdout)
 * @param {object} o.style
 * @param {boolean} [o.tty] force TTY behaviour (tests)
 */
function createProgress({ stream, style, tty } = {}) {
  const out = stream || process.stderr;
  const st = style || createStyle(false);
  const isTty = tty == null ? Boolean(out.isTTY) : Boolean(tty);
  let lastLen = 0;
  let lastPhase = null;
  let lastPlainPct = -1;
  let open = false;

  function write(s) {
    try {
      out.write(s);
    } catch (_) {
      /* a closed pipe must never break a job */
    }
  }

  function clear() {
    if (!isTty || !open) return;
    write(`\r${" ".repeat(lastLen)}\r`);
    lastLen = 0;
    open = false;
  }

  function update(evt = {}) {
    const pct = clampPct(evt.pct);
    if (isTty) {
      const line = renderProgressLine({ phase: evt.phase, pct, message: evt.message }, { style: st, columns: out.columns || 0 });
      const visible = st.width(line);
      const pad = visible < lastLen ? " ".repeat(lastLen - visible) : "";
      write(`\r${line}${pad}`);
      lastLen = visible;
      open = true;
      return;
    }
    // plain: a line whenever the phase changes, plus a coarse heartbeat so a
    // long download still shows life in a log.
    const phase = String(evt.phase || "");
    const step = Math.floor(pct / 25);
    if (phase === lastPhase && step === lastPlainPct) return;
    lastPhase = phase;
    lastPlainPct = step;
    write(`${phase || "working"} ${pct}% ${evt.message || ""}`.trimEnd() + "\n");
  }

  /** Finish the bar and leave a permanent line behind. */
  function finish(text, kind = "ok") {
    clear();
    if (!text) return;
    const mark = kind === "error" ? st.danger("!") : kind === "warn" ? st.amber("!") : st.cyan("✓");
    write(`${mark} ${text}\n`);
    lastPhase = null;
    lastPlainPct = -1;
  }

  /** An out-of-band line (toast) that must not be eaten by the bar. */
  function note(text, kind = "info") {
    if (!text) return;
    const wasOpen = open;
    clear();
    const paint = kind === "error" ? st.danger : kind === "warn" ? st.amber : st.muted;
    write(`${paint(text)}\n`);
    if (wasOpen) open = false;
  }

  return { update, finish, note, clear, isTty };
}

module.exports = { createProgress, renderBar, renderProgressLine, clampPct, BAR_WIDTH, PHASES, FILLED, TROUGH };
