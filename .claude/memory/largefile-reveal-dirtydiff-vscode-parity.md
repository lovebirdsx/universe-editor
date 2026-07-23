---
name: largefile-reveal-dirtydiff-vscode-parity
description: 34万行大文件三连修：定位事件驱动；dirty-diff/blame 节流+豁免；文档同步全文→增量+tsserver 内存上限+didOpen 代际去重（曾 3×全文发送）
metadata: 
  node_type: memory
  type: project
  originSessionId: ae0fd3b3-d185-4df3-9aff-7647cb31b036
---

34 万行 `index.d.ts` 暴露的三轮问题及修法（2026-07）：

**① 符号跳转打开文件不定位**：根因不是 Monaco 跳不动大行号，而是 reveal 用「rAF + 50ms 定时轮询 FileEditorRegistry」等编辑器挂载，大文件 model 构建远超窗口后静默放弃。修法＝`revealEditorPosition.ts` 的 `waitForFileEditor` 改为事件驱动（`FileEditorRegistry.onDidChange` + `input.onWillDispose` + 30s 安全兜底），并删掉 WorkspaceSymbolQuickAccessProvider / historyActions 各自的私有轮询变体，统一走 `revealSelectionInInput`。对标 VSCode：reveal 是 model 就绪的后继动作（textFileEditor.setInput → applyTextEditorOptions），不是定时器赌出来的。

**② 大文件编辑/滚动卡顿**：dirty-diff 原来每键无防抖、renderer 主线程同步全文 diff、无大小豁免。修法对标 VSCode quickDiffModel 三件套：`ThrottledDelayer(200)`（新加到 platform base/async.ts，含 Throttler/Delayer）+ 任一侧超 `MODEL_SYNC_LIMIT` 50MB 整体跳过（VSCode canComputeDirtyDiff→isTooLargeForSyncing 同款，跳过时记一次 info 日志）+ 行级 diff（HEAD 缓存预 split，buffer 用 getLinesContent，见 [[linediff-myers-perf]]）。GitBlame 同期加 500ms delayer（内容变化清缓存后延迟重发 git；光标移动缓存命中仍即时）。

**③ 跳转后 tsserver 重启 + 残余卡顿（第二轮）**：根因＝文档同步是全文链路——DocumentSyncContribution 每次 didChange 发 `model.getValue()` 全文过三跳（renderer→ext-host→tsserver），大文件每键 20-30MB；且 tsserver 未设内存上限易 OOM。修法对标 VSCode：(a) 增量同步全链——Monaco deltas 按 rangeOffset 降序转 LSP contentChanges（同批次基于同一前置状态，降序=顺序应用安全，helper `documentSyncChanges.ts`），host 镜像换 `vscode-languageserver-textdocument` 原地增量更新（文档身份跨编辑稳定），lspClient 直发增量 + `sentVersion` 防 crash-replay 后双 apply；(b) `initializationOptions.maxTsServerMemory: 3072`（vendored cli 转 `--max-old-space-size`）；(c) semanticTokens 100K chars 门（VSCode CONTENT_LENGTH_LIMIT 同款）；(d) server-gone 取证日志（restart 窗口计数/openDocs 大小/stderr tail）。

**④ didOpen 全文 ×3（合成 200K 行 e2e 抓包才现形）**：临时 spec 断言「didOpen 恰一次」直接失败——三个来源叠加：didOpen 先注册 `_open` 再 await ready，冷启动 `_start` replay 先发一遍、didOpen 醒来又发一遍；prewarm `pinProject` 选中同一文件再发第三遍。修法＝lspClient 连接代际去重：`_generation` 每次成功 start 自增，`OpenDoc.sentGeneration` 命中即跳过发送；didOpen 幂等（复用 entry，pin 的静态闭包升级为 live 视图）；pin/真实打开互斥；版本前移时 full-replace didChange 兜底（覆盖 dirty-restore 超前 pin 快照）。单测桩 `_ready`/`_notify` 即可测全部去重分支。

**⑤ 工程坑（诊断阻塞点）**：apps/editor devDependencies 漏 `@universe-editor/extension-host` → turbo e2e 图不重建它 → e2e 跑 stale bundle（新协议的 deltas 数组被旧代码当全文字符串，markdown `TextDocument.create` 内 `charCodeAt` 炸）。跨 IPC 的错误 stack 是 synthetic（`reviveWireError` 只保 name/message/code），renderer 帧不可信；怀疑 stale 时 grep dist 里该有的新日志串最快。

**⑥ 真机日志第三轮（用户 15.3MB 实测回灌）**：崩溃真因＝tsserver 语义 project 加载（用户 alt+shift+o 触发）**exit 134 = V8 OOM abort**，3072MB 默认上限装不下该工程（8192 可过，navto 返回 97 items）——用最小 LSP stdio 复现脚本（spawn vendored cli + initialize + 15MB didOpen + workspace/symbol）直接在 g:/aki_3.6 复现拿到完整 stderr。修法＝`typescript.tsserver.maxTsServerMemory` 配置化（默认 3072 对齐 VSCode，lspClient 每次 (re)start 经闭包重读→崩溃自动重启即生效）+ OOM 签名检测（stderrTail 匹配 `exit code: 134|out of memory`）一次性 `window.showWarningMessage` 指向该设置。**复现脚本大坑**：cli.mjs 版本探测用 `path.sep` 切分 `tsserver.path`——**正斜杠路径在 Windows 判 invalid，静默回退工作区旧 TypeScript**（4.5.5），务必传反斜杠。`--max-old-space-size` 走 fork execArgv，不出现在 tsserver.log 的 Arguments 行，不能凭该行断定没生效——用不同上限对照实验。

