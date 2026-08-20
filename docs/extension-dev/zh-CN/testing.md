# 测试扩展

> 扩展的两条测试链路（vitest 单测 + Playwright e2e）、e2e 的两个 teardown 门槛（Disposable 泄漏门、ext-host unhandled rejection 门），以及写 e2e 最常用的探针方法导览。以 API 0.13.0 / `@universe-editor/e2e-harness` 0.13.0 为准；脚手架如何搭好这两条链路见 [快速上手 · ⑦ 测试](./getting-started.md#⑦-测试)。

## 两条测试链路

- **单测（`npm test`，vitest）**面向纯逻辑：把命令逻辑抽在 `src/hello.ts`，测试里用 `vi.mock('@universe-editor/extension-api')` 假掉宿主 API 断言 activate 的注册行为，不起编辑器。
- **e2e（`npm run test:e2e`，Playwright）**面向整链路：冷启动一个只加载本扩展的编辑器实例，通过 `window.__E2E__` 探针断言命令注册、输出通道、自定义编辑器渲染等。

## e2e 泄漏门（Disposable leak gate）

harness 的 `page` fixture 在**每个测试的 teardown** 会自动调用 `expectNoLeaks`：它先卸载 React（让 `useEffect` 的 cleanup 跑完、React 自身的订阅不算泄漏），再调用探针的 `computeTeardownLeakReport()` 快照 Disposable 跟踪器——**报告非空即测试失败**，报错形如：

```
N Disposable leak(s) detected at teardown:
[Leak #1] idx=...
    at <renderer 堆栈>
```

判定规则：

- 被跟踪（track）的 Disposable 在 teardown 之后**仍存活**（没被 `dispose`），且沿 parent 链找到的**根不是 singleton**（`markAsSingleton` 过的常驻单例不计入）→ 报泄漏。
- 泄漏报告只留最多 10 条样例，`count` 是真实总数；堆栈来自 Disposable **构造时**抓的 `new Error().stack`。

**最常见的踩坑**：测试结束没关的 **webview 面板**会被判泄漏。测试里打开的面板 / 编辑器要在结束前关掉——例如：

```ts
await window.__E2E__.runCommand('workbench.action.closeActiveEditor')
```

**堆栈难读时的定位法**：报出来的堆栈是**构造点不是泄漏点**——它告诉你这个 Disposable 在哪 `new` 的，但真正的问题是你 spec 里创建了它却没释放。回看你的 spec 最后一步之前创建了什么（面板、编辑器、监听、provider、子进程），补齐对应关闭/释放即可。

**同机制还有一道 ext-host unhandled rejection 门**：扩展宿主进程出现未处理的 promise rejection 时，e2e 同样判失败。两道门叠加，意味着「测试通过」不仅要求断言正确，还要求你的扩展没有遗留资源、没有未处理的异步错误。

## e2e 探针 API 导览

探针是渲染侧注入到 `window.__E2E__` 的测试钩子（仅 `UNIVERSE_E2E=1` 启动时存在），类型定义在 `@universe-editor/e2e-contract`。**本文只做导览、指回 d.ts**——逐方法签名与边界以 `E2EProbe` 接口的 JSDoc 为唯一真相（编辑器里的类型提示即可看），不要背这页。

| 分组 | 常用方法 | 一句话 |
|---|---|---|
| 打开文件 / 编辑器 | `openFileUri(fsPath, options?)` | 按绝对路径打开文件（绕过原生文件选择框） |
| | `getActiveEditorUri()` | 当前活动编辑器 URI 字符串，无则 `undefined` |
| | `openUri(uri)` | 按 URI 打开（任意 scheme，含 remote-ssh） |
| 命令 | `hasCommand(id)` | 某命令 id 是否已进命令注册表（等扩展宿主 boot 用） |
| | `runCommand(id, ...args)` | 经命令服务执行任意命令并 await 其返回值 |
| 状态栏 | `getStatusBarEntries()` | 当前可见状态栏条目快照（id / text / alignment / icon） |
| 语言特性 | `getHover(uri, line, col)` | 任意语言在某位置的 hover 文本（经注册的 hover provider） |
| | `getDefinition(uri, line, col)` | 定义跳转目标 URI（经注册的 definition provider） |
| | `getCompletions(uri, line, col)` | 某位置的补全项 label 列表 |
| | `getCodeActions(uri, range)` | 某区间的 code action（title / kind / 是否带编辑） |
| | `getMarkers(uri, owner?)` | Monaco 诊断标记，可按 owner（诊断集合名）过滤 |
| | `getEditorDecorations(uri)` | 文档上当前绘制的装饰，按 className 找扩展贡献的 |
| Context Key | `getContextKey(key)` | 查某个 ContextKey 当前值（跨作用域回退） |
| | `getConfigurationValue(key)` | 读配置值（经配置服务合并后的结果） |
| 扩展管理 | `installVsixExtension(vsixPath, authority?)` | 装本地 `.vsix`，返回安装后的扩展 id |
| | `getInstalledExtensionIds(authority?)` | 所有用户已装扩展 id（可指定远程 authority） |
| | `setExtensionEnablement(id, enabled, workspace?)` | 全局 / 按工作区启用或禁用扩展 |

其他常用辅助：`whenReady()` / `whenRestored()`（等生命周期就绪）、`getNotifications()`（当前未关闭的通知）、`createOutputChannel` / `getOutputChannelContent`（断言扩展往 Output 通道写了什么）、`readFileText` / `writeFileText` / `statResource`（经文件服务读写任意 scheme 的资源）、`getEditorGroupCount`（断言编辑器组数量）。

### getContextKey 的时效性

`getContextKey` 读的是「当下快照」，而 **context key 的值随底层事件异步刷新**——某命令 / 操作刚改完状态后立刻断言，可能读到旧值。因此：

- 对会异步刷新的 context key，断言用 **`expect.poll`** 等它收敛，不要一次性 `expect(...).toBe(...)`；
- **语言类断言优先用状态栏条目（`getStatusBarEntries`）而不是 `editorLangId` context key**——后者在 `setTextDocumentLanguage` 这类切换后有刷新滞后，状态栏条目更可靠。

## 相关阅读

- [快速上手](./getting-started.md) — 脚手架与 `npm test` / `npm run test:e2e` 两条链路的搭法
- [调试扩展](./debugging.md) — 断点、日志与迭代循环
- [冷启动激活时序](./activation-timing.md) — 激活时机的致命推论（写 e2e 等文档事件前必读）
