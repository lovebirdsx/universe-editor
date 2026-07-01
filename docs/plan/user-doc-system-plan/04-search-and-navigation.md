# 04 · 搜索与导航（Search & Navigation）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**大项目里找东西**。覆盖全局搜索替换、单文件内查找替换、快速打开文件、符号与定义跳转、导航历史五个子域。帮助游戏内容创作者在大型策划项目中快速定位内容。
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

让游戏内容创作者能在大型策划项目中快速找到任何内容——无论是跨文件搜索关键词、在单文件内精准查找替换、通过文件名或符号名瞬间跳转，还是在多文件跳转后沿历史轨迹来回穿梭。本册五个页面相互独立，读者按需取用。

核心需澄清的三个概念（用户最常混淆，文档必须在醒目位置区分）：

- **命令面板**（`Ctrl+Shift+P`）：执行编辑器功能命令的入口，不搜索文件内容
- **快速打开**（`Ctrl+P`）：按文件名快速打开文件，以及通过前缀切换到符号/命令模式
- **全局搜索**（`Ctrl+Shift+F`）：跨所有文件搜索文本内容，可替换

---

## 2. 读者与前置

- **读者**：已完成快速上手（01 册）的游戏内容创作者，能打开项目、知道命令面板是什么。
- **不预设**：懂编程、了解正则表达式（搜索页需单独解释正则的使用方式）。
- **前置依赖**：00-foundation 的加载机制打通后本册才能在应用内渲染；符号/定义跳转页需说明前置条件（依赖语言特性支持，仅对 TypeScript 等特定文件类型有效）。

---

## 3. 信息架构

| 相对 `docs/user/zh-CN/` 的文件路径 | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `search-navigation/global-search.md` | 全局搜索与替换 | 打开搜索侧栏（`Ctrl+Shift+F`）、快速搜索（`Ctrl+Q`）、跨文件查找替换、大小写/全词/正则、包含排除文件 | `searchActions.ts`（`FindInFilesAction`、`QuickTextSearchAction`）；`zh-CN.ts`（`search.*` 前缀）；`BuiltInViewContainersContribution.ts`（`workbench.view.search`） |
| `search-navigation/find-in-file.md` | 单文件内查找与替换 | 当前文件查找（`Ctrl+F`）、替换（`Ctrl+H`）、查找下一个/上一个（`F3`/`Shift+F3`）、关闭查找栏 | `searchActions.ts`（`FindInFileAction`、`FindReplaceInFileAction`、`FindNextAction`、`FindPreviousAction`） |
| `search-navigation/quick-open.md` | 快速打开与命令面板 | 按文件名快速跳转（`Ctrl+P`）、打开文件对话框（`Ctrl+O`）、最近编辑器切换（`Ctrl+Tab`）；前缀机制（`>`命令、`@`符号、`#`工作区符号）；命令面板与快速打开的关系 | `fileOpenActions.ts`（`GoToFileAction`、`OpenFileAction`）；`editorActions.ts`（`QuickOpenRecentEditorAction`）；`layoutActions.ts`（`ShowCommandsAction`）；`zh-CN.ts`（`quickAccess.*` 前缀） |
| `search-navigation/symbols-and-definitions.md` | 符号与定义跳转 | 文件内符号跳转（`Ctrl+Shift+O`）、工作区符号搜索（`Ctrl+T`）；转到定义（`F12`）、转到引用（`Shift+F12`）、速览定义（`Alt+F12`）等；symbolKind 中文分类；依赖语言特性（TS/Markdown 支持，普通文本不支持） | `gotoSymbolActions.ts`（`GoToFileSymbolAction`、`GoToWorkspaceSymbolAction`）；`gotoLocationActions.ts`（全部导航命令）；`zh-CN.ts`（`symbolKind.*` 前缀、`action.revealDefinition.title` 等） |
| `search-navigation/history.md` | 导航历史 | 后退（`Alt+Left`）、前进（`Alt+Right`）、清除历史（无快捷键）；跨文件跳转后回到上一位置；历史记录的工作机制 | `historyActions.ts`（`GoBackAction`、`GoForwardAction`、`ClearHistoryAction`）；`zh-CN.ts`（`action.goBack.title`、`action.goForward.title`、`action.clearHistory.title`） |

---

## 4. 逐页要点

