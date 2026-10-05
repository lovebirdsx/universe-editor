# 远程开发（remote-ssh / WSL）

VSCode Remote 式远程开发：本机跑 UI，远端跑 daemon + 文件 / 搜索 / watcher / 终端 / extension host / agent。
本文是本域的**单一入口**——传输与自愈、URI 与 authority 语义、Windows / WSL 远端主机、远端终端、
extension host、agent 二进制、连接状态与实机验收的机制与坑。逐目录的运行时细节在代码头注释里
（本文只给索引 + 锚点）；扩展安装侧的远端路由另见
[extensionManagement 远程路由案例](../../apps/editor/src/main/services/extensionManagement/cases-remote-routing.md)。

## 1. 架构与传输层

形态一句话：远端常驻 daemon + TCP，client 经 `ssh -L` 转发；WSL 直连不走 ssh（`wsl.exe -e bash -lc` +
localhost 转发）。传输形态 / 重连语义 / 帧与 codec 的**事实来源**是
`packages/platform/src/remote/remoteProtocol.ts` 头注释、`packages/platform/src/ipc/persistentProtocol.ts`、
`packages/platform/src/ipc/codec.ts`，根 `CLAUDE.md` 的远程开发行给了全局索引——本节只写这三处没有的。

**Phase 0 地基（先有 scheme 抽象，才谈远端）**：`packages/platform/src/files/fileSystemProvider.ts` 新增
`IFileSystemProvider` + `FileSystemProviderRegistry`，`FileService` 按 `uri.scheme` 分派；
`FileSystemMainService` 瘦身为 `extends FileService` 并注册 `LocalFileSystemProvider`（原 `node:fs` 实现下沉），
对外 IPC 契约与 DI 注册不变。`IFileService.listRecursive` 返回类型 `string[]` → `URI[]`——裸字符串路径
在远端必然含糊「这是谁的机器上的路径」，换成 URI 后调用方不再有歧义。

**路由为何落在 main 侧**：Phase 0 的 scheme 分派 FileService 使路由天然落在 main——renderer 的文件族服务
本就是 main 代理，于是放弃原计划的 renderer `RemoteChannelRouter`。URI 互译收口
`apps/editor/src/main/services/remote/remoteUri.ts`（薄再导出，实现在
`packages/platform/src/remote/remoteUri.ts`，`remote-ssh` ↔ `file`），server 侧**零 scheme 感知**，
Phase 0 的守卫逻辑原样复用。

**加一个远端能力的配方**：server 端 `packages/remote-server/src/` 的 `createRemoteServer` 加 channel
（契约写进 `remoteProtocol.ts`，**必须 bump `REMOTE_PROTOCOL_VERSION`** 并按该文件既有体例写清「旧 daemon
会静默给出什么错答案」）+ main 侧 wrapper 加 remote 分支；authority 尾参路由再叠在这之上。取远程 channel
一律走 `IRemoteConnectionService.getServiceProxy`（勿自缓存代理，见根 `CLAUDE.md` 远程行）。

**协议 bump 必须纳入 daemon 自愈决策链**（2026-08-20 v5→v6 事故）：跨版本共享
`~/.universe-editor-server/{daemon.lock,server.json}`，旧 daemon 活着时 `bootstrap.js start` 轮询读到旧
`server.json` + pid 存活就**冒充成功**（它不查版本），客户端拿旧端口握手被拒且没有任何重装路径。四层修法：

1. `startDaemon` 校验协议 / 版本不匹配即抛含 `stale daemon already running` 的错误；
2. `classifyCheckResult` 按 stderr `version-mismatch:` 前缀把 exit 3 拆成新 state `stale`（区别于 `not-running`）；
3. `_ensureDaemon` 的 running 分支加 `protocolVersion` 判据、`stale` 分支走 stop →（hash 过期才 deploy）→ start；
   `_startDaemonWithRecovery` 对撞锁 / 报 stale 的 start 做 stop + 重试一次；
4. `_bringUp` 握手 `versionMismatch` 兜底 stop + 重走一轮（限一次，direct 模式除外）。

