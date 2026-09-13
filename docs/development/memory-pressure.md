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
- **成功发出的出站大帧也记录**（不只是被拒的）。只记拒绝会让 `ipc-frames.txt` 出现「`warned>=32MiB=0` 与 renderer 日志里 47.6MB 的入站帧同时存在」这种自相矛盾的读数——main 侧看不到自己发过的大帧，也就无法与 renderer 的 `ipc.log` 对上。热路径成本是一次 `byteLength >=` 整数比较（不取时间、不建对象）；**不允许**扩展成每帧记录。
- **每帧带 `type` 与 `#id`**：`response` 帧在 wire 上**只有 `id`**（没有 `channel`），所以 `frameChannel`/`frameName` 对它恒为空。渲染侧不靠改协议解决，而是由**发起方**回答：`ChannelClient` 的 `_pendingRequests` 存下请求的 `channel`/`command`，一个 `frameTargetFor(msg)` 只对 `response` 做一次 Map 查找（零分配），`decodeInbound` 用它补全标签。于是告警从 `large inbound ipc frame 47.6MB` 变成 `… (response fileService.readFile #42)`，与 main 侧 ring 的 `#42` 对得上；解析不出也退化成 `(response #42)`，仍强于裸行。
- **告警折叠**：同一 `(direction, channel, name)` 1s 窗口内只上报一次并携带 `suppressed` 计数。出站 warn 同样折叠（发送侧告警天然来自循环，一行一帧会把自己埋掉），折叠状态与 oversized 那份分开，避免互相重置窗口；入站 warn 维持**逐帧上报**。
- **落点分进程注入**（platform 是纯 Node 包，不能碰 Electron）：renderer 在 `renderer/ipc/bootstrap.ts`，main 在 `main/index.ts`。renderer 侧只有 `ILogger`（`bindIpcFrameLog`，晚绑定——首个帧早于文件日志器存在），main 侧走 `mainLogger` + `errorSink.recordLocal`。`ITelemetryService` 不在这条链上，它只服务**内存水位**（见下文 `_snapshot`）。
- **闸门接住的是症状，不是肇因**。47.6MiB 那条入站帧的发起方是**会话改动追踪的重算读取**：`sessionChangeTracker._buildChange` → `IFileService.readFileText` 把一个约 16MiB 的二进制编译产物当文本整读回来（其 `stat.size` 比 `MAX_CURRENT_BYTES` 低约 0.8%，尺寸闸门一次都没拦到），7 分钟内重复 113 次。帧闸门保证的是「这一帧不会把 renderer 打穿」，而**读取次数 × 单次体量**完全在它之外——别把那次 OOM 记成已解决。

> renderer 的 `direction:'out'` 是它自己发的；**main 的 `direction:'out'` 才是 renderer 必须 decode 的那些帧**。renderer OOM 时来不及上报，所以 main 侧的 ring 才是权威答案——诊断包里的 `ipc-frames.txt` 就是它。

### 二、renderer 内存水位（`apps/editor/src/renderer/services/memory/`）

