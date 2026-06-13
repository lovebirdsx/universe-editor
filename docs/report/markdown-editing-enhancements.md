# Markdown 编辑增强：内核 TextEditor API + 真插件实现

> 撰写日期：2026-06-14
> 实现方式：扩展内核 API（Phase 1）→ 在 `extensions/markdown` 以真插件实现（Phase 2）
> 验证：`pnpm check`（32 任务全绿）、markdown 插件 34 个纯逻辑单测、`pnpm e2e`（91 冒烟全过）

## 一、背景与决策

目标：把 VSCode「Markdown All in One」「Markdown Table」常见的编辑操作引入本编辑器。

核心架构决策（用户已确认）：**「扩展内核 API，真插件实现」**。即不在 app 内置这些功能，而是先给扩展宿主补齐「读写当前文本编辑器」的内核能力，再把所有功能作为 `extensions/markdown` 插件的贡献（commands + keybindings）落地——与 git、语言服务一样，markdown 只是「又一个扩展」。

其它已确认的细节决策：

| 议题 | 决策 |
|---|---|
| 加粗 `Ctrl+B` 与「切换侧栏」冲突 | markdown 文本焦点时归加粗，其它场景归侧栏 |
| 智能回车/Tab 算法来源 | 参考 MAIO 插件行为（其 dist 已压缩不可读，算法从零实现） |
| 图片落盘位置 | 同目录 `assets/` + 时间戳文件名 |
| 表格格式化触发方式 | 命令 + 快捷键手动触发（非保存时自动格式化） |

## 二、范围

### 已交付