教训：**bump 协议号时，重装决策链必须同步把 `protocolVersion` 当一等判据——握手失败是最后防线，不是唯一防线**。
（以上符号都在 `apps/editor/src/main/services/remote/remoteConnectionMainService.ts`，
daemon 侧握手错误码在 `packages/remote-server/src/bootstrap.ts`。）

**包装层转发基类事件，基类 emitter 必须是 `protected`**：ES2022 类字段语义下子类拿不到 `super.field`。
node-services 的 `TextSearchService` 把 `_onDidSearchProgress` / `_onDidSearchResults` 声明为 `protected`，
`TextSearchMainService` 才能靠它把本地与远端两条路的事件合并转发。

## 2. URI 互译与 authority 规范形

**DTO 路径一律 URI**：client 发 `remote-ssh://<authority>/<path>` **原样不译**，server 在 per-connection codec
里挂 `URITransformer`（decode: remote-ssh→file，encode: file→remote-ssh），于是 server 侧仍是一台「无头的
本地 file service」，client 永不手工互译。铁律：**channel DTO 里每个路径都必须是 URI**（`UriComponents` 带
`$mid`），裸字符串不会被变换。例外清单（watcher 事件的 server fsPath、`AcpLaunchSpec.cwd`、LSP wire 类型、
`AgentBinary.resolve` 的 native path、`IMainThreadFs` 的 `$` 方法）**逐条写在 `remoteProtocol.ts` 头注释里，
改协议前先读那儿**，此处不复制。

**authority 规范形 = WSL distro 小写**：收敛入口 `normalizeRemoteAuthority`（platform `remoteProtocol.ts`，
非 wsl 原样返回——ssh Host alias 大小写敏感，勿动）。归一化**只在两类边界**做：① `RemoteConnectionMainService`
的各公开入口；② 远程工作区 URI 进入 main 的打开 / 恢复 / recent 读写处（现收口 `canonicalizeWorkspaceFolderUri`，
两处折叠的完整说明见 `remoteUri.ts` 头注释）。下游一律消费规范形，**勿散写 `toLowerCase`**——不归一时
`wsl+Ubuntu-24.04` 与 `wsl+ubuntu-24.04` 会裂成两条 target 行。

**Remote Explorer 的 target 行**：侧栏 2026-08-15 把 4 个平铺 view（SSH Targets / WSL Targets / Connections /
Recent）合并为单一 `workbench.view.remote.targets`（"Targets"）树，构建是纯函数 `buildRemoteTree`
（`apps/editor/src/renderer/workbench/remote/remoteTree.ts`）。合并的 rationale：Connections 与 Targets 语义重复
（绿点即连接态）；Recent 只显示 basename 易重名。**authority 归一是这棵树的前置**——不归一，同一个 WSL 发行版
会在树上裂成两条 target。

**main / platform 优先加 scheme 守卫，而不是重写实现**：ripgrep 搜索、parcel watcher、项目 settings、
跳转列表、变量替换这些服务，在远端场景下会被远端 server 的**同名服务整体取代**；现在按远端需求重写是空转，
加守卫保证远端接入时 **fail loud** 即可。

**同一语义可能有两条独立供给路径，守一条不够**：`variableResolver` 的私有 `fsPath()` 加了守卫，但
`ConfigurationResolverService.getFilePath()` 是**另一条**供给 `${file}` 的通道、直接返回 `resource.fsPath`，
绕开了守卫（现已加 `scheme !== 'file'` 守卫 + 注释）。审校时要**顺着契约找全供给方**。

**`.fsPath` → `.path` 会在 Windows 多出前导斜杠**（`D:/a` → `/D:/a`）：比较层无碍（`relativePathUnder` 在
win32 整体 toLowerCase），但**所有拿它做字符串前缀匹配的对侧必须同步换**——
`workbench/files/resourceInfo.ts` 的 `dirnameOfResource` 与 `SessionChangesView.rootDir` 就是一对（已同步）。

**两类不可动的契约**：

- `extension-api` 的 `Uri.fsPath` / `RelativePattern.base` 对齐 VSCode `vscode.d.ts`，是**公开 SDK 契约**，
  改了破坏第三方插件兼容；
