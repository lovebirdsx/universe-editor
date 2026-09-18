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
- **`holders=` 是判定而非数值**：`acp` 取 `sharedResidentBudget.totalBytes()`（O(1)），`monaco` 取 `editor.getModels()` 的条数与 `getValueLength()` 之和，`codehtml` 取当前挂在已挂载代码块上的着色 HTML 字节（见第五类缺口；**不含 mermaid 图**——`MermaidBlock` 走另一条渲染分支，它渲染出的 SVG 是同类的大字符串但没有计入，看到 `codehtml` 很小时别把它排除干净），`changes` 取 `sessionChangeTracker` 的序列化记录与活行文本之和（见下），`output` 取各输出通道的 `retainedChars` 之和。**若已知持有者之和远小于 `used`，结论就是"元凶不在已知持有者里"**，这直接把搜索范围推出嫌疑圈——比数值本身更有用。判据的方向性要注意：`monaco` 按每条线 2 字节（UTF-16 上界）**高估**，所以它单独就能把差值抹平，即这份判据偏保守（倾向于"嫌疑人已覆盖"）。窗口号由 `createWindowScopedDiagnostics` 在 main 侧盖章（照 `createWindowScopedErrorSink` 先例），renderer 伪造不了。线尾还会带上 `unexplained=<n>MB`（`used − Σholders`，2026-09-18 那份包报不出来的中间数）：它**只**表示「当前估算没有解释的部分」，不是泄漏、不是丢失的分配、更不是缺陷计数——`holders` 覆盖的本来就是堆的一个子集（V8 内部结构、Monaco 自己的对象、以及所有没被计量的东西都在另一侧）。完全没有 holder 上报时整段省略（那种读数的「没解释」是构造性的，缺这段本身就在说这件事）。
- **`counts=` 报的是个数，与字节分开**：`sessions:<n>,budget.holders:<n>,pool:<n>` 由 renderer 以 O(1) 只读 getter 取（`acpSessionService.sessions` / `acpResidentBudget` 的 Set / `acpClientService` 连接池），**不遍历正文、不新增全域 IPC 计数**。口径与 `gauge` 刻意不同：`count` 返回 0 **照写**（0 个会话是一个读数），读不到（服务没装配/取数抛错）则该条目整体缺席——「一个都没有」和「这个构建没有这个服务」不能塌成同一行。读法：`used` 涨而 `counts` 不涨，指向单个会话/单条连接的体量；`counts` 涨而 `holders` 不涨，说明涨的那部分没有被任何已登记的预算管着。
- **每个样本带 renderer 自证身份的 `incarnation`**（每次 renderer 启动生成），main 侧连同 windowId/PID/导航代次一起盖章。它挡的是「上一个 renderer 的样本迟到、被算到接替它的那个堆头上」——导航代次在 reload 场景能挡住，但同一代次内被替换掉的帧（IPC 在途）只能靠它。快照轮次（见下）额外要求同一 incarnation，否则宁可丢一个样本。
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
- tracker 的 `_observables` 活行曾有**零可见度**：`holders` 的 `acp` 量的是 `sharedResidentBudget.totalBytes()`（聊天记录预算），与改动追踪的行无关——所以那次事故里 `used - sum(holders)` 的 3.6GB 缺口根本无从归因。看到巨大缺口时，改动追踪的行要进嫌疑名单。现在它有了归还通道（见上表 `sessionChanges.liveTexts`）**和**自己的读数（`holders` 的 `changes`：`_sessionBytes` 的序列化记录 + `_liveChangeBytes` 的活行文本，两个结构都驻留所以都计入）。
- **`readFileText` 的两个消费方现在都带尺寸闸门**（`MAX_EXTERNAL_RELOAD_BYTES = 16MiB`，收在 `services/files/externalReload.ts`，四处调用点共用）：① 会话改动追踪的重算读取（`_buildChange` 的 `MAX_CURRENT_BYTES` + 二进制闸门，`_buildChange` 的预判降级）；② 编辑器为「磁盘上文件被外部改动」而做的整读重载——`FileEditorInput.checkExternalChange` 与 `ExternalChangeWatcher` 的三条对预览/diff 的重读路径。② 此前**只有 mtime 短路、没有任何尺寸判断**，而它每条路径都会被每个 watcher 批次重入一次：一个每秒被写一次的大文件就是每秒一次全文搬运。超限时的行为是**不读盘 + 把 mtime 记为已知 + 一次性通知用户**（脏缓冲区仍会先问，因为问不需要内容；用户选择保留时同样记下这次 mtime，同一份写入的后续批次不会反复弹框）；缓冲区里显示的内容会过期，这是刻意的取舍。第二条消费方在 `externalReload.ts` 里共用同一个常量，避免四处阈值各自漂移。
- 因此在诊断包上判读这类事故，除了「持有者之和 vs `used`」，还要看**同一份内容被读了几次**：`ipc-frames.txt` 里同标签的大帧条数、以及 renderer 日志里被折叠的 `large inbound ipc frame … (response fileService.readFile #N)` 计数，是这个维度的唯一证据。

**第五类缺口：渲染节奏 × 内容长度。** 前四类管的都是「持有多大」「谁持有」「读了几次」，对「同一份内容被反复**重算**」没有量纲。2026-09-12 现场里有一段独立于死因的此类事故：某会话窗口 35 秒内 working set 从 1195MB 涨到 2300MB（+1105MB），而同期 V8 主 isolate JS 堆只涨 288MB——约 **800MB 落在 V8 堆外**。那 35 秒里**只有** 7664 条 `agent_thought_chunk`（同一 messageId，220/s 均值、340/s 峰值），无任何其他渲染活动，也无大帧（排除 IPC 序列化缓冲）。定性靠的是反证：11:48（329/s）、11:54（304/s）两次**同密度**风暴没有同级抬升——所以肇因不是事件速率，而是**单次渲染成本 × 消息长度**。取消后 WS 掉约 1.9GB，即这批内存可回收，不是泄漏。

机制：16ms 事务批的是状态写入，但每批都产出新的 blocks/timeline 数组，于是**整条消息约 60 次/秒全量重渲染**。放大倍数最大的两项被逐帧重做：`monaco.editor.colorize` 的产物（每 token 一个 `<span>`，体积约为源码 5–10 倍，是 V8 堆那 288MB 的主要来源）与 Blink 的 DOM/布局/合成器缓冲（堆外 800MB 的去处，`performance.memory` 完全看不见）。工作量与消息长度成正比、累计 O(n²/chunk)，所以同样速率的早期风暴不贵。

观测口是 `renderer-heap` 行尾的 `flow=` 与 `gauge=`（`renderer/services/memory/heapFlowCounters.ts`），两组的语义**刻意分开**：

| 组 | 语义 | 名字 |
|---|---|---|
| `flow=` | **区间增量**，上报即清零；`name:calls、chars` | `mdparse` / `mdreseal` / `colorize` / `colorize.skip` / `materialize`（顶层）/ `childchunks`（子代理） |
| `gauge=` | **绝对值**，0 值省略 | `domnodes`（进程唯一，取最近一次写入）；`views` / `astnodes` / `sealednodes` / `tailchars` / `mdbytes`（**跨全部已挂载 `MarkdownView` 求和**） |