| 编号 | 功能 | 命令 ID | 默认快捷键 |
|---|---|---|---|
| A1 | 任务完成切换 `- [ ]`↔`- [x]`（多行批量） | `markdown.editing.toggleTask` | `Alt+C` |
| A2 | 智能回车（自动续写列表标记 / 空项退出列表） | `markdown.editing.onEnter` | `Enter` |
| A3 | 智能 Tab / Shift+Tab（列表缩进/反缩进 + 重排） | `markdown.editing.onTab` / `onShiftTab` | `Tab` / `Shift+Tab` |
| A4 | 有序列表自动重排（随 A2/A3 联动触发） | （内嵌于 A2/A3） | — |
| A5 | 加粗（包裹/反包裹 `**`） | `markdown.editing.toggleBold` | `Ctrl+B` |
| A6 | 表格格式化（列对齐 + 分隔行归一） | `markdown.editing.formatTable` | `Ctrl+Alt+T` |
| B1 | 斜体 `*` | `markdown.editing.toggleItalic` | `Ctrl+I` |
| B2 | 行内代码 `` ` `` | `markdown.editing.toggleInlineCode` | `Ctrl+M` |
| B3 | 删除线 `~~` | `markdown.editing.toggleStrikethrough` | `Alt+S` |
| B4 | 标题级别增减 | `markdown.editing.headingUp` / `headingDown` | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| B5 | 数学公式 `$` | `markdown.editing.toggleMath` | `Ctrl+Shift+M` |
| B6 | 表格内 Tab 跳格（末格自动追加新行） | （内嵌于 `onTab`/`onShiftTab`） | `Tab` / `Shift+Tab` |

### 被阻塞（未交付）

| 编号 | 功能 | 阻塞原因 |
|---|---|---|
| B7 | 粘贴链接自动套住选中文本 | 内核缺剪贴板读取 + 粘贴事件钩子 API |
| C1 | 图片粘贴/拖拽落盘到 `assets/` | 同上（需读剪贴板二进制图片 + 拦截 paste/drop） |

详见 [§六 后续扩展](#六后续扩展b7--c1)。

## 三、内核改动（Phase 1：新增 TextEditor API）

为了让扩展宿主能「读当前编辑器内容/选区」并「写回编辑（作为单次 undo）+ 设置选区」，新增了一条 `mainThreadEditor` RPC 通道及配套类型。该能力划为 **trusted host 专属**（与 languages、scm 同级），外部受限扩展拿不到。

坐标系：扩展 API 全程 LSP 风格 **0-based**（`Position`/`Range`）；渲染端 handler 内部转换为 Monaco 的 1-based。

### 改动文件

| 文件 | 改动 |
|---|---|
| `packages/extensions-common/src/rpc.ts` | 新增 `ExtHostChannels.mainThreadEditor`；新增 DTO：`ITextEditDto`/`ISelectionDto`/`IActiveTextEditorDto`/接口 `IMainThreadEditor`。`IActiveTextEditorDto` 携带 `text` 字段，使「内容快照 + 选区」版本一致（文档同步是防抖的，可能滞后） |
| `apps/editor/src/renderer/services/extensions/MainThreadEditor.ts`（新增） | 渲染端 handler。`$getActiveTextEditor` 返回快照；`$applyEdits` 校验 `version` 不符则返回 false，再 `editor.executeEdits` 应用（0-based→1-based）；`$setSelections` 设置并 reveal |
| `apps/editor/src/renderer/services/extensions/HostConnection.ts` | 注入可选 `editorService`，注册 `mainThreadEditor` 通道 |
| `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` | 注入 `IEditorService`，仅 trusted host 传入 `editorService` |
| `packages/extension-host/src/bootstrap.ts` | 取 `mainThreadEditor` 通道并注入 `ExtensionService` |
| `packages/extension-host/src/extensionService.ts` | 新增 `HostTextEditor`（实现 `TextEditor`：`edit()` 构造 DTO 调 `$applyEdits`、`setSelections()`、选区映射）+ `getActiveTextEditor()` 桥接方法 |
| `packages/extension-api/src/index.ts` | 新增公开类型 `Selection`/`TextEditorEdit`/`TextEditor`；`window.getActiveTextEditor()` |
| `packages/extension-host/src/apiFactory.ts` | `IExtensionHostBridge` 增加 `getActiveTextEditor()` |

### suggestWidgetVisible 上下文键桥接

智能回车/Tab 绑定权重为 `ExternalExtension`(400)，会拦截 `Enter`/`Tab`。但补全弹窗可见时，这两个键应交给「接受补全」。Monaco 把 `suggestWidgetVisible` 关在自己的 scoped context-key service 里，全局键处理器看不到，故需镜像到全局：

| 文件 | 改动 |
|---|---|
| `apps/editor/src/renderer/contributions/ContextKeyContribution.ts` | 创建全局 `suggestWidgetVisible` 键 |
| `apps/editor/src/renderer/services/editor/editorFocus.ts` | 新增 `bridgeSuggestWidgetVisible()`：订阅 `SuggestController.model` 的 `onDidSuggest`/`onDidCancel`，更新全局键。对不含 `getContribution` 的 mock editor 做了空守卫 |
| `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` | 挂载时调用 `bridgeSuggestWidgetVisible`，卸载时 dispose |

## 四、插件实现（Phase 2：`extensions/markdown`）

所有逻辑落在 `extensions/markdown/src/edit/` 下，纯函数 core 与命令注册层分离，便于单测。

### 文件结构

```
extensions/markdown/src/edit/
  textEditing.ts     共享原语：Position/Range/Selection 构造、activeMarkdown()（取当前 md 编辑器并按行切分）、
                     applyResult()（把 EditResult 作为单次 undo 应用 + 设置选区）
  toggleDelimiter.ts 对称定界符切换（** * ` ~~ $）：选区包裹/反包裹、词级切换、空对插入定位
  heading.ts         changeHeadingLevel：ATX 标题级别 +1/-1（封顶 6、降到 0 去标题）
  task.ts            toggleTask：GFM 任务复选框批量切换（首个可勾选行决定整块目标态）
  listModel.ts       parseListMarker/renderPrefix/isEmptyItem：列表行解析
  renumber.ts        renumberOrderedLists：有序列表按缩进层级连续重排（空行/降级断流，嵌套独立计数）
  smartList.ts       computeSmartEnter / computeIndent / computeOutdent：智能回车/缩进（返回 'default' 表示回退默认行为）
  table.ts           findTableAt / formatTable / navigateTable：GFM 表格定位、列对齐、Tab 跳格（CJK 宽字符按 2 列宽计算）
  commands.ts        命令注册层：取 activeMarkdown() → 调 core → applyResult()
  __tests__/editing.test.ts  34 个纯逻辑单测
```

入口接线：`extension.ts` 的 `activate()` 末尾调 `registerEditingCommands(context)`。插件 `activationEvents` 已含 `onLanguage:markdown`，即打开 md 文件即激活，先于任何按键。

### 命令/快捷键贡献

`extensions/markdown/package.json` 的 `contributes.commands` + `contributes.keybindings`。统一 `when`：

```
editorTextFocus && editorLangId == markdown
```

回车/Tab 额外加 `!suggestWidgetVisible`。所有贡献键经 `ExtensionPointTranslator` 以 `KeybindingWeight.ExternalExtension`(400) 注册。

### 关键设计点

