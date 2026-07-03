---
name: link-opener-deeplink
description: 处理"链接打开/地址跳转/深链接"相关功能时召回——本仓库对等 VSCode 的 IOpenerService 机制：发一个地址（文件路径、URL、command: URI、或 OS 级 universe-editor:// 深链）就打开对应资源并定位行列。当任务涉及"点某个链接/发个地址就打开文件并跳到行列"、给 opener 加一档新协议、command: URI 执行命令 + 信任白名单、universe-editor:// 外部深链（setAsDefaultProtocolClient / open-url / second-instance / 冷启动 argv）、行列在 URI fragment 的编码（#L行,列）、把散落的"打开编辑器再定位"收敛到统一 helper、或要理解"markdown 链接/ACP 聊天/终端里点路径怎么打开的、AI 输出地址点击即达怎么实现"时使用。给出三层架构（platform 契约 / renderer 三档 opener / OS 深链）的文件地图、fragment 编码约定、信任闸门设计、定位 helper 的复用点、与检测端 filePathLink 的边界，以及关键坑。区别于 markdown-subsystem-context（那是 markdown 预览/成链，链接点击分发在 MarkdownView/SafeLink）：本 skill 是"地址→打开+定位"的统一机制本身。
disable-model-invocation: true
---

# 链接打开机制：IOpenerService + universe-editor:// 深链接

对等 VSCode 的"发一个地址就打开对应文件并定位/执行配置命令"。核心思路：**统一入口 `IOpenerService.open(target, options)`，行列编码进 URI fragment（`#L{行},{列}`，1-based），三档 opener first-wins 分发**（External → Command → File）。

> ⚠️ 第一原则：先分清你的改动落在**哪一层**——① platform 契约（接口 + fragment 编解码纯函数）、② renderer 实现（三档 opener + 定位 helper）、③ OS 级深链（main 路由 + IPC + renderer contribution）。三层职责不交叉，改错层白改。
>
> ⚠️ 第二原则：**检测端 ≠ 打开端**。"把文本里的裸路径识别成可点链接"是 `filePathLink.ts`（另有 markdown 的 SafeLink、终端 linkProvider），那是**检测**；本 skill 讲的是识别出地址**之后怎么打开并定位**。两端别混。

## 架构总览（三层）

```
① platform 契约      packages/platform/src/opener/openerService.ts   （必须在 opener/index.ts + src/index.ts re-export）
② renderer 实现      apps/editor/src/renderer/services/opener/OpenerService.ts   （main.tsx 副作用 import 注册）
                     apps/editor/src/renderer/services/editor/revealEditorPosition.ts   （统一定位 helper）
③ OS 级深链          apps/editor/src/shared/deepLink.ts   （纯函数，main 路由 + renderer 打开共用）
                     apps/editor/src/main/index.ts   （setAsDefaultProtocolClient + 三入口 → routeDeepLink）
                     apps/editor/src/renderer/contributions/DeepLinkContribution.ts   （消费 IPC → IOpenerService.open）
```

## ① platform 契约层

`packages/platform/src/opener/openerService.ts`：
- `IOpenerService`（`createDecorator('openerService')`）+ `IOpener`：`open(target: URI | string, options?): Promise<boolean>`（返回是否有 opener 处理了）；`registerOpener(opener): IDisposable`。
- `IOpenerOptions`：`openToSide?` / `allowCommands?: boolean | readonly string[]` / `fromUserGesture?`。
- `ITextEditorSelection`（1-based，对齐 Monaco 行列约定）。
- **`withSelection(uri, selection)` / `extractSelection(uri)`**：照抄 VSCode `platform/opener/common/opener.ts` 的这对纯函数。fragment 格式 `{起行},{起列}[-{止行}[,{止列}]]`，解码正则 `^L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?`，**1-based**，`L` 前缀可选。`extractSelection` 解出后把 fragment 剥空返回 uri。

> **必须**在 `opener/index.ts` 加一行 barrel，再在 `packages/platform/src/index.ts` re-export（`export * from './opener/index.js'`）；否则 `index.test.ts` 覆盖检查会失败（platform 约定：任何导出符号必须能从某个 barrel 到达）。改 platform 后 apps 看到的是 dist，dev 下 watcher 自动重建，非 dev 要 `pnpm --filter @universe-editor/platform build`。

## ② renderer 实现层

### 三档 opener（`OpenerService.ts`，first-wins，newest-first）