### 4.1 全局搜索与替换 (`global-search.md`)

**讲什么**：在整个项目的所有文件中搜索文本内容，支持大小写、全词、正则、范围限制，以及跨文件批量替换。是大型策划项目中定位内容的主要工具。

**任务导向要点**

- **打开搜索侧栏**：`Ctrl+Shift+F` / 命令面板"在文件中查找"（`workbench.action.findInFiles`）；打开侧栏的"搜索"视图容器（`workbench.view.search`，i18n 用词：搜索）；若当前编辑器中有选中文字，会自动填入搜索框
- 再次按 `Ctrl+Shift+F`（搜索侧栏已聚焦时）将收起侧栏
- **快速搜索**（浮动模式）：`Ctrl+Q` / 命令面板"快速搜索"（`workbench.action.quickTextSearch`）；不打开侧栏，在浮动快速选择器中即时搜索并跳转，适合临时查找
- **搜索选项**（搜索框右侧图标，以 i18n 用词为准）：
  - 区分大小写（`search.matchCase`）
  - 全字匹配（`search.matchWholeWord`）
  - 使用正则表达式（`search.useRegex`）
- **范围限制**：展开"切换搜索详情"（`search.toggleDetails`）显示：
  - 要包含的文件（`search.filesToInclude`）：如 `*.md`、`docs/**`
  - 要排除的文件（`search.filesToExclude`）：如 `*.json`
  - 使用排除设置和忽略文件（`search.useExcludeSettings`）：尊重 `.gitignore` 等
- **查找替换**：点击"切换替换"（`search.toggleReplace`）展开替换框；"替换文件中的所有匹配项"（`search.replaceAllInFile`）替换单文件；单条替换点击匹配行旁的替换图标
- **结果视图**：以树查看（`search.viewAsTree`）/ 以列表查看（`search.viewAsList`）切换；点击匹配项跳转到对应行
- 清除搜索结果：点击"清除搜索结果"（`search.clear`）
- 刷新搜索结果：点击"刷新"（`search.refresh`）

**三大概念区分提示框**

正文起始放提示块，明确区分：全局搜索（搜文件内容）vs 快速打开（按文件名跳转）vs 命令面板（执行功能命令）

**建议截图占位**

- `<!-- 截图：搜索侧栏展开状态，显示搜索框、替换框、选项图标、结果列表 -->`
- `<!-- 截图：Ctrl+Q 快速搜索浮动选择器 -->`
- `<!-- 截图：展开"切换搜索详情"后的包含/排除文件输入框 -->`

**涉及命令与快捷键**

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 打开搜索侧栏 | `workbench.action.findInFiles` | `Ctrl+Shift+F` |
| 快速搜索 | `workbench.action.quickTextSearch` | `Ctrl+Q` |

**互链去向**

- 前置概念：[快速打开与命令面板](./quick-open.md)（区分三个入口）
- 延伸：[单文件内查找与替换](./find-in-file.md)（当前文件精确查找）
- 相关：[版本控制 · 提交改动](../git/commit.md)（全局替换后需要提交）

---

### 4.2 单文件内查找与替换 (`find-in-file.md`)

**讲什么**：在当前打开的文件内查找和替换文本——Monaco 内置的查找栏，支持大小写、全词、正则，以及逐条或全部替换。

**任务导向要点**

- 打开查找栏：`Ctrl+F` / 命令面板"查找"（`workbench.action.editor.find`）；需有活动编辑器（`precondition: hasActiveEditor`）
- 打开查找并替换：`Ctrl+H` / 命令面板"替换"（`workbench.action.editor.findReplace`）；直接展开包含替换输入框的查找栏
- 查找下一个：`F3` / 命令面板"查找下一个"（`workbench.action.editor.findNext`）
- 查找上一个：`Shift+F3` / 命令面板"查找上一个"（`workbench.action.editor.findPrevious`）
- 关闭查找栏：`Escape`（Monaco 原生行为，无独立命令）
- 搜索选项（查找栏内图标）：区分大小写、全字匹配、使用正则表达式（与全局搜索同样的三个选项，UI 相同）
- 正则表达式说明：简要介绍用途（如 `第\d+章` 匹配所有章节标题），不深入讲正则语法，链接到 07 术语表或外部资料
- 替换操作：替换框展开后，单击"替换"按钮逐条替换，或"全部替换"一次性替换当前文件所有匹配项

