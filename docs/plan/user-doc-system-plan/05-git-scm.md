# 05 · 版本控制（Git / SCM，核心册）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**重头册**。Git 集成功能极丰富（`git` 扩展贡献 50 条命令 + `gitGraph` 96 条 i18n + Blame + 会话更改 + 内联/合并 diff）。但目标读者是游戏内容创作者，**可能完全不懂 Git**，因此本册从"为什么需要版本控制"讲起，按**任务**聚合成页，不逐条罗列命令。
> 依赖：[00-foundation.md](./00-foundation.md)（目录、加载机制、写作/链接约定、术语表基线）。互链需待 M0 打通"相对 `.md` 链接跳转"后才生效。
> 里程碑：M2（与 [03 编辑与文件](./03-editing-and-files.md)、[04 搜索与导航](./04-search-and-navigation.md) 一起构成"主场覆盖"）

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

1. 让**零 Git 基础**的内容创作者读完 overview 后，理解版本控制能帮他"给项目存档、随时回退、多人协作"，并认识源代码管理侧栏。
2. 把最高频的日常动作讲透——**看改动 → 暂存 → 提交**，并突出本编辑器特色：**AI 生成提交信息**、**会话更改**（AI Agent 改了哪些文件）。
3. 覆盖分支/合并/历史图/追溯/冲突等进阶主题，但克制篇幅：**只收高频命令**，把完整命令清单交给 [07 命令速查](../reference/command-reference.md)。
4. 命令名、快捷键、菜单位置、界面中文用词**逐条以代码为准**（见 §2 事实来源），发现不一致处记入 §6。
5. 与 [02 AI Agent](./02-ai-agent.md) 强互链：会话更改 ↔ 审阅改动、AI 提交信息 ↔ 模型与成本。

---

## 2. 读者与前置

- **读者**：已完成 [01 快速上手](./01-getting-started.md) 的创作者，会打开项目、用命令面板，但**不预设懂 Git / 命令行 / 分支概念**。
- **功能前置**：
  - 版本控制针对一个 **Git 仓库**。项目文件夹若不是 Git 仓库，源代码管理侧栏为空、Git 图谱会提示"Git 图谱不可用 - 此文件夹是 git 仓库吗？"。overview 需说明"如何让项目成为仓库"（用系统 Git 初始化，或克隆一个已有仓库）。
  - **AI 提交信息**需先在设置里配好可用模型/供应商，否则生成不出结果 → 链 [06 · AI 供应商](../customization/ai-providers.md)。
- **事实来源（写作时逐条核对）**：
  - Git 命令：`extensions/git/package.json` 的 `contributes`（`commands` 用 `%key%` 占位）；**真实中文 title 在 `extensions/git/package.nls.zh-cn.json`**（英文在 `package.nls.json`）。SCM 侧栏运行时文案（输入框占位、分组名）在 `extensions/git/src/nls.ts`。
  - 内置 Git 相关命令：`apps/editor/src/renderer/actions/` 下 `gitGraphActions.ts`、`gitBlameActions.ts`、`commitMessageActions.ts`、`diffActions.ts`、`dirtyDiffActions.ts`、`mergeActions.ts`、`mergeConflictActions.ts`。
  - 界面中文：`apps/editor/src/shared/i18n/messages/zh-CN.ts`（前缀 `gitGraph.` 96 条、`scm.`、`acp.changes.`、`viewContainer.` / `view.`）。
  - 侧栏容器：`contributions/BuiltInViewContainersContribution.ts`（`workbench.view.scm`、`workbench.view.sessionChanges`）；blame 渲染在 `contributions/GitBlameContribution.ts`。
  - AI 提交信息：`extensions/ai/package.json`（`ai.generateCommitMessage`）。
  - 特性背景（辅助理解，非用户文案）：`.claude/memory/` 下 `scm-submodule-multirepo`、`dirty-diff-inline-peek-feature`、`session-diff-feature`、`linediff-myers-perf`。

---

## 3. 信息架构

用户文档落位 `docs/user/zh-CN/git/`，共 **7 页**。