构造函数按"File 最后注册 → 排在最前会被后注册的顶掉"的相反顺序 register，使 **File 是 catch-all 兜底**：
1. **ExternalOpener**：scheme ∈ {http, https, mailto} → `window.open(uri.toString(), '_blank')`。主进程 `windowMainService` 的 `setWindowOpenHandler` 只对 http(s) 调 `shell.openExternal`，其余 deny——这是外链的实际出口。
2. **CommandOpener**：scheme === `command` → `path` 是命令 id、`query` 是 `JSON.parse(decodeURIComponent(query))` 参数（数组展开为多参，非数组包成 `[arg]`，非 JSON 兜底为单字符串参数）。**信任闸门（安全红线）**：`options.allowCommands` falsy（默认）→ 静默不执行（return true 表示"已处理"即吞掉）；`=== true` → 全放行；数组 → 白名单校验 `path`。对齐 VSCode markdown `isTrusted` 三层防御，**防 AI 输出等不受信内容执行任意命令**。
3. **FileOpener**：scheme === `file` → `extractSelection` 剥行列。目录 → `IWindowsService.openWindow`（新窗口，对齐拖入文件夹）；无 selection → `IEditorResolverService.openEditor`（让图片等专用编辑器胜出，避免二进制显乱码）；有 selection → 复用已开 / 新开 `FileEditorInput` 后走定位 helper。

`parseTarget(raw)`（字符串→URI）：有 `://` scheme 或 `mailto:`/`command:` 前缀且非 Windows 盘符 → `URI.parse`；否则 `splitFilePathLocation`（复用 `filePathLink.ts`）剥 `:line:col` 折进 fragment，`URI.file(path)`。**`parseTarget` 和 `CommandOpener` 已 export 供单测**（信任闸门 + 解析是最该测的两块）。

### 统一定位 helper（`revealEditorPosition.ts`）

把原本散在 **3 处**各自重复的"等 Monaco 挂载→setSelection/reveal/focus"和"跨组找已开 FileEditorInput"收敛为单一实现：
- `findExistingFileEditor(groups, uriIdentity, uri)` → `{ group, editor } | undefined`（跨所有 group 按 uriIdentity.isEqual 找 FileEditorInput）。
- `waitForFileEditor(input)`：`FileEditorRegistry.get(input)` 拿不到时 rAF + `[50,100,200]ms` 重试（Monaco 挂载是异步的，openEditor 不同步 mount）。
- `toRevealRange(selection)`：把单点 selection（`#L5,1` 无 end 字段）补全成合法 IRange（end 缺省填 start），否则 `setSelection` 抛 `Invalid arguments`。**取代**原 `EditorOpenerContribution.normalizeOpenRange`。
- `applyEditorSelection` / `revealSelectionInInput(input, selection)`：等挂载 + reveal 的组合入口。

**三个消费方**都改调它（纯重构，行为不变）：`actions/extensionApiActions.ts`（`_workbench.openFileAt`）、`contributions/EditorOpenerContribution.ts`（Monaco 跨文件跳转/peek）、`workbench/markdown/useMarkdownFileLink.ts`（markdown 链接打开）。

### 注册

`OpenerService.ts` 末尾 `registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed)`；`main.tsx` 加副作用 import（`import './services/opener/OpenerService.js'`），让 `getSingletonServiceDescriptors()` 快照能拾取。

## ③ OS 级深链接

### 纯解析（`shared/deepLink.ts`，main + renderer 共用）

- 协议 `universe-editor`。两种形态对齐 VSCode `vscode://file|command`：
  - `universe-editor://file/<abs-path>[:line[:col]]`
  - `universe-editor://command/<commandId>[?<args>]`
- `parseDeepLink(url)` → `DeepLinkTarget`（`{kind:'file',path,line?,col?}` | `{kind:'command',id,query}`）。Windows 盘符要剥 `URI.parse` 在 `/D:/` 前多加的斜杠。
- `DEEP_LINK_ALLOWED_COMMANDS`：命令深链白名单，**只放无副作用的"配置入口"**（openSettings/openKeybindings/selectTheme/configureDisplayLanguage 等）——绝不放会改文件/跑 agent/执行 shell 的命令。
- `deepLinkFilePath(target)`（main 路由匹配窗口用）、`deepLinkToOpenerTarget(target)`（转成 renderer 能直接喂给 `IOpenerService.open` 的字符串：文件→`path:line:col`，命令→`command:id?args`）。

### main 侧（`main/index.ts`）

