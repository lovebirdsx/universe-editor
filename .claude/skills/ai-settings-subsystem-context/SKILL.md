---
name: ai-settings-subsystem-context
description: 制作或修改 AI 设置页面（AI Settings editor）相关功能时召回，提供该页面子系统的上下文地图——双栏壳结构、两个分类面板（模型配置 / 功能模型）的文件分布与职责、状态持久化套路、帮助浮层、多语言（NLS）约定、与底层 IAiModelService 的边界。当任务涉及 apps/editor/src/renderer/workbench/ai/ 下的组件、AiSettingsEditorInput、ai.* 命令（pickModel / openSettings / setApiKey…）、provider group / 功能→模型 的图形配置、或要给 AI 设置加新分类 / 新控件 / 新帮助时，先读它建立全局认知。它给「改哪里 + 为什么 + 坑」；新增 AI provider/底层模型服务契约不在此（见 apps/editor/CLAUDE.md 套路 I）。
disable-model-invocation: true
---

# AI Settings 页面 子系统 上下文地图

AI 设置是一个**虚拟 editor**（不是 webview、不是 view），对标 VSCode Settings Editor 的「左侧分类导航 + 右侧内容」双栏范式。本 skill 只讲这个**页面**怎么拼起来；底层 AI 模型服务三层架构（platform 契约 / main 实现 / renderer 门面）、加 vendor、密钥红线见 `apps/editor/CLAUDE.md` **套路 I**——别在这找。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① 页面壳（分类/状态/帮助，`AiSettingsEditor.tsx`）② 某个分类面板（`AiModelsPanel` / `AiFeatureModelsPanel`）③ 选模型命令（`actions/*Actions.ts`）④ 底层服务（`IAiModelService`，**出本 skill**）。

## 文件地图

```
apps/editor/src/renderer/workbench/ai/
  AiSettingsEditor.tsx        双栏壳：CATEGORIES 静态数组（id/icon/label/panel/help）
                              左侧 nav 切换分类 + 右侧 header(标题 + 帮助按钮) + body(滚动容器)
                              状态持久化：activeCategory + per-category scrollTop（IStorageService GLOBAL）
  AiModelsPanel.tsx           分类①「模型配置」：provider group 卡片（baseUrl / apiKey / 模型列表 / 单模型参数）
                              GroupCard（可折叠，折叠态持久化）+ ModelRow（参数配置展开）
                              模型过滤框（per-group 持久化）；自定义模型置顶 + ★ 标记
  AiFeatureModelsPanel.tsx    分类②「功能模型」：chat / inline / commit 三行，数据驱动（FEATURES 数组）
                              点击行 → executeCommand 对应 pickModel 命令 → reload
  AiSettingsHelpButton.tsx    每个分类 header 右上角「?」：点击弹 FocusScopeOverlay + MarkdownView 浮层
  aiSettingsHelpText.ts       两段帮助 markdown（default 英文；中文在 zh-CN.ts 同 key）
  AiSettingsEditor.module.css 全部样式（双栏 + 卡片 + 功能行 + 帮助浮层 + 空状态），只用 --color-* + tokens.css

apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts
                              虚拟 EditorInput，typeId 'aiSettings'，resource universe:/aiSettings，无状态

apps/editor/src/renderer/actions/
  aiActions.ts                PickModelAction(ai.pickModel) / ManageModelsAction(ai.manageModels，标题 Open AI Settings)
                              / OpenAiSettingsJsonAction / Set·ClearApiKeyAction + pickGroup helper
  inlineCompletionActions.ts  PickInlineCompletionModelAction(ai.inlineCompletion.pickModel) 等
  commitMessageActions.ts     PickCommitModelAction(ai.commitMessage.pickModel)
  aiModelPickItems.ts         共享 buildModelPickItems(models, active)：三个 picker 统一的分组/勾选 QuickPick 项

apps/editor/src/shared/i18n/messages/zh-CN.ts   所有 ai.* / aiModels.* / aiFeatures.* / aiSettings.* 中文翻译
```

input→组件注册两处（套路见 apps/editor/CLAUDE.md「编辑器输入」）：
- `workbench/editor/EditorArea.tsx`：`editorComponentMap.set('aiSettings', AiSettingsEditor)`
- `contributions/BuiltInEditorProvidersContribution.ts`：注册 typeId / componentKey / deserialize