- extension host 眼里的「本机」**是它自己所在的机器**（它整个搬到远端），所以它读扩展安装目录、spawn
  tsserver 用 `fsPath` 是自洽的，不要改。

`.fsPath` 的子集禁令（`schemeAgnosticRestrictedSyntax`）只覆盖 `packages/platform/src/**`，作用域与豁免见
[config-eslint CLAUDE.md](../../packages/config-eslint/CLAUDE.md)。

## 3. 部署链与自愈

远端部署 = 传 dist-bundle + 逐 vendor 目录 `npm ci`。三处已被代码头注释承载，只给锚点：install 独立 entry 的
鸡生蛋根治（`packages/remote-server/src/install.ts` 头注释 + `installCli.ts`）、bundle 内容哈希自愈与 dev
保鲜（`scripts/dev/ensure-remote-server-bundle.mjs`）、发布版 version 契约
（`scripts/release/runtime-resources.mjs`：staged `package.json` 的 version 必须改写成 app 版本，否则每连必重
部署死循环）。以下是注释没有承载的三条：

- **tar/scp 的本地参数绝不能含盘符冒号**：GNU tar/scp 把 `C:\…` 当 `host:file` 远程语义
  （`Cannot connect to C: resolve failed`），而 PATH 命中 GNU tar 还是 System32 bsdtar **因环境而异**——手动
  shell 里能过、Electron main 里挂。统一 cwd = 临时根 + 裸文件名（`remoteDeploy.ts`，有单测守护）。
- **`bundleDir` / `serverVersion` 由 main 按 `app.isPackaged` 注入** `RemoteDeployer` / `WslDeployer`；
  `remoteDeploy.ts` 保持**纯 node**（勿在里面 `import electron`），否则打包与单测两条路径同时断。
- `packages/node-services` 的 `package.json` 需要 `"sideEffects": false` 才能摇掉未用的 native import——这是
  install 独立 entry 能成立的前提。

## 4. Windows 远端主机

**平台探测状态机**（`remoteDeploy.ts` 的 `_ensurePlatform`，per-authority 缓存）：先跑 `uname -sm`
（`MINGW` / `MSYS` / `CYGWIN` → windows，`Linux` / `Darwin` → posix），失败再退到
`cmd /c "echo UNIVERSE_REMOTE_OS=%OS%.%PROCESSOR_ARCHITECTURE%"`（cmd 与 PowerShell 两种默认 shell 都能执行）；
`AMD64` → x64、`ARM64` → arm64。

**命令契约与 git-bash 拒绝**：所有 Windows 远端命令是单条 `cmd /d /s /c "<body>"`，body 禁双引号、禁 `$`、
禁反引号，行首必须 `cd /d %USERPROFILE%&`（Win32-OpenSSH 对 admin 会话初始 cwd 是 System32，本机非 admin
复现不出）；git-bash / MSYS 作 DefaultShell 在探测期就拒绝——MSYS runtime 会把 `/d /s /c` argv 重写成盘符路径，
cmd 进交互模式静默挂死（vscode remote-ssh 同此限制）。逐字契约与快照测试在 `remoteDeploy.ts`。

**受管 node（Windows）**：nodejs.org 的 zip + 远端系统自带的 `%SystemRoot%\System32\tar.exe`（bsdtar 支持 zip）；
Windows 的 node 包**没有 `bin/` 子目录**，写路径时别照抄 POSIX 形态。

**WMI 逃 sshd job kill 的已知代价**：Windows OpenSSH 把会话包进 kill-on-close job object，会话结束时
`TerminateJobObject` 连 detached 子进程一起杀。修法是用 powershell `Invoke-CimMethod Win32_Process Create` 让
WmiPrvSE 代启、天然在 job 外；代价是 **WMI 创建的进程环境是注册表重新生成的默认环境**——实测
`USERPROFILE` / `USERNAME` 正确，但用户会话动态注入的 PATH 项丢失、嵌套 `REG_EXPAND_SZ`（如 `%NVM_HOME%`）
不展开。daemon 核心自包含（fork 全走绝对路径）不受影响；**远端 pty 里「找不到用户工具」先想到这里**。
启动旗标、被硬杀的指纹与 `ue:wmi-*` 降级标记见 `packages/remote-server/src/bootstrap.ts` 头注释。

