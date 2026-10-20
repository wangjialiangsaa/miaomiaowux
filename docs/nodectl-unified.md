# NodeCTL 统一后台

## 整合范围

统一页面、管理入口和登录授权，不合并数据库。网关把管理组件放入妙妙屋X原导航及主内容区，没有 iframe 或第二个 NodeCTL 登录页。妙妙屋X继续负责节点与订阅分发。

入口兼容顶部导航和侧栏布局。桌面顶部显示“NodeCTL 服务器”，手机顶部显示带同名提示和无障碍标签的图标；登录后也可直接访问 `/#nodectl`。没有导航容器时，直接入口仍可挂载到原主内容区。

每次管理请求都用原登录调用 `/api/user/profile`，只接受 `role=admin` 且 `is_admin=true`。网关只读 NodeCTL SQLite 中的当前签名密钥，使用一分钟、仅服务端可见的 JWT 调用白名单接口，不复制 NodeCTL 密码。普通订阅用户不能访问。退出登录后不另留管理会话。

服务端新增、更新、删除均通过 NodeCTL 原接口执行。修改基本信息时保留原协议、端口、流量、重置规则和隧道字段。危险操作须确认；命令提交成功不等于离线 Agent 已经执行。

基本信息编辑限名称、节点分组、地址模式和订阅可见性。原备注只读显示，不提供当前已核验上游接口不保存的备注修改，避免出现虚假的保存成功。

## 流量面板

白底卡片显示上传、下载、总量汇总；服务器按用量排序，配国旗、在线状态、绿蓝比例条、下载 / 上传比及当前速率。默认“累计”沿用 NodeCTL 当前计费 / 重置周期的计数，不假装是当日流量。选择日期后通过官方 `/api/traffic/consumption-rank` 查询真实历史记录；历史用量与累计计数分开，不把当前总量冒充过去某日的数据。字节使用 1024 进制并明确标注 KiB / MiB / GiB / TiB。

当前 JP / US / LV 地区使用本地 SVG 国旗，不依赖系统 Emoji 字体或第三方图片站；其他有效地区代码显示 ISO 缩写，未知地区不猜测国旗。

页面每 **500 毫秒**把最近收到的数据更新到已有行，不反复重建卡片或把整个管理接口提高到每秒两次请求。实时数据复用官方 `/api/traffic/live` WebSocket；上传对应服务器 TX、下载对应 RX。实际数据精度仍取决于 Agent 上报，断线、离线或超过 15 秒未上报时不显示伪造速率。服务器元数据及当前所选日期的历史记录每 15 秒复核，慢请求不会堆叠；历史统计本身受上游持久化频率限制。

实时入口与历史接口沿用妙妙屋X管理员认证；WebSocket 还校验精确同源 Origin，NodeCTL JWT 只留在服务端请求头，连接最多 55 秒后重新验证原会话。页面隐藏、退出该工作区或注销时关闭实时连接和显示定时器；恢复显示后重新连接，失败使用最多 15 秒的退避重连，不改 Agent 安装或节点协议。

## 已有安装：仅挂接网关

要求 Linux、Docker Compose V2、现有两个服务，以及可只读访问的 NodeCTL SQLite 目录。不要对现有业务运行后面的全新安装流程。

在仓库根目录创建仅本机保存的 `.env`，设置权限 `600`，示例不包含实际凭据：

```dotenv
PUBLIC_ORIGIN=https://panel.example.com
MMWX_URL=http://127.0.0.1:12890
NODECTL_URL=http://127.0.0.1:7878
NODECTL_DATA_DIR=/opt/nodectl/data
GATEWAY_UID=10001
GATEWAY_GID=10001
```

`PUBLIC_ORIGIN` 是实际 HTTPS origin，不能带路径或尾部斜杠，HTTP 只允许 localhost 开发。目录必须存在；Compose 不创建空目录冒充原数据。按现有访问权限配置 UID/GID 或专用只读组，不要 `chmod 777` 或重置业务目录所有权。挂载完整目录，包括可能的 WAL/SHM，不应仅挂单个 `.db`。

```bash
docker compose -f compose.existing.yml config --quiet
docker compose -f compose.existing.yml up -d --build
curl --fail http://127.0.0.1:12900/_nodectl/health
```

只新增监听 `127.0.0.1:12900` 的网关，不修改、停止或重启已有引擎。健康接口只证明网关进程存活；数据库权限、上游与登录还须实际验收。

