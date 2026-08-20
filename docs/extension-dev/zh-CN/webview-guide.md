# 自定义编辑器与 Webview

> 给某类文件做图形化界面（PDF 预览、表格、图片、自定义二进制格式……）的完整指南：声明、激活、provider 两阶段、资源加载、CSP、消息通信与 diff。以扩展 API 0.13.0 为准。

## 整体形态

一个自定义编辑器由三件套组成，缺一不可：

1. **声明**：`package.json` 的 `contributes.customEditors` 把一个 `viewType` 绑到文件 glob（如 `*.pdf`）。
2. **激活**：`activationEvents` 加上 `onCustomEditor:<viewType>`——用户首次打开匹配文件时才激活你的扩展（懒加载，不拖慢启动）。
3. **注册**：`activate` 里调 `window.registerCustomEditorProvider(viewType, provider, options?)`，返回的 `Disposable` 推进 `context.subscriptions`。

provider 本身分两个阶段，宿主依次回调：

- `openCustomDocument(uri)` —— 为打开的资源建文档模型，每个资源调一次。默认只需携带 `uri`；需要持有资源（句柄、缓存）时在返回的对象上挂，并在 `dispose()` 里释放。
- `resolveCustomEditor(document, webviewPanel)` —— 给文档挂 UI：设 `webview.options`、赋 `webview.html`、监听消息。tab 与 iframe 由工作台拥有，扩展只提供内容。

`registerCustomEditorProvider` 的第三个参数 `options` 目前只有一项：`supportsMultipleEditorsPerDocument`（默认 `false`）——同一个文档能否同时 backing 多个编辑器 tab。

## 声明与激活

```jsonc
// package.json
{
  "activationEvents": ["onCustomEditor:myExt.preview"],
  "contributes": {
    "customEditors": [
      {
        "viewType": "myExt.preview",
        "displayName": "My Preview",
        "selector": [{ "filenamePattern": "*.xyz" }],
        "priority": "default"
      }
    ]
  }
}
```

- `viewType` 是稳定 id：声明、激活事件、`registerCustomEditorProvider` 三处必须一致。
- `selector` 是 glob 数组，一个 `viewType` 可绑多种扩展名。
- `priority: "default"` 表示打开匹配文件时默认用你的编辑器；`"option"` 不抢默认，只出现在「打开方式…」（Reopen With）菜单里。

## 只读边界：当前没有可写 custom editor

API 目前只有 `CustomReadonlyEditorProvider`——渲染资源，但**永不写回**。可写 custom editor（save / backup / edit）是规划中的后续阶段，尚未落地。这意味着：

- 不要在你的 UI 里做「保存」按钮并暗示能写盘——没有对应的 API 通路。
- 需要改文件的场景，现阶段只能把自定义编辑器当预览，编辑仍走文本编辑器。

## `webview.options`：先设 options，再设 html

`WebviewOptions` 控制 webview 能做什么，**必须在给 `webview.html` 赋值之前设好**（`html` 赋值即重渲染，后设 options 不会作用于已渲染的内容）：

- `enableScripts`（默认关）：允许 iframe 里跑 `<script>`。纯静态内容不用开；要脚本时显式设 `true`。
- `localResourceRoots`：webview 经 `asWebviewUri` 可加载的本地目录白名单，见下节。

## `localResourceRoots`：最常见的实坑

规则只有两条，但漏了很难排查：

1. **扩展自身目录总是允许**，无需列出——你的 `assets/` 里的查看器脚本、样式、字体直接可用。
2. **文档所在目录要显式加**——否则 `asWebviewUri(document.uri)` 生成的 URL 会被资源协议拒绝（403），表现是「预览器 UI 出来了但内容空白」（工具栏在、内容区空）。

照抄 PDF 扩展的写法（`resolveCustomEditor` 里）：

```ts
panel.webview.options = {
  enableScripts: true,
  // 扩展目录放着查看器资产；文档自己的目录也要进白名单，
  // 否则 asWebviewUri(document.uri) 不解析
  localResourceRoots: [fileUri(extensionRoot), dirUri(document.uri)],
}
panel.webview.html = buildHtml(panel.webview, document.uri)
```

其中 `dirUri` 是取 `file:` UriComponents 目录部分的小工具（PDF 扩展源码里有完整实现，见文末「参考实现」）。只加载扩展自己资产的预览（如 diff 场景，内容按字节直传）可以不加文档目录。

## CSP：用 `webview.cspSource` 注入

