---
name: excel-viewer-diff-plugin
description: 制作/修改「表格文件（Excel/CSV）预览 + 表格 diff 对比」功能，或任何「需要用扩展的 webview 渲染一个双内容对比（而非单文件）」的功能时召回。本仓库的 Excel Viewer & Diff 插件 = 一条新增的**内核 webview-diff 通路**（`_workbench.openWebviewDiff` 命令 + `WebviewDiffInput` + `WebviewPanel.diffContext`，走 extension-api 五层 + version bump）+ 一个 **out-of-workspace 扩展**（`extensions-external/excel-diff`，SheetJS 解析 + LCS 行对齐单元格级 diff）+ **git/perforce 复用**（各自 openChange 加 .xlsx 分支，二进制 baseline）。当任务涉及：给表格/二进制文件加图形化 diff 预览、扩展要用 webview 渲染「两份内容对比」而非单文件、`_workbench.openWebviewDiff` / `WebviewDiffInput` / `panel.diffContext` 相关改动、SheetJS 解析或 diff 对齐算法、资源管理器「Select for Compare / Compare with Selected」表格分支、SCM（git blob / p4 print）二进制版本对比、或排查「webview diff 打不开 / diffContext 为空 / xlsx 字节损坏」时使用。区别于 webview-custom-editor（造**单文件** webview 预览基建，本 skill 复用它并加 diff 维度）与 create-extension（扩展骨架通用套路）。
disable-model-invocation: true
---

# Excel Viewer & Diff 插件 / webview-diff 内核通路

一个"用扩展的 webview 渲染 **双内容对比**"的完整实例。由三部分组成，改动前先判断你动的是哪部分：

1. **内核 webview-diff 通路**（extension-api 五层 + version bump）——让扩展的 custom editor 除了「按 glob 绑单文件打开」外，还能被内核用**两份字节**命令式打开成一个 diff tab。这是本仓库此前缺的能力（对等 VSCode 的"命令式 createWebviewPanel + 传两个 URI"）。
2. **Excel 扩展**（`extensions-external/excel-diff`）——SheetJS 解析 + 自绘表格；单文件预览与 diff 共用一个 viewType，靠 `panel.diffContext` 区分。
3. **SCM 复用**（git / perforce）——各自 `openChange` 加 `.xlsx` 分支，用二进制 baseline 调 `_workbench.openWebviewDiff`。

> ⚠️ **第一原则**：webview 单文件预览基建（iframe/CSP/焦点/asWebviewUri/五层 RPC）已由 **[webview-custom-editor]** skill 完整覆盖且已修好一堆坑。本 skill 只加"**diff 维度**"这一薄层。做任何 webview 相关改动前，先读那个 skill 建立基建认知——本 skill 不重复它的坑（CSP 继承、iframe 焦点、切 tab 白屏、allowRoots 竞态都在那）。
>
> ⚠️ **第二原则**：diff 内容走 **"内容直传"（base64 字节按值传）**，不走虚拟文件 scheme。这是刻意对齐既有 `_workbench.openDiff`（text 版）的设计——让 git blob / p4 print / 磁盘文件三种来源统一成"两份字节"，SCM 扩展只要能拿到字节就无缝复用同一个 diff 编辑器，不关心字节从哪来。

## 核心设计决策（照抄前先理解）

