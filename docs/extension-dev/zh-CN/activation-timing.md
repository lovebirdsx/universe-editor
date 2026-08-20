# 冷启动激活时序

> 冷启动时扩展从「编辑器恢复」到 `activate()` 返回的精确时序，以及它带来的一个致命推论：**不要在 `activate()` 里等文档或编辑器**。写激活逻辑、做语言扩展之前必读。以 API 0.13.0 为准。

## 激活顺序

```
① workbench 恢复编辑器
    主进程恢复上次会话，渲染进程重建编辑器组：创建文档模型、做语言解析。
    此时扩展的 contributes.languages 还没生效，文件先落到 plaintext 兜底。

② 扩展宿主 spawn
    扩展宿主进程启动。

③ getContributions / 静态贡献翻译
    宿主收集所有扩展的 package.json，把 contributes（commands / menus / languages /
    grammars / views …）翻译进宿主注册表。contributes.languages 等静态贡献此时才生效。

④ 冷启动语言关联（重推）
    contributes.languages 注册后，宿主对已打开的 plaintext 模型重新解析语言（对齐 VSCode），
    匹配到新语言的文档会 close(旧) + open(新) 重推——扩展收到 close(plaintext) 与 open(新语言)。

⑤ activateByEvent 派发
    '*' → 'onStartupFinished' 在扩展系统启动阶段统一派发；
    'onLanguage:<id>' 由文档镜像推送前触发（即上一步重推 open 之前）。

⑥ activate() 执行

⑦ activate() 返回后，文档镜像 $acceptDocumentOpen 才落地
    首文档推送等待 activate 返回——这就是「在 activate 里等首文档会死锁」的根因。
```

一句话串起来：**静态贡献先于激活事件，激活事件先于 `activate()`，`activate()` 先于文档镜像落地。**

## 致命推论：activate() 里不要等文档 / 编辑器

首文档镜像在 `activate()` 返回后才落地，所以在 `activate()` 里 `await getActiveTextEditor()` 或等待第一个文档事件会死锁。宿主的**最新行为**已经把这两处修成了「不会挂起」：

- **`getActiveTextEditor()`**：在激活期间镜像未就绪时**立即 resolve `undefined`**，而不是挂起等待。所以它不会再死锁，但你在 `activate()` 里同步拿到的也一定是 `undefined`，读不到已打开的文件。
- **`onDidOpenTextDocument`**：对订阅时**已经打开的文档**会异步补发一次 open 事件——所以激活后再注册的监听不会漏掉冷启动就已打开的文档。

因此正确写法是「**activate 里只注册监听，事件驱动处理**」，不要同步读、也不要 await 文档/编辑器：

```ts
import { window, workspace, type ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  // 正确：只注册监听。冷启动就已打开的文档，宿主会异步补发一次 open 事件覆盖到。
  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => {
      handle(doc)
    }),
    window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        handle(editor.document)
      }
    }),
  )
}
```

反例——在 `activate()` 里同步取编辑器 / 等首文档，拿到的一定是空：

```ts
export async function activate(context: ExtensionContext) {
  // 反例：激活期间镜像未就绪，立即 resolve undefined，永远读不到已打开的文件
  const editor = await window.getActiveTextEditor()
  if (editor) {
    // 这段永远不会执行到
  }
}
```

## visibleTextEditors 的镜像延迟语义

`visibleTextEditors` 是「当前可见的文本编辑器」集合，**每个编辑器组一项**（取其活动编辑器），split view 每侧一项；自定义编辑器不出现。每一项都是**快照**——语义与 `getActiveTextEditor` 一致，应在 `onDidChangeVisibleTextEditors` 触发后重新读取，不要长期持有句柄。

它有一个**镜像延迟**语义（冷启动语言扩展最容易踩）：一个**冷文档**（首次被触碰从而触发其语言激活的文件）进入集合的时机比它自己的 tab 略晚——在它的镜像落地之前，getter 与事件都只携带**已经镜像的成员**，随后在 `onDidChangeVisibleTextEditors` 上收敛。所以刚打开一个会触发语言激活的文件时，`visibleTextEditors` 可能短暂缺这一项；等镜像落地（或等事件补发）再看就是齐的。

## 冷启动语言关联

贡献一门语言（`contributes.languages`）不需要 `main` / `activationEvents`——语言声明在启动阶段静态生效。但如果你还注册了语言特性 provider（补全 / 跳转 / 诊断等），就要用 `onLanguage:<id>` 触发激活，并理解冷启动时的重推语义：

- 冷启动时文件先按 `plaintext` 打开（你的语言声明还没生效）；
- 你的 `contributes.languages` 注册后，宿主对已打开的 plaintext 模型**重新解析语言**，匹配到的文档会 **close(旧语言) + open(新语言) 重推**；
- 你的扩展因此收到 `onDidCloseTextDocument`(plaintext) 与 `onDidOpenTextDocument`(你的语言)，provider 挂到重推后的文档上即可。

语言关联的完整检测顺序与「扩展声明优先于内置表」规则见 [贡献点参考 · languages](./contribution-points.md#languages)。

## 相关阅读

- [扩展的结构](./extension-anatomy.md) — `activationEvents` 清单与激活生命周期
- [API 概览](./api/README.md) — `getActiveTextEditor` / `visibleTextEditors` / `onDidOpenTextDocument` 的运行时语义
- [语言特性](./language-guide.md) — 注册语言 provider 的完整套路
