# apps/editor/src/renderer/services/keybindings/CLAUDE.md

Keyboard Shortcuts 编辑器（对标 VSCode `keybindingsEditor`）的 **model 层**在本目录，**视图层**在 `workbench/keybindings/`——两者是同一个子系统，处理「快捷键编辑器」任务前通读本文。

分工：本目录是**纯逻辑 + 数据源**（行模型、查询解析、用户映射服务、活动编辑器句柄），`workbench/keybindings/` 是**渲染与交互**（虚拟表格、右键菜单、Define/Record 浮层、when 内联编辑）。

## 本目录

| 文件 | 职责 |
|---|---|
| `keybindingsEditorModel.ts` | 行模型。`collectKeybindingModelDeps` 从活 registry 拍一份快照（平台键位 + Monaco 默认键 + 命令元数据 + 用户条目），`resolveKeybindingEntries` 一次性 **O(n) resolve** 出全部行——registry 的**逆序遍历即 precedence 序**，表格行序与运行期解析顺序天然一致。纯函数，不吃 DI。 |
| `keybindingsSearchModel.ts` | 查询解析 + 行过滤。语法 `@command:` / `@source:` / `@ext:` / `@keybinding:`（值带引号 = 精确匹配）+ 文本 fuzzy/word 匹配；匹配跑在 registry 键空间（`row.keybinding` 已归一化）。纯函数。 |
| `keybindingsEditorRuntime.ts` | 活动编辑器句柄注册表：`registerKeybindingsEditor` / `getActiveKeybindingsEditor`（多实例时后注册者胜，dispose 回退上一个）。Action2 经 `IKeybindingsEditorHandle` 操作活动编辑器，不伸进 React 树。 |
| `UserKeybindingsService.ts` | 用户键盘映射的三层汇入点 + **行级 API**：`addKeybinding`（只追加，不碰该命令其它条目）/ `editKeybinding(target)` / `removeKeybinding(target)`；user 层删除会自动追加 `-command` 负号条目。分层、命令存在性过滤、诊断见 skill `fix-keybinding-not-firing`。 |
| `knownContextKeys.ts` | `when` 内联补全的候选键集合——三源并集：keybinding when 引用的键 / 菜单 when 引用的键 / contribution 静态 seed 的键。 |
| `buildKeybindingsJsonSchema.ts` | keybindings.json 的 JSON schema（编辑用户键位文件时的补全与校验）。 |

## 视图层（`workbench/keybindings/`）

`KeybindingsEditor.tsx` 是壳（搜索框 + 工具条 Record Keys / Sort by Precedence / Clear + 浮层编排，挂载时把 handle 注册进 runtime）；`KeybindingsTable.tsx` 走 `VirtualList` 虚拟化，**行高 24 / 40 / 60 三档**由 `estimateRowSize` 决定（命中命令 id / 默认标题 / 扩展名就多一行信息，对标 VSCode 同名的 Delegate）；`KeybindingsContextMenu.tsx` 是 workbench-ui `ListMenu` 的薄包装，动作走编辑器 handle 而非全局命令；`DefineKeybindingOverlay.tsx` 是 Define 浮层（chord ≤ 2 段）；`WhenInputCell.tsx` 内联编辑 when 表达式，补全走 `PopoverList` + `knownContextKeys.ts`。

## 规范：浮层自己要用键，必须 window capture 先手

在浮层里录制/捕获按键（Define 浮层的 getKeybinding、Record Keys）必须用 **`window` capture 的 keydown + `stopPropagation()` / `preventDefault()`**，让事件在到达全局面之前就被本浮层消费。

原因：全局键盘分发器是 `workbench/useGlobalKeybindingHandler.ts` 的**单个 document capture 监听器**，命中的键在那里就被吞掉，浮层（Floating UI / React，都在更晚的阶段）根本收不到。同源的先例：workbench-ui `overlay/AnchoredSurface.tsx` 的 Escape 关闭、`useOverlayListNavigation` 的 Ctrl+P/N/H/L 别名——都靠 window capture 抢到键；反过来，React `onKeyDown` 或 document 层监听在这类场景一律失效。

## 常见任务

- **改表格/搜索行为**：先改 model 的纯函数（`resolveKeybindingEntries` / 查询解析），再动 `workbench/keybindings/` 的渲染。
- **加编辑器内快捷键**：`actions/keybindingsEditorActions.ts`（`registerAction2`）+ 需要新动作时扩 `IKeybindingsEditorHandle`。
- **定位/断言某条键位**：`normalizeKeybindingString` 的修饰键按**字母序**（规范形是 `alt+ctrl+p` 而不是 `ctrl+alt+p`）——比较、查条目、写探针前必须先归一化。

## 验证

- 单测：`apps/editor/src/renderer/services/keybindings/__tests__/`（行模型 / 查询解析 / UserKeybindingsService / knownContextKeys）与 `workbench/keybindings/__tests__/`（编辑器壳 / Define 浮层 / when 内联编辑）。
- 注册期判别、e2e 守护与三层语义细节见 skill `fix-keybinding-not-firing`。
