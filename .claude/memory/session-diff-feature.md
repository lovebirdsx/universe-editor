---
name: session-diff-feature
description: 会话级 diff（Session Changes）——pinned baseline 快照制（agent 上报写前全文/watched 走 git HEAD）+ fs-watch 兜底侦测 + 推测徽标
metadata: 
  node_type: memory
  type: project
  originSessionId: f6f35c5d-d60d-486e-b6f2-8a1f136ffcfd
  modified: 2026-08-12T07:31:52.891Z
---

会话级 diff（VSCode-Copilot 式「Session Changes」），跟踪当前 ACP agent 会话改动的文件。2026-08 重构为 **pinned baseline 快照制**（替代旧「从盘上内容逆向 un-apply hunks 重建 baseline」——旧机制对 agent 未上报的改动/外部改动会误报漏报）。方案文档 `docs/plan/session-changes-baseline-snapshot-plan.md`。

核心设计（2026-08 现状）：
- **P1 baseline 快照**：写前全文已在 wire 上——claude PostToolUse `toolResponse.originalFile`（Edit=改前全文、create=null）、codex diff-content `oldText`。`readFileChanges`（acpSessionUpdateMeta.ts）提取为 `FileChangeDescriptor.baseline?: string | null`（string=写前全文、null=created、undefined=未上报）。tracker **first-touch-wins** 钉住快照；展示 diff = pinned baseline vs 现读盘；hunk batches 仅供 rewind restore。per-file cap `MAX_BASELINE_BYTES=4MB`（超限不 pin，回退 `sessionDiffReconstruct` 逆推）。
- **预算降级**：超 per-session 预算先「丢 batches 保 baseline」（diff 存活、rewind 回滚降级），baselines 单独仍超限才丢整会话。SCHEMA_VERSION=3，v1/v2 持久化直接丢弃不迁移。
- **P2 fs-watch 兜底**：`SessionWatchedChangesContribution`（AfterRestore）监听 watcher，事件时刻捕获 running 会话 → 1500ms grace（agent 自身上报先落地则仅刷新）→ **批量 `git.checkIgnore` 过滤 gitignore 文件**（`git check-ignore --stdin -z`，exit 1=无忽略非错误；扩展未激活/失败降级为不过滤）→ stat 确认（deleted 常是 atomic rewrite；目录跳过）→ `executeCommand(dirtyDiffCommandId(providerId,'getHeadContent'), fsPath)` 取 **git HEAD baseline**（undefined=命令未注册→degraded；null=无 HEAD→created）→ `recordWatched`。**watched 过滤策略（2026-08-12）= 应用自有目录黑名单，不是工作区白名单**：watcher 是全局流，打包版内置主题 JSON（ThemeFileWatcher 经 watchOutOfWorkspace 订阅 `resources/extensions/theme-defaults/themes/`）曾被误记为推测条目（无 git baseline → diff 两边一致 + 感叹号）；但 agent 经 shell 写工作区外文件（计划文件/~/.claude/explore-results）是 watched 链路要保的场景，不能按工作区过滤。修复=IEnvironmentSnapshot 扩 `userDataDir` + `appResourcesPath`（仅 packaged 时有值，dev 下内置扩展在仓库源码里可能就是打开的工作区，不过滤），`_collect` 用 isEqualOrParent 黑名单丢弃。self-write 排除：`selfWriteRegistry.ts` + FileEditorInput.save 写盘前 `noteSelfWrite`（3s 窗口；键用消费方注入的 IUriIdentityService.getComparisonKey，不手写 fsPath）。MAX_PATHS_PER_FLUSH=50 防整树风暴。
- **路径身份（2026-08 修复）**：claude-code 在 Windows 上报**小写盘符** `d:/...`，watcher 路径继承打开工作区时的大写盘符 → tracker 曾用保 casing 的字符串作 Map 键致同文件双记录、树上冒出绝对路径顶层组。修复：tracker 注入 IUriIdentityService，Map 键走 `getPathComparisonKey`（展示 path 另存首次 casing）；`buildTree` 剥根前缀从 `startsWith` 改 `relativePathUnder`。`getHeadContent` null 区分不了 untracked（该显示）与 ignored（该过滤），所以 checkIgnore 是独立查询（契约在 `dirtyDiff.ts` DirtyDiffCapabilities，按 resolveRepo 最长前缀路由嵌套 repo）。
- **origin/baselineSource**：`SessionFileChange` 带 `origin: 'agent'|'watched'` + `baselineSource: 'reported'|'git'|'reconstructed'|'none'`。agent record 解除 dismiss、升级 origin，但保留更早 pin 的 git baseline（first-touch-wins）。
- **UI**：watched 行显「推测」徽标（`acp-changes-inferred`）+ hover EyeOff 忽略按钮（`dismissWatched` 置 ignored=true，记录保留防 watcher 重加）。用户文档 `docs/user/zh-CN/git/session-changes.md` 有对应节。
- **视图**（2026-08-09 重构）：UI 骨架与 [[commit-changes-view-graph-polish]] 共享 `workbench/changesTree/`（泛型 ChangesTree + buildChangesTreeSnapshot），SessionChangesView 只是薄 wrapper（describeFile 注入徽标/按钮/badge，DiffEditorInput 直开）；由此获得键盘导航/焦点命令 `workbench.view.sessionChanges.focus`/焦点记忆/Collapse-Expand All/虚拟化；list 排序变为 path 字母序；acp-changes-* testid 与持久化 key 全保留。list/tree、单击预览/双击钉住（pinned:false/true）语义不变。

测试：`sessionChangeTracker.test.ts`（pinned baseline/watched/预算降级/v3 持久化/跨 casing 去重）、`acpSessionUpdateMeta.test.ts`（readFileChanges claude/codex 两路）、`SessionWatchedChangesContribution.test.ts`（含 gitignore 过滤与降级）、`SessionChangesView.test.tsx`（含徽标/忽略/casing 相对化）、git 扩展 `repository.test.ts`（checkIgnore 真实 temp repo）；e2e `smoke.sessionChanges.spec.ts`（@p1 全链路）。

坑：makeScm 测试桩默认参数用 `string | null`（显式传 undefined 会命中默认值）；`toolResponse.type:'create'` 与 `originalFile:null` 都是 created 信号；Bash 工具改动不上报——正是 watched 链路存在的原因。
