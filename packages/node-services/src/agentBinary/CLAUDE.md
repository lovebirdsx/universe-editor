# packages/node-services/src/agentBinary/CLAUDE.md

Agent 原生二进制（Claude / Codex）的**下载核心**，Electron-free，被**本地 main 进程**与 **remote server** 逐字共用（各自下载到自己那台主机）。本目录只管**下载语义**——系统安装/自定义路径的解析、source 分派、wire 契约都在调用方。

- `agentBinaryStore.ts` — `AgentBinaryStore`：版本目录树、按版本去重下载、进度事件、保留集清理、pin 变更后的空闲对齐（`syncBundled`）、**运行期版本硬下限**（`_resolveDownload`）。
- `flavors.ts` — 每个 agent 的 flavor（npm 包名 / 二进制在包内的相对路径 / 内置版本 / 平台探测）。`bundledVersion()` 读随包发布的 meta（claude 是 `claude-binary.json`，codex 是常量）；`minimumBinaryVersion()` 是**二进制自报命名空间**的下限（claude 读 meta 的 `cliVersion`，codex 同 `CODEX_VERSION`），**store 不调用它**，只有 main 的 system/custom 路径用（远端没有这两种来源）。
- `binaryVersion.ts` — 版本解析（严格：整串必须是一个版本）/ semver precedence 比较 / `--version` 探测（`probeBinaryVersion`，**永不 reject**）。**不复用** `extension-manifest` 的 semver 助手：那个对垃圾输入 fail-open 且忽略 prerelease，与硬下限语义相反。
- `agentBinaryProtocol.ts` — 远端 channel 的契约（`RemoteChannels.AgentBinary`，server 端实现见 `packages/remote-server/src/agentBinaryService.ts`）。
- 消费方：`apps/editor/src/main/services/{claudeBinary,codexBinary}/`、面板 `apps/editor/src/renderer/workbench/agentSettings/{claude/BinaryPanel,codex/CodexBinaryPanel}.tsx`。

## 磁盘布局与三个指针文件

```
<baseDir>/<version>/…      每个版本一套完整目录树（解压态），版本目录名即版本号
<baseDir>/.active          激活版本（唯一的「当前生效」真相）
<baseDir>/.latest          最近一次见过的 registry latest —— 只服务于保留集，不是「当前版本」
<baseDir>/.bundled         已对齐过的锁定版本 —— 只服务于「pin 变了要对齐一次」的判定
```

`.bundled` 不是「当前版本」，也**不进保留集**：它命名的版本由 `bundledVersion()` 天然进 keep-set，指针文件本身是 dotfile（清理与列举都已跳过）。`syncBundled()` 只翻 `.active`、**绝不删目录** —— 被替换掉的旧目录由 `_retainedVersion` 保留到本进程结束（同 `forceDownload`：活跃会话可能还在跑它、离线回退也要靠它，而**第二个窗口在本会话内 sweep 时 keep-set 已不再命名它**），下个进程的 sweep 才回收。写 `.bundled` 的时机是「对齐动作成功之后」：失败不写 ⇒ 下个会话重试；文件缺失 = 从未对齐（老用户首次启动会对每个 agent 各对齐一次）。

## 三条不变量（改动前先读）

1. **单入口按版本去重**：一切下载走 `_ensureVersion(version, background)` —— 盘上 `<version>/` 命中二进制则直接返回（**零网络**），否则下载；`_inflightEnsures` 保证同版本并发只 fetch 一次（后台 prefetch 与用户点击共享同一次下载），settle 后释放登记。`resolveDownload` / `forceDownload` / `prefetch` 都只是它的调用方，**不要在它们里各写一套下载逻辑**。`forceDownload` = ensure + 写 `.active`——**绝不删目录重下**（盘上已有就该秒切）。去重同时是防损坏的前提：同一版本的两次并发会写同一个 `<destDir>.extract.<pid>` 而互相踩踏。
2. **保留集永不联网**：`cleanupStaleVersions()` 的 keep-set = `{active} ∪ {bundled} ∪ {上次见到的 latest} ∪ {在飞的下载} ∪ {正在激活的版本} ∪ {被切换掉的旧版本（`_retainedVersion`，本进程内）} ∪ {从遗留暂存区搬回来的版本}`。cleanup 在启动路径上，联网会让 10s 超时成为最坏路径，故 latest 用 `.latest` 文件记（`getVersionInfo`/`prefetch` 拿到 registry 应答时顺手写）。**`bundledVersion()` 抛错时不能返回空集**——空集等于把用户下过的版本全删，宁可这轮不清理。`_activating` 与「搬回来的版本」这两项是为了堵两个真实窗口：下载已 settle 但 `.active` 还没写、以及 idle 的 cleanup 抢在用户点击之前把暂存区的几百 MB 回收掉；`_retainedVersion` 堵的是「第二个窗口在本会话内又 sweep 一次」——那时 `.active` 已经翻走，被替换的版本不再被任何一项命名。
3. **进度状态活在 store，不在组件里**：`onDidChangeDownload`（数组载荷，`[]` = 空闲）是唯一事件源，`getVersionInfo().downloads` 是同一状态的可查询快照。数组而非单值，是因为后台 prefetch 与用户点击可真实并发；面板靠快照重建跨挂载状态（切走再回来仍要显示进度），故**状态不能退化成组件局部 state**。失败路径必须在 `finally` 清状态，否则 UI 永远卡在「下载中」。

> 教训（已被审查抓到一次）：面板把**快照**当实时集用，点击后进度行与按钮同时出现 —— 判定「某版本是否正在下载」必须喂实时 `downloads`，快照只用来恢复挂载瞬间的状态（`deriveBinaryActionState` 的 `diskState` 参数）。

