# 妙妙屋X 开心版

去掉授权校验的妙妙屋X，**全功能免费**，套餐显示「妙妙屋开心版」。

TG 频道：<https://t.me/fuck_miaomiaowux>

> 本仓库维护安装与升级脚本，不包含面板 / Agent 业务源码。二进制默认取自 [上游 Releases](https://github.com/zako-li/miaomiaowux/releases)，不使用本仓库的空 Releases 页面。脚本修改不改变上游二进制内部行为。

本版先校验 SHA-256 和 ELF 架构，再备份、停止服务、替换并检查启动状态；失败或收到 Ctrl+C / SIGTERM 时恢复旧程序与原运行状态。原来停止的服务升级后保持停止。成功升级保留一个 `.previous` 程序备份。数据库升级是否兼容仍由上游程序决定，程序回滚不能代替数据备份。

依赖 Linux、Bash、Python 3、curl、coreutils、flock。面板需要 systemd；Agent 升级支持 systemd / OpenRC。有 systemd 的机器查询失败时会中止，不会误切其他服务管理器。

---

## 安装面板

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/install.sh | sudo bash
```

### ‼️ 装完先看这里：必须用 HTTPS 或 localhost 访问

面板的 API 走加密通道，依赖浏览器的 **WebCrypto**，而浏览器**只在 HTTPS 或 localhost 下**才提供它。

所以直接开 `http://你的IP:12889` 或 `http://你的域名:12889` 会出现：

> **明明是全新安装，打开却是「登录」界面，不是注册界面**；输入什么都登不进去。

这不是装坏了 —— 是浏览器把 `crypto.subtle` 禁掉了，前端所有请求失败后 fallback 成了登录框。

**两个办法，选一个：**

**① 先用 SSH 隧道进去建号（最快，什么都不用配）**

在你自己电脑上开个终端：

```bash
ssh -L 12889:127.0.0.1:12889 root@你的服务器
```

窗口别关，本地浏览器打开 **`http://127.0.0.1:12889/login`** —— localhost 是浏览器特例，
算安全上下文，能正常注册和登录。

**② 套 HTTPS（长期用这个）**

有域名的话，用 Caddy 最省事（自动申请证书，需要 80/443 端口没被占）：

```bash
apt install -y caddy
```

`/etc/caddy/Caddyfile`：

```
你的域名 {
    reverse_proxy 127.0.0.1:12889
}
```

```bash
systemctl restart caddy
```

之后访问 `https://你的域名/login` 即可。
（面板自带证书管理，但要先能登录进去才能配，所以第一次还是得靠上面两个办法之一。）

---

### 访问地址

**`https://你的域名/login`**（或隧道下的 `http://127.0.0.1:12889/login`）

- **第一次打开是注册页** —— 显示「这是首次启动，请创建管理员账号」，
  填好用户名密码点「创建管理员账号」就行，**首个注册的用户自动成为管理员**。
- 以后同一个地址就是登录页。

> ⚠️ **地址一定要带 `/login`。**
> 根路径 `/` 是「探针伪装页」（对外伪装用的，默认没开），
> **不管有没有初始化过**，只要没登录，直接开 `/` 都只会看到一句
> **「探针暂时无法访问」** —— 这不是装坏了，面板一直在 `/login`。
> 想让 `/` 也有内容，登录后去 系统设置 → 探针 里把探针打开。

**换端口 / 数据目录**（只在首次安装时生效）：

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/install.sh | sudo bash -s -- --port 8080 --data-dir /opt/mmwx/data
```

**国内网络**连不上 GitHub，加个加速前缀：

```bash
export MMWX_GH_PROXY=https://你的加速前缀/
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/install.sh | sudo -E bash
```

## 更新面板

**推荐：直接在面板里点。** 系统设置 → 检查更新 → 立即更新，会自己下载新版本、替换、重启，带进度条。

命令行更新（面板打不开时用）：

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/install.sh | sudo bash -s update
```

命令行脚本保留已有 systemd 配置与数据目录，启动或健康检查失败会恢复旧程序。面板内置更新器来自上游二进制，不受本仓库脚本修改影响。升级前请备份数据库和配置，尤其是可能包含数据迁移的版本。

离线安装要求同时提供可信的 SHA-256：

```bash
bash install.sh update --binary /path/to/mmwx --sha256 <64位摘要>
```

在线下载使用 GitHub Release 资产的 `digest`；缺少摘要时要求显式传入 `--sha256`。`MMWX_REPO` 只修改二进制发布源，当前默认 `zako-li/miaomiaowux`。在自己的仓库上传对应资产之前，不要把它改为 `wangjialiangsaa/miaomiaowux`。

## 隐藏标牌与欢迎弹窗

登录后打开「系统设置」中的「自定义 CSS」，将 [ui/minimal.css](ui/minimal.css) 的内容追加到已有样式并保存。它只隐藏「妙妙屋开心版」标牌和欢迎推广弹窗；登录页也会随服务器响应收到样式，换浏览器或重新登录后仍然生效。已有配色、字体等样式可保留。

这项设置使用面板原生自定义 CSS 能力，取决于所用二进制是否支持并启用该功能。`MMWX_DISABLE_CUSTOM_CSS=1` 会停用注入。已在上游 `mmwx-v0.5.4` 测试实例验证；安装、升级脚本不会自动修改已有面板设置，也没有修改面板授权逻辑或二进制。上游改动 CSS 类名后需要重新核验。

测试环境可运行 `scripts/customize-preview.mjs --apply` 保存同一段样式并进行浏览器检查；再次运行不带 `--apply` 时只验证。该辅助脚本要求 `playwright-core`、`/usr/bin/chromium`，以及 `MMWX_QA_DIR`（默认 `/out`）下已有的 `preview-credentials.json`，其中包含 `username` 和 `password`；不会创建或重置账号。它仅更新自己标记的 CSS 块，首次变更前在该私有目录备份旧 CSS。不要提交凭据、备份及截图。测试地址由 `MMWX_PREVIEW_URL` 指定，默认容器内 `http://127.0.0.1:12889`；使用 HTTPS 或 localhost。

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/install.sh | sudo bash -s uninstall
```

只删程序和服务，**数据目录保留**，确认不要了自己 `rm -rf /etc/mmwx`。

---

## 添加子服务器（Agent）

面板里「服务器管理 → 添加服务器」，把生成的一键命令拷到子服务器上执行就行 ——
自动装 xray、写配置、配开机自启、连回主控。该命令由上游面板生成，实际下载源取决于面板配置；默认二进制发布源仍为上游 Releases。

### 升级 Agent

到子服务器上跑：

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/miaomiaowux/main/upgrade-agent.sh | sudo bash
```

只更换程序，配置和 xray 都不动。运行中的 Agent 会重启并检查状态，失败恢复旧程序；原来停止的 Agent 保持停止。OpenRC 可显式设置 `MMWX_INIT=openrc`。没有可管理服务时中止，不再猜测存在 supervisor 并直接杀进程。

---

## 常见问题

**全新安装，打开却是登录页不是注册页？登录也进不去？**
你在用 `http://IP:端口` 访问。面板的加密通道要 WebCrypto，浏览器只在 **HTTPS 或 localhost** 下才给，
所以请求全失败、前端 fallback 成了登录框。解决办法见上面「必须用 HTTPS 或 localhost 访问」。
判断方法：F12 控制台执行 `window.isSecureContext`，返回 `false` 就是这个问题。

**打开 IP:12889 显示「探针暂时无法访问」？**
正常现象 —— `/` 是探针伪装页。面板在 **`/login`**，地址后面加上 `/login` 即可：
第一次进去是「创建管理员账号」（注册），之后是登录。

**面板装在哪？**
程序 `/usr/local/bin/mmwx`，服务 `mmwx`，数据默认 `/etc/mmwx/data`。
常用命令：`systemctl status mmwx` / `systemctl restart mmwx` / `journalctl -u mmwx -n 50`。

**忘记管理员密码？**
面板数据在 SQLite 里，暂时只能通过重置脚本处理，或者删掉数据目录重新初始化（会丢配置）。

**「检查更新」提示 API 限流？**
GitHub 匿名接口每小时只有 60 次。等一会儿再试，或给服务加个 token：
在 `/etc/systemd/system/mmwx.service` 的 `[Service]` 段加一行
`Environment="MMWX_GH_TOKEN=你的token"`，然后 `systemctl daemon-reload && systemctl restart mmwx`。

**想让面板彻底不联网检查更新？**
同样在 service 文件里加 `Environment="MMWX_UPDATE_REPO=off"`，重启后「检查更新」会永远显示已是最新。

### 面板支持的环境变量

写在 `/etc/systemd/system/mmwx.service` 的 `[Service]` 段里，改完 `systemctl daemon-reload && systemctl restart mmwx`。

| 变量 | 作用 |
| --- | --- |
| `PORT` | 监听端口，默认 12889 |
| `MMWX_DATA_DIR` | 数据目录，默认 `/etc/mmwx/data` |
| `MMWX_GH_PROXY` | GitHub 加速前缀，面板自更新和 Agent 下载都会用 |
| `MMWX_GH_TOKEN` | GitHub token，只为提高 API 限额 |
| `MMWX_UPDATE_REPO` | 面板从哪个仓库更新；设 `off` 关掉在线更新 |
| `MMWX_AGENT_GITHUB_REPO` | Agent 从哪个仓库下载；设 `off` 关掉 |
| `MMWX_AGENT_DOWNLOAD_BASE` | 自建镜像源，取 `{base}/mmwx-agent-linux-{arch}` |

---

## 说明

- 本项目基于妙妙屋X 修改，去除了授权校验，仅供学习交流使用。
- 面板 / Agent 业务源码不公开，本仓库只维护安装脚本，二进制来自上游。
- 出问题去 TG 频道反馈。

## 开发与测试

公共逻辑在 `scripts/common.sh`，两个入口模板在 `scripts/*.in`。运行 `node scripts/build.mjs` 生成可单独执行的 `install.sh` 和 `upgrade-agent.sh`；服务器安装不需要 Node，也不额外加载远程脚本库。

```bash
node scripts/build.mjs --check
sudo python3 -m unittest discover -s tests -v
# 仅在测试服务器执行：创建并清理独立的 systemd 测试服务
sudo bash tests/systemd-smoke.sh --run
```

单元测试只在临时目录中模拟服务与下载，覆盖校验失败、停止/启动/备份/替换失败、首次安装、OpenRC、原停止状态、并发与 SIGTERM。真实 systemd 测试使用系统自带的 sleep/false 测试升级与回滚，不使用论坛或其他业务账号。

独立实例可指定 `--prefix /opt/mmwx-test --service mmwx-test --port 12890`；已有服务的参数不覆盖。需要自定义启动检查时传 `--health-url http://127.0.0.1:12890/login --health-timeout 30`。安装目录须由 root 所有、不可由其他用户写入。脚本遇到其他目录提供的同名 systemd 服务时拒绝覆盖。
