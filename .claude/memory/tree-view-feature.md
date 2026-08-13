# Tree View 功能（contributes.views + TreeDataProvider）

> 阶段一（manifest 贡献点 + 占位组件）与阶段二（RPC 数据链路 + 真树渲染 + 菜单 + e2e）均已落地。对标 VSCode MainThreadTreeViews/ExtHostTreeViews 的首版裁剪实现。

## 链路一图

```
manifest contributes.viewsContainers/views → ExtensionPointTranslator._registerViews
  （componentKey=EXTENSION_TREE_VIEW_COMPONENT_KEY；MENU_ID_BY_KEY 含 view/item/context）
ExtensionTreeView.tsx（按 viewId props 分发；mount 发 onView:<viewId> 激活）
  ⇅ mainThreadTreeViews（注册/$refresh）/ extHostTreeViews（$getChildren/selection/expansion/visibility/$executeTreeItemCommand）
renderer services/extensions/TreeViewsService.ts（按页 DTO 缓存 + per-page epoch 防 stale）
  ⇅
host HostTreeViewRegistry（三级稳定身份 + element↔handle 双向表 + commandByHandle；
  onDidChangeTreeData → 50ms debounce → $refresh(viewId, items?) 整树/子树失效）
```

## 关键决策

- **拉取式懒加载**：renderer 只拉用户展开的节点；TreeModel 的 `getChildren` 返回 null 触发 `loadChildren` → RPC。workbench-ui Tree/TreeModel 全部复用，未新写树基建。
- **handle 跨刷新稳定（三级身份）**：`TreeItem.id` → 元素对象本身（仍在同一页时）→ 父**句柄**下的 label（`/` 转义 `//`，同名兄弟 `~n`）。子节点 key 挂父 handle 而非父 key 字符串——否则父改名会连带作废整棵子树身份。handle 只在元素不再从父 `getChildren` 回来时回收（连缓存子树一起），既保展开态又给 handle 表封顶。
- **首版裁剪**：无 reveal/DnD/checkbox/badge/TreeView.title；iconPath 仅 codicon 名；getParent 不消费。JSDoc 均已注明。
- **命令参数解析在 host 侧**：行点击与 view/item/context 菜单都走 `$executeTreeItemCommand(viewId, handle, commandId?)`——host 按 handle 反查 element/原始 `TreeItem.command`，经 `ExtensionCommandRegistry.execute` 路由（本地 handler 拿活引用；查不到则既有 `_workbench.*/allowlist` 兜底转发 renderer）。`command.arguments` 不上 wire（DTO 只带命令 id/title/tooltip/disabled），handler 收到的是扩展自己返回的原对象；`command` 不带 `arguments` 时 handler 收到该行 element（vscode 契约）。renderer 侧禁 revive 鸭子类型。**注意**：scm/timeline 的 `toCommandDto` 刻意保留 arguments（ScmView `commandArgs()` 与 TimelineView `runItem` 真实消费），三份已收敛为 `hostHandles.ts` 的 `toCommandDto(cmd, fields)`，字段由调用点声明。
- **展开态跨刷新保留**：`onDidChangeTreeData(element)` 只失效该子树（行就地替换 + 只丢它的 children 页），无参为整树失效；视图侧 `onDidChangeView` 对仍展开但页被丢的行补拉（不发展开事件，保「展开事件只由用户交互触发」）。

## 坑

- **undefined 过 newline-JSON 变 null**：根拉取 `$getChildren(viewId, undefined)` → host 收到 null → 被 `!== undefined` 判成 stale handle 返回 []，树恒空。修=调用点省略参数 + host 端 `== null` 判根。已登记 extension-host CLAUDE.md 坑 14。
- **空菜单泄漏**：所有条目被 when 门控掉时 ContextMenu 渲染 null 且永不 onClose → scoped context key 泄漏被 expectNoLeaks 抓到。修=openRowMenu 先 `MenuRegistry.getMenuItems(...).length === 0` 则 dispose scoped 不挂状态。
- **行点击双触发**：Tree 的 onClickRow 内置已对叶子触发 onActivate，行 onClick 再手动跑命令会执行两次。命令只挂 onActivate。
- **epoch 归零致 stale 复活**：renderer 按页记 epoch 防在途拉取覆盖新数据；settle 时若删掉 epoch 条目，计数器归零，更老的在途拉取比对相等后把已失效的行「复活」。修=epoch 单调递增、永不删除，只在该页有 in-flight 拉取时记账。
- **label 派生身份塌陷改名行**：身份若只按 label 算，改名 = 新 key = 新 handle = 展开态丢失；且子 key 若嵌父 key 字符串会级联作废整棵子树。故加「元素对象同页复用」这一级并把子 key 挂父 handle。

## 验证资产

- 单测：`packages/extension-host/src/__tests__/hostTreeViews.test.ts`、`apps/editor/src/renderer/services/extensions/__tests__/TreeViewsService.test.ts`、`apps/editor/src/renderer/workbench/extensionViews/__tests__/ExtensionTreeView.test.tsx`
- e2e：`apps/editor/e2e/specs/smoke.treeView.spec.ts`（@p1 内联 vsix；树渲染/懒展开/命令/刷新 + view/item/context 菜单 when 门控）
