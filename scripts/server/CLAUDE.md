# scripts/server

Universe Editor 的**更新分发 + 扩展市场后端**：单文件 Node 服务器（零外部依赖的 esbuild 产物）
+ 跨平台一键安装脚本（Ubuntu systemd / Windows schtasks）+ 一条指令部署。

使用手册（搭建步骤、运维命令、排错、market token 运维）在 [`README.md`](./README.md)；
本文件只讲**改这里的代码时必须知道的约束**。

## 文件职责

| 文件 | 跑在哪 | 职责 |
|---|---|---|
| `server.mjs` | 服务器 | 服务核心：静态更新分发（Range/差分/no-store）+ 市场路由（`/extensionquery`、`gallery/**`、publish/admin API） |
| `galleryPublish.mjs` | 服务器 | 自助发布 + 审批管理 API。被 `server.mjs` 在命中 `gallery/api/*` 时 lazy import |
| `registerPage.mjs` / `adminPage.mjs` | 服务器 | 内嵌 HTML 页面（零外部资源） |
| `pageStyles.mjs` | 服务器 | 两页面共享的深色基础样式（与下载页同一套令牌；下载页是静态 HTML 无法 import，令牌各存一份，改主题两边同步） |
| `download-page/index.html` | 开发机 → 发布根 | 面向用户的静态下载页（发布目录数据文件，**不进 bundle**）。首装由 `setup.mjs` 落到 `<UE_SERVER_ROOT>/index.html`，之后 `server:deploy` 随 `SERVER_VERSION` 同步（staged `index.html.v*`，sudoers 第三条 cp 通道） |
| `serverEnv.mjs` | **两边** | 运行时配置的单一事实源：白名单、默认值派生、`server.env` 读写、deploy 免密 sudoers 规则文本 |
| `setup.mjs` | 服务器 | 装服务：拷产物 / 写 `server.env` / 注册服务 / 自动生成机密 / 防火墙 / 启停卸载 / `--deploy-user` 写 deploy sudoers |
| `setup.sh` / `setup.ps1` | 服务器 | 平台入口：装 Node → 调 `setup.mjs` |
| `bundle.mjs` | 开发机 | esbuild 打包 `dist/server.js`；`--env <mode>` 时一并生成 `dist/server.env` |
| `deploy.mjs` | 开发机 | 一键部署：比对版本 → 打包 → scp → 远端安装重启 → 健康检查 |
| `setupRemote.mjs` | 开发机 | 远程首装/运维：tar+scp 上传 → 远端解包 → ssh 提权首装（Linux `-t` 就地输 sudo 密码，Windows 探测 node 二选一）→ 健康检查；`--action status/restart/uninstall` 直发原生命令 |
| `remoteShell.mjs` | 开发机 | `deploy`/`setupRemote` 共用：Windows 远端默认 shell 探测（`echo %comspec%` 判别）与 ssh 参数构造（非交互一律 `-n`） |

## 🔴 三条红线

**1. `serverEnv.mjs` 与 `setup.mjs` 只能用 node 内置模块。**
它们的运行场景是「`scripts/server/` 整目录拷到服务器执行」——那里没有仓库根、没有 `node_modules`。
所以**不能 `import '../lib/env.mjs'`**（`parseEnvText` 因此在 `serverEnv.mjs` 有一份刻意的副本）。
`bundle.mjs` / `deploy.mjs` 跑在开发机，可以正常用 `loadEnv` 等仓库设施。

**2. `--auth-dir` 绝不能落在 `--root` / `--gallery-root` 之内。**
`gallery/**` 是公开静态命名空间，publish token 哈希表进去等于公开下载。
`server.mjs` 启动自检命中即拒绝启动，别把这个检查删了。`setup.mjs` 首装在写 `server.env` 前会
用 `serverEnv.mjs` 的 `findAuthDirConflict` 做**同语义**预判（当场报错，杜绝「服务启动即崩 + run.cmd
吞输出」的假成功）——如果改 `server.mjs` 的判定逻辑，两边要同步。

**3. 签名私钥与 admin token 只存服务器文件，配置里只写路径。**
`serializeServerEnv` 遇到含换行的值直接抛错——systemd `EnvironmentFile` 与 cmd `set` 都不支持多行值，
而 Ed25519 私钥是多行 PEM。想"图方便直接把私钥塞进环境变量"是走不通的，也不该走通。

## 配置怎么流动

```
开发机 .env.<mode>  ──bundle --env / deploy──►  server.env  ──►  服务进程环境变量
                     （renderServerEnv 共用）      ▲                （server.mjs 认 UE_SERVER_*）
                                        systemd EnvironmentFile
                                        Windows run.cmd 逐行 set
```

- **`.env` → `server.env` 的转换固定发生在开发机**，因为服务器上没有 `.env`。首装走
  `pnpm server:bundle -- --env prod`（产物随包拷过去），部署走 `server:deploy`（内部透传 `--env`
  给 bundle）。两条路共用 `renderServerEnv`，同一份 `.env` 产出逐字节相同的结果。
- 优先级 `CLI 旗标 > server.env > 平台默认`；`server.env` 查找顺序
  `--env-file > dist/server.env > 同目录 > 安装目录已有的那份`（最后一个让不带参数重跑 install 不丢配置）。
