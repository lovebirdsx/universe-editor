# 内存压力与 IPC 帧闸门

针对一次线上 renderer OOM 崩溃（诊断包 2026-09-11）建立的机制。目标不是"猜元凶"，而是**让堆在被压垮之前有观测、有处置、有记录**。

## 现场物证（minidump crash keys）

崩溃瞬间的 renderer 堆构成：

| key | 值 |
|---|---|
| `lo_space`（单对象 >256KB 的大对象） | **3807 MB** |
| `old_space`（普通小对象） | 123 MB |
| `external_memory`（ArrayBuffer） | 22 MB |
| `heap.used` / 主 cage | 3.85 GB / 4 GB（free 仅 12.75MB，`ran out of reservation`） |
| GC Mark-Compact | 回收 **0.0 MB** → 3.8GB 全是活对象 |

崩溃栈最内层是 `JSON.parse ← decode`（`packages/platform/src/ipc/ipc.ts` 的 `defaultCodec.decode`）← `ue:ipc` 入站帧。

结论：renderer 长期持有约 3.8GB 的**巨型字符串**。三个结构性缺口：

1. renderer 没有任何活体内存自检（采样只在 main，看不到 renderer 的堆），崩溃前 20–40 秒日志完全静默；
2. IPC 解码零帧体量防护，而 `reviver` 让单帧解码峰值达到线速的约 3.5 倍；
3. 多个 renderer 缓存持有整份文件文本 / base64 图片，**无上限**。

## 三层防线

### 一、IPC 帧闸门（`packages/platform/src/ipc/ipcFrameGuard.ts`）

- **阈值**：警戒 32 MiB（`IPC_FRAME_WARN_BYTES`）、硬上限 128 MiB（`IPC_FRAME_MAX_BYTES`）。取值依据是合法大帧的上界——fileSearch 清单 ≈8MB、ACP stdout 行 16MB（`sdkHostStream.ts` 硬顶）、ACP 图片 prompt 默认 ≈34MB——留 3.6× 余量，同时把最坏 decode 峰值压在 cage 可承受范围。
- **三处 codec 全部内联检查**（`defaultCodec` / `createJsonCodec` / `createBinaryCodec`）：`ChannelClient/Server` 的 `autoDispatch` 路径绕过 `ChannelPair`，只有在 codec 内部查才零遗漏。二进制 codec 的 decode 在**信任表头之前**查（`attachmentCount`/长度来自 wire）。
- **发送侧降级**，而不是挂死 promise：
  - 超限的 **request** → `ChannelClient._send` 用 guard 错误 reject 调用方；
  - 超限的 **response** → `ChannelServer._send` 降级成一条小的错误 response（复用 `WireError.code` 通道，`IPC_FRAME_TOO_LARGE`），调用方正常 reject；
  - 超限的 **event** 只能丢弃，但留下记录。
  - 挂死 promise 在 UI 上表现为"卡住不动"，比报错难查得多。
- **崩溃前帧记录**：64 槽预分配环形缓冲（不用 `push/shift`，避免在最不该分配时分配）+ 4 个抗驱逐的持久标量（共见帧数 / 警戒数 / 超限数 / 最大帧及其标签）。突发小帧会把 tail 挤掉，而"本进程发出过的最大帧"恰是崩溃后最想问的问题。
- **告警折叠**：同一 `(direction, channel, name)` 1s 窗口内只上报一次并携带 `suppressed` 计数。
- **落点分进程注入**（platform 是纯 Node 包，不能碰 Electron）：renderer 在 `renderer/ipc/bootstrap.ts`，main 在 `main/index.ts`。renderer 侧只有 `ILogger`（`bindIpcFrameLog`，晚绑定——首个帧早于文件日志器存在），main 侧走 `mainLogger` + `errorSink.recordLocal`。`ITelemetryService` 不在这条链上，它只服务**内存水位**（见下文 `_snapshot`）。

