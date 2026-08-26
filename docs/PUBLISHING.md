# Publishing through NX Hub

**v0.12 · the contract for app repositories**

NX Hub installs, updates and launches programs straight out of GitHub Releases.
There is no store, no submission, and no packaging format to adopt. To be
published through the hub your program needs two things:

1. a **GitHub release** whose assets can be classified per platform, and
2. optionally an **`nx-app.json`** in that release, which is how your app
   describes itself instead of being described in someone else's repository.

This document is the whole contract. Schema:
[`registry/nx-app.schema.json`](../registry/nx-app.schema.json).

---

## 1. What the hub already does for you

A hub is pointed at **sources**: GitHub accounts it scans in full
(`settings.owners`) and individually pinned `owner/repo` entries
(`settings.extraRepos`). Anyone can add either. Your repository does not have to
belong to the hub's maintainer to appear in it.

For every repository in range the hub:

- fetches the release list (with a token when the user has one, so private
  repositories work identically) and revalidates it with ETags;
- **classifies each release asset** into an installable artifact per platform
  (§2), folding `.sha256`, `.sig`, `.blockmap` and `.zpatch` siblings into their
  parent asset instead of showing them as rows;
- resolves artifacts per *kind + platform* across releases, so an Android-only
  hotfix advances the APK row while the desktop rows stay on their own newest
  build;
- **installs** through a purpose-built engine per kind — AppImages are extracted
  so they work without `libfuse2`, archives are staged and swapped in
  atomically, APKs go over adb to a connected device;
- **verifies** the download against the release's asset size, then against your
  `.sha256` sidecar, then against your `.sig` if the owner's key is pinned;
- **updates** on a policy the user picks (notify / pre-download / install),
  keeps the previous install as a rollback target, and can fetch an update as a
  binary **delta** when you publish one;
- **uninstalls exactly**, by replaying a manifest of every file the install
  wrote outside its own directory;
- **launches** the result — from a card, from a tray menu, from `nx launch`,
  and inside a stack of several apps.

A repository with no release, or no classifiable asset in it, still shows up —
greyed out, under "Unpublished". That is the failure mode you are avoiding here.

## 2. What your release must look like

### Naming

Classification is by file name. These are the rules:

| Asset name | Platform | Kind |
| --- | --- | --- |
| `*.apk` | android | `apk-adb` (sideloads over adb, or installs directly on the Android companion) |
| `*.AppImage` | linux | `appimage` (extracted at install; the original is kept alongside) |
| `*linux*.tar.gz`, `*.tgz`, `*linux*.zip` | linux | `archive-dir` |
| `*windows*.exe` | windows | `windows-portable` |
| `*windows*.zip` | windows | `windows-zip` |
| any other `*.zip` | linux | `generic-zip` — downloaded, not installed, no launcher entry |
| `*.sha256`, `*.sig`, `*.yml`, `*.blockmap`, `*.zpatch` | — | ignored as rows, used as siblings |

Two names that look fine and are not: a `.tar.gz` **without** `linux` in it is
not classified at all, and a `.zip` without `linux` or `windows` in it lands in
`generic-zip`, which is a download and nothing more. Put the platform in the
file name. `myapp-1.4.0-linux-x86_64.tar.gz` costs nothing and removes the
entire question.

### One installable asset per platform

Artifact rows are keyed by kind + platform. Two AppImages in one release become
two rows that differ only by a numeric suffix, and neither the user nor
`nx install` can tell which is which. Ship one Linux asset, one Windows asset,
one APK. If you must ship variants (different GPU stacks, an ARM build), expect
to be curated — see §8.

### Why a `Setup.exe` loses to a portable `.exe`

When a release contains both `MyApp-Setup.exe` and a portable
`MyApp-windows.exe`, the setup asset is dropped and the portable one becomes the
Windows artifact. That is deliberate: the hub installs into
`~/Applications/nx/<app>/<artifact>/`, never elevates, and launches what it
installed. Handed only a `Setup.exe`, it will happily install and "launch" your
*installer* as if it were the app. Publish a portable `.exe` or a
`*windows*.zip`, and keep the setup asset for people who download it by hand.

### Checksums

Publish a `<asset>.sha256` beside every installable asset. The hub reads the
first 64-hex word of the file, so ordinary `sha256sum` output is exactly right:

