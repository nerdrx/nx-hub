"use strict";
// Hand-rolled argv parsing — the CLI ships with zero dependencies.
//
//   nx <command> [positionals…] [--flags]
//
// Supported forms: --flag, --no-flag, --flag=value, --flag value (for the
// value-taking flags listed in VALUE_FLAGS), -h, -y.

const BOOL_FLAGS = new Set([
  "json",
  "all",
  "force",
  "verbose",
  "plain",
  "offline", // doctor: skip the discovery pass
  "color", // --no-color
  "yes",
  "help",
  "version",
]);

// v0.6: `--port` lets `nx fleet pair` reach a hub that is not on :9023.
// There is deliberately no `--code`: a pairing code is a shared-secret seed
// and command-line arguments land in shell history and in `ps` output.
const VALUE_FLAGS = new Set(["tag", "port"]);

const SHORT = { h: "help", y: "yes", v: "verbose" };

/**
 * @param {string[]} argv arguments AFTER the program name
 * @returns {{command:string|null, args:string[], flags:object, unknown:string[]}}
 */
function parseArgv(argv) {
  const out = { command: null, args: [], flags: {}, unknown: [] };
  const list = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  let onlyPositional = false;

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];

    if (onlyPositional) {
      pushPositional(out, token);
      continue;
    }
    if (token === "--") {
      onlyPositional = true;
      continue;
    }

    if (token.startsWith("--")) {
      let name = token.slice(2);
      let value = null;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      let negated = false;
      if (name.startsWith("no-")) {
        negated = true;
        name = name.slice(3);
      }
      if (VALUE_FLAGS.has(name)) {
        if (value == null) {
          value = list[i + 1] != null && !String(list[i + 1]).startsWith("-") ? list[(i += 1)] : "";
        }
        out.flags[name] = value;
        continue;
      }
      if (BOOL_FLAGS.has(name)) {
        out.flags[name] = value == null ? !negated : value !== "false" && value !== "0";
        continue;
      }
      out.unknown.push(token);
      continue;
    }

    if (token.length > 1 && token[0] === "-") {
      // -abc → -a -b -c
      let bad = false;
      for (const ch of token.slice(1)) {
        const name = SHORT[ch];
        if (!name) {
          bad = true;
          break;
        }
        out.flags[name] = true;
      }
      if (bad) out.unknown.push(token);
      continue;
    }

    pushPositional(out, token);
  }

  return out;
}

function pushPositional(out, token) {
  if (out.command == null) out.command = token.toLowerCase();
  else out.args.push(token);
}

module.exports = { parseArgv, BOOL_FLAGS, VALUE_FLAGS, SHORT };