`flow` 有**两个读法，不可混用**：落盘行走 `drainHeapFlow()`（读即清零，采样器每 5s 一次，所以每行描述自己那段区间）；e2e 探针走 `readHeapFlowTotals()`（进程累计、非破坏性，由 spec 取前后两次读数相减）。清零型读法只能有一个消费者——探针曾共用它，于是采样器先读到的那部分对 spec 静默消失：`smoke.agentStreamMemory` 在本地稳过（约 600ms 的流恰好落在两次采样之间），在 CI 上报 `mdparse.calls: 1`。加新的计数消费者时沿用累计读法。

`materialize` 与 `childchunks` 是同一件事的两条路径：前者是顶层消息的合并发布，后者是**子代理消息**（挂在父卡 `children` 上，从不出现在 `_messages` 里）。哪个涨就说明那一侧是主力——2026-09-12 的包里两条路径同时在跑，而当时的计数器只有前者，所以「子代理路径是不是主力」这个问题没有答案。

`sealednodes` / `tailchars` 记的是**当前挂载的每个 `MarkdownView` 的解析缓存**，跨视图求和，消息 seal 后不归零——它描述的正是「这条流结束时的代价」，seal 一下就把读数抹成 0 等于让这条量在最该看的时候消失。**求和而不是「最后写入者胜」**：同时挂着多个聊天面板时，最后渲染的那个不是持有内容的那个，而这条量要回答的是「这个窗口扛着多少 markdown」；旧写法下无论挂几个面板都只报其中一个的量，是**系统性低报**。`views` 是挂载数，它说明后面几个求和值在描述一个面板还是一打；`mdbytes` 是各视图源文本长度之和（sealed 前缀 + tail）。

⚠️ 求和之后 **`tailchars` 单独不再是「某条流未密封的尾巴」**：非流式视图的 `sealedNodes` 为空、`tailChars` 就是它的全文长度，所以 `tailchars` 实际等于「全部已挂载 markdown 的源长度之和」，与 `mdbytes` 高度重合——50 条 20KB 的历史消息在**零流式**时就能报出约 1MB。判「有没有一条巨大的未密封 tail」要看 `sealednodes` 是否同时在动（静态视图对它贡献 0，方向是干净的），不能只看 `tailchars` 大。

读法（判定优先于数值，同 `holders`）：

- `mdparse.chars` 记的是**真正交给解析器的字符数**，不是消息长度。密封生效时它约等于消息长度（每个字符只解析一次）；它与 `calls` 同步放大则说明每次渲染都在重解析。**`mdreseal.calls` 跟涨 `mdparse.calls` 是「这条消息从未密封」的直接证据**——即 `lastSafeSplit` 找不到可切边界。
- `colorize.chars` 在流式期间应为 0（见下）。`holders` 里的 `codehtml` 是这些着色 HTML 的当前驻留量。
- `used - sum(holders)` 缺口大、而 `gauge=` 的 `astnodes` / `domnodes` / `mdbytes` 也大时，缺口在**渲染产物**里，不在任何已知持有者里——这正是前四类覆盖不到的那部分。
- `domnodes` 是 O(N) 遍历（`getElementsByTagName('*')`），只在 `level !== normal` 时才测，所以它是一条**受压窗口才有值**的量。

止血落在三处，各自可独立回滚：① 流式期间代码围栏**不着色**、mermaid 退化为代码块（`markdownStreamingContext.ts` 提供上下文，`CodeBlock` / `MermaidBlock` 读取）——门控只关 **tail 子树**，sealed 前缀与文档预览照常着色；② sealed 前缀成为 `React.memo` 边界（`MarkdownView` 的 `SealedNodes` 直接持有解析缓存的 `sealedNodes` 数组本身，`tail` 增长不触碰它）；③ 单条消息超过 `STREAM_HEAVY_CHARS = 64KB` 后批次间隔由 16ms 放宽到 64ms。观感前提是用户确认过的：流式期间不高亮、超长消息可降频。

**子代理路径（`toolCall.children`）上这三处曾全部落空**，因为 `AcpMessage` 的流式标志锚在 `_messages` 与 `_streamingIds` 上，而子代理消息从不进 `_messages`：它由 `_appendChildChunk` 建为 `streaming: false`（→ 静态全量解析、围栏每帧重着色），`_appendChildChunk` 又在函数入口以长度 0 打开了批次（→ 截止时间恒为 16ms，与消息多长无关；注意 `_batchedTx(len)` 只在**创建**批次时读 `len`，所以补长度必须补在真正开批的那一处），`ToolCallCard` 也没把标志传给 `MessageContent`。补齐方式是**加一个独立字段 `AcpMessage.live` 而不复用 `streaming`**：一个 flag 挂两个生命周期，未来"顺手补齐对称性"会让子代理流式中途被打断——而卡在 true 的代价不只是多渲染，`MarkdownStreamingContext` 会让围栏**永久不着色**、围栏内路径**永久不可点**。清除落在：回合结束（`_flushStream`，先 materialize 未决合并再扫，否则提交会把仍 live 的 base 重新铺开）、重放结束（`endHistoryReplay`）、角色切换与追加子 tool call（消息不再位于 children 末尾即运行结束）、**父卡 settle**（见下）、以及 trim（`trimMessage` 的字段列表本就丢弃它，单测守着这一点）。**不要**在父卡的 `tool_call_update` 上无条件清——PostToolUse 钩子会在子代理还在说话时重建父卡，清一次就打断一次。

**父卡 settle 是子代理自己的收尾信号**（`isSettledToolCallStatus`，即 wire 给 Task 卡发 `completed`/`failed`）：只在"回合结束"清是不够的。子代理最常见的收尾形态是**最后一条为 message 而非 tool call**（Task 的最终报告），此时从它停止输出到整个回合结束之间**没有任何别的 seal 信号**，而那段时间可能是几分钟——报告里的围栏一直不着色、围栏内路径一直不可点。上面的 PostToolUse 陷阱之所以不受影响，是因为那种中途重建带的是 `in_progress`，拿得到 settle 的只有真正的收尾。**提前清是可恢复的**：`_materializePendingChildMerge` 无条件写回 `live: true`（走到那里就意味着这条消息刚吃了新文本，它在长是定义），所以一个迟到/乱序的 chunk 会把消息重新放回流式路径，而不是悄悄退回静态全量解析——那个代价正是 `live` 存在的理由，且它不会有任何报错。

注意子代理卡默认折叠，而折叠时子代理消息**根本不挂载**（`CollapsibleSlot` 的 `{!collapsed && …}`），所以这条缺口只在用户展开过 Task 卡时发作。但**即使折叠，每批仍会 `timeline.set`**（`_setChildren` 重建 + 提交），订阅方每 16ms 跑一轮——所以批次降频的价值不依赖卡片是否展开。

**已知未修（由计数器判定，而非先做）**：一条消息若没有「围栏外且非松散列表内」的空行——最典型的是一整段从不闭合的代码围栏——`lastSafeSplit` 恒返回 0，密封与 ② 对它完全失效，仍按 (渲染次数 × 长度) 重解析。判定它就是 `mdreseal.calls` 与 `mdparse.calls` 同步增长。要不要为此做解析器加固，应由真机计数器回答：切出不等价 AST 会导致**显示错误**，比性能退化更严重。

### 三、崩溃恢复链路