- **单 viewType 承载预览 + diff**：`universe.excel` 一个 viewType。`resolveCustomEditor` 里 `panel.diffContext` 有 → 渲染双栏 diff，无 → 单文件预览。custom editor manifest 的 glob 只负责"单文件打开"；diff 由命令 `_workbench.openWebviewDiff` 触发，**不经 glob/resolver**（像 openDiff 一样直接 `new WebviewDiffInput` + `openEditor`）。
- **资源管理器 compare 菜单统一（不自建扩展命令）**：扩展**不再**注册 `excel.selectForCompare`/`excel.compareWithSelected`，而是**复用内核原生**的「选择以进行比较 / 与所选项进行比较 / 比较所选文件」（`selectForCompare`/`compareSelected`/`workbench.files.action.compareFiles`）。做法=manifest 的 `customEditors[]` 声明 `supportsDiff: true`；内核 `openFileDiff`（`fileCompareActions.ts`）在建 `DiffEditorInput` 前先 `IEditorResolverService.resolveEditors(right)[0]`，命中 `info.supportsDiff && info.viewType` 则读**二进制**（`IFileService.readFile`，内核侧直接返回 `Uint8Array`）建 `WebviewDiffInput`，否则回退文本 diff。viewType/supportsDiff 由 `IEditorResolverInfo` 携带（`ExtensionsContribution._registerCustomEditor` 注册时透传）。**未声明 supportsDiff 的 custom editor（如 pdf）自动走文本回退，不受影响**。CustomEditorHost 的 diff 分支自带 `activateByEvent`，无需 action 侧再激活。
- **解析在扩展侧（node），webview 是纯 painter**：SheetJS 在扩展进程解析（字节在这里已到手），把**结构化 JSON 模型**塞进初始 HTML 的 `<script type="application/json">`，webview 只读它画表格。SheetJS **bundle 进 node 扩展**（`extension.js` ~1.9MB），不发浏览器构建、不进 webview。
- **`WebviewDiffInput` 是 transient（无 deserialize）**：它持内存字节（git HEAD blob / p4 have-rev 可能不在磁盘），像 `DiffEditorInput` 一样窗口恢复时丢弃 tab。**别**给它加 deserialize（无处取回字节）。
- **SCM 复用必须走二进制 baseline**：git/p4 现有 text diff 用 utf8 解码，会**损坏 xlsx 字节**。必须新增二进制读取路径（`gitExecBinary` / p4 `execBinary`），返回 `Buffer`，base64 后传。

## 五层架构（内核 webview-diff 通路，改 API 才碰）

复用 webview-custom-editor 的五层，只在每层加 diff 维度：

```
① 契约  packages/extension-api/src/webview.ts
        WebviewDiffContext { leftUri, rightUri, left/right: Uint8Array, title }
        WebviewPanel.diffContext?（可选新增字段）
        ⚠️ 纯类型新增 → minor bump：index.ts version 0.3.0→0.4.0 + package.json 同步 +
           COMPATIBILITY.md 变更记录。契约快照 index.test.ts **无需改**（只加可选字段/接口，
           无新 runtime export / namespace 方法）——这点区别于加新 window.* 方法。
② 协议  packages/extensions-common/src/rpc.ts
        IWebviewDiffContextDto { leftUri, rightUri, leftBase64, rightBase64, title }
        （字节 base64 保证 JSON-safe 过 ProxyChannel）
        $resolveCustomEditor 增可选 diff?: IWebviewDiffContextDto 末位参数
③ host   packages/extension-host/src/hostWebviews.ts
        reviveDiffContext(dto)：base64 → Buffer → Uint8Array
        HostWebviewPanel.diffContext（⚠️ exactOptionalPropertyTypes：必须是真 optional
           字段 readonly diffContext?，构造器里 `if (diffContext) this.diffContext = ...`
           条件赋值，**不能**声明成 `readonly diffContext?: X` 却在构造器参数用 `X`——见坑①）
        extensionService.ts resolveCustomEditor 透传 diff；bootstrap.ts $resolveCustomEditor 补参
④ renderer  apps/editor/src/renderer/
        services/extensions/WebviewService.ts  openPanel(viewType, resource, diff?) 末位加 diff，
           透传给 extHost.$resolveCustomEditor
        services/editor/WebviewDiffInput.ts（新建）typeId='webviewDiff'，
           id = `webviewDiff:${viewType}:${leftUri}↔${rightUri}`，transient，focus() 走 WebviewFocusRegistry
        workbench/editor/CustomEditorHost.tsx  resolveOpenArgs(input) 分派两种输入类型
           （CustomEditorInput → 单文件；WebviewDiffInput → 建 diff DTO + toBase64），
           ⚠️ effect 依赖数组用 `input` 不是 `customInput`
⑤ 接入  apps/editor/src/renderer/
        actions/diffActions.ts  OpenWebviewDiffAction（照抄 OpenDiffAction）+ OpenWebviewDiffPayload
           + fromBase64；命令 id `_workbench.openWebviewDiff`（走 _workbench.* 白名单自动放行）
        actions/index.ts  registerAction2(OpenWebviewDiffAction)
        workbench/editor/EditorArea.tsx  editorComponentMap.set('webviewDiff', CustomEditorHost)
        contributions/BuiltInEditorProvidersContribution.ts  注册 webviewDiff provider（**无 deserialize**）
```

