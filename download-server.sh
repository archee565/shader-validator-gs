#!/usr/bin/env bash
#
# Download the shader language server binaries into bin/.
#
# The language server is a Rust binary maintained in antaalt/shader-sense and is
# not stored in this repository (see .gitignore). This script mirrors what
# .github/workflows/build.yml does in CI:
#
#   bin/win32-x64/    <- shader-language-server-x86_64-pc-windows-msvc.zip
#   bin/win32-arm64/  <- shader-language-server-aarch64-pc-windows-msvc.zip
#   bin/linux-x64/    <- shader-language-server-x86_64-unknown-linux-gnu.zip
#   bin/wasi/         <- shader-language-server-wasm32-wasip1-threads.zip
#
# By default the current host target and the WASI fallback are fetched, which is
# what a native extension build needs. Use --all to mirror a full CI run.

set -euo pipefail

REPO="antaalt/shader-sense"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_JSON="$SCRIPT_DIR/package.json"
OUT_DIR="$SCRIPT_DIR/bin"

# npm target -> rust target (asset name suffix).
declare -A RUST_TARGET=(
    [win32-x64]="x86_64-pc-windows-msvc"
    [win32-arm64]="aarch64-pc-windows-msvc"
    [linux-x64]="x86_64-unknown-linux-gnu"
    [wasi]="wasm32-wasip1-threads"
)
ALL_TARGETS=(win32-x64 win32-arm64 linux-x64 wasi)

VERSION=""
FORCE=0
WANT_ALL=0
WANT_HOST_ONLY=0
SKIP_WASI=0
TARGETS=()
TMP_DIR=""

info() { printf '[download-server] %s\n' "$*"; }
warn() { printf '[download-server] warning: %s\n' "$*" >&2; }
die() {
    printf '[download-server] error: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT

usage() {
    cat <<EOF
Usage: $(basename -- "$0") [options]

Download shader-language-server binaries from github.com/$REPO.

Options:
  -t, --target TARGET  Fetch TARGET; repeatable.
                       One of: ${ALL_TARGETS[*]}
  -a, --all            Fetch every target published by CI.
      --host           Fetch only the current host target (no WASI fallback).
      --no-wasi        Never fetch the WASI fallback.
  -v, --version VER    Server version to fetch (default: "server_version" in
                       package.json). A leading "v" is accepted.
  -o, --output DIR     Output directory (default: <repo>/bin).
  -f, --force          Re-download even when the binary is already present.
  -h, --help           Show this help.

Without arguments the current host target plus the WASI fallback are fetched.
EOF
}

detect_host_target() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os" in
        Linux)
            if [ "$arch" = "x86_64" ]; then
                echo "linux-x64"
            else
                echo "wasi"
            fi
            ;;
        Darwin)
            # No DXC available, always fall back to WASI.
            echo "wasi"
            ;;
        MINGW* | MSYS* | CYGWIN* | Windows_NT)
            case "$arch" in
                x86_64 | amd64) echo "win32-x64" ;;
                aarch64 | arm64) echo "win32-arm64" ;;
                *) echo "wasi" ;;
            esac
            ;;
        *)
            echo "wasi"
            ;;
    esac
}

binary_name() {
    case "$1" in
        wasi) echo "shader-language-server.wasm" ;;
        win32-*) echo "shader-language-server.exe" ;;
        *) echo "shader-language-server" ;;
    esac
}

resolve_version() {
    local version="$VERSION"
    if [ -z "$version" ] && [ -f "$PACKAGE_JSON" ]; then
        if command -v node >/dev/null 2>&1; then
            version="$(node -e '
                const fs = require("fs");
                const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                process.stdout.write(pkg.server_version || "");
            ' "$PACKAGE_JSON" 2>/dev/null || true)"
        fi
        if [ -z "$version" ]; then
            version="$(sed -n 's/^[[:space:]]*"server_version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PACKAGE_JSON" | head -n 1)"
        fi
    fi
    version="${version#v}"
    [ -n "$version" ] || die "unable to determine server version (no --version and no server_version in $PACKAGE_JSON)"
    echo "$version"
}