- **回退机制**：全局键处理器对「胜出绑定」会 `preventDefault`，因此智能回车/Tab 命令在「不在列表/表格」时必须自己重放默认行为——`onEnter` 回退插入 `\n`，`onTab` 回退插入 `INDENT_UNIT`（2 空格，与 `FileEditor` 的 `tabSize:2,insertSpaces:true` 一致），`onShiftTab` 无意义则不操作。
- **缩进单位**：`INDENT_UNIT = '  '`（2 空格）。
- **A4 联动**：`smartList.ts` 在结构性编辑后调 `renumberOrderedLists` 合并重排编辑，回车续写/Tab 缩进都会顺带把有序号刷正确。
- **表格宽字符**：`table.ts` 的 `cellWidth` 把 CJK/全角/emoji 记为 2 列宽，等宽字体下对齐才正确。

## 五、冲突与取舍

| 键 | 原归属 | 冲突解决 |
|---|---|---|
| `Ctrl+B` | `workbench.action.toggleSidebarVisibility`（WorkbenchContrib=200） | markdown 焦点时插件(400)胜出 → 加粗；其它场景仍切侧栏 |
| `Alt+S` | `workbench.action.agent.switchSession`（WorkbenchContrib=200） | markdown 焦点时插件(400)胜出 → 删除线；其它场景仍切会话 |

权重表（`packages/platform/src/command/keybindingRegistry.ts`）：
`EditorCore=0 < MonacoDefault=50 < EditorContrib=100 < WorkbenchContrib=200 < BuiltinExtension=300 < ExternalExtension=400 < User=1000`。

> 注：这是「同键多绑定、带 `when` 门控」的预期行为。若希望某键在 markdown 下仍归原 workbench 命令，删掉该条插件 keybinding 即可。

## 六、后续扩展：B7 / C1

B7（粘贴链接套选中）与 C1（图片落盘）**当前无法以插件形式实现**，因为内核没有任何剪贴板/粘贴事件 API：扩展宿主既读不到剪贴板（文本或二进制图片），也收不到编辑器的 paste/drop 事件钩子。

要遵循「真插件实现」原则，需先再扩一层内核能力（与本次 TextEditor API 同思路）：

1. **粘贴/拖放事件钩子**：让插件能拦截并改写 paste/drop 行为（类似 VSCode `DocumentPasteEditProvider` / `DocumentDropEditProvider`）。
2. **剪贴板读取 API**：文本 + 二进制图片（`env.clipboard.readText()` / 读图像）。

有了这两项后，B7/C1 才能作为 `extensions/markdown` 的贡献落地。图片落盘还要复用已有的 gated `workspace.fs` 写 `assets/`（路径策略禁止逃逸工作区根、禁 `.ssh/.aws/.env`）。

## 七、验证与复测指引

```bash
pnpm check                              # lint + typecheck + test，全绿
pnpm --filter @universe-editor/markdown test   # 34 个纯逻辑单测
pnpm e2e                                # 91 冒烟全过（输出多，建议只看错误）
```

> CLAUDE.md 约定：改 platform/扩展宿主后，apps 看到的是 `dist/`。非 dev 模式下需手动 `pnpm build` 或 `pnpm --filter <pkg> build`，否则 apps 仍用旧产物。markdown 插件改后跑 `pnpm --filter @universe-editor/markdown build`（esbuild 打包到 `dist/extension.js`）。

### 手动验证清单（在打开的 .md 文件中）

- 选中文字按 `Ctrl+B`/`Ctrl+I`/`Ctrl+M`/`Alt+S`/`Ctrl+Shift+M` → 对应定界符包裹；再按一次 → 反包裹
- 空选区放在词上按上述键 → 词级切换；放在空白处 → 插入空对、光标居中
- `Ctrl+Shift+]`/`[` → 标题级别增减
- 列表行 `Alt+C` → 任务复选框切换（多行选区批量）
- 列表项末尾回车 → 自动续写标记；有序列表自动 +1；空列表项回车 → 退出列表
- 列表项 `Tab`/`Shift+Tab` → 缩进/反缩进，有序号自动重排
- 光标置于 GFM 表格内 `Ctrl+Alt+T` → 列对齐；表格内 `Tab`/`Shift+Tab` → 单元格跳格，末格 Tab 追加新行
- 补全弹窗可见时回车/Tab → 接受补全（不被智能列表拦截）

### 调整指引

- **改快捷键**：编辑 `extensions/markdown/package.json` 的 `contributes.keybindings`
- **改算法**：改 `extensions/markdown/src/edit/*.ts` 纯函数 core，对应单测在 `__tests__/editing.test.ts`
- **改缩进宽度**：`smartList.ts` 的 `INDENT_UNIT`
- **新增编辑命令**：在 `edit/` 加 core → 在 `commands.ts` 的 `MARKDOWN_COMMANDS` 注册 → 在 `package.json` 加 command + keybinding