**⑦ 15MB didOpen IPC 4.4 秒**：renderer↔ext-host 走 newline-framed JSON（StdioFramingProtocol），`_ingest` 的 `buffer += chunk` + 从零 `indexOf('\n')` 在大帧按 64KB 分片到达时 O(n²)（微基准：15MB 单端 820ms→chunked 累积器 6ms，137×）。修法＝`_parts: string[]` 收集分片、见换行才 join。真机实测 didOpen send 4422ms→718ms。

**⑧ waitForFileEditor 泄漏门禁回归**：peek Enter 打开从未挂载的编辑器时，等待 store 挂满 30s 兜底，e2e teardown 泄漏检测先扫到即红（本轮 stdio 提速改变时序才暴露）。修法＝`waitForFileEditor(input, disposables?)` 把内部 store 挂宿主（EditorOpenerContribution 传 `this._store`）+ store 内哨兵 `toDisposable(() => settle(undefined))` + settled 幂等 + settle 时 `deleteAndLeak` 摘除防累积。

**⑨ tab 切回大文件卡 >1s（第四轮）**：CDP CPU profile 定位（临时 spec 真机工作区 + `Profiler.start/stop` + 按 node 父链打印栈，比猜快得多）。两个元凶都挂在 activeEditor 变化上：(a) **`MainThreadEditor._activeSnapshot` 的 DTO 带 `text: model.getValue()`**——每次切 tab 把 15MB 全文重过 RPC（stringify+TextEncoder+Buffer+IPC 结构化克隆 ≈ 500ms+）；修法对标 VSCode：`IActiveTextEditorDto` 删 text，host 从 ExtHostDocuments 镜像取文档（`get`/`whenOpen(uri,timeout)`，didOpen 未到则挂起 + generation 防超越），**连锁坑**＝镜像有 200ms didChange 防抖，markdown toggle-bold 紧跟击键读到旧文本产生 `****hello****`（e2e 抓到）→ `$getActiveTextEditor` 返回前先 `PendingDocumentSync.flush`（同 languageProviderProxy 模式）。(b) **GitMergeConflictContribution 每次切 tab 重建 InlineConflictController**，构造即 `parseConflicts(model.getValue())` 且跑两遍（constructor + ensureInitialized 冗余）；修法＝`findNextMatch('<<<<<<<')` piece-tree 预筛（不构造全文串）+ WeakMap<model,{versionId,conflicts}> 缓存 + 内容变化 200ms ThrottledDelayer + 消除冗余 render。真机实测 723ms→93ms、longtask 571ms→0。

**⑩ 切 tab 卡顿看门狗（第五轮，⑨ 修复后用户仍报间歇卡顿）**：`TabSwitchPerfContribution`（AfterRestore）每次 activeEditor 变化开 1500ms 观察窗——双 rAF 量首帧冻结 + `longtask` PerformanceObserver 汇总主线程阻塞，超 200ms 往窗口日志 `tabSwitchPerf.log` 写 warn（低于阈值走 debug，默认日志级别不落盘）；嫌疑点用 `recordTabSwitchPhase(name, fn)`（`services/performance/tabSwitchPerf.ts`）上报命名相位，已埋：fileEditor.setModel/applyOptions/updateDirty/restoreViewState/registerAndFocus、extHost.activeEditorEmit、mergeConflict.scan、dirtyDiff.compute——warn 行自带 long task 列表 + 相位归因（各带 @+偏移）。快速连切时上一观察窗**截断收尾而非丢弃**（否则「切走再切回」恰好丢掉大文件那次的报告）。真机验证：首开 index.d.ts 即抓到 warn（blocked 294ms，长任务 187+107ms，相位合计 ~95ms→其余是模型构建/didOpen 编码），后续 6 轮切换全部低于阈值；用户的间歇 >1s 未复现，等真实环境日志回灌定位。

**Why:** 定时轮询等异步挂载在大文件上必然超窗；主线程全文字符串 diff 无豁免在大文件上必然卡顿；全文文档同步在大文件上每键都是灾难——三者 VSCode 都有现成答案。多余的全文 didOpen 只有靠日志断言（恰好 N 次）才暴露，功能测试全绿也抓不到。字符串流式切帧必须带分片累积器，`+=`+全量扫描在多 MB 帧上是 O(n²)。**任何挂在 activeEditor 变化上的反应都不得携带/构造全文（DTO 带 text、getValue 后正则扫全文都算）**——每次切 tab 都会重付一次。

**How to apply:** 任何"打开后定位/聚焦"需求一律走 `revealSelectionInInput`/`waitForFileEditor`（有宿主 store 就传，避免 30s 兜底期挂泄漏门禁），不要再写 rAF+setTimeout 轮询（历史上已经抄散过 3 份）。命令层 await reveal 会阻塞 executeCommand（e2e runCommand 会等），保持 fire-and-forget。dirty-diff 两个行切分入口语义须一致（trailing newline 幻影行 pop 掉），否则文件尾会出幻影 added 区。性能类修复的验证用「日志计数断言」临时 spec（Extension Host output channel 可经 `getOutputChannelContent` 探针读到 host stderr；renderer logger 通道不在 Output，读 e2e userData `logs/<ts>/window-1/<id>.log`）；新增 workspace 包被 e2e 依赖时检查 apps/editor devDependencies 是否有边。诊断 LSP/tsserver 问题用最小 stdio 复现脚本最快（可控参数对照 + 全量 stderr + tsserver logVerbosity）。用户再报「切 tab 卡」先要 `tabSwitchPerf.log` 的 warn 行（long task + 相位归因都在里面）；新嫌疑代码包一层 `recordTabSwitchPhase` 即自动进报告。
