# cases-session-diff

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话级 diff（Session Changes，跟踪当前 ACP agent 会话改过的文件）的逐案细节——pinned baseline 快照制、预算降级与持久化版本、fs-watch 兜底链路、watched 过滤黑名单、路径身份（盘符大小写）、`origin`/`baselineSource` 语义、baseline 污染防线（2026-08-12 双 bug）、UI 与视图骨架、diff tab 不刷新的三条路径与 live-model 优先红线、测试清单。路由入口见 [CLAUDE.md](CLAUDE.md)「文件地图」与「易踩坑速记」。

## pinned baseline 快照制（2026-08 重构，取代「逆推 un-apply hunks」）

旧机制从盘上内容逆向 un-apply hunks 重建 baseline，对 agent 未上报的改动与外部改动都会误报漏报，已废弃。现状：baseline = **写前全文，且本来就在 wire 上**——claude PostToolUse 的 `toolResponse.originalFile`（Edit = 改前全文、create = null）、codex diff-content 的 `oldText`。`readFileChanges`（`acpSessionUpdateMeta.ts`）把它提取为 `FileChangeDescriptor.baseline?: string | null` **三态**：`string` = 写前全文、`null` = created、`undefined` = 未上报。tracker（`sessionChangeTracker.ts`）以 **first-touch-wins** 钉住第一次拿到的快照；展示的 diff = pinned baseline vs 现读盘；hunk batches 只供 rewind restore 用（不再参与 baseline 重建）。per-file cap `MAX_BASELINE_BYTES = 4MB`（`sessionChangeTracker.ts:177`）：超限的文件不 pin，回退 `sessionDiffReconstruct.ts` 逆推。

## 预算降级与持久化版本

超 per-session 预算时先**丢 batches 保 baseline**（diff 存活，rewind 回滚降级），baselines 单独仍超限才丢整个会话（`sessionChangeTracker.ts:160/455/477`）。持久化 `SCHEMA_VERSION = 3`：v1/v2 的数据**直接丢弃不迁移**。会话级活行内存降级与预算读数另见 [cases-memory-budget.md](cases-memory-budget.md) 与 `docs/development/memory-pressure.md`。

## fs-watch 兜底链路（`SessionWatchedChangesContribution`）

存在理由：**agent 经 Bash 等工具的改动不上报**（不走 Edit/Write 的结构化 diff 通道），只有 watcher 看得见。链路（`SessionWatchedChangesContribution.ts`，AfterRestore 注册）：监听文件 watcher → 在**事件时刻**捕获当时的 running 会话（不做延迟归属判断）→ 1500ms grace（agent 自身上报先落地则本次只刷新、不重复记录）→ 批量 `git.checkIgnore` 过滤 gitignore（`git check-ignore --stdin -z`；**exit 1 = 无忽略，不是错误**；git 扩展未激活或命令失败则降级为不过滤）→ stat 确认（`deleted` 常是 atomic rewrite 的中间态；目录跳过）→ `executeCommand(dirtyDiffCommandId(providerId, 'getHeadContent'), fsPath)` 取 git HEAD baseline（`undefined` = 命令未注册 → degraded；`null` = 无 HEAD → created）→ `recordWatched`。

## watched 过滤 = 应用自有目录黑名单，不是工作区白名单

watcher 是**全局流**，不能按工作区过滤：agent 经 shell 写工作区外文件（计划文件、`~/.claude/explore-results` 等）正是这条链路要保的场景。反向事故：打包版的内置主题 JSON（`ThemeFileWatcher` 经 `watchOutOfWorkspace` 订阅 `resources/extensions/theme-defaults/themes/`）被误记成推测条目——没有 git baseline，于是 diff 两边一致还挂个感叹号。修复：`IEnvironmentSnapshot` 扩 `userDataDir` + `appResourcesPath`（**仅 packaged 有值**，dev 下内置扩展就在仓库源码里、可能正是打开的工作区，故不过滤），`_collect` 用 `isEqualOrParent` 按黑名单丢弃。**self-write 排除**：`selfWriteRegistry.ts`（`services/editor/`）+ `FileEditorInput.save` 写盘前 `noteSelfWrite`（3s 窗口；键必须用消费方注入的 `IUriIdentityService.getComparisonKey`，不要手写 `fsPath`）。`MAX_PATHS_PER_FLUSH = 50` 防整树风暴。

## 路径身份：盘符大小写

