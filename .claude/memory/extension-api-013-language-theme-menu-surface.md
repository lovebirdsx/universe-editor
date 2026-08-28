---
name: extension-api-013-language-theme-menu-surface
description: extension-api 0.13.0 面补全:contributes.languages/colors、setTextDocumentLanguage、setLanguageConfiguration、semantic tokens 刷新+range、ThemeColor、editor/context 渲染(为 Rainbow CSV 类移植铺路)
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-19T16:04:02.952Z
---

2026-08-20,为移植 Rainbow CSV 类「自定义语言 + 动态高亮」扩展,extension-api 0.12.1→0.13.0 一轮面补全(变更细节见 `packages/extension-api/COMPATIBILITY.md` 0.13.0 条)。六块:

1. **contributes.languages**:后缀/文件名/glob→语言 id 注册表(renderer 模块单例 `services/languages/LanguageRegistry.ts`,`languageForResource` 每层扩展声明优先于内置表);language-configuration.json(JSONC)生效 comments/brackets/autoClosingPairs/surroundingPairs/wordPattern 五项;Monaco 注册与 grammar 共用 `TextMateService._registerMonacoLanguagePoint` 去重。
2. **languages.setTextDocumentLanguage**:renderer `setModelLanguage` → `DocumentSyncContribution` 监听 `model.onDidChangeLanguage` 统一做 detach+re-attach(close 旧语言→open 新语言→fire `onLanguage:`),手动「更改语言模式」与 API 同一管线;host 侧 `whenOpenWithLanguage` waiter 等新文档 open 后 resolve(5s 超时)。
3. **languages.setLanguageConfiguration**:wire 传 DTO(wordPattern 传 source 字符串),renderer 按 handle 记账 Monaco disposable。
4. **semantic tokens**:`onDidChangeSemanticTokens` 刷新——**Monaco 0.55 公开 d.ts 的 DocumentSemanticTokensProvider 本就带 `onDidChange?`,运行时真消费**(documentSemanticTokens.js bindDocumentChangeListeners),proxy 挂 Emitter 即可,无需重注册 hack;另加 range provider 全链路。
5. **contributes.colors + ThemeColor**:registerColor 进 platform colorRegistry 后 `--vscode-<id>` CSS 变量自动生成随主题;装饰 backgroundColor/borderColor 注入 `var(--vscode-*)` 实时追新;**坑:overviewRulerColor 不能透传 `{id}` 给 Monaco**——monacoThemeAdapter 只把 `editor*`/`diffEditor*` 色进 Monaco 主题,扩展自定义色解析为空,须在 `$createDecorationType` 时经 workbenchThemeService 解析成当次 hex(切主题不追新,JSDoc 注明)。
6. **editor/context 菜单渲染**:FileEditor `contextmenu:false` 关 Monaco 内置菜单,容器 DOM contextmenu 监听 + 自绘 `EditorContextMenu.tsx`(仿 Explorer 管线,scoped key seed editorHasSelection/editorLangId/editorReadonly/resourceScheme/resourceExtname);内置剪贴板/命令面板/加选区到聊天项经 `EditorContextMenuContribution` 注册回 `MenuId.EditorContext`;args[0]=文档 URI(扩展侧需 revive)。

已知差异:通用 ContextMenu 按 group 字典序排,无 VSCode「navigation 组置顶」特判(刻意不改,怕动全体既有菜单顺序);language-configuration 的 indentationRules/onEnterRules/folding 未接;`semanticTokenScopes` 贡献点仍缺(彩虹着色可直接用标准 token 类型)。

版本 bump 三件套:`src/index.ts` version 常量 + package.json + COMPATIBILITY.md 记录,再跑 `pnpm ext-packages:gen` 物化 sdkVersions(publish.mjs 有一致性拦截)。相关 [[extension-api-09-surface-expansion]] [[extension-system-progress]]
