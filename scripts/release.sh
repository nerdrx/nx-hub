#!/usr/bin/env bash
# Builds NX Hub for Linux + Windows and publishes a GitHub release.
#
#   scripts/release.sh [--skip-win] [--dry-run]
#
#   --skip-win   Linux AppImage only (no wine needed).
#   --dry-run    Build and checksum everything, but do not touch GitHub.
#
# The version comes from package.json - bump it there, nowhere else. The tag is
# v<version>, which is what the hub's own self-update discovery looks for.
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_WIN=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-win) SKIP_WIN=1; shift ;;
        --dry-run)  DRY_RUN=1; shift ;;
        -h|--help)  sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

REPO=nerdrx/nx-hub
VERSION=$(node -p "require('./package.json').version")
[[ -n "$VERSION" ]] || { echo "could not read version from package.json"; exit 1; }
TAG="v$VERSION"

LINUX_ASSET="NX-Hub-$VERSION-linux.AppImage"
WIN_ASSET="NX-Hub-$VERSION-windows-portable.exe"

echo "==> NX Hub $VERSION  (tag $TAG, repo $REPO)"
[[ $DRY_RUN -eq 1 ]] && echo "==> dry run: building only, GitHub untouched"

if [[ $DRY_RUN -eq 0 ]]; then
    command -v gh >/dev/null || { echo "gh CLI not installed"; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "gh not authenticated - run 'gh auth login'"; exit 1; }
    if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
        echo "release $TAG already exists on $REPO - bump the version in package.json"
        exit 1
    fi
fi

# ---------------------------------------------------------------- build

echo "==> building Linux AppImage"
npm run dist:linux
[[ -f "dist/$LINUX_ASSET" ]] || { echo "expected dist/$LINUX_ASSET, not found"; exit 1; }

ASSETS=("dist/$LINUX_ASSET")

if [[ $SKIP_WIN -eq 0 ]]; then
    # electron-builder drives wine to stamp the portable exe. On a fresh prefix
    # a crash dialog would block the build forever waiting for a click, so make
    # sure it is disabled. Best-effort and silent: already-configured prefixes
    # and wine-less machines both just fall through.
    if command -v wine >/dev/null 2>&1; then
        wine reg add 'HKCU\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f \
            >/dev/null 2>&1 || true
    fi

    echo "==> building Windows portable exe"
    npm run dist:win
    [[ -f "dist/$WIN_ASSET" ]] || { echo "expected dist/$WIN_ASSET, not found"; exit 1; }
    ASSETS+=("dist/$WIN_ASSET")
else
    echo "==> skipping Windows build (--skip-win)"
fi

# ---------------------------------------------------------------- checksums

echo "==> writing checksums"
CHECKSUMS=()
for a in "${ASSETS[@]}"; do
    base=$(basename "$a")
    # run inside dist/ so the .sha256 holds a bare filename and `sha256sum -c`
    # works from wherever the user downloaded the pair to
    ( cd dist && sha256sum "$base" > "$base.sha256" )
    CHECKSUMS+=("dist/$base.sha256")
    echo "    $base.sha256  $(cut -d' ' -f1 < "dist/$base.sha256")"
done

# ---------------------------------------------------------------- notes

NOTES=$(mktemp /tmp/nx-hub-notes-XXXXXX.md)
trap 'rm -f "$NOTES"' EXIT
{
    echo "NX Hub $VERSION - installer, updater and launcher for the NX app family."
    echo
    echo "### Downloads"
    echo
    echo "| Platform | File |"
    echo "| --- | --- |"
    echo "| Linux | \`$LINUX_ASSET\` |"
    [[ $SKIP_WIN -eq 0 ]] && echo "| Windows | \`$WIN_ASSET\` |"
    echo
    echo "The AppImage runs with or without FUSE. Mark it executable and run it:"
    echo
    echo '```'
    echo "chmod +x $LINUX_ASSET"
    echo "./$LINUX_ASSET"
    echo '```'
    echo
    echo "### Verify"
    echo
    echo "Each download has a \`.sha256\` sibling:"
    echo
    echo '```'
    echo "sha256sum -c $LINUX_ASSET.sha256"
    echo '```'
    echo
    echo "---"
    echo
    echo "If you already run NX Hub, it will offer this build as a self-update."
} > "$NOTES"

if [[ $DRY_RUN -eq 1 ]]; then
    echo "==> dry run complete. Artifacts:"
    for a in "${ASSETS[@]}" "${CHECKSUMS[@]}"; do echo "    $a"; done
    echo "==> release notes preview:"
    sed 's/^/    /' "$NOTES"
    exit 0
fi

# ---------------------------------------------------------------- publish

echo "==> creating GitHub release $TAG"
gh release create "$TAG" \
    --repo "$REPO" \
    --title "NX Hub $VERSION" \
    --notes-file "$NOTES" \
    "${ASSETS[@]}" "${CHECKSUMS[@]}"

echo "==> published: https://github.com/$REPO/releases/tag/$TAG"
