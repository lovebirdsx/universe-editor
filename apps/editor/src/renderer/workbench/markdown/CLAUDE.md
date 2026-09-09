# apps/editor/src/renderer/workbench/markdown/CLAUDE.md

markdown 子系统横跨三处：共享渲染器 MarkdownView 在本目录；语言特性插件在 `extensions/markdown/`（进程内 vscode-markdown-languageservice）；预览/成链等 renderer 增强散在 `workbench/editor/`、`contributions/`、`services/`。本文是 markdown 子系统的上下文地图（处理相关任务前通读）。

> ⚠️ 第一原则：先认领改动落在哪条线——① 语言特性（走插件+句柄路由，与 TS 共用同一套句柄路由/数据流，通用套路见 [extend-language-plugin]）② 预览渲染（纯 renderer，与 LSP 无关）③ 粘贴成链（拖拽/粘贴→链接，纯 renderer 编辑增强，不经插件/LSP）。三条线几乎不相交，改错线白改。

## 与 typescript 插件的差异速查

| 维度 | markdown 插件 |
|---|---|
| 运行方式 | **进程内库**：`createMdServer()` 直接在 ext host 跑 vscode-markdown-languageservice + markdown-it，无子进程/stdio/路径解析，无崩溃恢复问题 |
| 文件读取 | 经 host 的 `workspace.fs` 网关（`mdFsBridge`），受 path policy 约束（敏感目录拒、禁越界） |
| 诊断触发 | debounce-then-pull：文档变 → 200ms 防抖 → `$computeDiagnostics` 主动算 → push |
| wire 类型 | 复用 `vscode-languageserver-types`，`$provideXxx` 直返原生类型零转换透传（唯一规整：`$provideDefinition` 归一 `Location[]`） |
| 额外特性 | 预览 + 粘贴/拖拽成链 + 二进制图片落盘 assets/（TS 都没有） |
| 打包 | 插件 dist 自包含（esbuild bundle 进 LS），无额外 node_modules |

## 线①：语言特性

数据流走 [extend-language-plugin] 的 A/B/C/D 四条；renderer 侧完全复用 TS 的句柄路由壳（MainThreadLanguages / languageProviderProxy / lspMonacoConvert / DocumentSyncContribution），**renderer 不加 markdown 专属代码**。

```
extensions/markdown/src/
  extension.ts   activate：createMdServer → 注册 13 类 provider（selector=['markdown']；completion 触发字符 ['[','(','#','/']）
                 + 两条 server 命令 + createDiagnosticCollection('markdown') + 文档同步；DIDCHANGE_DEBOUNCE_MS=200
  mdFsBridge.ts  IMdClient：$readFile/$stat/$readDirectory/$findMarkdownFiles 全经 workspace.fs；扫描忽略 node_modules/.git/dist/out/.turbo
  server/        进程内库（不是子进程）：mdServer.ts=createMdServer+IMdServer+DIAGNOSTIC_OPTIONS；
                 documentStore.ts=已打开文档 overlay；lspWorkspace.ts=IWorkspace 适配（overlay 先答，未打开走 mdFsBridge）；
                 types.ts=IMdServer/IMdClient/MdFileStat/MdTextDocumentDto
  __tests__/mdServer.test.ts  stub IMdClient 驱动真实 language service
```

诊断 owner = `'markdown'`，必须与 `setModelMarkers` 的 owner 一致。

## 线②：预览渲染（与 LSP/插件无关）

```
actions/markdownActions.ts                Open Preview (ctrl+shift+v) / to Side (ctrl+k ctrl+v)
services/editor/MarkdownPreviewInput      虚拟 input（scheme 'markdown-preview'，可序列化恢复，按 sourceUri 去重）
workbench/editor/MarkdownPreviewEditor.tsx  源文件 open 时跟 Monaco model 实时刷新，否则 fileService 读盘
workbench/editor/useMarkdownSyncScroll.ts   预览↔源 同步滚动
workbench/markdown/MarkdownView.tsx       渲染核心：parseMarkdown AST → React 元素，不输出 raw HTML（React 转义 + SafeLink）
services/acp/markdownRenderer.ts          parseMarkdown —— 与 ACP 聊天共享的 AST
```