- **注册**：`applyProductIdentity` 后 `app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL)`（dev + Windows 要显式传 `process.execPath` + 脚本路径才能 round-trip）；E2E 用 `environmentService.isE2E` 跳过（隔离实例不抢 OS 关联）。
- **三入口**：① 冷启动 argv（`parseDeepLinkArg`；**注意从 `parseFileToOpen` 里用 `isDeepLink` 排除**，否则深链被当文件路径）② `second-instance`（已运行时，开头先判 deep link）③ `app.on('open-url')`（macOS）。
- **`routeDeepLink(target)`**：文件链优先路由到 workspace 含该文件的窗口，否则 focused/first 窗口；有窗口 → `webContents.send('ue:open-uri', deepLinkToOpenerTarget(target))`；无窗口 → `createWindow({ deepLink: ... })`。函数声明会 hoist，可在定义 `getOrCreateServices` 前引用（运行时才调）。
- `electron-builder.yml` 顶层加 `protocols:`（name + schemes）声明，让打包后 mac Info.plist / Windows NSIS 注册该 scheme。

### 打通 main→renderer

- `windowMainService.ts`：`ICreateWindowOptions` 加 `deepLink?: string`，`additionalArguments` 串 `--ue-open-uri=${opts.deepLink}`。
- `preload/index.ts`：读 `--ue-open-uri=` 暴露 `openUriTarget`（冷启动）+ `onOpenUri(cb)`（监听 `ue:open-uri`），照抄现有 `openFilePath`/`onOpenFile` 套路。
- `contributions/DeepLinkContribution.ts`（AfterRestore 相，注册在 `registration/afterRestore.ts`）：读 `ipc.openUriTarget` + `ipc.onOpenUri` → `IOpenerService.open(target, { allowCommands: DEEP_LINK_ALLOWED_COMMANDS, fromUserGesture: true })`。**深链的信任级就体现在这里传白名单**。

## 设计取舍与「为什么」

- **不给 `IEditorService.openEditor` 加 selection 参数**：会侵入编辑器挂载链路、风险大。改由 opener 封装"open(uri#L10) 即定位"，定位靠 `revealEditorPosition` helper 消化 Monaco 异步挂载。
- **main 只路由不解析行列**：解析集中在 renderer 复用 `filePathLink`/`extractSelection` 单一真相源，main 只认协议 + 匹配窗口，避免行列解析逻辑两份。
- **command 默认拒绝**：对等 VSCode `isTrusted`；opener 层 + 深链白名单双闸门。
- **行列走 fragment 而非 query**：VSCode 同款，最自洽、和 `extractSelection` 一套往返。

## 常见任务 → 改哪里

- **给 opener 加一档新协议/新目标类型**：`OpenerService.ts` 写一个 `IOpener`（`open` 里判 scheme，不匹配 return false 让下一档接手），在构造函数按"越兜底越先注册"的相反序 `this._register(this.registerOpener(...))`。
- **改行列编码/解析**：platform `openerService.ts` 的 `withSelection`/`extractSelection`（改这里所有消费方一致变）。
- **改"打开+定位"的时序/reveal 行为**：`revealEditorPosition.ts`（三处消费方共享，不要在消费方各自改）。
- **加/减命令深链白名单**：`shared/deepLink.ts` 的 `DEEP_LINK_ALLOWED_COMMANDS`。
- **深链协议名 / 新增深链形态**：`shared/deepLink.ts`（`parseDeepLink` + `deepLinkToOpenerTarget`）+ main 的 `routeDeepLink`。
- **深链在某入口没生效**：查三入口是否都接了（冷启动 argv / second-instance / open-url），argv 是否被 `parseFileToOpen` 误吞（要 `isDeepLink` 排除）。
- **markdown 里点链接的分发逻辑**（相对路径解析、目录/图片/预览分流、Ctrl+点击到侧边）：**不在本 skill**，在 `useMarkdownFileLink.ts` + `MarkdownView.tsx` 的 `SafeLink`（见 [markdown-subsystem-context] 线③相邻）。本 skill 只负责它们最终调到的"打开+定位"。

## 易踩坑速记