| 相对 `docs/user/zh-CN/` 的文件路径 | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `git/overview.md` | 版本控制是什么，为什么需要它 | 用创作者能懂的话讲存档/回退/协作；源代码管理侧栏（`workbench.view.scm`）；Git 概念最小集（仓库/改动/暂存/提交/分支/远程） | `BuiltInViewContainersContribution.ts`、`view.scm`=源代码管理、`extensions/git/src/nls.ts`（分组名） |
| `git/commit.md` | 提交你的改动 | 暂存/取消暂存/放弃、提交/提交（修正）、提交并推送/提交并同步、撤销上次提交；**AI 生成提交信息** + 选提交信息模型 | `git.stage*`/`git.commit*`/`git.undoLastCommit`（nls.zh-cn.json）、`extensions/ai/package.json`、`commitMessageActions.ts` |
| `git/branches-and-merge.md` | 分支与合并 | 创建/签出/重命名/删除分支、合并/变基、发布分支、工作树（创建/打开/删除） | `git.createBranch`/`git.checkout`/`git.merge`/`git.rebase`/`git.publishBranch`/`git.*Worktree`（nls.zh-cn.json） |
| `git/git-graph.md` | 提交历史图（Git 图谱） | 打开图谱、搜索提交、显示/隐藏远程分支、右键对提交/分支/标签的操作 | `gitGraphActions.ts`、`gitGraph.*`（i18n 96 条）、`scm/title` 菜单 `git-graph.view` |
| `git/blame-and-history.md` | 追溯每行的来历（Blame） | 编辑器内行尾注解、状态栏项、开关与模板配置、点击跳历史图 | `gitBlameActions.ts`、`GitBlameContribution.ts`、`git.blame.*`（configuration） |
| `git/session-changes.md` | 会话更改：AI 改了哪些文件 | 会话更改视图（`workbench.view.sessionChanges`）、以 Git 视角审阅本次会话改动；暂存/回退指向 SCM | `session-diff-feature`（memory）、`SessionChangesView.tsx`、`acp.changes.*` |
| `git/conflicts.md` | 拉取、推送、储藏与冲突 | 拉取/推送/同步/获取、储藏 stash、合并冲突（合并编辑器 / 内联标记 + 上下冲突导航） | `git.pull*`/`git.push*`/`git.sync`/`git.fetch*`/`git.stash*`、`mergeActions.ts`、`mergeConflictActions.ts` |

> 截图统一放 `docs/user/zh-CN/assets/git/`，暗色主题，命名 kebab-case。

---

## 4. 逐页要点

> 每页以样板页骨架落地（唯一 H1 + TOC + `## 下一步` / `## 相关阅读`）。命令名以 `package.nls.zh-cn.json` / `zh-CN.ts` 中文 title 为准；快捷键以 Windows 键位为准。**参考册（07）只收高频命令**，本册正文按任务讲，不逐条罗列 50 条。

### 4.1 overview.md — 版本控制是什么，为什么需要它

- **讲什么**：全册的"概念地基"。用非技术语言讲清版本控制的价值与最小概念集，必须让零基础读者读完不怕。
- **任务导向要点**：
  - 用创作者能懂的三句话立价值：**存档**（每次提交就是一个可回到的存档点）、**回退**（改砸了能一键回到上一个存档）、**协作**（多人改同一套内容不互相覆盖）。用"游戏存档"类比"提交"是本页的关键锚点。
  - **Git 概念最小集**（每条一句话 + 首次出现链 [07 术语表](../reference/glossary.md)）：
    - 仓库：被版本控制管理的项目文件夹（有 Git 记账本的项目）。
    - 改动：你对文件做的、还没存档的修改。
    - 暂存：挑出这次要存档的改动（放进"暂存的更改"）。
    - 提交：把暂存的改动记成一个存档点，附一句说明。
    - 分支：一条独立的改动线，互不干扰（如"试验新玩法"分支）。
    - 远程：云端/服务器上的仓库副本，用于备份和协作。
  - **源代码管理侧栏**：主侧栏第 3 个图标（`workbench.view.scm`，图标 source-control）。视图标题显示为**"源代码管理"**（`view.scm`）。里面自上而下是：提交信息输入框、提交按钮、"暂存的更改" / "更改"两个分组（`extensions/git/src/nls.ts`：`git.group.staged`=暂存的更改、`git.group.changes`=更改）。
  - 让项目变成仓库：说明"打开的项目文件夹需是 Git 仓库"，非仓库时侧栏为空；引导用系统 Git `git init` 或克隆现有仓库（本编辑器不内置"初始化仓库"命令，属已知边界，见 §6）。
  - **概念地图导航**：暂存/提交 → [commit](./commit.md)；分支/合并 → [branches-and-merge](./branches-and-merge.md)；看历史 → [git-graph](./git-graph.md)；AI 改的文件 → [session-changes](./session-changes.md)。
