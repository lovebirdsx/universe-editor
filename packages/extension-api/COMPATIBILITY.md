# Extension API 兼容性策略

> `@universe-editor/extension-api` 是插件作者编程所依赖的表面（Universe 版的
> `vscode.d.ts`）。本文件定义该表面的**版本承诺、协商语义与破坏性变更流程**。
> 可执行抓手是 `src/__tests__/index.test.ts` 的契约测试——它就是 API 表面的快照。

## 版本即 API 版本

包的 `version` 字段（`src/index.ts` 导出的 `version` 常量与之保持一致）即为 API
版本。扩展在自己的 `package.json` 里用 `engines.universe` 声明所需的兼容区间，宿主
在扫描阶段用 semver 区间做满足性检查（`extensionScanner.ts` 的 `satisfies`）。

```jsonc
// 扩展的 package.json
{
  "engines": { "universe": ">=0.1.0 <1.0.0" }
}
```

## 各级版本号的表面承诺

遵循 semver，但针对"API 表面"给出明确口径：

| 变更级别 | 允许的改动 | 不允许的改动 |
|---|---|---|
| **patch**（`0.1.0 → 0.1.1`） | 修 bug、补全注释、不改变行为的内部实现 | 任何对导出名/方法签名/枚举值的改动 |
| **minor**（`0.1.x → 0.2.0`） | **新增** namespace / 方法 / 接口 / 可选参数 / 枚举成员 | 删除或重命名既有导出；改既有方法签名；改既有枚举值 |
| **major**（`0.x → 1.0`，`1.x → 2.0`） | 删除/重命名导出、改签名、改枚举值等破坏性改动 | —— |

