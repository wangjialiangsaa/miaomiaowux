# Generated into both entry points; do not source code from the network.
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
value_required() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 缺少参数值"; }
safe_path() {
    [[ "$1" == /* && "$1" != / && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != */../* && "$1" != */.. && "$1" != */./* ]] || die '路径必须是独立的绝对目录，且不含换行或 ..'
}
validate_options() {
    [[ "$(uname -s)" == Linux ]] || die '仅支持 Linux'
    [[ "$EUID" -eq 0 ]] || die '请用 root 或 sudo 运行'
    [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'MMWX_REPO 格式应为 owner/repo'
    [[ "$SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die '服务名只能包含字母、数字、下划线和连字符'
    safe_path "$PREFIX"; safe_path "$UNIT_DIR"
    [[ "$PREFIX" =~ ^/[A-Za-z0-9_./-]+$ ]] || die '--prefix 不支持空格或特殊字符'
    [[ -z "$WANT_TAG" || "$WANT_TAG" =~ $TAG_MATCH ]] || die '--version 与程序类型不匹配'
    [[ -z "$EXPECTED_SHA" || "$EXPECTED_SHA" =~ ^[a-fA-F0-9]{64}$ ]] || die '--sha256 必须是 64 位十六进制'
    EXPECTED_SHA="${EXPECTED_SHA,,}"
    [[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ && ${#HEALTH_TIMEOUT} -le 3 ]] || die '--health-timeout 应为 3–300 秒'
    HEALTH_TIMEOUT=$((10#$HEALTH_TIMEOUT))
    (( HEALTH_TIMEOUT >= 3 && HEALTH_TIMEOUT <= 300 )) || die '--health-timeout 应为 3–300 秒'
    [[ -z "$HEALTH_URL" || "$HEALTH_URL" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/[^[:space:]]*$ ]] || die '--health-url 只允许本机 HTTP 地址'
    [[ -z "${MMWX_GH_PROXY:-}" || "${MMWX_GH_PROXY}" =~ ^https://[^[:space:]\"\\]+$ ]] || die 'MMWX_GH_PROXY 必须是无空白的 HTTPS URL'
    case "$(uname -m)" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) die '只支持 amd64 / arm64';; esac
    for required in python3 sha256sum flock mktemp install; do command -v "$required" >/dev/null || die "请先安装 $required"; done
    if [[ "${ACTION:-}" != uninstall && ( -z "$LOCAL_BINARY" || -n "$HEALTH_URL" ) ]]; then command -v curl >/dev/null || die '请先安装 curl'; fi
    if [[ -n "$LOCAL_BINARY" && -z "$EXPECTED_SHA" ]]; then die '--binary 必须同时提供 --sha256'; fi
}
api_get() {
    # Credentials go to curl through stdin, never to the proxy or log output.
    [[ -z "${MMWX_GH_TOKEN:-}" || "$MMWX_GH_TOKEN" =~ ^[A-Za-z0-9_]+$ ]] || die 'MMWX_GH_TOKEN 格式错误'
    { if [[ -n "${MMWX_GH_TOKEN:-}" ]]; then printf 'header = "Authorization: Bearer %s"\n' "$MMWX_GH_TOKEN"; fi; } |
        curl --config - -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 --retry 2 \
        -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/$1" -o "$2"
}
prepare_binary() {
    if [[ -n "$LOCAL_BINARY" ]]; then
        [[ -f "$LOCAL_BINARY" ]] || die '--binary 文件不存在'
        cp -- "$LOCAL_BINARY" "$STAGING/new-bin"
    else
        local endpoint='releases?per_page=100' selected
        [[ -z "$WANT_TAG" ]] || endpoint="releases/tags/$WANT_TAG"
        api_get "$endpoint" "$STAGING/release.json" || die '读取 GitHub Release 失败；可使用 --binary 和 --sha256 离线安装'
        selected="$(python3 - "$STAGING/release.json" "$ASSET_BASE-$ARCH" "$TAG_MATCH" "$WANT_TAG" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1]))
releases = data if isinstance(data, list) else [data]
for release in releases:
    if release.get('draft') or (release.get('prerelease') and not sys.argv[4]) or not re.fullmatch(sys.argv[3], release.get('tag_name', '')):
        continue
    for asset in release.get('assets', []):
        if asset['name'] == sys.argv[2]:
            print(release['tag_name']); print(asset['browser_download_url']); print(asset.get('digest') or '')
            sys.exit(0)
sys.exit('没有匹配版本和架构的 Release 资产')
PY
)" || die '找不到可用的 Release 资产'
        local tag url digest
        { IFS= read -r tag; IFS= read -r url; IFS= read -r digest || true; } <<< "$selected"
        [[ "$url" == "https://github.com/$REPO/releases/download/"* ]] || die 'Release 下载地址不匹配'
        if [[ "$digest" =~ ^sha256:([a-f0-9]{64})$ ]]; then
            [[ -z "$EXPECTED_SHA" || "$EXPECTED_SHA" == "${BASH_REMATCH[1]}" ]] || die '--sha256 与 GitHub Release 摘要不一致'
            EXPECTED_SHA="${digest#sha256:}"
        fi
        [[ -n "$EXPECTED_SHA" ]] || die 'Release 未提供 SHA-256，请显式提供 --sha256'
        [[ -z "${MMWX_GH_PROXY:-}" ]] || url="${MMWX_GH_PROXY%/}/$url"
        info "下载 $tag / $ARCH，并校验 SHA-256"
        curl -fL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --retry 2 --retry-max-time 600 \
            -o "$STAGING/new-bin" "$url" || die '下载失败'
    fi
    [[ "$(sha256sum "$STAGING/new-bin" | cut -d ' ' -f1)" == "$EXPECTED_SHA" ]] || die 'SHA-256 校验失败，服务未改动'
    python3 - "$STAGING/new-bin" "$ARCH" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as f:
    h = f.read(64)
if len(h) < 64 or h[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', h, 16)[0] not in (2, 3) or struct.unpack_from('<H', h, 18)[0] != {'amd64': 62, 'arm64': 183}[sys.argv[2]]:
    sys.exit('不是匹配当前架构的 64 位 Linux ELF 可执行文件')
PY
    chmod 0755 "$STAGING/new-bin"
}
svc() {
    if [[ "$INIT" == systemd ]]; then systemctl "$1" "$SERVICE" 9>&-;
    else rc-service "$SERVICE" "$1" 9>&-; fi
}
active() { if [[ "$INIT" == systemd ]]; then systemctl is-active --quiet "$SERVICE"; else rc-service "$SERVICE" status >/dev/null 2>&1; fi; }
initial_state() {
    WAS_RUNNING=0
    if [[ "$INIT" == systemd ]]; then
        local state
        state="$(systemctl show "$SERVICE" --property=ActiveState --value)" || die '无法确定服务状态，未替换程序'
        case "$state" in active) WAS_RUNNING=1;; inactive|failed) :;; *) die '服务状态未稳定，未替换程序，请稍后重试';; esac
    else
        local status=0
        rc-service "$SERVICE" status >/dev/null 2>&1 || status=$?
        case "$status" in 0) WAS_RUNNING=1;; 3) :;; *) die '无法确定 OpenRC 服务状态，未替换程序';; esac
    fi
}
lock_update() {
    mkdir -p -- "$(dirname "$BIN_PATH")"
    # Validate trusted directories before root opens the lock or replaces files.
    python3 - "$(dirname "$BIN_PATH")" "$UNIT_DIR" <<'PY'
import os, pathlib, stat, sys
for path in sys.argv[1:]:
    p = pathlib.Path(path)
    for current in [p, *p.parents]:
        if not current.exists():
            continue
        s = current.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or (s.st_mode & 0o022 and not (s.st_mode & stat.S_ISVTX and current != p)):
            sys.exit('安装目录必须由 root 所有，不能是符号链接或允许其他用户写入')
PY
    [[ ! -L "$BIN_PATH" && ! -d "$BIN_PATH" && ! -L "$BIN_PATH.update.lock" && ! -d "$BIN_PATH.update.lock" ]] || die '程序或锁文件类型异常'
    [[ ! -L "$BIN_PATH.previous" && ( ! -e "$BIN_PATH.previous" || -f "$BIN_PATH.previous" ) ]] || die '.previous 必须是普通文件'
    exec 9>>"$BIN_PATH.update.lock"
    flock -n 9 || die '另一个安装或升级任务正在运行'
}
healthy() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT)) stable=0
    while (( SECONDS < deadline )); do
        if active && { [[ -z "$HEALTH_URL" ]] || curl -fsS --noproxy '*' --connect-timeout 1 --max-time 2 "$HEALTH_URL" -o /dev/null; }; then
            stable=$((stable + 1)); (( stable < 3 )) || return 0
        else stable=0; fi
        sleep 1
    done
    return 1
}
cleanup() {
    local status=$? recovered=1 binary_restored=1
    trap - EXIT INT TERM
    set +e
    if (( status != 0 && TRANSACTION )); then
        warn '操作失败，恢复旧程序与原服务状态'
        if (( REPLACED )); then
            if svc stop; then
                if (( HAD_BINARY )); then
                    install -m 0755 "$STAGING/old-bin" "$STAGING/restore-bin" && mv -fT "$STAGING/restore-bin" "$BIN_PATH" || { recovered=0; binary_restored=0; }
                else rm -f -- "$BIN_PATH" || { recovered=0; binary_restored=0; }; fi
            else recovered=0; binary_restored=0; fi
        fi
        if (( CREATED_UNIT )); then
            systemctl disable "$SERVICE" >/dev/null 2>&1 || recovered=0
            rm -f -- "$UNIT_PATH" || recovered=0
            systemctl daemon-reload || recovered=0
        fi
        if (( WAS_RUNNING && binary_restored )); then svc start && active || recovered=0; fi
        if (( recovered )); then warn '已恢复旧程序与原服务状态；数据目录保留';
        else warn "自动恢复未完成，备份保留在 $STAGING，请手动检查 $SERVICE"; fi
    fi
    if (( recovered )) && [[ -n "${STAGING:-}" ]]; then rm -rf -- "$STAGING"; fi
    exit "$status"
}
begin_update() {
    lock_update
    STAGING="$(mktemp -d "$(dirname "$BIN_PATH")/.${SERVICE}-update.XXXXXXXX")"
    TRANSACTION=0 REPLACED=0 CREATED_UNIT=0 HAD_BINARY=0 WAS_RUNNING=0
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    prepare_binary
    if [[ -f "$BIN_PATH" ]]; then cp -p -- "$BIN_PATH" "$STAGING/old-bin"; HAD_BINARY=1; fi
    initial_state
    TRANSACTION=1
    if (( WAS_RUNNING )); then svc stop; fi
    REPLACED=1
    install -m 0755 "$STAGING/new-bin" "$STAGING/ready-bin"
    mv -fT -- "$STAGING/ready-bin" "$BIN_PATH"
}
finish_update() {
    if (( WAS_RUNNING || CREATED_UNIT )); then
        svc start
        healthy || die '启动或健康检查失败'
    else info '原服务处于停止状态，升级后保持停止'; fi
    if (( CREATED_UNIT )); then systemctl enable "$SERVICE"; fi
    if (( HAD_BINARY )); then
        install -m 0755 "$STAGING/old-bin" "$STAGING/previous-bin"
        mv -fT -- "$STAGING/previous-bin" "$BIN_PATH.previous"
    fi
    TRANSACTION=0
    info "完成：$BIN_PATH；服务 $SERVICE；上个版本保留为 .previous（如有）"
}