### resourceExtname 上下文键（顺带补的内核能力）
资源管理器右键 `when` 子句此前无 `resourceExtname`（VSCode 标准键）。在
`apps/editor/src/renderer/workbench/explorer/ExplorerContextMenu.tsx` 的 `createScoped({...})` 里
加了 `resourceExtname`（`extnameOf(resource)` = 带点小写扩展名如 `.xlsx`）。任何扩展的 explorer 菜单
`when` 现在都能 `resourceExtname == .xlsx || ...`（`||` Or 表达式 contextKeyExpr 支持）。

## Excel 扩展（`extensions-external/excel-diff`，照抄 pdf 但有关键差异）

骨架照抄 `extensions-external/pdf`（见 webview-custom-editor 的 out-of-workspace 构建套路），**差异点**：

```
extensions-external/excel-diff/
  src/extension.ts   provider：resolveCustomEditor 判 panel.diffContext；
                     compare 命令 excel.selectForCompare / excel.compareWithSelected（扩展内部存选中态，
                     读两文件字节 → _workbench.openWebviewDiff）
  src/parse.ts       SheetJS：parseWorkbook(bytes) → WorkbookModel（逐 sheet dense 2-D string 网格；
                     cellText 优先取格式化文本 w，回退 v）
  src/diff.ts        diffWorkbooks(left,right)：按 sheet 名匹配；每 sheet 走 LCS 行对齐
                     （alignRows dp 回溯）→ 删+紧跟插合并为 modified（changedColumns 标单元格级差异）；
                     added/removed/equal 分类 + changeCount
  assets/viewer.html 模板：<!--HEAD--> 注 CSP+css，<!--BODY_SCRIPT--> 注 payload script + viewer.mjs
  assets/viewer.mjs  纯 painter：读 #excel-payload JSON → 画单文件表格 or 双栏 diff（sheet 标签 +
                     变更计数 badge + 「只看差异」过滤 + 增删改高亮）
  assets/viewer.css  diff 配色（--added/removed/modified/cell-changed）
  package.json       ⚠️ 有自己的 node_modules（装 xlsx，不同于 pdf 无依赖）；engines.universe >=0.4.0；
                     customEditors glob *.xlsx/*.xls/*.xlsm/*.csv；explorer/context 菜单 when resourceExtname==
  esbuild.config.mjs bundle src→dist，xlsx 一起打进；.html text loader；alias extension-api→dist（同 pdf）
  scripts/pack.mjs   同 pdf：压 extension/** 结构 .vsix
```

**扩展侧关键约定**：
- `uri2fsPath`：`file:` UriComponents → OS 路径（Windows 剥 `/C:/` 前导斜杠）喂给 gated `workspace.fs.readFile`。
- payload 嵌 `<script type="application/json">`：`escapeJsonForScript` 只需转义 `<`/`&`（`textContent`+`JSON.parse` 读，不 eval）。
- `localResourceRoots` 单文件预览要含文档目录（`dirUri`）；diff 无文档目录只需扩展目录（字节按值传，webview 不加载文档资源）。

## LCS 行对齐算法（diff 质量的核心，`src/diff.ts`）

- `alignRows(left, right)`：经典 LCS（dp[i][j] = 后缀 LCS 长度）回溯成对齐对 `[leftIdx|-1, rightIdx|-1]`。行按 `rowKey`（cells join 空格）匹配。**价值**：中间插入一行 → 1 added + 其余 equal，**不级联**成一片 modified。
- **删+插合并**：一个 removal 紧跟一个 insertion → 合并成 `modified` 行 + `changedColumns` 标出差异列（"同一行改了几个单元格"的常见情形），而非拆成 remove + add。
- 已用真实数据验证：`[a,b,c] vs [a,b9,c,d]` → equal / modified(changed=[1]) / equal / added；`[a,b,c] vs [a,x,b,c]` → 1 added + 3 equal。改算法后务必回验这两个场景。

## 已知坑

