#!/usr/bin/env bash
# Explicit opt-in: creates and removes only mmwx-review-fixture.service.
set -Eeuo pipefail
[[ "$EUID" == 0 && "${1:-}" == --run ]] || { echo 'Run as root with --run on a test server'; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="$(mktemp -d /opt/mmwx-systemd-check.XXXXXXXX)"
unit=/etc/systemd/system/mmwx-review-fixture.service
[[ ! -e "$unit" && "$(systemctl show mmwx-review-fixture --property=LoadState --value)" == not-found ]] || exit 1
cleanup() {
    systemctl stop mmwx-review-fixture || true
    rm -f -- "$unit"
    systemctl daemon-reload
    printf 'Systemd fixture artifacts retained: %s\n' "$prefix"
}
trap cleanup EXIT
mkdir -p "$prefix/bin" "$prefix/data"
cp /bin/sleep "$prefix/bin/mmwx"
cat > "$unit" <<EOF
[Unit]
Description=Temporary installer rollback fixture
[Service]
ExecStart=$prefix/bin/mmwx 300
EOF
systemctl daemon-reload
systemctl start mmwx-review-fixture
old_hash="$(sha256sum /bin/sleep | cut -d ' ' -f1)"
bad_hash="$(sha256sum /bin/false | cut -d ' ' -f1)"
printf 'keep-me\n' > "$prefix/data/sentinel"
bash "$root/install.sh" update --prefix "$prefix" --service mmwx-review-fixture --binary /bin/sleep --sha256 "$old_hash" --health-timeout 5
systemctl is-active --quiet mmwx-review-fixture
if bash "$root/install.sh" update --prefix "$prefix" --service mmwx-review-fixture --binary /bin/false --sha256 "$bad_hash" --health-timeout 3; then
    echo 'Broken candidate unexpectedly succeeded' >&2; exit 1
fi
[[ "$(sha256sum "$prefix/bin/mmwx" | cut -d ' ' -f1)" == "$old_hash" ]]
systemctl is-active --quiet mmwx-review-fixture
systemctl stop mmwx-review-fixture
bash "$root/install.sh" update --prefix "$prefix" --service mmwx-review-fixture --binary /bin/sleep --sha256 "$old_hash" --health-timeout 5
[[ "$(systemctl show mmwx-review-fixture --property=ActiveState --value)" == inactive ]]
[[ "$(cat "$prefix/data/sentinel")" == keep-me ]]
echo 'Real systemd: successful update, startup-failure rollback, stopped-state preservation and data preservation passed'
