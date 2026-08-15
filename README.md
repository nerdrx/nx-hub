<div align="center">

<img src="assets/icon.png" width="128" alt="NX Hub">

# NX Hub

### One place for every app you ship.

**Installer · Updater · Launcher — powered directly by your GitHub releases.**

[![release](https://img.shields.io/github/v/release/nerdrx/nx-hub?display_name=tag&color=7700FF&labelColor=171028)](https://github.com/nerdrx/nx-hub/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-00e5ff?labelColor=171028)](LICENSE)
![platforms](https://img.shields.io/badge/linux%20·%20windows%20·%20android-efeaff?label=platforms&labelColor=171028)
![tests](https://img.shields.io/badge/tests-494%20passing-00e5ff?labelColor=171028)

<br>

<img src="docs/screenshots/hub.png" width="92%" alt="NX Hub — Manage view">

<br><br>

<img src="docs/screenshots/launch.png" width="92%" alt="NX Hub — Launch view">

</div>

<br>

NX Hub turns a GitHub account into a first-class software distribution channel.
It discovers every repository you publish, understands the artifacts inside each
release, and operates the entire lifecycle that follows: installation, updates,
version pinning, rollback, launching, and provably clean removal — across
Linux, Windows, and Android.

There is no store to submit to, no manifest to maintain, no update server to
operate, and no packaging format to adopt. GitHub Releases *is* the backend.
The moment a release goes live, it is live in the hub — on every desktop and
every device, simultaneously.

<br>

## Table of contents

- [Capabilities](#capabilities)
- [How discovery works](#how-discovery-works)
- [The integrity pipeline](#the-integrity-pipeline)
- [Update orchestration](#update-orchestration)
- [Device support](#device-support)
- [The terminal](#the-terminal)
- [The Android companion](#the-android-companion)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [The registry overlay](#the-registry-overlay)
- [Architecture](#architecture)
- [Design system](#design-system)
- [Development](#development)
- [FAQ](#faq)

<br>

## Capabilities

| | |
| --- | --- |
| **Zero-registration discovery** | Entire GitHub accounts and hand-pinned repositories, public and private, enumerated automatically. New repos and releases surface on the next refresh cycle. |
| **Per-artifact install engines** | Purpose-built strategies for AppImages, prefix tarballs, APKs, Blender add-ons, and Windows portables — not a generic downloader. |
| **Transactional installs** | Staged extraction with atomic rename-swaps. A failed download, checksum, or unpack can never strand a broken half-install. |
| **Manifest-exact uninstalls** | Every file written outside an install's own directory is recorded; removal replays the manifest, byte-for-byte accountable. |
| **Policy-driven updates** | Notify, pre-download, or auto-install — globally or per app — with OS notifications, per-version deduplication, and skip lists. |
| **Version time travel** | Full release history per app, install-any-version with downgrade confirmation, and single-click rollback to the retained previous install. |
| **Launcher surface** | Icon tiles ordered by favorites and recency, tray quick-launch, and remote launch of installed APKs on the connected device. |
| **Self-hosting** | The hub is an entry in its own catalog and updates itself through the identical pipeline, relaunching into the new binary. |
| **A first-class CLI** | `nx list · install · update --all · launch · rollback · doctor` — the same engine from any shell, with `--json` for scripting. |

<br>

## How discovery works

Discovery is a fan-out over your configured sources: each account in `owners`
is enumerated through the authenticated `/user/repos` listing (which includes
private repositories) or the public listing when anonymous, unioned with every
pinned `extraRepos` entry. For each repository the hub retrieves the complete
release list — not merely `/releases/latest` — so prerelease channels, version
history, and cross-release artifact resolution all operate on full information.

Every API interaction is **ETag-conditional**: responses are cached on disk and
revalidated with `If-None-Match`, so an idle refresh cycle costs a handful of
`304 Not Modified` responses rather than repeated payloads. Rate-limit headers
are tracked continuously; when GitHub throttles, the hub surfaces the reset
time and degrades gracefully instead of failing opaquely.

Asset classification maps each release file to an artifact descriptor by
extension and naming convention — `.apk` → adb sideload, `.AppImage` →
FUSE-independent extract-install, `*linux*.tar.gz` → prefix install,
`*windows*.exe`/`.zip` → portable — with checksum and signature siblings
(`.sha256`, `.sig`, `.blockmap`) folded into their parent artifact rather than
rendered as noise.

**Cross-release artifact resolution.** A release that ships only one platform
must not degrade the rest. Artifacts are resolved per *kind + platform*: each
comes from the newest eligible release that actually carries it, is labelled
with the version of that source release, and is diffed against that version for
update detection. An Android-only hotfix therefore advances the APK row alone,
while the desktop rows remain anchored — correctly — to their own newest
builds. Older releases participate strictly as **gap-fillers**: they may
contribute a platform the newer releases lack entirely, never a duplicate
flavor of one they already cover. The behavior is configurable per app for
repositories that want strict latest-release semantics.

Version comparison normalizes both operands through the same parser, so tag
prefixes (`v1.2.3`, `nx-1.3`) and device-reported `versionName` strings compare
by content, never by formatting accident.

<br>

## The integrity pipeline

Every byte between GitHub and your disk is accounted for:

1. **Transport.** Assets stream through the authenticated API endpoint (so
   private-repo downloads work identically), with the hash/progress meter
   implemented as a stream-pipeline stage — a single-consumer design that makes
   out-of-order interleaving structurally impossible.
2. **Length verification.** The on-disk byte count is checked against the
   release's authoritative asset size. A cleanly closed early stream — the kind
   that ends without a socket error — is detected and retried with backoff
   rather than passed to the extractor.
3. **Checksum verification.** When a release publishes a `.sha256` sidecar, the
   download is verified against it before anything is unpacked.
4. **Staged installation.** Extraction happens in a scratch sibling directory;
   the live install is replaced by atomic rename only after the stage is
   complete. The previous version is retained as a rollback target.
5. **Manifest accounting.** Each install writes a manifest of its version,
   kind, launch binary, desktop entries, and every path written outside its own
   directory. Uninstall replays the manifest; prefix installs remove exactly
   the files they created and prune only directories they emptied.

Failures at any stage roll back to the pre-transaction state. There is no
"partially installed" in the hub's vocabulary.

<br>

## Update orchestration

After every refresh — scheduled, manual, or startup — the policy engine sweeps
all artifacts with pending updates and applies the effective policy, resolved
per app with global fallback:

- **notify** — an OS notification and an update badge, emitted once per
  (app, version) pair and persisted so restarts do not re-notify;
- **download** — the asset is fetched and verified in the background, and the
  action button becomes *Install downloaded update* — apply is instant;
- **install** — the full pipeline runs unattended, serialized through the
  per-app job queue so an update can never race a user-initiated action.

Prerelease opt-in is per app; skipped versions suppress exactly the skipped
version and re-arm on the next; downgrades demand explicit confirmation; and
concurrent transfer count is a user-tunable semaphore, distinct from the
per-app install serialization.

<br>

## Device support

Android hardware is a first-class install target, not an afterthought.
The device panel handles wireless adb (`host:port` pairing with sane defaults),
multi-device selection with a persisted preference, and pre-flight facts —
model, battery percentage, free storage — before an APK is committed.
Installed versions are read live from the device (`dumpsys`-derived, normalized
before comparison), so the hub reflects what is actually on the hardware, not
what it last remembers installing. Installed packages launch remotely through
the activity manager.

<br>

## The Android companion

A self-contained companion app — under 700 KB, **zero runtime dependencies**;
plain `HttpsURLConnection`, platform JSON, and stock widgets — brings the
catalog to the device itself. It performs the same source enumeration and
overlay merge, installs through Android's `PackageInstaller` session API
(including seamless self-update), tracks installed versions through
`PackageManager`, and stores its GitHub token encrypted via a hardware-backed
`AndroidKeyStore` AES-GCM key. Release fallback logic mirrors the desktop:
a desktop-only patch release never evicts an app from the phone's list.

<br>

## Getting started

**Linux** — download from [Releases](https://github.com/nerdrx/nx-hub/releases/latest), then:

```bash
chmod +x NX-Hub-*-linux.AppImage
./NX-Hub-*-linux.AppImage
```

**Windows** — run the portable `.exe` from the same page.

**Android** — install the APK on the device, or let the desktop hub sideload it
over adb once a device is connected.

Every published file carries a `.sha256` sibling for independent verification:

```bash
sha256sum -c NX-Hub-*-linux.AppImage.sha256
```

<br>

## Configuration

**Settings → Sources** defines the discovery universe:

| Setting | Purpose |
| --- | --- |
| `owners` | GitHub accounts scanned in full. Default: `nerdrx`, `Arikazei`. |
| `extraRepos` | Individually pinned `owner/repo` entries from any account. |

Private repositories require a token. If the [`gh` CLI](https://cli.github.com/)
is authenticated, the hub resolves its token automatically; otherwise a
fine-grained personal access token with read access to your repositories can be
entered in Settings. Anonymous operation works on public repositories, at
GitHub's substantially lower unauthenticated rate budget — the token is worth
adding for headroom alone.

Further knobs: global and per-app update policy, prerelease channels, refresh
interval, install root, adb path, download concurrency, autostart with
start-minimized, desktop-entry creation, per-app launch arguments and
environment overrides, and settings export/import — with credentials
categorically excluded from every export.

<br>

## The registry overlay

Discovery is fully automatic; the overlay refines presentation and installation
semantics. [`registry/overrides.json`](registry/overrides.json) supplies
display names, taglines, ordering, install-strategy hints for artifacts that
need them (prefix paths, package ids, launch commands, post-install notes), and
an owner-scoped `hidden` list:

```jsonc
{
  "hidden": ["nerdrx/some-scratch-repo"],
  "apps": {
    "wivrn-nx": {
      "name": "WiVRn NX",
      "tagline": "Wireless VR streaming, tuned",
      "order": 10,
      "artifacts": [
        { "assetPattern": "*.apk", "label": "Headset APK",
          "kind": "apk-adb", "packageId": "org.meumeu.wivrn" }
      ]
    }
  }
}
```

The overlay is fetched live from this repository's `main` branch, so curation
propagates to every installed hub — desktop and Android — without shipping a
release; the bundled snapshot serves as offline fallback. Hidden entries are
owner-scoped by design: `owner/repo` hides exactly that repository, while a
bare name applies only to the primary account, so an identically-named
repository from another source can never inherit the hiding. Repositories the
overlay does not mention appear under their own names — curation is optional
everywhere.

> The overlay is a public file. It may reference private repository names —
> that is intentional and harmless. **Secrets never belong in the overlay.**

<br>

## Architecture

Three layers, one frozen contract:

- **Main process** — discovery and classification, the ETag-cached rate-aware
  GitHub client, the job queue with per-app serialization and a global transfer
  semaphore, the update-policy engine, window/tray lifecycle, and device
  orchestration. Pure-Node modules throughout; Electron APIs touch only the
  boundary files, which keeps the entire logic layer unit-testable without a
  display server.
- **Install engines** — one module per artifact kind behind a fixed dispatcher
  interface (`install`/`uninstall`/`launch`/rollback), each emitting phase-level
  progress and writing the manifest that makes its uninstall provable.
- **Renderer** — dependency-free, framework-free, bundler-free: pure string
  renderers hydrated through a single delegated event layer, defensive
  normalizers over the IPC payload, and capability probing so the UI degrades
  feature-by-feature rather than breaking against an older main process.

[**SPEC.md**](SPEC.md) is the authoritative contract for all three: the app
model, the IPC surface, install-kind semantics, and the visual language.
Verification runs at three levels: hermetic unit suites (mock GitHub server,
temp filesystems, fake adb), an end-to-end harness that drives the real
application against a fixture API inside a headless compositor, and
screenshot-reviewed visual passes.

<br>

## Design system

The interface is built on a tiered liquid-glass system: true backdrop blur is
budgeted to the few floating surfaces that earn it (bars, sheets, menus,
toasts), while cards synthesize their glass from layered translucent gradients
over a slow-drifting nebula field — which is why a full grid stays fluid on
modest GPUs. Cards flow in a masonry layout that packs by height, the content
column scales to ultrawide displays, and every decorative motion collapses
under `prefers-reduced-motion` to opacity-only transitions. The mark itself is
a beveled glass crystal with a sculpted monogram, shipped as three
size-specific variants so it stays crisp from a 16-pixel tray to a 512-pixel
tile.

<br>

## Development

```bash
npm install

npm start          # run the hub
npm test           # full unit suite (node --test, hermetic, no network)
npm run e2e        # end-to-end against a mock GitHub API
npm run dist:linux # AppImage     -> dist/
npm run dist:win   # portable exe -> dist/  (uses wine)
```

GUI verification runs inside a headless gamescope compositor — never on your
desktop:

```bash
scripts/headless_test.sh -o /tmp/hub.png
```

Releasing is one command after a version bump:

```bash
scripts/release.sh              # build, checksum, publish to GitHub
scripts/release.sh --dry-run    # build and checksum only
```

<br>

## FAQ

**Does this replace a package manager?**
For software you publish yourself — yes, that is the point. It does not manage
system packages and never asks for elevation; everything lives under
user-owned prefixes.

**What happens without a network connection?**
Cached discovery state renders, installed apps launch, and the next successful
refresh reconciles. The hub never blocks launching on connectivity.

**Can it install from someone else's account?**
Any account or repository can be added as a source. Bring friends.

**Why extract AppImages instead of running them directly?**
Modern distributions increasingly ship without `libfuse2`. Extraction at
install time produces a launchable tree that behaves identically everywhere —
and the original AppImage is kept alongside for portability.

**How private is my token?**
It is used exclusively as an `Authorization` header against `api.github.com`,
never logged, never exported, and on Android it is stored encrypted under a
hardware-backed keystore key.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
<sub>made with Claude</sub>
</div>
