# 用户文档系统建设计划

> 撰写日期：2026-07-01
> 范围：Universe Editor **面向最终用户**（使用编辑器的游戏内容创作者）的 markdown 文档体系
> 定位：一份基于 markdown、结构清晰、内容完备、易读、充分利用链接跳转的文档系统；先出**中文版**，但目录结构从第一天就为多语言预留
> 交付形态：本目录下 1 份总纲 + 1 份地基规范 + 7 份按功能域切分的内容册，逐份独立可执行

---

## 0. 背景与结论

### 0.1 我们不是从零开始

调研代码库后确认：应用内**已经存在一套用户文档的机制骨架**，本计划的核心是**把骨架扩充成体系**，而不是另起炉灶。已有设施：

| 设施 | 位置 | 现状 |
|---|---|---|
| 内置文档机制 | `apps/editor/src/renderer/services/editor/docRegistry.ts` + `workbench/editor/DocEditor.tsx` | ✅ 机制完善：markdown 经 Vite `?raw` 打包 → `MarkdownView` 渲染，无运行时磁盘读 |
| 内置文档内容 | `apps/editor/src/renderer/docs/{editor-guide,agent-guide}.md` | ⚠️ 仅 2 篇、共 90 行，内容单薄 |
| 欢迎页 | `workbench/editor/WelcomeEditor.tsx` | ✅ 有 Agent CTA + Getting Started，但只链到那 2 篇 |
| Help 菜单 | `actions/helpActions.ts`（Editor Guide / Agent Guide / Release Notes） | ✅ 有，可被命令面板搜到（`f1: true`） |
| 升级"What's New" | `contributions/ReleaseNotesContribution.ts` | ✅ VSCode 式版本对比，完整 |
| 首次运行引导 | `contributions/FirstRunAgentOnboardingContribution.ts` | ✅ 有 |
| i18n | `shared/i18n/messages/{en-US,zh-CN}.ts`（约 1222 条） | ⚠️ UI 已中英双语，但**文档本身是硬编码中文单文件**，未接入多语言结构 |

### 0.2 功能规模决定"完备"的边界

命令表（`actions/index.ts`）覆盖 **20+ 功能域**，其中两个重头：

- **AI Agent**：i18n 前缀 `acp`(106) + `agentSettings`(62) + `agent`(24)，是本编辑器区别于普通编辑器的核心卖点，值得**单独成册**。
- **Git / 版本控制**：`git` 扩展贡献 50 条命令，`gitGraph`(96) i18n，同样**单独成册**。

其余：文件与资源管理器、多标签与分屏、全局搜索、Markdown 编辑与预览、编号书签、大纲、终端、内联补全、设置/快捷键/主题/语言、插件管理、窗口与更新、日志输出等。9 个侧栏视图容器（`BuiltInViewContainersContribution.ts`）、6 个内置扩展（`extensions/`）。

**完备度定位（已与需求方确认）**：**任务导向（How-to + 概念）为主干，命令/设置/快捷键做精选参考**（速查表收录高频核心项，不逐条穷举 200+ 命令）。

### 0.3 两条贯穿全局的原则

**原则一 —— 单一内容源（Single Source of Truth）**
同一批 markdown，当前供应用内 `?raw` 打包；未来若做外部文档站（VitePress/Starlight 等），从同一批文件生成。**绝不维护两套内容**，否则必然漂移。因此源文件落位选在仓库级 `docs/user/`（见 §2），而非埋进 renderer 源码树。

**原则二 —— 任务导向，而非功能导向**
用户是游戏内容创作者，不是程序员。标题写"让 AI 帮我批量改文案"，不写"Agent 会话管理说明"。少术语、给可复制示例、关键操作配截图/GIF。

---

## 1. 目标与非目标

### 1.1 目标

1. **结构清晰**：信息架构（IA）分区明确，用户能在 3 次点击内找到任何主题。
2. **内容完备**：覆盖全部 20+ 功能域的核心用法；重头（AI Agent、Git）成册深讲。
3. **易读**：任务导向、示例优先、图文并茂；单页不超过合理滚动长度，过长则拆分并互链。
4. **充分利用链接跳转**：
   - 文档间用相对链接互跳（`[看 AI Agent](../02-...)` 之于内容，`universe:/doc/<id>` 之于应用内）。
   - 每篇有页内目录（TOC）+ 章节锚点。
   - "下一步/相关阅读"串起学习路径。
5. **多语言就绪**：目录与加载机制支持 locale 切换；本期只交付 `zh-CN`，`en-US` 留占位。

### 1.2 非目标（本期不做）

- ❌ 外部文档站 / 官网 / SEO（等有分享引流需求再上；因坚持单一内容源，届时近乎零迁移成本）。
- ❌ 视频教程（可在文档中预留占位链接）。
- ❌ 面向开发者/扩展作者的 API 文档（那属于现有 `docs/{plan,report,development}`）。
- ❌ 交互式 Walkthrough 引导（是很好的后续，但属于**功能开发**而非**文档编写**，本计划聚焦 markdown 文档本身；在 §6 列为后续建议）。

---

