# 受信视图（原生 UI 组件）

> 普通扩展的界面走 Tree View 或 Webview；若你需要一段**原生 React 组件**——像内置功能那样挂在侧栏或编辑器标签里，直接共享工作台的样式与交互——就用本文的 `contributes.trustedViews`。代价是组件运行在编辑器界面进程里，因此**只有受信扩展才会被加载**。

## 概念与适用场景

一个受信视图扩展由两半组成：

- **扩展宿主侧**（`main`）：普通扩展代码，在扩展宿主进程里运行，注册 `TrustedViewProvider` 处理组件发来的请求。
- **界面侧**（`trustedViews[].entry`）：一个浏览器 ESM 模块，默认导出 React 组件。编辑器界面在挂载视图/标签时动态 `import` 它，并把受限的 `ctx` 注入组件。

组件与扩展宿主之间只有一条 RPC 通道：组件的 `ctx.request()` 打到本扩展的 provider，provider 的 `session.postEvent()` 推回组件。不经过主进程 IPC，也不暴露编辑器内部服务。

适用场景：

- 需要工作台原生外观与交互（侧栏视图、编辑器标签），而非 iframe 里自绘的页面。
- 需要在组件里复用编辑器共享的 React 运行时，不额外加载一份框架。
- 扩展愿意让用户显式信任：组件与编辑器界面同 realm，能力边界是契约不是沙箱。

普通需求请优先用 [Tree View](./contribution-points.md#views)（数据驱动、无需受信）或 [自定义编辑器与 Webview](./webview-guide.md)（隔离更好、无需受信）。

## manifest 写法

```jsonc
{
  "activationEvents": ["onView:acme.serviceStatus"],
  "contributes": {
    "trustedViews": [
      {
        "id": "acme.serviceStatus",
        "name": "Service Status",
        "location": "view",
        "container": "explorer",
        "entry": "./dist/renderer/status.js",
        "icon": "$(pulse)"
      },
      {
        "id": "acme.serviceDetail",
        "name": "Service Detail",
        "location": "editor",
        "entry": "./dist/renderer/detail.js"
      }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 匹配 `^[A-Za-z][A-Za-z0-9._-]*$`，全局唯一；冲突时后扫描到的条目被跳过并记 warning |
| `name` | 是 | 显示名，支持 `%key%` 本地化 |
| `location` | 是 | `"view"`（侧栏视图）或 `"editor"`（编辑器标签） |
| `container` | `view` 必填 | `explorer` / `search` / `scm` / `outline`，或本扩展/其他扩展在 `viewsContainers.activitybar` 声明的容器 id；`editor` 禁止填写 |
| `entry` | 是 | 相对扩展根、不得逃逸（`..`、绝对路径、盘符均拒），后缀 `.js` / `.mjs`，必须是浏览器目标 ESM |
| `icon` | 否 | 图标标识 |
| `when` | 否 | 可见性条件，仅 `view` 可用；`editor` 禁止填写 |

字段速查也见 [贡献点参考 · trustedViews](./contribution-points.md#trustedviews)。

## 扩展宿主侧 API

`context.trustedViews.registerProvider(viewId, provider)` 注册**本扩展**的 provider；`context.trustedViews.openEditor(viewId, options)` 打开/聚焦 `location: "editor"` 的标签。API 挂在 `activate(context)` 收到的上下文上，宿主据此知道调用方是谁。

```ts
import type { ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    context.trustedViews.registerProvider('acme.serviceStatus', {
      resolveSession(session) {
        // 每次组件挂载都会调用；在这里做初始化、推首屏数据
        session.postEvent('status', { state: 'idle' })
      },
      handleRequest(session, method, args) {
        // 组件 ctx.request(method, ...args) 的落点；支持 async
        if (method === 'refresh') return refreshStatus(session)
        throw new Error(`unknown method: ${method}`)
      },
    }),
  )
}
```

provider 接口：

| 成员 | 说明 |
|---|---|
| `resolveSession?(session)` | 每次组件挂载调用一次；可 async |
| `handleRequest(session, method, args, token)` | 处理 `ctx.request`；返回值/异常原样回到组件 |

session 对象：

| 成员 | 说明 |
|---|---|
| `id` / `viewId` | 会话 id（每次挂载一个）与视图 id |
| `state` | `editor`：`openTrustedEditor` 传入的 state；`view`：`undefined` || `postEvent(name, data?)` | 推送给组件 `ctx.onEvent` 监听者 |
| `onDidDispose` | 组件卸载、标签关闭或扩展宿主断开时触发 |

`context.trustedViews.openEditor(viewId, { title?, state?, key?, preserveFocus? })` 用于 `location: "editor"`：`state` 必须 JSON 可序列化（会持久化用于恢复）；相同 `viewId` + `key` 已打开时聚焦已有标签而不新开。

`viewId` 归属由宿主校验：必须是**调用方扩展** manifest 声明过的 id；未声明、借用其他扩展的 id 或重复注册同一 `viewId` 都会抛错。同一 id 被两个扩展声明属于歧义，两边的注册都会被拒绝并记宿主 warning。所有 `args`、返回值与事件 `data` 都必须 **JSON 安全**（走 stdio 分帧 JSON）。

## 组件模块契约与 ctx

`entry` 指向的模块默认导出一个 React 组件，props 固定为 `{ context }`：

```tsx
import type { TrustedViewContext } from '@universe-editor/trusted-view-api'