**远端路径的展示策略**：`remote-ssh` 的 `URI.path` 规范形态是 `/E:/workspace/foo`，**任何直接渲染给用户的
地方都必须过 `toDisplayPath`**（platform `base/path.ts`，`/e:/a/b` → `E:\a\b`，POSIX 路径恒等）——纯形态推断、
**不需要远端 OS**，所以对未连接的 recent 记录也有效，不必引 `RemoteEnvironmentDto.os` 做异步查询。对远端一律
`toDisplayPath(uri.path)` 而**不是** `fsPath`（后者剥前导斜杠但不转反斜杠，还会折进 authority 语义）。已收口：
标题栏左右段 / 原生窗口标题 / Welcome 最近打开 / Remote Explorer recent description / agent @mention / tab
tooltip（此前 remote scheme 落到整条 URI）。**刻意未改**：功能性复制（Search 的 Copy Path、终端拖放粘贴）仍按
`fsPath` 走，正斜杠在 cmd / PowerShell 里可用。

**npm / ripgrep 的两个虚惊**：node 24 自带 npm 默认跳过未审批的 install scripts 并告警，但 ripgrep 1.18 /
parcel-watcher / node-pty 的二进制全走 optionalDependencies prebuilt，**不需要放行**；ripgrep 1.18 的布局已变成
`@vscode/ripgrep-<platform>-<arch>/bin/rg`，老路径 `@vscode/ripgrep/bin/` 不存在，别误判缺失。

## 5. WSL 远端

WSL 直连不走 ssh（`wsl.exe -e bash -lc`），daemon 端口直接经 localhost 转发。平台三坑（Windows 自带 sshd 抢
22 端口 / zsh 非交互 shell 只读 `~/.zshenv` / 闲置自动关机需在 Windows 侧保活）见用户文档
[docs/user/zh-CN/remote/overview.md](../../docs/user/zh-CN/remote/overview.md)；实机验收清单见 §10。以下是开发侧
必须记住的两条：

- `authorized_keys` 权限须 **600**——755 被 sshd 的 StrictModes 直接拒。
- `wsl.exe -e bash -lc` 下 **nvm 装的 node 不可见**（Ubuntu 的 `.bashrc` 交互早退，login shell 读不到 nvm
  init）→ 报 `node: command not found`。修法是把 `~/.nvm/versions/node/<ver>/bin/{node,npm,npx}` 符号链接进
  `~/.local/bin`（Ubuntu 默认 `~/.profile` 里「目录存在即入 PATH」，免 sudo，2026-08-15 实机验证）。

## 6. 远端终端

**PTY 生命周期核心下沉 `packages/node-services/src/terminal/ptyHostService.ts`**（Electron-free，本地 main 与
remote server 逐字共用）；`apps/editor/src/main/services/terminal/terminalMainService.ts` 是薄壳，只做本地 /
远端分流：cwd scheme 为 `remote-ssh` → 该 authority 的 server Terminal channel，远端 id 重写为窗口唯一映射
id（`remote:<authority>:<remoteId>`）使 renderer 保持 scheme 无关，事件合流回同一个 `onData` / `onExit` /
`onTitleChange`。**只有连接永久关闭才为它持有的终端 fire `onExit`**——socket 抖动不算，PersistentProtocol
让 channel 跨重连存活、输出继续流动。

**profile 探测必须在宿主侧做，OS 依赖全注入**：直连模式验收抓到 renderer 的 profile 探测把**本机** `pwsh.exe`
路径发给了 Linux 远端，pty 秒退、input 报 `unknown terminal`。修法是探测下沉宿主侧 + 远端 OS 感知
`defaultProfile`；`packages/node-services/src/terminal/terminalProfiles.ts` 是纯函数，`fs` / `execFile` /
`env` / `platform` / `windowsBuildNumber` 全部作依赖注入，单测可在任意主机模拟任意机器布局。

## 7. 远端 extension host 与激活链