input→组件两处注册：`EditorArea.tsx` 的 `editorComponentMap` + `BuiltInEditorProvidersContribution.ts`，漏一处预览开不出。

> MarkdownView 是**共享渲染器**（ACP 聊天 + 文档预览都用它），改它要同时顾及两个消费方。

**页内锚点**：标题自动 slug（CJK 保留）挂 `data-anchor`；空 HTML 锚点 `<a id="x"></a>` / `<a name="x"></a>` 被 parser 白名单识别（其余 HTML 仍是字面文本），渲染为零占位 `.mdAnchor`（**CSS 必须 `vertical-align: top`**——baseline 会让 scrollIntoView 对齐文字基线、落点偏下一行，已修勿回退；回归 e2e `smoke.markdownAnchorScroll.spec.ts`）。`#frag` 点击/跨文件 `foo.md#frag` 收口 `markdownAnchors.ts::findMarkdownAnchor`：先精确匹配 id（大小写敏感），未命中再 slugify 回退。已知限制：LSP 坏链诊断只认 `id=` 不认 `name=`——锚点统一写 `<a id="..."></a>`。

## 线③：粘贴/拖拽成链（纯 renderer，Monaco documentPasteEditProvider / documentDropEditProvider）

按住 **Shift** 拖进、或粘贴进 markdown 编辑器 → 自动生成链接：文件→`[text](相对路径)`、图片→`![alt](…)`、URL→`[选中文本](url)`；无磁盘路径的二进制图片落盘当前 md 同目录 `assets/` 再成链。产出是 **snippet**（链接文字 `${n:…}` 占位），落地后自动选中。

```
contributions/markdownPasteLinks.ts          纯函数：markdownLinksFromUriList / markdownLinkFromUrl / markdownLinkSnippet（产 snippet）；共享原语 isImagePath / encodeLinkTarget
contributions/markdownAssetLinks.ts          纯函数：mime→ext / 时间戳命名 / markdownLinkForPath
contributions/markdownAssetDropper.ts        saveDroppedImageAsset：assets/ 落盘 + 同秒去重（注入 @IFileService）
contributions/markdownLinkProviderShared.ts  drop/paste 共享内核 computeMarkdownLinkInsert
contributions/MarkdownPasteContribution.ts / MarkdownDropContribution.ts  注册 provider（对称）
```

注册：`contributions/registration/afterRestore.ts`（markdownPaste + markdownDrop）。

**⚠️ drop 双触发 + Shift 门控（本功能核心）**：不按 Shift＝拖入正文仍打开文件（原习惯）；**按住 Shift** 才在光标处插链接。`FileEditor` 各语言 `dropIntoEditor` 基线一律 `{enabled:false}`。四点联动，缺一即冲突或漏门控：
1. `FileEditor.tsx`：基线 create 时设 + model-swap effect 复位（编辑器实例跨 tab 复用）；容器上 **capture 阶段** dragover 按 `e.shiftKey && 当前 model 是 markdown` 实时 `updateOptions({dropIntoEditor})`。原因：Monaco 的 `isDropIntoEnabled()` 只看 readOnly+enabled 且触发时实时读，其 DragAndDropObserver 用 bubble 监听同一元素——capture 先跑才能就位。**切勿在 capture 的 drop 阶段复位 enabled**（抢在 Monaco bubble drop 前关掉，Shift 拖放失效）。
2. Monaco 的 drop 监听既不 preventDefault 也不 stopPropagation → drop 先插链接再冒泡到 body，双触发；`EditorGroupView.shouldDeferDropToMarkdownEditor(target, activeEditor, shiftKey)`：Shift 为真 + 活动编辑器是 markdown FileEditorInput + 落点在 `.monaco-editor` 内 → 不 openDroppedResources。**拖到标签栏仍打开文件**；粘贴不受 Shift 门控。

**⚠️ snippet 必须靠自定义 bulkEdit 执行**：provider edit 必须返回 `{snippet}`（不是字符串 `insertText`）。本仓库 `services/languageFeatures/typescript/fileBulkEditService.ts` 覆盖了 `IBulkEditService`，默认实现和它**都不解释 snippet** → `${1:text}`/`$0` 会当字面文本写入。它的 `apply(edits, {editor})` 接住 Monaco 传的第二参：`insertAsSnippet===true` 且目标是该 editor 当前 model 时走 `SnippetController2.get(editor).insert(text)`，否则维持原逻辑；无 editor 兜底 `stripSnippet()` 剥语法。

