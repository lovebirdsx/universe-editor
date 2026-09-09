# cases-tsserver-investigation

> 本文从 `CLAUDE.md` 拆出，范围是：TypeScript 内置插件的 **tsserver 行为排查实录与纠偏**——大型 depot 工程「didOpen 超大 d.ts 后又转圈 60-90s」的四个叠加因素、Windows 正斜杠回退 bug、close 不卸载的实证纠偏（close-probe 探针）、以及由此确立的 keep-alive pin 与诊断方法论。改 `lspClient.ts` / `tsServerPaths.ts` 的 spawn、路径、重启、日志逻辑时先读本文。

## 排查实录（大型 depot 工程 2026-07）：「didOpen 超大 d.ts 后又转圈 60-90s」

症状：ready 后每次打开该超大 .d.ts，~3s 后状态栏出现 `project load begin`、60-90s 后 end。按序排查出的四个叠加因素，每个都独立成立：

1. **多 configured 项目各自加载**：工作区不止根 tsconfig（各子目录的 tsconfig 等也是独立 configured project）。打开哪个项目的文件就 load 哪个项目，每个都过 `ServerInitializingIndicator` → 状态栏 ready→starting 是**多项目加载的固有表象**。
2. **TLS 的 `ServerInitializingIndicator` 合并进度丢配对**：每次 `projectLoadingStart` 都先 `reset()` 掉上一个 reporter（只发 end 不发 begin），所以 begin/end 计数永远对不上——不是漏 end，是 TLS 设计上「多项目加载合并成一个进度」。
3. **Windows 正斜杠 tsserver.path 静默回退**（本轮修掉的真 bug）：我们 dev 注入的正斜杠路径让 TLS 回退到工作区 TS 4.5.5（不是 vendored 5.9.3）。4.5.5 在巨型项目首次 `updateGraph` 后会对所有 close-watchers 误报事件（`x:1` 满日志）→ `onConfigFileChanged` → 以 `Change in config file detected` 整项目重载（实测 103s 初载后 14s 又重载）。5.9.3 无此行为。修法即 `initializationOptions.tsserver.path` **Windows 必须 `normalize()` 成反斜杠**（TLS 用 `path.sep` 切分校验路径）。
4. **诊断方法论**：裸 `initializationOptions.tsserver.logFile` **被 TLS 忽略**（它自算 `<workspace>/.log/tsserver-log-*/`）；tsserver verbose 日志里 server 真实二进制看 `Arguments:` 行；standalone LSP 探针必须应答 server→client 的 `window/workDoneProgress/create`（否则 TLS 永远等不到 reporter，进度全哑）。

## 「关掉某 tsconfig 的所有文件后对应 LSP 像终止了」——实证纠偏（2026-07，close-probe 探针）

tsserver **5.9.3 不会**在 configured project 的最后一个 open 文件关闭后卸载它（didClose 后 120s 该项目符号仍可 navto，tsserver 文件日志无 `remove Project`）。此前观察到的「关闭即卸载、重开付 60-90s 全量 reload」其实是第 3 条的正斜杠回退 bug：工作区 TS 4.5.5 假报 config 变更触发整项目重载，表象酷似卸载。修复回退后该表象消失，与 VSCode 行为一致。

真正会丢项目的路径只剩**进程崩溃重启**（`_open` 重放只含仍 open 的文档）——由 keep-alive pin 兜底（见主文档 lspClient.ts 条目）。LSP 协议上观测不到项目归属与加载/卸载明细：didOpen/didClose 打 `project≈<tsconfig>` 归属日志（启发式，`≈` 表示推测），加载明细看 tsserver 文件日志（`UNIVERSE_TS_LOG_LEVEL=verbose`）。
