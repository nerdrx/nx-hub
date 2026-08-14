<div align="center">

<img src="assets/icon.png" width="140" alt="NX Hub">

# NX Hub

**Installer, updater and launcher for the NX app family — auto-discovers your GitHub releases.**

</div>

---

Shipping software to yourself is its own chore. Every app lives in a different
repo, every release page has a different set of files, and half of them need a
different ritual to install — extract this, `chmod +x` that, sideload the other
onto a headset. NX Hub collapses all of it into one window: point it at a GitHub
account and every app you publish shows up, installs with one click, and tells
you when it is out of date.

Nothing is hardcoded. Publish a new release and the hub offers the update on its
next check — no registry edit, no new hub build.

## Features

- **Auto-discovery.** Scans whole GitHub accounts (`owners`) plus hand-pinned
  `owner/repo` entries. With a token it sees your private repos too, so
  unreleased work shows up alongside everything else.
- **An install engine per artifact type.** The hub reads a release's assets and
  picks the right strategy:
  - `.AppImage` — extracted at install time, so it runs **with or without FUSE**
  - tarball → prefix — unpacked into `~/.local` and friends, every written file
    recorded for an exact uninstall
  - `.apk` — sideloaded to a connected headset or phone over adb
  - Blender add-ons — dropped straight into your add-ons directory
  - Windows `.exe` / `.zip` — portable installs with Start-menu shortcuts
- **Exact uninstalls.** Every install writes a manifest listing the version and
  any file placed outside its own directory, so removal is precise rather than
  best-effort.
- **Launcher mode.** The hub is also the daily launcher. Installed cards get a
  **Launch** button, and the tray menu starts anything you have installed
  without opening the window.
- **Self-update.** NX Hub is just another app in its own list, and updates
  itself the same way it updates everything else.
- **Android companion app.** Installs on the headset or phone directly, for
  on-device installs when no PC is in reach.

## Screenshots

<p align="center">
  <img src="docs/screenshots/hub.png" width="80%" alt="NX Hub on the desktop">
  <br><em>The hub — every app, its state, and one button that does the right thing.</em>
</p>

<p align="center">
  <img src="docs/screenshots/android.png" width="45%" alt="NX Hub Android companion">
  <br><em>The Android companion, for installing on-device.</em>
</p>

## Install

Grab the latest build from [**Releases**](https://github.com/nerdrx/nx-hub/releases):

```bash
chmod +x NX-Hub-*-linux.AppImage
./NX-Hub-*-linux.AppImage
```

Windows users want the portable `.exe` from the same page. For the headset or
phone, install the Android APK — the hub can also push it there for you once a
device is connected.

Every download ships a `.sha256` sibling:

```bash
sha256sum -c NX-Hub-*-linux.AppImage.sha256
```

## Configuration

Open **Settings → Sources** and add the accounts and repos you want scanned:

| Setting | Meaning |
| --- | --- |
| `owners` | GitHub accounts whose repos are all scanned. Default `["nerdrx"]`. |
| `extraRepos` | Hand-pinned `owner/repo` entries — any repo from anyone. |

Private repos need a token. The hub picks one up automatically if you are
logged in with the [`gh` CLI](https://cli.github.com/); otherwise paste a
personal access token with `repo` scope into Settings. Without a token the hub
still works, just public repos only.

## The overlay

Discovery is the engine; the overlay is the trim. `registry/overrides.json`
polishes the raw output — display names, taglines, ordering, install strategies
for artifacts that need a hint, and a `hidden` list for noise repos:

```jsonc
{
  "hidden": ["some-scratch-repo"],
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

Anything the overlay does not mention still appears, just under its raw repo
name. It is fetched live from this repo's `main` branch so curation ships
without a new hub build, with the bundled copy as fallback.

> The overlay may name private repositories — that is intended and harmless, it
> is only a label. **No secrets or tokens ever belong in the overlay**; it is a
> public file.

## Development

```bash
npm install

npm start          # run the hub
npm test           # unit tests (node --test, no network, temp dirs)
npm run e2e        # end-to-end against a mock GitHub API
npm run dist:linux # AppImage     -> dist/
npm run dist:win   # portable exe -> dist/  (uses wine)
```

GUI checks run inside a headless gamescope compositor, never on your desktop:

```bash
scripts/headless_test.sh -o /tmp/hub.png
```

Releases are one command — bump `version` in `package.json`, then:

```bash
scripts/release.sh              # build both platforms, publish to GitHub
scripts/release.sh --dry-run    # build and checksum only, GitHub untouched
```

[**SPEC.md**](SPEC.md) is the frozen contract: the app model, the IPC surface,
the install-kind semantics and the branding all live there. Read it before
changing anything.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

made with Claude

</div>
