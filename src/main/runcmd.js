"use strict";
// Post-install command runner. Pure node, no electron.
//
// SECURITY MODEL: the renderer never sends a command string — only app and
// artifact ids. The command executed is exactly the artifact's own
// `postInstallCmd` from the discovery model (overlay-curated), resolved on
// this side of the IPC boundary. This module just executes and reports.

const { spawn } = require("child_process");

/**
 * GUI apps have no terminal for a sudo password prompt. Commands that ask for
 * root are rewritten to pkexec, which raises the desktop's polkit auth dialog.
 */
function rewriteForPrivilege(cmd) {
  const trimmed = String(cmd || "").trim();
  if (!trimmed) return null;
  if (/^sudo\s+/.test(trimmed)) {
    const bare = trimmed.replace(/^sudo\s+(-\S+\s+)*/, "");
    return { cmd: `pkexec sh -c ${shellQuote(bare)}`, privileged: true };
  }
  return { cmd: trimmed, privileged: false };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run through the user's shell, capture combined output, never throw.
 * @returns {Promise<{ok:boolean, code:number|null, output:string, timedOut:boolean}>}
 */
function runShell(cmd, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const cap = (chunk) => {
      out += String(chunk);
      if (out.length > 16384) out = out.slice(-16384);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_) {
        /* already gone */
      }
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, output: out.trim(), timedOut });
    });
  });
}

module.exports = { rewriteForPrivilege, runShell, shellQuote };