> renderer 的 `direction:'out'` 是它自己发的；**main 的 `direction:'out'` 才是 renderer 必须 decode 的那些帧**。renderer OOM 时来不及上报，所以 main 侧的 ring 才是权威答案——诊断包里的 `ipc-frames.txt` 就是它。

### 二、renderer 内存水位（`apps/editor/src/renderer/services/memory/`）

- `memoryPressureLevels.ts`：纯函数阈值/迟滞。口径是**绝对字节为纲 + limit 比例为底**（`max(绝对值, 比例×limit)`），比例同时封顶；`limit < 512MB` 视为不可信，回落 4GB cage。迟滞 0.85 防贴阈值抖动。
- `memoryPressureService.ts`：分级 `normal / elevated / critical`，超阈值按 priority 跑注册的 releaser。每个 releaser 容错、**必须返回真实释放字节**（否则归因日志不可读）。`critical` 时**先落诊断快照再释放**——释放前的状态才是现场。
- 采样器用**自重排 `setTimeout`，绝不用 `requestIdleCallback`**：主线程被 GC 挤占时永远不会 idle，恰恰是最需要采样的时刻。正常 5s、受压 1s。
- `boundedCache.ts`：通用 LRU + 条数上限 + 字节预算 + pin。**measure 函数同时用于准入与释放报告**——两个数字不一致的缓存会让内存日志谎报堆的去向。

注册的 releaser（`MemoryPressureContribution`）：

| id | 内容 | elevated 保留 | critical 保留 |
|---|---|---|---|
| `acp.cancelledDrafts` | 取消撤回的草稿（priority -10，最便宜） | — | 0 |
| `acp.promptDrafts` | 未发送的 prompt 草稿（含 base64 图片） | 75% | 0 |
| `acp.mentionFileListing` | `@` 文件清单 | 75% | 0 |
| `acp.residentBudget` | ACP 会话常驻预算 | 75% | 0 |
| `dirtyDiff.headCache` | HEAD 全文（由 `DirtyDiffContribution` 自注册） | — | — |

`acpElicitationDraftCache` / `acpChatViewStateCache` 只加条数上限、**不注册 releaser**（值是表单文本/滚动位置，释放的痛感大于收益）。`semanticSelector.typeHierarchyCache` 不加：其键是 Monaco token type（约 20 个闭集标准值），值全部派生自静态表，构造上就有界。

### 三、崩溃恢复链路

- **stdin EPIPE**：Node 对无监听者的 `'error'` 直接走 `uncaughtException`（现场 `write EPIPE at writeStdin` 就是这么来的），而 `write` 的 callback **不是**可靠错误通道（Node 可能只发流事件）。`ManagedChildProcess` 在构造时挂上 `stdin.on('error')`，记一次 warn、存下 errno，后续写入以 `CHILD_STDIN_NOT_WRITABLE` 拒绝（errno 保留在 message 里）；**在途的写入 promise 也由同一个流事件 reject**（否则只走流事件的失败会让调用方永久挂起）。`dispose` 摘除 stdout/stderr/exit 监听，但 **stdin 的 `'error'` 监听故意留着**——SIGKILL 之后子进程仍可能让 stdin 报错，摘掉就等于把这条崩溃路径还回去。
- **IPC 洪流**：Electron 43 的 `webFrameMain.send` **内部 catch 后打 console.error，不抛**，所以原来的 `try/catch` 是死代码。改为 send 前主动查 `isCrashed()` / `mainFrame.isDestroyed()` / `detached`——现场 `render-process-gone` 迟到约 48s，事件驱动的门在那段时间是开的，每次 send 都失败，而每次失败又经"日志→IPC 转发→send"闭环放大（现场 225 条）。
  - 门关了就**闩住**，不每帧重探；`dom-ready`/`did-finish-load` 在闩锁期内**不开闸**（它们分辨不出新帧和将死的帧），renderer 真实发来的消息立刻清闩锁。
  - 闩锁**有截止时间**（`FRAME_UNREACHABLE_LATCH_MS = 30s`），不是永久位：那条失败文本不指名是哪个窗口，所以 `markRendererFramesUnreachable()` 会关掉**所有**窗口的门——多窗口下健康窗口若永久闩住，它的推送会被静默丢弃且不重放。截止时间让误伤最多持续一个窗口期；仍存活的窗口下一次 `dom-ready` 就恢复，真死的窗口每 30s 只付一次探测 send。
  - `Error sending from webFrameMain` 经 `installConsoleInterceptor` 的 `suppress` 钩子做**折叠**（`LogFloodFold`，1s 窗口 + 计数）并触发 `markRendererFramesUnreachable()`——在 `render-process-gone` 迟到的那几十秒里提前关闸。折叠键是常量而非整行文本（Electron 会附加可变的尾串，用整行做键会一条都折不掉）。
  - `markRendererFramesUnreachable` **不**触发 `onDidClose`：那会拆掉 ChannelServer 的订阅，对**已确认**死亡的 renderer 是对的，对"从一行日志推断出来的"不是。