```bash
cd dist
for f in *.AppImage *.apk; do sha256sum "$f" > "$f.sha256"; done
```

Hash from inside the directory, as above, so the sidecar holds a bare filename
and a user can run `sha256sum -c MyApp-1.4.0-linux-x86_64.AppImage.sha256` by
hand after downloading both.

Sidecars are not decoration. They gate three things: the checksum step of the
install pipeline, LAN seeding between paired hubs (a hub only accepts an asset
from a peer when it knows the hash it must end up with), and delta updates,
which refuse to run without one.

### Optional: binary deltas

If a release ships `<asset>.from-<previousVersion>.zpatch` (a `zstd
--patch-from` patch against the same-named asset in the previous release) beside
the full asset and its `.sha256`, a hub updating an **AppImage** from exactly
that previous version downloads the patch instead of the whole file,
reconstructs it locally, and verifies the result against the full asset's
checksum. Any missing piece — no `zstd`, no sidecar, no kept original — falls
back to the full download silently. Linux only.

## 3. `nx-app.json`

Everything in §1 and §2 works with no manifest at all. The manifest is how you
control the parts the file names cannot express: what the app is called, what
the artifact rows say, what a user must still do after installing, and — if the
hub's user trusts you — how the install actually runs.

### Top level

| Field | Type | Does |
| --- | --- | --- |
| `nxApp` | `1` | Manifest format version. Recommended. |
| `name` | string ≤80 | Display name. Default: the repository name. |
| `tagline` | string ≤200 | The line under the name. Default: the repository description. |
| `homepage` | `http(s)` URL ≤300 | Your app's own page. |
| `artifacts` | array ≤16 | Per-asset entries, below. |
| `connector` | object | `{ "fields": [...] }` — how to render live status (§7). |
| `sandbox` | `"confined"` \| `"offline"` \| `"none"` | **Trusted.** Default bwrap profile for launches. |
| `configPaths` | array ≤16 of paths | **Trusted.** Where your config lives: bound into the sandbox, snapshotted before updates. |
| `keepAlive` | boolean | **Trusted.** Suggests the watchdog should relaunch this app when it exits unexpectedly. Right for a daemon, wrong for anything a user closes on purpose. |

Ordering in the list (`order`) and hiding a repository are not manifest fields.
Those are one hub's curation of many apps, not one app's description of itself.

### `artifacts[]`

| Field | Type | Does |
| --- | --- | --- |
| `assetPattern` | glob ≤200, **required** | Matched against the asset's file name (`*`, `?`). First matching entry wins — order specific before general. |
| `label` | string ≤64 | Row label, e.g. `"Desktop app (Linux)"`. Default: the kind's generic label. |
| `platform` | `linux` \| `windows` \| `android` | **Trusted.** Overrides the platform guess. |
| `kind` | see below | **Trusted.** Overrides the engine choice. |
| `postInstallNote` | string ≤600 | Prose shown after install: the one thing still to do. |
| `packageId` | string | **Trusted.** Android application id — reads the installed version off the device and launches it. |
| `binHint` | string | **Trusted.** `archive-dir`: which file in the tree is the executable. |
| `stripPrefix`, `prefix` | strings | **Trusted.** `tarball-prefix`: leading path to strip, and the directory to write into. |
| `addonsDir` | string | **Trusted.** `blender-addon`: which add-ons directory to unpack into. |
| `launchCmd` | string ≤400 | **Trusted.** What Launch runs for a `tarball-prefix` artifact. |
| `args` | array ≤32 of strings | **Trusted.** Default launch arguments. |
| `postInstallCmd` | string ≤600 | **Trusted.** One command offered behind a Run button beside the note. |

`kind` is one of `appimage`, `archive-dir`, `tarball-prefix`, `apk-adb`,
`blender-addon`, `blender-theme`, `windows-portable`, `windows-zip`.
`kind` and `platform` are themselves trusted-only, because `kind` chooses the
install engine — which is the same decision `prefix` makes, one step earlier.
`tarball-prefix`, `blender-addon` and `blender-theme` write outside the install
root and need `prefix`/`stripPrefix` or `addonsDir` on top of that.

So for an untrusted repository these are corrections you cannot reach, which
makes the naming rules in §2 the whole game: **name your assets so the default
classification is already right**, and the same manifest then works for every
user, trusted or not.

