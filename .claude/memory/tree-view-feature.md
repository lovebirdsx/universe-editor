# Tree View 功能（contributes.views + TreeDataProvider）

> 阶段一（manifest 贡献点 + 占位组件）与阶段二（RPC 数据链路 + 真树渲染 + 菜单 + e2e）均已落地。对标 VSCode MainThreadTreeViews/ExtHostTreeViews 的首版裁剪实现。

## 链路一图

```
manifest contributes.viewsContainers/views → ExtensionPointTranslator._registerViews
  （componentKey=EXTENSION_TREE_VIEW_COMPONENT_KEY；MENU_ID_BY_KEY 含 view/item/context）
ExtensionTreeView.tsx（按 viewId props 分发；mount 发 onView:<viewId> 激活）
  ⇅ mainThreadTreeViews（注册/$refresh）/ extHostTreeViews（$getChildren/selection/expansion/visibility/$executeTreeItemCommand）
renderer services/extensions/TreeViewsService.ts（per-view DTO 缓存 + generation 防 stale）
  ⇅
host HostTreeViewRegistry（element↔handle 双向表 + commandByHandle；onDidChangeTreeData → 清表 + $refresh 整树失效）
```

## 关键决策

- **拉取式懒加载**：renderer 只拉用户展开的节点；TreeModel 的 `getChildren` 返回 null 触发 `loadChildren` → RPC。workbench-ui Tree/TreeModel 全部复用，未新写树基建。
- **handle 单代有效**：host 每次 onDidChangeTreeData 清 handle 表；renderer `$refresh` bump generation，in-flight 拉取落地时 generation 不符即丢弃。stale handle 两侧都答 `[]` 不报错。
- **首版裁剪**：无 reveal/DnD/checkbox/badge/TreeView.title；iconPath 仅 codicon 名；getParent 不消费。JSDoc 均已注明。
- **命令参数解析在 host 侧**：行点击与 view/item/context 菜单都走 `$executeTreeItemCommand(viewId, handle, commandId?)`——host 按 handle 反查 element/原始 `TreeItem.command`，经 `ExtensionCommandRegistry.execute` 路由（本地 handler 拿活引用；查不到则既有 `_workbench.*/allowlist` 兜底转发 renderer）。`command.arguments` 不上 wire（DTO 只带命令 id/title/tooltip/disabled），handler 收到的是扩展自己返回的原对象；`command` 不带 `arguments` 时 handler 收到该行 element（vscode 契约）。renderer 侧禁 revive 鸭子类型。
- **展开态不跨刷新**：TreeItem.id 未参与身份，刷新后新 handle 对不上旧展开态，树回到全折叠（VSCode 靠 id 保展开，属已知差异）。

## 坑

- **undefined 过 newline-JSON 变 null**：根拉取 `$getChildren(viewId, undefined)` → host 收到 null → 被 `!== undefined` 判成 stale handle 返回 []，树恒空。修=调用点省略参数 + host 端 `== null` 判根。已登记 extension-host CLAUDE.md 坑 14。
- **空菜单泄漏**：所有条目被 when 门控掉时 ContextMenu 渲染 null 且永不 onClose → scoped context key 泄漏被 expectNoLeaks 抓到。修=openRowMenu 先 `MenuRegistry.getMenuItems(...).length === 0` 则 dispose scoped 不挂状态。
- **行点击双触发**：Tree 的 onClickRow 内置已对叶子触发 onActivate，行 onClick 再手动跑命令会执行两次。命令只挂 onActivate。

## 验证资产

- 单测：`packages/extension-host/src/__tests__/hostTreeViews.test.ts`、`apps/editor/src/renderer/services/extensions/__tests__/TreeViewsService.test.ts`、`apps/editor/src/renderer/workbench/extensionViews/__tests__/ExtensionTreeView.test.tsx`
- e2e：`apps/editor/e2e/specs/smoke.treeView.spec.ts`（@p1 内联 vsix；树渲染/懒展开/命令/刷新 + view/item/context 菜单 when 门控）
