# NX Hub — SPEC (contract, v1)

One installer/updater for every NX app. Electron 31, all logic in the main process,
sandboxed renderer behind `window.nxhub` (contextBridge). This file is the frozen
contract between modules — change it only in the main loop, never from an agent.

## What it does

- **Auto-discovers** from configurable sources: `settings.owners` (GitHub
  accounts whose repos are all scanned; default `["nerdrx"]`, authenticated →
  private repos included) plus `settings.extraRepos` (hand-pinned `owner/repo`
  entries — any repo from anyone). For each: fetch latest release, classify the
  assets into installable artifacts. New repos and new releases appear
  automatically — no registry edit needed. Both lists are editable in the
  Settings UI ("Sources"); cards from a non-primary owner show an owner badge.
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
  id,            // repo name, lowercased; a non-primary source's repo is
                 // owner-prefixed ("owner--name") so same-named repos from two
                 // sources can never collide in state, prefs, or jobs
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
setSettings(patch)    // { owners: [..], extraRepos: ["owner/repo", ..], token,
                      //   checkIntervalHours, installRoot, adbPath }
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
                      "postInstallNote", "postInstallCmd",   // cmd = the copy-button command; the note is prose
                      "skip": true|false }] } } }
```

Live overlay URL: `https://raw.githubusercontent.com/nerdrx/nx-hub/main/registry/overrides.json`
(fetched with token if set — works if repo private), fallback = bundled copy.

## Android companion (`android-app/`, own build, shares this repo)

"NX Hub" APK for on-device installs — runs on the Pico and regular phones, no adb
needed. Kotlin, single activity, minimal deps, same space branding (#7700FF /
#00e5ff on #0a0714). Same discovery model reduced to APKs: sources (owners +
extraRepos + optional token) in an in-app settings sheet, latest release per
repo, `*.apk` assets only; installed versions via PackageManager (packageId from
the overlay, else parsed from the downloaded APK). Install = download to app
cache + PackageInstaller session (REQUEST_INSTALL_PACKAGES). Launch button for
installed apps. Self-update: the hub's own releases carry
`NX-Hub-<version>-android.apk` (packageId `com.nxhub.android`) which both hubs
classify like any APK. Signing keystore lives OUTSIDE the repo in
`Lex/claude/tools/nx-hub-keystore/` (creds gitignored, pattern as PulseNX).

## v0.2 additions (frozen 2026-08-14)

Settings gains: `appPrefs: { <appId>: { updatePolicy: "notify"|"download"|"install",
includePrereleases, skippedVersion, favorite, launchArgs: [..], launchEnv: {..},
hidden } }`, plus global `updatePolicy` (default "notify"), `includePrereleases`
(default false), `notifications` (default true), `autostart` (default false),
`startMinimized` (default false), `createDesktopEntries` (default true),
`maxConcurrentDownloads` (default 2), `preferredDeviceSerial`.

`window.nxhub` additions:
```js
getReleases(appId)                    // full release list [{tag,version,notes,publishedAt,prerelease,assets}]
installVersion(appId, artifactId, tag) // any version; UI confirms downgrades
rollback(appId, artifactId)           // restore the kept previous install
setAppPref(appId, patch)              // appPrefs merge-save
adbConnect(hostPort); adbSelectDevice(serial)
getDeviceInfo()                       // {serial, model, batteryPct, storageFreeBytes}
getDiskUsage()                        // {perApp: {appId: bytes}, downloads: bytes, total: bytes}
clearDownloadCache()
getLogs(tailLines); exportSettings(); importSettings(json)
runPostInstallCmd(appId, artifactId)  // executes the artifact's OWN overlay
                                      // postInstallCmd (ids only cross IPC —
                                      // never a command string); sudo → pkexec
```
Events: `update-available {appId, version}` (also fires an OS notification when
settings.notifications). Engines: launch() honors appPrefs launchArgs/launchEnv;
install keeps the replaced version as `.prev` alongside (one level deep) for
rollback; desktop-entry creation respects createDesktopEntries. Background
scheduler applies per-app updatePolicy after each refresh. Autostart = XDG
autostart .desktop toggle. Prerelease handling switches from /releases/latest to
the /releases list, filtered per app pref. All new UI text stays English;
formatting must be locale-independent (host machines may run de_DE).

## NX Connector (v0.5 — frozen 2026-08-16)

The hub hosts a local rendezvous bus; NX apps announce presence and stream
status; the hub renders it and orchestrates multi-app **stacks**.

### Bus (`src/main/connector/` — [bus])

