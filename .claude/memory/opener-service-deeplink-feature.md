---
name: opener-service-deeplink-feature
description: "VSCode 式链接打开机制(IOpenerService + universe-editor:// 深链接),发地址即打开文件定位/执行白名单命令"
metadata: 
  node_type: memory
  type: project
  originSessionId: f3edba3c-f264-4fbc-9907-92448504a61f
---

对等 VSCode 的"发一个地址就打开对应文件并定位行列"机制,分三层落地:

**契约层(platform)**：`packages/platform/src/opener/openerService.ts` — `IOpenerService`/`IOpener` + `withSelection`/`extractSelection` 纯函数(照抄 VSCode opener.ts,行列编码进 URI fragment `#L{行},{列}`,**1-based**)。必须在 index.ts re-export。

**实现层(renderer)**：`renderer/services/opener/OpenerService.ts` — 三档 opener first-wins：External(http/https/mailto→window.open)、Command(`command:` scheme,`path`=命令id/`query`=JSON参数,**默认拒绝**,`allowCommands===true` 全放行 or 数组白名单)、File(catch-all,extractSelection 剥行列→定位)。经 `main.tsx` 副作用 import 注册。**坑**：built-in openers 的 registerOpener 返回的 disposable 必须 `this._register(...)`,否则被 DisposableTracker 判为泄漏(e2e expectNoLeaks 全红)。

**统一定位 helper**：`renderer/services/editor/revealEditorPosition.ts` — 抽出原本散在 3 处(extensionApiActions/EditorOpenerContribution/useMarkdownFileLink)重复的"等 Monaco 挂载(rAF+重试)→setSelection/reveal/focus"+"跨组找已开 FileEditorInput"。`toRevealRange` 取代原 EditorOpenerContribution.normalizeOpenRange。

**OS 级深链接**：`shared/deepLink.ts`(纯函数,main 路由+renderer 打开共用)。`universe-editor://file/<path>[:line[:col]]` 与 `universe-editor://command/<id>?<args>`。命令深链走 `DEEP_LINK_ALLOWED_COMMANDS` 白名单(仅设置/keybinding/主题等无副作用配置入口)。main/index.ts：`setAsDefaultProtocolClient` + argv(冷启动)/second-instance/`open-url`(mac) 三入口→`routeDeepLink` 匹配窗口→IPC `ue:open-uri` 送 opener-target 字符串;preload 暴露 `openUriTarget`/`onOpenUri`;`DeepLinkContribution`(AfterRestore)消费→`IOpenerService.open`。electron-builder.yml 加 `protocols` 声明。argv 需把 deep link 从 `parseFileToOpen` 里排除(isDeepLink)。

设计取舍：不给 IEditorService.openEditor 加 selection 参数(侵入挂载链路),改由 opener 封装;main 只路由不解析行列(解析集中 renderer 复用 filePathLink 单一真相源)。相关：[[editor-input-identity-isolation]] [[path-comparison-convergence]]。

**遗留问题**(非本次改动引入)：`docs/user/zh-CN/editing/markdown.md` 目录处曾有已提交的 git 冲突标记(HEAD/=====/3dd11b77),本次顺手修掉。