### Caps

Manifest ≤32 KB · ≤16 artifacts · ≤16 connector fields · `postInstallNote` ≤600
characters. Longer strings are clipped, unknown keys are dropped, and a manifest
that does not parse is ignored with a single log line — it never breaks
discovery, and it never breaks your listing. It just does nothing.

### A complete example

A release of `seabright/halyard` v1.4.0 containing:

```
Halyard-1.4.0-linux-x86_64.AppImage
Halyard-1.4.0-linux-x86_64.AppImage.sha256
halyard-1.4.0.apk
halyard-1.4.0.apk.sha256
nx-app.json
```

and `nx-app.json` being:

```json
{
  "$schema": "https://raw.githubusercontent.com/nerdrx/nx-hub/main/registry/nx-app.schema.json",
  "nxApp": 1,
  "name": "Halyard",
  "tagline": "Rig telemetry from the boat to the desk and the phone",
  "homepage": "https://github.com/seabright/halyard",
  "artifacts": [
    {
      "assetPattern": "Halyard-*-linux-x86_64.AppImage",
      "label": "Desktop app (Linux)",
      "kind": "appimage",
      "platform": "linux",
      "postInstallNote": "First launch asks for the boat's address on your network. Nothing else to set up."
    },
    {
      "assetPattern": "halyard-*.apk",
      "label": "Phone app",
      "kind": "apk-adb",
      "platform": "android",
      "packageId": "com.seabright.halyard"
    }
  ],
  "connector": {
    "fields": [
      { "key": "speed", "label": "Boat speed", "unit": "kn", "kind": "number" },
      { "key": "linked", "label": "Phone", "kind": "bool" }
    ]
  }
}
```

Every field here is honoured for every user **except one**: `packageId` is
trusted-only. On a hub whose user does not trust `seabright`, the APK still
installs over adb — it simply cannot report the version already on the device or
launch it there. Nothing else in the file changes, and nothing is refused.

## 4. What is honoured from whom

A manifest is data from a repository, not instructions. There are two tiers, and
which one you are in is the hub user's decision, not yours.

**Accepted from any repository** — presentation, escaped like every other
foreign string: `name`, `tagline`, `homepage`, per-artifact `label` and
`postInstallNote`, and `connector.fields`.

**Accepted only from a trusted owner** — everything that executes something or
decides where bytes land: `postInstallCmd`, `launchCmd`, `args`, `sandbox`,
`configPaths`, `prefix`, `stripPrefix`, `addonsDir`, `binHint`, `packageId`,
`keepAlive`, `kind`, `platform`. Trusted means the owner is in the hub's `settings.owners` or in
`settings.trustedManifestOwners` (default empty). From anyone else these fields
are dropped with a log line — never honoured, never partially honoured.

The reason is concrete rather than moral. `postInstallCmd` is the string a Run
button hands to a shell after rewriting `sudo` to `pkexec`, which means a
password prompt on the user's screen with your text behind it.
`prefix`, `addonsDir` and `configPaths` decide which directories outside the
install root get written to, and `launchCmd`/`args` decide what runs when the
user presses Launch. "Show this sentence" and "offer to run this as root" cannot
be the same privilege, so they are not the same field.

**What to do instead.** Put the instruction in `postInstallNote`, as prose, with
the exact command in it:

```json
{
  "assetPattern": "halyard-*-linux-x86_64.tar.gz",
  "label": "Bridge daemon (Linux)",
  "postInstallNote": "The daemon needs a writable /dev/uinput. Run once: sudo setfacl -m u:$USER:rw /dev/uinput"
}
```

The user reads it, copies it, and runs it themselves. That works from any
repository, on any hub, today. If your app ends up trusted later, the same
sentence gains a Run button by adding `postInstallCmd`; nothing else changes.

A note the hub took from an untrusted repository renders with a quiet marker
saying where the sentence came from. That marker is about foreign text, not
about you.

## 5. Where the manifest goes

Two sources, first hit wins:

1. **A release asset named exactly `nx-app.json`** — preferred. It costs the hub
   no extra API call, it travels with the version it describes (an old release
   keeps its old note), and it works for private repositories through the user's
   token. It is classifier-ignored, so it never becomes an installable row.
