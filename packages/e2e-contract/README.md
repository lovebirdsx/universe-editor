# @universe-editor/e2e-contract

Universe Editor e2e 探针契约包：`window.__E2E__` 探针的类型与常量（`E2EProbe` 接口 + 探针键常量），供 [`@universe-editor/e2e-harness`](https://www.npmjs.com/package/@universe-editor/e2e-harness) 与编辑器共享同一份真相，避免「测试侧调用的方法与渲染侧实际安装的探针」漂移。

编辑器在 `UNIVERSE_E2E=1` 启动时，把探针安装到 renderer 主世界的 `window.__E2E__`（安装点在 `apps/editor/src/renderer/e2e/probe.ts`）；e2e 侧经本包的类型安全地调用探针方法。

> **0.x 版本政策**：1.0 之前 minor 版本即可携带破坏性变更（semver 0.x 惯例）。

## 契约漂移约定

契约随编辑器演进：本包的 `E2EProbe` 类型与编辑器侧探针安装代码保持一致。升级编辑器时请同步升级本包，否则测试侧会拿到过时或缺失的探针方法定义。

## 探针方法导览

`E2EProbe` 有上百个方法，逐方法签名以 d.ts 的 JSDoc 为唯一真相。这里只做**分组导览**，列扩展作者写 e2e 最常用的方法（每个一句话）：

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

其他常用辅助：`whenReady()` / `whenRestored()`（等生命周期就绪）、`getNotifications()`（当前未关闭的通知）、`createOutputChannel` / `getOutputChannelContent`（断言扩展往 Output 通道写了什么）、`readFileText` / `writeFileText` / `statResource`（经文件服务读写任意 scheme 的资源）。

### getContextKey 的时效性

`getContextKey` 读的是「当下快照」，而 context key 的值随底层事件**异步刷新**——某命令/操作刚改完状态后立刻断言可能读到旧值。对会异步刷新的 context key，断言用 **`expect.poll`** 等它收敛；**语言类断言优先用状态栏条目（`getStatusBarEntries`）而不是 `editorLangId` context key**（后者在 `setTextDocumentLanguage` 等切换后有刷新滞后）。

## 安装

```bash
npm install --save-dev @universe-editor/e2e-contract
```

## License

Apache-2.0
