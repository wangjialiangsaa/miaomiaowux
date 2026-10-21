# 管理员后台在线更新

登录后进入 **NodeCTL 服务器 → 系统更新 → 检查更新 → 确认更新**。无需打开 GitHub 或登录服务器执行升级命令。更新完成后点击“刷新页面”。关闭弹窗不会中断已提交的任务；网关重建时短暂重连是正常现象。

## 更新范围

当前只更新本仓库的整合网关与注入的管理界面，**不自动更新 MMWX、NodeCTL 引擎、Agent 或更新器本身**。原有节点、登录账户、订阅地址和两个业务数据库保持独立。流量仍通过 WebSocket 接收、每 500 ms 更新显示；更新弹窗每两秒读取本地任务状态，不反复请求 GitHub。

更新器未配置时，弹窗明确显示未启用，普通管理功能不受影响。启用操作需要服务器管理员执行一次；普通用户之后只需使用后台按钮。

## 安全边界

- 使用现有 MMWX 管理员身份；所有变更接口验证同源、JSON 与专用 CSRF 请求头。普通用户、未登录和跨站请求不能升级。
- 网关以非 root 用户运行、根文件系统只读，**不挂载 Docker socket**。
- 独立更新器仅监听组权限 0660 的 Unix socket，不开放 TCP 管理端口。它只执行 root 预设的网关 Compose 服务，不能接受任意仓库、版本下载 URL、路径、镜像名、命令或项目名。
- 更新器持有 Docker socket，因此等同于宿主机 root 控制面。只有信任本项目更新器代码及发布签名管理者时才启用；不要将 socket 目录共享给其他不可信容器，也不要给无关用户加入网关组。
- root 控制配置/Compose/环境文件只读挂载；业务目录只读挂载；状态与备份目录 0700、文件 0600。不在浏览器响应或普通日志中输出私钥、会话、数据库内容及 Docker 环境。
- 更新器仅额外授予 `DAC_READ_SEARCH`，以只读方式备份由其他 UID 所有的私有 MMWX 目录/密钥，不修改其权限或所有者。
- root 固定的发行公钥验证 Ed25519 签名；校验精确清单、SHA-256、大小、架构、版本、标签、来源提交及载入后的不可变镜像身份。不执行远端安装脚本，不允许降级。

## 管理员首次启用

适用于已有 MMWX/NodeCTL 服务、使用 `compose.existing.yml` 的 Linux Docker 主机。下面路径是建议值；**先确认 Compose project 名称、现有容器名称、端口、数据库位置和 UID/GID，不能将另一台主机的示例原样覆盖到线上**。统一三服务部署同样可以用独立网关 Compose 接管，但必须保留原网关 project/service 名及数据挂载。

1. 备份现有网关部署与业务数据；确认根分区至少有发布包六倍大小、数据库两倍大小及额外 512 MiB 空间。Docker 需提供 `docker compose` 子命令。
2. 在所需源码提交上构建可信更新器和一次性引导网关：

```bash
revision=$(git rev-parse HEAD)
docker build -f integration/Dockerfile --build-arg GATEWAY_VERSION=0.0.0 --build-arg GATEWAY_REVISION="$revision" -t mmwx-gateway:bootstrap .
docker build -f updater/Dockerfile -t mmwx-updater:bootstrap .
install -d -m 0700 /opt/mmwx-updater/control /opt/mmwx-updater/state
install -d -o 0 -g 10001 -m 0750 /opt/mmwx-updater/socket
install -m 0600 updater/compose.gateway.yml /opt/mmwx-updater/control/gateway.yml
install -m 0600 updater/config.example.json /opt/mmwx-updater/control/config.json
```

3. 用文本编辑器修改 `control/config.json`：`project` 必须为正在运行的网关的 `com.docker.compose.project`；`gatewayService` 固定为 `gateway`；引擎名称/本地健康地址与 `architecture` 必须匹配实际主机。支持 `amd64`、`arm64`。备份源是在更新器里的 `/data/mmwx`、`/data/nodectl` 路径，而非宿主机路径。
4. 创建 root-only `control/gateway.env`，保留原有变量并设置：

