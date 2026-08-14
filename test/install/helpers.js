"use strict";
// Shared test scaffolding for the install-engine tests.
// Hard rules: no network, no real adb, no GUI, everything under a temp dir.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ENGINE_DIR = path.resolve(__dirname, "..", "..", "src", "main", "install");

/** A fresh sandbox: installRoot + dataDir + isolated XDG_DATA_HOME + HOME. */
async function makeSandbox(label = "nxhub") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const dirs = {
    root,
    installRoot: path.join(root, "Applications"),
    dataDir: path.join(root, "data"),
    xdgDataHome: path.join(root, "xdg-data"),
    home: path.join(root, "home"),
    downloads: path.join(root, "downloads"),
    bin: path.join(root, "bin"),
  };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  await fsp.mkdir(path.join(dirs.xdgDataHome, "applications"), { recursive: true });
  return dirs;
}

async function cleanup(sandbox) {
  if (sandbox?.root) await fsp.rm(sandbox.root, { recursive: true, force: true });
}

/** ctx with recorded log lines and progress events. */
function makeCtx(sandbox, extra = {}) {
  const logs = [];
  const progress = [];
  return {
    dataDir: sandbox.dataDir,
    installRoot: sandbox.installRoot,
    settings: extra.settings || {},
    signal: extra.signal || null,
    log: (m) => logs.push(String(m)),
    emitProgress: (phase, pct, message) => progress.push({ phase, pct, message }),
    logs,
    progress,
    ...extra,
  };
}

/** Point XDG_DATA_HOME at the sandbox so desktop entries stay contained. */
function withXdg(sandbox) {
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = sandbox.xdgDataHome;
  return () => {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  };
}

const APPIMAGE_SCRIPT = `#!/bin/sh
# Fake AppImage: implements just enough of the AppImage runtime for the hub.
# Real AppImages support --appimage-extract without libfuse2; so do we.
if [ "$1" = "--appimage-extract" ]; then
  rm -rf squashfs-root
  mkdir -p squashfs-root/usr/bin squashfs-root/usr/share/icons/hicolor/256x256/apps
  cat > squashfs-root/AppRun <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/usr/bin/realbin" "$@"
EOF
  chmod +x squashfs-root/AppRun
  printf 'ELFISH' > squashfs-root/usr/bin/realbin
  chmod +x squashfs-root/usr/bin/realbin
  printf 'PNGDATA-256' > squashfs-root/usr/share/icons/hicolor/256x256/apps/testapp.png
  printf 'PNGDATA-DIRICON' > squashfs-root/.DirIcon
  printf '[Desktop Entry]\\nName=Test App\\n' > squashfs-root/testapp.desktop
  exit 0
fi
echo "would need FUSE to run" >&2
exit 1
`;

/**
 * Write a fake .AppImage. `opts.electron` adds a chrome-sandbox to the extracted
 * tree; `opts.broken` makes --appimage-extract fail (atomicity test);
 * `opts.noAppRun` extracts a tree without AppRun.
 */
async function writeFakeAppImage(file, opts = {}) {
  let script = APPIMAGE_SCRIPT;
  if (opts.electron) {
    script = script.replace(
      "  printf 'PNGDATA-DIRICON'",
      "  printf 'SUIDHELPER' > squashfs-root/chrome-sandbox\n  printf 'PNGDATA-DIRICON'"
    );
  }
  if (opts.noAppRun) {
    script = script.replace("  chmod +x squashfs-root/AppRun\n", "  rm -f squashfs-root/AppRun\n");
  }
  if (opts.broken) {
    script = `#!/bin/sh\necho "boom: not an AppImage" >&2\nexit 1\n`;
  }
  await fsp.writeFile(file, script, { mode: 0o644 });
  await fsp.chmod(file, 0o755);
  return file;
}

/**
 * Build a real tree on disk from a spec:
 *   { "path/to/file": "contents" | {content, mode} }
 */
async function buildTree(root, spec) {
  for (const [rel, val] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (typeof val === "object" && val && val.symlink) {
      await fsp.symlink(val.symlink, abs);
      continue;
    }
    const content = typeof val === "string" ? val : val.content ?? "";
    await fsp.writeFile(abs, content);
    const mode = typeof val === "object" && val?.mode != null ? val.mode : 0o644;
    await fsp.chmod(abs, mode);
  }
  return root;
}

/** ELF-magic payload so exec-bit recovery has something real to sniff. */
function elfBlob(padding = 400) {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.alloc(padding, 0x41),
  ]).toString("binary");
}

function tarGz(srcDir, outFile) {
  execFileSync("tar", ["-czf", outFile, "-C", srcDir, "."], { stdio: "pipe" });
  return outFile;
}

/** zip WITH unix modes preserved (bsdtar) — exercises the normal +x path. */
function zipWithModes(srcDir, outFile) {
  const entries = fs.readdirSync(srcDir);
  execFileSync("bsdtar", ["-a", "-cf", outFile, "-C", srcDir, ...entries], { stdio: "pipe" });
  return outFile;
}

/** zip WITHOUT unix modes (python zipfile) — exercises exec-bit recovery. */
function zipNoModes(srcDir, outFile) {
  const py = `import os,sys,zipfile
src,out=sys.argv[1],sys.argv[2]
z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)
for root,dirs,files in os.walk(src):
    for f in files:
        p=os.path.join(root,f)
        z.write(p,os.path.relpath(p,src))
z.close()`;
  execFileSync("python3", ["-c", py, srcDir, outFile], { stdio: "pipe" });
  return outFile;
}

/**
 * Install a fake `adb` at <sandbox.bin>/adb that replays canned output, and
 * return {ctx-settings adbPath, calls()} — every invocation is appended to a
 * log file so tests can assert on the exact argv.
 *
 * `script` is a POSIX sh body; `$@` holds the adb args. Helpers available:
 *   emit <text>   → prints text
 */
async function writeFakeAdb(sandbox, body) {
  const logFile = path.join(sandbox.root, "adb-calls.log");
  const file = path.join(sandbox.bin, "adb");
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
${body}
`;
  await fsp.writeFile(file, script, { mode: 0o644 });
  await fsp.chmod(file, 0o755);
  return {
    path: file,
    logFile,
    calls() {
      try {
        return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

const DEVICES_OUTPUT = `List of devices attached
1WMHH8K1234567         device product:phoenix model:Pico_4 device:phoenix transport_id:3
emulator-5554          offline
9ABCD                  unauthorized
`;

/** Canned dumpsys blob with a versionName, like a real headset returns. */
function dumpsysOutput(pkg, version) {
  return `Packages:
  Package [${pkg}] (a1b2c3):
    userId=10234
    versionCode=42 minSdk=29 targetSdk=32
    versionName=${version}
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
`;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listTree(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(`${path.relative(root, abs)}/`);
        await rec(abs);
      } else {
        out.push(path.relative(root, abs));
      }
    }
  }
  await rec(root);
  return out.sort();
}

function readManifestSync(installDir) {
  return JSON.parse(fs.readFileSync(path.join(installDir, ".nx-manifest.json"), "utf8"));
}

module.exports = {
  ENGINE_DIR,
  makeSandbox,
  cleanup,
  makeCtx,
  withXdg,
  writeFakeAppImage,
  buildTree,
  elfBlob,
  tarGz,
  zipWithModes,
  zipNoModes,
  writeFakeAdb,
  DEVICES_OUTPUT,
  dumpsysOutput,
  exists,
  listTree,
  readManifestSync,
};