**远端 host 的 env 是干净构建**：本地 host 经 `buildChildEnv` 继承 `UNIVERSE_ENABLED_EXTENSIONS`，远端必须
**显式转发**（`apps/editor/src/main/services/extensionHost/remoteExtensionHostService.ts`——e2e 的最小扩展集就靠它）。
漏转发的后果不是「少一个扩展」而是**整条激活链被堵**：直连验收时 perforce 被误激活，它没有超时的 p4 探针在
不可达的 P4PORT 上挂起，typescript 永不激活、hover 全空。修法两件——allowlist 转发 + 探针 watchdog
（`extensions/perforce/src/clientDiscovery.ts` 的 `DISCOVERY_PROBE_TIMEOUT_MS = 15_000`）。

**贡献注册按「扩展 × 贡献类型」隔离**：`ExtensionPointTranslator._guardContribution`
（`apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts`，每个 `_register*` 逐个包），一个扩展
的某个贡献点抛错不再拖垮全部注册。

## 8. 远端 agent 二进制

**背景**：远程工作区下 claude / codex 的原生二进制改为下载到**远端主机** `<dataDir>/agent-bin/<agent>/`。此前
renderer 对 `spec.authority` 直接短路 → 远端 claude-code 必挂（fork 的 `claudeCliPath()` 拿不到
`CLAUDE_CODE_EXECUTABLE` 直接 throw），codex 则靠部署期 `npm ci` 隐式拉 300MB 平台包。放**非版本化目录**是为了
server 升级不重下几百 MB。

**架构**：下载核心抽为 `packages/node-services/src/agentBinary/`（`AgentBinaryStore` + claude / codex flavor，
Electron-free，main 与 server 逐字共用，各自下载到自己那台主机）；远端走 `RemoteChannels.AgentBinary`，server 端
`packages/remote-server/src/agentBinaryService.ts` 惰性建 store + 进度节流（**≥100ms**）跨隧道；main 按
`opts.authority` 分流（照 acpHost 模式，`onDidClose` 失效 proxy 缓存）。

**renderer 的远程分支固定 `source:'download'`**，把远端 native path 注入 `CLAUDE_CODE_EXECUTABLE` /
`CODEX_PATH`——该 env 在**同一台远端 host** 被 spawn，所以协议刻意不做 URI 变换（同 `remoteProtocol.ts` 头注释的
例外条目）；settings env 改读远端 `~/.claude`（`claudeConfig.read(authority)`）。

**面板的远程语义**（协议 v3→v4）：`IRemoteAgentBinaryService` 增 `getVersionInfo(agent)` / `forceDownload(agent,
version)`，editor 契约 `getVersionInfo(authority?)` / `forceDownload(version, authority?)` 按 authority 分流；面板
远程模式**隐藏 source 区**（远端固定受管下载）、进度按 authority 过滤、**authority 切换先清陈旧 versionInfo**。

**红线**：本地 source / customPath 配置与 `acp.codex.apiKey` **绝不过隧道**；进度事件按 authority 过滤（本地事件
`authority === undefined`），本地 / 远端下载互不驱动对方的通知。

**预下载补齐远端**（协议 v6→v7）：`prefetch(agent)` / `cleanupStaleVersions(agent)` 带 authority 尾参；
`AgentBinaryPrefetchContribution`（`apps/editor/src/renderer/contributions/`）从「runWhenIdle 跑一次」改成事件驱动
多入口——idle 初始触发 + `onDidChangeWorkspace` + `IRemoteStatusService.onDidChangeState` + 构造期
`getConnections()` seed，语义 = **每 authority 每会话至多一次**。prefetch 跟随当前工作区（remote 只预取远端，
不看本地 `acp.*.source`，本地照旧）；cleanup 本地恒跑 + 远端额外一次；`acp.prefetchBinaries` 与 e2e 探针门禁覆盖
全部下载路径。

**后台维护绝不能触发连接**：`getServiceProxy` 本身不连，但代理**首次 `.call()`** 会 `getConnection()` 走完整
bring-up（SSH 部署 + 安装）。远端 prefetch / cleanup 必须门控在 `IRemoteStatusService` 报的 `connected` 上；
`getConnections()` 是被动读，可安全轮询。