**建议截图占位**

- `<!-- 截图：Monaco 查找栏打开状态，包含搜索框、选项图标、匹配计数、关闭按钮 -->`
- `<!-- 截图：查找+替换展开状态，显示替换输入框和逐条/全部替换按钮 -->`

**涉及命令与快捷键**

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 查找 | `workbench.action.editor.find` | `Ctrl+F` |
| 替换 | `workbench.action.editor.findReplace` | `Ctrl+H` |
| 查找下一个 | `workbench.action.editor.findNext` | `F3` |
| 查找上一个 | `workbench.action.editor.findPrevious` | `Shift+F3` |

**互链去向**

- 上文：[全局搜索与替换](./global-search.md)（跨文件搜索）
- 下文：[快速打开与命令面板](./quick-open.md)
- 相关：[导航历史](./history.md)（查找跳转后可用后退回到之前位置）

---

### 4.3 快速打开与命令面板 (`quick-open.md`)

**讲什么**：Universe Editor 里最重要的两个键盘入口——快速打开（`Ctrl+P`，按名字找文件）和命令面板（`Ctrl+Shift+P`，执行功能命令）——以及从快速打开切换到其他模式的前缀机制。本页是区分三个"Ctrl+某键"入口的核心说明，应作为本册第一个推荐阅读页。

**核心区分（置于页面顶部的提示块）**

| 快捷键 | 入口 | 用途 |
|---|---|---|
| `Ctrl+P` | 快速打开 | 按文件名在项目中查找并打开文件 |
| `Ctrl+Shift+P` / `F1` | 命令面板（显示所有命令） | 输入命令名称执行编辑器功能 |
| `Ctrl+Shift+F` | 搜索侧栏 | 搜索文件内容（全局搜索）|
| `Ctrl+Q` | 快速搜索 | 浮动方式搜索文件内容 |

**快速打开 (`Ctrl+P`) 要点**

- `Ctrl+P` / 命令面板"转到文件…"（`workbench.action.quickOpen`，i18n：`action.goToFile.title`）；当终端焦点时此快捷键不生效（`when: !terminalFocus`）
- 打开浮动选择器（i18n 提示文字：`quickAccess.file.placeholder` 转到文件…）
- 输入文件名模糊搜索，支持拼音首字母缩写和路径前缀（如 `src/config`）
- 选中文件后按 `Enter` 打开，按 `Ctrl+Enter` 在侧边打开
- **前缀模式**（在快速打开框中输入前缀即切换）：
  - 无前缀或空格：文件搜索（默认）
  - `>`：命令面板（等同于 `Ctrl+Shift+P`，提示文字：`quickAccess.commands.placeholder` 输入命令名称…）
  - `@`：文件内符号跳转（等同于 `Ctrl+Shift+O`，提示文字：`quickAccess.fileSymbol.placeholder` 转到编辑器中的符号…）
  - `#`：工作区符号搜索（等同于 `Ctrl+T`，提示文字：`quickAccess.workspaceSymbol.placeholder` 转到工作区中的符号…）
- 通过系统对话框打开文件：`Ctrl+O` / 命令面板"打开文件…"（`workbench.action.files.openFile`，i18n：`action.openFile.title`）；弹出系统文件选择器

**最近编辑器切换 (`Ctrl+Tab`) 要点**

- `Ctrl+Tab` / 命令面板"打开最近使用的编辑器"（`workbench.action.quickOpenRecentEditor`，i18n：`action.quickOpenRecentEditor.title`）；按 MRU 顺序排列已打开的编辑器，持续按住 `Ctrl` + `Tab` 切换
- `Ctrl+Shift+Tab` / 命令面板"打开最久未使用的编辑器"（`workbench.action.quickOpenRecentEditorReverse`，i18n：`action.quickOpenRecentEditorReverse.title`）；反向切换
- 仅在有已打开编辑器时可用（`precondition: editorIsOpen`），且快速选择器未打开时（`when: !quickInputVisible`）
- 提示文字（i18n）：`quickOpenRecentEditor.placeholder` 最近使用的编辑器

**命令面板 (`Ctrl+Shift+P`) 要点**

