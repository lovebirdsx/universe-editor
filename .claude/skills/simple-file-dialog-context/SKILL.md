---
name: simple-file-dialog-context
description: 处理「应用内文件/文件夹选择对话框」相关功能时召回，提供 SimpleFileDialog 子系统的完整上下文地图——它是 renderer 端基于 QuickInput 的路径浏览器（对标 VSCode files.simpleDialog.enable），替换了所有原生 OS 对话框。涵盖：四层 QuickInput 链路（platform IQuickPick → renderer QuickInputService → workbench-ui QuickPickState/Panel）、值驱动的键盘交互（输入路径 / 上下键补全 / 回车进目录·打开 / 结尾分隔符确认目录 / ~ 展开主目录 / Windows 盘符切换与盘符列表）、纯函数 helper、IFileDialogService 接口与五个调用点、IFileService.listDrives 跨进程能力。当任务涉及 SimpleFileDialog、showOpenDialog/showSaveDialog、文件选择器的键盘交互/自动补全/盘符处理/下划线显示、QuickInput 的 autoFocusFirstItem/activeItems/valueSelection 行为，或要理解「这个对话框怎么拼起来、值与列表如何同步」时，先读它建立全局认知。QuickInput 本身作为命令面板/快速选择的通用基建另见各自调用方。
disable-model-invocation: true
---

# SimpleFileDialog 子系统 上下文地图

`SimpleFileDialog` 是一个 **renderer 端、纯键盘优先** 的文件/文件夹/保存浏览器，注册为 `IFileDialogService` 的单例实现，**替换了全部原生 OS 对话框**（对标 VSCode `files.simpleDialog.enable`）。它复用通用 QuickInput 浮层做 UI，文件系统访问经 `IFileService` 走 IPC 到 main。

> ⚠️ 第一原则：这是个 **值驱动（value-driven）** 的对话框 —— **输入框里的路径字符串是唯一事实来源**，列表只是它的投影。改交互前先想清楚你动的是「输入值 → 列表」（onValueChange）还是「列表/高亮 → 输入值」（onActiveChange）这两条方向中的哪一条，别让它俩打架成回环。

## 四层 QuickInput 链路（SimpleFileDialog 骑在其上）

```
packages/platform/src/workbench/quickInputService.ts
  IQuickPick<T> 接口（value/items/activeItems/valueSelection/keepOpenOnAccept/
                       autoFocusFirstItem + onDid* 事件）—— 纯类型契约
        │
apps/editor/src/renderer/services/quickInput/QuickInputService.ts
  IQuickInputService 实现：createQuickPick() 用闭包 + Emitter 造出 qp；
  每个 setter 调 pushState() 把当前态拍平成 QuickPickState 推给 React
        │  pushState()
packages/workbench-ui/src/feedback/quickInput/quickInputViewModel.ts
  QuickPickState（纯数据 view model）+ 回调（onValueChange/onActiveChange/onAccept/onOk…）
        │
packages/workbench-ui/src/feedback/quickInput/QuickInputPanel.tsx
  纯展示组件：渲染输入框 + 虚拟列表；键盘/鼠标 → 回调
  （宿主薄 wrapper QuickInputPortal 负责 useService 订阅 + createPortal + 注入图标）
```

**关键事实（已核实，改之前先记住）：**
- **程序设置 `qp.value` 不会 fire `onDidChangeValue`** —— 没有回环。所以 onActiveChange 里改 value 是安全的，不会再触发 onValueChange。
- **程序设置 `qp.activeItems` 会**经 panel 同步 focus 并 fire `onDidChangeActive`。这是「列表高亮 → 自动补全输入值」的驱动机制。
- **FakeQuickPick（host 单测里的）不自动 fire onActiveChange**：设 `activeItems` 只存值；测「设高亮→补全 value」要手动 `qp.fireActive(item)`（对标 panel 行为）。这是单测和生产的唯一行为差。
- `autoFocusFirstItem = false`（SimpleFileDialog 专用）：列表不再随 items 变化自动高亮首项，focus 完全由 `activeItems` + 用户上下键/鼠标驱动。Panel 侧据此关掉「hover 改 focus」（`onMouseMove` 被 gate），否则导航后鼠标静止悬停在新项上会乱触发补全。
- `keepOpenOnAccept = true`：accept 一项后面板不关，由 SimpleFileDialog 自己决定关不关（进目录 vs 选定）。