1. **built-in opener 的 disposable 必须 `this._register`**（血泪坑，勿回退）：`OpenerService` 构造函数里注册三档 opener，`registerOpener` 返回的 disposable 若不 `this._register(...)` 挂到服务 store，会被 DisposableTracker 判为泄漏 → **e2e `expectNoLeaks` 全红**（表现为几乎所有用例失败、栈指向 `OpenerService.registerOpener`→`toDisposable`）。写法：`this._register(this.registerOpener(instantiation.createInstance(FileOpener)))`。**通则**：dev/E2E 下任何 `new` disposable 都要有归属，见 [fix-disposable-leak]。
2. **fragment 单点 selection 的 end 字段是 undefined**（勿回退）：`#L5,1`（无 `-L..` 段）经 `extractSelection` 得到的 range `endLineNumber/endColumn` 为 undefined，既非合法 IRange 也非 ISelection，`setSelection` 抛 `Invalid arguments`。用 `toRevealRange` 把 end 补成 start。
3. **`parseFileToOpen` 会吞掉深链 argv**：Windows/Linux 深链作为普通 argv 传入，和文件路径同形。`parseFileToOpen` 的 `.find(...)` 必须 `&& !isDeepLink(a)`，`parseDeepLinkArg` 单独挑出深链，否则深链被当"要打开的文件"。
4. **Windows 盘符被误判为 URL scheme**：`D:\foo` 的 `D:` 像 scheme。`parseTarget` 与 `deepLink` 解析都要先用 `/^[A-Za-z]:[/\\]/` 短路成文件路径。`filePathLink.ts` 的 `looksLikeFilePath`/`isWindowsDrivePath` 已处理这层，复用别重造。
5. **platform 未 re-export → 编译过但运行时拿不到**：新加的 opener 符号忘了在 `opener/index.ts` 或 `src/index.ts` re-export，`index.test.ts` 会红；apps 端 import 报找不到。
6. **改 platform 后 apps 用旧 dist**：非 dev 模式改完 `openerService.ts` 要重建 platform，否则 renderer/main 仍是旧契约。
7. **深链 command 走白名单，普通 opener.open 默认拒 command**：两处信任级独立——`DeepLinkContribution` 显式传 `allowCommands: DEEP_LINK_ALLOWED_COMMANDS`；其它调用方（如未来 markdown command 链接）要各自决定传什么。默认不传 = 不执行任何命令。

## 验证

```bash
pnpm --filter @universe-editor/platform test -- --run opener   # fragment 编解码往返
cd apps/editor && pnpm exec vitest run OpenerService revealEditorPosition deepLink   # 三档分发/信任闸门/定位/深链解析
pnpm --filter editor typecheck
pnpm --filter editor build    # e2e 跑 out/ 产物，改 renderer/main 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.gotoSymbol smoke.historyNavigation smoke.markdownPreview --grep-invert "@visual|@serial|@flaky|@perf"
pnpm check    # lint+typecheck+test（含 docs:check），仅看错误
```

> 改了链接打开的用户可见行为（如 `:line:col` 语法、深链格式），检查 `docs/user/zh-CN/editing/markdown.md` 是否要同步（"点击链接跳转文件和目录"节）。

## 关键参考路径

- `packages/platform/src/opener/openerService.ts` —— 契约 + `withSelection`/`extractSelection`（fragment 1-based）
- `packages/platform/src/__tests__/opener/openerService.test.ts` —— 编解码往返单测
- `apps/editor/src/renderer/services/opener/OpenerService.ts` —— 三档 opener + `parseTarget`（后两者 export 供测）
- `apps/editor/src/renderer/services/opener/__tests__/OpenerService.test.ts` —— parseTarget + command 信任闸门
- `apps/editor/src/renderer/services/editor/revealEditorPosition.ts` —— 统一定位 helper（3 处消费方共享）
- `apps/editor/src/renderer/services/editor/__tests__/revealEditorPosition.test.ts` —— toRevealRange
- `apps/editor/src/shared/deepLink.ts` —— 深链纯解析 + 白名单 + opener-target 转换
- `apps/editor/src/shared/__tests__/deepLink.test.ts` —— 深链解析单测
- `apps/editor/src/main/index.ts` —— setAsDefaultProtocolClient + argv/second-instance/open-url 三入口 + `routeDeepLink`
- `apps/editor/src/main/services/window/windowMainService.ts` —— `ICreateWindowOptions.deepLink` + `--ue-open-uri=` argv
- `apps/editor/src/preload/index.ts` —— `openUriTarget` / `onOpenUri`
- `apps/editor/src/renderer/contributions/DeepLinkContribution.ts` —— 消费深链 → `IOpenerService.open`（传白名单）
- `apps/editor/src/renderer/contributions/registration/afterRestore.ts` —— DeepLinkContribution 注册（`workbench.contrib.deepLink`）
- `apps/editor/electron-builder.yml` —— `protocols:` 声明
- 检测端（非本 skill，但常一起出现）：`apps/editor/src/renderer/services/acp/filePathLink.ts`（裸路径识别单一真相源，`splitFilePathLocation` 被 opener 复用）、`workbench/markdown/useMarkdownFileLink.ts` + `MarkdownView.tsx` SafeLink（markdown 链接分发）
- VSCode 对照：`src/vs/platform/opener/common/opener.ts`、`src/vs/editor/browser/services/openerService.ts`（CommandOpener/EditorOpener）、`src/vs/platform/url/electron-main/electronUrlListener.ts`（OS 深链）
- 相关 skill：[markdown-subsystem-context]（markdown 链接检测/分发/成链）、[fix-disposable-leak]（坑1）、[register-monaco-command]（命令注册对照）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件。