- `Ctrl+Shift+P` 或 `F1` / 命令面板"显示所有命令"（`workbench.action.showCommands`，i18n：`action.showAllCommands.title`）
- 提示文字（i18n）：`quickInput.commandPalette.placeholder` 输入命令名称…（注意区别于 `quickAccess.commands.placeholder`）
- 说明：本文档中所有"命令面板"操作均指此入口；命令按类别（文件/编辑器/视图/搜索等）分组

**建议截图占位**

- `<!-- 截图：Ctrl+P 快速打开框，输入文件名模糊搜索的效果 -->`
- `<!-- 截图：Ctrl+Tab 最近编辑器选择器（Ctrl 持续按住时的状态）-->`
- `<!-- 截图：快速打开框输入 > 后切换到命令模式的效果 -->`

**涉及命令与快捷键**

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 快速打开（转到文件） | `workbench.action.quickOpen` | `Ctrl+P`（非终端焦点） |
| 打开文件（系统对话框） | `workbench.action.files.openFile` | `Ctrl+O` |
| 命令面板 | `workbench.action.showCommands` | `Ctrl+Shift+P` / `F1` |
| 最近编辑器（正向） | `workbench.action.quickOpenRecentEditor` | `Ctrl+Tab` |
| 最近编辑器（反向） | `workbench.action.quickOpenRecentEditorReverse` | `Ctrl+Shift+Tab` |

**互链去向**

- 上文：[单文件内查找与替换](./find-in-file.md)
- 延伸：[符号与定义跳转](./symbols-and-definitions.md)（快速打开 `@`/`#` 前缀的详细说明）
- 相关：[快速上手 · 命令面板](../getting-started/command-palette.md)（基础操作说明）

---

### 4.4 符号与定义跳转 (`symbols-and-definitions.md`)

**讲什么**：基于语言特性的结构化跳转——在文件内按函数/类/标题等符号结构导航（`@` 前缀），在整个工作区按符号名搜索（`#` 前缀），以及转到定义/引用/实现等代码级跳转。**需要语言特性支持**，内置支持 TypeScript（`extensions/typescript`）和 Markdown（`extensions/markdown`）。

**前置条件说明（必须在页面开头明确）**

符号导航依赖语言特性支持。目前内置支持的文件类型：
- **Markdown 文件（`.md`）**：符号 = 各级标题（`#`/`##`/`###`…），可用于快速跳转章节
- **TypeScript/JavaScript 文件（`.ts`/`.js`）**：符号 = 函数、类、变量、接口等
- **普通文本文件（`.txt` 等）**：无符号支持，相关功能不可用

其他文件类型可通过安装对应语言扩展来获得支持（参见 [扩展管理](../customization/extensions.md)）。

**文件内符号导航要点**

- `Ctrl+Shift+O` / 命令面板"转到编辑器中的符号…"（`workbench.action.gotoSymbol`，i18n：`action.gotoSymbol.title`）
- 打开快速选择器，提示文字：`quickAccess.fileSymbol.placeholder` 转到编辑器中的符号…
- 也可在 `Ctrl+P` 框中输入 `@` 前缀进入此模式
- 在 `@` 后输入 `:` 可按类别分组查看（`quickAccess.fileSymbol.placeholder` 的分类变体）
- symbolKind 中文分类名（i18n `symbolKind.*` 前缀，选取游戏内容创作者常见的）：
  - 函数（`symbolKind.functions`）、类（`symbolKind.classes`）、变量（`symbolKind.variables`）
  - 文件标题 → 对应 Markdown：无直接 symbolKind，以标题层级（H1/H2/H3）呈现

**工作区符号搜索要点**

- `Ctrl+T` / 命令面板"转到工作区中的符号…"（`workbench.action.showAllSymbols`，i18n：`action.showAllSymbols.title`）
- 打开快速选择器，提示文字：`quickAccess.workspaceSymbol.placeholder` 转到工作区中的符号…
- 也可在 `Ctrl+P` 框中输入 `#` 前缀进入此模式
- 跨文件搜索符号名，结果带文件路径，选中后跳转到对应文件和位置

**转到定义/引用等跳转（适用于 TypeScript 文件）要点**

这些命令由 Monaco 提供，项目通过 `gotoLocationActions.ts` 将其注册为可命令面板搜索的命令：

