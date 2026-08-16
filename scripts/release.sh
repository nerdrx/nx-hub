#!/usr/bin/env bash
# Builds NX Hub for Linux + Windows and publishes a GitHub release.
#
#   scripts/release.sh [--skip-win] [--dry-run] [--delta]
#
#   --skip-win   Linux AppImage only (no wine needed).
#   --dry-run    Build and checksum everything, but do not publish to GitHub.
#   --delta      Also emit `<asset>.from-<prevVersion>.zpatch` next to every
#                full asset (zstd --patch-from against the previous release),
#                which the hub downloads instead of the full file. Needs zstd
#                and read-only `gh` access; skips silently when either the tool
#                or the previous asset is missing. Works under --dry-run too
#                (it only READS from GitHub).
#
# The version comes from package.json - bump it there, nowhere else. The tag is
# v<version>, which is what the hub's own self-update discovery looks for.
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_WIN=0
DRY_RUN=0
DELTA=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-win) SKIP_WIN=1; shift ;;
        --dry-run)  DRY_RUN=1; shift ;;
        --delta)    DELTA=1; shift ;;
        -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

# Everything registered here is removed on exit (one trap, many owners).
CLEANUP=()
cleanup() { for p in ${CLEANUP[@]+"${CLEANUP[@]}"}; do rm -rf "$p"; done; }
trap cleanup EXIT

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

# ---------------------------------------------------------------- delta patches

# SPEC v0.6: for every full asset, diff it against the same asset in the
# PREVIOUS release and ship `<asset>.from-<prevVersion>.zpatch` alongside. The
# hub downloads the patch instead of the file when it is updating from exactly
# that version, and verifies the reconstruction against the FULL asset's
# .sha256 - so patches deliberately get no checksum sibling of their own.
PATCHES=()
if [[ $DELTA -eq 1 ]]; then
    echo "==> delta patches (zstd --patch-from)"
    PREV_TAG=""
    if ! command -v zstd >/dev/null 2>&1; then
        echo "    zstd not installed - no patches"
    elif ! command -v gh >/dev/null 2>&1; then
        echo "    gh not installed - no patches"
    else
        PREV_TAG=$(gh release list --repo "$REPO" --limit 10 --exclude-drafts \
            --json tagName --jq '.[0].tagName' 2>/dev/null || true)
        [[ -n "$PREV_TAG" && "$PREV_TAG" != "$TAG" ]] || \
            echo "    no previous release to diff against - no patches"
    fi
    if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$TAG" ]]; then
        PREV_VERSION="${PREV_TAG#v}"
        PREV_DIR=$(mktemp -d /tmp/nx-hub-prev-XXXXXX)
        CLEANUP+=("$PREV_DIR")
        echo "    previous release: $PREV_TAG (version $PREV_VERSION)"
        for a in "${ASSETS[@]}"; do
            base=$(basename "$a")
            # The previous release's counterpart: the same name when asset names
            # are stable, otherwise the same name with the old version in it
            # (ours embed the version: NX-Hub-<version>-linux.AppImage).
            prev_base="$base"
            if ! gh release download "$PREV_TAG" --repo "$REPO" --pattern "$prev_base" \
                    --dir "$PREV_DIR" --clobber >/dev/null 2>&1 || [[ ! -f "$PREV_DIR/$prev_base" ]]; then
                prev_base="${base//$VERSION/$PREV_VERSION}"
                if [[ "$prev_base" == "$base" ]] || \
                   ! gh release download "$PREV_TAG" --repo "$REPO" --pattern "$prev_base" \
                        --dir "$PREV_DIR" --clobber >/dev/null 2>&1 || [[ ! -f "$PREV_DIR/$prev_base" ]]; then
                    echo "    $base: no counterpart in $PREV_TAG - skipped"
                    continue
                fi
            fi
            patch="dist/$base.from-$PREV_VERSION.zpatch"
            if zstd -q -f --patch-from="$PREV_DIR/$prev_base" --long=27 "$a" -o "$patch" 2>/dev/null; then
                PATCHES+=("$patch")
                full_size=$(wc -c < "$a")
                patch_size=$(wc -c < "$patch")
                echo "    $(basename "$patch")  $patch_size B  ($((patch_size * 100 / (full_size > 0 ? full_size : 1)))% of the full asset)"
            else
                echo "    $base: zstd --patch-from failed - skipped"
            fi
            rm -f "$PREV_DIR/$prev_base"
        done
    fi
fi

# ---------------------------------------------------------------- notes

NOTES=$(mktemp /tmp/nx-hub-notes-XXXXXX.md)
CLEANUP+=("$NOTES")
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
    if [[ ${#PATCHES[@]} -gt 0 ]]; then
        echo "The \`.zpatch\` files are delta updates NX Hub uses to update itself"
        echo "with a fraction of the download; they are not meant to be used by hand."
        echo
    fi
    echo "---"
    echo
    echo "If you already run NX Hub, it will offer this build as a self-update."
} > "$NOTES"

if [[ $DRY_RUN -eq 1 ]]; then
    echo "==> dry run complete. Artifacts:"
    for a in "${ASSETS[@]}" "${CHECKSUMS[@]}" ${PATCHES[@]+"${PATCHES[@]}"}; do echo "    $a"; done
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
    "${ASSETS[@]}" "${CHECKSUMS[@]}" ${PATCHES[@]+"${PATCHES[@]}"}

echo "==> published: https://github.com/$REPO/releases/tag/$TAG"