## 2. 目录与信息架构（IA）

### 2.1 源文件落位（已确认）

```
docs/
  user/                      ← 新增：面向用户文档的唯一内容源
    zh-CN/
      index.md               ← 文档首页 / 总目录（应用内"文档中心"）
      getting-started/
        installation.md
        interface-tour.md
        first-project.md
        command-palette.md
      ai-agent/
        overview.md
        first-session.md
        reviewing-changes.md
        models-and-cost.md
        skills-memory-mcp.md
        modes-and-thinking.md
        managing-sessions.md
      editing/
        explorer-and-files.md
        tabs-and-split.md
        markdown.md
        bookmarks.md
        outline.md
        inline-completion.md
      search-navigation/
        global-search.md
        find-in-file.md
        quick-open.md
        symbols-and-definitions.md
        history.md
      git/
        overview.md
        commit.md
        branches-and-merge.md
        git-graph.md
        blame-and-history.md
        session-changes.md
        conflicts.md
      customization/
        settings.md
        keybindings.md
        themes-and-language.md
        extensions.md
        ai-providers.md
      reference/
        keyboard-shortcuts.md
        command-reference.md
        glossary.md
        faq.md
        troubleshooting.md
      assets/                ← 截图 / GIF，按册建子目录
        getting-started/
        ai-agent/
        ...
    en-US/                   ← 本期仅建目录 + index.md 占位，内容后续翻译
  plan/ report/ development/  ← 现有：开发者文档，保持不动
```

> 具体到每册的**页面清单**以对应计划文档（01–07）为准；上表是全景骨架，落地时以各册的 IA 小节为准绳。

### 2.2 应用内加载路径

现有 `docRegistry.ts` 用 `import x from '../../docs/xxx.md?raw'`（相对 renderer 源码树）。迁移到 `docs/user/` 后需要让 Vite 能 `?raw` 到仓库级目录——通过 **alias 或 glob import** 实现。**这是 00-foundation 的核心技术任务**，其余内容册都依赖它落地，因此 00 必须先行。

### 2.3 信息架构总览（分区 → 册）

| 分区 | 对应册 | 定位 | 优先级 |
|---|---|---|---|
| 快速上手 | 01 | 装好到跑通第一个项目 | P0 |
| **AI Agent（核心）** | 02 | 编辑器的灵魂功能，单独成册 | P0 |
| 编辑与文件 | 03 | 日常编辑主场 | P1 |
| 搜索与导航 | 04 | 大项目里找东西 | P1 |
| **版本控制（核心）** | 05 | Git 集成，重头，单独成册 | P1 |
| 定制 | 06 | 设置/快捷键/主题/插件/AI 供应商 | P2 |
| 参考与排障 | 07 | 速查表 + 术语 + FAQ | P1 |

---

## 3. 分册索引

按建议阅读/执行顺序排列。**00 是所有内容册的前置依赖**（定义路径、加载机制、写作与链接约定、术语表）。

| # | 计划文档 | 主题 | 产出的用户文档页数（约） | 依赖 |
|---|---|---|---|---|
| 00 | [00-foundation.md](./00-foundation.md) | 地基：目录规范 · 写作/链接约定 · 术语表 · `docRegistry` 接入 · 多语言 · CI 死链护栏 | 1（index.md）+ 全局规范 | 无 |
| 01 | [01-getting-started.md](./01-getting-started.md) | 快速上手：安装首启 · 界面导览 · 第一个项目 · 命令面板 | 4 | 00 |
| 02 | [02-ai-agent.md](./02-ai-agent.md) | **AI Agent**：会话 · 采纳 diff · 模型与成本 · Skills/Memory/MCP · 模式与思考等级 · 会话管理 | 7 | 00 |
| 03 | [03-editing-and-files.md](./03-editing-and-files.md) | 编辑与文件：资源管理器 · 标签与分屏 · Markdown · 书签 · 大纲 · 内联补全 | 6 | 00 |
| 04 | [04-search-and-navigation.md](./04-search-and-navigation.md) | 搜索与导航：全局搜索替换 · 文件内查找 · 快速打开 · 符号/定义跳转 · 历史 | 5 | 00 |
| 05 | [05-git-scm.md](./05-git-scm.md) | **版本控制**：提交与 AI 提交信息 · 分支合并 · GitGraph · Blame · 会话 diff · 冲突 | 7 | 00 |
| 06 | [06-customization.md](./06-customization.md) | 定制：设置 · 快捷键 · 主题与语言 · 插件 · AI 供应商密钥 | 5 | 00 |
| 07 | [07-reference-and-faq.md](./07-reference-and-faq.md) | 参考与排障：快捷键速查 · 命令速查 · 术语表 · FAQ · 排障 | 5 | 00、01–06（内容回填） |

> 07 的速查表与 FAQ 需要在 01–06 定稿后回填交叉引用，因此建议**最后收口**，但骨架可先建。

---

## 4. 多语言策略

