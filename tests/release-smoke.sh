#!/usr/bin/env bash
# Explicit opt-in: download and verify a real panel release without executing it.
set -Eeuo pipefail
[[ "${1:-}" == --run ]] || { echo 'Use --run to enable network download'; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/common.sh"
REPO=zako-li/miaomiaowux ASSET_BASE=mmwx-linux ARCH=amd64
TAG_MATCH='^(mmwx|mmwx-v[0-9A-Za-z._-]+)$'
WANT_TAG=mmwx-v0.5.4 LOCAL_BINARY='' EXPECTED_SHA=''
STAGING="$(mktemp -d /tmp/mmwx-release-check.XXXXXXXX)"
trap 'rm -rf -- "$STAGING"' EXIT
prepare_binary
[[ "$EXPECTED_SHA" == b0cb28538c15b3d33663ac1413e731dbf6cb7d8e9fb8b8dc0f808f0af87430f2 ]]
echo 'Real GitHub API, asset selection, SHA-256 and ELF architecture verification passed'
