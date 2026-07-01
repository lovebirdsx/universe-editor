# 01 · 快速上手（Getting Started）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：新用户的第一站——从下载安装到跑通第一个项目，建立最核心的界面心智与操作习惯，最终引导至 AI Agent（编辑器核心卖点）。
> 依赖：[00-foundation.md](./00-foundation.md)（目录规范、加载机制、写作/链接约定、术语表）
> 里程碑：M1

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

本册覆盖新用户的全部"第一次"：

- 第一次下载并安装 Universe Editor，处理 Windows SmartScreen 警告
- 第一次看到界面，认识五大区域及其用途
- 第一次打开一个项目文件夹，打开第一个文件
- 建立"不知道怎么做就打开命令面板"的心智模型

完成本册后，用户有信心独立在编辑器里导航，并被强力引导到 02 AI Agent 册——那才是编辑器的真正起点。

---

## 2. 读者与前置

**目标读者**：首次使用 Universe Editor 的游戏内容创作者，不预设任何编程或命令行背景。

**前置要求**：

- 一台 Windows 电脑（当前主要支持 Windows；Mac/Linux 提示"敬请期待"）
- 能下载并运行 `.exe` 安装程序

**本册不涉及**：AI Agent 操作细节（见 02）、Git 操作（见 05）、插件安装（见 06）。

---

## 3. 信息架构

| 文件路径（相对 `docs/user/zh-CN/`） | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `getting-started/installation.md` | 下载与安装 | 系统要求、下载渠道、安装步骤、首次启动、SmartScreen 警告处理 | `README.md`（Windows 打包章节）；`apps/editor/src/renderer/workbench/editor/WelcomeEditor.tsx` |
| `getting-started/interface-tour.md` | 界面导览 | 活动栏、主侧栏（资源管理器/搜索/源代码管理/会话更改）、编辑器区、面板（输出/终端）、次侧栏（Agents/大纲/AI 调试）、状态栏；显隐快捷键 | `contributions/BuiltInViewContainersContribution.ts`；`contributions/AgentsContributions.ts`；`actions/layoutActions.ts`；`shared/i18n/messages/zh-CN.ts` |
| `getting-started/first-project.md` | 打开第一个项目 | 打开文件夹、最近打开、欢迎页说明、打开第一个文件，结尾强引导至 AI Agent | `actions/workspaceActions.ts`（`OpenFolderAction`、`OpenRecentAction`）；`actions/fileOpenActions.ts`（`GoToFileAction`）；`workbench/editor/WelcomeEditor.tsx` |
| `getting-started/command-palette.md` | 命令面板 | 命令面板核心心智：记不住功能就打开它；搜索任意命令；一句带过快速打开文件（`Ctrl+P`）并链到 04 册 | `actions/layoutActions.ts`（`ShowCommandsAction`） |

---

## 4. 逐页要点

### 4.1 `installation.md` — 下载与安装

**讲什么**：手把手从"下载"到"见到欢迎页"。

**任务导向要点**：

- 系统要求：Windows 10+（64 位）；磁盘空间建议；无需额外运行时（Electron 自带 Node）
- 下载渠道：GitHub Releases 页找 `Universe Editor-<版本>-win-x64.exe`
- 安装步骤：双击安装器 → 选目录 → 完成，或直接用 `win-unpacked` 目录包（绿色版，不安装）
- **Windows SmartScreen 警告**（重点）：
  - 根因：当前产物默认未签名（代码依据：`README.md` "当前 Windows 产物默认未签名"），SmartScreen 对未签名程序弹"Windows 已保护你的电脑"
  - 放行方法：点"更多信息" → "仍要运行"
  - 说明这是预期行为，后续版本会添加代码签名
- 首次启动：见到欢迎页（WelcomeEditor）说明安装成功
- 应用图标：当前使用 Electron 默认图标，后续版本会添加自定义图标

**建议截图占位**：

- `<!-- 截图：Windows SmartScreen 警告弹窗，标注"更多信息"按钮 -->`
- `<!-- 截图：首次启动的欢迎页 -->`

**互链去向**：下一步 → `interface-tour.md`

---

### 4.2 `interface-tour.md` — 界面导览

**讲什么**：建立界面心智地图，让用户知道每块区域叫什么、放什么、怎么显隐。

**任务导向要点**：

以五大区域为主干，每个区域说明：名称、位置、放什么、如何显隐。

**区域一：活动栏（活动栏）**