- **拆文件而非拆句**：整篇文档是一个翻译单元，按 locale 建平行目录（`zh-CN/` / `en-US/`），不用插件 manifest 的 `%key%` 逐句机制（那对长文过重）。
- **加载按 locale 选目录**：`docRegistry` 依据当前显示语言（`ConfigureDisplayLanguageAction` 所设）选择 `docs/user/<locale>/`；缺失语言回退 `zh-CN`（本期基准语言）。
- **本期范围**：只写 `zh-CN` 全量；`en-US/` 仅建目录 + `index.md` 占位说明"英文文档建设中"。
- **一致性**：文档 slug（文件名/路径）**跨语言保持一致**，仅正文翻译，保证互链与锚点在任何语言下都成立。
- 详细实施（回退逻辑、缺页处理、locale 判定来源）见 [00-foundation.md](./00-foundation.md)。

---

## 5. 链接与跳转机制（全局约定，各册遵循）

充分利用 markdown 链接是硬需求，统一如下（细则与样例在 00-foundation）：

1. **页内目录（TOC）**：每篇顶部给锚点目录，长文必备。
2. **文档间互链**：用**相对路径**（`../git/commit.md`），保证源文件、应用内、未来文档站三处都成立。
3. **应用内深链**：Welcome 页 / Help 菜单 / 面板 `?` 图标用 `universe:/doc/<docId>` 打开指定页（`DocEditorInput` 机制）。
4. **命令引用**：正文提到某操作时，标注其命令面板名称与快捷键，并在文末"相关命令"聚合，指向 07 速查表锚点。
5. **学习路径**：每篇结尾固定"下一步 / 相关阅读"区块，把零散页面串成路径。
6. **术语链接**：首次出现的术语链接到 07 术语表锚点（如 `[会话](../reference/glossary.md#会话)`）。
7. **图片**：相对引用 `assets/<册>/<name>.png`，必写 `alt`。

---

## 6. 执行顺序与里程碑

```
里程碑 M0（地基）        →  00-foundation：建目录 + 打通 docRegistry 多语言加载 + 写规范/术语表/index.md
里程碑 M1（核心可用）    →  01 快速上手 + 02 AI Agent（P0，用户最先接触 + 核心卖点）
里程碑 M2（主场覆盖）    →  03 编辑与文件 + 04 搜索导航 + 05 版本控制
里程碑 M3（定制 + 收口） →  06 定制 + 07 参考与排障（回填交叉引用）+ Welcome 页升级为"文档中心"
里程碑 M4（护栏）        →  CI 死链检查 + "改功能必改文档"进 review 检查项
```

每个内容册都是**独立可执行单元**：完成后即可在应用内打开验证，不必等其它册。

### 后续建议（本期非目标，登记备忘）

- **交互式 Walkthrough**：把 `FirstRunAgentOnboardingContribution` 升级成 VSCode 式多步可勾选引导（围绕 AI Agent）。属功能开发。
- **上下文帮助**：复杂面板（AI 模型配置、Git）角落加 `?` 图标深链到对应文档页。
- **外部文档站**：从 `docs/user/` 生成 VitePress/Starlight 站点，接全文搜索。
- **示例项目**："打开示例项目"按钮，让用户在真实内容里学——游戏创作工具的通用有效打法。

---

## 7. 验收标准（所有册通用）

一份内容册视为完成，须满足：

- [ ] IA 与本总纲、00-foundation 的路径/命名约定一致。
- [ ] 每篇有 TOC、"下一步/相关阅读"、必要截图占位（至少标注 `<!-- 截图：xxx -->`）。
- [ ] 所有内部链接可解析（无死链），术语首现链接到术语表。
- [ ] 涉及的操作标注了命令面板名 + 快捷键，且与代码实际一致（对照 `actions/`、扩展 `package.json`、i18n 消息）。
- [ ] 应用内经 `DocEditorInput` 能正常打开渲染（M0 打通后每册自测）。
- [ ] 语言、术语、语气符合 00-foundation 的写作规范。

---

## 8. 事实基准（供各册引用，避免每册重查）

以下为撰写时反复用到的代码事实，集中列此，各册直接引用：

- **命令注册**：`apps/editor/src/renderer/actions/index.ts`（内置命令）；扩展命令在各 `extensions/<name>/package.json` 的 `contributes.commands`。
- **命令的 title / 快捷键 / 菜单位置**：Action2 的 `title`、`keybinding`、`menu` 字段；扩展走 `contributes.keybindings`。
- **侧栏视图容器**：`contributions/BuiltInViewContainersContribution.ts`（Explorer/Search/SCM/Session Changes/AI Debug/Outline/Output/Terminal）。
- **内置文档机制**：`services/editor/docRegistry.ts`、`DocEditorInput.ts`、`workbench/editor/DocEditor.tsx`。
- **i18n 消息**：`shared/i18n/messages/zh-CN.ts`（用户可见文案的权威中文用词，文档用词应与之对齐）。
- **内置扩展**：`extensions/{ai,claude-helper,git,markdown,numbered-bookmarks,typescript}`。

> 纪律：写作中凡涉及"某命令叫什么、快捷键是什么、在哪个菜单"，**以代码为准**，不臆造。发现文档与代码不一致时，以代码为事实、在册内记为待确认项。