- **stdin EPIPE**：Node 对无监听者的 `'error'` 直接走 `uncaughtException`（现场 `write EPIPE at writeStdin` 就是这么来的），而 `write` 的 callback **不是**可靠错误通道（Node 可能只发流事件）。`ManagedChildProcess` 在构造时挂上 `stdin.on('error')`，记一次 warn、存下 errno，后续写入以 `CHILD_STDIN_NOT_WRITABLE` 拒绝（errno 保留在 message 里）；**在途的写入 promise 也由同一个流事件 reject**（否则只走流事件的失败会让调用方永久挂起）。`dispose` 摘除 stdout/stderr/exit 监听，但 **stdin 的 `'error'` 监听故意留着**——SIGKILL 之后子进程仍可能让 stdin 报错，摘掉就等于把这条崩溃路径还回去。
- **IPC 洪流**：Electron 43 的 `webFrameMain.send` **内部 catch 后打 console.error，不抛**，所以原来的 `try/catch` 是死代码。改为 send 前主动查 `isCrashed()` / `mainFrame.isDestroyed()` / `detached`——现场 `render-process-gone` 迟到约 48s，事件驱动的门在那段时间是开的，每次 send 都失败，而每次失败又经"日志→IPC 转发→send"闭环放大（现场 225 条）。
  - 门关了就**闩住**，不每帧重探；`dom-ready`/`did-finish-load` 在闩锁期内**不开闸**（它们分辨不出新帧和将死的帧），renderer 真实发来的消息立刻清闩锁。
  - 闩锁**有截止时间**（`FRAME_UNREACHABLE_LATCH_MS = 30s`），不是永久位：那条失败文本不指名是哪个窗口，所以 `markRendererFramesUnreachable()` 会关掉**所有**窗口的门——多窗口下健康窗口若永久闩住，它的推送会被静默丢弃且不重放。截止时间让误伤最多持续一个窗口期；仍存活的窗口下一次 `dom-ready` 就恢复，真死的窗口每 30s 只付一次探测 send。
  - `Error sending from webFrameMain` 经 `installConsoleInterceptor` 的 `suppress` 钩子做**折叠**（`LogFloodFold`，1s 窗口 + 计数）并触发 `markRendererFramesUnreachable()`——在 `render-process-gone` 迟到的那几十秒里提前关闸。折叠键是常量而非整行文本（Electron 会附加可变的尾串，用整行做键会一条都折不掉）。
  - `markRendererFramesUnreachable` **不**触发 `onDidClose`：那会拆掉 ChannelServer 的订阅，对**已确认**死亡的 renderer 是对的，对"从一行日志推断出来的"不是。
- **延迟 reload**：崩溃对话框是窗口模态，无人点击则 `.then()` 永不 resolve，而 `win.reload()` 就在 `.then()` 里（现场黑屏 15m21s）。改为 20s 超时自动 reload + 崩溃风暴退避（5 分钟内 ≥3 次只提示不自动重载），`settled` 标志防双重动作。**不改成"先 reload 再提示"**——风暴下会无限重载。同理，风暴期间**对话框自身 reject 也不重载**（那会绕过退避变成无限重载循环，正是退避要防的事）；黑窗是这里的较小恶，下次启动的异常退出计数会提供「跳过恢复」。

## 按需受控堆快照（用户开启一次，自动采两份）

计数器与水位能缩小到「某一类」，回答不了「这 2GB 是谁持有的」。2026-09-18 那份包里 `used` 约 2GB、已登记的业务缓存约 32MB——中间那 1.9GB 在 `holders` 名单之外，而没有任何对象图可以拿去追引用链。这一段就是补那份对象图：**用户显式开启、本机保存、按轮次限额**，只在需要复现时用。

> ⚠️ 先读这一句：**这不是「已修未知泄漏」**。它是取证据的手段，不是止血；未知泄漏仍在（`ipc-frames.txt` 里那条「同一份内容被反复读回来」的第四类缺口、以及所有没进 `holders` 的持有路径）。快照本身也会暂停窗口并额外分配内存，资源检查只是准入判断，不是内存硬保证——**不承诺固定耗时，也不承诺绝不 OOM**。

**入口与授权范围**（`renderer/actions/helpActions.ts`，Help 菜单 `5_tools` 组 + 命令面板；无快捷键）

- 「开始内存诊断」`workbench.action.startHeapSnapshotDiagnostics`：先弹确认框（`IDialogService.confirm`，warning）——讲清四件事：**只诊断当前窗口**、采集期间**窗口会暂停数秒至数十秒**、快照是**当时堆里的字符串副本（可能含文件内容、会话正文、凭据）**、**只写本机且不会自动上传**；停止**不会取消**已经开始的那一份。跳过这个对话框就等于在这四件事上撒谎，所以它是命令的一部分，不是可选装饰。
- 「停止内存诊断」`…stopHeapSnapshotDiagnostics`：停住**后续**抓取。正在写的那份按「仍在写、无法取消」上报（`takeHeapSnapshot` 没有取消 API），**绝不写「已停止」**——那会让用户以为冻结结束了。
- 「打开内存快照目录」`…openHeapSnapshotsFolder`：路径由 main 决定，renderer 不传路径进来。
- **默认关闭、不持久化、没有任何配置项能开启它**（不存在可被工作区 settings 静默打开的键）；重复开启幂等（不重置本轮预算）；**全应用额度用尽时「开始」当场拒绝并说明理由**（不先发「已开启」再收回）；reload / 关窗即停止；一轮最长 **2 小时**（轮次自带到期计时器，**没有任何样本也会到期**，`status` 查询同样会先结账）。**同一次开始/停止只有一条通知**：开局、拒绝、结束一律由轮次事件流报，命令只报事件报不出来的那几种（重复点开始→回状态、服务未接上、IPC 失败），用户主动停止则是命令自己报、控制器静默。三条命令都**不带 icon**：`registerAction2` 会把 `desc.icon` 撒进它声明的每个菜单槽位，而菜单栏下拉只要有一项带图标就整组开启图标列（`iconCoverage.test.ts` 断言菜单栏一律无图标）；palette 侧也不读命令图标。

**一轮的判定链**（纯数值决策在 `main/services/diagnostics/heapSnapshotPolicy.ts`，注入时钟；编排与身份在 `heapSnapshotController.ts`）

| 阶段 | 判据 | 常量 |
|---|---|---|
| 基线 | 武装后 ≥60s、≥3 个有效样本、样本波动 ≤ 均值 10% | `minArmMs` / `minSamples` / `baselineBandRatio` |
| 拍摄上限 | `min(1GiB, 30% × V8 堆上限)`；堆上限从没上报过 → **永不自动拍** | `captureMaxBytes` / `captureLimitRatio` |
| 基线大小 | 堆 ≤ `min(512MiB, 拍摄上限/2)` 才拍 | `baselineMaxBytes` |
| 增长 | 参照点 = 基线之后**最低**的读数（抓取会推一次 GC，拿第一个样本当参照会把回升报成增长）；阈值 `max(256MiB, 50%×基线)`，再收窄到剩余余量的一半 | `growthMinBytes` / `growthBaselineRatio` |
| 持续性 | 连续 ≥3 个样本在阈值之上、且跨度 ≥60s | `growthSamples` / `growthSpanMs` |
| 已知解释 | 已知 holder 的增长 ≥ 涨幅的 50% → 判为「已被解释」，不拍 | `holderExplainRatio` |
| 新鲜度 | 样本比 45s 更旧 → 失去依据（窗口可能已不再上报），**只拦住这一次抓取、不结束轮次** | `sampleFreshMs` |
| 频次 | 两次抓取间隔 ≥5 分钟；每窗口每轮 ≤2 次调用（**失败也算**）；整个应用运行期 ≤4 次（停止/重开**不重置**，用尽则「开始」当场拒绝）；失败即结束本轮 | `minCaptureSpacingMs` / `maxAttemptsPerRound` / `maxAttemptsPerApp` |

