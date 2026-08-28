---
name: commit-changes-view-graph-polish
description: commit changes 侧栏视图与 git/perforce graph 交互打磨（toolbar/焦点/键盘导航/选中同步/延迟修复）的实现要点与坑
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-09T01:27:21.156Z
---

2026-08-08 在 `15163b43`（基于 `a909f62c` 多文件 diff 视图）完成 commit changes 视图与 graph 交互打磨：workspace 切换清空、头部两行化、toolbar（Open in Graph/折叠展开/tree-list 切换持久化）、聚焦命令 `workbench.view.scm.commitChanges.focus`（焦点落点 revealPath→记忆→首文件；空格 preserveFocus 预览/回车聚焦 diff）、graph 键盘导航（↑↓/Home/End/PgUp/PgDn/Ctrl+Enter 菜单+多目标 QuickPick）。

**坑1（reveal 无高亮根因）**：openEditor 同步返回先于 React 提交 tab 切换，桥接命令直调的 `revealCommit` 是即将卸载旧实例的闭包——修法 = reveal 请求写 `pendingReveal` observable，由新挂载实例响应式消费。
**坑2（点击延迟根因）**：onRowClick 的 useCallback 依赖 selection 导致每次点击全表 CommitRow memo 失效重渲染；修法 = selectionRef 稳定回调身份。详情加共享 LRU（graphPayloadCache）+ 点击/跟随共享 latest-wins 序号。
**坑3**：graph 选中静默同步 commit changes 走 payload 加 `silent` 标志（不 openViewContainer）；跟随门槛 = 视图有过 payload。
**坑4**：`a909f62c` 删了 perforce graph 底部详情面板但没更新 `perforceGraphReveal.spec.ts` 的 `#4521 · ` 断言（e2ea 才暴露）——大重构后要 grep e2e spec 里对被删 UI 的文本断言。

共享逻辑集中在 `workbench/scm/commitChanges/{graphFollow,graphPayloadCache}.ts` 与 `workbench/gitGraph/useGraphKeyboardNav.ts`（git/perforce 两编辑器复用）。2026-08-09 起视图交互内核（快照构建/Tree 渲染/折叠信号/焦点记忆/键盘导航）抽到 `workbench/changesTree/`（泛型 ChangesTree，Session Changes 复用同一实现——改这里两视图同时受益）；CommitChangesView 变薄 wrapper，行差异走 describeFile slot。相关 [[dirty-diff-inline-peek-feature]]、[[editor-input-identity-isolation]]、[[session-diff-feature]]。
