# Session Changes 完备化方案：从「hunk 逆推」到「写前快照 baseline」

> 状态：方案设计（未实施）。
> 背景调研：VSCode Copilot chatEditing（`D:/git_project/vscode/src/vs/workbench/contrib/chat/browser/chatEditing/`）与 codex `TurnDiffTracker`（`D:/git_project/codex/codex-rs/core/src/turn_diff_tracker.rs`）。

## 1. 现状问题诊断

当前机制（`sessionChangeTracker.ts` + `sessionDiffReconstruct.ts`）：agent 上报每次 Edit/Write 的
`structuredPatch` hunk 批次 → 按 (sessionId, path) 累积 → 展示时读盘上当前内容，**逆向 un-apply
全部 hunk 重建会话前 baseline**。

### 误报根因

| # | 根因 | 代码坐标 |
|---|---|---|
| E1 | hunk 逆推定位失败 → `degraded`（baseline 部分错误仍展示） | `sessionDiffReconstruct.ts:147-161` |
| E2 | 定位 fallback 是全文文本搜索（`indexOfBlock`），重复文本会**静默错位**，产出错误 baseline 而不自知 | `sessionDiffReconstruct.ts:92-114` |
| E3 | 用户手动编辑污染窗口 = **整个会话生命周期**：用户改过之后 hunk 对不上（→E1/E2），或被并入"agent 改动" | 机制固有 |
| E4 | codex 路径把 oldText/newText 全文对压成**单个整文件巨型 hunk**：曾积累 ~150MB 触发 main 进程 OOM，预算兜底会**整会话丢弃追踪**（误报变漏报） | `acpSessionUpdateMeta.ts` `wholeFileDiffHunks`、`sessionChangeTracker.ts:98-126` |

### 漏报根因

| # | 根因 | 说明 |
|---|---|---|
| M1 | **Bash/终端写文件不追踪**：claude 只有 Edit/Write 的 PostToolUse structuredPatch；codex 只有 apply_patch 的 fileChange。`sed -i`、脚本生成、formatter、git 操作全部不可见 | 两家 agent 共同盲区 |
| M2 | agent 用 bash 删除**从未编辑过**的文件：tracker 无该文件记录，`!existed → deleted` 判定（`_buildChange`）无从触发 | `sessionChangeTracker.ts:527-555` |
| M3 | codex 的 turn 级聚合 diff（`turn/diff/updated`，含 rename/mode/binary 一等表示）在 fork 里被忽略未透传 | `vendor/codex-acp/src/CodexEventHandler.ts:254` |
| M4 | 重命名/移动不追踪（最多表现为 delete+add，且 M1/M2 时连这个都没有） | 机制固有 |

## 2. 参考实现的精髓

### VSCode Copilot chatEditing

- **baseline 是真快照不是逆推**：entry 创建那一刻取 `modifiedModel` 当前值 `createSnapshot()` 做独立
  originalModel（`chatEditingModifiedDocumentEntry.ts:124-132`）。前提是"编辑必经 ITextModel"——
  AI 编辑走 `pushEditOperations` 带 `EditSources.chatApplyEdits` 元数据，不直接写盘。
- **用户编辑 rebase 进 baseline**：`_mirrorEdits` 监听 model 变更，`_isEditFromUs` flag 区分来源，
  用户编辑经 OT 式 rebase 并入 originalModel → diff 只显示 AI 净改动
  （`chatEditingTextModelChangeService.ts:358-407`）。
- **外部写盘统一收口**：`startExternalEdits`（保存→拍 before 快照）→ agent 写盘 →
  `stopExternalEdits`（`revertToDisk` 取 after → **前后快照 diff 反推 TextEdit 序列**回填统一模型）
  （`chatEditingSession.ts:669-858`）。
- 持久化用**内容寻址哈希存储**（`contents/` 目录按 7 位哈希去重），timeline 只存
  baseline + TextEdit 操作日志，重放重建任意历史时刻。