- **涉及命令 + 快捷键**：`刷新`（`git.refresh`，`Ctrl+Alt+G`）。
- **建议截图**：`<!-- 截图：源代码管理侧栏全貌（输入框 + 暂存的更改/更改分组） -->`
- **互链去向**：→ [commit](./commit.md)（马上上手）；概念词 → [07 术语表](../reference/glossary.md)。

### 4.2 commit.md — 提交你的改动

- **讲什么**：本册最高频的一页。手把手走"看改动 → 暂存 → 写信息 → 提交"，并主推**AI 生成提交信息**这一特色。
- **任务导向要点**：
  - **看改动**：在源代码管理侧栏"更改"分组点文件，打开 diff（左旧右新）。命令"打开更改"（`git.openChange`，`Shift+Alt+Y`）也可对当前文件开 diff。
  - **暂存 / 取消暂存 / 放弃**（行内按钮 + 命令）：`暂存更改`（`git.stage`）、`取消暂存更改`（`git.unstage`）、`放弃更改`（`git.discard`）；批量为 `暂存所有更改` / `取消暂存所有更改` / `放弃所有更改`。强调**"放弃更改"不可撤销**（`git.discard.fileConfirm`：放弃"…"中的更改？此操作无法撤销。），务必先讲清风险。
  - **写提交信息并提交**：在输入框写一句话说明（占位文案：**"消息（Ctrl+Enter 提交）"**，即 `Ctrl+Enter` 即可提交）；或点提交按钮 `提交`（`git.commit`）。没写信息时提示"请先输入提交消息。"，无改动时"没有可提交的更改。"。
  - **AI 生成提交信息（特色，重点写）**：输入框内有一个闪光（sparkle）图标按钮 → `Generate Commit Message`（`ai.generateCommitMessage`，`extensions/ai`）。它读取当前 diff、调 AI 写好一条提交信息填进输入框，你可再改。
    - 前置：需配好模型/供应商（链 [06 · AI 供应商](../customization/ai-providers.md)）。
    - 指定专用模型：命令面板"选择提交信息模型"（`ai.commitMessage.pickModel`）——与 [02 · 模型与花费](../ai-agent/models-and-cost.md) 的 `aiFeatures.commit`（提交信息模型）是同一处配置，互链过去。
    - 可配 `ai.commitMessage.instructions`（自定义提示，如强制中文/格式）、`ai.commitMessage.maxDiffChars`（默认 12000，超出截断）。
  - **提交的几种变体**（用小列表，别铺开）：`提交（修正）`（`git.commitAmend`，把这次改动并进上一条提交、改写它）、`提交并推送`（`git.commitAndPush`）、`提交并同步`（`git.commitAndSync`，先拉后推）、`撤销上次提交`（`git.undoLastCommit`，把上一条提交退回成未提交改动）。
  - **提交按钮的下拉**：提交按钮旁"提交操作..."（`scm.commitActions`）可选提交/提交（修正）/提交并推送/提交并同步。
  - 安全建议：让 AI Agent 大改前，先提交一次干净状态，任何改动都可回退（呼应 [02 · 审阅改动](../ai-agent/reviewing-changes.md)）。
- **涉及命令 + 快捷键**：`提交`（输入框 `Ctrl+Enter`）、`打开更改`（`Shift+Alt+Y`）、`暂存/取消暂存/放弃更改`（无默认键，行内按钮）、`提交（修正）`/`提交并推送`/`提交并同步`/`撤销上次提交`、`Generate Commit Message`、`选择提交信息模型`（命令面板）。
- **建议截图**：`<!-- 截图：输入框内的 AI 生成提交信息按钮（sparkle） -->`、`<!-- 截图：暂存的更改分组 + 提交按钮 -->`
- **互链去向**：→ [conflicts](./conflicts.md)（推送/同步细节）；→ [02 · 模型与花费](../ai-agent/models-and-cost.md)（提交信息模型）；前置 → [06 · AI 供应商](../customization/ai-providers.md)。

### 4.3 branches-and-merge.md — 分支与合并

