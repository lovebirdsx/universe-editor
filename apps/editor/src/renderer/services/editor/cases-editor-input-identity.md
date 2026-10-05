# cases-editor-input-identity.md

本文从 `services/editor/CLAUDE.md` 拆出，范围是 **EditorInput 身份隔离的次生点**——id 覆写只解决「同文件多视图」，两 tab 共存之后还会撞上下面几类问题。改动涉及「同文件多 tab」或「单例编辑器泛化多实例」前通读。

## 次生点 1：按 resource 认 tab 不够，得按 id / typeId

- **Reopen Closed Editor**：`ClosedEditorsService` 的条目是 `(typeId, resource)`，`_isOpen(entry)`（`ClosedEditorsService.ts:182-190`，`popMostRecent` / `getClosedEditors` / `takeMostRecentMatching` 共用）与 `_record` 去重（`:217`）都**必须同时比 `typeId`**——否则共享同一 file 的 image preview 与文本视图互相顶掉（图片 tab 已关但文本 tab 还开着时，Ctrl+Shift+T 会误判"还开着"而跳过它）。
- **tab 定向命令**：`resolveTargetEditor`（`actions/editorActionHelpers.ts:45`）在 arg 带 `editorId` 时**先按 `editorId` 精确定位**（`e.id === arg.editorId`），再回退 `resource.toString()` 比对。tab 右键菜单 / `ReopenWithAction` 都吃这个 arg——只按 resource 找会在「同 URI 两个 tab」时关错/激活错。回归 `actions/__tests__/editorActions.test.ts`（"picks the exact tab by editorId when two share a URI"）。

## 次生点 2：两派覆写手法与各自代价

- **虚拟 scheme 派**（`diff:` / `markdown-preview:` / `merge:`）：`resource` 本身是另一个 scheme，`id` 天然不同；额外暴露 `sourceUri` / `sourceInput` 给视图拿真资源。代价：任何「按 `file:` 前缀/扩展名认人」的外围逻辑要单独适配（tab 图标、SCM 装饰、`ue-file` 加载）。
- **仅覆写 id 派**（`image:${uri}`，`ImageEditorInput.ts:38-39`）：`resource` 保持真 `file:`，只有 `id` 分叉。**图片走这派**——tab 图标、SCM 装饰、`ue-file` 协议加载全都要真实 `file:` resource，换成虚拟 scheme 就得挨个补适配。
- 选型判据：**外围消费方是否需要真 `file:` resource**。需要 → 仅覆写 id；不需要（且视图有自己的协议面）→ 虚拟 scheme。

## 次生点 3：id 去重 ≠ 数量不变量（含一次设计反转）

`id` 隔离只保证「同一文件的预览与源各占一 tab」，**表达不了任何跨 tab 的数量约束**——这类约束必须在打开入口显式实现，别指望 id 命名空间。

- **当前不变量**（`services/editor/openPreviewInGroup.ts`）：**同一文件的预览全局唯一**（任意组已有则聚焦该 tab，不新开）；**不同文件的预览可以同组共存**（`2026-08-27 72793afc` 起）。
- **已被推翻的旧结论（勿改回去）**：`2026-08-25 b6b905a7` 曾把渲染预览做成 VSCode dynamic preview——「同组同 kind 最多一个，开新预览时显式 retarget 替换旧 tab」，当时三处同构逻辑各自只 `findEditor(同 id)` 而漏掉替换，[a 预览][a 源] 下开 b 预览会堆出第三个 tab。两天后按产品需要改成「不同文件预览各自成 tab」，`openPreviewInGroup` 里的 retarget 分支与 `previewReplace` 处理随之删除。**看到旧笔记/旧注释提「同组同 kind 只留一个」时，先读 `openPreviewInGroup.test.ts` 的 "lets previews of different files coexist" 再动手。**
- **唯一入口仍是这两个函数**：`openPreviewInGroup`（非 toggle）与 `togglePreviewInGroup`（Ctrl+Shift+V）。所有入口都汇到它——Ctrl+Shift+V、预览内链接（`workbench/markdown/useMarkdownFileLink.ts:240`）、历史前进后退（`actions/historyActions.ts:64`，`pinned:false` 落预览槽）、hover「Open Preview」（`services/resourcePreview/openResourcePreview.ts`）、markdown/html 预览 Action。
- **唯一刻意不走的例外**：`MarkdownPreviewInput.deserialize` / `HtmlPreviewInput.deserialize`（工作区恢复走 `EditorGroupsService.ts:454` 的 `EditorRegistry.deserialize` → 各自 `deserialize`）——恢复的语义是「原样还原用户的 tab」，不能做唯一化合并。恢复后短暂的重名预览会在下一次 preview 打开时收敛。

