# 02 · IPC 层系统性补强

> 依据：[03-main-process-ipc.md](../architecture-review-202607/03-main-process-ipc.md) P2 两项 + P3 错误 marshalling。
> 批次：三个任务全部第一批（P1）。共同特征：**都在 `packages/platform/src/ipc/` 一处改、消一类 bug**，建议同一批做完。

## 背景

- **URI 跨 IPC 无统一 marshalling**：信封只对 `Uint8Array` 做了标记还原（`platform/src/ipc/ipc.ts:120-153`），URI 落地成裸 `UriComponents`；全仓 50+ 处手写 `URI.revive`、main 侧同一 `toURI` helper 抄了 5 份。已发生真实 @p1 回归（realpath URI 未 revive 致 `.fsPath` 为空，见 memory `realpath-uri-ipc-revive`）。
- **反向 RPC 悬挂即永久**：`ChannelClient.call` 的 Promise 只在收到 response 时 settle（`ipc.ts:203-211`）；`dispose()` 只 clear 不 reject（`ipc.ts:234-236`）；帧死后 send 静默丢弃（`electronProtocol.ts:115-128`）。renderer 假死时 `confirmQuit` 的 `await rendererLifecycle.confirmShutdown(...)`（`windowMainService.ts:642`）永不返回，退出流程无声卡住。
- **IPC 错误只传 message 字符串**（`ipc.ts:295-297`）：下游被迫正则匹配错误语义（`acpHostMainService.ts:249` `/not writable|has exited/`），改措辞即破坏远端判断。

## 任务 1：URI 自动 marshalling ✅（P1，第一批）

> 已完成（2026-07-20）。落地：`packages/platform/src/ipc/ipc.ts` 的信封 reviver 在既有 base64/Uint8Array 标记同层新增 `$mid: 1` 识别——序列化端无需改（`URI.toJSON()` 已按 VSCode 约定打 `$mid:1`），reviver 端遇标记（带 string `scheme` 守卫，避免裸对象误判）经 `URI.revive` 还原为真 `URI` 实例，深度遍历复用现有路径。platform 补 5 例往返单测（单值 / 嵌套 / 数组 / 与 Uint8Array 混合 / 未打标记的裸 `UriComponents` 保持不变，断言用 `instanceof URI` 真还原）。
>
> **手写 revive 清理（步骤 3，2026-07-20 续做完成）**：先上机制、全量 e2e 稳定后清理。采用**类型驱动**策略——把跨 IPC 的 wire DTO 从 `UriComponents` 收紧为 `URI`（`IFileMatch`/`IFileSearchMatch`/`IFileChangeEvent`/`IUserDataFilesService.getFileUri`/`IWorkspace(.folder)`/`IRecentWorkspace`），生产端（main）去掉手动 `.toJSON()`、消费端删 `URI.revive()`，让 strict typecheck 精确逼出每个连锁点。清理域：MainThreadFs realpath、搜索结果消费（QuickTextSearch/useSearchEngine/useSearchActions/searchTree/mentionFileSearch）、文件监听事件消费（ExternalChangeWatcher/ExplorerTreeService）、`getFileUri` 全部消费点（aiActions/preferencesActions/4 个 Contribution/UserKeybindings/AiModelsPanel）、workspace wire（RendererWorkspaceService）。相应 realpath @p1 防护测试改为断言"envelope 已 revive、消费端直接读 `.fsPath`"的新契约。
> - **刻意保留**（56→36 文件）：编辑器 `deserialize`（FileEditorInput/DiffEditorInput/…）、`_storage.get` 持久化反序列化（recentFiles/workspaceTrust/recentWorkspaces）、main 侧 `URI | UriComponents | string` 多态归一 helper（fileSystem/fileSearch/fileWatcher/textSearch/workspace 的 `reviveUri`，IPC 已 revive 时 `instanceof URI` 提前返回不触发）、extension-host 进程内值、以及 MainThreadLanguages/windowsMainService/editorResolver 等无法静态断定"入参恒带 `$mid`"的存疑点——均非 IPC 边界冗余，删了会破坏非 IPC 路径。
>
> 既有 realpath @p1 防护 e2e 仍绿（全量 `pnpm e2e` 20 job 全过）。

**目标**：跨 IPC 的 URI 自动还原为真 `URI` 实例，一次性消灭 "revive 忘写" 这一类 bug。

**步骤**：

1. 照抄 VSCode marshalling 思路：URI 序列化时打 `$mid` 式标记，信封 reviver 端识别标记还原为 `URI` 实例。实现落在 `packages/platform/src/ipc/ipc.ts` 现有 Uint8Array 信封同层（深度遍历需注意与 base64 标记共存、嵌套对象/数组、性能——大 payload 走浅探测或沿用现有遍历路径）。
2. platform 补单测：URI 单值 / 嵌套对象 / 数组 / 与 Uint8Array 混合 / UriComponents 裸对象（未打标记的旧数据）各形态往返。
3. 确认 `URI.revive` 幂等（revive 真 URI 实例是安全的）后，**分批**清理 50+ 处手写 revive 与 5 份 `toURI` helper（fileSystemMainService.ts:27 / fileSearchMainService.ts:32 / fileWatcherMainService.ts:98 / textSearchMainService.ts:90 / workspaceMainService.ts:55）；第一批只上机制不删调用点，跑全量 e2e 稳定后再删。
4. 顺手核对既有 @p1 回归的防护测试（realpath e2e）仍绿。