- **加新 `UE_SERVER_*` 配置项必须同步往 `SERVER_ENV_KEYS` 加**，否则 bundle/deploy 不会把它搬上服务器。
  部署侧参数（`UE_SERVER_APP_DIR` / `UE_SERVER_HEALTH_URL`）前缀相同但**刻意不在白名单**——它们是
  deploy 自己用的，不是服务运行时配置。
- bundle 不带 `--env` **不生成** `server.env`（默认 mode 是 `dev`，静默把开发配置打进生产包很危险），
  且会清理上次留下的产物防陈旧配置误拷。

## Windows 服务化的三个坑（改 `installWin` 前必读）

1. **`schtasks /TR` 有 261 字符上限** → 完整命令行放进 `<appDir>\run.cmd`，任务只指向启动器。
2. **Task Scheduler 下 cmd 传给 node 的 stdout 句柄无效**，node 一写启动横幅就 `EBADF` 崩（退出码 1）
   → `run.cmd` 末尾的 `>nul 2>&1` **必须保留**。也别改成重定向到文件：server 有每请求访问日志，长跑必无界增长。
   排查启动失败时手动跑 `run.cmd`（临时去掉重定向）即可看到输出。
3. **`schtasks /End` 杀进程是异步的**，紧跟 `/Run` 会撞上旧实例尚未释放的端口（EADDRINUSE）
   → 本地用 `waitForTaskEnd()` 轮询 `Get-ScheduledTask` 的 `State`；远端（deploy）用 `ping -n 3` 垫 ~2s
   （`timeout /t` 在 ssh 的重定向 stdin 下会报错）。

另外 `run.cmd` 加载配置用的是
`for /f "usebackq eol=# tokens=1* delims==" %%a in ("...") do if not "%%a"=="" set "%%a=%%b"`——
`tokens=1*` 保证 base64 令牌里的 `=` 与空格不被截断，`eol=#` 跳过注释行。已实机验证，别随手简化。

## 远端命令字符串的四条坑（ssh 直发的命令构造，改 builders 前必读）

1. **cmd 的 `if` 会把同行的 `&` 绑进自己的命令体**：`if not exist X mkdir X & tar ...`
   在 X 已存在时整条 tar 被**静默跳过**且退出码 0——远端解包因此绝不用 if，
   先 `rmdir /s /q 2>nul &` 容错清残留再 `mkdir && tar`。
2. **带引号的远端命令在 cmd 与 PowerShell 两种默认 shell 间无兼容写法**（实机验证：
   `cmd /c "..."` + 引号翻倍经 Win32-OpenSSH 送达 cmd 会被去引号拆词；裸引号在
   PowerShell 下被拆词）。所以命令保持 cmd 语法裸引号，并以 `echo %comspec%`
   前置探测（cmd 展开成 cmd.exe 路径，其它 shell 原样回显字面量），非 cmd 立即
   报错+修复指引（remoteShell.mjs）。
3. **Win32-OpenSSH 非交互 ssh 可能退出挂起**（`close - IO is still pending on closed
   socket`：scp 上是无害告警，ssh 上会整进程卡死无输出）。非交互调用一律 `-n`
   （stdin=nul；密码/host-key 确认走 TTY 不受影响），只有 Linux sudo 交互用 `-t`；
   且每个远端单步设了墙钟 timeout，挂死必然报错而不是无限等。
4. **重装（已安装 + --force）顺序**：setup.mjs `installWin` 先 `schtasks /End` + 等停
   再覆盖 `server.mjs`/`run.cmd`，避免文件占用与 cmd 流式读到半截批文件；Linux 侧
   靠 unlink 语义不受影响，restart 收尾即可。

## 改动后要做什么

- **改了 `server.mjs` / `galleryPublish.mjs` 的行为 → 顶部 `SERVER_VERSION` +1**（手动维护）。
  启动横幅与健康检查响应都带它；`server:deploy` 部署前会比对远端版本，相同（疑似忘 bump）
  或远端更新（疑似降级）都会拦下。
- 部署前 `pnpm server:bundle`——服务器跑的是打包产物，改源码不重新打包等于没改。
- 测试：`node --test scripts/server/__tests__/<x>.test.mjs`。注意 `dist/server.env` 参与 setup 的
  查找顺序，本机残留会污染用例（`setup.test.mjs` 用 before/after 全程移开再还原）。
  并行跑整个 `__tests__/*.test.mjs` 时 publish-api 有已知的测试间状态冲突，逐文件跑是干净的。

## 客户端信任链（改签名相关代码时）

服务端签名的 keyId 必须与**客户端内置公钥**对齐：
`apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts`。
客户端遇到未知 keyId 一律 `unknown-key` **拒装**（fail-closed），所以密钥轮换顺序是：
生成新 key → 加进内置表并**保留旧 id** → 客户端铺量 → 最后才把服务端 `UE_SERVER_SIGNING_KEY_ID` 切过去。
`setup install` 时机密文件不存在会自动生成（0600）并一次性打印公钥与内置指引。

## 兼容性提醒

`deploy` 的远端安装命令先后新增了 `server.env` 与 `index.html` 两条 cp 通道（后者落
`<UE_SERVER_ROOT>/index.html`），**老部署的 sudoers 规则只覆盖 `server.js`，不更新会在安装步骤失败**
（deploy 已带精确 hint；带 `--deploy-user` 重跑 `server:setup` 首装也会自动补齐——
`setup.mjs` 每次 install 都重写这条规则）。`server.env` 通道急着发版可先用 `--skip-env` 跳过；
`index.html` 通道无开关。