- **讲什么**：分支的日常操作，以及"工作树"这一进阶但本仓库常用的并行开发机制。
- **任务导向要点**：
  - 一句话解释分支：一条独立的改动线；在"试验分支"上乱改不影响主线，满意了再合并回去。
  - **分支操作**：`签出到…`（`git.checkout`，切换到某分支）、`创建分支…`（`git.createBranch`）、`重命名分支…`（`git.renameBranch`）、`删除分支…`（`git.deleteBranch`）。这些在源代码管理侧栏标题栏 `…` 菜单的"分支"子菜单里（`git.branchMenu`）。
  - **合并 / 变基**：`合并分支…`（`git.merge`，把另一分支的改动并进当前分支）、`变基分支…`（`git.rebase`）。给创作者的取向：优先用"合并"，变基是进阶。
  - **发布分支**：`发布分支`（`git.publishBranch`，把本地新分支首次推到远程）。
  - **工作树（worktree）**：`创建工作区…`（`git.createWorktree`）、`打开工作区`（`git.openWorktree`）、`在新窗口中打开工作区`（`git.openWorktreeInNewWindow`）、`删除工作区…`（`git.deleteWorktree`），在"工作区"子菜单（`git.worktreeMenu`）。
    - **术语警示（见 §6）**：`nls.zh-cn.json` 把 worktree 译成**"工作区"**，与"打开的项目文件夹（workspace）"撞名；而 [Git 图谱](./git-graph.md) 里同一概念译成**"工作树"**。本册正文统一写 **"工作树 (worktree)"** 并明确"它不是你平时打开的项目文件夹"，避免读者混淆。
    - 面向创作者定调：工作树 = 让同一个仓库的多个分支各占一个文件夹、同时打开，互不打架（进阶，可略读）。
- **涉及命令 + 快捷键**：`签出到…`、`创建/重命名/删除分支…`、`合并分支…`、`变基分支…`、`发布分支`、`创建/打开/删除工作区…`（均无默认快捷键，走侧栏 `…` 菜单或命令面板）。
- **建议截图**：`<!-- 截图：源代码管理 … 菜单的分支子菜单 -->`、`<!-- 截图：签出分支的选择列表 -->`
- **互链去向**：→ [git-graph](./git-graph.md)（在历史图上对分支右键操作更直观）；→ [conflicts](./conflicts.md)（合并可能产生冲突）。

### 4.4 git-graph.md — 提交历史图（Git 图谱）

- **讲什么**：可视化浏览提交历史与分支的专用编辑器，是"看清项目怎么一步步走到今天"的最佳入口。
- **任务导向要点**：
  - **打开**：命令面板 `View Git Graph`（`git-graph.view`，**命令面板显示英文**，见 §6），或源代码管理侧栏标题栏最左的图谱图标（`scm/title` 的 `git-graph.view`）。打开后是一个编辑器标签页，标题为**"Git 图谱"**（`gitGraph.title`）。
  - 看什么：每行一个提交，含作者 / 提交 / 日期 / 描述列（`gitGraph.header.*`）；顶部有"未提交的更改"行（`gitGraph.uncommittedChanges`）。选中提交在下方看它改了哪些文件（状态色：已添加/已修改/已删除/已重命名…，`gitGraph.status.*`），可"打开文件"（`gitGraph.openFile`）。
  - **搜索提交**：`Ctrl+F`（`git-graph.focusSearch`，仅在图谱编辑器激活时生效）聚焦搜索框（占位"搜索提交…"，`gitGraph.search.placeholder`）。
  - **显示/隐藏远程分支**：`Toggle Remote Branches`（`git-graph.toggleRemoteBranches`，命令面板显示英文）；图谱内也有"显示远程分支"/"隐藏远程分支"入口（`gitGraph.showRemoteBranches` / `hideRemoteBranches`）。
  - **右键即操作（本页重点，列高频项即可）**：右键某个提交可"检出此提交…""拣选…""还原…""合并到当前分支…""将当前分支变基到此提交…""将当前分支重置到此提交…""在此处创建分支…""在此处创建标签…""复制提交哈希""复制提交信息"（`gitGraph.checkoutCommit` / `cherryPick` / `revert` / `mergeCurrent` / `rebaseCurrentCommit` / `resetCurrentCommit` / `createBranchHere` / `createTagHere` / `copyHash` / `copyMessage`）。危险操作（reset --hard、强制推送）有确认弹窗，正文提醒"看清确认框再点"。
  - 视图设置：提交顺序（作者日期/日期/拓扑，`gitGraph.order.*`）、"仅跟随第一父提交"（`gitGraph.onlyFirstParent`）、"加载更多提交"（`gitGraph.loadMore`）。这些进阶，一句话带过。
  - 不可用态：非 Git 仓库时"Git 图谱不可用 - 此文件夹是 git 仓库吗？"（`gitGraph.unavailable`）。