```dotenv
PUBLIC_ORIGIN=https://your-panel.example
MMWX_URL=http://127.0.0.1:12890
NODECTL_URL=http://127.0.0.1:7878
NODECTL_DATA_DIR=/absolute/existing/nodectl-data
UPDATER_SOCKET_DIR=/opt/mmwx-updater/socket
GATEWAY_UID=10001
GATEWAY_GID=10001
PORT=12900
```

5. 用 `docker image inspect --format '{{.Id}}' mmwx-gateway:bootstrap` 得到镜像 ID，保存成 root-only `state/selected.env`，格式 `GATEWAY_IMAGE=sha256:...`。不要使用可变的 `latest` 标签。用原 project 名启动固定网关定义：

```bash
docker compose --project-name YOUR_EXISTING_GATEWAY_PROJECT --env-file /opt/mmwx-updater/control/gateway.env --env-file /opt/mmwx-updater/state/selected.env -f /opt/mmwx-updater/control/gateway.yml up -d --no-deps --no-build --pull never gateway
```

6. 创建 root-only `updater.env`（实际宿主机绝对路径）：

```dotenv
UPDATER_IMAGE=mmwx-updater:bootstrap
UPDATER_CONTROL_DIR=/opt/mmwx-updater/control
UPDATER_STATE_DIR=/opt/mmwx-updater/state
UPDATER_SOCKET_DIR=/opt/mmwx-updater/socket
MMWX_DATA_DIR=/absolute/existing/mmwx-data
NODECTL_DATA_DIR=/absolute/existing/nodectl-data
GATEWAY_GID=10001
```

7. 启动独立更新器：

```bash
docker compose --project-name mmwx-updater --env-file /opt/mmwx-updater/updater.env -f updater/compose.updater.yml up -d --no-build --pull never
```

只替换网关，不要对包含 MMWX/NodeCTL 的老 Compose 执行 `down`。确认 updater ready、原引擎容器启动时间未变、管理员登录和所有原订阅正常。之后后台按钮即可完成更新。首次从 `0.0.0` 引导版升级到正式签名版也走同一流程。

## 发布新版本（项目维护者）

签名公钥在 `updater/release-signing.pub`。对应 Ed25519 私钥仅保存在仓库 Actions secret `GATEWAY_RELEASE_SIGNING_KEY`，禁止提交私钥或添加到镜像上下文。公钥轮换需要管理员审阅并手动更新受限更新器，不能通过普通网关发布偷偷更换。

测试通过后推送稳定标签，例如 `gateway-v1.0.1`。`.github/workflows/gateway-release.yml` 校验源码、构建 amd64/arm64 网关、导出压缩镜像、生成并签名 `manifest.json`，最后发布 `manifest.sig` 与镜像包。公开发布资产无需客户端保存 GitHub token。上游 MMWX 的发布标签与整合网关标签分开；工作流不更改默认 latest release。

维护者可以更改发布说明，后台只以纯文本显示。最多读取最新 100 条 GitHub release 中的稳定网关标签；若仓库长期发布大量其他版本导致网关标签超出窗口，应先发布新的签名网关版本。

## 备份、回退与故障处理

每次替换前保存一致性 SQLite 备份、MMWX master key、固定部署配置、旧版压缩镜像及事务元数据。只保留最近三个事务目录；不清理无关镜像，也不触碰原业务备份。

只有签名/下载/备份完成才允许替换网关。新版启动后核对版本与源提交、两个引擎的可访问性及原容器 ID/启动时间。失败自动按旧镜像 ID 重建网关并验证；**不会用备份覆盖正在运行的业务数据库**。更新器异常重启会处理持久化中断任务，再开放管理 socket。

弹窗报告“需要人工处理”时不再允许升级。管理员应检查 updater 日志与 root-only `state/state.json`，必要时从对应 `state/jobs/<job-id>/previous-image.tar.gz` 使用 `docker image load` 恢复镜像，参考 `transaction.json` 的旧 ID 写回 `state/selected.env`，再用固定 Compose 重建原网关。确认原引擎/订阅/网关都正常后，备份当前状态并由管理员修复事务状态；不要直接删除唯一恢复材料或盲目恢复数据库。

如旧代码需要完整人工回退，保留启用前网关源码/Compose 和旧镜像。禁用更新器可以先停独立 updater，再移除网关的 `UPDATER_SOCKET` 及 socket 挂载；无需停止任何业务引擎。
