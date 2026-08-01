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
| `server.mjs` | 静态服务器核心。两平台共用。处理 latest.yml 禁缓存、Range/多段 Range（差分下载）、路径穿越防护；目录请求回退到同目录 `index.html`（下载页）。还挂市场路由（`/extensionquery`、`gallery/**` 静态、`gallery/api/*` 自助发布 API）。 |
| `galleryPublish.mjs` | 自助发布 API 流水线（token 认证、解 VSIX 校验、registry 原子更新）。由 `server.mjs` 在命中 `gallery/api/*` 时 lazy import。 |
| `bundle.mjs` | 打包脚本（`pnpm server:bundle`）：把 server + 发布依赖（adm-zip/zod/extension-packaging）esbuild 成单文件产物 `dist/server.js`。**部署跑的是这个产物**（服务器上无 node_modules）。 |
| `download-page/index.html` | 面向用户的静态下载页。纯前端，运行时读同目录 `latest.yml` / `release-notes.json`，展示最新版本、发布日期与更新日志，并提供下载按钮。发布时由 `release:upload` 同步到发布目录。 |
| `setup.mjs` | 跨平台部署逻辑（按平台分支）：拷 `dist/server.js` / 注册服务 / 防火墙 / 启停 / 卸载。 |
| `setup.sh` | **Ubuntu 入口**：自检 root → 装 Node（缺则装）→ 调 `setup.mjs`。 |
| `setup.ps1` | **Windows 入口**：自检管理员 → winget 装 Node → 调 `setup.mjs`。 |

服务化方式：**Ubuntu = systemd**（`universe-update-server`），**Windows = 计划任务**（`UniverseUpdateServer`，开机触发）。

---

## 一、搭建（在服务器上）

先在**仓库内**构建部署产物（publish API 需要解 zip/zod，单文件产物已把这些依赖内联）：

```bash
pnpm install && pnpm server:bundle    # 产出 scripts/server/dist/server.js
```

然后把本目录（`scripts/server/`，**含 `dist/`**）整个拷到服务器任意位置，然后：

### Ubuntu

```bash
cd scripts/server
sudo bash setup.sh                 # 装 Node + 部署 + systemd enable --now
# 自定义：sudo bash setup.sh install --root /data/ue --port 8080 --base /ue/
```

### Windows（以管理员身份打开 PowerShell）

```powershell
cd scripts\server
./setup.ps1                        # 装 Node + 部署 + 创建并启动计划任务
# 若提示脚本被禁: 先 Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# 自定义：./setup.ps1 install --port 8080 --base /ue/
```

### 默认值

| 项 | Ubuntu 默认 | Windows 默认 |
|---|---|---|
| 服务程序安装目录 | `/opt/universe-update-server/` | `C:\universe-editor\app\` |
| 发布目录（更新产物落地） | `/srv/universe-editor` | `C:\universe-editor\data` |
| 市场根（扩展内容落地） | `/srv/universe-editor/gallery` | `C:\universe-editor\data\gallery` |
| 认证目录（publish token，静态根之外） | `/srv/auth` | `C:\universe-editor\auth` |
| 端口 | `80` | `80` |
| URL 前缀（`--base`） | `/universe-editor/` | `/universe-editor/` |

可用 `--root` / `--gallery-root` / `--auth-dir` / `--port` / `--base` 覆盖。**`--gallery-root` 默认 `<root>/gallery`（合并部署）**，想把扩展内容放另一块磁盘/另一套权限时指向独立目录即可（如 `--gallery-root /data/extensions`）——URL 上市场始终挂在 `{base}gallery/`，与磁盘位置无关。**`--auth-dir` 默认 `<root>/../auth`，绝不允许落在 `--root` 或 `--gallery-root` 之内**（publish token 哈希表会被静态服务公开下载；server 启动自检命中即拒绝启动）。

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

`release:upload` 会一并同步**下载页 `index.html`** 与**更新日志 `release-notes.json`**到发布目录：
浏览器访问 `http://<IP>/universe-editor/`（即 `--base` 路径）即可看到下载页，一键下载最新版。

> **历史版本不要删**：保留旧 `.exe` / `.blockmap`，electron-updater 的差分下载需要它们，也方便回滚。