- `memoryPressureLevels.ts`：纯函数阈值/迟滞。口径是**绝对字节为纲 + limit 比例为底**（`max(绝对值, 比例×limit)`），比例同时封顶；`limit < 512MB` 视为不可信，回落 4GB cage。迟滞 0.85 防贴阈值抖动。
- `memoryPressureService.ts`：分级 `normal / elevated / critical`，超阈值按 priority 跑注册的 releaser。每个 releaser 容错、**必须返回真实释放字节**（否则归因日志不可读）。`critical` 时**先落诊断快照再释放**——释放前的状态才是现场。
- **停留在一个档位也会重复释放**（`MEMORY_RELEASE_RETRY_MS = 5s`）。只在**跃迁**时释放等于只试一次：现场堆在 critical 线上方待了几分钟，1s 采样下档位再没变过，于是每个 releaser 恰好跑了一次，而堆继续爬到上限。缓存是**被制造压力的那些工作重新填满的**，所以"待在原地"不是停手的理由；间隔是必需的（释放本身有成本，且压在线上方的堆每次采样都会报同一个档位）。`normal` 不参与重试。
- 采样器用**自重排 `setTimeout`，绝不用 `requestIdleCallback`**：主线程被 GC 挤占时永远不会 idle，恰恰是最需要采样的时刻。正常 5s、受压 1s。
- **堆曲线要送到 main 才能在崩溃后活下来**（`rendererHeapReporter.ts`）：renderer 是它自己 V8 堆的唯一观测者，而 `processMetrics.log` 由 main 写——不送出去，曲线就与它所描述的进程同生共死。上报走已有的 `IDiagnosticsService` 通道（不新开通道），**复用采样器自己的定时循环**（不另起 timer），节流 30s / 受压 5s，`_reportedAt` 初值 0 使**首个读数必上报**（启动两分钟就崩的场景正是 30s 节流会整段漏掉的）。上报是 fire-and-forget 且吞掉 rejection——它绝不能带走唯一的堆观测者。
- **落盘格式**：`renderer-heap window=1 used=3200MB limit=4096MB usedPct=78.1 level=critical holders=acp:412MB,monaco:38MB(12)`，写进**与 `main-heap` 同一个** `processMetrics.log`（同一时间线）。main 侧 32 槽预分配 ring：平时是 16 分钟，受压后同一只 ring 变成 160 秒的密集崩溃前窗口。`level` 先过白名单正则再落日志（防换行注入），`used` 非有限/≤0 的样本**丢弃而不是写 0**——写 0 会读成"堆很健康"，正是最不该在出事报告上出现的结论。被丢的样本计入 `dropped=N`（0 时省略）：否则"从没有过曲线"和"每一条都被拒"是同一份文件，而这是两个相反的结论。受压时 `holders=` 之后还会追加 `flow=` 与 `gauge=` 两组（见下文第五类缺口），**为空则两组整体省略**，所以旧格式逐字不变。
- **`holders=` 是判定而非数值**：`acp` 取 `sharedResidentBudget.totalBytes()`（O(1)），`monaco` 取 `editor.getModels()` 的条数与 `getValueLength()` 之和，`codehtml` 取当前挂在已挂载代码块上的着色 HTML 字节（见第五类缺口）。**若已知持有者之和远小于 `used`，结论就是"元凶不在已知持有者里"**，这直接把搜索范围推出嫌疑圈——比数值本身更有用。判据的方向性要注意：`monaco` 按每条线 2 字节（UTF-16 上界）**高估**，所以它单独就能把差值抹平，即这份判据偏保守（倾向于"嫌疑人已覆盖"）。窗口号由 `createWindowScopedDiagnostics` 在 main 侧盖章（照 `createWindowScopedErrorSink` 先例），renderer 伪造不了。
- `boundedCache.ts`：通用 LRU + 条数上限 + 字节预算 + pin。**measure 函数同时用于准入与释放报告**——两个数字不一致的缓存会让内存日志谎报堆的去向。

注册的 releaser（`MemoryPressureContribution`）：

| id | 内容 | elevated 保留 | critical 保留 |
|---|---|---|---|
| `acp.cancelledDrafts` | 取消撤回的草稿（priority -10，最便宜） | — | 0 |
| `acp.promptDrafts` | 未发送的 prompt 草稿（含 base64 图片） | 75% | 0 |
| `acp.mentionFileListing` | `@` 文件清单 | 75% | 0 |
| `acp.residentBudget` | ACP 会话常驻预算 | 75% | 0 |
| `dirtyDiff.headCache` | HEAD 全文（由 `DirtyDiffContribution` 自注册） | — | — |
| `sessionChanges.liveTexts` | 会话改动追踪的活行全文（由 `SessionChangeTrackerService` 自注册） | — | 0 |

`acpElicitationDraftCache` / `acpChatViewStateCache` 只加条数上限、**不注册 releaser**（值是表单文本/滚动位置，释放的痛感大于收益）。`semanticSelector.typeHierarchyCache` 不加：其键是 Monaco token type（约 20 个闭集标准值），值全部派生自静态表，构造上就有界。

**第四类缺口：读取频次。** 上面三层管的都是**持有**——持有多大、谁持有、算不算得清。它们对「同一份内容被反复读回来又反复丢掉」零可见度：

