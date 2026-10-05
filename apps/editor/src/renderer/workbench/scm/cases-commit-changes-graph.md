# cases-commit-changes-graph.md

本文从 `workbench/scm/CLAUDE.md` 拆出，范围是 **Commit Changes 侧栏视图**（`workbench/scm/commitChanges/`）与 git / perforce 图谱的交互打磨：toolbar、焦点落点、键盘导航、选中静默同步、三处延迟/高亮根因，以及视图交互内核的抽取位置。CLAUDE.md 只留入口；改 Commit Changes 视图或图谱联动前通读本文。

## 案例：Commit Changes 视图 + 图谱联动打磨

2026-08-08 在 `15163b43`（基于 `a909f62c` 的多文件 diff 视图）完成这轮打磨。功能面：workspace 切换清空、头部两行化、toolbar（Open in Graph / 折叠展开 / tree-list 切换持久化）、聚焦命令 `workbench.view.scm.commitChanges.focus`（`actions/commitChangesActions.ts`，焦点落点 = revealPath → 记忆 → 首文件；**空格** preserveFocus 预览、**回车**聚焦 diff）、graph 键盘导航（↑↓ / Home / End / PgUp / PgDn / Ctrl+Enter 菜单 + 多目标 QuickPick，`workbench/gitGraph/useGraphKeyboardNav.ts` 被 git / perforce 两个编辑器复用）。

### 三个根因坑（都是"看起来像 UI 小问题"的竞态）

1. **reveal 无高亮**：`openEditor` 同步返回先于 React 提交 tab 切换，桥接命令直调的 `revealCommit` 是**即将卸载的旧实例**的闭包（写 state 无人消费）。修法 = reveal 请求写 `pendingReveal` observable，由新挂载实例响应式消费——现落点 `workbench/gitGraph/usePersistedGraphSelection.ts`（它同时服务于 session 恢复的 reveal）。
2. **点击延迟**：`onRowClick` 的 `useCallback` 依赖 `selection`，每次点击都让全表 `CommitRow` 的 memo 失效、整表重渲染。修法 = 稳定回调身份——现泛化为 `workbench/changesTree/ChangesTree.tsx` 的 `callbacksRef`（回调经 ref 间接调用，身份恒定）。
3. **graph 选中静默同步**：图谱里点行要把该 commit 的改动推进 Commit Changes 视图，走 payload 的 `silent` 标志（不 `openViewContainer`、不抢焦点）；**跟随门槛 = 视图已有 payload**（没被打开过的视图不追）。实现 = `workbench/scm/commitChanges/graphFollow.ts`（`shouldFollowGraphSelection` + `createCommitChangesFollower`）+ `graphPayloadCache.ts`（LRU，`MAX_CACHED_PAYLOADS = 50`，点击与跟随**共享同一份缓存**）+ 点击 / 跟随共享 latest-wins 序号。

### 坑 4 与内核抽取

**大重构删 UI 后必须 grep e2e spec 里对被删 UI 的文本断言**：`a909f62c` 删掉 perforce graph 的底部详情面板，却没同步 `extensions/perforce/e2e/specs/perforceGraphReveal.spec.ts` 里 `#4521 · ` 形态的断言，`e2ea` 全量才暴露。现该 spec 已改为指向 Commit Changes（详情面板的职责已迁到该侧栏视图）。删任何视图前，先 grep `apps/editor/e2e/specs/` 与 `extensions/*/e2e/specs/` 里的可见文本断言。

视图交互内核（快照构建 / Tree 渲染 / 折叠信号 / 焦点记忆 / 键盘导航）已抽到 `workbench/changesTree/`：泛型 `ChangesTree` + `describeFile` slot（`ChangesTree.tsx` / `buildSnapshot.ts` / `toolbar.tsx` / `useOpenDiffEditor.ts`），Session Changes 复用同一实现——**改这里两个视图同时受益**；`workbench/scm/commitChanges/CommitChangesView.tsx` 只剩薄 wrapper（`toItem` + `describeFile` 注入 + `useGraphKeyboardNav`）。

### 关键参考路径

- `apps/editor/src/renderer/workbench/scm/commitChanges/CommitChangesView.tsx` —— 薄 wrapper（describeFile 注入）
- `apps/editor/src/renderer/workbench/scm/commitChanges/{graphFollow,graphPayloadCache,viewState}.ts` —— 跟随逻辑 / payload LRU / tree-list 模式持久化（`scm.commitChanges.viewMode`）
- `apps/editor/src/renderer/workbench/scm/commitChanges/CommitChangesViewToolbar.tsx` —— Open in Graph / 折叠展开 / `…` 溢出
- `apps/editor/src/renderer/workbench/changesTree/` —— 共享交互内核（`ChangesTree.tsx` 的 `callbacksRef`、`buildSnapshot.ts`）
- `apps/editor/src/renderer/workbench/gitGraph/useGraphKeyboardNav.ts` —— 键盘导航 hook（两编辑器复用）
- `apps/editor/src/renderer/workbench/gitGraph/usePersistedGraphSelection.ts` —— `pendingReveal` observable
- `apps/editor/src/renderer/actions/commitChangesActions.ts` —— `_workbench.showCommitChanges` / `workbench.view.scm.commitChanges.focus`
- `extensions/perforce/e2e/specs/perforceGraphReveal.spec.ts` —— 坑 4 的守护（详情已迁到 Commit Changes）
