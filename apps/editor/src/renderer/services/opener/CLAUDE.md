# apps/editor/src/renderer/services/opener/CLAUDE.md

本目录是 opener 子系统的家：对等 VSCode 的 IOpenerService——发一个地址（文件路径、URL、command: URI、或 OS 级 universe-editor:// 深链）就打开对应资源并定位行列。renderer 三档 opener 实现在本目录（OpenerService.ts），契约在 platform，OS 级深链在 shared/main。收录案例「链接打开机制 IOpenerService + 深链接」。处理相关任务前通读本文件。

> ⚠️ 第一原则：先分清改动落在**哪一层**——① platform 契约（接口 + fragment 编解码纯函数）、② renderer 实现（三档 opener + 定位 helper）、③ OS 级深链（main 路由 + IPC + renderer contribution）。三层职责不交叉，改错层白改。
>
> ⚠️ 第二原则：**检测端 ≠ 打开端**。「把文本里的裸路径识别成可点链接」是 `filePathLink.ts`（另有 markdown SafeLink、终端 linkProvider），那是**检测**；本案例讲识别出地址之后**怎么打开并定位**。两端别混。

## 架构总览（三层）

```
① platform 契约   packages/platform/src/opener/openerService.ts    （须在 opener/index.ts + src/index.ts re-export）
② renderer 实现   services/opener/OpenerService.ts（main.tsx 副作用 import 注册）
                  services/editor/revealEditorPosition.ts（统一定位 helper）
③ OS 级深链       shared/deepLink.ts（纯函数，main+renderer 共用）
                  main/index.ts（setAsDefaultProtocolClient + 三入口 → routeDeepLink）
                  contributions/DeepLinkContribution.ts（消费 IPC → IOpenerService.open）
```

## ① platform 契约层

`packages/platform/src/opener/openerService.ts`：`IOpenerService` + `IOpener.open(target: URI | string, options?): Promise<boolean>`（返回是否有 opener 处理）；`registerOpener(opener): IDisposable`。`IOpenerOptions`：openToSide? / allowCommands?: boolean | readonly string[] / fromUserGesture?。`ITextEditorSelection`（1-based，对齐 Monaco 行列约定）。

- **`withSelection(uri, selection)` / `extractSelection(uri)`**（照抄 VSCode `platform/opener/common/opener.ts`）：fragment 格式 `{起行},{起列}[-{止行}[,{止列}]]`，正则 `^L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?`，**1-based**，`L` 前缀可选；extractSelection 解出后把 fragment 剥空返回 uri。
- **必须**在 opener/index.ts 加 barrel 再在 platform/src/index.ts re-export，否则 index.test.ts 覆盖检查失败。改 platform 后 apps 看到 dist，非 dev 要 `pnpm --filter @universe-editor/platform build`。

## ② renderer 实现层

**三档 opener（OpenerService.ts，first-wins，newest-first）**——构造函数按「File 最后注册 → 排在最前会被后注册的顶掉」的相反顺序 register，使 File 是 catch-all 兜底：

1. **ExternalOpener**：scheme ∈ {http, https, mailto} → `window.open(uri.toString(), '_blank')`。主进程 windowMainService 的 setWindowOpenHandler 只对 http(s) 调 shell.openExternal，其余 deny——外链实际出口。
2. **CommandOpener**：scheme === command → path 是命令 id、query 是 `JSON.parse(decodeURIComponent(query))` 参数（数组展开为多参，非数组包成 [arg]，非 JSON 兜底为单字符串）。**信任闸门（安全红线）**：allowCommands falsy（默认）→ 静默不执行（return true 表示已处理即吞掉）；=== true → 全放行；数组 → 白名单校验 path。对齐 VSCode markdown isTrusted 三层防御，防 AI 输出等不受信内容执行任意命令。
3. **FileOpener**：scheme === file → extractSelection 剥行列。目录 → IWindowsService.openWindow（新窗口）；无 selection → IEditorResolverService.openEditor（让图片等专用编辑器胜出，避免二进制乱码）；有 selection → 复用已开/新开 FileEditorInput 后走定位 helper。

`parseTarget(raw)`（字符串→URI）：有 `://` scheme 或 mailto:/command: 前缀且非 Windows 盘符 → URI.parse；否则 splitFilePathLocation（复用 filePathLink.ts）剥 :line:col 折进 fragment，URI.file(path)。**parseTarget 和 CommandOpener 已 export 供单测**（信任闸门 + 解析是最该测的两块）。

**统一定位 helper（revealEditorPosition.ts）**——把散在 3 处各自重复的「等 Monaco 挂载→setSelection/reveal/focus」「跨组找已开 FileEditorInput」收敛为单一实现：