| 操作 | 命令 ID | 快捷键 | i18n 中文 |
|---|---|---|---|
| 转到定义 | `editor.action.revealDefinition` | `F12` | 转到定义 |
| 在侧边打开定义 | `editor.action.revealDefinitionAside` | `Ctrl+K F12` | 在侧边打开定义 |
| 速览定义 | `editor.action.peekDefinition` | `Alt+F12` | 速览定义 |
| 转到声明 | `editor.action.revealDeclaration` | 无 | 转到声明 |
| 速览声明 | `editor.action.peekDeclaration` | 无 | 速览声明 |
| 转到类型定义 | `editor.action.goToTypeDefinition` | 无 | 转到类型定义 |
| 速览类型定义 | `editor.action.peekTypeDefinition` | 无 | 速览类型定义 |
| 转到实现 | `editor.action.goToImplementation` | `Ctrl+F12` | 转到实现 |
| 速览实现 | `editor.action.peekImplementation` | `Ctrl+Shift+F12` | 速览实现 |
| 转到引用 | `editor.action.goToReferences` | `Shift+F12` | 转到引用 |
| 速览引用 | `editor.action.referenceSearch.trigger` | 无 | 速览引用 |

- "速览"（Peek）：在当前文件内联显示目标内容，不切换标签页；`Escape` 关闭速览窗口
- 转到类型定义/实现/引用：需要当前活动编辑器（`precondition: hasActiveEditor`）；对 TypeScript 有效

**建议截图占位**

- `<!-- 截图：Ctrl+Shift+O 符号快速选择器（Markdown 文件的标题列表）-->`
- `<!-- 截图：Ctrl+T 工作区符号搜索，结果带文件路径 -->`
- `<!-- 截图：Alt+F12 速览定义，内联显示效果 -->`

**互链去向**

- 上文：[快速打开与命令面板](./quick-open.md)（`@`/`#` 前缀的基础说明）
- 相关：[编辑与文件 · 大纲视图](../editing/outline.md)（大纲也基于符号，两者互补）
- 扩展支持：[定制 · 扩展管理](../customization/extensions.md)（安装语言扩展获得更多符号支持）
- 深度扩展：[定制 · 语言特性来自插件](../customization/extensions.md)（06 册，符号/定义能力的来源）

---

### 4.5 导航历史 (`history.md`)

**讲什么**：Universe Editor 记录跨文件、跨位置的跳转轨迹，让你用两个快捷键在历史路径中前后穿梭——在深入查看某个定义或跳转到搜索结果之后，用一键回到出发点。

**任务导向要点**

- **后退**：`Alt+Left` / 命令面板"后退"（`workbench.action.goBack`，i18n：`action.goBack.title`）；跳转到上一个导航位置（可能在其他文件）；仅在有历史时可用（`precondition: canGoBack`）
- **前进**：`Alt+Right` / 命令面板"前进"（`workbench.action.goForward`，i18n：`action.goForward.title`）；跳转到下一个导航位置；仅在有历史时可用（`precondition: canGoForward`）
- **清除历史**：命令面板"清除导航历史"（`workbench.action.clearHistory`，i18n：`action.clearHistory.title`）；无快捷键；清空后 `Alt+Left`/`Alt+Right` 不再响应
- **历史记录的工作方式**（一句话概念）：每次你打开文件、跳转到定义、点击搜索结果等操作，都会记录一条历史。`Alt+Left` 沿着这条链向前走，`Alt+Right` 向后走
- **与浏览器前进/后退的类比**：像浏览器一样，后退回到上一页，前进去下一页，帮助读者建立直觉
- **典型场景**：
  - 按 `F12` 跳转到 TypeScript 函数定义后，用 `Alt+Left` 回到调用处
  - 在全局搜索结果中依次打开多个匹配文件查看，用 `Alt+Left` 沿路径回退
  - 用 `Ctrl+T` 工作区符号跳转后，用 `Alt+Left` 回到出发文件
- **什么不会记录**：在同一位置反复修改不算新历史；标签页切换（`Ctrl+Tab`）有自己的机制，与导航历史分开

**建议截图占位**

- `<!-- 截图：工具栏或状态栏中后退/前进按钮的位置（如有）-->`

**涉及命令与快捷键**

| 操作 | 命令 ID | 快捷键 |
|---|---|---|
| 后退 | `workbench.action.goBack` | `Alt+Left` |
| 前进 | `workbench.action.goForward` | `Alt+Right` |
| 清除导航历史 | `workbench.action.clearHistory` | 无 |