- 重算过程本身的**瞬时分配不在任何预算里**。`sessionChangeTracker` 的每一趟重算会按顺序读被跟踪的文件全文，峰值只受 `RECOMPUTE_READ_CONCURRENCY = 8` 约束；读回来的字符串进 `_capLiveChanges` 之前不计入任何 `residentBudget`。
- tracker 的 `_observables` 活行对 `holders` **零可见度**。`holders` 的 `acp` 量的是 `sharedResidentBudget.totalBytes()`（聊天记录预算），与改动追踪的行无关——所以那次事故里 `used - sum(holders)` 的 3.6GB 缺口根本无从归因。看到巨大缺口时，改动追踪的行要进嫌疑名单，尽管 `holders` 报不出来。现在它至少有了归还通道（见上表 `sessionChanges.liveTexts`）。
- **`readFileText` 的两个消费方现在都带尺寸闸门**（`MAX_EXTERNAL_RELOAD_BYTES = 16MiB`，收在 `services/files/externalReload.ts`，四处调用点共用）：① 会话改动追踪的重算读取（`_buildChange` 的 `MAX_CURRENT_BYTES` + 二进制闸门，`_buildChange` 的预判降级）；② 编辑器为「磁盘上文件被外部改动」而做的整读重载——`FileEditorInput.checkExternalChange` 与 `ExternalChangeWatcher` 的三条对预览/diff 的重读路径。② 此前**只有 mtime 短路、没有任何尺寸判断**，而它每条路径都会被每个 watcher 批次重入一次：一个每秒被写一次的大文件就是每秒一次全文搬运。超限时的行为是**不读盘 + 把 mtime 记为已知 + 一次性通知用户**（脏缓冲区仍会先问，因为问不需要内容；用户选择保留时同样记下这次 mtime，同一份写入的后续批次不会反复弹框）；缓冲区里显示的内容会过期，这是刻意的取舍。第二条消费方在 `externalReload.ts` 里共用同一个常量，避免四处阈值各自漂移。
- 因此在诊断包上判读这类事故，除了「持有者之和 vs `used`」，还要看**同一份内容被读了几次**：`ipc-frames.txt` 里同标签的大帧条数、以及 renderer 日志里被折叠的 `large inbound ipc frame … (response fileService.readFile #N)` 计数，是这个维度的唯一证据。

**第五类缺口：渲染节奏 × 内容长度。** 前四类管的都是「持有多大」「谁持有」「读了几次」，对「同一份内容被反复**重算**」没有量纲。2026-09-12 现场里有一段独立于死因的此类事故：某会话窗口 35 秒内 working set 从 1195MB 涨到 2300MB（+1105MB），而同期 V8 主 isolate JS 堆只涨 288MB——约 **800MB 落在 V8 堆外**。那 35 秒里**只有** 7664 条 `agent_thought_chunk`（同一 messageId，220/s 均值、340/s 峰值），无任何其他渲染活动，也无大帧（排除 IPC 序列化缓冲）。定性靠的是反证：11:48（329/s）、11:54（304/s）两次**同密度**风暴没有同级抬升——所以肇因不是事件速率，而是**单次渲染成本 × 消息长度**。取消后 WS 掉约 1.9GB，即这批内存可回收，不是泄漏。

机制：16ms 事务批的是状态写入，但每批都产出新的 blocks/timeline 数组，于是**整条消息约 60 次/秒全量重渲染**。放大倍数最大的两项被逐帧重做：`monaco.editor.colorize` 的产物（每 token 一个 `<span>`，体积约为源码 5–10 倍，是 V8 堆那 288MB 的主要来源）与 Blink 的 DOM/布局/合成器缓冲（堆外 800MB 的去处，`performance.memory` 完全看不见）。工作量与消息长度成正比、累计 O(n²/chunk)，所以同样速率的早期风暴不贵。

观测口是 `renderer-heap` 行尾的 `flow=` 与 `gauge=`（`renderer/services/memory/heapFlowCounters.ts`），两组的语义**刻意分开**：

| 组 | 语义 | 名字 |
|---|---|---|
| `flow=` | **区间增量**，上报即清零；`name:calls、chars` | `mdparse` / `mdreseal` / `colorize` / `colorize.skip` / `materialize` |
| `gauge=` | **绝对值**，取最近一次渲染写入；0 值省略 | `domnodes` / `astnodes` / `sealednodes` / `tailchars` |

`flow` 有**两个读法，不可混用**：落盘行走 `drainHeapFlow()`（读即清零，采样器每 5s 一次，所以每行描述自己那段区间）；e2e 探针走 `readHeapFlowTotals()`（进程累计、非破坏性，由 spec 取前后两次读数相减）。清零型读法只能有一个消费者——探针曾共用它，于是采样器先读到的那部分对 spec 静默消失：`smoke.agentStreamMemory` 在本地稳过（约 600ms 的流恰好落在两次采样之间），在 CI 上报 `mdparse.calls: 1`。加新的计数消费者时沿用累计读法。