> 参照点是**独立于滑窗**的一条低水位记录（值 + 当时的 holders + 时间），只在出现新低谷时下调、**永不上调**，也不随滑窗淘汰。曾经的做法是每轮从保留的 24 个样本里现取最小值：窗口一滚，参照点就跟着被抬走，于是「每个采样周期涨 1MiB」这类慢速爬升永远够不到阈值——阈值本身在跟着一起涨。`heapSnapshotPolicy.test.ts` 里那条 20 分钟慢爬用例就是照这个形状写的（默认阈值、5s 节奏）。

**资源与并发闸门**

- 只用**当前窗口的新鲜样本**（≤45s，时间取 **main 的接收时刻**，不信 renderer 自己的钟）。同一套复核（`_revalidate`）在**建目录之前和之后各走一遍**，最后再**同步重读一次资源读数**才调用抓取：`fs.mkdir` / `statfs` 这些 await 在慢盘上可能比整个准入检查还久，等待期间轮次可能到期、renderer 可能被换掉、样本可能变旧。三类问题的后果**刻意不同**：窗口/身份/时限出问题 → **结束轮次**（那个堆已经没人有了，抓到的文件只能丢弃，不能改名留下）；样本过期或上限不够 → **只拦住这一次抓取**（窗口暂停上报不等于诊断出错，下个样本会重新判断），且按 code 折叠提示、不刷屏。
- **窗口没了**（`no-target` / `window-closed`）与**窗口还在但 renderer 已死**（`renderer-unavailable`，命令开始时的拒绝和运行中掉线共用同一个码）是两种结局，不许合并：把崩溃的 renderer 报成「窗口已关闭」会指向一个用户看不见的事件，他只会去找一个明明还开着的窗口。
- 可用物理内存 ≥ `max(2GiB, 2×used)`——这一项**每次现读 `os.freemem()`**，不复用采样器缓存：缓存里的空闲物理内存是 commit 查询那一刻的伴随读数，两次之间可能隔一分钟，拿过期的数当现在正好会在最不该猜的时候猜；Windows 还要求**新鲜**的 commit 读数（≤90s）且提交余量 ≥ `max(2GiB, 2×used)`（commit 必须起进程去问，所以共用采样器缓存，但状态里带着年龄）；磁盘 ≥ `2GiB + 2×used`。读数失败或陈旧**保守跳过并明确说明**（`disk-unknown` / `commit-unknown`），**绝不猜**；非 Windows 不把「平台没有 commit 记账」当成错误（`unsupported` ≠ 失败）。目录**读不出来**（非 ENOENT）同样按 `disk-unknown` 拒绝，不当成空目录——空目录会让预算闸门失效，而一份读不出来的目录里可能正堆着几 GB。磁盘读数取**最近的已存在祖先**（`diskFreeBytesFor`）：快照目录要到第一次采集成功才建，而 `statfs` 对不存在的路径抛 ENOENT——直接读它会把「目录还没建」读成 `disk-unknown`，而那个拒绝**永远解不开**（只有成功的采集才会建目录）。
- 整个应用同时只有**一次**真正的抓取，不排无界队列（忙就等下一个样本重新决策，`HeapSnapshotController._inflight`）。`takeHeapSnapshot` 无取消 API：**90s 超时只是提示**（发一条 `capture-stalled`），**不释放并发锁、不启动下一份**；锁在 promise 真正落定时释放。提示发出前要确认「还是不是这个窗口当前那一轮」：reload 后新轮次收到旧轮次的迟到提醒，会把「上一位 renderer 还在写」读成「你现在卡住了」。同理，凡可能迟到的报告（停止、失败、抓取完成、样本判定）都带这一道守卫，被顶替的轮次只留日志、不进事件流。
- 快照产物与 partial 都受目录预算约束（`4GiB` / `8` 个产物），到顶即停止并**告知用户手动清理**，从不自动删历史文件。

**文件、隐私与诊断包**

- `<userData>/diagnostics/heap-snapshots/`（**刻意不放 `logs/`**：几百 MB 的产物不该被日志保留策略扫掉或被打进报告）。文件名由 main 生成；先写 `heap-<trigger>-w<id>-<stamp>.heapsnapshot.partial`，**API 成功且身份仍匹配**才 rename 成 `.heapsnapshot`，并写同名 `.json` sidecar（trigger / 窗口 / PID / 代次 / 采样值 / 耗时 / 字节数 / 状态）。上次异常退出残留的 partial 只列为 `incomplete`，不直接删。
- 日志只记 `heap-snapshot captured trigger=… window=… pid=… bytes=… duration=…s`，**不含快照正文**。
- 诊断 zip 里只有 `heap-snapshots.txt`（**清单**：时间 / 大小 / 类型 / 未完成标记），**永不打包原件**；「报告问题」的上传链路因此不可能把快照发出去——它要发去问题跟踪系统，而快照里装着当时堆上的各种字符串。分享快照只能在用户自己的机器上手工进行（「打开内存快照目录」）。
- 采集走 `webContents.takeHeapSnapshot(path)`：**不新建 CDP 连接、不调用强制 GC、不解析也不整份加载快照进内存**（对象图从不经过 main 的 JS 堆）。
- 实测（e2e 冷启空窗口，2026-09-18）：49MB 活跃堆 → 85.5MB 文件 / 耗时 2s，冻结就是这 2s。小堆上固定元数据占比大，**文件/堆比例不是常数**，别按 MB 外推耗时——上表那个 0.55~0.69 是大堆（几百 MB 起）的读数。

## 内存提醒（长期偏高且释放无效时）

水位服务自己会释放（见上文「renderer 内存水位」），但**释放失败时没有人告诉用户**：那次崩溃里窗口在 elevated 线上停了 20+ 分钟、每次 releaser 都返回 0.0MB，直到 V8 abort 都没有一句话。提醒就是补上这一句，并把用户直接接到上面那套受控快照上。

**判定**（`renderer/services/memory/memoryReminderPolicy.ts`，纯函数、时间只从样本取）：

| 常量 | 值 | 由来 |
|---|---|---|
| `MEMORY_REMINDER_SUSTAIN_MS` | 10 分钟 | 事故样本是 elevated 持续 20+ 分钟后 OOM，10 分钟能在中段提醒 |
| `MEMORY_REMINDER_OBSERVATION_GAP_MS` | 3 分钟 | 相邻读数间隔超过它就是「没人在看」；必须大于 Chromium 后台定时器节流周期，否则窗口只是切到后台就会被判成读数中断 |
| `MEMORY_REMINDER_COOLDOWN_MS` | 30 分钟 | 跨 reload 存活的那半条反骚扰规则；比持续门槛长，否则重载一次就能重新被问 |

四条同时满足才提醒：连续 ≥10 分钟在 elevated 之上、期间**从未回到 normal**、本 renderer 未提醒过、距上次提醒 ≥30 分钟。

**「releaser 没把它降下来」不是独立输入，就是「期间没有出现过 `at-normal`」**——`evaluatePressure` 的迟滞（0.85）已经定义了「降下来」的门槛。曾经想用「相对峰值回落 ≥5% 即视为释放有效」，被否掉：一次普通 GC 就能超过 5%，那台判据会把最该提醒的锯齿堆（涨→GC→涨）**永久静音**。同理，回升/抖动一律不算，只有 level 真的回到 normal 才重置计时。