- **涉及命令 + 快捷键**：`View Git Graph`、`Focus Search`（`Ctrl+F`，图谱内）、`Toggle Remote Branches`（这三条命令面板显示英文，category "Git Graph"）。
- **建议截图**：`<!-- 截图：Git 图谱编辑器全貌（提交线 + 分支标签 + 文件更改） -->`、`<!-- 截图：对某提交右键的操作菜单 -->`
- **互链去向**：→ [branches-and-merge](./branches-and-merge.md)（图上操作分支）；→ [blame-and-history](./blame-and-history.md)（从某行跳到它的提交）；← [overview](./overview.md)。

### 4.5 blame-and-history.md — 追溯每行的来历（Blame）

- **讲什么**：Blame = 看某一行**是谁、在哪次提交、什么时候**改的。对多人协作或回忆"这段设定为啥这么写"很有用。
- **任务导向要点**：
  - **编辑器内注解**：光标所在行的行尾会显示一条灰色注解，默认格式 `${subject}, ${authorName} (${authorDateAgo})`（如"平衡数值, 张三 (3 天前)"）。只标注光标那一行，不铺满全文。
  - **状态栏项**：底部状态栏显示当前行的 blame（默认 `${authorName} (${authorDateAgo})`）；**点击状态栏项会打开 [Git 图谱](./git-graph.md)** 定位该提交（`GitBlameContribution` 里 `OPEN_COMMIT_COMMAND` → `git-graph.view`）。
  - **悬停详情**：把鼠标停在行尾注解上，弹出完整提交信息（作者、邮箱、说明、时间、短哈希）。
  - **开关**：`切换 Git Blame 编辑器修饰`（`git.blame.toggleEditorDecoration`）、`切换 Git Blame 状态栏项`（`git.blame.toggleStatusBarItem`）。二者本质是翻转对应配置项。
  - **配置**（在设置里搜 `git.blame`）：`editorDecoration.enabled` / `statusBarItem.enabled`（开关）、`editorDecoration.template` / `statusBarItem.template`（模板，可用标记 `${hash}` `${hashShort}` `${subject}` `${authorName}` `${authorEmail}` `${authorDate}` `${authorDateAgo}`）、`editorDecoration.disableHover`（关悬停）、`ignoreWhitespace`（计算 blame 时忽略空白改动）。
  - 未提交行显示 "Not Committed Yet"（英文，见 §6）。
  - **文件历史**：本编辑器没有独立的"文件历史"面板；查一个文件的历史，走 [Git 图谱](./git-graph.md)（选提交看其文件改动）或从 blame 状态栏点进图谱。把"文件历史"作为一小节引导到图谱，别承诺不存在的功能。
- **涉及命令 + 快捷键**：`切换 Git Blame 编辑器修饰`、`切换 Git Blame 状态栏项`（均无默认快捷键，命令面板可搜）。
- **建议截图**：`<!-- 截图：编辑器行尾的 blame 灰字注解 + 悬停卡片 -->`、`<!-- 截图：状态栏 blame 项 -->`
- **互链去向**：→ [git-graph](./git-graph.md)（点 blame 进图谱）；← [overview](./overview.md)。

### 4.6 session-changes.md — 会话更改：AI 改了哪些文件

- **讲什么**：本编辑器特色。以 Git 视角查看**某次 AI Agent 会话**产生的文件改动集合，与 [02 · 审阅改动](../ai-agent/reviewing-changes.md) 是同一视图的两面——那册讲"看懂 diff、做决策"，本册讲"落到 Git 的动手操作"。
- **任务导向要点**：
  - 定位：主侧栏"会话更改"容器（`workbench.view.sessionChanges`，视图标题 `view.sessionChanges`=会话更改，图标 diff / FileStack）。它列出当前活跃会话改过的文件，独立于 Git 的"更改"分组。
  - 视图能做什么（**据实写，别臆造**）：**单击**文件 = 预览 diff（复用预览标签）、**双击** = 钉住成独立标签；行内有"打开文件"（`acp.changes.openFile`）、Markdown 文件还有"打开预览"（`acp.changes.openPreview`）；右上角切换"以列表查看"/"以树查看"（`acp.changes.viewAsList` / `viewAsTree`）。
  - 空态：无会话时"没有活跃的 Agent 会话。"（`acp.changes.noSession`）；有会话但没改文件时"此会话尚未修改任何文件。"（`acp.changes.none`）。
  - **暂存 / 回退这些改动在哪做（关键分工，见 §6）**：会话更改视图**本身只用于查看**，没有暂存/提交/放弃按钮。要暂存/提交这些改动，切到 [源代码管理](./commit.md) 侧栏用"暂存更改"+"提交"；要回退，用"放弃更改"或从 [Git 图谱](./git-graph.md) 重置。本页务必把动手操作明确指向 commit / git-graph，不要让读者以为在会话更改视图里能直接提交。
  - 安全叙事：Agent 直接写盘，会话更改是"这次会话动了什么"的总账；先干净提交、再让 Agent 大改，任何改动都可一键回退。