- `findExistingFileEditor(groups, uriIdentity, uri)`：跨所有 group 按 uriIdentity.isEqual 找 FileEditorInput。
- `waitForFileEditor(input)`：FileEditorRegistry.get 拿不到时 rAF + [50,100,200]ms 重试（Monaco 挂载是异步的，openEditor 不同步 mount）。
- `toRevealRange(selection)`：把单点 selection（#L5,1 无 end 字段）补全成合法 IRange（end 缺省填 start），否则 setSelection 抛 Invalid arguments。**取代**原 EditorOpenerContribution.normalizeOpenRange。
- `applyEditorSelection` / `revealSelectionInInput(input, selection)`：等挂载 + reveal 的组合入口。

三个消费方都改调它（纯重构，行为不变）：extensionApiActions.ts（_workbench.openFileAt）、EditorOpenerContribution.ts（Monaco 跨文件跳转/peek）、useMarkdownFileLink.ts（markdown 链接打开）。

**注册**：OpenerService.ts 末尾 registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed)；main.tsx 加副作用 import 让 getSingletonServiceDescriptors() 快照拾取。

## ③ OS 级深链接

**纯解析（shared/deepLink.ts，main+renderer 共用）**：协议 `universe-editor`，两种形态对齐 VSCode `vscode://file|command`：
- `universe-editor://file/<abs-path>[:line[:col]]`
- `universe-editor://command/<commandId>[?<args>]`

`parseDeepLink(url)` → DeepLinkTarget（{kind:'file',path,line?,col?} | {kind:'command',id,query}）；Windows 盘符要剥 URI.parse 在 /D:/ 前多加的斜杠。`DEEP_LINK_ALLOWED_COMMANDS`：命令深链白名单，**只放无副作用的「配置入口」**（openSettings/openKeybindings/selectTheme 等）——绝不放会改文件/跑 agent/执行 shell 的命令。`deepLinkFilePath(target)`（main 路由匹配窗口用）、`deepLinkToOpenerTarget(target)`（转成 renderer 可直接喂给 IOpenerService.open 的字符串）。

**main 侧（main/index.ts）**：
- **注册**：applyProductIdentity 后 app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL)（dev + Windows 要显式传 process.execPath + 脚本路径才能 round-trip）；E2E 用 environmentService.isE2E 跳过（不抢 OS 关联）。
- **三入口**：① 冷启动 argv（parseDeepLinkArg；**从 parseFileToOpen 里用 isDeepLink 排除**，否则深链被当文件路径）② second-instance（开头先判 deep link）③ app.on('open-url')（macOS）。
- **routeDeepLink(target)**：文件链优先路由到 workspace 含该文件的窗口，否则 focused/first 窗口；有窗口 → webContents.send('ue:open-uri', deepLinkToOpenerTarget(target))；无窗口 → createWindow({ deepLink: ... })。函数声明会 hoist，可在定义 getOrCreateServices 前引用（运行时才调）。
- electron-builder.yml 顶层加 `protocols:`（name + schemes），让打包后 mac Info.plist / Windows NSIS 注册该 scheme。

**打通 main→renderer**：windowMainService.ts 的 ICreateWindowOptions 加 `deepLink?: string`，additionalArguments 串 `--ue-open-uri=`；preload/index.ts 读 `--ue-open-uri=` 暴露 openUriTarget（冷启动）+ onOpenUri(cb)（监听 ue:open-uri）；contributions/DeepLinkContribution.ts（AfterRestore 相，注册在 registration/afterRestore.ts）读 openUriTarget + onOpenUri → `IOpenerService.open(target, { allowCommands: DEEP_LINK_ALLOWED_COMMANDS, fromUserGesture: true })`——**深链的信任级就体现在这里传白名单**。

## 设计取舍与「为什么」