- i18n 来源：`menu.activityBar` = '活动栏'
- 位置：最左侧竖条
- 用途：图标切换主侧栏视图容器
- 显隐命令：命令面板搜索"Toggle Activity Bar"（`workbench.action.toggleActivityBarVisibility`）；无默认快捷键
- 代码出处：`layoutActions.ts` 的 `ToggleActivityBarVisibilityAction`

**区域二：主侧栏（主侧边栏）**

- 名称依据：i18n `layoutControls.togglePrimarySideBarWithKey` = '切换主侧边栏 (Ctrl+B)'
- 显隐快捷键：`Ctrl+B`（`ToggleSidebarVisibilityAction`，id `workbench.action.toggleSidebarVisibility`）
- 内置视图容器（来源：`BuiltInViewContainersContribution.ts`）：
  - **资源管理器**（`viewContainer.explorer` = '资源管理器'，图标 `files`，order 1）：文件树
  - **搜索**（`viewContainer.search` = '搜索'，图标 `search`，order 2）：全局搜索替换
  - **SCM**（`viewContainer.scm` = 'SCM'，图标 `source-control`，order 3）：源代码管理/Git，i18n 保留英文缩写
  - **会话更改**（`viewContainer.sessionChanges` = '会话更改'，图标 `diff`，order 4）：AI Agent 产生的文件改动

**区域三：编辑器区**

- 位置：界面中央主体
- 用途：打开文件、文档、Agent 会话等各类标签
- 支持多标签页、多组分屏（`Ctrl+\` 向右拆分，`SplitEditorRightAction`）
- 快捷键：`Ctrl+\`（Split Editor Right，id `workbench.action.splitEditorRight`）

**区域四：面板（面板）**

- 名称依据：i18n `panel.output` = '输出'
- 显隐快捷键：`Ctrl+J`（`TogglePanelAction`，id `workbench.action.togglePanel`）
- 内置视图容器（来源：`BuiltInViewContainersContribution.ts`）：
  - **输出**（`viewContainer.output` = '输出'，order 1）：日志/构建输出
  - **终端**（`viewContainer.terminal` = '终端'，order 2）：集成终端，快捷键 `Ctrl+\``（`ToggleTerminalAction`，id `workbench.action.terminal.toggleTerminal`）

**区域五：次侧栏（辅助侧边栏）**

- 名称依据：i18n `layoutControls.toggleSecondarySideBarWithKey` = '切换辅助侧边栏 (Ctrl+Alt+B)'
- 显隐快捷键：`Ctrl+Alt+B`（`ToggleSecondarySidebarVisibilityAction`，id `workbench.action.toggleSecondarySidebarVisibility`）
- 内置视图容器：
  - **Agents**（`viewContainer.agents` = 'Agents'，注册于 `AgentsContributions.ts`，`ViewContainerLocation.SecondarySideBar`，order 2）：AI Agent 会话列表与 MCP 服务器；**这是编辑器的核心功能入口**
  - **大纲**（`viewContainer.outline` = '大纲'，注册于 `BuiltInViewContainersContribution.ts`，order 1）：文件结构符号树
  - **AI 调试**（`viewContainer.aiDebug` = 'AI 调试'，注册于 `BuiltInViewContainersContribution.ts`，order 5）：AI 调试信息

**区域六：状态栏**

- 名称依据：i18n `statusbar.label` = '状态栏'
- 位置：最底部横条
- 显示：当前文件光标位置、编码、语言模式、AI 模型选择器、通知等

**建议截图占位**：

- `<!-- 截图：完整界面标注六大区域（活动栏/主侧栏/编辑器区/面板/次侧栏/状态栏） -->`
- `<!-- 截图：主侧栏展开资源管理器状态 -->`
- `<!-- 截图：次侧栏展开 Agents 状态 -->`

**互链去向**：下一步 → `first-project.md`；相关阅读 → 02 AI Agent 册（Agents 区域说明时链接）；→ 07 快捷键速查表

---

### 4.3 `first-project.md` — 打开第一个项目

**讲什么**：从零开始，完成"打开文件夹 → 打开文件"的完整操作路径；结尾强力引导 AI Agent。

**任务导向要点**：

- **欢迎页**（WelcomeEditor）说明：
  - 首次无打开文件夹时显示欢迎页
  - 欢迎页上有"快速上手"文档链接（当前链接到 `editor-guide`、`agent-guide`，M0 后更新为新路径）
  - 欢迎页"最近打开"区块列出最多 5 个历史项目
  - 核心 CTA："开始第一个 Agent 会话"按钮（`workbench.action.agent.newSession`）