- **涉及命令 + 快捷键**：`显示会话更改`（`action.agent.showSessionChanges`，命令面板可搜，无默认键）。
- **建议截图**：`<!-- 截图：会话更改视图（列表/树） -->`、`<!-- 截图：单击预览某文件 diff -->`
- **互链去向**：↔ [02 · 审阅改动](../ai-agent/reviewing-changes.md)（**强互链**，看懂 diff 在那册）；→ [commit](./commit.md)（暂存/提交）；→ [git-graph](./git-graph.md)（回退）。

### 4.7 conflicts.md — 拉取、推送、储藏与冲突

- **讲什么**：与远程同步、临时收起改动（储藏）、以及协作里最让新手怕的合并冲突。
- **任务导向要点**：
  - **同步远程**（用小列表聚合，别逐条铺开）：`拉取`（`git.pull`，把远程改动拉下来）、`推送`（`git.push`，把本地提交推上去）、`同步（拉取并推送）`（`git.sync`）、`获取`（`git.fetch`，只看远程有无更新不合并）。变体：`拉取（变基）`/`拉取（自动储藏）`、`推送（强制）`/`推送到…`、`获取（清理）`。这些在侧栏 `…` 菜单的"拉取"/"推送"/"获取"子菜单。
    - 强制推送有覆盖远程历史的风险，正文给一句醒目提醒（`git.push.forceConfirm`：这将覆盖远程分支历史，可能导致他人的提交丢失）。
  - **储藏 stash**：`储藏`（`git.stash`，把当前改动临时收起、恢复干净状态）、`储藏（包含未跟踪文件）`、`应用储藏…`（`git.stashApply`）、`弹出储藏…`（`git.stashPop`）、`删除储藏…`（`git.stashDrop`）。场景："改到一半要临时切分支"就先储藏。
  - **合并冲突**：当拉取/合并遇到"两边都改了同一处"，文件进入冲突状态。两种解决路径（由 `git.mergeEditor` 配置决定，默认开三向合并编辑器）：
    - **合并编辑器**：`在合并编辑器中解决`（`git.openMergeEditor`）打开三向对比，逐处选"当前/传入"，完成后`完成合并`（`merge.completeMerge`，`action.completeMerge.title`=完成合并）。合并编辑器提示"{count} 处冲突待解决" / "所有冲突已解决"（`mergeEditor.unresolved` / `allResolved`）。
    - **内联标记**：`git.mergeEditor` 关掉时，冲突以 `<<<<<<<` 标记内联在文件里；用 `转到下一处合并冲突`（`merge-conflict.next`，`Alt+F9`）/ `转到上一处合并冲突`（`merge-conflict.previous`，`Shift+Alt+F9`）在冲突间跳转。
  - 常见错误提示可给读者对照（`extensions/git/src/nls.ts` 的 `git.error.*`）：如"远程仓库有您本地没有的提交——请先拉取，或使用强制推送""请先提交或储藏您的本地更改"。
- **涉及命令 + 快捷键**：`拉取`/`推送`/`同步（拉取并推送）`/`获取`及其变体、`储藏`系列、`在合并编辑器中解决`、`完成合并`、`转到下一处/上一处合并冲突`（`Alt+F9` / `Shift+Alt+F9`）。
- **建议截图**：`<!-- 截图：三向合并编辑器 -->`、`<!-- 截图：内联冲突标记 + 下一处冲突导航 -->`、`<!-- 截图：储藏子菜单 -->`
- **互链去向**：← [commit](./commit.md)（提交并推送/同步）；← [branches-and-merge](./branches-and-merge.md)（合并触发冲突）；→ [07 排障](../reference/troubleshooting.md)（同步失败常见错误）。

---

## 5. 链接与交叉引用

