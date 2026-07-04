# Prompt `#` 上下文引用机制 实施计划

> 撰写日期：2026-07-04
> 范围：ACP 会话输入框（`PromptInput`）引入 VSCode Copilot 式的 `#` 上下文引用，让用户在提问时显式挂接
> **工作区符号 / 本地修改(Git) / 打开的编辑器与选区 / 用户文档** 作为上下文。
> 目标形态（已与需求方确认）：**`#` 专管结构化上下文；`@` 保持现状（文件 / 文件夹 mention）**。两个入口职责分明，
> 对现有 `@` 逻辑零改动、增量最小，贴合 VSCode Copilot 心智。

---

## 给执行 agent 的话（纪律 + 关键坐标）

- **这是一个 renderer-only 功能**（除“用户文档”需给 main 侧 `IDocsService` 补一个暴露根路径的方法）。不碰 `vendor/`。
- **优先复用，不要另起炉灶**。现有 `@` mention 管线已经把「token 触发 → popover → 记录引用 → 提交序列化 → 草稿持久化」这套骨架铺好了，`#` 是**同构扩展**，不是重写。
- **序列化通道已就绪**：ACP `ContentBlock` 支持三种承载——`resource_link`（含 `description`/`title`/`_meta`，基线能力必备）、`EmbeddedResource`（`type:'resource'`，内嵌真实文本，需 `promptCapabilities.embeddedContext`）、`text`（兜底）。见 `node_modules/.pnpm/@agentclientprotocol+sdk@0.22.1_*/…/schema/types.gen.d.ts:888`（`ContentBlock`）、`:4014`（`ResourceLink`）、`:1646`（`EmbeddedResource`）。
- **核心文件坐标**：
  - 输入框：`apps/editor/src/renderer/workbench/agents/PromptInput.tsx`
  - `@` 纯函数（照抄范本）：`apps/editor/src/renderer/services/acp/promptMentions.ts`
  - 文件搜索源：`apps/editor/src/renderer/services/acp/mentionFileSearch.ts`
  - 选区上下文（本计划“选区”类直接复用）：`apps/editor/src/renderer/services/acp/promptContext.ts` + `SelectionContextChips.tsx`
  - 草稿持久化：`apps/editor/src/renderer/services/acp/acpPromptDraftCache.ts`
  - popover UI（泛型，可直接复用）：`packages/workbench-ui/src/overlay/PopoverList.tsx`
  - 发送链路：`apps/editor/src/renderer/services/acp/acpSession.ts`（`sendPrompt` L494、`_dispatchPrompt` L534、`_connection.enqueue`）
  - 工作区符号数据源范本：`apps/editor/src/renderer/services/quickInput/providers/WorkspaceSymbolQuickAccessProvider.ts`
  - 语言特性服务：`apps/editor/src/renderer/services/languageFeatures/LanguageFeaturesService.ts`（`getWorkspaceSymbolProviders()` L361）
  - SCM 模型：`apps/editor/src/renderer/services/extensions/ScmService.ts`（`IScmService.sourceControls`）+ 消费范本 `services/scm/ScmDecorationsService.ts`
  - 用户文档：`apps/editor/src/shared/ipc/docsService.ts` + `apps/editor/src/main/services/docs/docsMainService.ts`
- **验证**：`pnpm check`（仅截错误）；涉及输入框交互链路的用 `pnpm e2e`（仅截错误）。
- **测试优先**：纯函数（`extractHashQuery` / 序列化）先写单测；popover 键盘链路补 `PromptInput.test.tsx` 用例。
- 相关记忆：[[acp-prompt-image-feature]]（图片三入口 + chips 范式）、[[opener-service-deeplink-feature]]（定位收敛）、[[session-diff-feature]]。

---

## 1. 背景与可行性结论

### 1.1 结论：合理、低风险、增量小

`#` 方案本质是**复制已有 `@` 管线 + 替换数据源**。现有 `PromptInput` 的触发/弹层/记录/序列化机制天然可泛化，四类上下文源的底层服务**全部已存在**，无需新造取数能力。