### codex TurnDiffTracker

- **写前抢跑（front-run）快照**：apply_patch 落盘**之前**的 Begin 阶段对"本 turn 首次触碰"的文件
  读全文 bytes + mode + git oid 入内存（`turn_diff_tracker.rs:54-128`）。这是 agent 侧方案的本质
  优势——客户端收到通知时文件已被改写，永远读不到真 baseline。
- **右侧永远现读盘**：聚合 diff = baseline vs 当前磁盘，patch 部分失败/后续被覆盖都自动如实反映。
- **推送幂等聚合 diff**：每次 patch 后推全量 `TurnDiffEvent{unified_diff}`，客户端无需累积 hunk 流。
- add/delete/rename/mode/symlink/binary 都有一等表示；rename 用内部 uuid 稳定身份。
- 局限：同样**只追踪 apply_patch**，shell 写文件不进 diff（M1 是行业共同盲区）；tracker 是
  turn 级，会话级聚合仍需客户端做。

### 对本仓库的适配判断

我们的 agent 直接写盘（renderer 无法走 VSCode 的"编辑必经 model"主路径），但**两个 fork 的 wire
数据里已经有写前全文**：

- claude：PostToolUse `toolResponse` 自带 **`originalFile`（本次 Edit/Write 前的全文，create 时为
  null）**，fork 已把完整 toolResponse 透传进 `_meta.claudeCode.toolResponse`——renderer 侧
  `readStructuredPatch` 目前只用它判定 `isCreate`，**把全文丢掉了**（`acpSessionUpdateMeta.ts:208`）。
- codex：fork `CodexToolCallMapper.createFileChangeUpdate` 已产出 `{type:'diff', path, oldText,
  newText}` **全文对**（读盘 + applyPatch/reversePatch 重建），renderer `readDiffContentChanges`
  已拿到 `oldText`——目前却把它压成巨型 hunk 再逆推回去。

**结论：数据早就在手上，问题出在存储模型。核心改造可以完全在 renderer 侧完成，P1 无需改 fork。**

## 3. 方案总览：三层数据源，baseline 快照制

核心转变：**不再逆推 baseline，改为"首次触碰时定格写前快照"**（codex 思路），展示 diff =
定格 baseline vs 现读盘 current（右侧现读盘继承自现状，保持"任何来源的后续改动如实反映"）。

```
数据源优先级（高→低）：
  ① agent 上报的写前全文（claude originalFile / codex oldText）   —— P1，权威
  ② git 提供的改前内容（HEAD/index 版本）                          —— P2，兜底
  ③ 无 baseline（非 git 文件被 bash 触碰）→ 显示为"已触碰"降级态    —— P2

存储模型（per sessionId, path）：
  baseline: string | null | undefined   // null=会话内新建；undefined=仅 P2 侦测到、无来源
  baselineSource: 'reported' | 'git' | 'none'
  origin: 'agent' | 'watched'           // P2：fs-watch 兜底收录的标记
  batches: DiffBatch[]                  // 保留，仅服务 rewind restore/previewRestore
```

三个并存职责（对齐调研结论"codex 三件套"）：

1. **展示**：baseline 快照 vs 现读盘（新）。
2. **回滚**：per-toolCallId hunk 批次逆放（现有 `restore`/`previewRestore`，不动）。
3. **侦测**：fs-watch + git 兜底捕获 agent 未上报的改动（P2 新增）。

## 4. P1：baseline 快照制（根治误报，纯 renderer 改造）

### 4.1 上报链路改造（`acpSessionUpdateMeta.ts`）

`FileChangeDescriptor` 增加 `baseline?: string | null`：

- `readStructuredPatch`：透传 `toolResponse.originalFile`（string=写前全文，null=create）。
  同时保留 hunks（rewind 用）。
