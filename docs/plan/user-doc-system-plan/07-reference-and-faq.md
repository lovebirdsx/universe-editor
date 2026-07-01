# 07 · 参考与排障（Reference & FAQ）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**收口册**。速查表 + 术语表 + FAQ + 排障。内容大量交叉引用 01–06，因此骨架可先建，**正文最后回填**。
> 依赖：00（机制/术语基线）；01–06（内容定稿后回填交叉引用与速查条目）
> 里程碑：M3

---

## 目录

- [1. 目标](#1-目标)
- [2. 信息架构](#2-信息架构)
- [3. 逐页要点](#3-逐页要点)
- [4. 术语表（权威译法收口）](#4-术语表权威译法收口)
- [5. 待修复的代码/文案不一致清单（重要）](#5-待修复的代码文案不一致清单重要)
- [6. 链接与交叉引用](#6-链接与交叉引用)
- [7. 本册注意事项](#7-本册注意事项)
- [8. 执行步骤](#8-执行步骤)
- [9. 验收标准](#9-验收标准)

---

## 1. 目标

给用户一个"查得到、看得懂、出问题能自救"的兜底层：

- **速查**：高频快捷键、高频命令，一页扫完（不穷举 200+，只收核心，呼应 README 的"精选参考"定位）。
- **术语**：全站译法的唯一权威，各册的术语链接都指向这里。
- **排障 / FAQ**：把用户最可能卡住的地方（装不上、Agent 连不上、更新、Git 没反应）集中解答。

---

## 2. 信息架构

用户文档页目录 `docs/user/zh-CN/reference/`：

| 文件路径 | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `reference/keyboard-shortcuts.md` | 快捷键速查 | 按功能域分组的高频快捷键表；Windows/Mac 差异 | 各 `actions/*.ts` 的 `keybinding`；扩展 `contributes.keybindings` |
| `reference/command-reference.md` | 命令速查 | 高频命令的命令面板名 + 作用 + 快捷键，按域分组 | `actions/index.ts` 全量；`zh-CN.ts` 的 `action.*` |
| `reference/glossary.md` | 术语表 | 全站术语的中文译法与一句话解释（本册 §4 收口） | `zh-CN.ts`；00-foundation §8 基线 |
| `reference/faq.md` | 常见问题 | 高频疑问速答，答案链到对应册详解 | 各册 |
| `reference/troubleshooting.md` | 疑难排解 | 分症状的排查步骤 | 见 §3 |

---

## 3. 逐页要点

### keyboard-shortcuts.md — 快捷键速查

- 讲什么：一页速查高频快捷键，是全站被 `Ctrl+快捷键` 引用最多的锚点目标。
- 要点：
  - 按功能域分表：通用（命令面板 `Ctrl+Shift+P`、快速打开 `Ctrl+P`）、布局（`Ctrl+B` 切换侧栏、`` Ctrl+` `` 切换终端）、编辑器（分屏 `Ctrl+\`、关闭等）、搜索（文件内 `Ctrl+F`、全局 `Ctrl+Shift+F`）、AI Agent、Git、Markdown、书签。
  - 每域末尾"更多见 XX 册"链接。
  - **Windows/Mac 差异**统一在本页头部说明（`Ctrl`↔`Cmd`、`Alt`↔`Option`）。
  - **只收核心项**，全量不逐条；从各 `actions/*.ts` 与扩展 `package.json` 核实，与各册正文一致。
- 截图：不需要，纯表格。
- 互链：被 01–06 大量反向链接；本页链回各册详解。

### command-reference.md — 命令速查

- 讲什么：命令面板里能搜到的高频命令清单（名 + 作用 + 快捷键）。
- 要点：
  - 按域分组；只收高频核心（新建/保存/搜索/Agent/Git/Markdown 等），不穷举。
  - 强调"记不住就 `Ctrl+Shift+P` 搜"这一心智（与 01 命令面板页呼应）。
  - **标注命令面板显示语言**：部分命令当前显示英文（见 §5），速查表如实标注中/英，避免用户搜中文搜不到。
- 互链：链到 01 命令面板页、各域详解页。

### glossary.md — 术语表

- 讲什么：全站术语权威译法，见 §4。
- 要点：每条 = 术语（带锚点）+ 一句话解释 + "详见 XX 册"链接。各册术语首现链到此处对应锚点。

### faq.md — 常见问题

- 讲什么：高频疑问速答，答案短、链到详解。
- 候选问题（定稿时据实增减）：
  - 首次打开提示"Windows 已保护你的电脑 / SmartScreen"怎么办？→ 见 troubleshooting + 01 安装页（当前产物未签名）。
  - 怎么让 AI 帮我干活？→ 链 02 first-session。
  - AI 没反应 / 连不上？→ 链 troubleshooting Agent 段 + 06 供应商配置。
  - 怎么改成英文界面 / 换主题？→ 链 06 themes-and-language。
  - 侧栏的文件树不见了？→ `Ctrl+B`；链 01 界面导览。
  - 源代码管理侧栏是空的？→ 当前目录不是 Git 仓库（无内置 `git init`，见 §5），链 05 overview。
  - AI 会花多少钱 / 怎么看开销？→ 链 02 models-and-cost（¥ 显示）。
  - API 密钥安全吗？→ 加密存储、不入明文配置，链 06 ai-providers。
- 互链：几乎每条都外链到详解册。

### troubleshooting.md — 疑难排解

- 讲什么：按症状给排查步骤。
- 候选症状：
  - **装不上 / 打不开**：SmartScreen 放行、未签名说明（根 README "Windows 打包"）、系统要求。
  - **Agent 连不上 / 无回复**：先查是否配了供应商与模型（06）、密钥是否设置、网络；`inlineCompletion.error.*` 文案对应的含义（密钥被拒/额度用尽/频率受限/网络错误）。
  - **更新相关**：检查更新（`CheckForUpdatesAction`）、下载/安装更新；自动更新行为（参考 memory `autoupdate-silent-install-coupling`）。
  - **日志在哪**：`ShowLogsAction` / 打开日志文件夹（`OpenLogsFolderAction`），教用户取日志反馈问题。
  - **Git 没反应**：非仓库、未装系统 Git 等。
- 互链：与 faq 双向；链到 01/02/05/06。

---

## 4. 术语表（权威译法收口）

以 00-foundation §8 基线为起点，**据各内容册撰写中的实测发现修订**。以下修订项来自 01–06 撰写时对代码的核实（详见 §5），术语表最终以此为准：

| 术语 | 采用译法 | 说明 | 备注 / 修订来源 |
|---|---|---|---|
| workspace | 工作区 | "打开文件夹"载入的整个目录 | 基线保留 |
| worktree | **工作树（worktree）** | Git 的多工作目录特性 | ⚠️ git 扩展 nls 误译为"工作区"，与 workspace 撞名；文档统一用"工作树"，并提修 nls（§5-1） |
| Session Changes | **会话更改** | 某次 Agent 会话产生的文件改动集合 | ⚠️ 修订基线的"会话改动"→ 与 UI `viewContainer.sessionChanges`='会话更改' 对齐（§5-2） |
| checkout | 签出 | 切换到某分支/提交 | ⚠️ git 扩展"签出"、Git 图谱"检出"不一致；文档统一"签出"（§5-3） |
| SCM / 源代码管理 | 源代码管理（SCM） | Git 集成侧栏 | Activity Bar 容器名英文 "SCM"，视图标题"源代码管理"；首现写全称后简称 SCM |
| Secondary Side Bar | 辅助侧边栏 | 右侧可选侧栏（AGENTS/大纲/AI Debug） | ⚠️ 修订基线的"次侧栏"→ 与 i18n `layoutControls` 用词"辅助侧边栏"对齐（§5-4） |
| Agent / AGENTS 面板 | 智能体 / Agent；面板名保留 "AGENTS" | 核心 AI 能力 | 面板 `viewContainer.agents` 中文仍是 "Agents"，不自造译名 |
| 会话 | 会话 | 与 AI 的一轮对话上下文 | 基线保留 |
| 模式 / 思考等级 | 模式 / 思考等级 | Agent 行为模式 / 推理投入 | 基线保留 |
| 技能 / 记忆 / MCP | 技能（Skill）/ 记忆（Memory）/ MCP | Agent 扩展能力 | 基线保留 |
| 暂存 / 提交 | 暂存 / 提交 | Git stage / commit | 基线保留 |

> **动作项**：术语表定稿后，需回头把 00-foundation §8 的两处（"会话改动"→"会话更改"、"次侧栏"→"辅助侧边栏"）同步修订，保持全计划一致。

---

## 5. 待修复的代码/文案不一致清单（重要）

撰写各册时对照代码发现以下**产品侧**不一致。它们不阻塞文档编写（文档一律"以代码实际为准"如实描述），但建议单独开 issue 修复，修好后文档相应简化。按影响排序：

1. **worktree 译名撞名**（05 发现）：`extensions/git/package.nls.zh-cn.json` 把 worktree 译为"工作区"，与 workspace 的"工作区"冲突；Git 图谱里同概念又译"工作树"。建议 nls 统一为"工作树"。
2. **术语"会话更改"vs"会话改动"**（02 发现）：UI 用"会话更改"，00 基线曾写"会话改动"。已在 §4 统一为"会话更改"，并需同步修 00。
3. **checkout 译名不一致**（05 发现）：git 扩展"签出" vs Git 图谱"检出"。建议统一。
4. **"次侧栏"用词**（01 发现）：i18n 实为"辅助侧边栏"。文档已采用。
5. **部分命令面板显示英文**（03/05/06 发现）：
   - Git 图谱命令（View Git Graph / Focus Search / Toggle Remote Branches，`gitGraphActions.ts`）硬编码英文。
   - AI 提交信息命令（Generate Commit Message，`extensions/ai`）英文。
   - Markdown 10 个格式命令、link hints 3 命令（`extensions/markdown`）英文，`zh-CN.ts` 无对应条目。
   - 部分 AI 设置命令（`OpenAiSettingsJsonAction` / `ManageModelsAction`）中文标题待应用内实测确认。
   - 影响：用户用中文搜命令面板可能搜不到。命令速查表需如实标注中/英，或推动本地化。
6. **`OpenAgentSettingsAction` 未启用 f1**（02 发现）：命令面板搜不到"打开 Agent 设置"；可用入口是"打开 AI 与 Agent 设置"。文档引导已改用后者。
7. **blame 命令双重注册**（05 发现）：`git.blame.toggle*` 同时在 git 扩展（中文）与 `gitBlameActions.ts` 内置 Action2（英文）注册，命令面板最终显示取决于运行时覆盖顺序，需实测。
8. **会话更改视图为只读**（05 发现）：`SessionChangesView` 只有预览/钉住/打开/列表树切换，无暂存/提交/放弃按钮；文档把"动手改"指向 SCM 侧栏与 Git 图谱。
9. **无"初始化仓库"命令**（05 发现）：50 条 Git 命令中无 `git init`；非仓库目录 SCM 侧栏为空。faq/overview 已说明。
10. **`saveAll` 等少量命令缺中文条目**（03 发现）：`action.saveAll.title` 在 `zh-CN.ts` 无对应；文档暂标"保存全部（Save All）"。
11. **少量 blame 英文串**（05 发现）："Not Committed Yet"、tooltip、相对时间短语英文硬编码。
12. **`Ctrl+\`` 绑定的是终端而非输出面板**（01 发现）：`WelcomeEditor` 的 i18n key `welcome.outputPanel` 文案与实际绑定不符。

> 这份清单也是文档系统给产品的"副产品价值"——写文档的过程系统性地体检了一遍用户可见文案。

---

## 6. 链接与交叉引用

- 本册是**被链最多**的册：各册 `Ctrl+快捷键`、术语首现、"相关命令"都指向 keyboard-shortcuts / glossary / command-reference。
- faq 与 troubleshooting 双向互链；两者答案都外链到 01–06 详解，不在此展开长篇。
- glossary 每条链到"详见 XX 册"。

---

## 7. 本册注意事项

- **最后回填**：速查表条目、faq/troubleshooting 的链接目标都依赖 01–06 定稿。建议先建 5 个文件骨架 + 术语表（术语表可早定，供各册链接），其余待 01–06 完成后回填。
- **只收高频**：严守 README"精选参考"定位，不把命令表/设置项/快捷键全量搬来；全量属未来外部文档站的检索场景。
- **中英标注**：凡命令面板当前显示英文的（§5-5），速查表如实标注，别只写中文让用户搜空。
- **术语唯一权威**：任何册出现新术语，先在此登记译法再用；发现冲突以本册 §4 为准。

---

## 8. 执行步骤

1. 建 `reference/` 下 5 个文件骨架 + `.gitkeep` 已由 00 建目录覆盖。
2. **先定 `glossary.md`**（据 §4），供 01–06 链接（若 01–06 尚未全定稿，术语表可与之并行迭代）。
3. 01–06 定稿后，回填 `keyboard-shortcuts.md` / `command-reference.md`（核实每条与各册及代码一致）。
4. 回填 `faq.md` / `troubleshooting.md`，确认每个答案的外链有效。
5. 跑死链检查（00 §10 脚本），确保被大量反链的锚点都存在。
6. 据 §5 清单，视情况开产品 issue（文档不阻塞）。

---

## 9. 验收标准

- [ ] `reference/` 下 5 页齐备，格式符合 00 样板。
- [ ] 术语表 §4 收口，与各册实际用词一致；00-foundation §8 的两处已同步修订。
- [ ] 快捷键/命令速查只收高频核心，且每条与代码 + 各册一致；显示英文的命令已标注。
- [ ] faq/troubleshooting 每个答案都有有效外链到详解册。
- [ ] 本册被各册引用的锚点（术语、速查项）全部存在，死链检查通过。
- [ ] §5 不一致清单已同步给产品（issue 或记录），并在文档中如实描述现状。