WebSocket server on `ws://127.0.0.1:9021` (config.NX_CONNECTOR_PORT), loopback
only, zero npm deps (hand-rolled RFC6455 server: GET upgrade, masked client
frames, text only, ≤16KB frames). Auth: shared secret at
`<dataDir>/connector.token` (0600, created at init); clients present it in
`hello`. Wire protocol (JSON per WS text frame):

```js
// client → hub
{ type:"hello", app:"pulsenx", version:"1.2.1", pid, token, caps:["status"] }
{ type:"status", fields:{ hr:72, connected:true } }  // ≤2KB, throttled 4/s
{ type:"bye" }
// hub → client
{ type:"welcome", hub:"<version>" } | { type:"error", message } | { type:"ping" }
{ type:"shutdown-request" }         // polite stop (stacks); client SHOULD exit
```

Module API (frozen): `init({port, dataDir, emit, log, hubVersion})→{close}` ·
`getClients()→[{app,version,pid,since,lastSeen,fields}]` · `isPresent(appId)` ·
`requestShutdown(appId)→bool` · `onChange(cb)`. Emits `{type:"connector-changed"}`
through `emit` (debounced ≤4/s). Unknown/duplicate app ids: latest hello wins,
id normalized lowercase. Client presence = open socket; 30s ping, 90s reap.

Drop-in client: `docs/connector/nx-connector.js` (CommonJS, zero deps,
node/electron): `connect({app, version, url?, tokenPath?}) → {sendStatus,
close, on}` with auto-reconnect (1s→30s backoff) and silent no-hub tolerance.
`docs/connector/PROTOCOL.md` documents the wire format for non-JS apps.

### Status rendering (overlay + [ui])

Overlay per app: `"connector": { "fields": [{ "key":"hr", "label":"Heart
rate", "unit":"bpm", "kind":"number"|"text"|"bool" }] }` — cards show a live
status strip when the app is present (cyan dot + formatted fields); unknown
fields render `key: value` generically. Tray lines: "PulseNX · 72 bpm".
`getState()` gains `connector: { clients }`.

### Stacks (`src/main/stacks.js` — [stacks])

`<dataDir>/stacks.json`. Model: `{ id, name, steps:[{ appId, artifactId?,
health: { type:"connector"|"port"|"delay", timeoutMs?, port? }, optional? }] }`.
`run`: sequential — launch step via jobs.launch, then gate: `connector` = app
present on the bus; `port` = TCP connect on 127.0.0.1:port; `delay` = wait
timeoutMs. Gate timeout (default 30s): step `optional` → continue, else stop
run, report failed. `stop`: reverse order — `shutdown-request` via bus when
present, else SIGTERM the launch pid (engine launch() already returns {pid});
never SIGKILL. Module API (frozen): `init({jobs, connector, config, emit})` ·
`list()/save(stack)/remove(id)` · `run(id)/stop(id)/running()`. Events:
`{type:"stack-progress", stackId, stepIndex, appId, phase}` with phase ∈
launching|waiting|healthy|failed|done|stopping|stopped.

### IPC additions (frozen)

`getConnector()` · `getStacks()` · `saveStack(stack)` · `deleteStack(id)` ·
`runStack(id)` · `stopStack(id)`; events `connector-changed`, `stack-progress`.
Launch view renders stack tiles (wide, distinct edge treatment) before app
tiles; a Stacks editor sheet creates/edits (ordered app picker + health rule
per step). CLI: `nx status` (bus clients), `nx stack ls|run|stop <id>`.

## Future (not v1 — do not build, do not preclude)

## Verification

- `npm test` → node --test test/core test/install (no network, temp dirs only).
- `node test/e2e.js` → launches real app with mock GitHub + temp dirs, drives
  via :9020 hooks, asserts discovery/install/uninstall flows, screenshots.
