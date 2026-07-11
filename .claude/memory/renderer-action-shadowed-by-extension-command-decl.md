---
name: renderer-action-shadowed-by-extension-command-decl
description: "内置扩展里 renderer Action2 命令若同时写进扩展 package.json 的 commands 数组,会被无 handler 的扩展宿主命令静默遮蔽成 no-op"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e9c20cb-08f1-496c-8647-f46e7e1c1af2
---

内置扩展(git/perforce)贡献到 scm/title 菜单、但真正 handler 在 **renderer 的 Action2**(如 `git-graph.view`/`perforce-graph.view`)的命令,**绝不能**再写进扩展 `package.json` 的 `contributes.commands` 数组。

**Why:** `contributes.commands` 会在扩展宿主侧注册一个同名命令。执行时该宿主命令(无 handler)胜出,遮蔽 renderer Action2,`executeCommand` 静默返回 undefined、不抛错,编辑器不打开——极难排查(命令"成功"但什么都没发生)。

**How to apply:** 只在 `contributes.menus`(scm/title 等)里写该命令项,菜单项自带 `icon` 即可显示图标;title/tooltip 由 renderer Action2 的 `title` 提供。参照 git 扩展:`git-graph.view` 只出现在 menus,不在 commands 数组。加 Perforce Graph 时我误把 `perforce-graph.view` 放进了 commands 数组,导致 e2e 里点命令只停在 welcome 页;删掉该 commands 条目后即修复。

排查手法:e2e 里 `getActiveEditorTypeId`/`getActiveGroupEditorCount` 探针对比同结构的 git-graph(count=1 打开)vs perforce-graph(count=0 no-op),快速定位是"命令被吞"而非"组件渲染崩"。

相关:e2e 跑的是 `out/main/index.js` 预构建产物,改 renderer 后必须 `pnpm --filter @universe-editor/editor build` 才生效;改扩展后 `pnpm --filter @universe-editor/perforce build`。另一坑:`getByText('Perforce Graph')` 子串匹配会同时命中标题 span 和 "Perforce Graph is unavailable..." 错误文案触发 strict-mode violation,断言标题要用 `{ exact: true }`。