- **册内学习路径**：overview → commit →（按需）branches-and-merge / git-graph / blame-and-history / conflicts；session-changes 从 [02 AI Agent](./02-ai-agent.md) 顺势进入。每页 `## 下一步` / `## 相关阅读` 落实。
- **跨册强互链**：
  - session-changes ↔ [02 · 审阅改动](../ai-agent/reviewing-changes.md)（同一视图，看 diff 在 02、动手在 05）。
  - commit（AI 提交信息 / 提交信息模型）↔ [02 · 模型与花费](../ai-agent/models-and-cost.md)（`aiFeatures.commit`）；前置 → [06 · AI 供应商](../customization/ai-providers.md)。
  - blame / commit 配置 → [06 · 设置](../customization/settings.md)（`git.blame.*`、`ai.commitMessage.*`）。
- **术语链接**：仓库 / 改动 / 暂存 / 提交 / 分支 / 远程 / 合并 / 变基 / 储藏 / 工作树 / 会话更改，首次出现链 [07 术语表](../reference/glossary.md)。
- **命令速查回填**：本册命令名 + 快捷键并入 [07 · 命令速查](../reference/command-reference.md) 与 [快捷键速查](../reference/keyboard-shortcuts.md)；正文文末可选"相关命令"聚合区。

---

## 6. 本册注意事项

> 以下为核对代码时**发现的与代码不一致 / 易踩坑处**，写作与后续维护须留意；能力所及应推动修正源代码文案，文档暂以"代码现状"为准并注明。