`sealednodes` / `tailchars` 记的是**最近一条流式消息**的密封进度（`MarkdownView` 的解析缓存本身），消息 seal 后不归零——它描述的正是「这条流结束时的代价」，seal 一下就把读数抹成 0 等于让这条量在最该看的时候消失。

读法（判定优先于数值，同 `holders`）：

- `mdparse.chars` 记的是**真正交给解析器的字符数**，不是消息长度。密封生效时它约等于消息长度（每个字符只解析一次）；它与 `calls` 同步放大则说明每次渲染都在重解析。**`mdreseal.calls` 跟涨 `mdparse.calls` 是「这条消息从未密封」的直接证据**——即 `lastSafeSplit` 找不到可切边界。
- `colorize.chars` 在流式期间应为 0（见下）。`holders` 里的 `codehtml` 是这些着色 HTML 的当前驻留量。
- `used - sum(holders)` 缺口大、而 `gauge=` 的 `astnodes` / `domnodes` 也大时，缺口在**渲染产物**里，不在任何已知持有者里——这正是前四类覆盖不到的那部分。
- `domnodes` 是 O(N) 遍历（`getElementsByTagName('*')`），只在 `level !== normal` 时才测，所以它是一条**受压窗口才有值**的量。

止血落在三处，各自可独立回滚：① 流式期间代码围栏**不着色**、mermaid 退化为代码块（`markdownStreamingContext.ts` 提供上下文，`CodeBlock` / `MermaidBlock` 读取）——门控只关 **tail 子树**，sealed 前缀与文档预览照常着色；② sealed 前缀成为 `React.memo` 边界（`MarkdownView` 的 `SealedNodes` 直接持有解析缓存的 `sealedNodes` 数组本身，`tail` 增长不触碰它）；③ 单条消息超过 `STREAM_HEAVY_CHARS = 64KB` 后批次间隔由 16ms 放宽到 64ms。观感前提是用户确认过的：流式期间不高亮、超长消息可降频。

**已知未修（由计数器判定，而非先做）**：一条消息若没有「围栏外且非松散列表内」的空行——最典型的是一整段从不闭合的代码围栏——`lastSafeSplit` 恒返回 0，密封与 ② 对它完全失效，仍按 (渲染次数 × 长度) 重解析。判定它就是 `mdreseal.calls` 与 `mdparse.calls` 同步增长。要不要为此做解析器加固，应由真机计数器回答：切出不等价 AST 会导致**显示错误**，比性能退化更严重。

### 三、崩溃恢复链路

- **stdin EPIPE**：Node 对无监听者的 `'error'` 直接走 `uncaughtException`（现场 `write EPIPE at writeStdin` 就是这么来的），而 `write` 的 callback **不是**可靠错误通道（Node 可能只发流事件）。`ManagedChildProcess` 在构造时挂上 `stdin.on('error')`，记一次 warn、存下 errno，后续写入以 `CHILD_STDIN_NOT_WRITABLE` 拒绝（errno 保留在 message 里）；**在途的写入 promise 也由同一个流事件 reject**（否则只走流事件的失败会让调用方永久挂起）。`dispose` 摘除 stdout/stderr/exit 监听，但 **stdin 的 `'error'` 监听故意留着**——SIGKILL 之后子进程仍可能让 stdin 报错，摘掉就等于把这条崩溃路径还回去。
- **IPC 洪流**：Electron 43 的 `webFrameMain.send` **内部 catch 后打 console.error，不抛**，所以原来的 `try/catch` 是死代码。改为 send 前主动查 `isCrashed()` / `mainFrame.isDestroyed()` / `detached`——现场 `render-process-gone` 迟到约 48s，事件驱动的门在那段时间是开的，每次 send 都失败，而每次失败又经"日志→IPC 转发→send"闭环放大（现场 225 条）。
  - 门关了就**闩住**，不每帧重探；`dom-ready`/`did-finish-load` 在闩锁期内**不开闸**（它们分辨不出新帧和将死的帧），renderer 真实发来的消息立刻清闩锁。
  - 闩锁**有截止时间**（`FRAME_UNREACHABLE_LATCH_MS = 30s`），不是永久位：那条失败文本不指名是哪个窗口，所以 `markRendererFramesUnreachable()` 会关掉**所有**窗口的门——多窗口下健康窗口若永久闩住，它的推送会被静默丢弃且不重放。截止时间让误伤最多持续一个窗口期；仍存活的窗口下一次 `dom-ready` 就恢复，真死的窗口每 30s 只付一次探测 send。
  - `Error sending from webFrameMain` 经 `installConsoleInterceptor` 的 `suppress` 钩子做**折叠**（`LogFloodFold`，1s 窗口 + 计数）并触发 `markRendererFramesUnreachable()`——在 `render-process-gone` 迟到的那几十秒里提前关闸。折叠键是常量而非整行文本（Electron 会附加可变的尾串，用整行做键会一条都折不掉）。
  - `markRendererFramesUnreachable` **不**触发 `onDidClose`：那会拆掉 ChannelServer 的订阅，对**已确认**死亡的 renderer 是对的，对"从一行日志推断出来的"不是。