2. **`nx-app.json` at the root of your default branch** — the fallback, used
   only when the release ships no manifest asset. It is one extra request per
   repository, so a hub that is anonymous or near its rate limit **skips it
   entirely**. Discovery scanning many repositories is exactly the situation
   where per-repository fetches turn a working hub into a throttled one.

Keep the file at your repository root for humans and CI, and upload it as an
asset in every release. `gh` does this in one line:

```bash
gh release create v1.4.0 dist/* nx-app.json --title "v1.4.0" --notes-file CHANGELOG-1.4.0.md
```

## 6. Checking your work

```bash
nx manifest check --file nx-app.json   # exit 0 valid, 1 invalid
nx manifest check --file nx-app.json --json
```

A hub ignores what it cannot use and says nothing about it; the checker is where
a typo, an over-long note or a misspelled key becomes visible. It is a pure
validator — no network, no GitHub — so it belongs in CI, on the same job that
builds your assets, before the release is cut:

```yaml
- run: nx manifest check --file nx-app.json
```

If your repository is already curated in the hub's overlay, `nx manifest init
<app>` prints the manifest equivalent of that entry, so adopting this is a
paste rather than a translation.

## 7. Optional extras

### Signatures

An asset may carry a `<asset>.sig` sibling: an ed25519 signature over the
asset's sha256 digest, hex encoded. The hub checks it after the checksum step,
and a mismatch is a hard failure with no fallback.

Be clear-eyed about what this is worth to a third party today: the hub verifies
a signature only for owners whose **public key is pinned in the hub's own
source**. There is no key exchange, no keyserver and no trust-on-first-use — an
unpinned owner's `.sig` is not a failure, it is simply not checked, and the
asset installs on its checksum alone. Publish signatures if you want them
verifiable by hand; do not treat them as a feature the hub performs for you
until your key is pinned.

### The connector bus

If your app streams live status to the hub, the wire protocol is
[`docs/connector/PROTOCOL.md`](connector/PROTOCOL.md), and JavaScript apps
should just copy [`nx-connector.js`](connector/nx-connector.js) rather than
implement any of it. Two points that connect back to this document:

- the `app` id you send in `hello` must equal the hub's id for your app, which
  is your **repository name, lowercased** — that is what attaches your status
  strip to your card. (A hub that reached your repository through a pinned
  `extraRepos` entry rather than by scanning your whole account keys it
  `<owner>--<name>` so two same-named repositories cannot collide; send the
  plain repository name anyway, and the strip appears wherever your account is
  a scanned source.)
- `connector.fields` in the manifest supplies the label, unit and formatting for
  each key. Anything you send that is not listed still renders, as `key: value`.
  Fields you send as JSON **numbers** keep a ten-minute history and draw a
  cyan sparkline beside the value — so send `72`, never `"72"`, and do not
  change a key's type mid-run.

Presence on the bus also makes your app a valid health gate in a stack, and lets
the hub ask it to exit politely instead of signalling it.

### Post-install notes worth writing

A note is shown to every user, every install. Good ones state a step the app
genuinely cannot take by itself: a capability the binary needs, a service to
restart, a checklist inside the app that must be completed once. Bad ones
restate that the install finished, thank the user, or link to the README. If it
is not an instruction, it is noise on the card — leave it out.

## 8. What the hub will not do for you

- **Build anything.** It downloads what you publish. Compilation, signing and
  packaging are your CI's job.
- **Elevate.** No install runs as root. Everything lands under user-owned
  prefixes, which is why the setcap-shaped requirement is a note and not a step.
- **Invent a release.** No release, or no classifiable asset, means the
  "Unpublished" section — not an error anyone will report to you.
- **Adopt a package format.** There is no manifest of files, no dependency
  solver, no post-install script hook. If your app needs a dependency, say so in
  the tagline or the note.
- **Guarantee your manifest wins.** Precedence is
  **`registry/overrides.json` > your `nx-app.json` > the hub's own defaults.**
  The overlay is a curated file in the nx-hub repository, fetched live, and it
  always wins. That is how an app whose repository nobody controls gets curated
  at all, and how a wrong note gets fixed on every hub at the next refresh
  instead of waiting for that app to cut a release. If the maintainer has
  curated your app there, your manifest refines only what the overlay leaves
  unset — and the right move is to open an issue on
  [nx-hub](https://github.com/nerdrx/nx-hub) so the two agree.
