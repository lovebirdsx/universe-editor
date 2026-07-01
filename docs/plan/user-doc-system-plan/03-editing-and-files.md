# 03 · 编辑与文件（Editing & Files）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**日常编辑主场**。覆盖资源管理器文件操作、多标签分屏、Markdown 编辑与预览、编号书签、大纲导航、内联 AI 补全六个子域。
> 依赖：[00-foundation.md](./00-foundation.md)（路径约定、加载机制、写作规范、术语表）
> 里程碑：M2

---

## 目录

- [1. 目标](#1-目标)
- [2. 读者与前置](#2-读者与前置)
- [3. 信息架构](#3-信息架构)
- [4. 逐页要点](#4-逐页要点)
- [5. 链接与交叉引用](#5-链接与交叉引用)
- [6. 本册注意事项](#6-本册注意事项)
- [7. 执行步骤](#7-执行步骤)
- [8. 验收标准](#8-验收标准)

---

## 1. 目标

让游戏内容创作者能高效管理项目文件、在多文件之间流畅切换、用 Markdown 写策划文档并即时预览、用编号书签记住关键位置、借助大纲快速跳转内部结构、用内联补全加速文本输入。六个子域之间有明确互链，读者按需取用，不必通读全册。

---

## 2. 读者与前置

- **读者**：已完成快速上手（01 册）的游戏内容创作者，能打开项目、知道命令面板是什么。
- **不预设**：懂编程、熟悉 Git、了解 Markdown 语法（相关页面在首次出现时做一句话说明）。
- **前置依赖**：00-foundation 的加载机制打通后本册才能在应用内渲染；内联补全页有一条"需先配置模型"的前置说明，链到 06 册的 AI 供应商页。

---

## 3. 信息架构

| 相对 `docs/user/zh-CN/` 的文件路径 | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `editing/explorer-and-files.md` | 资源管理器与文件操作 | 新建/重命名/删除/复制/移动/保存/路径复制/系统显示/刷新 | `fileCreateActions.ts`、`fileMutateActions.ts`、`fileClipboardActions.ts`、`fileCopyActions.ts`、`fileSaveActions.ts`、`fileOpenActions.ts`、`revealActions.ts` |
| `editing/tabs-and-split.md` | 标签页与分屏 | 切换/关闭标签、重新打开、分屏、组焦点与移动编辑器、换行与小地图 | `editorActions.ts`、`editorResolverActions.ts` |
| `editing/markdown.md` | Markdown 编辑与预览 | 源码与预览切换、格式命令、预览内查找、键盘链接导航 | `markdownActions.ts`、`extensions/markdown/package.json` |
| `editing/bookmarks.md` | 编号书签 | 0–9 号书签切换/跳转、列出与清空、gutter 图标、配置项 | `extensions/numbered-bookmarks/package.json` |
| `editing/outline.md` | 大纲视图 | 大纲视图位置与激活、按符号结构快速导航 | `BuiltInViewContainersContribution.ts`（`workbench.view.outline`，次侧栏）、`layoutActions.ts`（`FocusOutlineAction`） |
| `editing/inline-completion.md` | 内联补全（幽灵文本） | 触发/接受/跳到下一处/开关/选择补全模型 | `inlineCompletionActions.ts` |

---

## 4. 逐页要点

### 4.1 资源管理器与文件操作 (`explorer-and-files.md`)

**讲什么**：资源管理器（侧栏第一个标签页，`workbench.view.explorer`）中对文件和文件夹的全部日常操作，以及保存和路径复制等编辑区配套操作。

**任务导向要点**

- 新建无标题文件：`Ctrl+N` / 命令面板"新建文件"（`workbench.action.files.newUntitledFile`）；直接在编辑区打开，未保存时保存会弹另存为
- 在资源管理器中新建文件：命令面板"新建文件…"（`workbench.files.action.newFile`）；需先在资源管理器中选中父文件夹，或右键菜单触发
- 新建文件夹：命令面板"新建文件夹…"（`workbench.files.action.newFolder`）
- 重命名：选中文件后按 `F2` 或命令面板"重命名…"（`workbench.files.action.rename`）
- 删除：选中文件后按 `Delete` 或命令面板"删除"（`workbench.files.action.delete`）；会弹确认对话框
- 剪切/复制/粘贴：在资源管理器焦点下 `Ctrl+X` / `Ctrl+C` / `Ctrl+V`（命令 `filesExplorer.cut` / `filesExplorer.copy` / `filesExplorer.paste`）
- 复制副本：命令面板"复制副本…"（`workbench.files.action.duplicate`）；弹出命名对话框
- 移动到其他目录：命令面板"移动…"（`workbench.files.action.move`）；弹出系统目录选择器
- 复制文件路径：命令面板"复制路径"（`copyFilePath`），或标签页右键菜单
- 复制文件名：命令面板"复制名称"（`workbench.files.action.copyName`）
- 复制相对路径：命令面板"复制相对路径"（`copyRelativeFilePath`）；相对工作区根目录
- 在系统资源管理器中显示：`Alt+Shift+E` / 命令面板"打开所在文件夹"（`workbench.files.action.revealInOsExplorer`）
- 在资源管理器树中定位当前文件：命令面板"在资源管理器中定位当前文件"（`workbench.files.action.revealActiveFileInExplorer`）
- 保存：`Ctrl+S` / 命令面板"保存"（`workbench.action.files.save`）
- 另存为：`Ctrl+Shift+S` / 命令面板"另存为…"（`workbench.action.files.saveAs`）
- 全部保存：`Ctrl+Alt+S` / 命令面板"保存全部"（`workbench.action.files.saveAll`）；注意 i18n 原文是"Save All"，zh-CN.ts 无对应条目，待核实显示文字
- 使用默认应用打开：命令面板"使用默认应用打开"（`workbench.files.action.openWithDefaultApp`）；此命令 `f1: false`，仅通过右键菜单触发
- 刷新资源管理器：命令面板"刷新资源管理器"（`workbench.files.action.refresh`）

**涉及命令与快捷键**（代码核实完毕）

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 新建无标题文件 | `workbench.action.files.newUntitledFile` | `Ctrl+N`（非终端焦点时） |
| 重命名 | `workbench.files.action.rename` | `F2` |
| 删除 | `workbench.files.action.delete` | `Delete` |
| 剪切（资源管理器） | `filesExplorer.cut` | `Ctrl+X`（资源管理器焦点） |
| 复制（资源管理器） | `filesExplorer.copy` | `Ctrl+C`（资源管理器焦点） |
| 粘贴（资源管理器） | `filesExplorer.paste` | `Ctrl+V`（资源管理器焦点且有剪贴板内容） |
| 打开所在文件夹 | `workbench.files.action.revealInOsExplorer` | `Alt+Shift+E` |
| 保存 | `workbench.action.files.save` | `Ctrl+S` |
| 另存为 | `workbench.action.files.saveAs` | `Ctrl+Shift+S` |
| 全部保存 | `workbench.action.files.saveAll` | `Ctrl+Alt+S` |

**建议截图占位**

- `<!-- 截图：资源管理器右键菜单（展示新建/重命名/删除/复制/移动等项） -->`
- `<!-- 截图：另存为对话框 -->`

**互链去向**

- 前置：[快速上手 · 界面导览](../getting-started/interface-tour.md)
- 延伸：[标签页与分屏](./tabs-and-split.md)、[版本控制 · 提交改动](../git/commit.md)

---

### 4.2 标签页与分屏 (`tabs-and-split.md`)

**讲什么**：编辑区的多标签管理、关闭策略、历史恢复、分屏布局、编辑器组焦点与编辑器移动，以及两个视图辅助开关。

**任务导向要点**

- 切换标签：`Ctrl+PageDown`（下一个，"打开下一个编辑器"）/ `Ctrl+PageUp`（上一个，"打开上一个编辑器"）
- 最近使用历史切换（MRU）：`Ctrl+Tab` / `Ctrl+Shift+Tab`（快速选择器 + 键盘导航）
- 关闭当前标签：`Ctrl+W` / 命令面板"关闭编辑器"（`workbench.action.closeActiveEditor`）
- 关闭其他标签：`Alt+W` / 命令面板"关闭其他编辑器"（`workbench.action.closeOtherEditors`）
- 关闭右侧标签：`Alt+A` / 命令面板"关闭右侧编辑器"（`workbench.action.closeEditorsToTheRight`）
- 关闭左侧标签：命令面板"关闭左侧编辑器"（`workbench.action.closeEditorsToTheLeft`）；**无快捷键**
- 关闭已保存的标签：命令面板"关闭已保存的编辑器"（`workbench.action.closeUnmodifiedEditors`）
- 关闭组内所有标签：命令面板"关闭组内所有编辑器"（`workbench.action.closeEditorsInGroup`）
- 关闭所有标签：命令面板"关闭所有编辑器"（`workbench.action.closeAllEditors`）
- 重新打开已关闭的编辑器：`Ctrl+Shift+T` / 命令面板"重新打开已关闭的编辑器"（`workbench.action.reopenClosedEditor`）
- 向右分屏：`Ctrl+\` / 命令面板"向右拆分编辑器"（`workbench.action.splitEditorRight`）
- 向下分屏：命令面板"向下拆分编辑器"（`workbench.action.splitEditorDown`）；无快捷键
- 向左分屏：命令面板"向左拆分编辑器"（`workbench.action.splitEditorLeft`）；无快捷键
- 向上分屏：命令面板"向上拆分编辑器"（`workbench.action.splitEditorUp`）；无快捷键
- 聚焦下一个组：`Alt+0` / 命令面板"聚焦下一个组"（`workbench.action.focusNextGroup`）
- 聚焦上一个组：`Alt+9` / 命令面板"聚焦上一个组"（`workbench.action.focusPreviousGroup`）
- 方向聚焦组（四向）：`Ctrl+K Ctrl+Left/Right/Up/Down`（"Focus Left/Right/Above/Below Editor Group"）
- 将编辑器移动到方向组：`Ctrl+K Ctrl+Shift+Left/Right/Up/Down`
- 以其他方式重新打开：命令面板"重新打开方式..."（`workbench.action.reopenWith`）；弹快速选择器选择编辑器类型
- 切换自动换行：`Alt+Z` / 命令面板"切换自动换行"（`editor.action.toggleWordWrap`）
- 切换小地图：命令面板"切换小地图"（`editor.action.toggleMinimap`）；无快捷键

**建议截图占位**

- `<!-- 截图：分屏后的双栏编辑界面 -->`
- `<!-- 截图：Ctrl+Tab 弹出的最近使用编辑器快速选择器 -->`

**互链去向**

- 上一页：[资源管理器与文件操作](./explorer-and-files.md)
- 下一页：[Markdown 编辑与预览](./markdown.md)
- 相关：[大纲视图](./outline.md)（在次侧栏辅助导航）

---

### 4.3 Markdown 编辑与预览 (`markdown.md`)

**讲什么**：写游戏策划文档时的 Markdown 工作流——格式命令、源码与渲染预览切换、预览内查找和键盘链接导航。对游戏内容创作者是高频功能，需要写扎实。

**任务导向要点**

- **一句话说明 Markdown**：轻量标记语言，`**粗体**`、`# 标题`、`- 列表`，Universe Editor 可即时渲染预览
- 打开预览（替换当前标签）：`Ctrl+Shift+V` / 命令面板"打开预览"（`workbench.action.markdown.openPreview`）；仅当当前文件是 `.md` 时可用
- 在侧边打开预览（保留源码标签）：`Ctrl+K Ctrl+V` / 命令面板"在侧边打开预览"（`workbench.action.markdown.openPreviewToSide`）
- 从预览切回源码：预览标签页上方按钮"打开源文件"（`workbench.action.markdown.showSource`，`Ctrl+Shift+V` 在预览焦点时）
- **格式命令**（均需编辑器文本焦点，文件语言为 markdown）：
  - 加粗：`Ctrl+B`（`markdown.editing.toggleBold`）
  - 斜体：`Ctrl+I`（`markdown.editing.toggleItalic`）
  - 行内代码：`Ctrl+M`（`markdown.editing.toggleInlineCode`）
  - 删除线：命令面板"Toggle Strikethrough"（`markdown.editing.toggleStrikethrough`）；**无快捷键**
  - 数学公式：`Ctrl+Shift+M`（`markdown.editing.toggleMath`）
  - 升级标题：`Ctrl+Shift+]`（`markdown.editing.headingUp`，"Increase Heading Level"）
  - 降级标题：`Ctrl+Shift+[`（`markdown.editing.headingDown`，"Decrease Heading Level"）
  - 切换任务勾选：`Alt+C`（`markdown.editing.toggleTask`，"Toggle Task Completion"）
  - 格式化表格：`Ctrl+Alt+T`（`markdown.editing.formatTable`，"Format Table"）
  - 整理链接定义：命令面板"Organize Link Definitions"（`markdown.organizeLinkDefinitions`）；**无快捷键**
- 说明：`Enter`/`Tab`/`Shift+Tab` 在 Markdown 编辑模式下被扩展接管（列表缩进等），不需要用户手动触发
- 预览内查找：预览获得焦点后按 `Ctrl+F` / 命令面板"在预览中查找"（`workbench.action.markdownPreview.find`）；`F3`/`Shift+F3` 上下查找，`Escape` 关闭
- 键盘链接导航（link hints，vimium 式）：预览获得焦点后按 `F`（"Show Link Hints"，`workbench.action.markdownPreview.linkHints`），字母标签覆盖所有可见链接，输入标签字母后跟随链接；`Shift+F` 在侧边打开（"Show Link Hints (to Side)"）；`?` 显示快捷键说明（"Keyboard Shortcuts"）
  - 注意：这三个命令在 zh-CN.ts 中**尚无中文条目**，命令面板显示英文 title，属待本地化项

**建议截图占位**

- `<!-- 截图：Markdown 源码（左）与渲染预览（右）的并排分屏 -->`
- `<!-- 截图：预览内的 link hints 字母标签覆盖效果 -->`
- `<!-- 截图：格式化表格前后对比 -->`

**互链去向**

- 上一页：[标签页与分屏](./tabs-and-split.md)
- 延伸：[编号书签](./bookmarks.md)（搭配书签标记重要段落）、[大纲视图](./outline.md)（借助标题符号跳转）
- 相关术语：[术语表 · Markdown](../reference/glossary.md)（如有）

---

### 4.4 编号书签 (`bookmarks.md`)

**讲什么**：Delphi 风格的 0–9 号编号书签——用快捷键给任意行打上编号标记，之后随时一键跳回，跨文件管理关键位置。对游戏内容创作者（大型策划表、对话树文件）是高频需求。

**任务导向要点**

- 原理一句话：每个数字（0–9）对应一个书签槽，同一编辑器内唯一；再次切换即清除
- 打 / 清除编号书签：`Ctrl+Shift+<数字>` 切换对应书签（`numberedBookmarks.toggleBookmark0`…`9`）；再按一次清除
- 跳转到编号书签：`Ctrl+<数字>` 跳转（`numberedBookmarks.jumpToBookmark0`…`9`）；书签所在文件会自动打开
- 列出所有书签：命令面板"List Bookmarks"（`numberedBookmarks.list`）；弹快速选择器，选中跳转
- 清空全部书签：命令面板"Clear All Bookmarks"（`numberedBookmarks.clear`）
- gutter 图标：已设书签的行号区域显示带数字的彩色圆形图标（颜色可配置）
- 编辑粘附：插入/删除行时书签位置自动跟随，不会错位
- 配置项：
  - `numberedBookmarks.gutterIconFillColor`（默认 `#0070e0`）：gutter 图标填充色
  - `numberedBookmarks.gutterIconNumberColor`（默认 `#ffffff`）：gutter 图标数字色

**完整快捷键表**（代码核实，共 20 个）

| 操作 | 快捷键 |
|---|---|
| 切换书签 0–9 | `Ctrl+Shift+0` … `Ctrl+Shift+9` |
| 跳转书签 0–9 | `Ctrl+0` … `Ctrl+9` |

注意：`Ctrl+0`–`Ctrl+9` 在编辑器文本焦点时生效（`when: editorTextFocus`）；无文本焦点时数字键可能触发其他操作。

**建议截图占位**

- `<!-- 截图：gutter 区域的书签图标（多行，带不同数字） -->`
- `<!-- 截图：List Bookmarks 快速选择器 -->`

**互链去向**

- 上一页：[Markdown 编辑与预览](./markdown.md)
- 下一页：[大纲视图](./outline.md)
- 相关：[设置 · 修改颜色](../customization/settings.md)（调整书签图标颜色）

---

### 4.5 大纲视图 (`outline.md`)

**讲什么**：次侧栏中的"大纲"视图（`workbench.view.outline`）——按文件的符号结构（Markdown 标题、代码函数、类等）展示层级树，点击即跳转。重点讲 Markdown 文件的标题树用法。

**任务导向要点**

- 位置：次侧栏（编辑区右侧面板）的"大纲"标签页（`Outline`，i18n 中文为"大纲"）
- 打开方式：`Ctrl+Shift+Q` / 命令面板"聚焦大纲视图"（`outline.focus`）；若次侧栏未展开会自动展开
- Markdown 文件：大纲显示各级标题树（`#`/`##`/`###`…），点击标题跳转到对应行
- 快速导航大型文档：结合书签（标记目标行）+ 大纲（快速跳章节）工作流
- 排序与筛选：大纲视图顶部可按位置/名称排序（具体 UI 以实际界面为准）

**建议截图占位**

- `<!-- 截图：次侧栏展开，大纲视图显示 Markdown 文件的标题树 -->`

**互链去向**

- 上一页：[编号书签](./bookmarks.md)
- 下一页：[内联补全](./inline-completion.md)
- 相关：[Markdown 编辑与预览](./markdown.md)（大纲配合标题导航）

---

### 4.6 内联补全（幽灵文本）(`inline-completion.md`)

**讲什么**：编辑器的 AI 幽灵文本（ghost text）——在光标处实时显示 AI 续写建议，`Tab` 接受，`Alt+\` 手动触发，支持独立配置比聊天更轻量的补全模型。

**任务导向要点**

- 前置说明：需先在设置中配置模型，详见 [AI 供应商](../customization/ai-providers.md)；未配置模型时手动触发会弹提示引导选择
- 手动触发补全：`Alt+\` / 命令面板"触发内联补全"（`ai.inlineCompletion.trigger`）；当前活动文件需为编辑器文本文件
- 接受补全：`Tab`（采纳当前幽灵文本，`ai.inlineCompletion.commit`）；前提是幽灵文本或内联编辑可见
- 跳转到下一处编辑建议：`Tab`（光标不在建议处时先跳到建议位置，`ai.inlineCompletion.jump`）
- 开关内联补全：命令面板"开关内联补全"（`ai.inlineCompletion.toggle`）；关闭后不再产生幽灵文本
- 选择补全模型：命令面板"选择内联补全模型"（`ai.inlineCompletion.pickModel`）；可以选择比对话更小更快的模型（`aiFeatures.inline`，见 i18n `aiFeatures.inline.desc`："编辑器幽灵文本补全使用的模型（可选更小更快的模型）"）

**涉及命令与快捷键**（代码核实）

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 触发内联补全 | `ai.inlineCompletion.trigger` | `Alt+\`（编辑器文本焦点） |
| 采纳内联补全 | `ai.inlineCompletion.commit` | `Tab`（幽灵文本可见时） |
| 跳到下一处编辑建议 | `ai.inlineCompletion.jump` | `Tab`（光标不在建议处时） |
| 开关内联补全 | `ai.inlineCompletion.toggle` | 无 |
| 选择补全模型 | `ai.inlineCompletion.pickModel` | 无 |

**建议截图占位**

- `<!-- 截图：编辑器中幽灵文本的显示效果（灰色内联续写） -->`

**互链去向**

- 上一页：[大纲视图](./outline.md)
- 必读前置：[AI 供应商配置](../customization/ai-providers.md)（需先配置模型）
- 相关：[AI Agent 概述](../ai-agent/overview.md)（对话 AI 与内联补全的区别）

---

## 5. 链接与交叉引用

**本册入口**（应从以下位置被链接）

- `docs/user/zh-CN/index.md` 文档中心首页的"编辑与文件"分区
- 01 册的界面导览页（资源管理器介绍后链到本册）
- 06 册的 AI 供应商页（被 `inline-completion.md` 引用）

**本册对外的关键互链**

| 来源页 | 链向 | 原因 |
|---|---|---|
| `inline-completion.md` | `../customization/ai-providers.md` | 使用内联补全前置：配置模型 |
| `inline-completion.md` | `../ai-agent/overview.md` | 区别对话 AI 与幽灵文本 |
| `explorer-and-files.md` | `../git/commit.md` | 保存文件后下一步通常是提交 |
| `markdown.md` | `./bookmarks.md` | 配合书签标记重要段落 |
| `outline.md` | `./markdown.md` | 大纲配合 Markdown 标题导航 |
| `bookmarks.md` | `../customization/settings.md` | 调整书签图标颜色 |

**本册被 07 参考册引用的内容**

- `editing/` 目录下的全部快捷键归入 07 册"快捷键速查"表；
- 命令 ID 归入 07 册"命令速查"。

---

## 6. 本册注意事项

1. **Markdown 格式命令标题语言**：`extensions/markdown/package.json` 中命令 title 为英文（如"Toggle Strikethrough"、"Organize Link Definitions"），在 `apps/editor/src/shared/i18n/messages/zh-CN.ts` 中**无对应中文条目**。用户文档中应标注英文 title 并加中文释义（如"Toggle Strikethrough（切换删除线）"），待扩展本地化后更新。

2. **预览 link hints 命令未本地化**：`MarkdownPreviewLinkHintsAction`（"Show Link Hints"）、`MarkdownPreviewLinkHintsToSideAction`（"Show Link Hints (to Side)"）、`MarkdownPreviewHelpAction`（"Keyboard Shortcuts"）在 zh-CN.ts 无条目；文档标注英文并备注。

3. **`saveAll` 中文名待核实**：`fileSaveActions.ts` 的 `SaveAllFilesAction` i18n key 为 `action.saveAll.title`，但 zh-CN.ts 中**无对应条目**（搜索结果未命中）；文档暂写"保存全部（Save All）"，执行前需二次核实实际显示文字。

4. **`OpenWithDefaultApp` 不在命令面板**：该命令 `f1: false`，仅通过资源管理器右键菜单触发，文档应明确说明"无法从命令面板搜到"。

5. **大纲视图在次侧栏**：`workbench.view.outline` 注册在 `ViewContainerLocation.SecondarySideBar`（次侧栏，即编辑区右侧）。文档需明确说明位置，避免用户在主侧栏（左侧）找不到。

6. **书签的 `Ctrl+0`–`Ctrl+9` 冲突风险**：这 10 个跳转快捷键生效条件是 `when: editorTextFocus`；部分用户的系统快捷键或其他扩展可能冲突，文档可作提示。

7. **Markdown `Enter`/`Tab`/`Shift+Tab` 是内部命令**：`markdown.editing.onEnter`/`onTab`/`onShiftTab` 在 keybindings 中出现，但并非用户可主动调用的功能命令，属于扩展的键盘处理，用户文档不应列为"命令"，而应说明这三个键在 Markdown 编辑时的特殊行为（自动续写列表等）。

---

## 7. 执行步骤

1. 确认 00-foundation 的加载机制已打通（`docRegistry` glob 加载 + 文档间相对链接跳转）。
2. 在 `docs/user/zh-CN/editing/` 目录下创建以下文件：
   - `explorer-and-files.md`
   - `tabs-and-split.md`
   - `markdown.md`
   - `bookmarks.md`
   - `outline.md`
   - `inline-completion.md`
3. 在 `docs/user/zh-CN/assets/editing/` 目录下预留截图子目录（`.gitkeep`），截图在内容定稿后补充。
4. 撰写每页时，命令名/快捷键/界面文字直接引用本计划文档 §4 的核实结果，不另行查找。
5. 每页末尾写"下一步"和"相关阅读"互链区块。
6. 处理本册注意事项 §6 中的 3 处待核实/待本地化项（saveAll 中文名、markdown 命令英文标题、linkHints 命令英文标题），以代码当前状态为准，在文档中如实标注。
7. `docs/user/zh-CN/index.md` 的"编辑与文件"分区补入本册 6 个页面的链接。
8. 在应用内（M0 打通后）打开每篇文档，验证渲染和页内锚点跳转；点击文档间相对链接验证跳转。

---

## 8. 验收标准

- [ ] `docs/user/zh-CN/editing/` 目录下存在全部 6 个页面文件：`explorer-and-files.md`、`tabs-and-split.md`、`markdown.md`、`bookmarks.md`、`outline.md`、`inline-completion.md`。
- [ ] 每页有 H1 标题（作为 tab 名）、TOC 目录、"下一步/相关阅读"收尾区块。
- [ ] 所有命令名、快捷键与本计划 §4 核实结果一致（不出现未核实的快捷键）。
- [ ] 3 处待本地化项（markdown 格式命令、linkHints 命令、saveAll 中文名）均以当前代码实际为准并标注，不臆造中文名。
- [ ] `OpenWithDefaultApp` 文档说明"仅右键菜单触发，不在命令面板"。
- [ ] 大纲视图文档明确说明位置在**次侧栏**（编辑区右侧）。
- [ ] 书签页快捷键表覆盖 `Ctrl+Shift+0`–`9`（切换）和 `Ctrl+0`–`9`（跳转）全部 20 个，与 `extensions/numbered-bookmarks/package.json` keybindings 一致。
- [ ] 内联补全页明确说明前置条件（需先配置模型），并链到 06 册 AI 供应商页。
- [ ] 所有内部相对链接在 00 机制打通后可正常跳转（无死链）。
- [ ] 应用内打开每篇文档，渲染正常、页内锚点可跳转。
- [ ] `docs/user/zh-CN/index.md` 的编辑与文件分区已更新本册 6 个页面链接。