**多入口去重的两条不变量**（`AgentBinaryPrefetchContribution._maintain`，代码注释同守）：

1. `_maintained.add(authority)` 必须在 **connected 检查之后**（前置会让「未连接 → 后连接」的 authority 永久漏
   维护），且在任何 `await` **之前**（否则同帧两个事件重复下载）；
2. `onDidChangeState` 是 live emitter、**不重放历史**，故需 seed；seed 失败的按需重试必须**有次数上限**，否则
   `seed → _maintain → re-seed` 自成环，IPC 持续失败时无限刷日志。

store 层自身的下载语义（单入口 `_ensureVersion`、保留集、进度状态、两个时间窗口）见
[node-services/src/agentBinary/CLAUDE.md](../../packages/node-services/src/agentBinary/CLAUDE.md)。

## 9. 连接状态与进度

**细粒度步骤事件不新增通道**：直接在 `IRemoteConnectionStateChange` / `RemoteConnectionStatusDto` 上加可选
`progress`（`stepId` / `stepIndex` / `stepTotal` / `startedAt`），由 `_ensureDaemon` 在 classify 之后按分支 fire
——`stepTotal` 只有这时才可知。deployer 用**方法参数** `onPhase` 回调上报（deployer 是共享单例，不能构造器注入
per-connection 回调）。快速路径（server 已就绪）与 reconnect 天然零 progress 事件，不打扰。

**reconnecting 中关掉 app 不能卡住退出**：连接状态机 dispose 时必须销毁 in-flight 的重连 socket 与握手定时器并
`unref`，否则退出被顶 10 秒（直连验收抓到）。

状态栏条目的 in-flight authority 回退见
`apps/editor/src/renderer/contributions/RemoteStatusContribution.ts` 的 `_displayAuthority()`。

## 10. 实机验收

**有状态子系统（终端 / extension host / 激活链）必须真实跨 OS 验收**——直连模式本机同构会掩盖**路径、平台、
环境**三类泄漏，这类 bug 在本地同构环境不可能复现，别指望单测兜底。三个样本的机制分别在 §6 / §7 / §9：终端
profile 探测把本机 pwsh 路径发给 Linux 远端；`UNIVERSE_ENABLED_EXTENSIONS` 未转发 + p4 探针无超时阻塞整条激活
链；reconnecting 中关 app 被顶 10 秒。

**直连模式的入口**：e2e 与手动联调走 `UNIVERSE_REMOTE_SERVER_CMD`——代码**只认以 `[` 开头的 JSON 数组形态**
（`_resolveDirectCommand`，`apps/editor/src/main/services/remote/remoteConnectionMainService.ts:652`；数组而非
shell 字符串，是为了不让 Windows 的空格路径被拆散）。对 `remote-ssh://<authority>/<path>` 做任意文件操作即
**懒建连接**，不需要先 connect；daemon 的 `--data-dir` 落在 `<userData>/remote-direct/<authority>`。

**WSL 直连验收清单**：`authorized_keys` 600（§5）；login shell 里 node 可见（§5 的符号链接修法）；Windows 侧
保活，否则闲置关机会让长跑用例中途掉线。Windows 远端另见 §4。跑 e2e 的机型 / 环境约束见
[wsl-e2e.md](wsl-e2e.md)。

## 11. 已知限制与未收口

- **`OpenerService.parseTarget`**（`apps/editor/src/renderer/services/opener/OpenerService.ts`）：字符串 target
  没有 host 上下文，仍按本地语义 `URI.file` 解析——remote 工作区里从纯文本路径打开文件会指向客户端磁盘。要
  收口得让调用方带上 authority。
- 远端扩展管理的限制清单（`quarantineMalicious` 只治理本机、远端图标、enablement 徽标共用等）见
  [extensionManagement CLAUDE.md 远程路由节](../../apps/editor/src/main/services/extensionManagement/CLAUDE.md)与
  [cases-remote-routing.md](../../apps/editor/src/main/services/extensionManagement/cases-remote-routing.md)。
