# Extension API 对标 VSCode 补全路线图（0.9.0 之后）

## 1. 背景与基线

0.9.0（2026-08-12）已对标 `vscode.d.ts` 补全一轮 API 面：工具类（`Uri`/`EventEmitter`/
`CancellationTokenSource`/`Disposable` class 化）、新 namespace `env`/`extensions`、
`commands.getCommands`、window（withProgress/setStatusBarMessage/文件对话框/
showTextDocument/选区事件）、workspace（openTextDocument/workspaceFolders/findFiles/
onDidSaveTextDocument/applyEdit/onDidChangeConfiguration/createFileSystemWatcher/
fs.rename+copy）、languages（getLanguages + rangeFormatting/onTypeFormatting/inlayHints，
provider 18→21 类）。完整变更与限制见 `packages/extension-api/COMPATIBILITY.md` 0.9.0 条目。

本计划收录 0.9.0 **明确未做**的内容，按"升级既有降级项 → 中等新面 → 两块大件"分期。
每期独立可发版（各自 bump 一次 minor），期与期无强依赖，可按需要抽单项执行。

**贯穿约束（每期收尾必做）**：

1. 契约测试快照同步：`packages/extension-api/src/__tests__/index.test.ts` 的
   `RUNTIME_EXPORTS` / `NAMESPACE_METHODS` / 枚举断言。
2. 版本 bump **五处联动**（有守卫测试锁定前两处，见 memory
   `extension-api-09-surface-expansion`）：extension-api 的 `src/index.ts` `version` 常量 +
   `package.json`、`packages/uex/src/lib/sdkVersion.ts` 的 `CURRENT_API_VERSION`、
   `packages/create-extension/src/sdkVersions.ts`、`samples/hello-world/package.json`
   （engines + devDep，CI drift check 要求与 scaffold 字节一致）。
3. `COMPATIBILITY.md` 追加变更记录；`docs/extension-dev/zh-CN/` 同步（重点
   `api/README.md` 总览表与 `migration-from-vscode.md` 对照表）。
4. 加 RPC 方法走 `packages/extension-host/CLAUDE.md`「加一条新通道」五步清单；
   wire DTO 仅 JSON 形状，URI 用 `UriComponents` + `URI.revive`。

## 2. P1：升级 0.9.0 的降级实现（简单~中等，多为解除既有限制）

这些项 wire/API 形状已定，只解除实现限制，**多数不改 API 签名**（不 bump 也可发，
但建议攒一批走一次 minor）。

| # | 项 | 现状限制 | 改动落点 | 复杂度 |
|---|---|---|---|---|
| 1.1 | 文件对话框多选/过滤 | `showOpenDialog` 单选、`filters` 不生效（wire 已备好） | `IFileDialogService`（SimpleFileDialog）补 canSelectMany/filters；`MainThreadWindow.ts` 直接点亮，API 零改动 | 中 |
| 1.2 | `applyEdit` 文件级操作 | 含 create/rename/delete 的 edit 整体拒绝返回 false | `apps/editor/src/renderer/services/languageFeatures/typescript/fileBulkEditService.ts` 补文件操作分支（经 `IFileService`）；`MainThreadEditor.$applyWorkspaceEdit` 放行；LSP `WorkspaceEdit.documentChanges` 的 Create/Rename/DeleteFile 转换 | 中 |
| 1.3 | `onDidSaveTextDocument` 覆盖更多保存入口 | 仅 `FileEditorInput.save()` 一条路径 | `apps/editor/src/renderer/services/extensions/DidSaveNotification.ts` 头注有 TODO 清单（Untitled/Merge/SchemaViewer/MarkdownPreview/HtmlPreview）；优先接 Untitled（保存落盘获得 file 身份时通知） | 简单 |
| 1.4 | inlay hints resolve 阶段 | label/tooltip 一次给全，`data` 字段丢弃 | wire 加 `IExtHostLanguages.$resolveInlayHint` 回路（照 `$resolveCodeLens` 模式）；`InlayHintsProvider.resolveInlayHint?` | 简单 |
| 1.5 | `TextEditorSelectionChangeKind.Command` 归因 | Monaco 事件无法区分命令来源，恒不发 Command | 命令侧打标记（`$setSelections` 等已映射 undefined；如需精确需在命令执行路径埋 reason），**优先级低，等真实诉求** | 中 |
| 1.6 | `findFiles` 增强 | glob 仅 string、取消 best-effort（丢弃迟到结果）、100k 枚举上限截断仅 warn | RelativePattern 类型 + wire 取消通道（`$cancelFindFiles(handle)`）；分页协议视需求 | 中 |
| 1.7 | `createFileSystemWatcher` 工作区外监听 | 仅工作区内部事件 | `IFileWatcherService.watchOutOfWorkspace`（`packages/platform/src/files/fileWatcher.ts`）已有原语；`MainThreadFileEvents.ts` 按 watcher 的 base 追加额外路径 | 中 |
| 1.8 | `workspace.openTextDocument` untitled/content 重载 | 仅 Uri/path 形式 | 对齐 VSCode `openTextDocument({ language?, content? })`；renderer 走 Untitled 模型创建 + 既有 DocumentMirrorTracking 管线 | 中 |

