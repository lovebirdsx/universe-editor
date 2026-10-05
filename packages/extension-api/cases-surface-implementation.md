# cases-surface-implementation

> 本文从 `CLAUDE.md` 拆出，范围是：extension-api 各版面补全的**实现落点与坑**——0.13.0（语言/主题/菜单六块）的 renderer↔host 管线、刻意保留的残留差异，以及 SCM 视图的宿主内置形态。API 清单与各版限制查 `COMPATIBILITY.md`；0.9–0.12 面扩张的运行时机制（openTextDocument 模型级同步、事件推送两护栏、兴趣 lease、findFiles 额度消耗顺序）见 `packages/extension-host/cases-runtime-pitfalls.md`；glob 引擎的两套语义见 `packages/platform/CLAUDE.md`。

## 0.13.0 六块

### 1. contributes.languages

后缀/文件名/glob → 语言 id 的注册表是 renderer 模块单例 `apps/editor/src/renderer/services/languages/LanguageRegistry.ts`；`languageForResource`（`apps/editor/src/renderer/workbench/files/resourceLanguage.ts`）取「**每层扩展声明优先于内置表**」。language-configuration.json（JSONC）**只映五项**——comments / brackets / autoClosingPairs / surroundingPairs / wordPattern（其余字段刻意不映，见 `apps/editor/src/renderer/services/languages/languageConfiguration.ts` 头注释）。Monaco 语言点注册与 grammar 注册共用去重。

### 2. languages.setTextDocumentLanguage

renderer `setModelLanguage` → `DocumentSyncContribution` 监听 `model.onDidChangeLanguage` 统一做 detach + re-attach（close 旧语言 → open 新语言 → fire `onLanguage:`）；手动「更改语言模式」与 API 共用**同一管线**。host 侧 `ExtHostDocuments.whenOpenWithLanguage` waiter 等新文档 open 后 resolve（5s 超时）。

### 3. languages.setLanguageConfiguration

wire 传 DTO（wordPattern 传 **source 字符串**而非 RegExp）；renderer 按 handle 记账 Monaco disposable 以支持撤销。

### 4. semantic tokens 刷新 + range

`onDidChangeSemanticTokens` 的真相：**Monaco 0.55 公开 d.ts 的 `DocumentSemanticTokensProvider` 本就带 `onDidChange?`，且运行时真消费**（`documentSemanticTokens.js` 的 `bindDocumentChangeListeners`）——proxy 挂 Emitter 即可，**勿做「重注册 provider」hack**；另加 range provider 走全链路。

### 5. contributes.colors + ThemeColor

`registerColor` 进 platform colorRegistry 后 `--vscode-<id>` CSS 变量自动生成、随主题更新；装饰 backgroundColor / borderColor 注入 `var(--vscode-*)` 实时追主题。**坑：overviewRulerColor 不能把 `{id}` 透传给 Monaco**——`monacoThemeAdapter`（`apps/editor/src/renderer/services/themes/monacoThemeAdapter.ts`）只把 `editor*` / `diffEditor*` 色进 Monaco 主题，扩展自定义色解析为空；须在 `$createDecorationType` 经 workbenchThemeService 解析成**当次 hex**（切主题不追新，JSDoc 已注明）。

### 6. editor/context 菜单渲染落点

`FileEditor` 置 `contextmenu:false` 关 Monaco 内置菜单；容器 DOM contextmenu 监听 + 自绘 `apps/editor/src/renderer/workbench/editor/EditorContextMenu.tsx`（仿 Explorer 管线，scoped key seed editorHasSelection / editorLangId / editorReadonly / resourceScheme / resourceExtname）。内置剪贴板 / 命令面板 / 加选区到聊天经 `apps/editor/src/renderer/contributions/EditorContextMenuContribution.ts` 注册回 `MenuId.EditorContext`；args[0] = 文档 URI（扩展侧需 revive）。

## 0.13.0 残留差异（未实现清单）

- 通用 ContextMenu 按 group **字典序**排，无 VSCode「navigation 组置顶」特判——刻意不改，怕动全体既有菜单顺序。
- language-configuration 的 indentationRules / onEnterRules / folding 未接。
- `semanticTokenScopes` 贡献点仍缺（自定义 token 着色可直接用标准 token 类型）。

## SCM 视图是宿主内置组件，不走 manifest 翻译

SCM 视图由宿主内置，扩展只 `registerSourceControlProvider`（对标 VSCode）——**在 `contributes.views` 里声明 SCM 视图不会生效**；视图渲染、`scoped` 路径门控都在宿主侧，真插件样板见 `extensions/git`。
