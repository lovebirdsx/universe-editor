# 发布与内网更新服务器

Universe Editor 通过 **electron-updater 的 generic provider** 从内网静态 HTTP 服务器拉取更新。
本目录的 `upload.mjs` 负责把打包产物同步到该服务器。

整体链路：

```
开发机 (Windows)                         内网服务器 (Ubuntu + nginx)        客户端
  pnpm package:win  ──►  apps/editor/release/   ──upload.mjs(scp)──►  /srv/universe-editor/  ──HTTP──►  autoUpdater
                         ├─ *.exe                                     ├─ *.exe
                         ├─ *.blockmap                                ├─ *.blockmap
                         └─ latest.yml                                └─ latest.yml  ← 客户端先读这个比对版本
```

---

## 一、搭建内网静态服务器（Ubuntu Server）

> 💡 **更省心的跨平台一键方案见 [`../server/README.md`](../server/README.md)**：自带零依赖 Node 服务器
> + 一键安装脚本，**Ubuntu 和 Windows 都能从0搭起并注册成开机自启服务**，已处理好 Range/差分
> 下载与 latest.yml 禁缓存。本节的 nginx 手动方案适合**已有 nginx 的 Linux 机器**，与之二选一即可。

只需要一个能提供静态文件的 HTTP 服务即可。下面用 nginx，最省心。

### 1. 安装 nginx

```bash
sudo apt update
sudo apt install -y nginx
```

### 2. 建发布目录并授权给上传账号

假设上传用账号为 `deploy`：

```bash
sudo mkdir -p /srv/universe-editor
sudo chown -R deploy:deploy /srv/universe-editor
```

### 3. 配置 nginx 站点

新建 `/etc/nginx/sites-available/universe-editor`：

```nginx
server {
    listen 80;
    server_name _;            # 内网直接用 IP 访问可留 _，有域名则填域名

    # 与 electron-builder.yml 里 publish.url 的路径段保持一致：
    #   url: http://<服务器IP>/universe-editor/
    location /universe-editor/ {
        alias /srv/universe-editor/;
        autoindex off;

        # latest.yml 是清单，禁止缓存，确保客户端总能拿到最新版本信息。
        location ~ \.yml$ {
            alias /srv/universe-editor/;
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            expires -1;
            try_files $uri =404;
        }
    }
}
```

> 说明：`alias` 末尾斜杠要和 `location` 对应。若把 `publish.url` 设为根路径
> `http://<IP>/`，把 `location /universe-editor/` 改成 `location /` 即可。

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/universe-editor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default     # 可选：去掉默认站点
sudo nginx -t                                    # 校验配置
sudo systemctl reload nginx
```

### 4. 放行防火墙（如启用了 ufw）

```bash
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp     # 上传脚本走 SSH/SCP
```

### 5. 验证

服务器本机：

```bash
echo ok | sudo tee /srv/universe-editor/ping.txt
curl http://localhost/universe-editor/ping.txt    # 应输出 ok
sudo rm /srv/universe-editor/ping.txt
```

开发机浏览器访问 `http://<服务器IP>/universe-editor/`，能连通即可。

---

## 二、把服务器地址写进打包配置

编辑 `apps/editor/electron-builder.yml`，把占位 url 换成真实地址（务必与 nginx `location` 对应）：

```yaml
publish:
  provider: generic
  url: http://<服务器IP>/universe-editor/
  channel: latest
```

> 暂未做代码签名，安装时 Windows SmartScreen 会提示“未知发布者”，点“更多信息 → 仍要运行”即可。
> 后续接入证书后，自动更新无需改动客户端逻辑。

---

## 三、发布一个新版本（三步）

```bash
# 1) bump 版本（apps/editor/package.json 的 version，遵循 semver）
#    例如 0.1.0 → 0.1.1

# 2) 打包，产物落到 apps/editor/release/
pnpm --filter @universe-editor/editor package:win

# 3) 上传到内网服务器（在 PowerShell 或 cmd 中运行）
pnpm release:upload --host <服务器IP> --user deploy --dir /srv/universe-editor
```