- **打开文件夹**（最常用路径）：
  - 菜单：文件 → 打开文件夹…
  - 命令面板：搜索"Open Folder"
  - 快捷键：`Ctrl+K Ctrl+O`（`OpenFolderAction`，id `workbench.action.files.openFolder`，keybinding 为 chord `['ctrl+k', 'ctrl+o']`）
  - 打开后资源管理器自动显示文件树
- **最近打开**（再次访问）：
  - 快捷键：`Ctrl+R`（`OpenRecentAction`，id `workbench.action.openRecent`）
  - 命令面板：搜索"Open Recent"
  - 列表支持直接搜索路径；`Ctrl+点击`在新窗口打开
- **打开第一个文件**：
  - 在资源管理器文件树中单击文件（预览模式，斜体 tab）
  - 双击文件或编辑内容钉住 tab
  - 快速打开（`Ctrl+P`，`GoToFileAction`，id `workbench.action.quickOpen`）：输入文件名模糊搜索（一句带过，链接到 04 搜索导航册）
- **结尾强力引导**：
  - 用突出段落或 callout 引导到 AI Agent
  - 文案建议参考欢迎页 i18n：'Agents 是此编辑器的核心 - 描述你的目标，让 AI 和你一起编辑、搜索和运行任务。'
  - 明确说明：这个编辑器真正的威力在 AI Agent，下一步强烈推荐先读 02 AI Agent 册

**涉及命令**：

| 命令面板名称 | 快捷键 | Action ID |
|---|---|---|
| Open Folder… | `Ctrl+K Ctrl+O` | `workbench.action.files.openFolder` |
| Open Recent… | `Ctrl+R` | `workbench.action.openRecent` |
| Go to File… | `Ctrl+P` | `workbench.action.quickOpen` |

**建议截图占位**：

- `<!-- 截图：欢迎页完整界面，标注"开始第一个 Agent 会话"按钮和"最近打开"区域 -->`
- `<!-- 截图：资源管理器显示已打开项目文件树 -->`
- `<!-- 截图：用 Ctrl+P 快速打开文件的 QuickPick 弹窗 -->`

**互链去向**：下一步 → `../ai-agent/overview.md`（强引导，本册最重要的出口）；相关阅读 → `command-palette.md`、`../search-navigation/quick-open.md`

---

### 4.4 `command-palette.md` — 命令面板

**讲什么**：建立"记不住在哪就打命令面板"的核心心智；这是全书最重要的一个操作概念。

**任务导向要点**：

- **一句话定义**：命令面板是访问编辑器全部功能的统一入口，输入关键词即可找到任何命令
- **打开方式**：
  - 快捷键：`Ctrl+Shift+P` 或 `F1`（`ShowCommandsAction`，id `workbench.action.showCommands`，keybinding `[{ primary: 'ctrl+shift+p' }, { primary: 'f1' }]`）
  - 菜单：视图（`menu.view`）→ 显示所有命令
- **核心用法**：
  - 输入命令关键词（中文/英文均可）模糊搜索
  - 结果列表显示命令名称和对应快捷键（帮助记忆）
  - 举几个典型例子：搜索"打开文件夹"、"新建 Agent 会话"、"切换主题"
- **前缀模式**（进阶一句带过）：
  - `>` 前缀：命令（默认，`ShowCommandsAction` 就是在空输入前加 `>`）
  - 无前缀：快速打开文件（`Ctrl+P` 直接进入此模式，`GoToFileAction`）—— 详见 04 搜索与导航册
- **记忆原则**：只需记住 `Ctrl+Shift+P`，其余都可以从命令面板找到

**涉及命令**：

| 命令面板名称 | 快捷键 | Action ID |
|---|---|---|
| Show All Commands | `Ctrl+Shift+P` / `F1` | `workbench.action.showCommands` |
| Go to File… | `Ctrl+P` | `workbench.action.quickOpen` |

**建议截图占位**：

- `<!-- 截图：命令面板打开状态，输入"新建"后的搜索结果 -->`
- `<!-- 截图：命令面板结果列表，标注右侧快捷键显示区 -->`

**互链去向**：相关阅读 → `../search-navigation/quick-open.md`（`Ctrl+P` 文件搜索详解）；→ `../reference/keyboard-shortcuts.md`（07 快捷键速查）