- GUI screenshots ONLY inside headless gamescope (`scripts/headless_test.sh`,
  adapted from nxtakt's) — never on the real desktop.
- Real-world smoke test at the end: discovery against live GitHub, install
  QuadForge (small, harmless) into a temp install root.

## CLI (`nx`, v0.3)

A terminal front end for the same logic layer the GUI drives. `src/cli/**` is a
thin presentation layer over `config` / `github` / `discovery` / `state` /
`jobs` / `install/engine` — it re-implements none of them and requires no
electron API (only `ELECTRON_RUN_AS_NODE`), no system node, and no dependencies
(ANSI and argv parsing are hand-rolled).

| Command | Arguments | Does |
| --- | --- | --- |
| `nx list` | `[--all] [--json]` | every app: installed version(s), latest, status glyph (`✓` up to date, `↑` update, `·` not installed). Non-installable repos (unreleased, overlay-hidden, wrong platform) are summarised in a dim bottom block; `--all` spells out the reason per app. |
| `nx info <app>` | `[--json]` | the card in text: repo, tagline, latest, per-artifact table (id, label, platform, size, source version + provenance, installed, status) and post-install notes. |
| `nx install <app> [artifact]` | `[--tag <tag>]` | `jobs.install` / `jobs.installVersion`. |
| `nx uninstall <app> [artifact]` | `[-y]` | `jobs.uninstall`; confirms first on a TTY. |
| `nx update [<app>]` | `[--all]` | bare = list what is pending (installs nothing); `--all` or a named app = install them, one job at a time. |
| `nx launch <app> [artifact]` | | `jobs.launch` (engine `launch()`). |
| `nx rollback <app> [artifact]` | `[-y]` | `jobs.rollback` — the kept `<installdir>.prev`. |
| `nx versions <app>` | `[--json]` | `discovery.getReleases`, marking latest / installed / prerelease. |
| `nx refresh` | `[--force] [--json]` | `discovery.refresh`; `--force` bypasses the ETag cache. |
| `nx doctor` | `[--offline] [--json]` | hub version, runtime, data dir, install root, token source (settings / `gh` / anonymous), sources, rate-limit state, install-engine availability, adb + devices, shim state, install count. Runs one discovery pass unless `--offline`. |
| `nx help` | | command list. `nx --version` prints the hub version. |

Aliases: `ls`, `i`/`add`, `rm`/`remove`, `up`/`upgrade`, `run`/`start`, `sync`,
`status`. **App matching**: exact id → exact name/repo → unambiguous prefix →
unambiguous substring (all case-insensitive, ordinal — never `localeCompare`);
ambiguous prints the candidates and exits 1. **Artifact matching**: optional
when exactly one artifact fits the command (installable on this platform —
android counts, it sideloads over adb — installed, launchable, rollbackable);
otherwise the candidate ids are listed.

**Exit codes**: `0` ok · `1` usage / user error (unknown command or flag,
unknown or ambiguous app, nothing installed to act on) · `2` operation failed
(job error, unreachable sources with nothing cached).

**Output**: 24-bit ANSI in the NX palette (see DESIGN §10) on a TTY; plain text
when the stream is not a TTY, when `NO_COLOR` is set, or with `--plain` /
`--no-color`. Progress is a single `\r`-rewritten bar on **stderr** (violet fill,
dim trough, cyan percentage) and degrades to one line per phase when not a TTY,
so stdout stays clean for pipes. `--json` output is the only thing on stdout in
json mode, errors included (`{ok:false,error}`). All formatting is
locale-independent (ISO dates, the hub's own `fmtBytes`). The hub's console log
is muted unless `--verbose`; the file log always keeps everything.

**Shim**: `bin/nx` in the repo runs the CLI from a checkout. The hub itself
writes `~/.local/bin/nx` on startup (`settings.cliShim`, default true, sanitized
like the other booleans) with the CURRENT `process.execPath` and app dir baked
in:

```sh
#!/bin/sh
# nx-hub-shim
NX_HUB_BINARY='…/nx-hub'; NX_HUB_APP_DIR='…/resources/app.asar'
ELECTRON_RUN_AS_NODE=1 exec "$NX_HUB_BINARY" "$NX_HUB_APP_DIR/src/cli/index.js" "$@"
```

`ELECTRON_RUN_AS_NODE=1` runs the hub's bundled electron as plain node — no
window, no single-instance lock, so `nx` works while the GUI is running (asar
paths included). It is rewritten whenever those paths change (self-update,
move), removed when the setting is turned off, and **never** written over a file
at that path lacking the `# nx-hub-shim` marker. Skipped on win32 and when the
hub runs from a temporary AppImage FUSE mount (`/tmp/.mount_*`), whose paths die
with the process. `nx shim [--force]` reports/rewrites it.

**Concurrency with the GUI**: the CLI runs discovery in its own process and
writes `state.json` through the same atomic write (tmp + rename) — last writer
wins per file, which is acceptable because installs are recorded per
app/artifact and the GUI re-reads state after every job. The CLI deliberately
does NOT wire discovery's `afterRefresh` hook, so a `nx list` never triggers
background update policies.

**Tests**: `test/cli/**` (in the `npm test` glob) — argv parsing, app/artifact
matching, list/info/versions/doctor rendering (plain and styled), progress-line
rendering, shim generation, command dispatch + exit codes with a faked runtime,
plus an end-to-end pass on the real stack against the mock GitHub in temp dirs.