> ⚠️ **Windows 用 PowerShell / cmd 运行上传命令，不要用 Git Bash。** Git Bash（MSYS）会把
> `--dir /srv/universe-editor` 这类以 `/` 开头的远程路径自动改写成本地 Windows 路径
> （`C:/Program Files/Git/srv/...`），导致文件传到错误位置。
> 必须在 Git Bash 里跑时，加 `MSYS_NO_PATHCONV=1` 前缀规避：
> `MSYS_NO_PATHCONV=1 pnpm release:upload --host … --dir /srv/universe-editor`

客户端会在下次启动检查（或命令面板执行 **Check for Updates**）时，从
`http://<服务器IP>/universe-editor/latest.yml` 发现新版本，弹提示 → 下载 → 重启安装。

> **历史版本不要删**：保留旧的 `.exe` 与 `.blockmap`，electron-updater 的差分下载
> 需要它们；同时也方便回滚（把 `latest.yml` 换回旧版本即可降级）。

---

## 四、`upload.mjs` 用法

```bash
node scripts/release/upload.mjs --host <IP> --user <user> --dir <远程目录> [选项]
# 或经 npm script
pnpm release:upload --host <IP> --user <user> --dir <远程目录> [选项]
```

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--host` | `UE_RELEASE_HOST` | （必填） | 服务器 IP / 域名 |
| `--user` | `UE_RELEASE_USER` | （必填） | SSH 登录账号 |
| `--dir`  | `UE_RELEASE_DIR`  | （必填） | 服务器上的发布目录（如 `/srv/universe-editor`） |
| `--port` | `UE_RELEASE_PORT` | `22` | SSH 端口 |
| `--key`  | `UE_RELEASE_KEY`  | — | SSH 私钥路径（用密钥登录时） |
| `--remote-os` | `UE_RELEASE_OS` | 自动 | 远端系统 `linux`/`windows`，默认按 `--dir` 形态自动判断 |
| `--dry-run` | — | — | 只打印将执行的命令，不实际上传 |
| `--no-mkdir` | — | — | 跳过远程建目录（目录已存在且账号无创建权限时用） |

脚本依赖系统自带的 `ssh` / `scp`（Windows 10+、Ubuntu 均内置 OpenSSH），无第三方 npm 依赖。

> **目标为 Windows 服务器时**：`--dir` 直接写 `D:\universe-editor`（无需尾斜杠，带了也会自动去掉）。
> 脚本检测到盘符/反斜杠会自动用 `cmd /c if not exist … md …` 建目录（兼容远端 cmd 与 PowerShell），
> 且“目录已存在”只告警不中断。判断有误时可用 `--remote-os windows|linux` 显式覆盖。

**上传顺序**：先传 `.exe` / `.blockmap`，最后才传 `latest.yml` —— 保证客户端读到清单时安装包已就位，避免拉到半包。

环境变量方式（适合写进 CI 或本地 shell profile）：

```bash
export UE_RELEASE_HOST=10.0.0.5
export UE_RELEASE_USER=deploy
export UE_RELEASE_DIR=/srv/universe-editor
pnpm release:upload          # 不必再带参数
```

先看会执行什么，不实际传：

```bash
pnpm release:upload --host 10.0.0.5 --user deploy --dir /srv/universe-editor --dry-run
```

---

## 五、常见问题

- **产物文件名带空格**（`Universe Editor-0.1.1-win-x64.exe`）：脚本已正确处理（scp 目标为目录、参数数组传递，无需手动转义）。若想更省心，可把 `electron-builder.yml` 的 `artifactName` 改为无空格，例如 `universe-editor-${version}-${os}-${arch}.${ext}`。
- **客户端检查不到更新**：确认 `electron-builder.yml` 的 `publish.url` 与 nginx `location` 路径一致；浏览器能否直接打开 `…/latest.yml`；客户端版本是否确实低于 `latest.yml` 里的 `version`。
- **本地联调**（不必真有内网服务器）：`pnpm server:serve` 起本地服务器（`apps/editor/dev-app-update.yml` 已指向 `http://localhost:8788/`），跑未打包构建即可走完检查→下载→重启全链路。详见 [`../server/README.md`](../server/README.md) 第四节。
- **GitHub Actions 推不进内网**：CI 只产出 `release/` artifact；上传这一步在能访问内网的机器上跑本脚本（或配置内网自托管 runner）。
