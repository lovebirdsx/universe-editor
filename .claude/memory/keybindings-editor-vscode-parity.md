---
name: keybindings-editor-vscode-parity
description: Keyboard Shortcuts 编辑器完整对标 VSCode 的架构与关键坑（虚拟化/搜索语法/浮层录制/负号条目）
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-08T08:43:48.769Z
---

Keyboard Shortcuts 编辑器已完整对标 VSCode（2026-08）：model 与视图分离——`services/keybindings/keybindingsEditorModel.ts`（一次性 O(n) resolve，registry 逆序=precedence 序）+ `keybindingsSearchModel.ts`（@command:/@source:/@ext:/@keybinding:/引号精确 + 修饰键词法匹配）+ `keybindingsEditorRuntime.ts`（Action2 经 handle 操作活动编辑器）；视图 `workbench/keybindings/`（VirtualList 确定性行高 24/40/60、AnchoredSurface 自绘 12 项右键菜单、DefineKeybindingOverlay 浮层 chord≤2、Record Keys、When 内联编辑 + PopoverList 补全）；服务层 `UserKeybindingsService` 新增行级 API（addKeybinding 多键共存 / editKeybinding(target) / removeKeybinding(target)，默认条目自动追加 `-command` 负号条目）。

**Why:** 旧实现全量 `<table>` + 每行 O(registry) 扫描，交互与 VSCode 差距大。

**How to apply:**
- 改该编辑器先读 `keybindingsEditorRuntime.ts` 的 handle 接口；编辑器内快捷键统一 weight 250（WorkbenchContrib+50，压过全局同键，见 [[keybinding-when-not-priority-weight-wins]]）。
- `normalizeKeybindingString` 修饰键按**字母序**（`alt+ctrl+p` 而非 `ctrl+alt+p`），比较/定位条目时必须先归一化。
- workbench-ui 新通用件：`wordMatching.ts`（IMatch 区间匹配原语）/`HighlightedLabel`/`KeybindingLabel`；keybindingLabel.* 颜色未注册，用 input.* 近似替代。
- AnchoredSurface 的 Escape 关闭靠自身 window capture 监听（全局分发器在 document capture 会 stopPropagation 吞事件，Floating UI useDismiss 收不到）——所有浮层同理。
- Define 浮层/录制用 window capture keydown + stopPropagation 即可零泄漏（先于 document 层分发器）。