1. **`exactOptionalPropertyTypes` 下 optional 字段**（TS2420/TS2379）：`HostWebviewPanel.diffContext` 声明成 `readonly diffContext?: WebviewDiffContext`，构造器参数 `diffContext?: X` 后**条件赋值** `if (diffContext) this.diffContext = diffContext`。直接 `readonly diffContext?: X` 当构造器参数（`T | undefined` 派生）会被判"incorrectly implements interface"。这是本仓库 strict 三件套的通病。
2. **命令白名单**：`_workbench.openWebviewDiff` 靠 `_workbench.` 前缀在 `MainThreadCommands.ts` 的 `HOST_INVOKABLE_PREFIX` 自动放行——扩展经 `commands.executeCommand` 能调。换非 `_workbench.` 前缀的命令名会被拒。
3. **SCM 二进制 baseline**：git `gitExecBinary`（stdout 收 Buffer 不 utf8 decode，stderr 仍 text）；p4 `execBinary` + `BaselineProvider.getHaveContentBytes`（**不进** string print 缓存）。用现成的 text `getHaveContent` / `gitExec` 读 xlsx 会静默损坏字节 → webview 里 SheetJS 解析报错。
4. **CustomEditorHost 复用两输入**：`resolveOpenArgs` 分派；effect 依赖 `[webviewService, extensionHost, input]`（不是旧的 `customInput`）。漏改依赖 → 切换 diff/单文件 tab 不重挂。
5. **base64 双跳开销**：字节 ext→core（DTO）→ext（revive）跳两次。xlsx 通常几 MB 可接受；超大表格是潜在瓶颈（未做流式）。
6. **WebviewDiffInput 无 deserialize**：窗口恢复丢 diff tab（刻意，同 DiffEditorInput）。别为"恢复"给它加 deserialize——字节无处取回。
7. **SheetJS npm 版本**：registry 上是 `0.18.5`（有已知 advisory），CDN 版更新但非 registry。当前用 0.18.5。

## 验证

```bash
pnpm check                                    # lint+typecheck+test（47 tasks），仅看错误
pnpm build                                    # e2e 跑 out/ 产物，改 renderer/main 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.webviewDiff.spec.ts
                                              # 守护 _workbench.openWebviewDiff → WebviewDiffInput →
                                              # CustomEditorHost 传 diffContext → 扩展解码渲染两侧（内联扩展，不装真 SheetJS）
# 扩展侧：cd extensions-external/excel-diff && npm install && node esbuild.config.mjs && node scripts/pack.mjs
# diff 算法快验：esbuild bundle src/diff.ts → import data:URL → 跑上面两个场景断言
pnpm docs:check                               # 动了 docs/user 后校验死链
```

E2E 范例 `apps/editor/e2e/specs/smoke.webviewDiff.spec.ts`：内联极简 diff-capable 扩展（读 `panel.diffContext`、`TextDecoder` 解码 left/right 写进 iframe），`runCommand('_workbench.openWebviewDiff', payload)` 触发，poll `getActiveEditorTypeId()==='webviewDiff'`，`frameLocator` 断言两侧文本渲染。**不装真 SheetJS**（headless 稳定），只守护内核通路。

## 关键参考路径

- **内核通路**：`packages/extension-api/src/webview.ts`（契约 + bump 点）/ `extensions-common/src/rpc.ts`（DTO）/ `extension-host/src/hostWebviews.ts`（reviveDiffContext）/ `apps/editor/src/renderer/services/editor/WebviewDiffInput.ts` / `workbench/editor/CustomEditorHost.tsx`（resolveOpenArgs）/ `actions/diffActions.ts`（OpenWebviewDiffAction，照抄 OpenDiffAction）
- **Excel 扩展**：`extensions-external/excel-diff/`（`src/{extension,parse,diff}.ts` + `assets/viewer.{html,css,mjs}`）
- **SCM 复用**：`extensions/git/src/{gitService.ts(gitExecBinary),repository.ts(_openSpreadsheetChange)}` / `extensions/perforce/src/{p4Service.ts(execBinary),baselineProvider.ts(getHaveContentBytes),client.ts(_openSpreadsheetChange)}`
- **resourceExtname**：`apps/editor/src/renderer/workbench/explorer/ExplorerContextMenu.tsx`
- **用户文档**：`docs/user/zh-CN/customization/extensions.md`（"扩展可以提供的自定义预览"节）
- 相关 skill：**[webview-custom-editor]**（webview 单文件预览基建 + 全部 iframe/CSP/焦点坑，**必读前置**）、[create-extension]（扩展骨架）、[extend-perforce-plugin]（p4 扩展全景）、[fix-disposable-leak]（panel/iframe 生命周期）
- 相关 memory：[[editor-input-identity-isolation]]（EditorInput id 隔离，WebviewDiffInput 的 id 命名空间遵它）、[[realpath-uri-ipc-revive]]（wire URI revive）

## 其它
- 后续用本 skill 发现新经验，需同步更新本文件。
- 扩展目前需手动 `.vsix` 安装（同 pdf，未进内置扩展列表）。
