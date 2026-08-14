"use strict";
// kinds: "windows-portable" (a single .exe) and "windows-zip" (a zip holding an
// .exe). Same <installRoot>/nx/<appId>/<artifactId>/ layout as everything else,
// but with a Start-menu shortcut instead of a .desktop file.
//
// This code ships in v1 and is exercised on the real Windows box later; on Linux
// every entry point refuses cleanly (the UI renders these artifacts with a
// "Windows" chip and no install button, so this is only a backstop).

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  installDirFor, exists, mkdirp, extractArchive, walkFiles, pickBinary,
  spawnDetached, stagedInstall, writeManifest, readManifest, throwIfAborted, run,
} = require("./util");
const { standardUninstall, nameHints } = require("./common");

const REFUSAL = "Windows artifact — install from the hub on Windows";

function isWindows() {
  return process.platform === "win32";
}

function requireWindows() {
  if (!isWindows()) throw new Error(REFUSAL);
}

function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "NX Hub");
}

function shortcutPath(app, artifact) {
  const safe = String(app.name || app.id).replace(/[\\/:*?"<>|]/g, "-");
  const suffix = artifact.label ? ` (${String(artifact.label).replace(/[\\/:*?"<>|]/g, "-")})` : "";
  return path.join(startMenuDir(), `${safe}${suffix}.lnk`);
}

/** Create a .lnk via WScript.Shell. Best-effort: never fails the install. */
async function createShortcut({ app, artifact, target, ctx }) {
  if (!isWindows()) return null;
  const lnk = shortcutPath(app, artifact);
  await mkdirp(path.dirname(lnk));
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$s = New-Object -ComObject WScript.Shell",
    `$k = $s.CreateShortcut(${psQuote(lnk)})`,
    `$k.TargetPath = ${psQuote(target)}`,
    `$k.WorkingDirectory = ${psQuote(path.dirname(target))}`,
    `$k.Description = ${psQuote(app.tagline || app.name || app.id)}`,
    "$k.Save()",
  ].join("; ");
  const res = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    timeout: 30000,
    signal: ctx?.signal,
  });
  if (res.code !== 0) {
    ctx?.log?.(`Start-menu shortcut failed (non-fatal): ${(res.stderr || "").trim()}`);
    return null;
  }
  ctx?.log?.(`Start-menu shortcut created: ${lnk}`);
  return lnk;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function install({ app, artifact, filePath, ctx }) {
  requireWindows();
  const installDir = installDirFor(app, artifact, ctx);
  const kind = artifact.kind === "windows-portable" ? "windows-portable" : "windows-zip";

  ctx.emitProgress("verify", 5, "Checking download");
  if (!(await exists(filePath))) throw new Error(`Downloaded file missing: ${filePath}`);

  let binary = null;

  await stagedInstall(installDir, async (stage) => {
    throwIfAborted(ctx);
    if (kind === "windows-portable") {
      ctx.emitProgress("install", 40, "Installing executable");
      const name = artifact.assetName || path.basename(filePath);
      await fsp.copyFile(filePath, path.join(stage, name));
      binary = name;
    } else {
      ctx.emitProgress("extract", 25, "Extracting archive");
      await extractArchive(filePath, stage, ctx);
      const files = await walkFiles(stage);
      if (!files.length) throw new Error("Archive extracted to nothing — download may be corrupt");
      ctx.emitProgress("install", 70, "Locating executable");
      binary =
        (artifact.binHint && files.find((f) => f.rel === artifact.binHint)?.rel) ||
        pickExe(files, nameHints(app, artifact)) ||
        (await pickBinary(stage, { hint: artifact.binHint, names: nameHints(app, artifact), ctx }));
    }
  });

  const files = [];
  if (binary) {
    ctx.emitProgress("install", 88, "Creating Start-menu shortcut");
    const lnk = await createShortcut({ app, artifact, target: path.join(installDir, binary), ctx });
    if (lnk) files.push(lnk);
  }

  ctx.emitProgress("cleanup", 96, "Writing manifest");
  await writeManifest(installDir, {
    version: artifact.version,
    kind,
    files,
    dirs: [],
    desktopEntries: [],
    binary,
  });

  ctx.emitProgress("cleanup", 100, "Installed");
  return { version: artifact.version, path: installDir, launchable: Boolean(binary) };
}

/** Prefer an .exe whose name matches the app, then the shallowest/biggest one. */
function pickExe(files, names) {
  const exes = files.filter((f) => /\.exe$/i.test(f.rel));
  if (!exes.length) return null;
  const wanted = names.map((n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  const score = (f) => {
    const base = path.basename(f.rel, path.extname(f.rel)).toLowerCase().replace(/[^a-z0-9]/g, "");
    let s = 0;
    if (wanted.includes(base)) s += 1000;
    else if (wanted.some((w) => base.startsWith(w) || w.startsWith(base))) s += 400;
    if (/unins|setup|vcredist|crash|helper/i.test(f.rel)) s -= 800;
    s -= f.rel.split(path.sep).length * 20;
    s += Math.min(100, Math.log10(Math.max(f.size, 1)) * 10);
    return s;
  };
  exes.sort((a, b) => score(b) - score(a) || b.size - a.size);
  return exes[0].rel;
}

async function uninstall({ app, artifact, installedPath, ctx }) {
  // Uninstall stays tolerant on Linux: if a state entry somehow exists we still
  // clean it up rather than trapping the user.
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  return standardUninstall({ installDir, ctx });
}

async function launch({ app, artifact, installedPath, ctx }) {
  requireWindows();
  const installDir = installedPath || installDirFor(app, artifact, ctx);
  const manifest = await readManifest(installDir);
  const rel = manifest?.binary || artifact.binHint;
  if (!rel) throw new Error("No executable recorded for this install");
  const abs = path.join(installDir, rel);
  if (!(await exists(abs))) throw new Error(`Executable missing at ${abs} — reinstall the app`);
  ctx.log(`launching ${abs}`);
  const child = spawnDetached(abs, [], { cwd: path.dirname(abs) });
  return { pid: child.pid, command: abs };
}

module.exports = {
  install, uninstall, launch, REFUSAL, isWindows, startMenuDir, shortcutPath, pickExe,
};