---

## 四、本地联调（不必真有服务器）

`apps/editor/dev-app-update.yml` 默认指向 `http://localhost:8788/`（base 为 `/`），所以联调用 `--base /`：

```bash
pnpm server:serve                  # = node scripts/server/server.mjs --root apps/editor/release --port 8788 --base /
```

配合未打包的 dev 构建，可走完 检查 → 下载 → 重启安装 全链路。

本地预览提示：pnpm server:serve 默认指向 apps/editor/release/（没有 index.html）。想本地看页面效果，把 scripts/server/download-page/index.html 和 apps/editor/resources/release-notes.json 拷进 release/ 目录再起服务即可（生产由 upload 自动同步，无此问题）。
```bash
cp scripts/server/download-page/index.html apps/editor/release/
cp apps/editor/resources/release-notes.json apps/editor/release/
```

---

## 五、运维命令

### Ubuntu

```bash
systemctl status universe-update-server         # 状态
journalctl -u universe-update-server -f         # 日志
sudo bash setup.sh uninstall                    # 卸载（保留发布目录）
```

### Windows

```powershell
schtasks /Query /TN UniverseUpdateServer /V /FO LIST   # 状态
./setup.ps1 uninstall                                  # 卸载（保留发布目录）
```

---

## 六、更新服务器程序（改了 `server.mjs` 后）

服务器跑的是 setup 部署时拷到安装目录的 `server.mjs` **副本**（Ubuntu `/opt/universe-update-server/`、Windows `C:\universe-editor\app\`），内容是 **`dist/server.js` 打包产物**（依赖已内联），且进程已把它加载进内存。改了仓库里的源码后，要**重新打包**、把新产物送上去**并重启进程**才生效——只 `git pull` 或重传文件不够。

改动一般向后兼容，可热替换；重启的一两秒内 systemd / 计划任务会自动拉起，不影响客户端正在进行的自动更新。

先在仓库侧 `pnpm server:bundle` 重新打包，让服务器拿到新产物：服务器上有仓库就 `git pull && pnpm install && pnpm server:bundle`，否则从开发机 `scp scripts/server/dist/server.js <user>@<IP>:~/`。然后：

### Ubuntu

```bash
sudo cp scripts/server/dist/server.js /opt/universe-update-server/server.mjs
sudo systemctl restart universe-update-server
systemctl status universe-update-server          # 确认 active (running)
```

### Windows（管理员 PowerShell）

```powershell
Copy-Item scripts\server\dist\server.js C:\universe-editor\app\server.mjs -Force
schtasks /End /TN UniverseUpdateServer           # 先停旧实例，避免端口占用
schtasks /Run /TN UniverseUpdateServer           # 用新文件起进程
```

> 重跑 `setup.sh install` / `setup.ps1 install` 也会重新拷文件，但对**已运行**的服务不一定重启进程
> （systemd `enable --now` 不重启 active 服务；Windows `/Run` 可能与旧实例抢端口），所以仍需显式
> `restart` / `End`+`Run`。只改了 `server.mjs`、没动端口/base 时，上面这套「拷文件 + 重启」最干净，
> 不动 unit、防火墙与目录权限。
>
> 若改动**新增了发布目录里的静态资源**（如下载页 `index.html`、`release-notes.json`），重启 server 只是让它
> 能服务这些文件；文件本身要进发布目录——下次 `release:upload` 会自动同步，想立刻生效可手动 `scp` 一次。

完成后用下一节的 `curl` 验证。

---

## 七、验证

服务器本机（把 `<name>` 换成实际 .blockmap 文件名）：

```bash
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
  任务以 SYSTEM 跑、cwd 为 system32，脚本已用全绝对路径规避。
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
- 上传体积上限 `--max-vsix-size`（默认 128MB）。限流未做（内部信任环境），公开前见公开阶段清单。
- 版本不可变：同版本重发一律 409，改内容必须 bump version——服务端强制，无例外。

验证（token 签发后）：

```bash
curl -i http://localhost/universe-editor/gallery/api/whoami -H "Authorization: Bearer uet_xxx"   # 200 {"publisher":"acme"}
```
