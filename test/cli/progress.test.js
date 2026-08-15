"use strict";
// src/cli/progress.js — the single-line bar (TTY) and its plain fallback.

const test = require("node:test");
const assert = require("node:assert");

const { createProgress, renderBar, renderProgressLine, clampPct, BAR_WIDTH } = require("../../src/cli/progress");
const { createStyle, strip, PALETTE } = require("../../src/cli/ansi");

const plain = createStyle(false);
const color = createStyle(true);

/** A writable stand-in for stdout/stderr. */
function fakeStream({ isTTY = false, columns = 0 } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
    chunks,
  };
}

test("cli/progress: the bar fills proportionally", () => {
  assert.equal(strip(renderBar(0, { style: plain })), "░".repeat(BAR_WIDTH));
  assert.equal(strip(renderBar(100, { style: plain })), "█".repeat(BAR_WIDTH));
  const half = strip(renderBar(50, { style: plain }));
  assert.equal(half.length, BAR_WIDTH);
  assert.equal(half.split("█").length - 1, Math.round(BAR_WIDTH / 2));
});

test("cli/progress: violet fill on a dim trough", () => {
  const bar = renderBar(50, { style: color });
  assert.ok(bar.includes(`\u001b[38;2;${PALETTE.violet.join(";")}m`), "filled part is violet");
  assert.ok(bar.includes("\u001b[2m"), "trough is dim");
});

test("cli/progress: a progress line carries percentage, phase and message", () => {
  const line = strip(renderProgressLine({ phase: "download", pct: 42, message: "12 MB / 30 MB" }, { style: plain }));
  assert.match(line, /42%/);
  assert.match(line, /download/);
  assert.match(line, /12 MB \/ 30 MB/);
  assert.ok(!line.includes("\n"), "one line, no newline");
});

test("cli/progress: lines are truncated to the terminal width", () => {
  const line = renderProgressLine(
    { phase: "download", pct: 10, message: "x".repeat(400) },
    { style: plain, columns: 60 }
  );
  assert.ok(strip(line).length <= 59, `got ${strip(line).length}`);
  assert.match(strip(line), /…$/);
});

test("cli/progress: percentages are clamped and rounded", () => {
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(140), 100);
  assert.equal(clampPct(33.6), 34);
  assert.equal(clampPct("nope"), 0);
});

test("cli/progress: TTY mode rewrites one line with \\r and never adds newlines", () => {
  const stream = fakeStream({ isTTY: true, columns: 100 });
  const p = createProgress({ stream, style: plain, tty: true });
  p.update({ phase: "download", pct: 10, message: "a" });
  p.update({ phase: "download", pct: 20, message: "b" });
  p.update({ phase: "install", pct: 90, message: "c" });
  assert.equal(stream.chunks.length, 3);
  for (const chunk of stream.chunks) {
    assert.ok(chunk.startsWith("\r"), "each update rewrites the same line");
    assert.ok(!chunk.includes("\n"), "no newline until the job finishes");
  }
  assert.match(stream.text, /10%/);
  assert.match(stream.text, /90%/);
});

test("cli/progress: TTY mode erases the leftovers of a longer previous line", () => {
  const stream = fakeStream({ isTTY: true, columns: 200 });
  const p = createProgress({ stream, style: plain, tty: true });
  p.update({ phase: "download", pct: 50, message: "a very long message indeed" });
  const longLen = strip(stream.chunks[0]).length;
  p.update({ phase: "install", pct: 60, message: "short" });
  assert.equal(strip(stream.chunks[1]).length, longLen, "padded back to the old width");
  p.finish("done");
  assert.match(stream.text, /\r {2,}\r/, "the bar is wiped before the final line");
  assert.match(stream.text, /done\n$/);
});

test("cli/progress: plain mode prints one line per phase, no carriage returns", () => {
  const stream = fakeStream({ isTTY: false });
  const p = createProgress({ stream, style: plain, tty: false });
  p.update({ phase: "download", pct: 0, message: "downloading x.zip" });
  p.update({ phase: "download", pct: 3, message: "1 MB / 30 MB" }); // same phase + bucket → quiet
  p.update({ phase: "download", pct: 99, message: "30 MB / 30 MB" });
  p.update({ phase: "extract", pct: 20, message: "extracting" });
  p.update({ phase: "install", pct: 75, message: "installing" });
  p.finish("Installed Demo 1.0.0");

  const lines = stream.text.trimEnd().split("\n");
  assert.deepEqual(lines, [
    "download 0% downloading x.zip",
    "download 99% 30 MB / 30 MB",
    "extract 20% extracting",
    "install 75% installing",
    "✓ Installed Demo 1.0.0",
  ]);
  assert.ok(!stream.text.includes("\r"), "nothing that would confuse a log file");
});

test("cli/progress: failures are marked, not silently finished", () => {
  const stream = fakeStream({ isTTY: false });
  const p = createProgress({ stream, style: plain, tty: false });
  p.finish("Checksum mismatch", "error");
  assert.match(stream.text, /^! Checksum mismatch\n$/);
});

test("cli/progress: notes survive next to an open bar", () => {
  const stream = fakeStream({ isTTY: true, columns: 80 });
  const p = createProgress({ stream, style: plain, tty: true });
  p.update({ phase: "install", pct: 50, message: "working" });
  p.note("Re-run: sudo setcap …", "info");
  assert.match(stream.text, /Re-run: sudo setcap …\n/);
  assert.ok(stream.text.indexOf("\r") < stream.text.indexOf("Re-run"), "the bar is cleared first");
});