- **延迟 reload**：崩溃对话框是窗口模态，无人点击则 `.then()` 永不 resolve，而 `win.reload()` 就在 `.then()` 里（现场黑屏 15m21s）。改为 20s 超时自动 reload + 崩溃风暴退避（5 分钟内 ≥3 次只提示不自动重载），`settled` 标志防双重动作。**不改成"先 reload 再提示"**——风暴下会无限重载。同理，风暴期间**对话框自身 reject 也不重载**（那会绕过退避变成无限重载循环，正是退避要防的事）；黑窗是这里的较小恶，下次启动的异常退出计数会提供「跳过恢复」。

## 诊断包里的相关文件

- `ipc-frames.txt`：main 侧帧环形记录 + 统计 + 最大帧标签。每行/标签形如 `out response fileService.readFile #42`；`#id` 是把它与 renderer 侧告警对上、再与那次请求对上三者的唯一把手。
- `memory.txt`：main 堆（`formatMainHeapSample`）+ 托管进程树内存（`hosted-processes cnt=… name#pid=…MB/…%`）+ **renderer 堆曲线尾部 32 条**（`renderer-heap samples=32 (newest first)`，最新在前）。曲线进 zip 而不是只留在日志里，是因为日志尾部有 512KiB 截断，会恰好丢掉慢速爬升最早的那几条。
- `sysinfo.md` / 日志尾部：renderer 侧的 `[memory] …` 行（水位变化时打印 `describe()` + 最近 12 帧）。
- 详见 [error-diagnostics.md](error-diagnostics.md)。

## 已知取舍与后续项

- **`reviver` 的 base64 解码峰值（约 3.5×）未重构**。延后解码会破坏 `instanceof Uint8Array` 契约，改动面是全仓每个 IPC 消费点，与止血目标不成比例。当前做法是"已知峰值模型 + 硬上限兜底"。
- **`VIEW_MODEL_OVERHEAD_FACTOR = 3` 系数不改**。它是记账单位，改成动态值会让同一卡片在 measure 与 release 拿到不同系数，账永远配不平。实测改由水位服务提供，职责分离。
- **硬上限可能误伤合法大帧**（用户把 `acp.prompt.image.maxSizeMB` 调到 50 → 约 340MB 帧）。这是刻意取舍：该帧 decode 峰值约 1.2GB，本就会 OOM。回滚 = 改一个常量。
- **同一份用户 prompt 可能被记两次**：本地 append 走 `_appendMessage` 的显式记账，agent 若把该消息回显成 `user_message_chunk`，`applyUpdate` 会再按 `estimateUpdateCost` 记一次。方向是保守的（提前 trim，不会漏记），且 `_releaseResidentDownTo` 在 `freed === 0` 时用 `_measureResidentBytes()` 重算兜底，账不会永久漂高。真要收口需要按 messageId 去重记账，改动面大于收益。
- **流式渲染的解析器加固延后**：无安全切点的消息（典型是一整段不闭合的代码围栏）密封失效，仍按 (渲染次数 × 长度) 重解析。不做是因为切出不等价 AST 会导致显示错误，而它是否真的发生可以由 `mdreseal` / `mdparse` 计数器在真机上回答。见第五类缺口。
- **`holders` 只覆盖已知持有者**：`acp` 与 `monaco` 之外的堆（`output` 通道、diff 缓存、webview、第三方库的字符串）不计。这不是缺陷而是判据的一半——"已知持有者之和 vs `used`"的差值本身就是结论。补 `output` 需要 `IOutputService` 暴露通道枚举，留作后续；崩溃栈落在 `OutputModelService._applyFlush ← ModelRawLineChanged` 的那份报告说明它值得补。上一条提到的高估方向同样作用于这个差值。
- **32 槽 ring 不按窗口分割**：多窗口下每个窗口各自上报，共用同一只 ring（≈每窗口 16 条）。判定依据是"崩溃的那个窗口在最后一刻的曲线"，共用 ring 在最坏情况下仍保留它最近的若干条。真要多窗口精读再按窗口分桶。
- **renderer 侧自己的帧 ring 不进诊断包**：renderer OOM 时来不及落盘，只有 main 侧那份能活到导出。**出站热路径只加一次比较**是硬约束：任何"顺便做点别的"的改动都要先证明它不分配。
- **被降级的改动行会粘住**：`sessionChangeTracker` 的 `(size, mtime)` 行缓存缓存的是 **cap 之后**的行（必须如此，否则被降级的行会把两份全文永久留在缓存里），所以一行一旦因超预算被降级，只要文件 size/mtime 不变就一直显示 degraded，即使预算压力已经消失。换来的读短路值得这个代价，逃生口也是现成的：文件一动、或 `record()` 再触发一次失效即恢复。
- **预判降级会多降级一些 CJK 文本**：读之前的预判用 `2 × (baseline 字符数 + size 字节数) > maxLiveChangeBytes`，`chars ≤ bytes` 使它是保守估计（宁可多降级也不多读）。一个 9MiB 的 CJK 文本本该产出约 12MB 的行（预算内），会被直接降级。该门闸的存在意义是：这样的行**必然**会被 `_capLiveChanges` 的 heaviest-first 循环降级，读它是纯浪费。**对 `watched` 无 baseline 的行它按两份文本估算，而该行实际只按引用持有一份**（`baselineSource:'none'` 的 baseline 就是 `current`），即这类超过 8MiB 的文件会被降级、而预算本来容得下 16MiB —— 这是**刻意保留**的保守：事故里那个约 16MiB 的二进制正是这个形状，把门闸放宽到 2× 就等于把那次的读取放回来。