### 1.2 触发管线已铺好骨架（`#` 照搬即可）

| 环节 | 现有实现（`@`） | `#` 复用方式 |
|---|---|---|
| caret 感知 token 提取 | `extractMentionQuery`（`promptMentions.ts:46`） | 同构 `extractHashQuery`，词边界规则一致 |
| 弹出层 | `MentionPopover` / `SlashCommandPopover` | 新增 `ContextPopover`（分组渲染），底层复用 `PopoverList` |
| 选中回写文本 | `applyMentionPick`（`promptMentions.ts:100`） | 直接复用（label 前缀改 `#`） |
| 记录引用 | `mentions: PromptMention[]` + `mergeMention` | 新增 `contextRefs: PromptContextRef[]` + `mergeRef` |
| 提交序列化 | `composePromptBlocks`（`promptMentions.ts:123`） | 泛化为同时识别 `@name` 与 `#label`（见 §4） |
| 键盘导航路由 | `WidgetHandle.popoverSelectNext/Prev/Accept/Hide`（`PromptInput.tsx:199-262`） | 加 `hash` 分支到 `popoverStateRef` |
| 互斥优先级 | `slashOpen` 屏蔽 mention（`PromptInput.tsx:480-485`） | slash > (`@` \| `#`)；`@`/`#` 因引导符不同天然互斥（同一 token 只可能命中一种） |
| 草稿持久化 | `AcpPromptDraftCache`（text/mentions/contexts/images/caret） | 追加 `contextRefs` 字段 |

### 1.3 四类上下文源的底层服务均已存在

| 上下文类别 | 数据源（已存在） | 取数范本 |
|---|---|---|
| 工作区符号 | `ILanguageFeaturesService.getWorkspaceSymbolProviders()` → `provideWorkspaceSymbols(query)` | `WorkspaceSymbolQuickAccessProvider.ts`（含 MonacoLoader + `workspaceSymbolsToEntries`） |
| 本地修改(Git) | `IScmService.sourceControls` → `groups` → `resources`（每项含 `resourceUri` + 状态字母 `contextValue`） | `ScmDecorationsService.ts` |
| 打开的编辑器/选区 | `IEditorGroupsService.groups[].editors`（打开的）+ 活动编辑器选区 → 复用 `SelectionContext` | `promptContext.ts` + `SelectionContextChips.tsx` + “Add Selection to Agent Chat” 命令 |
| 用户文档 | `IDocsService`（内容 map）+ main 侧磁盘根 `docs/user/<locale>/`（plain files，外部 agent 可直接读盘） | `docsMainService.ts`（注释明确 “lets external agents read the guides straight off disk”） |

### 1.4 语义对齐（加分项，非冲突）

本产品全局 quick open 里 `#` 已经等于「工作区符号」（`QuickAccessContribution.ts:57`），与 VSCode / Copilot 心智一致。`PromptInput` 是独立 `textarea`，与 quick open **无冲突**，`#` 复用反而强化一致心智。

---

## 2. 目标形态与交互设计

### 2.1 触发与优先级

- 用户在输入框任意位置键入 `#`，若光标处于 `#<query>` token 内（token 至下一个空白结束），弹出**上下文引用面板**。
- **优先级链**：整行 `/` slash 命令（行级）> `@` mention / `#` 上下文引用（caret-token 级）。`@` 与 `#` 因引导符不同、token 内无空白，同一时刻只会命中其一，天然互斥。
- **误触发无副作用**：沿用 `@` 的“不选中即当纯文本”策略——`#123`、`#fff`、markdown 标题这类正文 `#` 只会短暂弹层，不选中就不产生任何上下文块。后续可加“`#` 后须紧跟字母”等收敛规则（§8 风险）。

### 2.2 面板结构（分组）

`#` 面板按类别分组展示（VSCode Copilot 式）：