确认后只替换原 Caddy 站点的 upstream，示例：

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:12900
}
```

不要用示例覆盖已有整段站点。保留短链接重写和其他路由，先 `caddy validate` 再 reload。旧 NodeCTL 域名、Agent 回报地址与端口不动，不自动修改 DNS、防火墙或 SSH。

## 全新安装

仅用于空环境，会新建数据卷，不自动迁入旧数据。`.env` 至少设置 `PUBLIC_ORIGIN=https://panel.example.com`：

```bash
docker compose -f compose.unified.yml config --quiet
docker compose -f compose.unified.yml up -d --build
```

配置 HTTPS 反向代理至 `127.0.0.1:12900`，首次注册并登录妙妙屋X管理员，从原导航进入“NodeCTL 服务器”。后端不直接发布管理端口。初始化未完成或数据权限不足时接口返回 503，不绕过认证。

MMWX 镜像固定 `mmwx-v0.5.4`，按 amd64 / arm64 校验上游公开 SHA-256 和 ELF 魔数，不运行上游一键安装器。内置在线更新关闭，升级须重新验证集成。`NODECTL_IMAGE` 可固定已验证版本或 digest；默认上游 `latest` 不保证未来版本兼容。

网关透传四个 NodeCTL Agent 公开入口：`/api/public/new-install-script`、`/api/public/download/agent`、`/api/agent/init-config`、`/api/callback/traffic/ws`。安装 ID、上报和 WebSocket 验证仍由 NodeCTL 负责，公开请求不会被签管理员 JWT。安装命令优先使用 NodeCTL 原 `panel_url`。

## 节点导入与订阅

只导出未屏蔽服务器的已启用、未被脱敏链接。“导入到妙妙屋X”显式确认后，使用原加密客户端解析，完整解析后再新增，并按 `raw_url` 跳过已有及重复链接。原节点 ID、名称、标签、用户和订阅令牌不变。新节点仍通过原节点 / 订阅页面分发，不自动改动订阅文件选中的节点集合。

这是**新增缺失节点**，不是双向自动同步。重置协议后原导入记录不自动覆盖或删除。不支持的解析阻止本次写入；若保存响应不完整或提交后连接中断，先刷新核对再重试，不可假定没有写入。

原生导入 API 仅按 0.5.4 核验。初版不含 NodeCTL PostgreSQL、系统设置、Cloudflare 密钥管理、日志及远程 Agent 自动升级；这些仍可在原面板处理，不能描述为两套产品全部功能源码合并。

## 测试

Node.js 22.13+，建议 24 LTS：

```bash
node --test tests/integration.test.mjs tests/traffic.test.mjs
node scripts/build.mjs --check
bash -n install.sh upgrade-agent.sh
python3 -m unittest discover -s tests -v
```

安装 Playwright 和 Chromium 后可运行 `node tests/browser-unified.mjs`，或用 `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_EXECUTABLE` 指定已有工具。浏览器测试仅启动本机临时 fixture，检查一次登录、真实 DOM、字段保留、协议操作、导入去重、原页面恢复、注销与移动布局。fixture 不是完整上游二进制或实际 Agent，不等同生产端到端、负载或代理流量验收。日志截图在忽略目录 `.artifacts/`。

## 验收与回退

上线前备份原配置和两套一致性数据库；妙妙屋X备份包括主密钥。验收原账号、原节点数、订阅内容、短链接，确认统一页有原 NodeCTL 记录、普通用户被拒绝、注销后管理不可用、旧 Agent 继续回报。

回退将 Caddy upstream 恢复到原妙妙屋X端口，验证 reload 后停止 gateway，无需逆向迁移数据库。但是用户发起的删除、协议重置或节点导入是真实操作，不会因停止网关而撤销。

发布本仓库不会自动部署或切换生产。

## 验证记录（2026-10-20）

- Node.js 22.23.2 接口和流量模型测试 28/28 通过，包括会话撤销、跨站写入拒绝、字段保留、订阅字节保真、固定代理目标、历史日期校验、实时连接授权与速率方向。
- Chromium fixture 的 25 项浏览器检查通过，覆盖登录、侧栏、桌面 / 手机顶部导航、节点操作、增量导入、流量汇总、半秒实时显示、稳定 DOM、真实按日查询、隐藏页面暂停、注销关闭连接及本地 SVG 国旗；不展示不受上游支持的备注编辑。
- 两个 Compose 文件均通过 Compose v5.6.0 配置校验；生成文件一致性、Shell / JavaScript 语法和 Git 空白检查通过。
- 本地环境没有 Python 与 Docker 引擎，原 Python 安装器测试未运行。镜像构建和线上入口须在实际部署环境另行验收，不能用 fixture 结果替代；这些测试不执行真实 Agent 安装、协议调整或节点写入。