- `readDiffContentChanges`：透传 `oldText`（isCreate 时 null）。**不再调用
  `wholeFileDiffHunks` 造巨型 hunk 作为展示数据**——codex 路径的 batches 仅为 rewind 保留
  （见 4.5 开放问题：codex rewind 依赖它，不能直接删）。

### 4.2 tracker 改造（`sessionChangeTracker.ts`）

- `record(...)` 增加 `baseline` 参数：**该 (session, path) 首条记录时定格**
  `FileRecord.baseline`；后续 record 不再更新（first-touch-wins）。重投递的同 toolCallId 批次
  照旧替换，但 baseline 判定要以"首个 toolCall 的首次投递"为准。
- `_buildChange`：删除 `reconstructBaseline` 调用，直接
  `baseline = record.baseline ?? (逆推兜底或 degraded)`。状态推导逻辑不变：
  - `!existed → deleted`（baseline 用定格值，删除项可以有 diff 预览了——现状 baseline/current
    皆空、禁点击，这是顺带修复）
  - `created → added`（baseline === null）
  - `baseline === current → 从列表消失`（自动治愈：agent 改了又改回去、或 rewind 后）
  - `degraded` 仅剩一种来源：schema 迁移前的旧数据（开发阶段可直接丢弃 v2 数据，见 4.4）
- **体积**：baseline 全文 per file 只存一份，O(files) 而非 O(edits)。预算机制保留但压力大减
  （巨型 hunk 不再是展示必需品；codex 大文件场景的存储从"每次编辑全文×2"降为"一次 baseline 全文"）。
  超预算时的降级策略可以从"整会话丢弃"改为"丢 batches 保 baseline"——只失去 rewind 文件回滚，
  不失去 Session Changes 展示。

### 4.3 diff 语义说明（有意的取舍）

baseline 定格于 agent **首次触碰前**，此后到现在的一切变化（agent 后续编辑、bash、formatter、
用户手改）都会进 diff。这与 VSCode "rebase 掉用户编辑、只显示 AI 净改动"不同，但：

- 语义清晰可解释：「该文件自本会话 agent 首次触碰以来的净变化」；
- 用户会话中途手改同一文件是低频事件；
- 现状在同场景下直接 degraded/错位，新方案严格更好；
- VSCode 式 rebase 依赖"编辑必经 model"，我们做不到无损复刻，放 P3 观察需求。

### 4.4 持久化与迁移

`SCHEMA_VERSION = 3`：`files[]` 增加 `baseline`/`baselineSource` 字段。项目开发阶段不做向后
兼容（CLAUDE.md 约定）：`_deserialize` 遇 v1/v2 直接丢弃返回 undefined，旧会话的 Session
Changes 清零重来。

### 4.5 开放问题（实施前需拍板）

- **codex rewind 依赖 batches**：`restore()` 按 toolCallId 逆放 hunk 写回磁盘。P1 保留 batches
  双轨。远期若要消灭巨型 hunk，可改为 per-toolCall before 快照 + 内容寻址去重（VSCode
  contents/ 哈希思路），单独立项。
- **多 toolCall 竞态**：同文件在一个 turn 内被 Edit 多次，PostToolUse 到达顺序理论上与执行顺序
  一致（SDK 串行），首条的 originalFile 即真 baseline；若未来出现并行工具调用需按时间戳最早者定格。
- **resume 场景**：持久化的 baseline 随会话恢复继续有效；tracker 记录被预算逐出后再触碰，
  baseline 会定格在中间状态——与现状同级问题，接受。

### 4.6 测试

- `sessionChangeTracker.test.ts`：first-touch-wins、created(null baseline)、baseline===current
  自愈、deleted 带 diff 预览、v2 数据丢弃、预算降级"丢 batches 保 baseline"。
- `acpSessionUpdateMeta` 单测：originalFile/oldText 透传各形状（string/null/缺失）。
- e2e `smoke.sessionChanges.spec.ts`：现有全链路用例应全绿（行为兼容），补一条
  "agent 改后用户手改，diff 不 degraded"。