```
#<query>
├─ 符号        foo()  bar   Baz…          （来自 workspace symbol providers）
├─ 本地修改    M src/a.ts   A src/b.ts…    （来自 SCM working tree）
├─ 选区/编辑器 当前选区 a.ts:12-40 · 打开的 b.ts…
└─ 用户文档    📘 编辑器使用文档（整体入口，选中即告知 agent 文档位置）
```

- query 为空：每组各展示前 N 项（符号组走 match-all，参照 workspace symbol 的 stale-while-revalidate）。
- 有 query：各组内 fuzzy 过滤（复用 `fuzzyScore` / `fuzzyMatchField`，`@universe-editor/workbench-ui`）。
- **用户文档是“整体入口”而非逐篇候选**（见 §2.4）。

### 2.3 选中后的表现

统一采用**内联 token + 记录 ref**（与 `@` 对称）：选中后在文本插入 `#<label>`，并在 `contextRefs` 记录解析信息；提交时把匹配的 `#<label>` 展开为对应 `ContentBlock`；用户删除该 token 则引用自动失效（沿用 `@` 的 by-name 语义，`promptMentions.ts` 顶部注释）。

例外——**选区类**继续用 chips（`SelectionContextChips`，已存在，不改其展示范式），因为它需要显示行范围与内容 tooltip。即：
- 符号 / 打开的编辑器文件 / 本地修改文件 / 用户文档 → 内联 `#label` token。
- 当前选区 → 复用现有 chip 区（`#` 只是多提供一个“把当前选区加入”的入口）。

### 2.4 用户文档的特殊语义（需求方明确）

> “用户文档只要告知 agent 文档的读取位置即可，不需要用户去选择对应的文档。场景是：用户针对编辑器用法提问，agent 可以搜索文档后回复。”

因此“用户文档”**不下钻到具体文档**，而是面板里的**单一整体条目**（如 `📘 编辑器使用文档`）。选中后附加一条上下文，告诉 agent：文档位于 `<绝对路径>`，按 locale 分子目录，回答编辑器用法问题时可自行检索。agent（Claude/Codex）用其文件工具 grep 即可。

---

## 3. 架构：统一上下文引用模型

### 3.1 新增类型 `PromptContextRef`

新建 `apps/editor/src/renderer/services/acp/promptContextRef.ts`：

```ts
export type PromptContextRefKind = 'symbol' | 'scmChange' | 'openEditor' | 'docs'

export interface PromptContextRef {
  readonly kind: PromptContextRefKind
  /** 插入文本的 #label（去掉前缀 #），也是提交时 by-name 匹配键。 */
  readonly label: string
  /** 目标资源 URI（docs 类为文档根目录 URI）。 */
  readonly uri: string
  /** kind 相关的定位/展示补充，序列化时决定走 resource_link/_meta 还是 embedded。 */
  readonly meta?: {
    readonly line?: number
    readonly column?: number
    readonly symbolKind?: number
    readonly scmStatus?: string
    readonly description?: string
  }
}
```

> 选区类**不进** `PromptContextRef`——它已有 `SelectionContext`（`promptContext.ts`），继续独立走。

### 3.2 数据流

```
用户键入 #query
  → extractHashQuery(text, caret)                    (promptContextRef.ts 纯函数)
  → ContextSuggestionProvider.query(query)           (聚合四类源，见阶段 1-4)
  → ContextPopover 渲染 (PopoverList)
  → 选中 → applyMentionPick 回写 #label + mergeRef 记录 contextRef
  → 草稿持久化 (AcpPromptDraftCache.contextRefs)
提交 (PromptInput.submit)
  → session.sendPrompt(text, mentions, contexts, images, contextRefs)
  → _dispatchPrompt / enqueue
  → composePromptBlocks(text, mentions, contextRefs)  (泛化：@ 与 # 一次 walk)
  → [ ...selectionBlocks, ...imageBlocks, ...body(含 resource_link/embedded) ]
```

### 3.3 数据源聚合器