claude-code 在 Windows 上报**小写盘符** `d:/...`，而 watcher 路径继承打开工作区时的大写盘符 → tracker 曾用保 casing 的字符串作 Map 键，同一个文件两条记录、树上冒出绝对路径顶层组。修复：tracker 注入 `IUriIdentityService`，Map 键走 `getPathComparisonKey`（展示用 path 另存第一次见到的 casing）；`buildTree` 剥根前缀从 `startsWith` 改 `relativePathUnder`。

## `origin` / `baselineSource` 语义

`SessionFileChange` 带 `origin: 'agent' | 'watched'` + `baselineSource: 'reported' | 'git' | 'reconstructed' | 'none'`。agent record 会解除 dismiss 并把 origin 升级，但**保留更早 pin 的 git baseline**（first-touch-wins 的延伸）。`getHeadContent` 的 `null` 区分不了 untracked（该显示）与 ignored（该过滤），所以 checkIgnore 是**独立查询**：契约在 `packages/extensions-common/src/contracts/dirtyDiff.ts` 的 `DirtyDiffCapabilities`，按 `resolveRepo` 最长前缀路由到嵌套 repo。

## baseline 污染防线（2026-08-12 双 bug）

四条，动 `readFileChanges` / `record` 前逐条核对：

1. **claude 乐观 tool_call 的 diff content 是 old_string 片段**：tool_call 在执行**前**发出，其 `oldText` 只是 old_string 片段（Write 恒 null），**绝不可当整文件 baseline**。`readFileChanges` 对「带 `_meta.claudeCode` 但无 structuredPatch」的更新返回 `[]`；codex 没有该 meta（其权威整文件 diff 恰好就在 tool_call 上），不受影响。
2. **claude ≥2.1.226 只有每文件第一次 Edit 带 `originalFile` 全文**，之后为 `null`——那是「未上报」，不是 create；只有 Write 的 null 才是 create 信号（Edit 的结果没有 `type` 字段）。
3. `record()` 允许 watched 钉的 `null`（baselineSource 未设）升级为 agent 上报的字符串；`'reported'` 的 `null`（Write 新建）**不升级**。
4. `_buildChange` 加 `!existed && source === 'none'` 净零清除：claude 原子写 tmp 文件（`x.tmp.<pid>.<hex>`，只在 watcher 里出现）在 git 命令不可用时，曾以 `D` + 推测徽标永久残留。

## UI 与视图骨架

watched 行显「推测」徽标（`acp-changes-inferred`）+ hover EyeOff 忽略按钮（`dismissWatched` 置 `ignored = true`；记录保留，防 watcher 重新加回来）。视图骨架与 commit-changes **共享** `workbench/changesTree/`（泛型 `ChangesTree` + `buildChangesTreeSnapshot`），`SessionChangesView.tsx` 只是薄 wrapper（`describeFile` 注入徽标/按钮/badge，DiffEditorInput 直开）——由此白得键盘导航、焦点命令 `workbench.view.sessionChanges.focus`、焦点记忆、Collapse/Expand All、虚拟化。list 排序 = path 字母序；`acp-changes-*` testid 与持久化 key 全保留；list/tree、单击预览/双击钉住（`pinned: false/true`）语义不变。用户可见行为见 `docs/user/zh-CN/git/session-changes.md`。

## diff tab 不刷新：三条独立路径，都要修

**路径 1（重新点列表行）**：`EditorService.openEditor` 按 `input.id` 去重（`DiffEditorInput` 的 id 是 `diff:${uri}`），命中已开 tab 时直接 `input.dispose()` 丢掉携带新 baseline/current 的新 input、复用旧实例；而 `SessionChangesView` 每次点行都 `new DiffEditorInput(...)`、从不更新已存在的实例。修复 = `EditorInput` 基类加可选钩子 `updateFrom?(other)`，`openEditor` 命中已存在实例时先 `existing.updateFrom?.(input)` 再 dispose（`DiffEditorInput.updateFrom` 调 `update()`）。契约与平台侧细节见 `packages/platform/CLAUDE.md`「EditorInput.updateFrom 契约」；测试 `EditorService.diffReuse.test.ts`。