## 5. P2：fs-watch + git 兜底（补漏报 M1/M2）

**目标**：turn 运行期间 agent 经 bash/终端改的文件也出现在 Session Changes。

- **侦测**：session `running` 期间订阅 `IFileWatcherService.onDidChangeFiles`（复用
  `SessionDeletedFilesWatcher` 曾用的通道）。变更文件若不在 tracker 中 → 候选收录，
  `origin: 'watched'`。
- **过滤降噪**（关键，决定误报率）：
  - 排除工作区忽略集（`.git/`、`node_modules/`、`out/`、日志目录——复用搜索/watcher 现有排除配置）；
  - 排除编辑器内用户主导的保存：dirty model 保存事件可从 `ITextFileService`/编辑器层拿到
    "本编辑器写盘"信号，时间窗内的 watch 事件不收录；
  - 只收录 turn running 窗口内的事件（turn 结束后的变更不算）。
- **baseline 来源**：收录时文件已被改写，向 SCM 层要改前内容：git 仓库文件取 `HEAD:path`
  （或 index 版本；多 repo 按 rootUri 最长前缀路由，复用 SCM submodule 机制）。非 git 文件 →
  `baselineSource: 'none'`，展示为"已修改（无法对比）"降级行。
- **删除兜底**：watch 到 deleted 且 git 有该文件 → 收录为 deleted 项，baseline 取 git 版本
  （修 M2）。
- **UI**：`origin: 'watched'` 的行加弱化徽标（如"推测"），hover 说明来源；提供单行忽略操作
  （用户判断是自己改的）。误报由交互兜底而不是算法赌博。
- **git baseline 的时点问题**：`HEAD:path` 是"上次 commit 时"而非"turn 开始时"——若用户 turn 前
  有未提交改动，diff 会多算。可选增强：turn 开始时对 git status dirty 文件集拍轻量快照
  （codex ghost commit 思路的最小版），初版先接受 HEAD 语义 + UI 标注。

## 6. P3：可选增强（按需求再立项）

- **用户编辑 rebase**（VSCode `_mirrorEdits` 式）：监听已打开文件的 model 变更，识别非 agent
  来源 edits 并 rebase 进定格 baseline，使 diff 更接近"agent 净改动"。
- **重命名检测**（M4）：watch 的 delete+create 配对 + 内容相似度，或消费 codex
  `turn/diff/updated` 的 rename 表示（需 codex fork 把该事件从忽略列表移出、经 `_meta` 透传——
  fork 改动很小，但 ACP 无标准消息，走自定义通道）。
- **codex turn diff 校验通道**（M3）：透传后用聚合 unified diff 与本地 baseline-vs-disk 结果
  互相校验，不一致时以 agent 侧为准并打点，观察真实世界的偏差率。
- **restore 快照化**：per-toolCall before 快照 + 内容寻址存储，替换 hunk 逆放，彻底消灭巨型
  hunk 存储。

## 7. 明确不做

- **accept/reject（keep/undo）**：Session Changes 定位是只读观察视图，不引入 VSCode 的
  entry 状态机与双模型（那要求编辑流经 model，架构不符）。
- **hunk 级操作**：同上。
- **VSCode 式 checkpoint timeline**：rewind 已有独立机制（transcript 截断 + 文件回滚），不重复建设。

## 8. 分期与验证

| 期 | 内容 | 改动面 | 验证 |
|---|---|---|---|
| P1 | baseline 快照制 | 纯 renderer：`acpSessionUpdateMeta.ts` + `sessionChangeTracker.ts` + 单测 | `pnpm check` + `pnpm e2e specs/smoke.sessionChanges.spec.ts` |
| P2 | fs-watch + git 兜底 | renderer contribution + tracker 扩展 + UI 徽标 | 同上 + 新 e2e（bash 写盘场景，sessionDiffAgent.cjs 扩展） |
| P3 | 按需 | 视子项 | — |