新建 `apps/editor/src/renderer/services/acp/contextSuggestions.ts`：暴露一个 provider 集合，每个 provider 负责一类，返回 `{ groupLabel, items: ContextSuggestionItem[] }`。`PromptInput` 只依赖聚合结果，不感知各源细节。各 provider 内部分别注入 `ILanguageFeaturesService` / `IScmService` / `IEditorGroupsService` / `IDocsService`。

---

## 4. 序列化决策表（提交时 `PromptContextRef` → `ContentBlock`）

| kind | 通道 | 形状 | 说明 |
|---|---|---|---|
| `symbol` | `resource_link` | `{ uri, name: label, description: '<kind> <relPath>:<line>', _meta: { symbol: { line, column, kind } } }` | `resource_link` 无原生 range，行列进 `_meta`；agent 可据此定位 |
| `openEditor` | `resource_link` | `{ uri, name: label }` | 与 `@` 文件一致，仅来源是“已打开” |
| `scmChange` | `resource_link` | `{ uri, name: label, description: '<status>' }` | **首批**：只给路径 + 状态字母，agent 自行读 diff。内嵌真实 `git diff`（`EmbeddedResource`，`mimeType:'text/x-diff'`）列为增强（§7） |
| `docs` | `text`（+ 可选 `resource_link`） | text：`编辑器用户文档位于 <absRoot>，按 locale 分子目录（zh-CN/…），回答编辑器用法问题时可检索。` | 目录型 `resource_link` agent 未必会自动展开，故以 text 说明为主、`resource_link` 指向根目录为辅 |
| 选区（非 ref，独立） | 复用 `composeContextBlocks` | `EmbeddedResource`（支持 `embeddedContext`）或 fenced text | 已存在，不改（`promptContext.ts:52`） |

**泛化 `composePromptBlocks`**（`promptMentions.ts:123`）：现仅硬编码识别 `@name`。改为一次 walk 内同时识别 `@`（查 `mentions`）与 `#`（查 `contextRefs` 的 `label`），按命中项类型产出 `resource_link` / `text`。同一 token 只可能是一种前缀，无歧义。保持“未记录的 `@x`/`#x` 留作纯文本”语义。

---

## 阶段 0 · 契约与骨架（无 UI 行为变化）

**目标**：铺好类型、纯函数、序列化与持久化通道，先用单测锁定，不接 UI。

- [ ] 0.1 新增 `promptContextRef.ts`：`PromptContextRef` 类型 + `extractHashQuery(text, caret)`（照抄 `extractMentionQuery` 的 caret/边界规则，引导符换 `#`）+ `mergeRef(prev, next)`（by-label 去重，照抄 `mergeMention`）。
- [ ] 0.2 泛化 `composePromptBlocks(text, mentions, contextRefs?)`：一次 walk 识别 `@`/`#`，`#` 命中 ref 时按 §4 产出块；新增 `composeContextRefBlock(ref)` 纯函数做 kind→block 映射。
- [ ] 0.3 `AcpPromptDraft` 增加 `contextRefs?: readonly PromptContextRef[]`（`acpPromptDraftCache.ts:14`）。
- [ ] 0.4 `sendPrompt` / `_dispatchPrompt` / `_connection.enqueue` 增加 `contextRefs` 形参并透传（`acpSession.ts:494/534` + 队列结构）。默认空数组，保持既有调用兼容。
- [ ] 0.5 单测：`extractHashQuery`（含 `#` 在词中/行首/空格后/caret 越界）、`composePromptBlocks`（`@`+`#` 混排、未记录 token、各 kind 映射）。

**验证**：`pnpm check`（仅错误）。此阶段完成后现有行为完全不变。

---

## 阶段 1 · 工作区符号（`#symbol`）

**目标**：`#` 面板“符号”组可用，选中插入 `#符号名`，提交产出带 `_meta` 的 `resource_link`。

