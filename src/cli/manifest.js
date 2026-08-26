"use strict";
// `nx manifest check|init` — SPEC v0.12 "app manifest".
//
//   nx manifest check [--file <path>] [--json]   validate an nx-app.json
//   nx manifest init <app> [--json]              print the manifest for an app
//                                                the hub already curates
//
// `check` is meant to run in an app repo's CI: exit 0 when the file is clean,
// 1 when it is not. It also prints what a hub that does NOT trust the repo's
// owner would refuse — an author who writes a postInstallCmd should find out
// here, not from a user wondering why the Run button never showed up.
//
// Neither subcommand touches the network or needs a running hub.

const fs = require("fs");
const path = require("path");

const manifest = require("../main/manifest");

const EXIT_OK = 0;
const EXIT_USER = 1;

/** Structurally index.js's UserError — see the same note in ./dev.js. */
function userError(message, hint) {
  const e = new Error(message);
  e.name = "UserError";
  e.hint = hint || null;
  e.exitCode = EXIT_USER;
  return e;
}

const SUBS = ["check", "init"];

async function cmdManifest(ctx) {
  const sub = String(ctx.args[0] || "").toLowerCase();
  if (sub === "check") return check(ctx);
  if (sub === "init") return init(ctx);
  throw userError(
    sub ? `unknown manifest command "${ctx.args[0]}"` : "nx manifest needs a subcommand",
    "nx manifest check [--file <path>] | nx manifest init <app>"
  );
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

function check(ctx) {
  const target = String(ctx.flags.file || manifest.MANIFEST_FILE);
  const file = path.resolve(process.cwd(), target);

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw userError(
      `could not read ${file} (${e.code === "ENOENT" ? "no such file" : e.message})`,
      "write one first — `nx manifest init <app>` prints a working example"
    );
  }

  // Validated twice on purpose: once as a trusted owner, so problems INSIDE the
  // executable fields are still reported, and once as a stranger, so the author
  // sees exactly what a hub that does not trust them would throw away.
  const asTrusted = manifest.validate(text, { trusted: true });
  const asStranger = manifest.validate(text, { trusted: false });
  const ok = asTrusted.ok && asTrusted.problems.length === 0;

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          ok,
          file,
          valid: asTrusted.ok,
          manifest: asTrusted.manifest,
          problems: asTrusted.problems,
          droppedForUntrustedOwner: asStranger.dropped,
          usableByUntrustedOwner: asStranger.ok,
        },
        null,
        2
      )
    );
    return ok ? EXIT_OK : EXIT_USER;
  }

  const st = ctx.st;
  ctx.out("");
  ctx.out(`  ${st.dim(file)}`);
  if (asTrusted.ok) {
    const m = asTrusted.manifest;
    const bits = [];
    if (m.name) bits.push(m.name);
    bits.push(`${m.artifacts.length} artifact${m.artifacts.length === 1 ? "" : "s"}`);
    ctx.out(`  ${ok ? st.cyan("✓") : st.amber("!")} ${st.text(bits.join("  ·  "))}`);
  } else {
    ctx.out(`  ${st.danger("✗")} ${st.text("not a usable nx-app.json")}`);
  }

  if (asTrusted.problems.length) {
    ctx.out("");
    ctx.out(`  ${st.amber(`${asTrusted.problems.length} problem${asTrusted.problems.length === 1 ? "" : "s"}`)}`);
    for (const p of asTrusted.problems) ctx.out(`  ${st.muted(p.field || "(file)")}  ${st.dim(p.detail)}`);
  }

  if (asStranger.dropped.length) {
    ctx.out("");
    ctx.out(`  ${st.muted("needs a trusted owner")}`);
    ctx.out(`  ${st.dim(asStranger.dropped.join(", "))}`);
    ctx.out(
      `  ${st.dim(
        "a hub only honours these from settings.owners or settings.trustedManifestOwners — everyone else gets the presentation fields only"
      )}`
    );
  }
  ctx.out("");
  return ok ? EXIT_OK : EXIT_USER;
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function init(ctx) {
  const query = String(ctx.args[1] || "").trim();
  if (!query) throw userError("nx manifest init needs an app", `try one of: ${manifest.overlayIds().slice(0, 8).join(", ")}`);

  const ids = manifest.overlayIds();
  const wanted = query.toLowerCase();
  const id =
    ids.find((k) => k === wanted) ||
    ids.find((k) => k === wanted.slice(wanted.indexOf("--") + 2)) ||
    ids.filter((k) => k.startsWith(wanted))[0] ||
    null;
  const entry = id ? manifest.fromOverlayEntry(id) : null;
  if (!entry) {
    throw userError(`no overlay entry for "${query}"`, `the hub curates: ${ids.join(", ")}`);
  }

  const text = `${JSON.stringify(entry, null, 2)}\n`;
  ctx.stdout.write(text);
  if (!ctx.json) {
    ctx.err(ctx.stErr.dim(`  save as ${manifest.MANIFEST_FILE} in the repo root, or attach it to the release`));
    const result = manifest.validate(entry, { trusted: true });
    for (const p of result.problems) ctx.err(ctx.stErr.dim(`  ${p.field || "(file)"}: ${p.detail}`));
  }
  return EXIT_OK;
}

module.exports = { cmdManifest, SUBS };