- **【译名冲突 · 严重】worktree = "工作区" 撞 workspace**：`extensions/git/package.nls.zh-cn.json` 把 worktree 全译成**"工作区"**（创建工作区…/打开工作区/删除工作区…），而 [00 术语表](./00-foundation.md#8-术语表基线) 里"工作区"指的是 workspace（打开的项目文件夹）。同一个词两个意思，读者必然混淆。**Git 图谱**里同一概念又译成**"工作树"**（`gitGraph.worktree.*`、`gitGraph.ref.worktree`）。处置：本册正文统一用 **"工作树 (worktree)"**，并明确"不是你平时打开的项目文件夹"；建议提 PR 把 git 扩展的 worktree 中文统一改为"工作树"。
- **【译名不一致】checkout = "签出" vs "检出"**：git 扩展 `git.checkout` 译**"签出到…"**，Git 图谱右键译**"检出/检出此提交…"**（`gitGraph.checkout*`）。本册在对应页按各自 UI 实际用词写（侧栏写"签出"、图谱写"检出"），并在术语表注明二者同义，避免读者以为是两种操作。
- **【命令面板显示英文】部分命令未本地化**：`gitGraphActions.ts`（`View Git Graph` / `Focus Search` / `Toggle Remote Branches`，category `Git Graph`）与 `extensions/ai`（`Generate Commit Message`）的 title 是**硬编码英文**，命令面板搜到的是英文。写作时如实写英文命令名（可加中文释义括注），别写成中文命令名让读者搜不到。
- **【blame 命令双重注册，待确认】**：命令 id `git.blame.toggleEditorDecoration` / `git.blame.toggleStatusBarItem` **同时**存在于 `extensions/git/package.json`（中文 title：切换 Git Blame 编辑器修饰 / 状态栏项）和 `gitBlameActions.ts` 内置 Action2（英文 title：Toggle Git Blame …）。命令面板最终显示中文还是英文取决于运行时注册覆盖顺序，落地前**在应用内实测命令面板搜 "blame" 看实际中文**，以实测为准。
- **【blame 少量英文串未本地化】**：编辑器内注解的 "Not Committed Yet"、状态栏 tooltip "Git Blame"、悬停里的时间短语（just now / N days ago）是英文硬编码（`GitBlameContribution.ts`）。截图会带出英文，正文如实描述即可，别声称是中文。
- **【会话更改视图只读，不能提交】**：`SessionChangesView.tsx` 只提供预览/钉住/打开文件/切换列表树，**没有**暂存/提交/放弃按钮。session-changes 页必须把动手操作指向 [commit](./commit.md)（暂存/提交）与 [git-graph](./git-graph.md)（回退），不能暗示能在该视图里直接提交/回退。
- **【无"初始化仓库"命令】**：50 条 Git 命令里没有 `git init` 类命令，非 Git 仓库时侧栏为空。overview 需引导用系统 Git 初始化或克隆，别承诺应用内一键建仓库（属已知边界）。
- **【SCM 容器名 vs 视图标题】**：Activity Bar 容器标签 `viewContainer.scm` 文案是英文缩写 **"SCM"**，而视图标题 `view.scm` 是中文 **"源代码管理"**。正文统一称"源代码管理侧栏"，与 [00 术语表](./00-foundation.md#8-术语表基线)（源代码管理 / SCM）一致。
- **【多仓库 / 子模块】**：SCM 支持一个主仓库 + 每个 git submodule 各作独立提供方（各有独立提交框与分组）。overview 可一句话带过"含子模块时会看到多个仓库"，不展开（背景见 memory `scm-submodule-multirepo`）。
- **命令极多按任务聚合**：50 条 git 命令 + 图谱右键几十项，正文**只讲高频**、其余交 07 速查；`InlineCode` 会把纯路径渲染成可点链接（见 [00 §6.4](./00-foundation.md#6-写作规范)），`git.blame.*`、`.claude/` 这类示例注意排版。

---

## 7. 执行步骤

1. 确认 [00](./00-foundation.md) 已打通 `docRegistry` 多语言加载与"相对 `.md` 链接跳转"，否则本册互链是死的。
2. 在 `docs/user/zh-CN/git/` 建 7 个 md（overview / commit / branches-and-merge / git-graph / blame-and-history / session-changes / conflicts），每篇含唯一 H1 + TOC + `## 下一步` / `## 相关阅读`。
3. 逐页对照 §4 要点与代码出处填内容；每个命令名回查 `package.nls.zh-cn.json` / `zh-CN.ts`，每个快捷键回查 `package.json` keybindings 与 `actions/*.ts` 后再落笔。
4. 处理 §6 的译名冲突：正文按"代码现状"写 + 术语表注明同义；能力所及提 PR 统一 worktree 译名。与 [02](./02-ai-agent.md) 作者对齐"会话更改"术语与互链锚点（`ai-agent/reviewing-changes.md`、`ai-agent/models-and-cost.md`）。
5. 在应用内实测确认 §6 待确认项（blame 命令面板显示中/英）。
6. 截图：暗色主题，放 `docs/user/zh-CN/assets/git/`，无法即时产出的留 `<!-- 截图：… -->` 占位并在册末汇总"待补图清单"。
7. `pnpm check`（仅截取错误）；应用内经 `DocEditorInput` 逐页打开自测渲染与跳转；涉及交互链路时跑 `pnpm e2e` 文档打开/跳转冒烟。
8. 回填 [07](./07-reference-and-faq.md) 命令/快捷键速查（把本册高频命令并入）。

---

## 8. 验收标准

- [ ] 7 页齐全，路径与命名与 [README](./README.md) / [00](./00-foundation.md) 完全一致。
- [ ] 每页有 TOC、`## 下一步` / `## 相关阅读`、必要截图占位（至少 `<!-- 截图：… -->`）。
- [ ] overview 用"存档/回退/协作"讲清价值，零 Git 基础读者可懂；概念最小集（仓库/改动/暂存/提交/分支/远程）到位并链术语表。
- [ ] 所有命令中文名与 `package.nls.zh-cn.json` / `zh-CN.ts` 一致；命令面板显示英文的（View Git Graph / Focus Search / Toggle Remote Branches / Generate Commit Message）如实写英文。
- [ ] 快捷键与代码一致（`Ctrl+Alt+G` 刷新、`Shift+Alt+Y` 打开更改、图谱内 `Ctrl+F` 搜索、输入框 `Ctrl+Enter` 提交、`Alt+F9`/`Shift+Alt+F9` 冲突导航）。
- [ ] commit 页突出 AI 生成提交信息（sparkle 按钮 + 选提交信息模型），并与 [02 模型与花费](../ai-agent/models-and-cost.md) 互链、前置指向 [06 AI 供应商](../customization/ai-providers.md)。
- [ ] session-changes 页明确"视图只读、暂存/回退在 SCM/图谱"，并与 [02 审阅改动](../ai-agent/reviewing-changes.md) 强互链成立。
- [ ] §6 译名冲突（worktree=工作区/工作树、checkout=签出/检出）在正文与术语表处理一致，无自造译名。
- [ ] 所有内部链接可解析（无死链），术语首现链到 [07 术语表](../reference/glossary.md)。
- [ ] 应用内经 `DocEditorInput` 能正常打开渲染全部 7 页。
- [ ] `pnpm check` 通过（仅截取错误）；文档打开/跳转 e2e 冒烟通过。