**两个动作**：主操作是命令 `workbench.action.reloadWindowForMemoryDiagnosis`（重载窗口并开始诊断），次操作是「暂不」。**不做**「先拍一张当前快照」：堆已经超过基线上限，main 策略只会回 `baseline-too-large`；要让它成立就得在拍摄上限/配额上开洞，与「释放阈值和拍摄阈值都不为提醒让路」直接冲突。

- **为什么主操作是重载而不是就地开始**：基线只有在**小堆**上拍才有意义（`baselineMaxBytes = min(512MiB, cap/2)`）。内存高到值得提醒时早就超过它，就地开始只会被拒绝。重载把堆换回干净值，「基线 → 增长」才跑得起来。代价照实写进提醒正文（仓库的 reload **没有**未保存缓冲区的保护——与 `workbench.action.reloadWindow` 同级，唯一的 shutdown veto 参与者是 ACP 会话）。
- **重载意图走 `sessionStorage`**（`renderer/services/diagnostics/diagnosisReloadSession.ts`，一次性 + 90s TTL）：它属于「这次重载之后的那个 renderer」，且只属于它。放进持久化存储会让某次冷启动读到它并自己开一轮。命令里**先过 shutdown 否决闸门再写意图**——被否决的重载不能留下悬着的意图。
- **通知用 `notify({sticky, actions})` 而不是 `prompt()`**：`prompt()` 的 promise 在用户只是关掉通知中心面板（`markAllAsRead`/`toggleCenter`）时**永不 resolve**，in-flight 守卫会就此卡死；它也不返回 handle，无法在跳转重载前撤掉提醒。
- **提醒正文就是同意书**：这条路径不弹确认框（提醒本身就是那次同意），所以 toast 必须自己说完确认框说的四件事（只诊断本窗口 / 采集时会暂停数秒至数十秒 / 快照可能含文件内容与会话正文 / 只写本机不上传）。暂停秒数按**当前** used 估算（`estimateSnapshotPauseSeconds`：1000ms 固定 + 19ms/MB，取实测区间上界），并写成「最多约 N 秒」——真实采集跑在重载后更小的堆上，这个数是上界。
- **轮次已在跑时不提醒**：用户可能刚手动开了一轮，主操作会把那轮打成 `window-reloaded`，还会白烧一次全应用额度。改为推迟 5 分钟，且**不消耗**本窗口的提醒配额（`markReminded` 只在通知真的发出后才提交）。
- 提醒本身（`contributions/MemoryReminderContribution.ts`）与重载后的武装在同一个 contribution：前者订阅 `onDidSample`，后者在构造时消费 sessionStorage 里的意图并调 `startHeapSnapshotRound()`（**不再弹确认框**，轮次开局由既有的 `started` 事件播报）。
- **意图只在「重载真的发生了」之后才算数**：否决闸门有**两道**——命令里的 `confirmBeforeShutdown` 只跑否决相位，而 `IHostService.restart()` 内部还会对 reload 跑一次完整 shutdown（`lifecycle.shutdown()`，含同一个否决相位：ACP 会话在跑时会**弹第二次**同一个对话框）。写意图卡在两道门之间，所以 `restart()` 现在回 `Promise<boolean>`，命令在 `false` 时调 `clearReloadArmIntent`。**不能写成 `try/finally`**：重载时 IPC 回包先于页面销毁送达，`finally` 会在新 renderer 读之前把意图删掉，功能直接失效。**也不能用定时器兜**：设成 TTL 只在危害窗口已关闭后才响（等于没修），设短了又会在对话框需要用户思考时抢在真实重载之前删掉意图。意图自带的 90 秒 TTL 挡不住这一点——危害恰恰发生在被否之后那 90 秒内：窗口没重载，而意图还活着，之后**任意一次**重载（用户按 `Ctrl+Alt+R`、扩展触发、崩溃恢复）都会替用户开始一轮他从没要过的诊断。
- **重载后没能武装要照实记**：额度用尽 / 没有活 renderer 时 `startHeapSnapshotRound()` 回的是 `{ active: false, phase: 'stopped', code: 'app-quota-exhausted' }`——只判 `phase === 'off'` 会把这情形记成 `armed`，与事实相反（而 `maxAttemptsPerApp = 4` 是全应用级、reload 不重置，跑完两轮后第三次提醒照样会发，点下去白重载一次）。判 `status.active`，非 active 打 `warn` 带 `code`/`detail`；**不另发通知**，拒绝已由轮次自己的 `stopped` 事件播报（见上文）。同理 `consumeReloadArmIntent` 的返回值要把「压根没有意图」和「意图过期了」分开——后者意味着用户点了主操作、窗口也重载了，但诊断没起来，这是唯一从外面看不见的结局。
- **提醒正文有硬上限**：toast 的 message 渲染进一个带 `max-height: 7.2em`（约 5 行）的 `<p>`，且**没有 `white-space` 规则**——`\n\n` 会塌成一个空格，同时把「最多暂停约 N 秒」这句挤出可视区。所以这条文案是**一整段**（`\n\n` 是 dialog `detail` 的用法，通知正文里不要用），两笔代价（重载丢未保存的更改 / 最多暂停约 N 秒）都放在前半段。守护这条的断言同时钉住「不含 `\n`」与「两笔代价都在」。
- **闩锁要带截止时间**：`_remind` 之前的守卫是「到点之前不许再来一次」的**时间戳**而不是布尔——`getHeapSnapshotStatus()` 若永不 settle，布尔的 `finally` 永不执行，这个窗口余生的提醒就永久静默且不留一行日志。
- 顺带修掉一个既有缺陷：`NotificationService._load()` 复原持久化通知时改为**白名单**重建（丢掉 `actions`）。`JSON.stringify` 保留 label 丢掉 handler，复原出来的按钮点下去抛 TypeError——这个功能让它每次都发生（提醒必然导致重载）。

## 闭包链持有：识别、修复与回收验证（2026-09-18）

一次真实的 renderer 增长：在同一窗口相隔 14 分钟的两份堆快照里，`used` 从 111.7 MiB 到 607.3 MiB，而增长的是**同一批形状的节点成倍复制**——OutlineView 的 snapshot/display 各 4 → 3,570 份、`DocumentSymbol` 189 → 1,517,921、`Range` 376 → 3,035,840。它既不是 detached DOM，也不是漏 dispose，判据是两条：

- **看重复出现的函数名，而不是对象图的宽度**：一条 GC root 最短路径含 14,181 条边，其中 `sizeAt` 出现 3,541 次、`makeClickHandler` 3,540 次。同一个函数名在同一路径上等距重复数千次，就是「闭包链」的指纹——每个渲染帧的闭包让上一帧可达。本次主链根植于仍挂载的 Outline DOM，历史对象经回调作用域保留；不能只凭对象类型断定漏 dispose 或 detached DOM。后者只是脱离文档树，若仍被 JS 强引用，也会存在 GC root 路径。
- **离线剪边实验只用于定位，不是节省量**：仅忽略 Tree Context 上这两类槽位（保留其他非 weak 边），有 11,658,306 个节点 / 337.2 MiB 变为不可达，含 3,565 份历史 snapshot/display 与 1,516,812 个 symbol，约占快照 self_size 增量的 85.2%。它说明「证据指向这里」，**不**说明「修完省这么多」，也不是完整的 dominator/ephemeron 分析。