## 3. P2：中等新面（diagnostics 读取 + 可见编辑器）

### 3.1 `languages.getDiagnostics` / `onDidChangeDiagnostics`

VSCode 语义是**全源**诊断（含其它扩展与内置），不能只回放本扩展自己的
DiagnosticCollection。落点：

| 文件 | 改动 |
|---|---|
| `packages/extensions-common/src/protocol/rpc.ts` | `IMainThreadLanguages` 加 `$getDiagnostics(uri?: UriComponents)`；`IExtHostLanguages`（或复用推送方向）加 `$acceptDiagnosticsChange(uris: UriComponents[])` |
| `apps/editor/src/renderer/services/extensions/MainThreadLanguages.ts` | 从 Monaco marker service 读全量 markers → LSP Diagnostic 转换（`lspMonacoConvert.ts` 反向）；订阅 `onDidChangeMarkers` 推送变更 uris（**防抖**，仓库有 RPC 洪泛前科；且加"host 侧有监听者才推送"的兴趣订阅，照 `MainThreadFileEvents` 的 interest 计数模式） |
| `packages/extension-host` | `languageProviderRegistry` 或新 `hostDiagnostics.ts`：缓存无必要，直接转发 + `DiagnosticChangeEvent { uris }` |
| extension-api | `getDiagnostics(resource?)` 两重载 + `onDidChangeDiagnostics` |

### 3.2 `window.visibleTextEditors` / `onDidChangeVisibleTextEditors`

现状 `MainThreadEditor` 只镜像 **active** 编辑器（`$acceptActiveEditorChange` 单快照）。
需扩为可见集合镜像：

| 文件 | 改动 |
|---|---|
| rpc.ts | `IExtHostEditor.$acceptVisibleEditorsChange(snapshots: ITextEditorDto[])` |
| `MainThreadEditor.ts` | 订阅 editor groups 布局/标签变化（`IEditorGroupsService`），组装各组当前可见编辑器快照集合推送；复用现有快照组装函数 |
| host `hostHandles.ts` | 可见集合缓存 + `visibleTextEditors` getter + 事件 |

注意：`TextEditor` 在本 API 是快照语义（JSDoc 已确立），visibleTextEditors 沿用，
不引入活句柄。

## 4. P3：`window.createWebviewPanel`（大件一）

现状 webview 面只有 **custom editor**（`registerCustomEditorProvider`，workbench 拥有
tab + iframe，见 `packages/extension-api/src/webview.ts` 与 renderer `WebviewService.ts`）。
createWebviewPanel 是"扩展主动开一个独立 webview tab"，差异在**生命周期反转**：面板由
扩展创建/持有/reveal/dispose，而非由打开文件触发 resolve。

分段：

1. **renderer**：`WebviewService` 增加"panel"形态——不绑定 resource 的 `WebviewInput`
   （EditorInput 子类，**必须覆写 id 防 tab 去重**，见 memory
   `editor-input-identity-isolation`）；iframe/`universe-app` scheme/`asWebviewUri`/
   `localResourceRoots` 与 custom editor 共用现有实现。
2. **wire**：`IMainThreadWebviews` 加 `$createWebviewPanel(handle, viewType, title,
   showOptions, options)` / `$disposeWebviewPanel` / `$revealWebviewPanel` /
   `$setTitle`；`IExtHostWebviews` 加 `$acceptPanelDisposed` / `$acceptPanelViewState
   (active, visible)`（postMessage/html 通道两形态共用现有方法）。