- [ ] 1.1 新建 `contextSuggestions.ts` 的 symbol provider：注入 `ILanguageFeaturesService` + `IWorkspaceService` + `IUriIdentityService`，`MonacoLoader.ensureInitialized()` 后调 `getWorkspaceSymbolProviders()`，对 query 聚合、`workspaceSymbolsToEntries` 归一、`fuzzyScore` 排序。**直接抽取 `WorkspaceSymbolQuickAccessProvider.ts` 的逻辑**（debounce、seq 乱序守卫、empty-query 缓存），避免重复实现。
- [ ] 1.2 归一为 `ContextSuggestionItem`：`{ kind:'symbol', label:符号名, uri, description:relPath:line, meta:{ line, column, symbolKind } }`；图标复用 `symbolIconId`（`workbench/symbols/symbolIcon.ts`）。
- [ ] 1.3 序列化：`composeContextRefBlock` 的 `symbol` 分支按 §4 产出。

**验证**：`pnpm check`；手动在 TS/Markdown 工作区键 `#` 验证候选与提交块。

---

## 阶段 2 · 本地修改 / Git（`#change`）

**目标**：`#` 面板“本地修改”组列出工作树变更文件，选中插入 `#路径`，提交产出带状态的 `resource_link`。

- [ ] 2.1 symbol 之外新增 scm provider：注入 `IScmService`，读 `sourceControls → groups → resources`，取 `resourceUri` + `contextValue`（状态字母，参照 `ScmDecorationsService.ts:90-102` 的读法）。多 repo/submodule 场景按 `rootUri` 归属（记忆 [[scm-submodule-multirepo]]）。
- [ ] 2.2 归一为 `{ kind:'scmChange', label:relPath, uri, meta:{ scmStatus } }`；用状态字母做行首徽标（复用 SCM 颜色/字母约定）。
- [ ] 2.3 序列化：`scmChange` 分支产出 `resource_link { uri, name, description:'<status>' }`。
- [ ] 2.4（可选，增强）内嵌 diff：若要把真实 `git diff` 喂给 agent，走 `EmbeddedResource`，diff 文本取数参照 dirty-diff 的 `git diff -U0` 通道（记忆 [[dirty-diff-inline-peek-feature]]）。**首批默认关闭**，仅在 agent 支持 `embeddedContext` 且配置开启时启用。

**验证**：`pnpm check`；在有改动的 git 工作区键 `#` 验证变更列表与提交块。

---

## 阶段 3 · 打开的编辑器与选区（`#editor` / 当前选区）

**目标**：`#` 面板提供“当前选区”“打开的编辑器”两类条目；选区复用现有 chip 管线，打开的编辑器走 `resource_link`。

- [ ] 3.1 openEditor provider：注入 `IEditorGroupsService`，枚举 `groups[].editors` 中的 `FileEditorInput`，去重（`IUriIdentityService.isEqual`），归一为 `{ kind:'openEditor', label:relPath, uri }`。
- [ ] 3.2 当前选区条目：复用“Add Selection to Agent Chat”命令构造 `SelectionContext` 的逻辑（定位其实现，抽出共享 helper 到 `promptContext.ts`，避免复制）；选中后**走现有 `contexts` state + `SelectionContextChips`**，不进 `contextRefs`。
- [ ] 3.3 面板里两类同组展示，但接受时分派到不同落点（选区→chips；打开的编辑器→内联 token）。

**验证**：`pnpm check`；打开若干 tab、选中一段代码，键 `#` 验证两类条目与各自落点。

---

## 阶段 4 · 用户文档（`#docs` 整体入口）

**目标**：`#` 面板一个“编辑器使用文档”条目，选中即注入“文档位置”上下文，供 agent 检索。

- [ ] 4.1 main 侧暴露文档根绝对路径：`IDocsService` 增加 `getDocsRoot(): Promise<string>`（`docsService.ts` 契约 + `docsMainService.ts` 实现，复用其 `_resolveRoot()`）。经 `ProxyChannel` 过 IPC（通道名走 `shared/ipc/channelNames.ts`，套路 C）。
- [ ] 4.2 docs provider：query 命中“文档/docs/帮助/使用”等关键词或 query 为空时展示单条 `{ kind:'docs', label:'编辑器使用文档', uri: file://docsRoot }`。
- [ ] 4.3 序列化：`docs` 分支按 §4 产出 text 说明块（含绝对路径 + locale 子目录提示）；可附 `resource_link` 指向根目录。文案走 `localize`。
- [ ] 4.4 因是“整体入口”，选中后建议以 chip 呈现（如“📘 编辑器文档”），或内联 `#编辑器使用文档` token，二选一（实现时取更简洁者，默认内联 token 与其它 `#` 一致）。