> **0.x 特别说明**：1.0 之前 API 仍在演进，**minor 即可承载破坏性变更**（semver 对
> 0.x 的惯例）。但即便如此，破坏性改动也必须走下方的"破坏性变更流程"，让契约测试
> 快照显式更新、`version` 显式 bump，避免"悄悄删 API、扩展激活时才 `undefined is
> not a function`"。

## engines.universe 协商语义

- 扩展不写 `engines.universe` → 当前按"不校验"放行（见 `scanExtensions` 的
  `hostApiVersion` 为 `undefined` 分支）。**建议所有扩展显式声明**。
- 写了区间但宿主 API 版本不满足 → 该扩展被跳过并记日志，不影响其它扩展。
- 推荐写法：`">=0.1.0 <1.0.0"`（接受整个 0.x 演进）。**不要用 `^0.1.0`**：0.x 下
  caret 等价于 `>=0.1.0 <0.2.0`，会把任何 minor bump——哪怕是向后兼容的纯新增——
  都挡在门外，导致用不到新 API 的扩展被误杀。若某扩展确实依赖某次 minor 引入的新
  能力，则把下界抬到那次 minor（如 `">=0.2.0 <1.0.0"`）。
- 破坏性变更在 0.x 下靠"破坏性变更流程"（契约测试快照 + `version` bump + 变更记录）
  显式把关，而非靠 caret 区间兜底。

## 弃用机制

- 计划移除的接口先打 `@deprecated since x.y — 用 ... 替代` 的 JSDoc，至少保留到下一个
  major（0.x 下至少保留到下一个 minor）。
- 运行时若可行，对已弃用 API 的首次调用打一次 `console.warn`（不重复刷屏）。
- 当前表面**无**已弃用项；本节确立规范，后续新增弃用时遵循。

## 破坏性变更流程

任何会改变 API 表面（删除/重命名导出、改方法签名、改枚举值）的改动：

1. 更新 `src/__tests__/index.test.ts` 里的 `RUNTIME_EXPORTS` / `NAMESPACE_METHODS`
   / 枚举值断言——这是表面快照，diff 即变更评审点。
2. 按上表 bump `src/index.ts` 的 `version` 与 `package.json` 的 `version`。
3. 在本文件追加一条变更记录（见下）。
4. 受影响的内置扩展同步更新其 `engines.universe`。

## 1.0 冻结时间线

1.0 是 API 表面的稳定承诺起点。冻结条件（达成后发布 1.0）：

- 语言 provider 全量迁移到扩展（见 memory `language-features-plugin-migration-roadmap`）后，
  `languages` namespace 表面趋于稳定；
- `window` / `workspace` 的编辑器/文档能力补齐至覆盖内置扩展所需；
- 契约测试覆盖全部 namespace（已达成）。

1.0 之后：minor 仅做向后兼容的新增，破坏性变更一律走 major。

## 变更记录

- `0.1.0` — 首个有记录的 API 表面。namespaces：`commands` / `window` / `workspace` /
  `languages` / `scm` / `ai`。契约测试与本策略文档同时建立。
- `0.2.0` — 新增 webview / 自定义编辑器表面（向后兼容的新增，minor）：
  `window.registerCustomEditorProvider` + `Webview` / `WebviewPanel` /
  `WebviewOptions` / `CustomDocument` / `CustomEditorOptions` /
  `CustomReadonlyEditorProvider`（`src/webview.ts`）。新增激活事件
  `onCustomEditor:<viewType>` 与 manifest 贡献点 `contributes.customEditors`。
- `0.4.0` — 两组向后兼容的新增（minor）：
  - webview diff 表面：`WebviewPanel.diffContext` 可选字段 + `WebviewDiffContext`
    接口（`src/webview.ts`）。当工作台经内部命令 `_workbench.openWebviewDiff` 以
    "两份内容对比"方式打开一个 custom editor 时，provider 在 `resolveCustomEditor`
    里读 `panel.diffContext`（存在→渲染 diff，不存在→单文件预览）。纯新增可选字段，
    不改既有签名。
  - 文档格式化与保存前钩子表面，支撑语言插件做「作为格式化器」与「保存时 fixAll」：
    - `languages.registerDocumentFormattingEditProvider` +
      `DocumentFormattingEditProvider` / `FormattingOptions`。
    - `workspace.onWillSaveTextDocument` + `WillSaveTextDocumentEvent`（含
      `waitUntil(thenable)`）+ `TextDocumentSaveReason` 枚举。宿主在文件保存前同步
      派发该事件，收集各监听器 `waitUntil` 贡献的 `TextEdit[]`（带超时兜底）并应用
      到模型。

- `0.5.0` — 向后兼容的新增（minor）：`languages.setLanguageServerStatus(id, status)` +
  `LanguageServerStatus` 类型（`'starting' | 'ready' | 'error'`）。语言插件（如
  TypeScript）用它上报后端语言服务的启动状态，工作台据此在状态栏显示启动 spinner，
  并让「转到定义 / 查看引用」等导航命令在服务启动期间显示进度、就绪后自动执行，而非
  静默阻塞。纯新增方法，不改既有签名。

- `0.6.0` — 向后兼容的新增（minor）：`workspace.getConfiguration(section).update(key, value)`。
  扩展可通过该方法写入用户级配置；宿主经内部命令 `_workbench.updateConfiguration`
  转发到 renderer 的配置服务。纯新增方法，不改既有签名。

- `0.7.0` — 向后兼容的新增（minor）：timeline 表面（对等 VSCode proposed `timeline` API）：
  `workspace.registerTimelineProvider(scheme, provider)` + `TimelineProvider` /
  `TimelineItem` / `Timeline` / `TimelineOptions` / `TimelineChangeEvent`（`src/timeline.ts`）。
  扩展为给定 URI scheme 注册文件历史 provider，工作台内置 Timeline 视图对活动文件
  分页拉取条目并执行条目 `command`（通常打开 diff）；条目 `contextValue` 经
  `timelineItem` context key 暴露给 `timeline/item/context` 菜单贡献点的 `when` 子句。
  纯新增方法与类型，不改既有签名。

- `0.7.1` — patch：无 API 表面改动（仅注释/内部实现修正），契约测试快照不变。

- `0.8.0` — 新增 manifest 贡献点 `contributes.mcpServers`（由 `c98dea28` 引入）：
  扩展在 `package.json` 里声明式注册 MCP server，替代以往在 settings.json 手写
  `ai.mcpServers` 的配置方式；宿主在激活时收集各扩展的声明并注入 ACP 会话。
  `extension-api` 的导出表面本身无变化，版本 bump 供使用该贡献点的扩展把
  `engines.universe` 下界抬到 `>=0.8.0`。

- `0.9.0` — 大批向后兼容的新增（minor），对标 `vscode.d.ts` 补齐通用表面。
  除注明外均为纯新增，不改既有签名：
  - 工具类（纯本地实现，不过 RPC）：`Disposable` 由 interface 变为 class——新增
    `constructor(callOnDispose)` 与 `static from(...)`，dispose 幂等；保持结构兼容，
    任何实现 `dispose(): void` 的对象字面量仍满足该类型，既有代码无需改动。新增
    `EventEmitter<T>`、`CancellationTokenSource`（配既有 `Event` / `CancellationToken`
    类型）与 `Uri`（`file` / `parse` / `from` / `joinPath` / `fsPath` / `toString` /
    `toJSON`，`UriComponents` 可 JSON 序列化直达 RPC）。
  - 新 namespace `env`：`appName` / `appVersion` / `language` / `sessionId` /
    `uriScheme` 只读属性，`clipboard.readText` / `writeText`（纯文本），
    `openExternal(target)`（http(s) 走系统浏览器，file URI/路径在工作台打开）。
  - 新 namespace `extensions`：`all` / `getExtension(id)` / `onDidChange` +
    `Extension<T>` 接口（`isActive` / `exports` 为实时视图，`activate()` 可触发
    激活）。注意：本产品通过重启扩展宿主应用扩展的装/卸/启停，单个宿主生命周期内
    集合固定，`onDidChange` 不会 fire。
  - `commands.getCommands(filterInternal?)`：列出全部已注册命令 id；
    `filterInternal` 为真时排除下划线前缀的内部命令。
  - `window`：
    - `withProgress(options, task)` + `ProgressLocation` 枚举 + `ProgressOptions` /
      `Progress`：`cancellable` 时 UI 提供取消控件并翻转 task 的 token；
      `ProgressLocation.SourceControl` 当前按 `Window` 渲染。
    - `setStatusBarMessage` 三重载（Disposable / 超时自动隐藏 / Promise settle 自动
      隐藏）。每次调用相互独立，不是 VSCode 的消息栈。
    - `showOpenDialog` / `showSaveDialog` + `OpenDialogOptions` / `SaveDialogOptions`：
      当前对话框实现为单选（`canSelectMany` 仅为兼容保留，结果至多一个 Uri），
      `filters` 不过滤列出的条目。
    - `showTextDocument(target, options?)` + `TextDocumentShowOptions`
      （`preserveFocus` / `preview` / `selection`）。
    - `onDidChangeTextEditorSelection` + `TextEditorSelectionChangeKind` 枚举 +
      `TextEditorSelectionChangeEvent`：防抖派发（一波输入只投递最新选区一次）；
      后台编辑器的选区变化不触发；程序化 `setSelections` 时 `kind` 为 undefined。
  - `workspace`：
    - `openTextDocument(target)`：按 Uri/路径打开文档进编辑器文档模型（不显示），
      已打开的复用不重读磁盘；返回的文档与编辑器共用实时镜像，跟踪后续编辑。
    - `workspaceFolders` / `name` / `asRelativePath` + `WorkspaceFolder`：
      单文件夹模型，`workspaceFolders` 至多一项且 `index` 恒为 0。
    - `findFiles(include, exclude?, maxResults?, token?)`：返回 `Uri[]`；glob 仅
      支持 string（无 RelativePattern）；`exclude` 省略用配置排除项、传 `null`
      完全不排除；取消为 best-effort——跨 RPC 不中止在途搜索，迟到结果被丢弃并
      以空列表 resolve。
    - `onDidSaveTextDocument`：当前仅文件编辑器的保存路径会触发。
    - `applyEdit(edit)`：仅支持文本编辑；含文件级 create/rename/delete 操作的
      `WorkspaceEdit` 整体被拒绝（resolve false）。
    - `onDidChangeConfiguration` + `ConfigurationChangeEvent`
      （`affectsConfiguration(section)` 前缀匹配）。扩展宿主重启期间的配置变更
      会丢失，激活后需重读。
    - `createFileSystemWatcher(globPattern, ...)` + `FileSystemWatcher`：仅观察
      工作区文件夹内部；glob 仅支持 string（无 RelativePattern）。
    - `fs.rename` / `fs.copy`：`target` 已存在且未设 `overwrite` 时 reject；
      两者同样走路径策略管控。
  - `languages`：
    - `getLanguages()`：编辑器当前已知的全部语言 id。
    - `registerDocumentRangeFormattingEditProvider`（Format Selection）。
    - `registerOnTypeFormattingEditProvider`：仅在用户开启 `editor.formatOnType`
      （本产品默认关）时生效。
    - `registerInlayHintsProvider`：一次性返回完整 hint，无 resolve 阶段（LSP hint
      的 `data` 字段被丢弃）；同时 re-export `InlayHint` / `InlayHintLabelPart` /
      `InlayHintKind`。
  - 宿主协议配套：新增 RPC 通道 `extHostWindow`（回推 progress 取消）与
    `extHostFileEvents` / `mainThreadFileEvents`（文件监听事件）；其余能力挂既有
    通道。协议为内部实现细节，不影响扩展侧表面。

## 激活事件清单（activation events）

扩展在 `package.json` 的 `activationEvents` 声明唤醒时机。手写字符串易拼错（拼错则
永不激活），故：

- **优先用构造器**：`@universe-editor/extension-manifest` 的 `ActivationEvents` /
  `commandActivationEvent` / `languageActivationEvent` / `viewActivationEvent`。
- **manifest 校验兜底**：宿主扫描时用 `isValidActivationEvent` 校验，未知事件直接
  报 `invalid manifest` 跳过该扩展（而非静默不激活）。

支持的事件：

| 事件 | 触发时机 | 构造器 |
|---|---|---|
| `*` | 扩展系统启动即激活（eager，慎用） | `ActivationEvents.startup` |
| `onStartupFinished` | 工作台完成初次恢复后 | `ActivationEvents.startupFinished` |
| `onCommand:<id>` | 贡献的命令首次被调用 | `ActivationEvents.onCommand(id)` |
| `onLanguage:<languageId>` | 该语言的文档首次打开 | `ActivationEvents.onLanguage(lang)` |
| `onView:<viewId>` | 贡献的视图首次显示 | `ActivationEvents.onView(viewId)` |
| `onCustomEditor:<viewType>` | 该 viewType 的自定义编辑器首次打开 | `ActivationEvents.onCustomEditor(viewType)` |

新增事件类型时：在 `extension-manifest/src/activation.ts` 加构造器 + 把前缀加入
`PARAMETERIZED_PREFIXES`，并更新本清单。

## API 设计规则

随 npm 对外发布，下列原仓库约定升级为 API 设计的硬规则（违反即破坏第三方扩展，
评审时按破坏性变更对待）：

- **`enum` 一律用普通 enum，禁止 const enum**：本包在 `isolatedModules` 消费场景
  （esbuild bundle 扩展）下 const enum 会触发 TS2748「无法访问 ambient const enum」。
  新增枚举类型时照此办理，不得引入 const enum。