## 状态持久化套路（本页核心）

仿 `ScmView` 的写法，**用 `IStorageService` 直接读写，不要建 service**（PersistedStateBase 是给 service 的，这里是组件态）：

```ts
const storage = useService(IStorageService)
// 恢复：挂载时 storage.get(KEY, StorageScope.GLOBAL) → setState；restoredRef 守卫避免首帧把默认值写回
// 持久化：状态变化时 storage.set(KEY, value, StorageScope.GLOBAL)（滚动/输入类 debounce ~200ms）
```

已落地的持久化项与 key：
| 状态 | key | 作用域 |
|---|---|---|
| 当前分类 | `ai.settings.activeCategory` | GLOBAL |
| 各分类滚动位置 | `ai.settings.scroll.<categoryId>` | GLOBAL |
| group 折叠态（整体一个 Record） | `ai.settings.models.collapsed` | GLOBAL |
| 各 group 模型过滤文本 | `ai.settings.models.filter.<groupKey>` | GLOBAL |

> 全用 GLOBAL（AI 配置与 workspace 无关）。滚动恢复要 `requestAnimationFrame` 等面板渲染后再设 `scrollTop`；切换分类前先 flush 旧分类滚动位置。

## 多语言（NLS）约定 —— 最容易写错

机制：`localize(key, defaultMessage, vars?)`，运行时 `messages[key] ?? fallbackMessages[key] ?? defaultMessage`（实现 `packages/platform/src/nls/nls.ts`）。

铁律：
1. **`defaultMessage` 永远写英文**（它是 fallback）。**绝不**把中文写进 default——否则英文环境显示中文。
2. 中文翻译加到 `apps/editor/src/shared/i18n/messages/zh-CN.ts`（同 key）。en-US **不用加**（命中失败回落 default 英文即可）。
3. 帮助 markdown 这类长文本：default（英文）在 `aiSettingsHelpText.ts` 用数组 `.join('\n')`；中文在 zh-CN.ts 同 key 也用 `.join('\n')`。
4. 加新 UI 文本 = 配一个 `localize('aiXxx.yyy', 'English')` + 去 zh-CN.ts 补 `'aiXxx.yyy': '中文'`。
5. 校验某 key 是否漏翻：`rg "localize\(\s*'aiXxx" workbench/ai` 列出 key，比对 zh-CN.ts。

可用语言 `en-US` / `zh-CN`（`shared/i18n/availableLocales.ts`）；NLS 在 `shared/i18n/bootstrap.ts` 用 `configureNls` 装配，跟随设置 `workbench.language`。

## 常见任务 → 改哪里

- **加一个新分类**（如「Agent 设置」）：`AiSettingsEditor.tsx` 的 `CATEGORIES` 加一项（id / lucide icon / label(localize) / panel 组件 / help 函数）；新建 `XxxPanel.tsx`（用 `styles['panel']` 容器）；`aiSettingsHelpText.ts` 加一段 help（英文）+ zh-CN.ts 补中文。分类是**静态数组**，不做 DI 注册表（数量少，避免过度设计）。
- **某分类面板加控件**：优先用 workbench-ui 原子件（`Button`/`IconButton`/`Input`/`Checkbox`/`Badge`）+ `styles` 里 token 化样式；按钮尽量图标化（`IconButton` + lucide，必带 `label`）。
- **加一个功能→模型项**：`AiFeatureModelsPanel.tsx` 的 `FEATURES` 数组加一项（icon / label / desc / command / read）；该功能的 pickModel 命令需已存在（否则先按 actions 套路加）。
- **改选模型 QuickPick 外观**（分组/勾选/描述）：只改 `aiModelPickItems.ts` 的 `buildModelPickItems`，三个 picker 同步生效。
- **加持久化状态**：起一个 `ai.settings.*` 的 GLOBAL key，按上面套路读写 + restoredRef 守卫。
- **改帮助内容/宽度**：内容 `aiSettingsHelpText.ts`(英) + zh-CN.ts(中)；浮层宽度/样式 `AiSettingsEditor.module.css` 的 `.helpPopover`。
- **改命令标题/ID**：`actions/aiActions.ts`。注意命令 ID 不要随便改（状态栏/其它入口在引用）；标题改了记得 zh-CN.ts 对应 `action.ai.*` 同步。

