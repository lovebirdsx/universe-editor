---
name: remote-dev-v2-full-stack
description: remote 开发 v2 全栈落地——daemon+TCP+PersistentProtocol、终端/exthost/ACP 迁远端、WSL 实机验收要点
metadata: 
  node_type: memory
  type: project
  originSessionId: eb9da09e-9e55-414b-81dd-97a9a92fd7d9
  modified: 2026-08-20T11:05:00.000Z
---

remote 开发 v2（2026-08-14 完成，取代 [[remote-dev-phase1-remote-server]] 的 stdio-over-ssh 形态）：R1 传输层（常驻 daemon 监听远端 127.0.0.1+token、ssh -L 转发、13B 帧+二进制附件 codec、PersistentProtocol seq/ack 重放透明重连、URI 互译在 server 侧 per-connection codec）→ R2 UI（Remote Explorer/状态栏/三段式重连通知）→ R3 远端终端（pty 核心下沉 node-services）→ R4 extension host 迁远端（第二条 TCP 字节隧道，host 进程内挂 createJsonCodec 换行安全 transformer——renderer⇄host 是换行分帧 JSON，**binaryCodec 不换行安全不可用**）→ R5 ACP 迁远端（spawn/acpTerminal/agentConfig 按 authority 路由，凭据远端自行登录不过隧道）。

**Why**: 终端/ACP/exthost 是有状态长会话，Phase 1 断线即死+JSON base64+client 手工互译撑不住。

