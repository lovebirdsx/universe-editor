# packages/node-services/src/agentBinary/CLAUDE.md

Agent 原生二进制（Claude / Codex）的**下载核心**，Electron-free，被**本地 main 进程**与 **remote server** 逐字共用（各自下载到自己那台主机）。本目录只管**下载语义**——系统安装/自定义路径的解析、source 分派、wire 契约都在调用方。

- `agentBinaryStore.ts` — `AgentBinaryStore`：版本目录树、按版本去重下载、进度事件、保留集清理。
- `flavors.ts` — 每个 agent 的 flavor（npm 包名 / 二进制在包内的相对路径 / 内置版本 / 平台探测）。`bundledVersion()` 读随包发布的 meta（claude 是 `claude-binary.json`，codex 是常量）。
- `agentBinaryProtocol.ts` — 远端 channel 的契约（`RemoteChannels.AgentBinary`，server 端实现见 `packages/remote-server/src/agentBinaryService.ts`）。
- 消费方：`apps/editor/src/main/services/{claudeBinary,codexBinary}/`、面板 `apps/editor/src/renderer/workbench/agentSettings/{claude/BinaryPanel,codex/CodexBinaryPanel}.tsx`。

## 磁盘布局与两个指针文件

```
<baseDir>/<version>/…      每个版本一套完整目录树（解压态），版本目录名即版本号
<baseDir>/.active          激活版本（唯一的「当前生效」真相）
<baseDir>/.latest          最近一次见过的 registry latest —— 只服务于保留集，不是「当前版本」
```

## 三条不变量（改动前先读）

1. **单入口按版本去重**：一切下载走 `_ensureVersion(version, background)` —— 盘上 `<version>/` 命中二进制则直接返回（**零网络**），否则下载；`_inflightEnsures` 保证同版本并发只 fetch 一次（后台 prefetch 与用户点击共享同一次下载），settle 后释放登记。`resolveDownload` / `forceDownload` / `prefetch` 都只是它的调用方，**不要在它们里各写一套下载逻辑**。`forceDownload` = ensure + 写 `.active`——**绝不删目录重下**（盘上已有就该秒切）。去重同时是防损坏的前提：同一版本的两次并发会写同一个 `<destDir>.extract.<pid>` 而互相踩踏。
2. **保留集永不联网**：`cleanupStaleVersions()` 的 keep-set = `{active} ∪ {bundled} ∪ {上次见到的 latest} ∪ {在飞的下载} ∪ {正在激活的版本} ∪ {从遗留暂存区搬回来的版本}`。cleanup 在启动路径上，联网会让 10s 超时成为最坏路径，故 latest 用 `.latest` 文件记（`getVersionInfo`/`prefetch` 拿到 registry 应答时顺手写）。**`bundledVersion()` 抛错时不能返回空集**——空集等于把用户下过的版本全删，宁可这轮不清理。`_activating` 与「搬回来的版本」这两项是为了堵两个真实窗口：下载已 settle 但 `.active` 还没写、以及 idle 的 cleanup 抢在用户点击之前把暂存区的几百 MB 回收掉。
3. **进度状态活在 store，不在组件里**：`onDidChangeDownload`（数组载荷，`[]` = 空闲）是唯一事件源，`getVersionInfo().downloads` 是同一状态的可查询快照。数组而非单值，是因为后台 prefetch 与用户点击可真实并发；面板靠快照重建跨挂载状态（切走再回来仍要显示进度），故**状态不能退化成组件局部 state**。失败路径必须在 `finally` 清状态，否则 UI 永远卡在「下载中」。

> 教训（已被审查抓到一次）：面板把**快照**当实时集用，点击后进度行与按钮同时出现 —— 判定「某版本是否正在下载」必须喂实时 `downloads`，快照只用来恢复挂载瞬间的状态（`deriveBinaryActionState` 的 `diskState` 参数）。

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

`__tests__/agentBinaryStore.test.ts`：全部**不碰真网络**——`vi.spyOn(globalThis,'fetch')` + 手写 `Response` 桩，用 `deferred<Response>()` 做闸门观察「并发只 fetch 一次」「在飞可见」「失败清状态」，`mkTempDir` 造盘上版本。codex flavor 用常量版本，故测试默认用它（claude 需要 meta 文件夹具）。