webview 的内容安全策略由你在 HTML 的 `<meta>` 里声明。凡是经 `asWebviewUri` 产出的资源，其来源都是 `webview.cspSource`（`universe-app://root`），把它插进各条指令：

```ts
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`
```

以 `default-src 'none'` 打底、按需逐条放开（PDF 扩展的 CSP 是完整范例）。注意 `enableScripts` 与 CSP 是两道独立的门：脚本要跑，两者都得放行。

## `asWebviewUri`：本地资源 → webview 可加载的 URL

把 `file:` 的 `UriComponents` 转成 webview 里可加载的 URL **字符串**（`universe-app://root/_resource_/<绝对路径>`）：

```ts
const cssUrl = webview.asWebviewUri(fileUri(joinPath(extensionRoot, 'assets', 'viewer.css')))
// 填进 HTML：<link rel="stylesheet" href="${cssUrl}">
```

两个要点：webview 这部分表面（`CustomDocument.uri`、`asWebviewUri` 的入参出参）仍是普通对象/字符串——`Uri` 类（0.9.0 起存在于包级导出）在此不出现，手写 `file:` UriComponents 时 `path` 要带前导斜杠（Windows 盘符形如 `/C:/...`）；只有落在 allow-list（扩展目录 + `localResourceRoots`）内的路径才会真正解析，越界路径得到的是一个必然 403 的 URL。

## 消息通信：扩展 ↔ webview 脚本

双向通道，载荷须可结构化克隆：

- **扩展 → 页面**：`await webview.postMessage(message)`，返回 `false` 表示 webview 已销毁。页面侧以 `window` 的 `message` 事件接收（`event.data` 即载荷）。
- **页面 → 扩展**：页面脚本调 `acquireVsCodeApi()`（宿主同时注入别名 `acquireUniverseApi()`）拿到桥对象，调其 `postMessage(message)`；扩展侧用 `webview.onDidReceiveMessage(msg => ...)` 接收。
- 桥对象上还有 `getState` / `setState`，当前是占位实现（`getState` 恒返回 `undefined`）——webview 状态持久化未落地，不要依赖。

```ts
// 扩展侧
panel.webview.onDidReceiveMessage((msg) => {
  if (msg?.type === 'ready') void panel.webview.postMessage({ type: 'load', url: docUrl })
})
```

```js
// webview 页面脚本侧
const api = acquireVsCodeApi()
api.postMessage({ type: 'ready' })
window.addEventListener('message', (event) => { /* event.data 即扩展发来的载荷 */ })
```

## `supportsDiff` 与 `panel.diffContext`

在 manifest 的 customEditors 条目加 `"supportsDiff": true` 后，宿主的 diff 场景（资源管理器的「选择以进行比较 / 与所选项进行比较」、Git/Perforce 的 Open Changes）也会调你的 provider——此时 `resolveCustomEditor` 里 `panel.diffContext` **存在**，携带 `leftUri` / `rightUri` / `title` 以及两侧内容的**原始字节**（`left` / `right`，`Uint8Array`，按值传递——两侧可能根本不在磁盘上，比如 Git HEAD 的 blob，所以渲染 diff 时读这些字节而不是 `document.uri`）。`diffContext` 为 `undefined` 时就是普通的单文件打开。完整实战见仓库里的 Excel Viewer & Diff 扩展（`extensions-external/excel-diff/`）：一个 `viewType` 同时承载单文件预览与双栏对比，靠 `panel.diffContext` 分派。

## 完整最小示例

一个可粘贴的骨架（manifest 用上面「声明与激活」那段，`viewType` 对齐）：

```ts
import {
  window,
  type CustomDocument,
  type ExtensionContext,
  type UriComponents,
  type WebviewPanel,
} from '@universe-editor/extension-api'

const VIEW_TYPE = 'myExt.preview'

function dirUri(uri: UriComponents): UriComponents {
  const p = uri.path ?? ''
  const slash = p.lastIndexOf('/')
  return { scheme: 'file', path: slash > 0 ? p.slice(0, slash) : '/' }
}

export function activate(context: ExtensionContext): void {
  const provider = {
    openCustomDocument(uri: UriComponents): CustomDocument {
      return { uri, dispose() {} }
    },
    resolveCustomEditor(document: CustomDocument, panel: WebviewPanel): void {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [dirUri(document.uri)], // 扩展目录自带允许，不必列出
      }
      const docUrl = panel.webview.asWebviewUri(document.uri)
      panel.webview.html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${panel.webview.cspSource};">
</head><body><img src="${docUrl}" style="max-width:100%"></body></html>`
    },
  }
  context.subscriptions.push(window.registerCustomEditorProvider(VIEW_TYPE, provider))
}
```

脚手架的 `webview` 模板（见 [快速上手](./getting-started.md)）生成的就是一个可运行的只读自定义编辑器，建议从它起步而不是从零搭。

## 独立 webview 面板：`window.createWebviewPanel`（0.11.0 起）

自定义编辑器由工作台拥有 tab（打开匹配文件 → 路由到你的 provider）；`window.createWebviewPanel` 则反过来——**扩展**主动创建、持有、销毁一个不绑定任何文件的 webview tab（典型的「展示型 UI」：仪表盘、预览页、向导）。不需要 manifest 声明，也不需要激活事件配合（一般由你自己的命令触发）：

```ts
import { commands, window, type ExtensionContext, type WebviewPanel } from '@universe-editor/extension-api'