**路径 2（diff tab 一直开着、agent 又改文件——真正的主场景）**：已打开的 `DiffEditorInput` 不订阅 tracker（只有 `SessionChangesView` 列表订阅了 `changesFor`），于是列表刷新而 tab 纹丝不动、不重新点行就永远不刷新。修复 = 常驻 contribution `SessionChangesDiffSyncContribution`（AfterRestore）：autorun 遍历 `sessions.sessions` 订阅**所有**会话的 `changesFor`（各自读 `sessionIdOnAgent`；diff tab 可属任意 session，不是只有 active），按同 `originalUri` 命中已开实例调 `update(baseline, current)`。测试 `SessionChangesDiffSyncContribution.test.ts`。

**路径 3（用户在编辑器里改源文件，diff 要 live 跟随）**：`DiffEditor` 的 modified 侧是**独立临时 model**（synthetic URI），与源文件共享的 Monaco model 脱钩，所以切回源文件编辑（含未保存脏编辑）时 diff 不动。修复 = `DiffLiveContentSyncContribution`（AfterRestore）为每个开着的 `DiffEditorInput` 订阅其 `originalUri` 的共享 model（`MonacoModelRegistry.peek`），`onDidChangeContent` 时把 live 文本推进 diff 的 modified 侧。

下游链路 `update()` → `onDidChangeContent` → `DiffEditor.tsx` 就地 setValue 双侧 model 本就齐全，两处缺口都只在「谁来触发 update」；路径 1/2 互补兜底（tracker 的 `_recompute` 是异步的，点行那刻 `current` 可能仍是旧值，contribution 会在重算完后再刷一次）。

## 红线：刷新 diff modified 侧一律 live-model 优先

写盘会触发**迟到的 fs 事件**：`ExternalChangeWatcher._refreshDiff`（`ExternalChangeWatcher.ts:426`）与 `SessionChangesDiffSyncContribution._sync` 若直接拿磁盘/tracker 的值去 `update`，会**盖掉用户未保存的 live 编辑**（磁盘还是旧内容）。统一修法：两处刷 modified 侧时都 **live-model 优先**——`MonacoModelRegistry.peek(uri)` 有值就用 `model.getValue()`（编辑器缓冲才是真相；clean 时它 = 磁盘，也覆盖 SCM discard 后 revert 的情形），没有 live model 才回退读盘。**别用 `isDirty` 判断**该取哪个（React effect 异步更新，fs 事件到达时可能还没翻 true，留竞态窗口）；`isDirty` 现在只用于「共享缓冲 clean 才把磁盘值以最小编辑回灌并 markClean」这一文件编辑器对齐语义。回归 `ExternalChangeWatcher.test.ts`（`vi.mock` `MonacoModelRegistry` 注入 live model，验不被 disk-stale 覆盖）；E2E 排障见 skill `fix-ci-e2e-flake` 案例 19。

## 测试清单与三个坑

单测：`sessionChangeTracker.test.ts`（pinned baseline / watched / 预算降级 / v3 持久化 / 跨 casing 去重）、`acpSessionUpdateMeta.test.ts`（`readFileChanges` claude/codex 两路）、`SessionWatchedChangesContribution.test.ts`（含 gitignore 过滤与降级）、`SessionChangesView.test.tsx`（含徽标/忽略/casing 相对化）、git 扩展 `extensions/git/src/__tests__/repository.test.ts`（`checkIgnore`，真实 temp repo）；e2e `smoke.sessionChanges.spec.ts`（@p1 全链路）。

坑：① `makeScm` 测试桩的默认参数用 `string | null`——显式传 `undefined` 会命中默认值；② `toolResponse.type: 'create'` 与 `originalFile: null` 都是 created 信号；③ **Bash 工具的改动不上报**——这正是 watcher 兜底链路存在的原因。

## 参考路径

- 本目录：`sessionChangeTracker.ts` / `acpSessionUpdateMeta.ts` / `sessionDiffReconstruct.ts`；`IAcpSession` 类型在 `acpSessionModel.ts`，**不在 platform**。
- UI：`workbench/agents/SessionChangesView.tsx`、`workbench/changesTree/`（`ChangesTree.tsx` / `buildSnapshot.ts`）。
- contributions（`apps/editor/src/renderer/contributions/`）：`SessionWatchedChangesContribution.ts` / `SessionChangesDiffSyncContribution.ts` / `DiffLiveContentSyncContribution.ts` / `ExternalChangeWatcher.ts`。
- 契约 `packages/extensions-common/src/contracts/dirtyDiff.ts`；预算读数 `docs/development/memory-pressure.md`。