export default function StatusView({ context }: { context: TrustedViewContext }) {
  // ...
  return <div>...</div>
}
```

`TrustedViewContext`：

| 成员 | 说明 |
|---|---|
| `extensionId` / `viewId` / `sessionId` | 身份信息 |
| `location` | `'view'` 或 `'editor'` |
| `state` | 编辑器标签的恢复状态；`view` 为 `undefined` |
| `request<T>(method, ...args)` | Promise；转发到 provider 的 `handleRequest` |
| `onEvent(listener)` | 订阅 `session.postEvent`；返回可 dispose 的订阅 |
| `setTitle(title)` | 设置编辑器标签标题；`view` 下忽略 |
| `addStyleSheet(css)` | 注入样式，返回的 disposable 或组件卸载时自动移除 |
| `log.info/warn/error(msg)` | 写入宿主日志 |

组件**只能**通过 ctx 与扩展通信。不要 import 编辑器的任何内部模块，也不要依赖 `window` 上恰好可见的宿主对象——那些都不属于契约。

样式表与资源加载范围收窄到 `entry` 所在目录：组件用相对路径 import 的同目录/子目录产物可以加载，扩展根下其它目录的资源不在允许列表内。需要共享资源时把它构建进 `entry` 目录。

## React 共享与构建

组件**不得打包自己的 React**。编辑器在首次 import 组件之前把共享运行时挂到全局：

```ts
globalThis[Symbol.for('universe-editor.trustedViews.runtime')] = {
  React,
  jsxRuntime: { jsx, jsxs, Fragment },
}
```

构建时把 `react` / `react/jsx-runtime` alias 到读取该全局的 shim。编辑器仓库提供包 `@universe-editor/trusted-view-api`，其中根路径是类型，`./react` 与 `./jsx-runtime` 是 shim。esbuild 示例：

```js
// build.mjs
import { build } from 'esbuild'