## 核心：SimpleFileDialog 的交互逻辑

`apps/editor/src/renderer/services/dialogs/SimpleFileDialog.ts`（注册为 `IFileDialogService` 单例）

`_show(opts, mode)` 里建一个 qp，挂 5 个事件处理：

| 事件 | 处理函数 | 职责 |
|---|---|---|
| `onDidChangeValue` | `onValueChange` | **值 → 列表**：解析输入路径，必要时切目录/切盘符列表，按尾段前缀高亮 |
| `onDidChangeActive` | `onActiveChange` | **高亮 → 值**：把当前高亮项补全进输入框，选中未输入的尾巴 |
| `onDidAccept` | `onAccept` | 回车/点击：优先按「选中的具体项」动作（进目录/打开/保存），否则解析输入值 |
| `onDidTriggerOk` | `acceptValue(qp.value)` | OK 按钮：直接按输入值解析 |
| `onDidTriggerButton` | 切 `showDotFiles` + 重列 | 显示/隐藏隐藏文件 |

**两个核心私有动作：**
- `updateItems(folder, { resetInput })`：拉 `fileService.list(folder)` 重建列表。`resetInput:true`（导航类）会把输入框重置为 `display(folder)+sep`；`resetInput:false`（手动改路径触发的刷新）**不动输入框**（避免 clobber 用户正在敲的字）。用 `navToken` 守卫异步 list 竞态。**也是盘符列表的入口**（见下）。
- `acceptValue(value)`：把输入值当路径解析 —— 目录则进入或选定，文件则打开，save 模式则确认覆盖。结尾带分隔符 = 「这个目录本身」。

### 已落地的对标 VSCode 行为（A~D + ~ + Windows 盘符）