**互链去向**

- 上文：[符号与定义跳转](./symbols-and-definitions.md)（跳转后常用后退回位）
- 相关：[单文件内查找与替换](./find-in-file.md)（查找跳转也记录历史）
- 相关：[快速打开与命令面板](./quick-open.md)（`Ctrl+Tab` 的最近编辑器与导航历史的区别）

---

## 5. 链接与交叉引用

**本册入口**（应从以下位置被链接）

- `docs/user/zh-CN/index.md` 文档中心首页的"搜索与导航"分区
- 01 册的"命令面板"页（`quick-open.md` 是扩展说明）
- 03 册的"大纲视图"页（`symbols-and-definitions.md` 的互补功能）

**本册对外的关键互链**

| 来源页 | 链向 | 原因 |
|---|---|---|
| `global-search.md` | `./quick-open.md` | 区分三个入口的概念说明 |
| `global-search.md` | `../git/commit.md` | 全局替换后下一步通常是提交 |
| `quick-open.md` | `../getting-started/command-palette.md` | 命令面板基础在 01 册，避免重复 |
| `quick-open.md` | `./symbols-and-definitions.md` | `@`/`#` 前缀详细说明 |
| `symbols-and-definitions.md` | `../editing/outline.md` | 大纲也基于符号，功能互补 |
| `symbols-and-definitions.md` | `../customization/extensions.md` | 语言特性来自扩展 |
| `history.md` | `./symbols-and-definitions.md` | F12 跳转后用后退回位 |
| `history.md` | `./quick-open.md` | `Ctrl+Tab` 与导航历史的区别 |

**本册被 07 参考册引用的内容**

- 本册全部快捷键归入 07 册"快捷键速查"表
- 命令 ID 归入 07 册"命令速查"
- 术语"命令面板"的权威解释在 00 术语表基线（本册与 01 册共同依赖）

**与 02 AI Agent 册的互链**

- `quick-open.md` 或 `global-search.md` 中可加一句"Agent 也能帮你在项目中找内容"，链到 [AI Agent · 会话](../ai-agent/first-session.md)（需 02 册落地后核实具体锚点）

---

## 6. 本册注意事项

1. **三个入口的混淆是核心用户痛点**：`Ctrl+P`（快速打开）/ `Ctrl+Shift+P`（命令面板）/ `Ctrl+Shift+F`（全局搜索）在中文用户中经常混淆。`quick-open.md` 的对比表格应在 `global-search.md` 里也以提示块的形式出现，保证从任何入口进来都能看到区分说明。

2. **`GoToFileAction` 命令 ID 是 `workbench.action.quickOpen`**：代码中 `GoToFileAction.ID = 'workbench.action.quickOpen'`，i18n title 是"转到文件…"（`action.goToFile.title`）；命令面板里显示为"转到文件…"而非"快速打开"。文档中两个用词均需提及，用"转到文件…（快速打开）"的写法帮助用户关联。

3. **`QuickTextSearchAction` 快捷键是 `Ctrl+Q`**：不是 `Ctrl+Shift+Q`（`Ctrl+Shift+Q` 是"聚焦大纲视图"，`outline.focus`）。这两个容易混淆，文档须明确标注。

4. **gotoLocationActions 的命令均有 `f1: true`**：所有转到定义/引用等命令（`editor.action.revealDefinition` 等）在代码中均注册为 `f1: true`，可在命令面板中搜索到。文档可提示用户可以通过命令面板访问这些功能，不仅限于快捷键。

5. **速览（Peek）功能的 i18n 用词**：代码中 `action.peekDefinition.title` 对应 i18n `'action.peekDefinition.title': '速览定义'`，用词"速览"而非"预览"；文档须统一用"速览"，与界面一致。

6. **`ClearHistoryAction` 无快捷键**：`historyActions.ts` 中该命令没有 `keybinding` 字段，只能从命令面板触发，文档须明确说明"无快捷键，仅可从命令面板使用"。

7. **符号跳转依赖语言特性，需在页面开头充分说明**：`gotoSymbolActions.ts` 的命令本身只负责打开 QuickAccess 界面，实际的符号数据来自语言特性 provider（TypeScript 扩展、Markdown 扩展）。对普通文本文件（`.txt`、`.csv` 等）无符号数据，选择器会为空。游戏内容创作者可能大量使用 `.csv`、`.json` 等格式，须在页面开头明确告知。