**验证**：`pnpm check`；选中该条目并提问，确认 agent prompt 里带上了文档路径说明（可在 `_dispatchPrompt` 加调试输出核对最终 `prompt` blocks）。

---

## 阶段 5 · UI 接线与草稿收口

**目标**：把四类 provider 接进 `PromptInput`，补齐 popover、键盘导航、草稿持久化。

- [ ] 5.1 新增 `ContextPopover.tsx`（分组版 `PopoverList`，参照 `MentionPopover.tsx`）；分组头 + 每组 fuzzy 结果。
- [ ] 5.2 `PromptInput.tsx` 加 `#` 档：
  - state：`hashIndex` / `hashDismissed` / `contextRefs`（`useState`，初值从 `AcpPromptDraftCache` 读）。
  - `hashQuery = slashOpen ? null : extractHashQuery(text, caret)`；`hashOpen = hashQuery !== null && !hashDismissed && workspaceRoot`。
  - `mentionQuery` 计算追加排除 `hashOpen`（对称 `slashOpen`）。
  - `popoverOpen = slashOpen || mentionOpen || hashOpen || historyOpen`。
  - JSX 三元链加一档 `ContextPopover`（`PromptInput.tsx:870-895`）。
  - `onChange` 里 `#` token 消失时 `setHashDismissed(false)`（对称 mention，`:915-918`）。
- [ ] 5.3 `popoverStateRef` + `WidgetHandle` 四个方法加 `hash` 分支（`PromptInput.tsx:199-262`、`:652-667`）：Next/Prev/Accept/Hide 路由到 `#` 面板。
- [ ] 5.4 接受回调 `acceptContextRef(item)`：`applyMentionPick` 回写 `#label`（复用，前缀改 `#`）+ `mergeRef` + `setHashDismissed(true)` + caret 恢复（照抄 `acceptMention`，`:541-557`）。
- [ ] 5.5 草稿：`useEffect` 的 save/clear 纳入 `contextRefs`（`:351-357`）；`submit` 清理 `contextRefs` + 传参给 `sendPrompt`（`:689-704`）。
- [ ] 5.6 provider 数据懒加载：首次键 `#` 才拉取（对称 mention 的 `loadWorkspaceFiles` 懒加载，`:488-499`）；符号组 debounce 150ms。

**验证**：`pnpm check`；`pnpm e2e`（输入框交互链路，仅错误）。

---

## 阶段 6 · 测试、文档与收尾

- [x] 6.1 `PromptInput.test.tsx` 补：键 `#` 弹面板、方向键导航、Enter 接受插入 `#label`、Esc 关闭、`@`/`#` 互斥、slash 优先。
- [x] 6.2 各 provider 单测（symbol/scm/openEditor/docs 归一 + fuzzy）——`contextSuggestions.test.ts` 已覆盖。
- [x] 6.3 序列化单测已在阶段 0；补各 kind 端到端 block 快照——`promptContextRef.test.ts` 已覆盖。
- [ ] 6.4（可选，未做）视需要加一条 `@p1` E2E：键 `#`、选一个符号、发送、断言 timeline 用户消息携带引用。单测已覆盖弹窗交互 + 序列化两端，暂不加 E2E。
- [x] 6.5 用户可见功能变更：同步 `docs/user/zh-CN/ai-agent/first-session.md`「进阶技巧」新增一条 `#` 引用说明；`pnpm docs:check` 通过（40 files, no broken links）。
- [x] 6.6 i18n：所有面板文案、组标题、占位符走 `localize`；`en-US.ts` 无需补 `acp.contextRef.*`——该文件只收「默认英文文案需要覆盖」的条目，源码里 `localize()` 的 defaultMessage 本身已是正确英文文案。

