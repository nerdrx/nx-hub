# NX Hub — SPEC (contract, v1)

One installer/updater for every NX app. Electron 31, all logic in the main process,
sandboxed renderer behind `window.nxhub` (contextBridge). This file is the frozen
contract between modules — change it only in the main loop, never from an agent.

## What it does

- **Auto-discovers** the user's GitHub account (`owner` setting, default `nerdrx`):
  lists all repos (authenticated → private repos included), fetches the latest
  release of each, classifies the assets into installable artifacts. New repos and
  new releases appear automatically — no registry edit needed.
- A curated **overlay** (`registry/overrides.json`, also fetched live from the
  nx-hub repo main branch so it can be updated without shipping a new hub) refines
  display names, taglines, ordering, install strategies, and hides noise repos.
- Installs / updates / uninstalls / launches per artifact. Self-updates from its
  own repo's releases.
- Repos with no (or no classifiable) release → "Unpublished" section, greyed.
- **Launcher**: the hub doubles as the daily launcher for everything it manages.
  Installed card → primary button = "Launch" (secondary: update when available).
  Tray icon menu lists every installed app for one-click launch (hub window not
  required). Closing the window minimizes to tray; Quit only via tray.

## Processes & files (ownership map for agents)

- `src/main/index.js` — app bootstrap, single-instance, window + tray, periodic
  refresh scheduler. **[core]**
- `src/main/config.js` — settings load/save; token resolution order:
  settings.token → `gh auth token` (execFile, cached) → anonymous. **[core]**
- `src/main/github.js` — REST client: list repos, latest release, asset download
  (Authorization + `Accept: application/octet-stream`), ETag cache, rate-limit
  tolerant. **[core]**
- `src/main/discovery.js` — repos + releases + overlay → App model (below);
  asset classification heuristics. **[core]**
- `src/main/state.js` — installed-state store + install manifests. **[core]**
- `src/main/jobs.js` — job queue (one job per app at a time), progress events,
  cancellation. **[core]**
- `src/main/ipc.js` + `src/main/preload.js` — the `window.nxhub` surface. **[core]**
- `src/main/e2e.js` — when `NX_HUB_E2E=1`: HTTP hooks on :9020 (`/dom`,
  `/screenshot`, `/state`, `/click?sel=`) like PulseNX's e2e server. **[core]**
- `src/main/install/*.js` — install engines, one file per kind (see Kinds), plus
  `engine.js` dispatcher, `desktop.js` (desktop-entry + icon helpers), `adb.js`
  (device detection, apk install, installed-version via dumpsys). **[engines]**
- `src/renderer/**` — UI (index.html, app.js, styles.css; no bundler, no
  framework, ES modules). **[ui]**
- `assets/**`, `scripts/release.sh`, `scripts/headless_test.sh`, README.md,
  electron-builder config in package.json. **[packaging]**
- `test/**` — unit (node --test) per owner: core tests in `test/core/`, engine
  tests in `test/install/`, e2e in `test/e2e.js` **[core]**.

Agents own ONLY their bracketed areas. package.json deps: additions allowed via
`npm i` but no frameworks, no bundlers, no TypeScript. Node built-ins preferred.

## App model (frozen — discovery output, consumed by UI)

```js
{
  id,            // repo name, lowercased
  repo,          // "nerdrx/wivrn-nx"
  name, tagline, // overlay, fallback repo name + description
  private,       // bool (GitHub)
  order,         // overlay sort hint, default 100
  unpublished,   // true when no classifiable release
  latest: { tag, version, publishedAt, notes, prerelease } | null,
  //        version = tag stripped of leading "v", "nx-", "V" etc.
  artifacts: [{
    id,          // stable: kind + platform (+ n if dup)
    label,       // "Headset APK", "Linux server", …
    platform,    // "linux" | "windows" | "android"
    kind,        // see Kinds
    assetName, assetUrl, size,
    installed: { version, path, installedAt } | null,
    updateAvailable, // installed && installed.version !== latest.version
    postInstallNote, // overlay, optional (e.g. setcap command)
  }],
}
```

## Asset classification (defaults; overlay `artifacts` match by assetPattern and win)

- `*.apk` → android / `apk-adb`
- `*.AppImage` → linux / `appimage`
- `*linux*.tar.gz|*.tgz|*linux*.zip` → linux / `archive-dir`
- `*windows*.exe` (or `*setup*.exe` → skipped in favor of portable if both) → windows / `windows-portable`
- `*windows*.zip` → windows / `windows-zip`
- other `*.zip` → linux / `generic-zip` (download to installRoot/downloads, no entry)
- checksums/sigs (`*.sha256`, `*.sig`, `*.yml`, `*.blockmap`) → ignored, but a
  sibling `<asset>.sha256` is used to verify the download when present.

## Install kinds (engine contract)

All installs go under `installRoot` (default `~/Applications`), per-app:
`<installRoot>/nx/<appId>/<artifactId>/`. Every install writes a manifest
(`.nx-manifest.json`: version, files written OUTSIDE the install dir, desktop
entries created) so uninstall/update is exact: uninstall = rm install dir +
manifest-listed outside files. Desktop entries in
`~/.local/share/applications/nx-<appId>-<artifactId>.desktop`, icon extracted
from the artifact when possible.

- `appimage` — download, chmod +x, run `--appimage-extract` in a temp dir (works
  WITHOUT libfuse2 — this box has none), move `squashfs-root` into the install
  dir, keep the original .AppImage alongside as `<name>.AppImage` (for machines
  with FUSE), desktop entry Exec = AppRun. Launch = AppRun.