## 运行期硬下限（`_resolveDownload` 的分支）

锁定版本是**下限**，不只是空闲期对齐的目标：**任何来源都不得启动低于它的二进制**。`allowDownload` 只影响「要不要花流量」，不影响「能不能低于下限」。

- `download` 来源（本地 + 远端共用）：`.active` 只在**不低于锁定版本**时才被直接返回；低于（或目录名根本不是版本 → **fail-closed**，视为低于）则改走「锁定版本已在盘 → 零网络 `_activate` 切过去 / 不在盘 → `_ensureVersion` 下载」——**前台下载失败必须抛**，绝不退回旧版将就。判据是 `<` 不是 `!==`：用户手选的**更新**版本必须原样放行。
- `download` + `allowDownload:false`（会话恢复等后台探测）：不能下载，所以退回盘上那个旧二进制，但**去重 warn**（静默路径每次 resolve 都刷日志）。没有可退的旧版才抛既有的 `not downloaded yet`。
- 锁定版本本身不可解析 → warn + **关掉下限**（无从比较，不能拿垃圾值当门槛）。
- 下限相关的三条 warn 全走 `_warnFloorOnce(key, msg)` 共用一个去重集（键带 `pin:` / `active:` / `fallback:` 前缀）：它们描述的都是**持久状态**，而静默路径每次 connect 都会 resolve 一次。
- **不写 `.bundled`**：它属于空闲对齐的语义（「pin 变了要对齐一次」），运行期切指针写它只会多出指针状态组合；`syncBundled` 之后看到 `active === bundled` 会直接补记，无冲突。
- **不加 `_activating`**：强制目标恒为 `bundledVersion()`，它永远在 `cleanupStaleVersions` 的 keep-set 里，不存在「下载完到写 `.active` 之间被 sweep」的窗口。`forceDownload` 也不加守卫——它只下载/切指针不启动进程，下次 resolve 会被强制回来。
- `_activate(next, previous)` 是唯一的指针写入点（`forceDownload` 与 `_resolveDownload` 共用）：`previous !== next` 时才写，并把 outgoing 版本记进 `_retainedVersion`（离线回退要用 + 活跃会话可能还锁着它）。
- `system` / `custom` 来源不在 store 里，由两个 main service 各自用 `minimumBinaryVersion()` + `probeBinaryVersion()` 校验（**fail-open**：探测不出来/基准未知就放行，wrapper 脚本不能误杀）。`probeBinaryVersion` 只由这两个 service 调用。
- `resolve({source:'download', allowDownload:false})` **不进 `_inflight`**：该路径可能返回上面那个「退回的旧版」，缓存它会让随后翻转的 `.active` 永远观测不到（跨窗口更是如此）。这条路径只有几次 `pathExists`，重跑很廉价。

## 坑

- **`background` 是「谁先发起」不是「我是谁」**：前台调用 join 已跑的后台下载时会继承 `true`。别用它判断「是不是我发起的」。
- **`.prefetch` 暂存区已删**（2026-09）：暂存目录与版本目录不同时，「一个版本只下一次」不可能成立。`_adoptStagedVersion` 负责把单个版本搬过来（`_ensureVersionImpl` 命中时按需调用），`_adoptLegacyPrefetch` 则在 **cleanup 里**扫一遍整个暂存区——只能放这里：cleanup 在 idle 跑，早于用户的下一次点击，若那时直接把它 rm 掉，用户盘上已下好的几百 MB 就被回收了，紧接着还得重下。搬进来的版本要**计入 keep-set**，否则同一次清理里前脚搬后脚删。
- **Windows 文件锁**：`_rmQuiet` / `_renameWithRetry` 的重试语义别去掉；升级后旧版本仍被运行中的 agent 占用，cleanup 只在 startup/idle 跑才是安全的。
- **跨进程并发**：两个编辑器实例各有 store，同版本仍可能并发下载（`.extract.<pid>` 不同，最终 rm+rename 竞争）。刻意不引入锁文件。

## 改动波及面

- 改 `agentBinaryProtocol.ts`（方法/payload）→ **bump** `packages/platform/src/remote/remoteProtocol.ts` 的 `REMOTE_PROTOCOL_VERSION`（老 daemon 握手会失败，需重启远端 daemon）。
- 改 `AgentBinaryVersionInfo` / 下载事件形状 → 编辑器 wire 契约 `apps/editor/src/shared/ipc/{claudeBinaryService,codexBinaryService}.ts`、main 转发（按 agent 过滤 + 附 `authority`）、两个 BinaryPanel，以及 `renderer/services/acp/acpClientService.ts` 的下载进度提示。
- 新增 flavor → 加进 `flavors.ts` 并在 `AgentBinaryStore` 调用方接上 `AgentBinaryId`。

## 测试

`__tests__/agentBinaryStore.test.ts`：全部**不碰真网络**——`vi.spyOn(globalThis,'fetch')` + 手写 `Response` 桩，用 `deferred<Response>()` 做闸门观察「并发只 fetch 一次」「在飞可见」「失败清状态」，`mkTempDir` 造盘上版本。codex flavor 用常量版本，故测试默认用它（claude 需要 meta 文件夹具）。下限相关的用例也在这里（切指针 + keep-set、后台回退 + warn 去重、前台下载失败不回退）。

`__tests__/binaryVersion.test.ts`：解析/比较/探测三组纯函数用例（含 `process.execPath --version` 成功路与超时路）。main 侧 system/custom 的校验在 `apps/editor/src/main/services/{claudeBinary,codexBinary}/__tests__/binaryVersionFloor.test.ts`，用 POSIX `#!/bin/sh` 假二进制（win32 的 claude 用例 skip：`selectClaudeExecutable` 在 Windows 只认原生 `.exe`）。
