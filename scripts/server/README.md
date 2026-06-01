# 自建更新服务器（跨平台一键 · 服务化）

Universe Editor 通过 **electron-updater 的 generic provider** 从一个**静态 HTTP 服务器**拉取更新。
本目录提供一套**零依赖 Node 服务器 + 一键安装脚本**，可在 **Ubuntu 和 Windows** 上从0搭起，并注册成
**开机自启的后台服务**。

> 与 `scripts/release/README.md` 里的 **nginx 手动方案二选一**：那套适合已有 nginx 的 Linux 机器；
> 本套适合「裸机、一键、跨平台、Windows 也要」的场景，自带 Range/差分下载与禁缓存处理。

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
| `server.mjs` | 零依赖静态服务器核心。两平台共用。处理 latest.yml 禁缓存、Range/多段 Range（差分下载）、路径穿越防护。 |
| `setup.mjs` | 跨平台部署逻辑（按平台分支）：拷文件 / 注册服务 / 防火墙 / 启停 / 卸载。 |
| `setup.sh` | **Ubuntu 入口**：自检 root → 装 Node（缺则装）→ 调 `setup.mjs`。 |
| `setup.ps1` | **Windows 入口**：自检管理员 → winget 装 Node → 调 `setup.mjs`。 |

服务化方式：**Ubuntu = systemd**（`universe-update-server`），**Windows = 计划任务**（`UniverseUpdateServer`，开机触发）。

---

## 一、搭建（在服务器上）

把本目录（`scripts/server/`）整个拷到服务器任意位置，然后：

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
| 发布目录（产物落地） | `/srv/universe-editor` | `C:\universe-editor\data` |
| 端口 | `80` | `80` |
| URL 前缀（`--base`） | `/universe-editor/` | `/universe-editor/` |

可用 `--root` / `--port` / `--base` 覆盖。

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

> **历史版本不要删**：保留旧 `.exe` / `.blockmap`，electron-updater 的差分下载需要它们，也方便回滚。

---

## 四、本地联调（不必真有服务器）

`apps/editor/dev-app-update.yml` 默认指向 `http://localhost:8788/`（base 为 `/`），所以联调用 `--base /`：

```bash
pnpm server:serve                  # = node scripts/server/server.mjs --root apps/editor/release --port 8788 --base /
```

配合未打包的 dev 构建，可走完 检查 → 下载 → 重启安装 全链路。

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

## 六、验证

服务器本机（把 `<name>` 换成实际 .blockmap 文件名）：

```bash
curl -i http://localhost/universe-editor/latest.yml          # 200，响应头含 no-store
curl -r 0-99 -i http://localhost/universe-editor/<name>      # 206 + Content-Range
curl -r 0-99,200-299 -v http://localhost/universe-editor/<name>   # 206 multipart/byteranges
curl -i http://localhost/universe-editor/../../etc/passwd    # 403/404（穿越防护）
```

---

## 七、排错

- **客户端检查不到更新**：确认 `publish.url` 路径段与 `--base` 一致；浏览器能否直接打开 `…/latest.yml`；
  客户端版本是否确实低于 `latest.yml` 的 `version`；latest.yml 响应头是否 `no-store`。
- **80 端口 EACCES（Ubuntu）**：unit 已配 `CAP_NET_BIND_SERVICE`；若仍失败，改用高位端口 `--port 8080`
  并同步改 `publish.url`。
- **Windows 计划任务起不来**：`schtasks /Query /TN UniverseUpdateServer /V /FO LIST` 看上次结果；
  任务以 SYSTEM 跑、cwd 为 system32，脚本已用全绝对路径规避。
- **内网无外网装不了 Node**：Ubuntu 用官方 tar.xz 离线包解到 `/usr/local`；Windows 用离线 MSI。装好后
  重跑 `setup.sh` / `setup.ps1` 即可（会跳过安装步骤）。
- **GitHub Actions 推不进内网**：CI 只产出 `release/` artifact；上传与搭建在能访问内网的机器上做。