- **延迟 reload**：崩溃对话框是窗口模态，无人点击则 `.then()` 永不 resolve，而 `win.reload()` 就在 `.then()` 里（现场黑屏 15m21s）。改为 20s 超时自动 reload + 崩溃风暴退避（5 分钟内 ≥3 次只提示不自动重载），`settled` 标志防双重动作。**不改成"先 reload 再提示"**——风暴下会无限重载。同理，风暴期间**对话框自身 reject 也不重载**（那会绕过退避变成无限重载循环，正是退避要防的事）；黑窗是这里的较小恶，下次启动的异常退出计数会提供「跳过恢复」。

## 诊断包里的相关文件

- `ipc-frames.txt`：main 侧帧环形记录 + 统计 + 最大帧标签。
- `memory.txt`：main 堆（`formatMainHeapSample`）+ 托管进程树内存（`hosted-processes cnt=… name#pid=…MB/…%`）。
- `sysinfo.md` / 日志尾部：renderer 侧的 `[memory] …` 行（水位变化时打印 `describe()` + 最近 12 帧）。
- 详见 [error-diagnostics.md](error-diagnostics.md)。

## 已知取舍与后续项

- **`reviver` 的 base64 解码峰值（约 3.5×）未重构**。延后解码会破坏 `instanceof Uint8Array` 契约，改动面是全仓每个 IPC 消费点，与止血目标不成比例。当前做法是"已知峰值模型 + 硬上限兜底"。
- **`VIEW_MODEL_OVERHEAD_FACTOR = 3` 系数不改**。它是记账单位，改成动态值会让同一卡片在 measure 与 release 拿到不同系数，账永远配不平。实测改由水位服务提供，职责分离。
- **硬上限可能误伤合法大帧**（用户把 `acp.prompt.image.maxSizeMB` 调到 50 → 约 340MB 帧）。这是刻意取舍：该帧 decode 峰值约 1.2GB，本就会 OOM。回滚 = 改一个常量。
- **同一份用户 prompt 可能被记两次**：本地 append 走 `_appendMessage` 的显式记账，agent 若把该消息回显成 `user_message_chunk`，`applyUpdate` 会再按 `estimateUpdateCost` 记一次。方向是保守的（提前 trim，不会漏记），且 `_releaseResidentDownTo` 在 `freed === 0` 时用 `_measureResidentBytes()` 重算兜底，账不会永久漂高。真要收口需要按 messageId 去重记账，改动面大于收益。

## 验证

- 单测：`packages/platform/src/__tests__/ipc/ipcFrameGuard.test.ts`、`ipcFrameGate.test.ts`、`log/logFloodFold.test.ts`；`apps/editor/src/renderer/services/memory/__tests__/`（阈值/迟滞/缓存归还字节）、`AcpSession.liveBudget.test.ts`（trim 后 `_residentBytes === _measureResidentBytes()`）。
- e2e：`@p0` `apps/editor/e2e/specs/smoke.memoryPressure.spec.ts`——**直接验证"`performance.memory` 在真实 Electron renderer 里可读"这个核心假设**、releaser 已注册、强制释放有归因。