- **[A] 手动改目录列表同步**：`onValueChange` 用 `splitTrailingSegment(value)` 拆 `{dir, name}`，若 `dir` 对应目录 ≠ 当前且 stat 为目录 → `updateItems(dirUri, {resetInput:false})`。
- **[B] 输入时高亮匹配项**：`applyMatch(name)` 在 currentItems 里找 label 前缀匹配的项，设 `activeItems`。删字时（`isDeletion`）不强制高亮，免得跟退格打架。
- **[C] 上下键移动 + 路径补全 + 回车定型**：`onActiveChange` 把高亮项补全成 `display(folder)+sep+label`，`valueSelection` 选中用户未输入部分（下次按键替换）。
- **[D] 结尾分隔符回车直接确认目录**：`acceptValue` 中 `endsWithSeparator` + 目录 + `canSelectFolders` → 直接 finish。
- **`~` 展开主目录**：`expandTilde` 在 onValueChange 最前面处理（`~`/`~/`/`~\` → home+sep）。
- **Windows 盘符**（见下节）。

### Windows 盘符处理（win32 专属，`this._sep === '\\'`）

三个判定/构造 helper：`_driveListRoot()`（= `URI.file('/')`，盘符列表的合成根）、`_isDriveListRoot(uri)`（win32 且 path === '/'）、`_displayWithSep(uri)`（保证单尾分隔符，因盘根 fsPath 自带 `/`）。

- **输入盘符切盘**：`D:\` → `_uriFromInput` 把裸盘符 `D:` 补回斜杠成 `D:/`（裸 `D:` 指向盘的工作目录而非根，必须补斜杠），经 [A] 分支 stat + `updateItems` 切到 D 盘根。
- **裸片段 → 盘符列表**：`onValueChange` 里 **`dir === '' && win32`** 判定为「用户清空后从顶层重新输入盘符」 → 切到盘符列表（`updateItems(driveListRoot)`），并用输入字母前缀匹配高亮盘符（输入 `f` → 高亮 `F:`）。**这条专门修了「全选后输入单字母被错误补全成 `当前路径\匹配项`」和「输入盘符字母不出盘符列表」两个 bug**。空输入是它的子集（name===''，只列盘符不高亮）。
- **盘符列表态**：`updateItems` 在 `_isDriveListRoot(folder)` 时改为枚举 `fileService.listDrives()`（无 `..`）；`setInputToFolder` / onActiveChange 的 prefix 在该态为空串；从盘根按 `..` 上行（其父正是 `/`）回到盘符列表。
- **跨进程能力 `IFileService.listDrives?()`**（**可选**方法）：main 端 `FileSystemMainService` 在 win32 探测 A–Z 盘根返回 `['C:', 'D:', …]`，非 win32 返回 `[]`。设为**可选**是因为大量测试 fake 全量实现 `IFileService`，必填会全炸；调用处用 `(await this._fileService.listDrives?.()) ?? []`。

## 纯函数 helper（无副作用，易单测）

`apps/editor/src/renderer/services/dialogs/simpleFileDialogUtil.ts`

- `prepareEntries(entries, {allowFiles, showDotFiles})` —— 目录在前文件在后各自排序；过滤 dotfile / 非目录。
- `splitTrailingSegment(value)` —— 拆成 `{dir(含尾分隔符), name}`；无分隔符则 `{dir:'', name:value}`。识别 `/` 和 `\` 两种分隔符。
- `endsWithSeparator` / `expandTilde(value, home, sep)` / `isDeletion(prev, next)`（next 是 prev 的更短前缀）/ `findCompletion` / `completePath`。

## 注册接入点 & 调用方

- **DI 注册**：`SimpleFileDialog.ts` 末尾 `registerSingleton(IFileDialogService, SimpleFileDialog, InstantiationType.Delayed)`。renderer 直接注入用。
- **接口契约**：`packages/platform/src/dialog/fileDialogService.ts` —— `IFileDialogService` + `IFileDialogOptions`（`title` / `defaultUri?` / `canSelectFiles` / `canSelectFolders` / `openLabel?`）。改接口记得在 `packages/platform/src/index.ts` re-export（已 export）。
- **五个调用点**（都注入 `IFileDialogService` 调 `showOpenDialog`/`showSaveDialog`，取 `uri.fsPath`/`uri`）：
  - `actions/fileOpenActions.ts`、`actions/fileSaveActions.ts`、`actions/workspaceActions.ts`、`actions/windowActions.ts`、`actions/configLocationActions.ts`（最后一个原生框已消除）。
- **UI 下划线裁切修复**：`packages/workbench-ui/src/feedback/quickInput/QuickInput.module.css` 的 `.input`（`height:40px; line-height:40px;`）——下划线/descender 显示问题改这里，验证靠 Playwright 截图 + 人工看图。

## 常见任务 → 改哪里

- **改路径输入的解析/补全行为**：`SimpleFileDialog.onValueChange`（值→列表）+ `onActiveChange`（高亮→值）。先确认你动的是哪条方向，避免回环。
- **改回车/点击的动作（进目录/打开/保存/确认）**：`onAccept` + `acceptValue`。`onAccept` 优先按「具体选中项」动作（不依赖输入值，免得跟补全竞速），无选中项才解析 `qp.value`。
- **改盘符相关**：`_uriFromInput`（裸盘符补斜杠）、`onValueChange` 的 `dir===''` 分支、`updateItems` 的 `_isDriveListRoot` 分支、`FileSystemMainService.listDrives`。
- **改「显示/隐藏隐藏文件」「列表排序过滤」**：`onDidTriggerButton` + `prepareEntries`。
- **加纯逻辑**：优先抽到 `simpleFileDialogUtil.ts` 写纯函数 + 单测，别堆进 `_show` 闭包。
- **改面板通用行为（focus 重置 / Enter / hover）**：`QuickInputPanel.tsx` —— 注意它是**通用** QuickInput，命令面板等都共用；用 `autoFocusFirstItem` 等 flag 区分 SimpleFileDialog 专属行为，别写死。
- **新增对话框选项**：扩 `IFileDialogOptions`（platform）→ 在 `_show` 消费 → 调用方传入。

## 易踩坑速记

1. **值 ↔ 列表回环**：程序设 `qp.value` 不 fire onValueChange（安全），但设 `qp.activeItems` 会 fire onActiveChange（→改 value）。别在 onValueChange 里又设 activeItems 又指望它不反过来动 value 造成抖动；现有代码靠「程序设 value 不回环」这一事实成立。
2. **`resetInput` 用错**：导航（进目录/上行）用 `true`，手动改路径触发的刷新用 `false`，否则会把用户正敲的字 clobber 回旧目录路径（这是历史 bug A 的根因）。
3. **裸盘符丢斜杠**：`D:`（无斜杠）= D 盘工作目录 ≠ `D:\` 根。`_uriFromInput` 必须给裸盘符补回斜杠。
4. **盘根 fsPath 自带尾斜杠**：`URI.file('C:/').fsPath === 'C:/'`，普通目录无尾斜杠。拼输入值用 `_displayWithSep`（幂等加单分隔符），别手动 `+sep` 造成 `C:\\`。
5. **win32 判定统一用 `this._sep === '\\'`**：盘符所有逻辑都 gate 在它后面，非 Windows 维持「裸片段在当前目录内匹配」的旧行为。
6. **`autoFocusFirstItem=false` 必须配合 panel 关 hover**：否则导航后鼠标静止悬停新项 → `onMouseMove` 乱触发补全（历史 e2e 失败根因）。
7. **host 单测设 activeItems 不自动补全**：FakeQuickPick 不 fire onActiveChange，测补全要 `qp.fireActive(item)`。
8. **`listDrives` 是可选方法**：调用必带 `?.()`；新写 IFileService fake 不需要实现它。
9. **测试环境**：host 单测在 **renderer-node**（无 DOM），测试内 `globalThis.window = { ipc: { platform, home } }` 切平台；panel 单测在 **workbench-ui happy-dom**（`src/__tests__/`）。

## 验证

```bash
# host 交互单测（A~D + ~ + Windows 盘符，含 FakeQuickPick + 内存 FakeFileService）
pnpm --filter @universe-editor/editor exec vitest run --project renderer-node \
  src/renderer/services/dialogs/__tests__/SimpleFileDialog.test.ts
