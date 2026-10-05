# Tree View（扩展贡献的树视图）

对标 VSCode `MainThreadTreeViews` / `ExtHostTreeViews` 的首版裁剪实现：链路、懒加载、handle 身份、host 侧命令解析与两个坑在此。**扩展侧对外契约（行点击/刷新语义、首版裁剪清单）**见 `docs/extension-dev/zh-CN/migration-from-vscode.md`；另两个已登记的坑——`undefined` 过 newline-JSON 变 `null`、全 when 门控掉时的空菜单泄漏——分别见 `packages/extension-host/cases-runtime-pitfalls.md` 与 `packages/workbench-ui/CLAUDE.md`，不在此重复。

## 链路与懒加载

```
manifest contributes.viewsContainers/views
  → ExtensionPointTranslator._registerViews（componentKey=EXTENSION_TREE_VIEW_COMPONENT_KEY='extension.treeView'；MENU_ID_BY_KEY 含 view/title、view/item/context）
ExtensionTreeView.tsx（按 viewId 分发；mount 发 viewActivationEvent(viewId) 激活 owning 扩展）
  ⇄ mainThreadTreeViews / extHostTreeViews（$getChildren / $refresh / selection / expansion / visibility / $executeTreeItemCommand）
services/extensions/TreeViewsService.ts（按页 DTO 缓存 + per-page epoch 防在途拉取覆盖新数据）
  ⇄
packages/extension-host/src/hostTreeViews.ts（HostTreeViewRegistry：三级稳定身份 + element↔handle 双向表 + commandByHandle；
  onDidChangeTreeData → REFRESH_DEBOUNCE_MS=50 debounce → $refresh(viewId, items?) 整树/子树失效）
```

**拉取式懒加载**：renderer 只拉用户展开的节点——`TreeModel.getChildren` 返回 `null` 触发 `loadChildren` → RPC。`packages/workbench-ui` 的 `Tree`/`TreeModel` 全部复用，未新写树基建。

## handle 跨刷新稳定（三级身份）

`TreeItem.id` → **元素对象本身**（仍在同一页时）→ **父句柄**下的 label（`/` 转义 `//`，同名兄弟 `~n`）。子节点 key 挂**父 handle** 而非父 key 字符串——否则父改名会连带作废整棵子树身份（身份若只按 label 算，改名 = 新 key = 新 handle = 展开态丢失）。handle 只在元素不再从父 `getChildren` 回来时回收（连缓存子树一起），既保展开态又给 handle 表封顶。实现：`hostTreeViews.ts` 的 `_bind` / `_stableKey` / `_recyclePage`。

**展开态跨刷新保留**：`onDidChangeTreeData(element)` 只失效该子树（行就地替换 + 只丢它的 children 页），无参为整树失效；视图侧 `onDidChangeView` 对**仍展开但页被丢**的行补拉，且**补拉不发展开事件**（保住「展开事件只由用户交互触发」）。

## host 侧命令解析

行点击与 `view/item/context` 菜单命令都走 `$executeTreeItemCommand(viewId, handle, commandId?)`：host 按 handle 反查 element / 原始 `TreeItem.command`，经 `ExtensionCommandRegistry.execute` 路由（查不到则既有 `_workbench.*` / allowlist 兜底转发 renderer）。`command.arguments` **不上 wire**（DTO 只带 id/title/tooltip/disabled——`hostTreeViews.ts` 的 `toCommandDto(cmd, ['disabled'])`），renderer 侧**禁 revive 鸭子类型**。

⚠️ 反例：scm/timeline 的 `toCommandDto` **刻意保留 `arguments`**（`ScmView.commandArgs()` / `TimelineView.runItem` 真实消费；`hostTimeline.ts` 的字段表就是 `['arguments']`）。三份已收敛为 `packages/extension-host/src/hostHandles.ts` 的 `toCommandDto(cmd, fields)`，字段由调用点声明——加新消费方照此声明，别复制 DTO 形状。

## 两个坑

1. **行点击双触发**：`Tree` 的 `onClickRow` 内置已对叶子触发 `onActivate`；行 `onClick` 再手动跑命令会执行两次。**命令只挂 `onActivate`**（`workbench/extensionViews/ExtensionTreeView.tsx:271/301`）。
2. **epoch 归零致 stale 复活**：renderer 按页记 epoch 防在途拉取覆盖新数据；settle 时若删掉 epoch 条目、计数器归零，更老的在途拉取比对相等后会把已失效的行「复活」。修法 = epoch **单调递增、永不删除**，只在该页有 in-flight 拉取时记账（`services/extensions/TreeViewsService.ts:275-277`）。

## 验证资产

- 单测：`packages/extension-host/src/__tests__/hostTreeViews.test.ts`、`apps/editor/src/renderer/services/extensions/__tests__/TreeViewsService.test.ts`、`apps/editor/src/renderer/workbench/extensionViews/__tests__/ExtensionTreeView.test.tsx`
- e2e：`apps/editor/e2e/specs/smoke.treeView.spec.ts`（@p1；内联 vsix 覆盖树渲染 / 懒展开 / 命令 / 刷新，以及 `view/item/context` 菜单的 when 门控）