## 验证

- 单测：`packages/platform/src/__tests__/ipc/ipcFrameGuard.test.ts`、`ipcFrameGate.test.ts`、`log/logFloodFold.test.ts`；`apps/editor/src/renderer/services/memory/__tests__/`（阈值/迟滞/缓存归还字节、上报节流与"首个读数必上报"、holder 采集容错、`heapFlowCounters.test.ts` 的 drain 清零与非法值、累计读法不被 drain 影响、`flow=`/`gauge=` 为空时字段整体省略、取数抛错不影响堆读数）、`rendererHeapReporter.test.ts`、`main/services/diagnostics/__tests__/`（`renderer-heap` 行格式、非法样本被丢、越界的 `flow`/`gauge` 条目被丢、ring 满 32 淘汰最旧、窗口号盖章）、`AcpSession.liveBudget.test.ts`（trim 后 `_residentBytes === _measureResidentBytes()`）、`services/acp/__tests__/markdownIncremental.test.ts`（等价性、sealed 前缀的元素身份、`mdparse.chars` 记的是被重新解析的字符数）、`workbench/agents/__tests__/CodeBlock.test.tsx` + `workbench/markdown/__tests__/markdownStreamingGating.test.tsx`（流式期间不着色、seal 后着色一次、回收实例翻回流式时旧 html 被清空、sealed 段在 tail 增长时不被重渲染）。
- e2e：`@p0` `apps/editor/e2e/specs/smoke.memoryPressure.spec.ts`——**直接验证"`performance.memory` 在真实 Electron renderer 里可读"这个核心假设**、releaser 已注册、强制释放有归因，以及**堆曲线真的抵达 main 的 `processMetrics.log`**。最后一条是必需的：上报是 fire-and-forget，方法名写错或通道没注册会被完全静默吞掉，产出的报告与"这个构建本来就没有曲线"无法区分。
- e2e：`@p1` `apps/editor/e2e/specs/smoke.agentStreamMemory.spec.ts`——把一条 300KB 的思考消息喂给真窗口（夹具 `emit-thought:<count>x<kb>[,fence]`，回合在末块后留 500ms 观察窗），断言**可密封消息的 `mdparse.chars` 不超过 (长度 + 每次调用有界的尾部)**、sealed 缓存确实在增长、`colorize.chars === 0`；再断言**从不闭合的围栏在流式期间 `colorize.chars === 0`、seal 之后被着色**，两条都比对全文逐字符相等。刻意不断言 WS/RSS/墙钟：那是机器属性，而这里要守的是算法形状。