> Monaco 的 paste/link/hover/completion/reference 等内部 registry **无公开 `monaco.languages.*` API**，只能经 `MonacoLoader.getLanguageFeaturesService()`（shim 声明在 `renderer/monaco-shims.d.ts`）；e2e 探针读 registry 也走它。

## 关键架构决策

- **坏链诊断是头牌特性**：`DIAGNOSTIC_OPTIONS` 开 warning，definition-hygiene 降 hint。
- **预览不复用 markdown-it 直出 HTML**：parseMarkdown AST + React 渲染，杜绝 untrusted 注入 raw HTML（安全），与 ACP 聊天共享。

## 常见任务 → 改哪里

- **加一类新 provider**（hover/folding/code action…）：走 [extend-language-plugin] 任务 1 全套（rpc 枚举 + KEEP IN SYNC 三处 + renderer 句柄壳）；markdown 端只加 `server/mdServer.ts` 的 `$provideXxx` + `server/types.ts` 接口 + `extension.ts` 一行 register（零转换透传）。
- **调诊断规则/级别**：`server/mdServer.ts` 的 `DIAGNOSTIC_OPTIONS`；链路排查见 [extend-language-plugin] 任务 4 + 下方盘符坑。
- **诊断防抖时长**：`extension.ts` 的 `DIDCHANGE_DEBOUNCE_MS`。
- **fs 行为**（扫描忽略目录/容错/新增 client 方法）：`mdFsBridge.ts`（+ `server/types.ts` 的 IMdClient + `server/lspWorkspace.ts`）。
- **预览渲染/样式/同步滚动**：线② 对应文件，**完全不碰插件**。
- **预览命令/键位/菜单**：`actions/markdownActions.ts`（对标 VSCode：`ctrl+shift+v` / `ctrl+k ctrl+v`）。
- **粘贴/拖拽成链行为**：纯函数在 `markdownPasteLinks.ts`（含 snippet）/`markdownAssetLinks.ts`/`markdownAssetDropper.ts`（优先在这加单测），共享内核 `markdownLinkProviderShared.ts`，注册/注入 Paste/DropContribution；**snippet 插入+选中**在 `fileBulkEditService.ts`；「拖入 vs 打开」分流 + Shift 门控在 `FileEditor.tsx` + `EditorGroupView.tsx`。**不碰插件**。
- **YAML frontmatter**（文首 `---…---` 块）三条线都碰：线① 诊断/documentLink 屏蔽——`server/frontmatter.ts::detectFrontmatterRange` + `mdServer.ts::tokenizeWithFrontmatter` 向 parser.tokenize 注入合成 `code_block` token（根因：LS 无 frontmatter 感知，NoLinkRanges 只跳 code_block/fence/html_block，加 front_matter 插件无效）。线② 高亮——`workbench/editor/monaco/monacoMarkdownFrontmatter.ts`（token 颜色在 `panel/output/monacoLogLanguage.ts`）。线② 预览表格——`markdownRenderer.ts::parseMarkdown(input,{frontmatter:true})` + `MarkdownView.tsx::FrontmatterBlock`；配置 `markdown.preview.renderYamlFrontmatter`（默认 true）在 `contributions/MarkdownConfigurationContribution.ts`。改后必 `pnpm ext:build`。

## 易踩坑速记（结论级，论证已删）