**验证**：`pnpm check` + 全量 `pnpm e2e`（IPC 信封是全局路径，必须全量）。

**验收**：新写跨进程接口传 URI 不再需要任何手写 revive；手写 revive 调用点清零（或仅剩注释登记的豁免）。

## 任务 2：ChannelClient dispose-reject + 反向 RPC 超时 ✅（P1，第一批）

> 已完成（2026-07-20）。落地：
> - `ChannelClient.dispose()` 现 reject 全部 pending 请求，错误为新增的 `IpcChannelDisposedError`（`code = 'IPC_CHANNEL_DISPOSED'`），async 闭包不再随窗口关闭悬挂泄漏。
> - `windowMainService.ts` 的 `_canProceed` 把 `rendererLifecycle.confirmShutdown(...)` 套 `Promise.race` 超时（常量 `CONFIRM_SHUTDOWN_TIMEOUT_MS = 10_000`，注释理由）；renderer 假死超时后按"视为放行"返回 `true` 并 warn 日志，退出流程不再无声卡死。
> - 单测：platform 侧 dispose 时 pending reject（1 例）；windowMainService 侧用 `vi.useFakeTimers()` + `advanceTimersByTimeAsync(10_000)` 模拟 renderer 永不响应 confirmShutdown，断言退出在超时后继续（1 例）。正常响应路径不受影响。

**步骤**：

1. `ChannelClient.dispose()` reject 全部 pending 请求（错误带明确 name，如 `IpcChannelDisposedError`），async 闭包不再随窗口关闭泄漏。
2. main→renderer 反向 lifecycle 调用（`confirmShutdown` 等）套 `Promise.race` 超时：超时后按"视为放行/放弃 veto"处理并 warn 日志（退出路径宁可继续也不无声卡死）；超时时长给常量并注释理由。
3. 单测：dispose 时 pending reject；超时路径走通；正常响应不受影响。补一个 windowMainService 层的测试模拟 renderer 永不响应 confirmShutdown，断言退出流程在超时后继续。

**验收**：renderer 假死场景下 app 能在超时窗口内正常退出；窗口关闭无 pending Promise 泄漏。

## 任务 3：wire 结构化错误 ✅（P1，第一批）

> 已完成（2026-07-20）。落地：
> - IPC 错误信封升级为 `{ name, message, code? }`（`ResponseMessage.error` 由 `string` 改为 `WireError`）；序列化端 `serializeError(err)`、接收端 `reviveWireError(wire)` 还原为带 `name`/`code` 的 Error，`ChannelClient._handleMessage` 与 `ChannelServer._handleRequest`（channel-not-found → `ChannelNotFoundError`；catch → `serializeError`）全部走新信封。
> - 迁移 message 正则判断为 code 判断：`managedChildProcess.ts` 导出 `CHILD_PROCESS_EXITED_CODE`/`CHILD_STDIN_NOT_WRITABLE_CODE`（`childProcessError` helper 打码，消息措辞不变以保既有单测）；`acpHostMainService.ts` 与 `extensionHostMainService.ts` 的 `writeStdin` 改按 `err.code` 分支（原 `/not writable|has exited/` 正则删除），acpHost 侧重抛带 `ACP_HOST_STDIN_NOT_WRITABLE_CODE` 的错误供 renderer 跨 IPC 后分类。grep 全仓无其余对 IPC 错误 message 做语义匹配的生产代码（余下 `.message` 匹配均为 notification 文案测试断言）。
> - 单测：错误往返保留 name/code（2 例）；旧格式无 code 容错。

**步骤**：

1. IPC 错误信封升级为 `{ name, message, code? }`（`ipc.ts:295-297` 序列化端 + 接收端还原为带 name/code 的 Error 子类或附加属性）。
2. 替换 `acpHostMainService.ts:249` 式的 message 正则判断为 code 判断；grep 全仓其余对 IPC 错误 message 做字符串匹配的点一并迁移。
3. 单测：错误往返保留 name/code；旧格式（无 code）容错。

**验收**：跨进程错误语义判断全部走 `code`/`name`，无 message 正则。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ `ProxyChannel.fromService` 支持显式方法白名单或 wire 接口 Pick 收窄（`proxyChannel.ts:77-102` 现暴露实现类全部公有方法，含 `dispose()`）。
- ⬜ 通道注册收敛为单一描述符表 `{ name, contract, resolve(accessor), scope: 'app'|'window' }`，派生 `channelNames.ts` / `main-services.ts` / `registerMainServices.ts` / `renderer/main.tsx` 的 5-6 处手抄表；顺带让 fromService 吃 contract key 白名单（与上一条同解）。
- ⬜ 事件订阅去重 key 纳入 `arg`（`ipc.ts:308` 现按 `${channel}:${event}` 去重，将来参数化事件会互相顶掉）。