**验证**：`pnpm check`（35/35 通过，3283+23 测试）+ `pnpm e2e`（仅错误，151+3 通过，0 失败）+ `pnpm docs:check`（通过）。

---

## 5. 建议的实现顺序与里程碑

```
M0 契约骨架     → 阶段 0（类型 + 纯函数 + 序列化 + 持久化，单测锁定，零行为变化）
M1 首个源打通   → 阶段 1（工作区符号）+ 阶段 5 的最小接线（先只接 symbol，验证全链路）
M2 其余三源     → 阶段 2 本地修改 → 阶段 3 选区/编辑器 → 阶段 4 用户文档
M3 收口         → 阶段 5 剩余（草稿/键盘）+ 阶段 6（测试/文档/i18n）
```

每接一个 provider 即可在应用内自测，不必等全部完成。

---

## 6. 可选重构评估（阶段 0 末决策）

现状 `PromptInput` 的 slash/mention/history 三套 popover 是**平行手写**的 state（index/dismissed/matches）。再加 `#` 会成第四套。若发现 `PromptInput` 膨胀明显，评估抽 `useSuggestionPopover` hook 统一“query→matches→index→accept→dismiss”生命周期。

- **默认**：`#` 先按现有平行范式加入（风险最低、与现有测试一致）。
- **触发重构的信号**：四套 state 出现明显重复且键盘路由分支难维护时，再抽 hook，单独一次提交、单独回归。

不要在功能落地的同时做大重构（避免混淆回归来源）。

---

## 7. 增强项（本期非必须，登记备忘）

- 本地修改内嵌真实 `git diff`（`EmbeddedResource`，复用 dirty-diff 的 `git diff -U0` 通道，见 [[dirty-diff-inline-peek-feature]]）。
- 符号引用内嵌符号定义片段（而非仅 `resource_link`），提高 agent 命中率。
- 用户文档从“告知路径”升级为“检索命中片段直接内嵌”（需在 renderer 侧做一次轻量全文检索）。
- `#` 收敛规则（`#` 后须字母、跳过 markdown 标题行首）降低误弹。

---

## 8. 风险与注意

- **`#` 误触发**：`#` 在正文比 `@` 更常见（`#123`/`#fff`/标题）。缓解：沿用“不选中即纯文本”零副作用策略；必要时加 §7 收敛规则。
- **符号取数成本**：workspace symbol 依赖各语言服务懒激活（打开对应语言文件才注册）。冷启动可能空列表——照搬 `WorkspaceSymbolQuickAccessProvider` 的 stale-while-revalidate + debounce + seq 乱序守卫，勿自造。
- **`_meta` 依赖 agent 配合**：`resource_link._meta.symbol` 是我方约定，agent 未必消费。定位信息务必**同时**放进 `description`（人类可读、agent 也能从文本理解），`_meta` 作结构化增强。
- **`embeddedContext` 能力门**：内嵌类块须先查 `promptCapabilities.embeddedContext`（选区已有 `_embeddedContextSupported`，`acpSession.ts`），不支持则降级 text。
- **草稿兼容**：`AcpPromptDraft` 加字段属纯附加；旧草稿无 `contextRefs` 时按空数组处理（项目开发期不需向后兼容，但 draft 是内存态，直接加即可）。
- **Action2 async accessor 失效**：若新增命令入口（如“从选区加入”），async run 首个 `await` 前同步取完 service（记忆 [[action2-async-accessor-invalidation]]）。
- **disposable 生命周期**：provider 若持订阅/定时器，务必 `this._register` / `disposables.add`，避免 e2e 泄漏红（记忆 [[opener-service-deeplink-feature]] 的坑）。

---

## 9. 验证命令

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 输入框交互链路冒烟，仅截错误
pnpm docs:check   # 用户文档死链校验（若改了 docs/user）
```