**机制**：`sizeAt`（`useCallback([structureVersion])`）与 `makeClickHandler`（`useCallback([model, onActivate])`）的依赖不同源，在同一棵树上交替换身份；二者的闭包共享同一个 **V8 闭包 Context**（渲染函数的作用域链）。方向是**从当前回指历史**：活着这一帧的闭包链上挂着更早的帧，连同它们捕获的对象一起被钉住——不是「前代指向后代」。视图每更新一版（OutlineView 每次渲染带新的内联 `onActivate` / `renderRow`），整代 `display` 及其符号表就被钉住一代。

**修复**（`packages/workbench-ui/src/hooks/useStableCallback.ts` + `tree/Tree.tsx`）：只把这两个工厂换成 identity 恒定的包装——包装在 hook 自己的作用域里创建、只捕获 ref，调用时读最新 body。**不改** React callback ref（`rootRef` 换身份带解绑/重绑语义，不能为稳定身份悄悄破坏），也**不**把所有 `useCallback` 一律重写：普通 `useCallback` 不是泄漏，本例的特征是**依赖交替 + 共享 Context 的链式持有**。`sizeAt` 恒定后，reveal 的 layout effect 必须显式依赖 `structureVersion`，否则「展开后才可见」的目标不再触发重算。

**回收验证（identity 只能当哨兵，回收必须问真实收集器）**：单测与 e2e 两条都问真实 GC，而不是比对回调身份——任何「身份稳定但仍保留全部历史对象」的实现都能通过身份断言。

- 单测（`packages/workbench-ui/src/__tests__/Tree.callbackRetention.test.tsx`）：保留组件挂载，每代造一个只被该代闭包捕获的 payload，用真实 V8 GC（`node:v8` + 隔离的 vm 上下文）问「上一代的 payload 是否已不可达」。实测修复后 2、修复前 41。**GC 能力缺失必须 fail loud，不能 skip**——「没回收」与「从没问过」必须可区分（收集后断言收集器确实跑过）。
- e2e（`@regression` `apps/editor/e2e/specs/smoke.outlineRetention.spec.ts`）：真窗口里驱动两段各 15 代真实 outline 更新（每代等该代符号在服务侧出现、对应行在 DOM 里落地），每段之后经 CDP `HeapProfiler.collectGarbage` 跨任务回收，再由探针读 WeakRef 存活数。探针 E2E-only、显式 start/stop、每次 start 开一轮新统计、**只存 WeakRef**、有代际上限，不在生产启用。**每次强制回收都要 arm 一个只剩 WeakRef 的控制对象并验证它已被回收**：控制对象仍存活只说明这一轮「未能证明不可达对象确实可回收」，此时同批存活数不可解释——**直接报错而不是当成泄漏**，也不要据此推断「GC 没跑」。实测 16 代 → live 3、31 代 → live 3。比较的是**两段更新的 live 是否随代数增长**，上界取一个保守常数（本例始终是同一个 URI，符号缓存只会覆盖同一个键，不会有 8 代同时驻留；常数余量涵盖缓存 / 挂载帧 / React 双树），**不断言恰好 ≤2、也不要求两段相等**。

**指标口径（下结论前先分清）**：采集前 `performance.memory.usedJSHeapSize`（111.7 / 607.3 MiB）与快照内全节点 `self_size` 之和（149.5 / 545.5 MiB）是两种口径——前者是采集那一刻 V8 报告的 JS 堆，后者只统计快照序列化出的节点且**含 native 尺寸**；两者相减再归因会得到无意义的差值。同类未确证项：同一个 native ArrayBuffer（Oniguruma WASM 线性内存，路径 `onigLibPromise → OnigScanner → HEAPU32.buffer`）16 MiB → 69.19 MiB——只有两点读数，**不能证明持续泄漏**，不要把它写成「WASM 泄漏」；扣除闭包链与该 buffer 后的净增同样无法用这两个口径互相印证。

## 诊断包里的相关文件

- `ipc-frames.txt`：main 侧帧环形记录 + 统计 + 最大帧标签。每行/标签形如 `out response fileService.readFile #42`；`#id` 是把它与 renderer 侧告警对上、再与那次请求对上三者的唯一把手。
- `memory.txt`：main 堆（`formatMainHeapSample`）+ **系统提交内存行**（`formatSystemMemoryLine`：Windows 的 `CommittedBytes` / `CommitLimit` / 余量 / `AvailableBytes`，与周期性 metrics 日志共用同一份缓存读数，不会为导出再起一次查询）+ 托管进程树内存（`hosted-processes cnt=… name#pid=…MB/…%`）+ **renderer 堆曲线尾部 32 条**（`renderer-heap samples=32 (newest first)`，最新在前）。曲线进 zip 而不是只留在日志里，是因为日志尾部有 512KiB 截断，会恰好丢掉慢速爬升最早的那几条。
- `heap-snapshots.txt`：快照目录的**清单**（时间 / 大小 / 类型 / `incomplete` 标记 + 目录预算）。**只有清单，永不打包 `.heapsnapshot` 原件**。
- `sysinfo.md` / 日志尾部：renderer 侧的 `[memory] …` 行（水位变化时打印 `describe()` + 最近 12 帧）。
- 详见 [error-diagnostics.md](error-diagnostics.md)。

## 已知取舍与后续项

