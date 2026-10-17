# 安装升级脚本改进版验证记录

验证日期：2026-10-17。原始脚本取自 `wangjialiangsaa/miaomiaowux` 的 `1b79324a50e6bc4f1a24071ee43cd74af3eaf560`。本次修改安装、升级和开发测试流程，新增可复用的界面精简 CSS；没有修改上游面板或 Agent 二进制。

## 测试结果

- `node scripts/build.mjs --check`：生成入口与模板一致。
- `bash -n install.sh`、`bash -n upgrade-agent.sh`：通过。
- `python3 -m unittest discover -s tests -v`：Linux 服务器 19 项全部通过，包含面板和 Agent 成功/失败分支、SHA-256、错误文件格式、备份/停止/替换/启动失败、健康检查失败、首次安装失败清理、保持停止状态、OpenRC 模拟、查询失败、其他位置的服务文件、锁文件符号链接、并发和 SIGTERM。
- `bash tests/systemd-smoke.sh --run`：真实 systemd 成功升级、失败启动后回滚、原停止状态、数据保留全部通过。临时服务单元测试结束后移除，测试产物保留在 `/opt/mmwx-systemd-check.*`。
- `bash tests/release-smoke.sh --run`：真实 GitHub API 查询、资产选择、SHA-256 和 ELF 架构检查通过；此检查没有执行下载的程序。
- 真实 Chromium：首次注册页正常，安全上下文和 WebCrypto 可用，无页面脚本异常。创建测试管理员成功；全新浏览器上下文重新登录成功，跳转到主页面。

注册成功会返回登录页。测试初版误以为自动跳入控制台，发生等待跳转超时；随后通过独立会话确认注册已成功，并修正测试判断。

## 界面精简

`ui/minimal.css` 只隐藏 `.license-nameplate` 和 `.mmwx-welcome-mask`，分别对应用户标出的版本标牌和欢迎推广弹窗。使用系统原生自定义 CSS 设置，随 HTML 下发，保留已有 CSS 和其他设置。没有修改授权判断、删除后台功能或改写编译资源。

`scripts/customize-preview.mjs --apply` 使用面板自身的 API 客户端完成认证和加密通道请求，仅保存 `custom_css`。保存前私下备份旧 CSS，保存后读取核对。辅助脚本中的设置接口契约适用于已核验的 `mmwx-v0.5.4`；其他版本需重新核验。安装脚本本身不自动应用界面设置。

酷雪实例保存后，重新运行不带 `--apply` 的验证模式通过：613 × 1244 视口下，light/dark 两种浏览器上下文分别检查全新登录页、登录后控制台、刷新后控制台、系统设置，共 8 个场景。每个场景均确认服务器注入样式，标牌及欢迎层不占可见布局；等待 1.8 秒覆盖欢迎层的 400 毫秒定时器，没有页面脚本异常。截图保存在私有 `runtime/qa/minimal-*.png`。该实现隐藏欢迎层，其上游脚本仍会创建不可见 DOM。

## 服务器测试实例

- 服务器：`23.138.76.21`。
- 源码及测试目录：`/opt/mmwx-review.b6BKYG2R`。
- 容器：`mmwx-preview`，监听 `127.0.0.1:12890`，映射到容器 `12889`。
- 面板二进制：上游 `mmwx-v0.5.4` / amd64，SHA-256 `b0cb28538c15b3d33663ac1413e731dbf6cb7d8e9fb8b8dc0f808f0af87430f2`。
- 数据卷绑定：`runtime/data`；工作目录 `/data`，兼容上游程序的相对数据及订阅路径。新安装的 systemd 服务也明确设置 WorkingDirectory。
- 测试容器使用只读根文件系统、非 root 用户、256 MiB 内存上限。空闲观察约 30–39 MiB，属于该版本在空数据测试实例下的单次观察，不能作为本次脚本修改带来性能收益的证据。
- 测试实例关闭上游内置在线更新，避免审查期间二进制版本自行变化。
- 管理员凭据保存在服务器 `runtime/qa/preview-credentials.json`，没有放入仓库。浏览器截图在 `runtime/qa`。
- 现有 `nodeseek-tg-nodeseek-tg-1` 检查为 healthy，`zhixu-office-preview` 保持运行。

## 审查范围与限制

本版解决的是安装升级的可靠性、校验与脚本维护问题。现有 systemd 单元不自动迁移；其他目录提供的同名服务会拒绝覆盖。程序回滚不回滚 SQLite 或 PostgreSQL 数据迁移，实际业务升级仍需提前备份。

OpenRC 通过故障模拟核验，未在真实 OpenRC 主机上部署。尚未配置真实子服务器、xray 或代理流量，也未进行业务负载性能测试。上游闭源程序及其内置更新器不在本次代码修改范围内。

GitHub 当前登录令牌没有 `workflow` 权限，服务器拒绝写入 `.github/workflows`。因此 CI 配置作为 `docs/installer-checks.yml.example` 一并提供，未启用 GitHub Actions；上述测试结果来自已执行的本地及酷雪服务器检查。