download() {
    local url="$1"
    local dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --progress-bar --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$dest" "$url"
    else
        die "neither curl nor wget is available"
    fi
}

fetch_target() {
    local target="$1"
    local tag="$2"
    local rust="${RUST_TARGET[$target]:-}"

    [ -n "$rust" ] || die "unknown target '$target' (valid: ${ALL_TARGETS[*]})"

    local asset="shader-language-server-$rust.zip"
    local url="https://github.com/$REPO/releases/download/$tag/$asset"
    local dest="$OUT_DIR/$target"
    local bin="$dest/$(binary_name "$target")"

    if [ -f "$bin" ] && [ "$FORCE" -ne 1 ]; then
        info "$target: $bin already exists, skipping (use --force to re-download)"
        return 0
    fi

    info "$target: downloading $(basename -- "$asset") ($tag)"
    mkdir -p "$dest"
    local zip="$TMP_DIR/$asset"
    download "$url" "$zip"

    unzip -tq "$zip" >/dev/null 2>&1 || die "$url did not return a valid zip archive (check that tag $tag exists)"

    # Archives are flat: extract everything so support DLLs (dxcompiler.dll,
    # dxil.dll) are placed next to the executable on Windows.
    unzip -q -o "$zip" -d "$dest"

    if [ ! -f "$bin" ]; then
        die "$target: expected '$bin' after extracting $asset; archive contents:
$(unzip -l "$zip")"
    fi

    chmod +x "$bin"
    info "$target: installed $bin"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -t | --target)
            [ $# -ge 2 ] || die "$1 requires an argument"
            TARGETS+=("$2")
            shift 2
            ;;
        -a | --all)
            WANT_ALL=1
            shift
            ;;
        --host)
            WANT_HOST_ONLY=1
            shift
            ;;
        --no-wasi)
            SKIP_WASI=1
            shift
            ;;
        -v | --version)
            [ $# -ge 2 ] || die "$1 requires an argument"
            VERSION="$2"
            shift 2
            ;;
        -o | --output)
            [ $# -ge 2 ] || die "$1 requires an argument"
            OUT_DIR="$2"
            shift 2
            ;;
        -f | --force)
            FORCE=1
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown option '$1'"
            ;;
    esac
done

command -v unzip >/dev/null 2>&1 || die "unzip is required but not installed"

[ "$WANT_ALL" -eq 1 ] && [ "$WANT_HOST_ONLY" -eq 1 ] && die "--all and --host are mutually exclusive"

if [ "$WANT_ALL" -eq 1 ]; then
    TARGETS=("${ALL_TARGETS[@]}")
elif [ "${#TARGETS[@]}" -eq 0 ]; then
    TARGETS=("$(detect_host_target)")
    info "host target: ${TARGETS[0]}"
fi

# Bundled native builds always ship the WASI server as a fallback, so fetch it
# unless the user asked otherwise or explicitly listed targets.
if [ "$SKIP_WASI" -eq 0 ] && [ "$WANT_HOST_ONLY" -eq 0 ]; then
    has_wasi=0
    for target in "${TARGETS[@]}"; do
        [ "$target" = "wasi" ] && has_wasi=1
    done
    [ "$has_wasi" -eq 1 ] || TARGETS+=("wasi")
fi

SERVER_VERSION="$(resolve_version)"
TAG="v$SERVER_VERSION"

info "server version: $SERVER_VERSION (tag $TAG)"
info "output directory: $OUT_DIR"

mkdir -p "$OUT_DIR"
TMP_DIR="$(mktemp -d)"

for target in "${TARGETS[@]}"; do
    fetch_target "$target" "$TAG"
done

# CI prints the version of the native binary as a smoke test; do the same when
# the host binary was fetched (the wasm one needs a WASI runtime to execute).
host_target="$(detect_host_target)"
for target in "${TARGETS[@]}"; do
    if [ "$target" = "$host_target" ] && [ "$target" != "wasi" ]; then
        bin="$OUT_DIR/$target/$(binary_name "$target")"
        if [ -x "$bin" ]; then
            info "checking $bin"
            "$bin" --version || warn "$bin --version failed"
        fi
    fi
done

info "done."