3. **extension-api**：`window.createWebviewPanel(viewType, title, showOptions,
   options?)` 返回 `WebviewPanel`（`webview`/`title`/`visible`/`active`/`reveal()`/
   `onDidDispose`/`onDidChangeViewState`/`dispose()`）；`webview.ts` 现有 `Webview`
   接口复用。
4. **持久化**：首版不做 serializer（关窗即散，VSCode 无 serializer 时同此），JSDoc 注明；
   `retainContextWhenHidden` 视现有 custom editor 的 iframe 保活能力如实支持或注明。

验收：pdf 之外做一个最小 panel 示例（可放 `samples/`）；e2e 冒烟覆盖"命令开 panel →
reveal → 关闭 fire onDidDispose"。

## 5. P4：Tree View（大件二，建议最后做）

`window.registerTreeDataProvider` / `createTreeView`。工作量在 renderer 视图侧而非 RPC：

1. **renderer 视图**：需要一个"扩展树视图"通用组件挂进侧栏视图体系（套路 B：
   Container/View/viewComponentMap 三处 + `contributes.views` manifest 贡献点经
   `ExtensionPointTranslator` 翻译）；树组件复用 `packages/workbench-ui` 的 VirtualList
   惯例（动态测量/滚动锚点坑见 memory `virtual-list-scroll-anchor-restore`）。
2. **wire（拉取式镜像）**：`IExtHostTreeViews.$getChildren(viewId, elementHandle?)`
   （host 把扩展元素映射为 handle + `TreeItemDto`）+ `IMainThreadTreeViews.
   $refresh(viewId, handles?)`；展开/选中/可见性事件回推。对照 VSCode
   `MainThreadTreeViews`/`ExtHostTreeViews`。
3. **extension-api**：`TreeDataProvider<T>`（getTreeItem/getChildren/getParent?/
   onDidChangeTreeData）+ `TreeItem`（label/collapsibleState/command/contextValue/
   iconPath/tooltip）+ `TreeView<T>`（reveal/selection/visible/onDid* 事件）+
   `TreeItemCollapsibleState` 枚举。
4. **菜单集成**：`view/item/context` 菜单贡献点 + `viewItem` context key（照 timeline
   的 `timelineItem` 先例，见 `ExtensionPointTranslator`）。

首版裁剪建议：不做 drag&drop controller、checkbox、badge；`reveal` 可后置
（依赖 getParent，VSCode 也是可选能力）。

## 6. 零散小项（顺手做，不单独排期）

- `env.machineId` / `env.appRoot`（握手 DTO `$initializeEnvironment` 加字段即可）。
- `extensions.onDidChange` 热插拔：当前"扩展集变更一律重启 host"模型下**刻意不 fire**
  （JSDoc 已注明），除非未来支持就地装卸，否则不动。
- `workspace.onDidCreateFiles/onDidDeleteFiles/onDidRenameFiles`：create/delete 可由
  `extHostFileEvents` 通道直接派生；rename 需要 explorer 操作侧打标（raw watcher 无法
  归因 rename），等有真实诉求再做。
- `getExtension` JSDoc 示例 id 形态修正（`'universe.typescript'` → 实际无 publisher 时
  id=name 的形态），下次动 index.ts 时顺手。
- pdf 扩展接回 watcher 自动重载（`extensions-external/pdf/` 代码注释处，
  `createFileSystemWatcher` 已可用，留作文档中的"最小改造练习"或顺手补）。

## 7. 优先级与依赖总览

```
P1（解除限制，随时可做，互相独立）
P2（diagnostics / visibleTextEditors，互相独立）
P3 createWebviewPanel ──┐ 共用 WebviewService，先 P3 后 P4 可少踩一次 webview 坑
P4 TreeView ────────────┘ （但无硬依赖；P4 另依赖套路 B 视图体系）
```

建议节奏：P1 攒一批 + P2 各一项 → 0.10.0；P3 → 0.11.0；P4 → 0.12.0。
每期完成后按第 1 节贯穿约束收尾（契约测试/五处版本联动/COMPATIBILITY.md/
extension-dev 文档），交互类改动跑 `pnpm e2e:smoke` 兜底。