1. **盘符大小写**（已修勿回退）：Monaco `Uri.parse` 小写化盘符；`MainThreadLanguages._setMarkers` 必须用 `monacoNs.editor.getModel(monacoNs.Uri.parse(...))` 解析，勿换回 `MonacoModelRegistry.peek`。
2. **二进制 IPC**（已修，全局基建）：`workspace.fs.readFile` 的 Uint8Array 由 platform `ipc.ts` 的 base64 tag replacer/reviver 修复；动 ipc 编解码别破坏。
3. **server 直返原生 LSP 类型**：加 provider 别画蛇添足造中间 DTO。
4. **path policy 静默拒读**：`mdFsBridge` 吞成 `undefined`/`[]` 不抛；「某链接诊断不报/预览空」先想是不是被网关挡了。
5. **esbuild vscode-uri CJS alias**：`esbuild.config.mjs` + `vitest.config.ts` 都有该 alias，动构建/测试配置别删。
6. **打包靠自动发现**：`scripts/release/runtime-resources.mjs` 扫 `extensions/*` 自动带入，新插件不用改 electron-builder.yml。
7. **预览 input→组件两处必同步**：`EditorArea.tsx` + `BuiltInEditorProvidersContribution.ts`，漏一处预览开不出或恢复不了。
8. **host stdout 就是 RPC 线，禁止任何 console.log**（已修勿回退）：`protectStdout()`（`packages/extension-host/src/stdoutProtection.ts`）把 host console 重定向 stderr；升级 md LS / 改 host bootstrap 别破坏。
9. **header-fragment 链接 setSelection 崩溃**（已修勿回退）：`EditorOpenerContribution.normalizeOpenRange` 把缺省 end 补成 start，再 setSelection/reveal。
10. **补全 vs 文档同步防抖竞态**（已修勿回退）：即时触发的 provider 调前先 `await PendingDocumentSync.flush(uri)`（`renderer/services/extensions/PendingDocumentSync.ts`）。
11. **预览链接点击不走 LSP documentLink**：`MarkdownView`/`SafeLink` 自路由；`./foo.md#hello` 拆「文件路径+fragment」先开 MarkdownPreviewInput 再 `MarkdownPreviewRegistry.revealAnchor`；`@path/to/file` 是文件 mention，解析/打开前剥 `@`。别让 `#fragment`/`@` 进 `markdownLinkCandidates`。
12. **vim 导览键吞预览内输入框字符**（已修勿回退）：容器级键盘监听开头 `if (isEditableTarget(e.target)) return`；`isEditableTarget` 已抽到共享 `renderer/workbench/domUtils.ts`。
13. **预览本地链接 %20 空格**（已修勿回退）：decodeURIComponent 只在 `workbench/markdown/markdownLinkResolve.ts` 的文件路径候选做（解码候选优先、原样兜底并去重）；别在 parser 阶段全局 decode href、别改 `URI.file`。
14. **成链相对路径基准**（已修勿回退）：用 `dirname(mdUri.fsPath)`（目标文档自身目录）+ platform `relativePath`（允许 `../`）；勿回退工作区根（`relativePathUnder` 爬不出根，目标不在根目录必 404）。
15. **`.mdAnchor` 必须 `vertical-align: top`**（已修勿回退）：见线② 锚点节；几何不可在 happy-dom 测。
16. **跨文件锚点挂载期滚动**（已修勿回退）：预览未挂载时 `revealAnchor` 把 fragment 存 `MarkdownPreviewViewStateCache.saveRevealAnchor` one-shot（与 revealLine 互斥），restore effect 按 **anchor > revealLine > saved scrollTop** 决策；**新的挂载期滚动意图必须并入此 one-shot 通道，勿旁路**（600ms 窗口内 scroll-restore 反复 re-apply 会拉回 saved 位置）。

## 验证

```bash
pnpm --filter @universe-editor/markdown test      # server 单测
pnpm ext:build                                    # 改插件/server 后必跑
pnpm --filter @universe-editor/editor build       # e2e 跑 out/ 产物，改 renderer 后必重建
cd extensions/markdown && pnpm e2e -- specs/markdownLsp.spec.ts    # 扩展自带 e2e 栈，非 apps/editor 冒烟
pnpm check
```

相关单测（`__tests__/`）：`markdownPasteLinks` / `markdownLinkProviderShared` / `markdownAssetLinks` / `markdownAssetDropper` / `fileBulkEditService` / `shouldDeferDropToMarkdownEditor` / `EditorOpenerContribution` / `PendingDocumentSync` / `stdoutProtection`。

e2e 探针（`renderer/e2e/probe.ts`）：`getMarkdown*` 全家（symbols/workspaceSymbols/definition/markers(owner:'markdown')/documentLinks/hover/completions/references）+ `getMarkdownPasteEdit` / `getMarkdownDropEdit` / `insertMarkdownSnippet`。

## 关键参考

- 相关 skill：[extend-language-plugin]（通用语言插件套路）；TS 子系统对照 `extensions/typescript/CLAUDE.md`

## 其它

- 后续用本文，发现新经验，需同步更新本文件