- **不给 IEditorService.openEditor 加 selection 参数**：会侵入编辑器挂载链路；改由 opener 封装「open(uri#L10) 即定位」，定位靠 revealEditorPosition 消化 Monaco 异步挂载。
- **main 只路由不解析行列**：解析集中在 renderer 复用 filePathLink/extractSelection 单一真相源，main 只认协议 + 匹配窗口。
- **command 默认拒绝**：对等 VSCode isTrusted；opener 层 + 深链白名单双闸门。
- **行列走 fragment 而非 query**：VSCode 同款，与 extractSelection 一套往返。

## 常见任务 → 改哪里

- **给 opener 加一档新协议/新目标类型**：OpenerService.ts 写一个 IOpener（open 里判 scheme，不匹配 return false 让下一档接手），在构造函数按「越兜底越先注册」的相反序 `this._register(this.registerOpener(...))`。
- **改行列编码/解析**：platform openerService.ts 的 withSelection/extractSelection（所有消费方一致变）。
- **改「打开+定位」的时序/reveal 行为**：revealEditorPosition.ts（三处消费方共享，不要在消费方各自改）。
- **加/减命令深链白名单**：shared/deepLink.ts 的 DEEP_LINK_ALLOWED_COMMANDS。
- **深链协议名 / 新增深链形态**：shared/deepLink.ts（parseDeepLink + deepLinkToOpenerTarget）+ main 的 routeDeepLink。
- **深链在某入口没生效**：查三入口是否都接了（冷启动 argv / second-instance / open-url），argv 是否被 parseFileToOpen 误吞（要 isDeepLink 排除）。
- **markdown 里点链接的分发逻辑**（相对路径解析、目录/图片/预览分流、Ctrl+点击到侧边）：**不在本案例**，在 useMarkdownFileLink.ts + MarkdownView.tsx 的 SafeLink（见 workbench/markdown/CLAUDE.md）。本案例只负责它们最终调到的「打开+定位」。

## 易踩坑速记

1. **built-in opener 的 disposable 必须 `this._register`**（血泪坑勿回退）：registerOpener 返回的 disposable 不挂到服务 store 会被 DisposableTracker 判泄漏 → e2e expectNoLeaks 全红（栈指 OpenerService.registerOpener→toDisposable）。写法：`this._register(this.registerOpener(instantiation.createInstance(FileOpener)))`。通则见 [fix-disposable-leak]。
2. **fragment 单点 selection 的 end 字段是 undefined**（勿回退）：#L5,1（无 -L.. 段）经 extractSelection 得到的 range endLineNumber/endColumn 为 undefined，setSelection 抛 Invalid arguments。用 toRevealRange 把 end 补成 start。
3. **parseFileToOpen 会吞掉深链 argv**：Windows/Linux 深链作为普通 argv 传入与文件路径同形。parseFileToOpen 的 .find(...) 必须 `&& !isDeepLink(a)`，parseDeepLinkArg 单独挑出深链。
4. **Windows 盘符被误判为 URL scheme**：`D:\foo` 的 D: 像 scheme。parseTarget 与 deepLink 解析都要先用 `/^[A-Za-z]:[/\\]/` 短路成文件路径；filePathLink.ts 的 looksLikeFilePath/isWindowsDrivePath 已处理这层，复用别重造。
5. **platform 未 re-export → 编译过但运行时拿不到**：新加 opener 符号忘了 re-export，index.test.ts 会红；apps 端 import 报找不到。
6. **改 platform 后 apps 用旧 dist**：非 dev 模式改完 openerService.ts 要重建 platform。
7. **深链 command 走白名单，普通 opener.open 默认拒 command**：两处信任级独立——DeepLinkContribution 显式传 allowCommands: DEEP_LINK_ALLOWED_COMMANDS；其它调用方要各自决定。默认不传 = 不执行任何命令。
8. **agent 深链必须先 `await IUserSettingsSyncService.whenInitialized`**（勿回退）：设置 hydration 是 fire-and-forget，冷启动 AfterRestore 可能先于 settings.json 读盘——bootstrap 提速竞态即翻转，深链会话读到默认 acp.defaultAgentId（claude-code）而非用户配置，直接在错误 agent 上建会话（一次性动作，无法靠配置变更自愈）。守护用例 smoke.deepLinkAgentWorkspace.spec.ts。

## 验证

```bash
pnpm --filter @universe-editor/platform test -- --run opener    # fragment 编解码往返
cd apps/editor && pnpm exec vitest run OpenerService revealEditorPosition deepLink    # 三档分发/信任闸门/定位/深链解析
pnpm --filter editor build    # e2e 跑 out/ 产物
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.gotoSymbol smoke.historyNavigation smoke.markdownPreview --grep-invert "@visual|@serial|@flaky|@perf"
pnpm check    # lint+typecheck+test（含 docs:check），仅看错误
```

> 改了链接打开的用户可见行为（如 :line:col 语法、深链格式），检查 `docs/user/zh-CN/editing/markdown.md` 是否要同步。

## 关键参考路径

- `packages/platform/src/opener/openerService.ts` —— 契约 + withSelection/extractSelection（fragment 1-based）
- `services/opener/OpenerService.ts` —— 三档 opener + parseTarget（后两者 export 供测）；`__tests__/OpenerService.test.ts`
- `services/editor/revealEditorPosition.ts` —— 统一定位 helper；`__tests__/revealEditorPosition.test.ts`
- `shared/deepLink.ts` —— 深链纯解析 + 白名单；`shared/__tests__/deepLink.test.ts`
- `main/index.ts` —— setAsDefaultProtocolClient + 三入口 + routeDeepLink；`main/services/window/windowMainService.ts`（deepLink 选项 + --ue-open-uri=）；`preload/index.ts`（openUriTarget/onOpenUri）
- `contributions/DeepLinkContribution.ts` + `contributions/registration/afterRestore.ts`；`electron-builder.yml`（protocols:）
- 检测端（非本案例，常一起出现）：`services/acp/filePathLink.ts`（裸路径识别单一真相源，splitFilePathLocation 被 opener 复用）、`workbench/markdown/useMarkdownFileLink.ts` + SafeLink
- 相关 skill：[fix-disposable-leak]（坑1）、[register-monaco-command]；markdown 链接见 `workbench/markdown/CLAUDE.md`