---

## 5. 链接与交叉引用

### 本册对外输出的关键链接

| 目标 | 用途 |
|---|---|
| `../ai-agent/overview.md` | `first-project.md` 结尾的强引导，也是 `interface-tour.md` 中 Agents 区域的说明链接 |
| `../search-navigation/quick-open.md` | `first-project.md` 和 `command-palette.md` 中 `Ctrl+P` 的"详见"出口 |
| `../reference/keyboard-shortcuts.md` | 各页"相关阅读"链接到快捷键速查 |
| `../reference/glossary.md` | 术语首现链到术语表：[会话](../reference/glossary.md#会话)、[资源管理器](../reference/glossary.md#资源管理器)、[命令面板](../reference/glossary.md#命令面板) |

### 本册期待的入链

| 来源 | 链接描述 |
|---|---|
| `docs/user/zh-CN/index.md`（文档中心首页） | "快速上手"分区，指向 `getting-started/installation.md` |
| 应用内欢迎页（WelcomeEditor） | 00 完成后，"快速上手"文档链接更新为 `getting-started/installation.md`（docId `getting-started/installation`） |
| Help 菜单（`helpActions.ts`） | 待 00 完成后，可在 Help 菜单增加"快速上手"入口 |
| 07 术语表/快捷键速查 | 逆向链接，速查表引用本册页面的锚点 |

---

## 6. 本册注意事项

### 6.1 代码事实确认

以下均已通过代码核实：

| 事实 | 代码依据 |
|---|---|
| `Ctrl+Shift+P` / `F1` 打开命令面板 | `layoutActions.ts` `ShowCommandsAction.keybinding = [{ primary: 'ctrl+shift+p' }, { primary: 'f1' }]` |
| `Ctrl+B` 切换主侧边栏 | `layoutActions.ts` `ToggleSidebarVisibilityAction.keybinding = { primary: 'ctrl+b' }` |
| `Ctrl+Alt+B` 切换辅助侧边栏 | `layoutActions.ts` `ToggleSecondarySidebarVisibilityAction.keybinding = { primary: 'ctrl+alt+b' }` |
| `Ctrl+J` 切换面板 | `layoutActions.ts` `TogglePanelAction.keybinding = { primary: 'ctrl+j' }` |
| `Ctrl+K Ctrl+O` 打开文件夹 | `workspaceActions.ts` `OpenFolderAction.keybinding = { primary: ['ctrl+k', 'ctrl+o'] }` |
| `Ctrl+R` 最近打开 | `workspaceActions.ts` `OpenRecentAction.keybinding = { primary: 'ctrl+r' }` |
| `Ctrl+P` 快速打开文件 | `fileOpenActions.ts` `GoToFileAction.keybinding = { primary: 'ctrl+p', when: '!terminalFocus' }` |
| `Ctrl+\`` 切换终端 | `terminalActions.ts` `ToggleTerminalAction.keybinding = { primary: 'ctrl+\`' }` |
| `Ctrl+\` 拆分编辑器（向右） | `editorActions.ts` `SplitEditorRightAction.keybinding = { primary: 'ctrl+\\' }` |
| Agents 视图容器在次侧栏 | `AgentsContributions.ts` `AgentsViewContainerContribution`，`location: ViewContainerLocation.SecondarySideBar` |
| 活动栏显隐无默认快捷键 | `layoutActions.ts` `ToggleActivityBarVisibilityAction` 无 `keybinding` 字段 |
| SmartScreen 根因：产物未签名 | `README.md` "当前 Windows 产物默认未签名，首次运行可能触发 SmartScreen 警告" |

### 6.2 发现的代码与界面不一致处（写作时注意）

**不一致 1：WelcomeEditor 中 `Ctrl+\`` 的说明有误**

- `WelcomeEditor.tsx` 第 89–90 行：`<kbd>Ctrl+\`</kbd>` 配上的说明文字来自 i18n key `welcome.outputPanel`，值为"切换输出面板"
- 但代码实际上 `Ctrl+\`` 绑定的是 `ToggleTerminalAction`（`terminalActions.ts`），功能是"切换终端"，不是"切换输出面板"
- **文档中应以代码绑定为准**，写 `Ctrl+\`` = 切换终端；同时可建议在 00/M0 后修正 WelcomeEditor 的 i18n 描述（列为代码待确认项）

**不一致 2："次侧栏"的中文名称**

- 任务说明中写"次侧栏（Secondary Side Bar）"，但 i18n 中的用词是"辅助侧边栏"（`layoutControls.toggleSecondarySideBarWithKey` = '切换辅助侧边栏 (Ctrl+Alt+B)'）
- **文档中以 i18n 为准**，用"辅助侧边栏"，与用户实际看到的 UI 文字一致

**不一致 3：`viewContainer.scm` 为英文**

- i18n `viewContainer.scm` 的值为 'SCM'（英文），不是"源代码管理"
- 但 `view.scm` 的值是"源代码管理"（用于具体的 View 名称）
- 界面上活动栏图标 tooltip 显示的是容器 label，即 'SCM'
- **文档中建议**：首次提到时写"源代码管理（SCM）"，后续简称 SCM，符合 i18n 实际

### 6.3 本册写作边界

- **安装部分**只覆盖 Windows；Mac/Linux 如未来支持，以 `<!-- TODO: Mac/Linux 安装说明 -->` 占位
- **欢迎页文档链接**：当前 WelcomeEditor 指向旧的 `editor-guide`/`agent-guide` docId；在 00 完成并迁移后，本册的"欢迎页"描述需同步更新链接目标，**写作时以占位注释标注此处待更新**
- 命令面板页故意保持轻量；进阶的 QuickPick 模式（符号搜索 `@:`、行号跳转 `:`、命令 `>` 等前缀）放 04 册，本页只需引出入口

---

## 7. 执行步骤

1. 确认 00-foundation 的目录结构、写作规范、链接约定已就位（本册依赖 M0 完成）
2. 创建目录 `docs/user/zh-CN/getting-started/` 和 `docs/user/zh-CN/assets/getting-started/`
3. 按 §4 的逐页要点，依次撰写四篇 markdown，遵循 `docs/user/_template.md` 骨架
4. 每篇写完，用 `docRegistry` 的 docId（如 `getting-started/installation`）在应用内打开验证渲染效果
5. 检查所有相对链接（目标文件是否存在；未建立的册内页面用 `<!-- TODO: 链接待建 -->` 标注）
6. 核对所有快捷键、命令名与 §6.1 核实表一致
7. 补充实际截图（替换 `<!-- 截图：... -->` 占位注释），或在末尾汇总"待补图清单"
8. 应用内打开所有四页，验证 TOC 锚点、文档间跳转（如 `interface-tour.md` 链到 `first-project.md`）正常工作

---

## 8. 验收标准

- [ ] `getting-started/` 目录下四篇 markdown 均已创建：`installation.md`、`interface-tour.md`、`first-project.md`、`command-palette.md`
- [ ] 每篇有唯一 H1、TOC（超过 3 个 H2 时）和"下一步/相关阅读"收尾区块
- [ ] SmartScreen 说明准确且有放行步骤（依据 README.md 的"当前 Windows 产物默认未签名"）
- [ ] 界面导览覆盖六大区域，区域名称与 i18n 实际用词一致（活动栏、主侧边栏、编辑器区、面板、辅助侧边栏、状态栏）
- [ ] 六大区域的内置视图容器名称与 `BuiltInViewContainersContribution.ts`、`AgentsContributions.ts` 和 `zh-CN.ts` 三者对齐
- [ ] 快捷键标注（`Ctrl+Shift+P`/`Ctrl+B`/`Ctrl+Alt+B`/`Ctrl+J`/`Ctrl+K Ctrl+O`/`Ctrl+R`/`Ctrl+P`）与 `layoutActions.ts`、`workspaceActions.ts`、`fileOpenActions.ts` 中的 keybinding 定义一致
- [ ] `first-project.md` 结尾有明确且突出的引导指向 `../ai-agent/overview.md`
- [ ] `command-palette.md` 中"快速打开文件（`Ctrl+P`）"有明确外链指向 04 搜索与导航册（`../search-navigation/quick-open.md`）
- [ ] 术语首次出现链到 `../reference/glossary.md` 对应锚点
- [ ] 所有内部相对链接通过死链检查脚本（00 建立后）
- [ ] 应用内用 `DocEditorInput` 逐一打开四页，渲染正常，文档间跳转可用
- [ ] 不一致项已在正文做标注（`Ctrl+\`` 对应终端而非"输出面板"；辅助侧边栏而非次侧栏；SCM 为英文）
- [ ] 语言、术语、语气符合 00-foundation 的写作规范（对读者用"你"，祈使句给步骤，无轻佻词）