let panel: WebviewPanel | undefined

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('myExt.showDashboard', () => {
      if (panel) {
        panel.reveal() // 已有面板：只是把它的 tab 带回前台
        return
      }
      panel = window.createWebviewPanel('myExt.dashboard', 'Dashboard', undefined, {
        enableScripts: true,
      })
      panel.webview.html = '<!DOCTYPE html><html><body><h1>Dashboard</h1></body></html>'
      // 用户关掉 tab 时扩展收到通知——把引用清掉，下次命令重新创建
      panel.onDidDispose(() => {
        panel = undefined
      })
    }),
  )
}
```

- **返回的 `WebviewPanel` 与自定义编辑器拿到的是同一个类型**：`webview` 表面（`html` / `options` / `cspSource` / `asWebviewUri` / 双向消息）完全通用，上文各节照旧适用；此外 `title` 可读写（改名即改 tab 标题）、`active` / `visible` / `onDidChangeViewState` 跟踪编辑器组真实状态（`visible` = tab 是所在编辑器组的选中 tab；`active` = 且该组是焦点组；切 tab、分屏切焦点、后台 preserveFocus 创建都会如实触发，可按此暂停/恢复渲染）、`reveal(preserveFocus?)` 重新激活已有 tab、`dispose()` 主动关闭。
- **与 VSCode 的差异**（如实列举）：没有 `ViewColumn` 参数——tab 开在当前活动编辑器组，showOptions 只支持 `{ preserveFocus: true }`（后台打开不抢焦点）；没有 `retainContextWhenHidden`——iframe 在隐藏期间从不重建，状态天然保留；没有 `WebviewPanelSerializer`——窗口 reload / 重启后 tab 不恢复，扩展重新激活后自行重建即可。
- **句柄即身份**：每个面板一个 tab；扩展侧保存引用、重复调用前先判 `panel` 是否还活着（如上例），不要无脑重复创建。

独立示例仓库 `universe-editor-extension-samples` 的 webview-panel 示例是可安装的最小范例（Show / Reveal / Dispose 三个命令走完整生命周期）。

## 安全边界：webview 不是强沙箱

webview 界面运行在受限的内嵌页面（iframe）里——只能加载扩展自己目录下以及显式声明位置的资源、受 CSP 约束；**但这不是等同于浏览器网页的强沙箱**，承载它的扩展进程本身仍拥有接近编辑器的权限。扩展进程可以读文件、发网络请求；webview 的限制只约束 iframe 里的内容，不构成对扩展的安全边界。请在 README 与市场描述里如实表述，不要宣称「沙箱隔离」。完整的权限模型与作者责任见 [安全与信任](./security-and-trust.md)。

## 参考实现

仓库里的 [`extensions-external/pdf/`](../../../extensions-external/pdf/) 是完整实战（Mozilla pdf.js 移植）：`src/extension.ts` 的 provider 写法、`localResourceRoots` 双目录、CSP 注入、`asWebviewUri` 资产加载、viewer.html 经 esbuild text loader 内联后字符串替换——都可直接参考。注意它的 `scripts/pack.mjs` 是仓库内形态（借 monorepo 路径解析依赖），**第三方扩展不要照抄打包脚本**，直接用 `npx uex package` 即可（见 [快速上手](./getting-started.md)）。

## 相关阅读

- [贡献点参考](./contribution-points.md) — `contributes.customEditors` 字段全集与其它贡献点
- [API 概览](./api/README.md) — 宿主提供的完整 API 表面
- [安全与信任](./security-and-trust.md) — 权限边界、Workspace Trust 与作者责任清单