## 次生点 4：toggle 的 pin 继承与 dirty 保护（曾丢过未保存编辑）

`togglePreviewInGroup` 用预览替换同组的源 tab（detach 源、预览 `adoptSource()` 持有它，Monaco model 存活到切回）。两条必须一起读：

- **pin 继承**：`pinned = group.isPinned(source) || source.isDirty`，且**必须在 `detachEditor` 之前读**——detach 后源不在组里，`isPinned` 对未知 editor 恒 false。
- **dirty 保护**：dirty 的源**绝不能进预览槽**。槽里的预览会被后续 `pinned:false` 的打开按 `previewReplace` 释放（连带级联 dispose 它持有的源）→ 未保存编辑三条路同时静默：关闭无提示 + 不进 backup + 外部变更静默 reload。`|| source.isDirty` 这一项就是为此存在的（回归 `openPreviewInGroup.test.ts` 的 "toggle: a dirty source forces the preview pinned…" 与 "…a later slot open cannot evict it"）。
- `FileEditorInput` **没有 `updateFrom`**，dirty 标志也不在共享 Monaco model 上（`FileEditorInput.updateDirtyFromModel`）——所以 dirty 只能在 input 实例之间用「保住实例」的方式传递，没有内容搬运通道。

## 次生点 5：单例编辑器泛化多实例 = 两处必改，漏第二处状态串扰

把一个「全局单例」编辑器泛化成带参多 tab（先例：Perforce 文件历史）时：

1. **模块级 view state 单例改按 `input.id` 分桶**（先例 `services/perforceGraph/perforceGraphViewState.ts`：懒建 scoped 桶 `_scopedStates`，按 `input.id` 取，用 `MAX_SCOPED_STATES`（12）封顶——每个桶持有整页 change 数组，不封顶会随 tab 无界增长）。
2. **在 `workbench/editor/EditorGroupView.tsx:886-900` 的 keyed remount 名单登记该 `componentKey`**（现名单：`markdown.preview` / `doc` / `swarmReview` / `perforceGraph`）。

第 2 处为什么是刚需：默认渲染路径是 `<Component input={active} />`，**没有 key**——同组 A→B 切 tab 复用同一实例只换 prop，而组件的 `useState(() => view.xxx)` 惰性初始器**只在挂载时跑一次**，于是 B 显示 A 的数据；更糟的是镜像 effect 会反手把 A 的 result/selection 写进 B 的桶，污染是双向的。keyed remount（`key={active.id}`）让原地换 input 时重挂载出干净表面。

**护栏测试写法**（`workbench/editor/__tests__/EditorGroupView.perforceGraphScopeSwap.test.tsx`）：一个 `ProbeX` 组件用**空依赖 `useEffect`** 计数挂载次数，同组连续切两个不同 id 的 input，断言新 id 的计数为 1——没有 key 时第二个 input 复用实例、计数为 0（挂在 `useState` 惰性初始器上也可，任选其一，关键是**观察挂载而非渲染**）。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer-node src/renderer/services/editor/__tests__/openPreviewInGroup.test.ts \
  src/renderer/services/editor/__tests__/ClosedEditorsService.test.ts
pnpm e2e specs/smoke.imageEditor.spec.ts specs/smoke.htmlPreview.spec.ts
```