await build({
  entryPoints: ['src/renderer/status.tsx'],
  outfile: 'dist/renderer/status.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  alias: {
    react: '@universe-editor/trusted-view-api/react',
    'react/jsx-runtime': '@universe-editor/trusted-view-api/jsx-runtime',
  },
})
```

仓库外扩展拿不到该包时，自带一份等价 shim 也可以——shim 的职责只有从上面那个全局符号取 `React` / `jsx` / `jsxs` / `Fragment` 并导出，不包含 React 本体。打包后的 `entry` 仍必须是浏览器 ESM。

## 受信要求与用户如何信任

受信判定在编辑器界面侧：

- **隐式受信**：内置扩展，以及经 `--extension-development-path` 加载的开发中扩展。
- **显式受信**：其它扩展的 id（`publisher.name`，大小写不敏感）必须出现在用户设置 `extensions.trustedViewExtensions: string[]` 中。该设置 scope 为 **application**，写在工作区/文件夹设置里不生效。
- manifest 自己声明什么都不影响判定。

未受信时：该扩展的所有受信视图都不注册并记 warning；每个扩展每个会话最多通知一次「扩展 X 提供受信视图，需加入受信列表才能加载」，提供 **信任并加载**（写入用户设置并重新应用贡献）与 **忽略** 两个按钮。

扩展宿主侧还有一道二次校验：`context.trustedViews` 携带调用方扩展的 id，provider/open 只能使用**该扩展** manifest 声明过的 `viewId`——它防误用与冒用，不是信任门控，真正的门控在界面侧的受信列表。

## 生命周期

- **激活**：组件首次挂载时宿主派发 `onView:<id>` 激活事件（需显式写进 `activationEvents`），你的扩展在此注册 provider。
- **会话**：每次挂载生成一个 session；组件卸载、标签关闭或扩展宿主断开触发 `onDidDispose`，provider 应在此清理监听。重新挂载会产生新会话。
- **扩展宿主重启**：编辑器界面会重新为所有活动会话调用 `resolveSession`，组件随后重挂载；会话 id 的重复 resolve 是幂等的。
- **编辑器标签恢复**：标签的 `TrustedViewEditorInput` 会序列化 `{ extensionId, viewId, title, state, key }`，重启后自动恢复并重新建立会话。贡献晚到时界面会等待该扩展注册后再挂载。
- **失败隔离**：每个组件包 ErrorBoundary，加载或渲染失败只显示错误占位，不影响编辑器其余部分。

## 安全边界

- 组件与编辑器界面**同 realm**：它能触达 DOM、页面状态与网络。这是**契约边界不是沙箱**，所以默认不加载、只对受信扩展开放。
- 只通过 ctx 通信：不要 import 渲染器 DI、内部模块或主进程 IPC；不要假设内部对象形状稳定。
- 所有跨 RPC 的数据必须 JSON 安全，不要传类实例、函数、循环引用。
- **不要**把凭据、token 或用户敏感数据交给组件，也不要写进组件日志或事件数据。
- 与 webview 相比，受信视图的隔离更弱、能力更强——需要在 README 与市场描述里如实说明组件做了什么（参见 [安全与信任](./security-and-trust.md)）。

## 打包与本地调试

`uex package` 会检查每个 `trustedViews[].entry`：

- 文件必须存在（先构建出浏览器 ESM 产物）；
- 必须被 `files` 白名单覆盖。扩展有 `trustedViews` 但没写 `files` 时，默认打包 `dist/`。

打包仓库外的扩展（也检查 `main` 入口）：

```bash
node scripts/release/package-external-plugin.mjs --extension-dir X:/workspace/acme-tools --out acme-tools.vsix
```

本地开发用 `--extension-development-path` 直接加载未打包目录，它同时被视为隐式受信：

```bash
universe-editor --extension-development-path=X:/workspace/acme-tools
```

改扩展宿主代码后可用「重启扩展宿主」；改了组件模块或 manifest 后重新加载窗口即可看到新的界面侧产物。

## 最小示例

```
acme-tools/
  package.json
  src/extension.ts
  src/renderer/status.tsx
  dist/extension.js        # main
  dist/renderer/status.js  # trustedViews[].entry
```

`package.json`：

```jsonc
{
  "name": "tools",
  "publisher": "acme",
  "version": "0.1.0",
  "engines": { "universe": ">=0.13.0 <1.0.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onView:acme.serviceStatus"],
  "contributes": {
    "trustedViews": [
      {
        "id": "acme.serviceStatus",
        "name": "Service Status",
        "location": "view",
        "container": "explorer",
        "entry": "./dist/renderer/status.js"
      }
    ]
  },
  "files": ["dist"]
}
```

`src/extension.ts`：

```ts
import type { ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    context.trustedViews.registerProvider('acme.serviceStatus', {
      resolveSession(session) {
        session.postEvent('status', { state: 'idle' })
      },
      async handleRequest(_session, method, args) {
        if (method === 'ping') return `pong: ${String(args[0])}`
        throw new Error(`unknown method: ${method}`)
      },
    }),
  )
}
```

`src/renderer/status.tsx`：

```tsx
import { useEffect, useState } from 'react'
import type { TrustedViewContext } from '@universe-editor/trusted-view-api'

export default function StatusView({ context }: { context: TrustedViewContext }) {
  const [status, setStatus] = useState('connecting…')

  useEffect(() => {
    const subscription = context.onEvent((name, data) => {
      if (name === 'status') {
        setStatus(String((data as { state?: string }).state ?? 'unknown'))
      }
    })
    void context.request<string>('ping', 'hello').then((reply) => context.log.info(reply))
    return () => subscription.dispose()
  }, [context])

  return <div>{status}</div>
}
```

## 相关阅读

- [贡献点参考 · trustedViews](./contribution-points.md#trustedviews) — manifest 字段与打包规则
- [扩展的结构](./extension-anatomy.md) — `main` / `contributes` / `activationEvents` 的整体位置
- [安全与信任](./security-and-trust.md) — 扩展权限模型与作者责任
- [自定义编辑器与 Webview](./webview-guide.md) — 不需要受信时的隔离界面方案