# 纯函数单测
pnpm --filter @universe-editor/editor exec vitest run --project renderer-node \
  src/renderer/services/dialogs/__tests__/simpleFileDialogUtil.test.ts
# panel 单测
pnpm --filter @universe-editor/workbench-ui test
# 改了 platform 接口（如 IFileService/IFileDialogService）必重建
pnpm --filter @universe-editor/platform build
pnpm check                                   # lint + typecheck + 全量 test（仅截错误）
# e2e（@p1）：改 renderer 后必先 build out/，再跑冒烟
pnpm --filter @universe-editor/editor build
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts --grep "simple file dialog"
```

## 关键参考路径

- `apps/editor/src/renderer/services/dialogs/SimpleFileDialog.ts` —— 交互主逻辑（onValueChange/onActiveChange/onAccept/updateItems/acceptValue + 盘符 helper）
- `apps/editor/src/renderer/services/dialogs/simpleFileDialogUtil.ts` —— 纯函数 helper
- `apps/editor/src/renderer/services/dialogs/__tests__/SimpleFileDialog.test.ts` —— host 单测（FakeQuickPick + FakeFileService + win32 盘符 fake）
- `packages/platform/src/dialog/fileDialogService.ts` —— `IFileDialogService` / `IFileDialogOptions` 契约
- `packages/platform/src/files/fileService.ts` —— `IFileService`（含可选 `listDrives?()`）
- `apps/editor/src/main/services/files/fileSystemMainService.ts` —— main 实现（`listDrives` 探测 A–Z）
- `packages/platform/src/workbench/quickInputService.ts` —— `IQuickPick` 接口（autoFocusFirstItem 等）
- `apps/editor/src/renderer/services/quickInput/QuickInputService.ts` —— QuickInput 实现（pushState）
- `packages/workbench-ui/src/feedback/quickInput/quickInputViewModel.ts` —— `QuickPickState` view model
- `packages/workbench-ui/src/feedback/quickInput/QuickInputPanel.tsx` —— 通用面板（focus/Enter/hover，autoFocusFirstItem gate）
- `packages/workbench-ui/src/feedback/quickInput/QuickInput.module.css` —— `.input` 下划线显示
- 调用点：`apps/editor/src/renderer/actions/{fileOpen,fileSave,workspace,window,configLocation}Actions.ts`
- e2e：`apps/editor/e2e/specs/smoke.simpleFileDialog.spec.ts`

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件