## 关键架构决策与「为什么」

- **激活模型只在「功能模型」分类设置**：chat/inline/commit 的活跃模型由 `AiFeatureModelsPanel` 点击行触发对应命令统一管理。**`AiModelsPanel` 不再有「设为活跃」入口**（曾有，已移除）——模型配置面板只管「配置模型」（baseUrl/key/参数/增删），不管「用哪个」，避免两处重复。
- **点击功能行复用命令而非自造 picker**：`AiFeatureModelsPanel` 直接 `executeCommand('ai.pickModel'…)`，确保和状态栏 model picker 完全一致的体验，零重复逻辑。
- **虚拟 EditorInput 无状态**：`AiSettingsEditorInput` 不存任何东西，页面所有数据 live 读 `IAiModelService`，UI 态（分类/折叠/滚动/过滤）走 IStorageService。这样多窗口/重开行为一致。
- **帮助浮层用 FocusScopeOverlay**：自带 focus trap + Esc + restoreFocus；再叠一个透明 backdrop 实现点击外部关闭。内容走共享 `MarkdownView`（不引新依赖）。
- **样式零硬编码**：只用 `--color-*`（dark 默认 / light 在 `:root[data-theme=light]`，`workbench.css`）+ `tokens.css` 的 spacing/radius/font token，切主题零改动。

## 易踩坑速记

1. **中文写进 localize default**（最常见）：default 必须英文，中文去 zh-CN.ts。见上「NLS 约定」。
2. **`exactOptionalPropertyTypes` 下传 `styles['x']` 给可选 string prop 会报 TS2375**：`styles[...]` 类型是 `string | undefined`。给只接受 `string` 的 prop（如 `MarkdownView.className`）要 `styles['x'] ?? ''`。
3. **滚动恢复设早了不生效**：面板内容异步渲染，`scrollTop` 要在 `requestAnimationFrame` 里设；切分类前先把旧分类的 scrollTop flush 掉。
4. **折叠态是一个整体 Record 存一个 key**，不是每 group 一个 key——读写时整体覆盖。
5. **加了 localize key 忘了补 zh-CN**：英文环境正常、中文环境回落英文，静默不报错。改完用 `rg` 比对一遍。
6. **input→组件注册漏一处**：`EditorArea.tsx` + `BuiltInEditorProvidersContribution.ts` 两处都要有 'aiSettings'，否则页面开不出。

## 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
# 手动（pnpm dev）：命令面板 "AI: Open AI Settings" 打开 → 切分类 / 折叠 group / 过滤 / 点功能行选模型 / 点? 看帮助
#   → 切 workbench.language 为 en-US / zh-CN 验证两套文案 → 切 workbench.colorTheme 验证 dark/light
#   → 切分类+滚动+折叠后重启 app，确认状态恢复
```

## 关键参考路径

- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.tsx` —— 双栏壳 + CATEGORIES + 状态持久化
- `apps/editor/src/renderer/workbench/ai/AiModelsPanel.tsx` —— 模型配置面板（折叠/过滤/置顶/参数）
- `apps/editor/src/renderer/workbench/ai/AiFeatureModelsPanel.tsx` —— 功能→模型（FEATURES 数组）
- `apps/editor/src/renderer/workbench/ai/AiSettingsHelpButton.tsx` + `aiSettingsHelpText.ts` —— 帮助浮层 + 文案
- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.module.css` —— 全部样式（token 化）
- `apps/editor/src/renderer/actions/aiModelPickItems.ts` —— 共享 QuickPick 项构建
- `apps/editor/src/renderer/actions/{aiActions,inlineCompletionActions,commitMessageActions}.ts` —— 选模型命令
- `apps/editor/src/shared/i18n/messages/zh-CN.ts` —— 中文翻译
- 相关：`apps/editor/CLAUDE.md` 套路 I（底层 AI 服务/加 vendor）、`packages/platform/src/nls/nls.ts`（localize 机制）
```