- **`reviver` 的 base64 解码峰值（约 3.5×）未重构**。延后解码会破坏 `instanceof Uint8Array` 契约，改动面是全仓每个 IPC 消费点，与止血目标不成比例。当前做法是"已知峰值模型 + 硬上限兜底"。
- **`VIEW_MODEL_OVERHEAD_FACTOR = 3` 系数不改**。它是记账单位，改成动态值会让同一卡片在 measure 与 release 拿到不同系数，账永远配不平。实测改由水位服务提供，职责分离。
- **硬上限可能误伤合法大帧**（用户把 `acp.prompt.image.maxSizeMB` 调到 50 → 约 340MB 帧）。这是刻意取舍：该帧 decode 峰值约 1.2GB，本就会 OOM。回滚 = 改一个常量。
- **同一份用户 prompt 可能被记两次**：本地 append 走 `_appendMessage` 的显式记账，agent 若把该消息回显成 `user_message_chunk`，`applyUpdate` 会再按 `estimateUpdateCost` 记一次。方向是保守的（提前 trim，不会漏记），且 `_releaseResidentDownTo` 在 `freed === 0` 时用 `_measureResidentBytes()` 重算兜底，账不会永久漂高。真要收口需要按 messageId 去重记账，改动面大于收益。
- **流式渲染的解析器加固延后**：无安全切点的消息（典型是一整段不闭合的代码围栏）密封失效，仍按 (渲染次数 × 长度) 重解析。不做是因为切出不等价 AST 会导致显示错误，而它是否真的发生可以由 `mdreseal` / `mdparse` 计数器在真机上回答。见第五类缺口。
- **子代理的 `_childrenOf` 是 O(timeline) 扫描**，而 `_setChildren` 每次重建是 O(#children)，数百条子消息时呈 O(n²)。先量数据再决定要不要索引——`childchunks.calls` 与真机上 Task 卡的展开比例就是那个数据。同一处待确认项：真机上 Task 卡**是否展开**，决定这条路径是不是主力。
- **`holders` 只覆盖已知持有者**：`acp` / `monaco` / `codehtml` / `changes` / `output` 之外的堆（diff 缓存、webview、第三方库的字符串）不计。这不是缺陷而是判据的一半——"已知持有者之和 vs `used`"的差值本身就是结论。`changes` 与 `output` 是后补的两项：前者有前科（见第四类缺口）却没有读数，后者是崩溃栈落在 `OutputModelService._applyFlush ← ModelRawLineChanged` 的那份报告点名要的。`output` 走 `IOutputChannel.retainedChars`（通道自己维护的长度，不 join 缓冲）而不是 `getText()`——采样本身发生在受压窗口，那里最不该做的就是拼一个 4MB 的字符串。上一条提到的高估方向同样作用于这个差值。
- **32 槽 ring 不按窗口分割**：多窗口下每个窗口各自上报，共用同一只 ring（≈每窗口 16 条）。判定依据是"崩溃的那个窗口在最后一刻的曲线"，共用 ring 在最坏情况下仍保留它最近的若干条。真要多窗口精读再按窗口分桶。
- **renderer 侧自己的帧 ring 不进诊断包**：renderer OOM 时来不及落盘，只有 main 侧那份能活到导出。**出站热路径只加一次比较**是硬约束：任何"顺便做点别的"的改动都要先证明它不分配。
- **被降级的改动行会粘住**：`sessionChangeTracker` 的 `(size, mtime)` 行缓存缓存的是 **cap 之后**的行（必须如此，否则被降级的行会把两份全文永久留在缓存里），所以一行一旦因超预算被降级，只要文件 size/mtime 不变就一直显示 degraded，即使预算压力已经消失。换来的读短路值得这个代价，逃生口也是现成的：文件一动、或 `record()` 再触发一次失效即恢复。
- **预判降级会多降级一些 CJK 文本**：读之前的预判用 `2 × (baseline 字符数 + size 字节数) > maxLiveChangeBytes`，`chars ≤ bytes` 使它是保守估计（宁可多降级也不多读）。一个 9MiB 的 CJK 文本本该产出约 12MB 的行（预算内），会被直接降级。该门闸的存在意义是：这样的行**必然**会被 `_capLiveChanges` 的 heaviest-first 循环降级，读它是纯浪费。**对 `watched` 无 baseline 的行它按两份文本估算，而该行实际只按引用持有一份**（`baselineSource:'none'` 的 baseline 就是 `current`），即这类超过 8MiB 的文件会被降级、而预算本来容得下 16MiB —— 这是**刻意保留**的保守：事故里那个约 16MiB 的二进制正是这个形状，把门闸放宽到 2× 就等于把那次的读取放回来。
- **CDP 自动堆快照（原计划的 2.6）经 spike 判定不做**（按需能力另见上文「按需受控堆快照」一节）。计数器只能缩小到"某一类"，回答不了"这 3.8GB 是谁持有的"，所以曾规划让 main 在收到 `level=critical` 样本时用 `webContents.debugger` 触发 `HeapProfiler.takeHeapSnapshot` 落盘。2026-09-15 在 Electron 43.3.0 上实测（`wc.debugger.attach('1.3')` → `HeapProfiler.enable` → `takeHeapSnapshot({reportProgress:true})`，chunk 经 `addHeapSnapshotChunk` 直接流式写文件）：**能连、能拍、renderer 活着、main 侧 RSS 平稳**，但代价使 `critical` 触发点站不住：

  | 活跃堆 | 快照 | 比值 | 耗时 | renderer 主线程卡顿 |
  |---|---|---|---|---|
  | 272 MB | 166 MB | 0.61 | 3.7 s | 3.7 s |
  | 1201 MB | 663 MB | 0.55 | 17.9 s | 18.0 s |
  | 2235 MB | 1542 MB | 0.69 | 42.0 s | 42.0 s |

  **卡顿 == 全程**（三次 `maxStallMs` 与总耗时逐次相等），即快照期间 renderer 主线程完全停摆；耗时约 **15–19 ms / MB 活跃堆**，外推现场的 3.8GB ≈ **70 秒全窗口冻结**，而 renderer RSS 同期涨到约 1.6× 活跃堆。`critical`（≥85% limit）既是最没余量、又正是用户正在交互的时刻，在那里加一分钟冻死会把"可诊断的慢"变成"看起来已经死了"。**要留这条能力就只能是手动/按需**（用户或支持人员在复现时显式触发、窗口已空闲），不能挂自动阈值；且必须先解决卡顿的可接受性，而不是先做触发条件。→ 这条结论就是上文「按需受控堆快照」的由来：**上表是那套阈值的依据**（60s 稳定带、512MiB 基线上限、`min(1GiB, 30%×limit)` 拍摄上限、两次间隔 ≥5 分钟、每窗口每轮 ≤2 次都从「冻结的是用户的时间」推出来），而采集改用 `webContents.takeHeapSnapshot`——同一条 V8 对象图序列化路径，同样冻结主线程数秒至数十秒（**不承诺固定耗时**），但不建 CDP 连接、不解析快照进内存。

  > 附带教训，省下一次重复踩坑：`'x'.repeat(n)` / `padEnd` 产出的是 rope/sliced 表示，**不是真实字节**——spike 里 400MB 这样的"字符串"只花了约 3MB RSS，`performance.memory` 与 CDP `Runtime.getHeapUsage` 双双不涨，据此测出的快照成本会小三个数量级。造真实堆要用 `JSON.parse(JSON.stringify(...))`（也正是那次崩溃栈 `JSON.parse ← decode` 的形状）。


## 验证

- 单测：`packages/platform/src/__tests__/ipc/ipcFrameGuard.test.ts`、`ipcFrameGate.test.ts`、`log/logFloodFold.test.ts`；`apps/editor/src/renderer/services/memory/__tests__/`（阈值/迟滞/缓存归还字节、上报节流与"首个读数必上报"、holder 采集容错、`heapFlowCounters.test.ts` 的 drain 清零与非法值、累计读法不被 drain 影响、`flow=`/`gauge=` 为空时字段整体省略、取数抛错不影响堆读数、视图 gauge 的跨视图求和、重渲染后按新句柄接续且句柄数不累加）、`rendererHeapReporter.test.ts`、`main/services/diagnostics/__tests__/`（`renderer-heap` 行格式、非法样本被丢、越界的 `flow`/`gauge` 条目被丢、ring 满 32 淘汰最旧、窗口号盖章）、`AcpSession.liveBudget.test.ts`（trim 后 `_residentBytes === _measureResidentBytes()`、trim 掉的子代理消息同时丢 `live`）、`AcpSession.timeline.test.ts` 的 `sub-agent streaming runs` 组（`live` 置位、批次按尾部长度定时、回合/重放/角色切换/追加子 tool call/父卡 settle 各自清除、就地更新与 `in_progress` 的父卡 update **不**清除、父卡 settle 后迟到的 chunk 把消息放回流式路径、连接丢失清除、顶层 `streaming` 不受影响）、`services/acp/__tests__/markdownIncremental.test.ts`（等价性、sealed 前缀的元素身份、`mdparse.chars` 记的是被重新解析的字符数）、`workbench/agents/__tests__/CodeBlock.test.tsx` + `workbench/markdown/__tests__/markdownStreamingGating.test.tsx`（流式期间不着色、seal 后着色一次、回收实例翻回流式时旧 html 被清空、sealed 段在 tail 增长时不被重渲染）、`workbench/agents/__tests__/ToolCallCard.test.tsx`（`live` 的子代理消息走增量解析且跳过尾部围栏着色，静态消息反之）。
- e2e：`smoke.agentStreamMemory.spec.ts` 的 `acp sub-agent streaming render accounting` 组（`emit-subagent` / `emit-subagent-mixed` 夹具）。断言的是**算法形状**（`mdparse` 与 `mdreseal` 的比值、`childchunks.calls` 相对 chunk 数的量级、流式期 `colorize.chars === 0`），**不**断言墙钟或 MB——那些是机器的属性。`emit-subagent-mixed` 那条专守**追加子 tool call 的 seal**：它在回合仍在跑时取样（两侧消息在回合结束都会被 `_flushStream` 清掉，之后再读，"清过"与"从没清"长得一模一样），断言被打断的首条消息 `live === false`、其后新建的那条 `live === true`、且两条的文本长度之和等于整条流——这个 seal 一旦漏掉，表现是"围栏再也不着色"，只能在这条路径上被真窗口看见。
- e2e：`@p1` `apps/editor/e2e/specs/smoke.agentStreamMemory.spec.ts`——把一条 300KB 的思考消息喂给真窗口（夹具 `emit-thought:<count>x<kb>[,fence]`，回合在末块后留 500ms 观察窗），断言**可密封消息的 `mdparse.chars` 不超过 (长度 + 每次调用有界的尾部)**、sealed 缓存确实在增长、`colorize.chars === 0`；再断言**从不闭合的围栏在流式期间 `colorize.chars === 0`、seal 之后被着色**，两条都比对全文逐字符相等。刻意不断言 WS/RSS/墙钟：那是机器属性，而这里要守的是算法形状。
- e2e：`@p0` `apps/editor/e2e/specs/smoke.memoryPressure.spec.ts`——**直接验证"`performance.memory` 在真实 Electron renderer 里可读"这个核心假设**、releaser 已注册、强制释放有归因，以及**堆曲线真的抵达 main 的 `processMetrics.log`**。最后一条是必需的：上报是 fire-and-forget，方法名写错或通道没注册会被完全静默吞掉，产出的报告与"这个构建本来就没有曲线"无法区分。
- 单测（受控快照）：`main/services/diagnostics/__tests__/heapSnapshotPolicy.test.ts`（未武装不决策、60s 稳定带与「波动则重置带」、基线过大/堆上限未知/过期样本、参照点取基线后的谷底、增长阈值按余量收窄、holder 解释、5 分钟间隔、轮次超时与两种配额耗尽、重开一轮丢弃上一轮样本）、`heapSnapshotController.test.ts`（partial→rename、增长轮、失败也扣名额、采集中停止按「仍在跑」上报且保留产物、等待资源期间被停止/身份被替换则不起抓取、迟到 promise 不污染新一轮、应用级配额不因重开重置、目录预算在写之前拦、只删本次的 partial、单航班锁在 stalled 期间不释放、无活 renderer 只报不武装、incarnation 不同即丢弃、清单有界且不含内容）、`systemMemorySampler.test.ts`（真机 `Win32_PerfFormattedData_PerfOS_Memory` 语义：`AvailableBytes` 是可用物理内存、提交余量 = `CommitLimit − CommittedBytes`，单位/字符串化 64 位计数器/非法字段/负数余量、固定命令无 shell 不改执行策略、单 flight、退避到 10 分钟、dispose 杀在途子进程并丢弃迟到读数、非 Windows 标 `unsupported` 但仍报物理内存、共享单例只启动一次）、`diagnosticsMainService.test.ts`（sanitize、`counts=`/`unexplained=`、zip 只含清单、窗口盖章）、`renderer/services/memory/__tests__/rendererIncarnation.test.ts`、`renderer/services/diagnostics/__tests__/heapSnapshotMessages.test.ts`（每个 code 都有句子、severity 分档、detail 只挂在值得引用的结局上）、`renderer/contributions/__tests__/HeapSnapshotNotificationContribution.test.ts`（revision 单调丢弃旧报告、只有 outcome 粘住、揭示动作只在有用时给）、`renderer/actions/__tests__/helpActions.test.ts`（确认框文案含暂停/隐私/本机/不可取消四件事、取消则不武装、Help 菜单落点与「刻意不带 icon」）。
- e2e：`@p1` `apps/editor/e2e/specs/smoke.heapSnapshot.spec.ts`——**独立 userData 冷启**，走**真实命令 + 真实确认对话框**（`Start Diagnosis` 按钮），等满 60s+ 让 main 真的采一份 baseline（实测量级：武装到落盘约 2 分钟——开机后堆还在动，第一次判定通常是 `baseline-unstable`，等下一组样本重来；等待上限 420s，够走完退避后恢复的资源读数），然后断言：`.heapsnapshot` 已从 partial 改名落地且是一份完整的 V8 快照（头部 `{"snapshot":` + `meta`、尾部闭合、体积 > 0）、sidecar 记的是 `trigger: baseline`、窗口在冻结后仍能应答探针、`workbench.action.stopHeapSnapshotDiagnostics` 之后不再产出、reload 结束本轮、诊断 zip 里只有 `heap-snapshots.txt` 清单而**不含任何 `.heapsnapshot` / `.partial` 正文**。它**不**造 GB 级堆、不碰用户的正式 userData。资源不够时分两种结局，绝不互相冒充：**只有明确点名「资源不足」的闸门**（`physical-memory-low` / `commit-headroom-low` / `disk-space-low`）→ 用例**跳过并打印该闸门与读数**（skip ≠ 通过，这台机器上就是没验证过）；`commit-unknown` / `disk-unknown`（读数取不到）**不在跳过之列**——一次恒失败的 WMI 查询或永远 ENOENT 的 `statfs` 是本构建的缺陷，把缺陷一起跳过等于用绿色盖住代码错误；任何其他原因（决策行里没有闸门、超时、策略 bug）→ **失败并报出该决策行 + `active`/`phase` 与两处配额计数**。判据取自 main 自己写下的 `<userData>/logs/<session>/heapSnapshot.log` 决策行，而不是窗口的 `getHeapSnapshotStatus`：后者的 `code` 只在**轮次结束**（`_stop`）时才有值，被闸门拦住的轮次全程 `active: true` 且无 code，只看它会把「被拦」误读成「卡住」，跳过分支永远不会触发。断言产物时必须**等快照与其 sidecar 一起就位**再读：rename 先落地、`.json` 随后才写，只等 `.heapsnapshot` 会出现「读到没有元数据的半成品目录」。策略边界本身由上面的纯函数单测守，不由这条 e2e 守。
- 单测（闭包链回收）：`packages/workbench-ui/src/__tests__/Tree.callbackRetention.test.tsx`（挂载保持、每代独立 payload、真实 V8 GC 判「上一代是否可达」，修复后 2 / 修复前 41；GC 不可用 fail loud 而非 skip）、`Tree.stableCallbacks.test.tsx`（恒定身份仍读最新 `model` / `onActivate` / `getRowHeight`——冻结首帧的稳定回调不会以任何 identity 变化暴露自己）、`Tree.revealScroll.test.tsx`（结构变化后的待处理 reveal 继续生效，补 `structureVersion` 依赖）。
- e2e：`@regression` `apps/editor/e2e/specs/smoke.outlineRetention.spec.ts`——两段各 15 代真实 outline 更新，CDP `HeapProfiler.collectGarbage` 后读 WeakRef 存活数（实测 16 代→3、31 代→3）。断言的形状：**live 不随代数增长**且不超过保守常数上界。每次回收都以只剩 WeakRef 的控制对象验证「这一轮确实收得掉不可达对象」；未被回收即报错——那是这一轮读数不可解释（不代表 GC 没跑），不是应用缺陷。
