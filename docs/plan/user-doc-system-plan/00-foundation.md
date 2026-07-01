# 00 · 地基规范（Foundation）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**所有内容册（01–07）的前置依赖**。本册不写用户内容，而是把"地基"打好——目录结构、加载机制、写作与链接约定、术语表、多语言、质量护栏。
> 依赖：无（最先执行）
> 里程碑：M0

---

## 目录

- [1. 目标](#1-目标)
- [2. 目录结构落地](#2-目录结构落地)
- [3. 应用内加载机制改造（核心技术任务）](#3-应用内加载机制改造核心技术任务)
- [4. 文档间跳转机制（核心技术缺口）](#4-文档间跳转机制核心技术缺口)
- [5. 多语言实施](#5-多语言实施)
- [6. 写作规范](#6-写作规范)
- [7. 链接与结构约定](#7-链接与结构约定)
- [8. 术语表基线](#8-术语表基线)
- [9. 截图与资源管理](#9-截图与资源管理)
- [10. 质量护栏（CI 死链）](#10-质量护栏ci-死链)
- [11. 样板页模板](#11-样板页模板)
- [12. 执行步骤](#12-执行步骤)
- [13. 验收标准](#13-验收标准)

---

## 1. 目标

把用户文档从"埋在 renderer 源码里的 2 篇硬编码中文" 升级为"仓库级、多语言就绪、可互链、可 CI 校验"的内容源，并让应用内加载机制适配之。完成后，01–07 各册只需往 `docs/user/zh-CN/<册>/` 里写 markdown，即可在应用内打开验证。

---

## 2. 目录结构落地

按 [README §2.1](./README.md) 建立 `docs/user/` 骨架。本册负责创建：

```
docs/user/
  zh-CN/
    index.md              ← 文档中心首页（本册撰写）
    getting-started/      ← 01 册（本册只建目录 + .gitkeep）
    ai-agent/             ← 02 册
    editing/              ← 03 册
    search-navigation/    ← 04 册
    git/                  ← 05 册
    customization/        ← 06 册
    reference/            ← 07 册
    assets/               ← 截图，按册建子目录
  en-US/
    index.md              ← 占位："英文文档建设中"
```

- 各册子目录先建好、放 `.gitkeep`，内容由对应册填充。
- `index.md` 是文档系统的门面（应用内"文档中心"入口指向它），本册撰写，形态见 [§11](#11-样板页模板)。

---

## 3. 应用内加载机制改造（核心技术任务）

### 3.1 现状

`apps/editor/src/renderer/services/editor/docRegistry.ts` 当前把 markdown 硬编码进 renderer 源码树：

```ts
import editorGuide from '../../docs/editor-guide.md?raw'
import agentGuide from '../../docs/agent-guide.md?raw'

export type DocId = 'editor-guide' | 'agent-guide'
export const DOCS: Record<DocId, IDocEntry> = { ... }
```

`DocEditorInput`（`docId` → 打开）、`DocEditor.tsx`（`DOCS[docId].content` → `MarkdownView`）、`WelcomeEditor.tsx` / `helpActions.ts`（构造 `DocEditorInput`）都依赖这个 registry。

### 3.2 目标形态

内容源迁到仓库级 `docs/user/<locale>/`，`docId` 从 2 个扩展为**层级路径式**（如 `getting-started/installation`、`ai-agent/overview`），按当前 locale 加载。

### 3.3 关键技术决策：Vite glob import

用 Vite 的 `import.meta.glob` 一次性把某 locale 下所有 markdown 以 `?raw` 收进来，避免逐文件 `import`（几十篇不可能手写）：

```ts
// 形态示意（最终实现以落地为准）
const zhModules = import.meta.glob('/docs/user/zh-CN/**/*.md', {
  query: '?raw', import: 'default', eager: true,
})
```

- **路径别名**：`electron.vite.config.ts` 需让 renderer 能解析到仓库级 `docs/user/`（配置 alias 或用绝对 glob）。这是本册要在 `electron.vite.config.ts` 落的一处小改。
- **docId ↔ 文件路径映射**：`docId = 相对 <locale>/ 的路径去掉 .md`。`DOCS` 从静态对象改为"按 docId 查 glob 结果"的函数。
- **打包无运行时磁盘读**：仍是构建期 `?raw` 内联，保持现有"无运行时 fs"特性（`docRegistry.ts` 头注释的承诺不破坏）。

### 3.4 docId 与标题

- `DocId` 从字面量联合类型改为 `string`（路径式），`isDocId` 改为"该路径是否存在于 glob 结果"。
- 页面标题不再靠 registry 的 `titleKey`，改为**从 markdown 的首个 H1 提取**（约定每篇必有且仅有一个 H1，见 [§6](#6-写作规范)）；`DocEditorInput.getName()` 相应调整。
- **序列化兼容**：`DocEditorInput.serialize/deserialize` 用 `docId` 字符串，天然向前兼容；`isDocId` 守卫防止已删除文档的陈旧 tab 崩溃。

### 3.5 影响面清单（改造时逐一核对）

| 文件 | 改动 |
|---|---|
| `services/editor/docRegistry.ts` | glob 加载 + 按 locale 选目录 + docId 路径化 + 标题从 H1 取 |
| `services/editor/DocEditorInput.ts` | `DocId` 放宽为 string；`getName()` 取 H1；`isDocId` 改运行时校验 |
| `workbench/editor/DocEditor.tsx` | 传 `previewLinks` + `baseUri`（见 §4） |
| `electron.vite.config.ts` | alias / glob 能解析 `docs/user/` |
| `workbench/editor/WelcomeEditor.tsx` | 文档入口指向新 docId（见 01 册） |
| `actions/helpActions.ts` | Help 菜单指向新 docId |
| 旧 `renderer/docs/*.md` | 内容迁走后删除 |

> 本册只需打通机制并迁移**现有 2 篇**作为验证；完整内容由 01–07 填充。

---

## 4. 文档间跳转机制（核心技术缺口）

### 4.1 问题

需求明确要求"充分利用 markdown 的链接、跳转机制"。但当前 `MarkdownView.tsx` 的 `SafeLink`（第 314–356 行）对链接的处理是：

- `#anchor` → 页内滚动 ✅（已支持）
- `file:` URI → 打开文件 ✅
- 看起来像文件路径 → 打开文件 ✅
- **其它一律 `window.open(href, '_blank')` 当外部 URL** ❌

也就是说，**文档里写 `[提交](../git/commit.md)` 这种文档间相对链接，目前不会在应用内跳到另一篇文档**，而会被当外链丢给浏览器。这是必须补的核心能力，否则"链接跳转"无从谈起。

### 4.2 方案

在 `MarkdownView` / `SafeLink` 增加一类链接识别：**指向另一篇内置文档的链接**，点击时打开对应 `DocEditorInput` 而非外跳。两种可选写法（择一，落地时定）：

- **方案 A（相对路径，推荐）**：识别以 `./` / `../` 结尾为 `.md`（可带 `#anchor`）的链接，结合当前文档的 `baseUri`（docId 所在目录）解析成目标 docId，打开 `DocEditorInput`。优点：源文件里就是标准相对链接，未来外部文档站零改动可用（呼应单一内容源）。
- **方案 B（自定义 scheme）**：约定 `universe:/doc/<docId>` 形式。优点：显式、易识别；缺点：不是标准 markdown 链接，外部站需转换。

> 倾向 **A**：正文用标准相对链接，`DocEditor` 渲染时传入该文档的 `baseUri`（其 docId 目录），`SafeLink` 解析 `.md` 相对链接 → docId → 打开。跨文档 `#anchor`（`../git/commit.md#amend`）解析为"打开目标文档 + 滚动到锚点"。
>
> `universe:/doc/<docId>`（方案 B）仍保留给**应用内非文档场景**（Welcome 页、Help 菜单、面板 `?` 图标）直接深链，因为那些地方不是 markdown。

### 4.3 落地点

- `MarkdownView` / `SafeLink`：新增"内置文档相对链接"分支。
- `DocEditor.tsx`：给 `MarkdownView` 传 `previewLinks` 与 `baseUri`（当前 docId 目录）。
- 补测试：`MarkdownView.test.tsx` 增加"相对 `.md` 链接打开对应 DocEditorInput"用例。

> 这是 00 里工作量最大、也最关键的一项——**没有它，所有内容册的互链都是死的**。务必在 M0 完成并测试。

---

## 5. 多语言实施

### 5.1 现有 i18n 事实

- `shared/i18n/availableLocales.ts`：`SUPPORTED_LOCALES = ['en-US', 'zh-CN']`，`DEFAULT_LOCALE = 'en-US'`。
- `getCurrentLocale(): SupportedLocale` 已存在，可直接用于选择文档目录。
- 显示语言由 `ConfigureDisplayLanguageAction` 设置，存 `workbench.language`。

### 5.2 文档多语言规则

- **按 locale 平行目录**：`docs/user/zh-CN/` 与 `docs/user/en-US/`，同一 slug 路径跨语言一致。
- **加载选目录**：`docRegistry` 用 `getCurrentLocale()` 决定 glob 哪个目录。
- **回退**：目标 locale 缺某篇 → 回退到基准语言的同 slug；本期基准语言为 **zh-CN**（因为只有中文全量），即 `en-US` 缺页回退中文，并在页首提示"该页暂无英文版"。
   - 注意：这与 UI 的 `DEFAULT_LOCALE='en-US'` 相反，是**文档专属**的回退基准，须在 registry 里显式处理，不要复用 UI 的默认。
- **本期交付**：`zh-CN` 全量；`en-US` 只有 `index.md` 占位。

### 5.3 语言切换的即时性

文档 tab 已打开时切换显示语言，不强制热切换（可要求重开）。但 `docRegistry` 每次 `openEditor` 都应读**当时**的 `getCurrentLocale()`，保证新打开的文档是当前语言。

---

## 6. 写作规范

统一风格，各册遵循。总原则：**为游戏内容创作者写，不是为程序员写**。

### 6.1 语气与人称

- 用"你"称呼读者，友好、直接。祈使句给步骤（"点击…""按下…"）。
- 避免"仅需""轻松""只要"这类轻佻词；也避免"显然""众所周知"。
- 不预设读者懂编程/Git/命令行；首次出现的技术概念一句话解释或链术语表。

### 6.2 结构

- **每篇一个 H1**（页面标题，用于应用内 tab 名，见 §3.4），其下用 H2/H3 分节。
- 长页顶部放 TOC（锚点目录）。段落短，多用列表、表格、步骤编号。
- 固定收尾区块：`## 下一步` / `## 相关阅读`（互链，见 §7）。

### 6.3 术语与文案一致性

- **界面元素名称以 `zh-CN.ts` i18n 为准**：文档里写的按钮名/菜单名/面板名，必须和用户实际看到的中文一致（例如命令面板、资源管理器、源代码管理）。写作时对照 `shared/i18n/messages/zh-CN.ts`。
- **快捷键**：以代码里 Action2 的 `keybinding` / 扩展 `contributes.keybindings` 为准，不臆造。Windows 为主（`Ctrl`/`Alt`/`Shift`），Mac 差异在 07 速查表统一标注。
- **命令名**：正文提到"可从命令面板运行 XXX"时，XXX 用该命令的 `title` 中文。

### 6.4 代码/示例

- 遵循项目 Prettier 风格（无分号、单引号）；示例可复制即用。
- 路径、文件名、命令用行内 code。
- 注意 `MarkdownView` 特性：**行内 code 若整体是一个文件路径，会被渲染成可点击链接**（`InlineCode` 逻辑）。因此不希望被当路径的示例（如 `a/b`）需留意，避免误触发。

### 6.5 图文

- 关键操作配截图/GIF；无法即时截图时留占位注释 `<!-- 截图：命令面板搜索 Git 提交 -->`，并在册末列"待补图清单"。
- 图片必写 `alt`。

---

## 7. 链接与结构约定

落实 [README §5](./README.md) 的 7 条，具体写法：

### 7.1 页内目录（TOC）

超过 3 个 H2 的页面，H1 下给 TOC：

```markdown
## 目录
- [打开项目](#打开项目)
- [命令面板](#命令面板)
```

锚点规则：`MarkdownView` 用 `slugifyHeading`（`markdownRenderer.ts`）生成，中文标题也可锚点（会 slug 化）。写 TOC 时锚点用**标题原文**，`#` 后接标题文字（大小写/空格按 slug 规则）——不确定时以渲染后实际锚点为准。

### 7.2 文档间互链

- 用**相对路径**：`[提交改动](../git/commit.md)`、`[采纳 diff](./reviewing-changes.md)`。
- 跨文档带锚点：`[amend 提交](../git/commit.md#amend-修改上一条提交)`。
- 依赖 §4 的机制生效——写法是标准 markdown，应用内被解析为打开对应文档。

### 7.3 学习路径收尾

每篇结尾：

```markdown
## 下一步
- [让 AI 帮你改第一处内容](../ai-agent/first-session.md)

## 相关阅读
- [模型与成本](../ai-agent/models-and-cost.md)
```

### 7.4 术语链接

术语首次出现链到术语表：`[会话](../reference/glossary.md#会话)`。

### 7.5 命令/快捷键引用

正文提操作时行内标注，例如：

> 按 `Ctrl+Shift+P` 打开命令面板，输入"新建会话"。

页末可选"相关命令"小节，聚合本页命令并链到 07 命令速查。

---

## 8. 术语表基线

在 `reference/glossary.md`（07 册落地，本册先定基线词条）统一译法，供各册链接。基线词条（中文 → 说明，锚点）：

| 术语 | 说明 | 备注 |
|---|---|---|
| 工作区 / 项目 | 用"打开文件夹"载入的整个目录 | 对应 workspace |
| 资源管理器 | 主侧栏的文件树 | i18n `viewContainer.explorer` |
| 辅助侧边栏 | 右侧可选侧栏（AGENTS / 大纲 / AI Debug） | i18n 用词"辅助侧边栏"，勿写"次侧栏" |
| 命令面板 | `Ctrl+Shift+P` 的全局命令入口 | 核心心智 |
| 会话（Agent 会话） | 与 AI 的一轮对话上下文 | ACP session |
| 智能体 / Agent | 能读写文件、执行操作的 AI | 核心卖点 |
| 差异 / diff | 改动前后的对比 | 采纳/回退 |
| 模式（Agent 模式） | Agent 的行为模式 | `SelectAgentMode` |
| 思考等级 | Agent 推理投入程度 | `SelectAgentThoughtLevel` |
| 技能 / Skill | 可复用的 Agent 能力包 | Skills |
| 记忆 / Memory | 跨会话持久的上下文 | Memory |
| MCP | 外部工具/数据接入协议 | Model Context Protocol |
| 源代码管理 / SCM | Git 集成侧栏 | `viewContainer.scm`（容器名英文 "SCM"，视图标题"源代码管理"） |
| 暂存 / stage | 把改动加入下次提交 | Git |
| 提交 / commit | 记录一次改动快照 | Git |
| 会话更改 | 某次 Agent 会话产生的文件改动集合 | UI `viewContainer.sessionChanges`='会话更改'，勿写"会话改动" |
| 工作树（worktree） | Git 的多工作目录特性 | 勿译"工作区"（与 workspace 撞名），详见 [07 §5](./07-reference-and-faq.md#5-待修复的代码文案不一致清单重要) |

> 译法一经确定，各册严格沿用；发现新术语补进这张表再用。术语的**最终权威**收口在 [07 术语表](./07-reference-and-faq.md#4-术语表权威译法收口)，其中含撰写时据代码实测的修订（会话更改、辅助侧边栏、工作树等）。

---

## 9. 截图与资源管理

- 统一放 `docs/user/<locale>/assets/<册>/`，文件名 kebab-case、语义化（`command-palette-git-commit.png`）。
- 亮/暗主题：优先用**暗色主题**截图（编辑器默认深色），保持一致。
- 中英截图可共用同一张（若图中无文字）或各自一套（图中有 UI 文字时按 locale 分）。
- GIF 控制体积（关键操作 3–8 秒），大文件考虑压缩。
- 无法即时产出的图，正文留 `<!-- 截图：... -->` 占位，册末汇总"待补图清单"。

---

## 10. 质量护栏（CI 死链）

- **内部链接检查**：加一个脚本（`scripts/` 下，风格参照现有 `scripts/*.mjs`）遍历 `docs/user/**/*.md`，校验：
  - 相对链接目标文件存在；
  - 跨文档锚点存在（可选，二期）；
  - 图片引用存在。
- 接入 `pnpm check` 或单列 `docs:check`，死链则失败。
- **"改功能必改文档"**：把"若改动了用户可见功能，检查是否需同步更新 `docs/user/`"列入 PR 自查项（写进 CLAUDE.md 或 PR 模板）。
- 本册只需落地**内部死链检查**最小版；锚点级校验与 CI 门禁可二期。

---

## 11. 样板页模板

各册每篇 markdown 以此为骨架（存为 `docs/user/_template.md` 备查，不纳入加载 glob——注意 glob 需排除下划线开头文件）：

```markdown
# 页面标题（唯一 H1，作为 tab 名）

一句话说明这篇讲什么、读完你能做到什么。

## 目录
- [小节一](#小节一)
- [小节二](#小节二)

## 小节一

任务导向的步骤：

1. 打开命令面板（`Ctrl+Shift+P`）。
2. 输入"…"。

<!-- 截图：... -->

> 提示：额外说明用引用块。

## 小节二

…

## 下一步
- [接下来做什么](./next.md)

## 相关阅读
- [相关主题](../other/topic.md)
```

`index.md`（文档中心首页）额外要求：按 [README §2.3](./README.md) 的分区，用分组链接列出各册入口，作为应用内"文档中心"。

---

## 12. 执行步骤

1. **建目录**：`docs/user/{zh-CN,en-US}/` 及各册子目录（`.gitkeep`）、`assets/`。
2. **写 `zh-CN/index.md`** 文档中心首页 + `en-US/index.md` 占位 + `_template.md`。
3. **改造 `docRegistry`**（§3）：glob 加载 + locale 选目录 + docId 路径化 + 标题取 H1；改 `electron.vite.config.ts` alias/glob。
4. **补文档间跳转**（§4）：`MarkdownView`/`SafeLink` 识别相对 `.md` 链接 → 打开 DocEditorInput；`DocEditor` 传 `baseUri`/`previewLinks`；补测试。
5. **迁移现有 2 篇**（`editor-guide`/`agent-guide`）到 `docs/user/zh-CN/` 对应位置作为验证样本，更新 Welcome/Help 引用，删除旧 `renderer/docs/*.md`。
6. **死链检查脚本**（§10）最小版。
7. `pnpm check`（截取错误）；涉及交互链路跑 `pnpm e2e`（doc 打开/链接跳转相关冒烟）。

> 完成 1–7 后，M0 达成：01–07 各册可开始"只写 markdown 即生效"。

---

## 13. 验收标准

- [ ] `docs/user/{zh-CN,en-US}/` 结构建立，各册子目录就位。
- [ ] `docRegistry` 经 glob 按 locale 加载路径式 docId；应用内能打开任意 `docs/user/zh-CN/**` 文档。
- [ ] 文档间相对 `.md` 链接在应用内正确跳转（含跨文档锚点），有测试覆盖。
- [ ] 标题从 H1 提取，tab 名正确；已删文档的陈旧 tab 不崩。
- [ ] 现有 2 篇迁移完成，Welcome/Help 指向新 docId，旧文件删除。
- [ ] 死链检查脚本可运行并能发现断链。
- [ ] `pnpm check` 通过（截取错误）；文档打开/跳转 e2e 冒烟通过。
- [ ] `index.md` 文档中心、术语表基线、样板页就位，供 01–07 引用。