**How to apply**:
- 契约单一真相 `platform/src/remote/remoteProtocol.ts`；channel DTO 路径一律 URI，字符串路径例外（watcher fsPath、AcpLaunchSpec.cwd）须在该文件文档化。
- vendor agent 随 bundle 只带 dist+manifest（~3MB），远端部署对每个 vendor 目录 `npm ci --omit=dev`——**绝不 scp node_modules**（950MB 且含本机平台二进制如 lightningcss-win32）。
- server 侧事件 Emitter 若在 client 订阅前 fire 会静默丢（高负载下丢 seq 0 的流式 chunk）——早发事件的服务用 platform BufferedEmitter。
- 大 enum 跨包（apps/editor isolatedModules）不能用 const enum，ProtocolMessageType 等已改普通 enum。
- WSL 实机坑：Windows 自带 sshd 抢 22 端口，`localhost` 连不到 WSL sshd——用 `wsl hostname -I` 的虚拟网卡 IP；WSL 用户 shell 是 zsh 时非交互 ssh 读 `~/.zshenv` 不读 .bashrc（node≥20 的 PATH 注入写 zshenv，标记 `# universe-remote-node`，勿当验收垃圾清掉）；WSL 闲置自动关机，保活必须 Windows 侧 `wsl -- sleep 7200`（持 Windows 句柄）——ssh 进去 nohup 的后台进程挡不住关机；authorized_keys 权限须 600（755 被 sshd StrictModes 拒）；WSL TARGETS 直连（wsl.exe -e bash -lc）下 nvm 装的 node 不可见（bashrc 交互早退，login shell 读不到 nvm init）→ 报 `node: command not found`，修法=把 `~/.nvm/versions/node/<ver>/bin/{node,npm,npx}` 符号链接进 `~/.local/bin`（Ubuntu 默认 ~/.profile 目录存在即入 PATH，免 sudo，2026-08-15 实机验证）。
- 实机验收还揪出三类「直连模式测不出」的 bug：① renderer 终端 profile 探测不带 folder → 把本机 pwsh.exe 路径发给 Linux 远端，pty 秒退→input 报 unknown terminal（修=profile 探测按工作区路由+远端 OS 感知 defaultProfile）；② UNIVERSE_ENABLED_EXTENSIONS 没转发远端 host env → perforce 被误激活且其 p4 探针无超时，在不可达 P4PORT 上挂起阻塞整个激活链，typescript 永不激活 hover 空（修=allowlist 转发+探针 15s watchdog）；③ reconnecting 中关 app 退出被顶 10 秒（修=dispose 销毁 in-flight 重连 socket+握手定时器 unref）。教训：**有状态子系统（终端/exthost/激活链）必须真实跨 OS 验收，直连模式本机同构会掩盖路径/平台/环境泄漏三类错**。
- deploy 链的 tar/scp 本地参数**绝不能含盘符冒号**：GNU tar/scp 把 `C:\...` 当 host:file 远程语义（`Cannot connect to C: resolve failed`），而 PATH 命中 GNU tar 还是 System32 bsdtar 因环境而异（手动 shell 能过、Electron main 里挂）——统一 cwd=tmpdir + 裸文件名（remoteDeploy.ts，有单测守护）。
- 远端部署按 **bundle 内容哈希自愈**（2026-08-15 加，起因=旧部署发字符串 extensionLocation 炸掉新 renderer 的贡献注册、grammar 23→0）：dev 版本恒 0.0.0 比不出新旧，deploy 时写 `bundle.hash` 到部署目录、`bootstrap.js check` 无条件回报（旧部署无该行→判过期），`_ensureDaemon` 哈希/版本任一不匹配即 stop→deploy→start；`UNIVERSE_REMOTE_SKIP_DEPLOY_CHECK=1` 跳过。dist-bundle 由 `pnpm dev`/`dev:run` 自动保鲜：预检 `scripts/dev/ensure-remote-server-bundle.mjs`（输入面 mtime 指纹 stamp-skip，warm ~20ms）+ dev 会话内 `esbuild --watch --bundle` 子进程持续跟新；仅在两条 dev 入口之外改代码后手动 `pnpm --filter @universe-editor/remote-server bundle`（worktree 无 dist-bundle 时哈希比对 fail-open 静默跳过，自愈不生效）。同批修复：贡献注册按扩展×贡献类型隔离（ExtensionPointTranslator._guardContribution），一个扩展炸不再拖垮全部。
- **发布版打包**（2026-08-15 补）：runtime:stage 把 dist-bundle 拷进 `resources/remote-server` 并**改写其 package.json version 为 app 版本**——version 契约=daemon 从部署目录 package.json 回报版本、client 每次连接比对不匹配即全量重部署，staged bundle 留 0.0.0 而 client 用 app.getVersion() 会每连必重部署死循环；运行时 main-services 组装处按 `app.isPackaged` 注入 `{bundleDir: resources/remote-server, serverVersion: env??app.getVersion()}` 给 RemoteDeployer/WslDeployer（remoteDeploy.ts 保持纯 node，勿在里面 import electron）。
- **协议 bump 必须纳入 daemon 自愈决策**（2026-08-20 补，起因=v5→v6 后 WSL 旧 daemon 挡锁报 `protocol version 6 != 5`）：跨版本共享 `~/.universe-editor-server/{daemon.lock,server.json}`，旧 daemon 活着时 `bootstrap.js start` 轮询读到旧 server.json+pid 存活就冒充成功（不查版本）→ 客户端拿旧端口握手被拒且无重装路径。修=四层：① startDaemon 校验协议/版本不匹配即抛含 `stale daemon already running` 的错误；② classifyCheckResult 按 stderr `version-mismatch:` 把 exit 3 拆成新 state `stale`（区别于 not-running）；③ `_ensureDaemon` running 分支加 protocolVersion 判据、`stale` 分支 stop→(hash 过期才 deploy)→start、`_startDaemonWithRecovery` 对撞锁/报 stale 的 start 做 stop+重试一次；④ `_bringUp` 握手 versionMismatch 兜底 stop+重走一轮（限一次，direct 模式除外）。教训：**bump 协议号时重装决策链必须同步把 protocolVersion 当一等判据，握手失败才算最后防线而非唯一防线**。