- `archive-dir` — extract zip/tar.gz into install dir; binary = overlay `binHint`
  else heuristic (largest +x file / name match to app id); desktop entry; launch.
- `tarball-prefix` — overlay-only kind. Extract with `stripPrefix` (e.g. `usr/`)
  into `prefix` (e.g. `~/.local`), record every written file in the manifest for
  exact uninstall; surface `postInstallNote` after install.
- `apk-adb` — requires adb device (settings.adbPath, default `adb` on PATH).
  `adb install -r`. Installed version read live from device via
  `dumpsys package <packageId>` (overlay) when a device is connected; otherwise
  falls back to state-recorded version with a "device offline" hint.
- `blender-addon` — overlay-only. Unzip into overlay `addonsDir`; manifest lists
  the created addon folder.
- `windows-portable` / `windows-zip` — same layout under installRoot on win32;
  Start-menu shortcut instead of .desktop (PowerShell WScript.Shell). Code ships
  v1 but is exercised only when the hub runs on Windows; on Linux these artifacts
  render with a "Windows" chip and no install button.
Launch semantics per kind (engine exports `launch(install)`): `appimage` →
spawn AppRun (detached); `archive-dir` → manifest-recorded binary; `tarball-prefix`
→ overlay `launchCmd` (e.g. WiVRn dashboard binary in ~/.local/bin), hidden if
none; `apk-adb` → `adb shell monkey -p <packageId> 1` on the connected device;
`blender-addon` → no launch; windows kinds → spawn exe (win32 only).

- Self-update: nx-hub is itself an app in the list (its repo has releases);
  installing it replaces the hub's own install dir and relaunches
  (`app.relaunch()` after swap; swap via rename-old → move-new → delete-old).

## `window.nxhub` (frozen IPC surface)

```js
getState()            // → { apps, settings, jobs, adb, hubVersion, refreshing }
refresh(force)        // re-run discovery; force bypasses ETag cache
install(appId, artifactId)
uninstall(appId, artifactId)
launch(appId, artifactId)
cancelJob(jobId)
setSettings(patch)    // { owner, token, checkIntervalHours, installRoot, adbPath }
openExternal(url); showInFolder(path)
onEvent(cb)           // → unsubscribe. Events:
//  { type: "state-changed" }                       (re-pull via getState)
//  { type: "job-progress", jobId, appId, artifactId, phase, pct, message }
//      phase: "download" | "verify" | "extract" | "install" | "cleanup"
//  { type: "job-done" | "job-error", jobId, appId, artifactId, message? }
//  { type: "toast", level: "info"|"warn"|"error", message }
```

## State on disk (env-overridable for tests)

- Data dir: `NX_HUB_DATA_DIR` || `~/.local/share/nx-hub/` — settings.json,
  state.json, cache/ (etags + release json), logs/nx-hub.log (also console).
- Install root: settings.installRoot, `NX_HUB_INSTALL_ROOT` overrides for tests.
- E2E: `NX_HUB_E2E=1` + `NX_HUB_GITHUB_BASE=http://127.0.0.1:PORT` (mock API) —
  github.js must honor the base-URL override.

## Branding (frozen)

Dark space theme. Background #0a0714 → #12091f gradient, panel #171028,
violet **#7700FF** (primary, buttons, accents), cyan **#00e5ff** (secondary,
progress), text #efeaff / #9a8fc0 muted. Warm accent for "update available":
#ffb300. Logo: hexagonal "NX" mark in violet w/ cyan edge glow (assets/icon.svg
→ 512px png for builder). Window frameless=NO (normal frame), dark titlebar via
`backgroundColor`. Footer: "made with Claude" in #7700FF. Font: system UI stack.
UI language: English. Subtle starfield in the header only — no heavy animation
(this is a utility, keep it instant).

## Overlay schema (`registry/overrides.json`)

```js
{ "hidden": ["vrcx-modschnitstelle", "CDRP-for-Claude", "petri", …],
  "apps": { "<repoName>": {
      "name", "tagline", "order",
      "artifacts": [{ "assetPattern",       // glob, matches assetName
                      "label", "kind", "platform", "packageId",
                      "stripPrefix", "prefix", "binHint", "addonsDir",
                      "postInstallNote", "skip": true|false }] } } }
```

Live overlay URL: `https://raw.githubusercontent.com/nerdrx/nx-hub/main/registry/overrides.json`
(fetched with token if set — works if repo private), fallback = bundled copy.

## Future (not v1 — do not build, do not preclude)

**NX Connector**: the hub as a local rendezvous for NX apps — a small always-on
WS endpoint (`ws://127.0.0.1:9021`, reserved now) where installed NX apps can
announce themselves and publish status (PulseNX vitals, WiVRn session state,
OGB link status), surfaced in hub cards/tray. v1 only reserves the port constant
in config.js and keeps jobs/state modules UI-agnostic so a bus can attach later.

## Verification

- `npm test` → node --test test/core test/install (no network, temp dirs only).
- `node test/e2e.js` → launches real app with mock GitHub + temp dirs, drives
  via :9020 hooks, asserts discovery/install/uninstall flows, screenshots.
- GUI screenshots ONLY inside headless gamescope (`scripts/headless_test.sh`,
  adapted from nxtakt's) — never on the real desktop.
- Real-world smoke test at the end: discovery against live GitHub, install
  QuadForge (small, harmless) into a temp install root.