8. **`GoBackAction`/`GoForwardAction` 的 `precondition`**：分别是 `canGoBack`/`canGoForward`，这是 ContextKey，不是 `hasActiveEditor`；无历史时命令面板中对应命令会显示为禁用状态，快捷键按下无反应，文档可作轻量提示。

9. **symbolKind 中文名出自 `zh-CN.ts`**：文档中的符号类别中文名须与 `zh-CN.ts` 中 `symbolKind.*` 前缀保持一致（如"函数"不是"方法"、"变量"不是"字段"），逐字核对。

---

## 7. 执行步骤

1. 确认 00-foundation 的加载机制已打通（`docRegistry` glob 加载 + 文档间相对链接跳转）。
2. 在 `docs/user/zh-CN/search-navigation/` 目录下创建以下文件：
   - `global-search.md`
   - `find-in-file.md`
   - `quick-open.md`
   - `symbols-and-definitions.md`
   - `history.md`
3. 在 `docs/user/zh-CN/assets/search-navigation/` 目录下预留截图子目录（`.gitkeep`），截图在内容定稿后补充。
4. 撰写时：
   - 先写 `quick-open.md` 的三个入口对比表格，作为本册的核心概念定锚；
   - `global-search.md` 和 `find-in-file.md` 引用并简化这个对比，各自聚焦主题；
   - `symbols-and-definitions.md` 开头的语言特性前置说明要写清楚，避免用户看到空选择器不知所措；
   - `history.md` 用浏览器前进/后退类比帮助非技术用户理解。
5. 所有命令名/快捷键/界面文字以本计划文档 §3-§4 的核实结果为准，不另行猜测。
6. 每页末尾写"下一步"和"相关阅读"互链区块。
7. `docs/user/zh-CN/index.md` 的"搜索与导航"分区补入本册 5 个页面的链接。
8. 在应用内（M0 打通后）打开每篇文档，验证渲染和页内锚点跳转；点击文档间相对链接验证跳转。

---

## 8. 验收标准

- [ ] `docs/user/zh-CN/search-navigation/` 目录下存在全部 5 个页面文件：`global-search.md`、`find-in-file.md`、`quick-open.md`、`symbols-and-definitions.md`、`history.md`。
- [ ] 每页有 H1 标题（作为 tab 名）、TOC 目录、"下一步/相关阅读"收尾区块。
- [ ] `quick-open.md` 在醒目位置有命令面板 / 快速打开 / 全局搜索三者的对比说明（表格或提示块）。
- [ ] `global-search.md` 引用了三个入口的区分提示，避免读者混淆。
- [ ] 所有命令名与 i18n `zh-CN.ts` 中对应条目一致（如"查找"不是"搜索"、"转到定义"而非"跳转到定义"、"速览定义"而非"预览定义"）。
- [ ] 所有快捷键与 `searchActions.ts`、`historyActions.ts`、`gotoSymbolActions.ts`、`gotoLocationActions.ts`、`fileOpenActions.ts`、`editorActions.ts`、`layoutActions.ts` 中代码一致（无臆造）。
- [ ] `symbols-and-definitions.md` 开头明确说明语言特性前置条件（支持 TypeScript/Markdown，不支持普通文本），并列出 symbolKind 中文分类（以 `zh-CN.ts` 为准）。
- [ ] `symbols-and-definitions.md` 中的转到定义/引用等命令表格与 `gotoLocationActions.ts` 中 `NAVIGATION_COMMANDS` 数组的命令 ID、快捷键、i18n title 逐条核对一致。
- [ ] `history.md` 明确说明 `ClearHistoryAction` 无快捷键，仅命令面板可用。
- [ ] `quick-open.md` 明确说明 `GoToFileAction` 的命令 ID 是 `workbench.action.quickOpen`，命令面板中显示为"转到文件…"。
- [ ] `quick-open.md` 明确说明 `Ctrl+P` 在终端焦点时不生效（`when: !terminalFocus`）。
- [ ] 所有内部相对链接在 00 机制打通后可正常跳转（无死链）。
- [ ] 应用内打开每篇文档，渲染正常、页内锚点可跳转。
- [ ] `docs/user/zh-CN/index.md` 的搜索与导航分区已更新本册 5 个页面链接。
