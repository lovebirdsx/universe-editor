# 自建更新服务器（跨平台一键 · 服务化）

Universe Editor 通过 **electron-updater 的 generic provider** 从一个**静态 HTTP 服务器**拉取更新。
本目录提供一套**单文件 Node 服务器（esbuild 打包产物，零外部依赖）+ 一键安装脚本**，可在
**Ubuntu 和 Windows** 上从0搭起，并注册成**开机自启的后台服务**。

> 与 `scripts/release/README.md` 里的 **nginx 手动方案二选一**：那套适合已有 nginx 的 Linux 机器；
> 本套适合「裸机、一键、跨平台、Windows 也要」的场景，自带 Range/差分下载与禁缓存处理。

> **同一进程也是扩展市场后端**。`server.mjs` 除服务自动更新外，还按发布目录下的 `gallery/registry.json`
> 生成 `/extensionquery` 响应、静态托管 `.vsix`、并挂 token 认证的自助发布 API（`gallery/api/*`），即
> [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md) 描述的市场后端。
> 搭好本服务器就自带市场，无需另装。市场内容（registry / vsix）可用
> [`scripts/gallery`](../gallery/README.md) 的脚本发布（见[「市场内容发布」](#九市场内容发布)节），
> 或开放第三方经 token 自助 `uex publish`（见[「市场自助发布」](#十市场自助发布publish-token-运维)节）。

整体链路：

```
开发机                                   服务器 (Ubuntu / Windows)              客户端
  pnpm package:win  ──►  apps/editor/release/  ──release:upload(scp)──►  发布目录  ──HTTP──►  autoUpdater
                         ├─ *.exe                                        ├─ *.exe
                         ├─ *.blockmap                                   ├─ *.blockmap
                         └─ latest.yml                                   └─ latest.yml ← 客户端先读这个比对版本
```

---

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 静态服务器核心。两平台共用。处理 latest.yml 禁缓存、Range/多段 Range（差分下载）、路径穿越防护；目录请求回退到同目录 `index.html`（下载页）。还挂市场路由（`/extensionquery`、`gallery/**` 静态、`gallery/api/*` 自助发布 API、审批管理页 `gallery/admin`）。 |
| `galleryPublish.mjs` | 自助发布 API 流水线（token 认证、解 VSIX 校验、registry 原子更新）+ 审批管理 API（`gallery/api/admin/*`）。由 `server.mjs` 在命中 `gallery/api/*` 时 lazy import。 |
| `registerPage.mjs` | 自助注册网页（`GET {base}gallery/register`）的内嵌 HTML（中文一次性表单，零外部资源）。由 `server.mjs` 静态 import。 |
| `adminPage.mjs` | 审批管理页（`GET {base}gallery/admin`）的内嵌 HTML（中文，待审批/已启用/已拒绝三分区，零外部资源）。由 `server.mjs` 静态 import。 |
| `bundle.mjs` | 打包脚本（`pnpm server:bundle`）：把 server + 发布依赖（adm-zip/zod/extension-packaging）esbuild 成单文件产物 `dist/server.js`。**部署跑的是这个产物**（服务器上无 node_modules）。加 `-- --env <mode>` 时按开发机 `.env.<mode>` 一并生成 `dist/server.env`，让首装即带配置。 |
| `deploy.mjs` | 一键部署脚本（`pnpm server:deploy -- --env prod`）：比对远端 `SERVER_VERSION` → 交互确认 → 打包 → scp 上传 → 远端安装重启（Ubuntu=免密 sudo + systemctl，Windows=schtasks）→ 轮询健康检查断言新版本。按 `--app-dir` 是否为 Windows 路径自动识别远端形态，详见[第六节](#六更新服务器程序改了-servermjs-后)。 |
| `setupRemote.mjs` | 远程首装/运维脚本（`pnpm server:setup -- --env prod`）：不登服务器，本地一条命令完成首次安装——打包 → tar+scp 上传 → 远端解包 → 提权首装（Linux 走 `ssh -t` 就地输 sudo 密码，Windows 管理员 ssh 会话自带提升令牌）→ 健康检查；`--action status/restart/uninstall` 直发原生命令做日常运维。详见[第一节方式 B](#方式-b本地一条命令远程首装推荐)。 |
| `download-page/index.html` | 面向用户的静态下载页。纯前端，运行时读同目录 `latest.yml` / `release-notes.json`，展示最新版本、发布日期与更新日志，并提供下载按钮；卡片右上角以图标入口链接到注册页与审批管理页（悬停/聚焦显示说明，相对路径 `gallery/register` / `gallery/admin`）。它是发布目录的数据文件（不进 bundle）：首装由 `setup` 落地到 `<root>/index.html`，之后由 `server:deploy` 随 `SERVER_VERSION` 一并同步。 |
| `pageStyles.mjs` | `registerPage.mjs` / `adminPage.mjs` 共享的深色基础样式（与下载页同一套设计令牌；下载页是静态 HTML 无法 import，令牌在两处各存一份，改主题时两边同步）。 |
| `setup.mjs` | 跨平台部署逻辑（按平台分支）：拷 `dist/server.js` / 写 `server.env` / 注册服务 / 自动生成缺失的签名私钥与管理令牌 / 防火墙 / 启停 / 卸载。 |
| `serverEnv.mjs` | 服务端运行时配置（`UE_SERVER_*`）的单一事实源：白名单、默认值派生、`server.env` 读写。`setup.mjs` 与 `deploy.mjs` 共用。 |
| `setup.sh` | **Ubuntu 入口**：自检 root → 装 Node（缺则装）→ 调 `setup.mjs`。 |
| `setup.ps1` | **Windows 入口**：自检管理员 → winget 装 Node → 调 `setup.mjs`。 |

服务化方式：**Ubuntu = systemd**（`universe-update-server`），**Windows = 计划任务**（`UniverseUpdateServer`，开机触发）。

---

## 一、搭建

两种搭法二选一：**方式 B（推荐）**不登服务器、本地一条命令远程首装；**方式 A** 手动把目录拷到服务器执行。

### 方式 B：本地一条命令远程首装（推荐）

```bash
pnpm server:setup -- --env prod    # 生产机
pnpm server:setup -- --env test    # 测试机
```

一条命令走完：本地打包（`server:bundle -- --env <mode>`）→ tar 打包（setup 脚本 + `dist/server.js` +
`dist/server.env`）→ scp 上传 → 远端解包 → **提权执行首装** → 轮询健康检查断言版本（成功后打印
服务地址；超时非零退出并给出排障指引）。
连接参数与 `server:deploy` 同一套（`--host/--user/--port/--key` ← `UE_RELEASE_*`，`--app-dir` ←
`UE_SERVER_APP_DIR`，配置示例见[第六节](#六更新服务器程序改了-servermjs-后)的 `.env.prod` / `.env.test`）；
远端形态同样按 `--app-dir` 是否为 Windows 路径自动识别。

**提权确认发生在本地控制台**，不需要事先登服务器：

- **Ubuntu**：脚本用 `ssh -t` 分配 TTY，sudo 密码提示直接出现在本地终端，就地输入（也可以直接用
  root 登录）。首装会顺带把 ssh 用户写进 `/etc/sudoers.d/universe-update-server`（deploy 免密规则，
  `visudo` 校验通过才落盘）——装完即可直接 `server:deploy`，无需第六节的手动 sudoers 配置。
- **Windows**：Administrators 组成员的 ssh 会话默认发放提升令牌，无需 UAC。脚本先探测远端 `node`：
  已装 Node LTS 则直接跑 `setup.mjs`；没装则走 `setup.ps1`（winget 装 Node——**ssh 非交互会话下
  winget 经常不可用**，失败会提示「请先在服务器装一次 Node LTS」，手动装好后重跑本命令即可）。

**前置条件**：

- ssh 可达目标机；**首次连接**的 host-key 确认提示会出现在本地终端，照提示输入 `yes` 即可。
- Windows 开发机请用 **PowerShell/cmd** 跑本命令（同 `release:upload`）——Git Bash 会把
  `--app-dir /opt/...` 这类 POSIX 参数改写成 `C:/Program Files/Git/...`，导致远端平台识别错误。
- Ubuntu：登录用户可用 sudo（交互输密码），或直接用 root。
- Windows：远端已装 OpenSSH Server 并自启（安装命令见[第六节](#六更新服务器程序改了-servermjs-后)）、
  登录用户属 **Administrators** 组、默认 shell 为 cmd.exe（Windows 默认即是；脚本执行前会自动
  探测，非 cmd 立即报错并给出修复命令）；建议已装 Node LTS。
- 脚本化场景加 `--yes` 跳过确认；**非 TTY 环境的前置**是 host key 已信任（先手动 ssh 一次）、
  Linux 侧 sudo 免密或直接用 root。

常用旗标：`--dry-run`（打印全部命令零副作用）、`--yes`、`--force`（远端已在运行时仍重跑首装：
覆盖程序、`server.env` 与启动器并重启服务；已生成的机密——签名私钥 / 管理令牌——不会覆盖）、
`--skip-bundle`（复用已有 `dist/server.js`）。
日常运维的 `--action status/restart/uninstall` 见[第五节](#五运维命令)。

首装生成的签名公钥与管理令牌经 ssh 直接回显在本地终端——公钥必须内置进客户端
（见下方「让客户端信任签名公钥」），脚本收尾会再提示一次。

### 方式 A：手动拷到服务器执行

先在**仓库内**构建部署产物（publish API 需要解 zip/zod，单文件产物已把这些依赖内联）：

```bash
pnpm install
pnpm server:bundle -- --env prod    # 产出 dist/server.js + dist/server.env（按 .env.prod）
# 不想带配置（用平台默认值）：pnpm server:bundle
```

`.env` 只在开发机存在（服务器上没有仓库），所以 **`.env.<mode>` → `server.env` 的转换固定发生在打包时**，
setup 只消费生成好的 `server.env`。加了 `--env` 首装就直接带上你的配置，与后续 `server:deploy` 走完全
相同的生成逻辑；不加则只出 `server.js`，服务器侧用平台默认值。

> 不带 `--env` 重跑会顺手删掉上次生成的 `dist/server.env`，避免陈旧配置被误拷到服务器。

然后把本目录（`scripts/server/`，**含 `dist/`**）整个拷到服务器任意位置，然后：

Ubuntu：

```bash
cd scripts/server
sudo bash setup.sh                 # 装 Node + 部署 + systemd enable --now
# 自定义：sudo bash setup.sh install --root /data/ue --port 8080 --base /ue/
```

Windows（以管理员身份打开 PowerShell）：

```powershell
cd scripts\server
./setup.ps1                        # 装 Node + 部署 + 创建并启动计划任务
# 若提示脚本被禁: 先 Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# 自定义：./setup.ps1 install --port 8080 --base /ue/
```

### 默认值

| 项 | 环境变量 | Ubuntu 默认 | Windows 默认 |
|---|---|---|---|
| 服务程序安装目录 | `--app-dir` | `/opt/universe-update-server/` | `C:\universe-editor\app\` |
| 发布目录（更新产物落地） | `UE_SERVER_ROOT` | `/srv/universe-editor` | `C:\universe-editor\data` |
| 市场根（扩展内容落地） | `UE_SERVER_GALLERY_ROOT` | `<root>/gallery` | `C:\universe-editor\data\gallery` |
| 认证目录（publish token，静态根之外） | `UE_SERVER_AUTH_DIR` | `<root>/../auth` | `C:\universe-editor\auth` |
| 端口 | `UE_SERVER_PORT` | `80` | `80` |
| URL 前缀 | `UE_SERVER_BASE` | `/universe-editor/` | `/universe-editor/` |
| 市场签名私钥 | `UE_SERVER_SIGNING_KEY_FILE` | `<authDir>/market-key.pem` | `<authDir>\market-key.pem` |
| 签名 keyId | `UE_SERVER_SIGNING_KEY_ID` | `market-v1` | `market-v1` |
| 审批管理令牌 | `UE_SERVER_ADMIN_TOKEN_FILE` | `<authDir>/admin-token.txt` | `<authDir>\admin-token.txt` |
| 注册限流（每 IP 每小时，0=关） | `UE_SERVER_REGISTER_RATE_LIMIT` | `10` | `10` |

**`--gallery-root` / `--auth-dir` 等都从 `--root` 派生**，只给 `--root` 时整套跟着走。
**`--auth-dir` 绝不允许落在 `--root` 或 `--gallery-root` 之内**（publish token 哈希表会被静态服务公开下载）：
`setup install` 落盘前即校验、命中当场报错，server 启动自检也会拒绝启动。

### 配置怎么来（重要）

服务的运行时配置**不烧在服务定义里**，而是集中放在安装目录下的 `server.env`（`UE_SERVER_*=值`，每行一条）：
Ubuntu 由 systemd `EnvironmentFile=` 注入，Windows 由 `run.cmd` 逐行 `set` 加载。

**唯一编辑点是开发机的 `.env.<mode>`**（完整变量清单见仓库根 [`.env.example`](../../.env.example)）。
`.env` 不会出现在服务器上，所以两条路都在开发机上把它转成 `server.env`，用的是同一套生成逻辑：

| 场景 | 命令（开发机） | 产物 |
|---|---|---|
| 首装 | `pnpm server:bundle -- --env prod` → 拷目录到服务器 → `setup.sh` | `dist/server.env` 随包 |
| 日常改配置 / 换程序 | `pnpm server:deploy -- --env prod` | 上传 `server.env` + 重启 |

setup 侧的完整优先级与查找顺序：

```
CLI 旗标  >  server.env（--env-file > dist/server.env > 同目录 > 安装目录已有的那份）  >  平台默认值
```

所以改配置日常走 `server:deploy`（不必登服务器、不必重装）；在服务器上临时改用
`setup.sh install --port 8080`（CLI 旗标覆盖，会写回 `server.env`）。

> 不带任何旗标重跑 `install` 不会丢配置：会沿用安装目录里已有的 `server.env`。
> 只想换程序、完全不动服务器配置时用 `pnpm server:deploy -- --env prod --skip-env`。

### 首装会自动生成的机密

`install` 时若 `UE_SERVER_SIGNING_KEY_FILE` / `UE_SERVER_ADMIN_TOKEN_FILE` 指向的文件不存在，setup 会**自动生成**（权限 0600，Linux 下一并 `chown www-data`），并在安装结束时**一次性打印**：

- **市场签名公钥**（Ed25519 JWK `x`）——必须让客户端信任它，否则从本市场装扩展会因验签失败被拒（fail-closed）。做法见下方[「让客户端信任签名公钥」](#让客户端信任签名公钥)。
- **审批管理令牌明文**——管理页 `{base}gallery/admin` 登录用（文件里也有一份）。

私钥与令牌都是**服务器上的持久运维资产**，`server:deploy` 永远不碰它们（只搬路径，不搬内容）；重跑 `install` 检测到文件已存在也不会覆盖。

### 让客户端信任签名公钥

拿到 setup 打印的公钥（形如 `ygBMXrD6w96p8I0uYBejToWvqU8DUer--4cWJ676A-g`）后，二选一：

**1）正式发布（推荐）**：在仓库里编辑
`apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts`，
往 `BUILTIN_MARKETPLACE_SIGNING_KEYS` 加一行（**保留已有条目，勿删旧 keyId**）：

```ts
export const BUILTIN_MARKETPLACE_SIGNING_KEYS: Readonly<Record<string, string>> = {
  'market-v1': 'ygBMXrD6w96p8I0uYBejToWvqU8DUer--4cWJ676A-g',
  'market-v2': '<setup 打印的公钥>',   // ← 新增
}
```

然后重新打包发版。**旧客户端要升级到含该公钥的版本后才能装本市场的扩展**——遇到未知 keyId 一律
`unknown-key` 拒装。所以密钥轮换的正确顺序是：生成新 key → 加进内置表并保留旧 id → 客户端铺量 →
最后才把服务端 `UE_SERVER_SIGNING_KEY_ID` 切到新 id。

**2）临时联调 / 内部试用**：客户端启动前设环境变量（叠加在内置表之上，仅适合 dev/e2e）：

```bash
UNIVERSE_GALLERY_SIGNING_KEYS='{"market-v1":"<公钥>"}'
```


---

## 二、把服务器地址写进打包配置

编辑 `apps/editor/electron-builder.yml`，`publish.url` 的**路径段要和 `--base` 一致**：

```yaml
publish:
  provider: generic
  url: http://<服务器IP>/universe-editor/   # 路径段 /universe-editor/ ↔ server 的 --base
  channel: latest
```

> **base 三处必须对齐**：`server` 的 `--base`、`electron-builder.yml` 的 `publish.url` 路径段、
> 以及本地联调用的 `apps/editor/dev-app-update.yml` 的 url。不一致会全部 404。

---

## 三、发布一个新版本

```bash
# 1) bump 版本（apps/editor/package.json 的 version，semver）
# 2) 打包，产物落到 apps/editor/release/
pnpm --filter @universe-editor/editor package:win
# 3) 上传到服务器发布目录（Windows 用 PowerShell/cmd，不要用 Git Bash）
pnpm release:upload --host <IP> --user deploy --dir /srv/universe-editor
```

客户端下次启动检查（或命令面板 **Check for Updates**）即从 `…/latest.yml` 发现新版本。

`release:upload` 会一并同步**更新日志 `release-notes.json`** 到发布目录；**下载页 `index.html`**
则由 `server:deploy` 同步（随 `SERVER_VERSION` 走，首装时 `setup` 已落地）：
浏览器访问 `http://<IP>/universe-editor/`（即 `--base` 路径）即可看到下载页，一键下载最新版。

> **历史版本不要删**：保留旧 `.exe` / `.blockmap`，electron-updater 的差分下载需要它们，也方便回滚。

---

## 四、本地联调（不必真有服务器）

`apps/editor/dev-app-update.yml` 默认指向 `http://localhost:8788/`（base 为 `/`），所以联调用 `--base /`：

```bash
pnpm server:serve                  # = node scripts/server/server.mjs --root apps/editor/release --port 8788 --base /
```

配合未打包的 dev 构建，可走完 检查 → 下载 → 重启安装 全链路。

本地预览提示：pnpm server:serve 默认指向 apps/editor/release/（没有 index.html）。想本地看页面效果，把 scripts/server/download-page/index.html 和 apps/editor/resources/release-notes.json 拷进 release/ 目录再起服务即可（生产上 index.html 由 server:deploy 同步、release-notes.json 由 release:upload 同步，无此问题）。
```bash
cp scripts/server/download-page/index.html apps/editor/release/
cp apps/editor/resources/release-notes.json apps/editor/release/
```

---

## 五、运维命令

### 本地一条命令（不登服务器）

`server:setup` 的 `--action` 直连远端已安装的服务做日常运维（连接参数与首装/deploy 同一套）：

```bash
pnpm server:setup -- --env prod --action status      # 查看状态
pnpm server:setup -- --env prod --action restart     # 重启
pnpm server:setup -- --env prod --action uninstall   # 卸载（删除服务与安装目录，发布目录保留）
```

Ubuntu 走 `systemctl`（restart/uninstall 经 `ssh -t` 在本地终端就地输 sudo 密码），Windows 走
`schtasks`；uninstall 顺带清掉首装创建的防火墙规则。

### Ubuntu

```bash
systemctl status universe-update-server         # 状态
journalctl -u universe-update-server -f         # 日志
sudo bash setup.sh restart                      # 重启
sudo bash setup.sh uninstall                    # 卸载（保留发布目录）
```

### Windows

```powershell
schtasks /Query /TN UniverseUpdateServer /V /FO LIST   # 状态
./setup.ps1 restart                                    # 重启
./setup.ps1 uninstall                                  # 卸载（保留发布目录）
```

---

## 六、更新服务器程序（改了 `server.mjs` 后）

服务器跑的是 setup 部署时拷到安装目录的 `server.mjs` **副本**（Ubuntu `/opt/universe-update-server/`、Windows `C:\universe-editor\app\`），内容是 **`dist/server.js` 打包产物**（依赖已内联），且进程已把它加载进内存。改了仓库里的源码后，要**重新打包**、把新产物送上去**并重启进程**才生效——只 `git pull` 或重传文件不够。

改动一般向后兼容，可热替换；重启的一两秒内 systemd / 计划任务会自动拉起，不影响客户端正在进行的自动更新。

> 改了服务器行为时，顺手把 `server.mjs` 顶部的 `SERVER_VERSION` +1（手动维护）。启动横幅
> 和健康检查响应（`curl http://<IP>/`）都会带上它，能立刻确认服务器跑的是哪版代码。
> `server:deploy` 部署前会自动比对远端版本：相同（疑似忘 bump）或远端更新（疑似降级）都会拦下。

### 一键部署（Ubuntu / Windows 远端均支持，推荐）

```bash
pnpm server:deploy -- --env prod    # 生产机
pnpm server:deploy -- --env test    # 测试机（预验证）
```

一条指令走完：检查远端版本 → 交互确认 → `pnpm server:bundle` 打包 → scp 上传 `dist/server.js`、
**`server.env` 与下载页 `index.html`** → 远端安装并重启服务（`index.html` 落 `<UE_SERVER_ROOT>/index.html`
发布根；`--skip-env` 只跳过 `server.env`，下载页仍部署，UE_SERVER_ROOT 改从远端 server.env 读）→
轮询健康检查断言新版本号。必须显式指定目标环境（`--env prod` /
`--env test`，或 `UE_ENV`），否则拒绝执行（防误发护栏）；连接参数与服务端运行时配置都从对应 `.env.<mode>` 读取。

远端形态按 **`--app-dir` / `UE_SERVER_APP_DIR` 是否为 Windows 路径**（盘符或反斜杠）自动识别：

- **Ubuntu/systemd**：上传到 `~/server.js.v<N>` → 免密 sudo 拷到安装目录 →
  `systemctl restart universe-update-server`。
- **Windows/计划任务**：上传到 `%USERPROFILE%\server.js.v<N>` → `copy` 到安装目录，成功后
  `schtasks /End` + `/Run` 重启任务（copy 失败不动在跑的服务）。

`server.env` 先于程序落地，所以**改配置和换程序是同一次操作**——改 `.env.<mode>` 里的 `UE_SERVER_*`
再跑一次 deploy 即可，不必登服务器。只想换程序、完全保留服务器现有配置时加 `--skip-env`。
⚠️ 只有 `serverEnv.mjs` 白名单里的 `UE_SERVER_*` 会被搬上服务器，`UE_RELEASE_KEY` 等部署侧机密永远留在本机。

连接参数与 `release:upload` 同一套（`--host/--user/--port/--key` ← `UE_RELEASE_HOST/USER/PORT/KEY`），
推荐按环境分别写进仓库根 `.env.prod`（生产机）与 `.env.test`（测试机）：

```bash
# .env.prod（Ubuntu 远端示例）
UE_RELEASE_HOST=10.0.0.5
UE_RELEASE_USER=deploy
UE_RELEASE_PORT=22
#UE_RELEASE_KEY=/path/to/id_ed25519              # 缺省用 ssh 默认凭证
#UE_SERVER_APP_DIR=/opt/universe-update-server   # 服务程序安装目录（默认即此）
#UE_SERVER_HEALTH_URL=http://10.0.0.5/           # 默认 http://<host>/
# 服务端运行时配置（会生成 server.env 上传，重启即生效）
UE_SERVER_PORT=80
UE_SERVER_BASE=/universe-editor/

# .env.test（Windows 远端示例——UE_SERVER_APP_DIR 必须显式给 Windows 路径，deploy 据此识别）
UE_RELEASE_HOST=10.0.0.6
UE_RELEASE_USER=Administrator
UE_SERVER_APP_DIR=C:\universe-editor\app
UE_SERVER_HEALTH_URL=http://10.0.0.6/
UE_SERVER_ROOT=C:\universe-editor\data
```

完整变量清单见仓库根 [`.env.example`](../../.env.example)。常用旗标：`--dry-run`（打印全部命令零副作用）、
`--yes`（跳过交互确认）、`--force`（远端版本 >= 本地时强制）、`--skip-bundle`（复用已有 `dist/server.js`）、
`--skip-env`（不上传 `server.env`）。

**Ubuntu 前置条件：部署用户配免密 sudo**（缺失时脚本会打印精确的 sudoers 配置后退出）。
用 `pnpm server:setup -- --env <mode>` 完成首装的机器**已自动写好这条规则**，无需手动配置；
仅方式 A 手动首装（或没有传 `--deploy-user` 的老安装）需要自己动手。在服务器上执行
`sudo visudo -f /etc/sudoers.d/universe-update-server`，加入（`deploy` 换成实际用户名）：

```
deploy ALL=(root) NOPASSWD: /usr/bin/cp /home/deploy/server.js.v* /opt/universe-update-server/server.mjs, /usr/bin/cp /home/deploy/server.env.v* /opt/universe-update-server/server.env, /usr/bin/cp /home/deploy/index.html.v* /srv/universe-editor/index.html, /usr/bin/systemctl restart universe-update-server
```

> ⚠️ **已有部署需要更新这条规则**：`server.env` 与 `index.html` 两条 cp 通道都是后加的
> （`index.html` 落 `<UE_SERVER_ROOT>/index.html`，示例按默认发布根 `/srv/universe-editor`，路径按实际配置替换），
> 老规则没有覆盖会在安装步骤失败——deploy 安装失败时会打印适用于你环境的整行替换文本；
> 带 `--deploy-user` 重跑 `server:setup` 首装也会自动补齐。`server.env` 通道急着发版可先用
> `--skip-env` 跳过；`index.html` 通道无开关。

**Windows 前置条件**（部署前脚本会远端 `schtasks /Query` 预检，失败时打印下述清单）：

1. 已按[第一节方式 A](#方式-a手动拷到服务器执行)用 `setup.ps1` 完成首次安装（计划任务 `UniverseUpdateServer` 存在）。
2. 远端装好 **OpenSSH Server** 并自启（管理员 PowerShell）：

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service sshd -StartupType Automatic; Start-Service sshd
   ```

3. ssh 登录用户属于 **Administrators 组**（Win32-OpenSSH 对管理员默认发放提升令牌，schtasks / 写
   `C:\universe-editor\app` 均需要）。
4. 远端 OpenSSH 默认 shell 为 **cmd.exe**（Windows 默认即是；命令执行前会自动探测，若改过
   PowerShell 默认 shell，会在首个远端命令前报错并给出修复命令：远端管理员 PowerShell 执行
   `New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\cmd.exe' -PropertyType String -Force`）。

### 手动 fallback（无法满足上述前置条件时）

先在仓库侧 `pnpm server:bundle` 重新打包，让服务器拿到新产物：服务器上有仓库就 `git pull && pnpm install && pnpm server:bundle`，否则从开发机 `scp scripts/server/dist/server.js <user>@<IP>:~/`。然后：

#### Ubuntu

```bash
sudo cp scripts/server/dist/server.js /opt/universe-update-server/server.mjs
sudo bash setup.sh restart
systemctl status universe-update-server          # 确认 active (running)
```

#### Windows（管理员 PowerShell）

```powershell
Copy-Item scripts\server\dist\server.js C:\universe-editor\app\server.mjs -Force
./setup.ps1 restart                              # 内部 End+Run，避免旧实例抢端口
```

> 重跑 `setup.sh install` / `setup.ps1 install` 也会重新拷文件并重启（Linux 侧显式 `restart`，
> Windows 侧 `End`+`Run`），但它还会重写 `server.env` 与服务定义；只改了 `server.mjs`、
> 没动配置时，上面这套「拷文件 + 重启」最干净，不动 unit、防火墙与目录权限。
>
> 若改动**新增了发布目录里的静态资源**（如下载页 `index.html`、`release-notes.json`），重启 server 只是让它
> 能服务这些文件；文件本身要进发布目录——`index.html` 下次 `server:deploy` 随版本同步（须 bump
> `SERVER_VERSION`），`release-notes.json` 下次 `release:upload` 同步；想立刻生效均可手动 `scp` 一次。

手动方式完成后用下一节的 `curl` 验证（`server:deploy` 已内置健康检查，无需再验）。

---

## 七、验证

服务器本机（把 `<name>` 换成实际 .blockmap 文件名）：

```bash
curl -i http://localhost/                                     # 200，响应体含服务器版本号
curl -i http://localhost/universe-editor/                    # 200 text/html，下载页（目录回退 index.html）
curl -i http://localhost/universe-editor/latest.yml          # 200，响应头含 no-store
curl -r 0-99 -i http://localhost/universe-editor/<name>      # 206 + Content-Range
curl -r 0-99,200-299 -v http://localhost/universe-editor/<name>   # 206 multipart/byteranges
curl -i http://localhost/universe-editor/../../etc/passwd    # 403/404（穿越防护）
```

---

## 八、排错

- **客户端检查不到更新**：确认 `publish.url` 路径段与 `--base` 一致；浏览器能否直接打开 `…/latest.yml`；
  客户端版本是否确实低于 `latest.yml` 的 `version`；latest.yml 响应头是否 `no-store`。
- **80 端口 EACCES（Ubuntu）**：unit 已配 `CAP_NET_BIND_SERVICE`；若仍失败，改用高位端口 `--port 8080`
  并同步改 `publish.url`。
- **Windows 计划任务起不来**：`schtasks /Query /TN UniverseUpdateServer /V /FO LIST` 看上次结果；
  任务指向 `<appDir>\run.cmd` 启动器（schtasks /TR 有 261 字符上限，启动器里先从 `server.env`
  加载 `UE_SERVER_*` 再起 node），排查时直接手动跑 `C:\universe-editor\app\run.cmd`
  （去掉行尾 `>nul 2>&1` 可看到输出）。配置不对时先看 `C:\universe-editor\app\server.env`。
- **内网无外网装不了 Node**：Ubuntu 用官方 tar.xz 离线包解到 `/usr/local`；Windows 用离线 MSI。装好后
  重跑 `setup.sh` / `setup.ps1` 即可（会跳过安装步骤）。
- **GitHub Actions 推不进内网**：CI 只产出 `release/` artifact；上传与搭建在能访问内网的机器上做。

---

## 九、市场内容发布

本服务器同时是[扩展市场后端](../../docs/development/marketplace-server.md)。市场内容放在**市场根**（`--gallery-root`，默认 `<root>/gallery`，可指向独立目录/磁盘）：

```
<市场根>/
  registry.json          扩展清单（服务器据此生成 /extensionquery，改动免重启，按 mtime 自动重载）
  control.json           恶意/弃用清单（可选）
  assets/<publisher>.<name>/<version>/<publisher>.<name>-<version>.vsix (+ icon/README)
```

用 [`scripts/gallery`](../gallery/README.md) 的脚本发布（零依赖，从 `.vsix` 自动抽元数据）。`--dir` 就是服务器上的市场根（= server 的 `--gallery-root`）：

```bash
# 发布进本地 stage → 同步到服务器市场根（先 assets 后 registry.json，避免半态）
pnpm gallery:publish -- --stage ./market-stage path/to/foo.vsix
pnpm gallery:upload  -- --stage ./market-stage --host <IP> --user deploy --dir /srv/universe-editor/gallery
```

客户端把 `GALLERY_URL` 指向与更新同前缀的地址即可（server `--base` 为 `/universe-editor/` → `GALLERY_URL=http://<IP>/universe-editor`）。详见 [`scripts/gallery/README.md`](../gallery/README.md) 与 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)。

验证：

```bash
curl -X POST http://localhost/universe-editor/extensionquery \
  -H 'Content-Type: application/json' \
  -d '{"filters":[{"criteria":[{"filterType":10,"value":""}],"pageNumber":1,"pageSize":50}],"flags":787}'
curl -i http://localhost/universe-editor/control.json
```

---

## 十、市场自助发布（publish token 运维）

服务器还挂了 Bearer token 认证的发布 API（`POST {base}gallery/api/publish` 等），让第三方开发者用 [`uex`](../../packages/uex/README.md) 直接上架，运维不再人肉 scp。完整协议与服务端流水线见 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)「自助发布 API」节，这里只列运维动作。

> ⚠️ **publish 依赖签名私钥**：未配置或文件不存在时 publish 一律 503（编辑器验签 fail-closed，无签名的包上架必拒装）；whoami / register / unpublish 不受影响。**首次 `setup install` 会自动生成私钥并打印公钥**（见[第一节](#首装会自动生成的机密)），公钥必须内置进客户端才能装扩展；也可用 `pnpm gallery:keygen` 手动生成后经 `UE_SERVER_SIGNING_KEY_FILE` 指定。keyId 须与客户端内置公钥一致（`UE_SERVER_SIGNING_KEY_ID`，默认 `market-v1`）。

开发者拿 token 有两条路：**自助注册**（浏览器打开 `http://<IP>/universe-editor/gallery/register` 填表，token 只显示一次）与运维签发（下述 `token.mjs`）。⚠️ 自助注册写 `publishers.json` 与运维 ssh 直改该文件是两条写通道，存在与 upload 通道同级的写竞态——避免同时操作。

### 注册审批制（2026-08-11 起）

自助注册改为**审批制**：网页注册创建的 publisher 落 `status: 'pending'`，token 照常签发（可先 `uex login` / `uex whoami` 查状态），但 **publish / unpublish 一律 403（`pending approval`）**，直到管理员在管理页批准。运维通道 `token.mjs issue` 签发的 publisher 直接 `active`，不受门控；被拒绝（`rejected`）的 publisher 其 token 与无效 token 不可区分（一律 401，不给探测面）。

**管理页**在 `http://<IP>/universe-editor/gallery/admin`：内嵌中文页面，分「待审批 / 已启用 / 已拒绝」三区，支持批准、拒绝、删除记录（仅 pending/rejected 且名下无扩展可删，删除即释放名字）。所有操作走 `gallery/api/admin/*` API（审计进 server 日志），写操作与 publish 共用进程内串行写队列。

管理令牌经 **`UE_SERVER_ADMIN_TOKEN_FILE`**（默认 `<authDir>/admin-token.txt`）配置，文件内容为令牌明文（trim 后单行），与 publish token 完全独立的一套凭证。**首次 `setup install` 会自动生成并打印一次明文**，一般无需手动操作。想手动换一个：

```bash
# Ubuntu：换令牌 = 重写文件 + 重启服务（启动时读一次，不支持热轮换）
openssl rand -base64 32 > /srv/auth/admin-token.txt && chmod 600 /srv/auth/admin-token.txt
sudo bash setup.sh restart
```

```powershell
# Windows（管理员 PowerShell）
$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Fill($b)
Set-Content C:\universe-editor\auth\admin-token.txt ([Convert]::ToBase64String($b)) -NoNewline
./setup.ps1 restart
```

想把令牌文件放到别处，改 `.env.<mode>` 的 `UE_SERVER_ADMIN_TOKEN_FILE` 后重跑 `server:deploy` 即可（只改路径，不搬内容——文件本身要先在服务器上就位）。

- 配了但文件不可读/为空 → **拒绝启动**；路径为空 → 启动横幅 warning（admin console disabled），管理页与管理 API 一律 **503**（fail-closed，同签名密钥语义）。
- 校验方式：请求 Bearer 与配置值各自 sha256 后 `timingSafeEqual`，失败一律 401。
- ⚠️ 管理令牌同样 Bearer 明文过线，公网部署必须置于 TLS 反代之后；管理页本身不存令牌（浏览器 sessionStorage 暂存，关标签即清）。
- 管理页只服务**审批**这一件事；publisher 自视角/运营报表等完整管理台属公开阶段（Phase F）。

token 数据存 **`--auth-dir`（默认 `<root>/../auth`）的 `publishers.json`**（只存 sha256 哈希；server 按 mtime 自动重载，改完免重启）。用 [`scripts/gallery/token.mjs`](../gallery/README.md) 签发/吊销——直接读写服务器上的文件（ssh 上去跑），或对本地副本跑完随 `gallery:upload` 通道上传：

```bash
# 签发（明文只打印一次，交付给开发者用于 uex login；publisher 首次隐式创建）
pnpm gallery:token -- issue --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
# 吊销（label 定点，立即生效）/ 盘点
pnpm gallery:token -- revoke --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
pnpm gallery:token -- list --auth-dir /srv/auth
```

安全要点：

- 🔴 `--auth-dir` 绝不能在 `--root` / `--gallery-root` 之内（启动自检会拒），否则 token 哈希表被静态服务公开下载。
- ⚠️ token 走 Bearer 明文过线，**公网/跨办公网部署必须置于 TLS 反代之后**（server 自身不做 TLS）。
- 上传体积上限 `--max-vsix-size`（默认 128MB）。publish 限流未做（内部信任环境；注册 API 已有内存级 IP 节流，`--register-rate-limit`），公开前见公开阶段清单。
- 版本不可变：同版本重发一律 409，改内容必须 bump version——服务端强制，无例外。

验证（token 签发后）：

```bash
curl -i http://localhost/universe-editor/gallery/api/whoami -H "Authorization: Bearer uet_xxx"   # 200 {"publisher":"acme","status":"active"}
```
