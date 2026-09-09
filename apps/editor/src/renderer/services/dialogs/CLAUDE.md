# apps/editor/src/renderer/services/dialogs/CLAUDE.md

本目录是应用内文件对话框的家：`SimpleFileDialog` 是 renderer 端基于 QuickInput 的**纯键盘优先**路径浏览器（对标 VSCode `files.simpleDialog.enable`），注册为 `IFileDialogService` 单例、**默认替换全部原生 OS 对话框**。开关 `files.nativeDialog.enable`（默认 false）开启时，`showOpenDialog`/`showSaveDialog` 入口分流到 `_showNative` → `IHostService`（main 端 Electron 原生对话框；open 的 canSelectFiles/canSelectFolders 映射 openFile/openDirectory），所有调用点零改动。处理相关任务前通读本文件。

> ⚠️ 第一原则：这是**值驱动（value-driven）**对话框——**输入框里的路径字符串是唯一事实来源**，列表只是它的投影。改交互前先想清楚动的是「输入值 → 列表」（onValueChange）还是「列表/高亮 → 输入值」（onActiveChange），别让两条方向打架成回环。

## QuickInput 链路（SimpleFileDialog 骑在其上）

```
platform IQuickPick<T> 契约（value/items/activeItems/selectedItems + onDid* 事件）
→ services/quickInput/QuickInputService（createQuickPick 闭包+Emitter；setter 拍平 pushState 推给 React）
→ workbench-ui quickInputViewModel（QuickPickState 纯数据 view model + 回调）
→ workbench-ui QuickInputPanel（纯展示：输入框+虚拟列表；宿主薄 wrapper QuickInputPortal）
```

**关键事实（已核实，改之前先记住）**：
- 程序设 `qp.value` **不会** fire onDidChangeValue（无回环，onActiveChange 里改 value 安全）；设 `qp.activeItems` **会** fire onDidChangeActive（「高亮 → 补全输入值」的驱动机制）。
- FakeQuickPick（host 单测）设 activeItems 不自动 fire onActiveChange，测补全要手动 `qp.fireActive(item)`——单测与生产的唯一行为差。
- `autoFocusFirstItem = false`（本对话框专用）：focus 完全由 activeItems + 键盘/鼠标驱动，panel 据此 gate 掉「hover 改 focus」（否则导航后鼠标静止悬停乱触发补全）。`keepOpenOnAccept = true`：accept 后由本对话框自己决定关不关。

## 核心：SimpleFileDialog 交互逻辑

`services/dialogs/SimpleFileDialog.ts`（注册为 IFileDialogService 单例）。`_show(opts, mode)` 建一个 qp 挂 6 个事件：

| 事件 | 职责 |
|---|---|
| onDidChangeValue → onValueChange | **值 → 列表**：解析输入路径，必要时切目录/切盘符列表，按尾段前缀高亮 |
| onDidChangeActive → onActiveChange | **高亮 → 值**：把高亮项补全进输入框，选中未输入的尾巴 |
| onDidAccept → onAccept | 回车/点击：优先按「选中的具体项」动作（进目录/打开/保存），否则解析输入值 |
| onDidTriggerOk → confirmSelectionOrValue | OK：多选有选中集 → 确认全部；否则回退 acceptValue(qp.value) 单选 |
| onDidTriggerButton | 切 showDotFiles + 重列 |
| onDidChangeSelection | checkbox toggle 分流；carried（跨目录选中）项保留 |

**两个核心私有动作**：
- `updateItems(folder, {resetInput})`：`fileService.list(folder)` 重建列表。`resetInput:true`（导航类）把输入框重置为 `display(folder)+sep`；`resetInput:false`（手动改路径触发）**不动输入框**（避免 clobber 用户正在敲的字——历史 bug A 的根因）。`navToken` 守卫异步 list 竞态；也是盘符列表的入口。
- `acceptValue(value)`：输入值当路径解析——目录则进入或选定，文件则打开，save 模式确认覆盖；结尾带分隔符 = 「这个目录本身」。

### 已落地的对标 VSCode 行为（A~D + ~ + 盘符）

- **[A] 手动改目录列表同步**：onValueChange 用 `splitTrailingSegment(value)` 拆 {dir,name}，dir 对应目录 ≠ 当前且 stat 为目录 → `updateItems(dirUri, {resetInput:false})`。
- **[B] 输入时高亮匹配项**：`applyMatch(name)` 在 currentItems 里找 label 前缀匹配项设 activeItems；删字时（isDeletion）不强制高亮，免得跟退格打架。
- **[C] 上下键 + 路径补全 + 回车定型**：onActiveChange 把高亮项补全成 `display(folder)+sep+label`，valueSelection 选中用户未输入部分。
- **[D] 结尾分隔符回车直接确认目录**：acceptValue 里 endsWithSeparator + 目录 + canSelectFolders → 直接 finish。
- **`~` 展开**：`expandTilde` 在 onValueChange 最前处理（`~`/`~/`/`~\` → home+sep）。
- **浏览上下文 `_ctx()` 按目标解析**（`_show` 开头按 start.folder 结算）：`file:` 用客户端 sep/home；`remote-ssh:` 经 `IRemoteStatusService.getEnvironment(authority)` 取远程 os/homeDir 驱动分隔符与 ~ 展开，未知退化 POSIX `/`（远程 Windows 盘符列表不支持，driveList=false）。**分隔符/home/盘符按浏览目标解析，非客户端平台**。

### 多选（canSelectMany）与过滤（filters）

- **canSelectMany 只在 `mode==='open' && opts.canSelectMany===true` 时点亮**（save 永不多选）。选中集按 item id（=URI string）键的 Map，**跨目录保留**（carried 分支从 Map 取回）。
- **文件行 Enter/点击 = toggle checkbox**（`isSelectableEntry` 门控：`'..'`/文件夹行不可勾选）；文件夹行 accept 保持导航；OK = 确认选中集，空则回退 acceptValue 单选。
- **filters 只在 open 且 allowFiles 时生效**：`collectFilterExtensions` 把 {name, extensions[]}[] 压成小写扩展名并集（含 `*` 则不过滤）。两处守卫：列表渲染（prepareEntries 的 fileExts）+ typed-path 提交（acceptValue/onAccept 拒绝残留高亮里扩展名不在集合内的文件）。目录永远显示。
- **Space toggle 在 panel 侧 gate 于 `!filterExternally`**：文件对话框输入框是路径数据（空格必须可输入），所以文件对话框里 Space 不 toggle。

### Windows 盘符处理（仅本机 win32 file 浏览，ctx.driveList）

helper：`_driveListRoot()`（=URI.file('/') 合成根）、`_isDriveListRoot(uri)`、`_displayWithSep(uri)`（幂等加单分隔符——盘根 fsPath 自带尾斜杠，别手动 +sep 造成 `C:\\`）。

- **输入盘符切盘**：`D:\` → `_uriFromInput` 把裸盘符 `D:` 补斜杠成 `D:/`（裸 `D:` 指盘的工作目录非根，必须补斜杠），经 [A] 分支 stat + updateItems 切到 D 盘根。
- **裸片段 → 盘符列表**：onValueChange 里 `dir === '' && win32` → 切到盘符列表（updateItems(driveListRoot)），用输入字母前缀高亮盘符（输入 f → 高亮 F:）。修了「全选后输入单字母被错误补全成 当前路径\匹配项」和「输入盘符字母不出盘符列表」两个 bug。空输入是子集（只列盘符不高亮）。
- **盘符列表态**：updateItems 在 _isDriveListRoot(folder) 时改为 `fileService.listDrives()`（无 `..`）；setInputToFolder / onActiveChange 的 prefix 在该态为空串；从盘根按 `..` 上行（其父正是 /）回到盘符列表。
- **跨进程 `IFileService.listDrives?()`**（可选方法）：main 端 FileSystemMainService 在 win32 探测 A–Z 盘根，非 win32 返回 []。**可选**是因为大量测试 fake 全量实现 IFileService，必填会全炸；调用处 `(await this._fileService.listDrives?.()) ?? []`。新写 IFileService fake 不需要实现它。

## 纯函数 helper（无副作用，易单测）

`services/dialogs/simpleFileDialogUtil.ts`：`prepareEntries(entries, {allowFiles, showDotFiles, fileExts?})`（目录前文件后各自排序；过滤 dotfile；fileExts 非空按扩展名过滤文件、目录永远保留）、`fileExtension` / `collectFilterExtensions(filters)`、`splitTrailingSegment(value)`（→{dir 含尾分隔符, name}，识别 `/` 和 `\`）、`endsWithSeparator` / `expandTilde` / `isDeletion` / `findCompletion` / `completePath`。

## 注册接入点 & 调用方

- **DI 注册**：SimpleFileDialog.ts 末尾 `registerSingleton(IFileDialogService, SimpleFileDialog, InstantiationType.Delayed)`。
- **接口契约**：`packages/platform/src/dialog/fileDialogService.ts` —— IFileDialogService + IFileDialogOptions（title/defaultUri?/canSelectFiles/canSelectFolders/canSelectMany?/filters?/openLabel?）。改接口记得在 platform/src/index.ts re-export（已 export）。
- **返回值**：showOpenDialog → `Promise<URI[] | undefined>`（多选支持后改数组；save 仍单 URI）。8 个调用点取 `picked?.[0]` 或遍历：actions/{fileOpen（多选循环打开）,fileSave,workspace,window,configLocation,extensions,fileClipboard}Actions.ts、workbench/sessions/PromptInput.tsx；扩展链路 MainThreadWindow.ts（透传 canSelectMany/filters）。
- **UI 下划线裁切修复**：`packages/workbench-ui/src/feedback/quickInput/QuickInput.module.css` 的 `.input`（height:40px; line-height:40px;）——下划线/descender 显示问题改这里。

## 常见任务 → 改哪里

- **改路径输入的解析/补全行为**：SimpleFileDialog.onValueChange（值→列表）+ onActiveChange（高亮→值）。先确认动的哪条方向，避免回环。
- **改回车/点击动作（进目录/打开/保存/确认）**：onAccept + acceptValue。onAccept 优先按「具体选中项」动作（不依赖输入值，免得跟补全竞速）。
- **改盘符相关**：`_uriFromInput`（裸盘符补斜杠）、onValueChange 的 dir==='' 分支、updateItems 的 _isDriveListRoot 分支、FileSystemMainService.listDrives。
- **改「显示/隐藏隐藏文件」「列表排序过滤」**：onDidTriggerButton + prepareEntries。
- **加纯逻辑**：优先抽到 simpleFileDialogUtil.ts 写纯函数 + 单测，别堆进 _show 闭包。
- **改面板通用行为（focus 重置/Enter/hover）**：QuickInputPanel.tsx —— 通用 QuickInput，命令面板等共用；用 autoFocusFirstItem 等 flag 区分本对话框专属行为，别写死。
- **新增对话框选项**：扩 IFileDialogOptions（platform）→ _show 消费 → 调用方传入。

## 易踩坑速记

1. **值 ↔ 列表回环**：程序设 qp.value 不 fire onValueChange（安全），设 qp.activeItems 会 fire onActiveChange（→改 value）。别在 onValueChange 里又设 activeItems 又指望它不反过来动 value；现有代码靠「程序设 value 不回环」成立。
2. **resetInput 用错**：导航（进目录/上行）用 true，手动改路径触发的刷新用 false，否则把用户正敲的字 clobber 回旧目录路径（历史 bug A 根因）。
3. **裸盘符丢斜杠**：`D:`（无斜杠）= D 盘工作目录 ≠ `D:\` 根；_uriFromInput 必须补回斜杠。
4. **盘根 fsPath 自带尾斜杠**：`URI.file('C:/').fsPath === 'C:/'`，普通目录无尾斜杠。拼输入值用 _displayWithSep，别手动 +sep 造成 `C:\\`。
5. **分隔符/home/盘符按浏览目标解析，非客户端平台**：_ctx() 按 start.folder 结算——file: 用客户端事实；remote: 经 getEnvironment(authority) 取远程 os/homeDir，未知退化 POSIX。盘符逻辑 gate 到 ctx.driveList（仅本机 win32 file 浏览），远程浏览禁用。
6. **autoFocusFirstItem=false 必须配合 panel 关 hover**：否则导航后鼠标静止悬停新项 → onMouseMove 乱触发补全（历史 e2e 失败根因）。
7. **host 单测设 activeItems 不自动补全**：FakeQuickPick 不 fire onActiveChange，测补全要 qp.fireActive(item)。
8. **listDrives 是可选方法**：调用必带 `?.()`；新写 IFileService fake 不需要实现它。
9. **测试环境**：host 单测在 renderer-node（无 DOM），测试内 `globalThis.window = { ipc: { platform, home } }` 切平台；panel 单测在 workbench-ui happy-dom。

## 验证

```bash
pnpm --filter @universe-editor/editor exec vitest run --project renderer-node \
  src/renderer/services/dialogs/__tests__/SimpleFileDialog.test.ts   # host 交互单测（A~D+~+盘符，FakeQuickPick+FakeFileService）
pnpm --filter @universe-editor/editor exec vitest run --project renderer-node \
  src/renderer/services/dialogs/__tests__/simpleFileDialogUtil.test.ts   # 纯函数单测
pnpm --filter @universe-editor/workbench-ui test    # panel 单测
pnpm --filter @universe-editor/platform build       # 改 platform 接口必重建
pnpm check                                          # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build         # e2e 前必 build out/
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts --grep "simple file dialog"
```

## 关键参考路径

- `services/dialogs/SimpleFileDialog.ts` —— 交互主逻辑（onValueChange/onActiveChange/onAccept/updateItems/acceptValue + 盘符 helper）
- `services/dialogs/simpleFileDialogUtil.ts` —— 纯函数 helper；`__tests__/SimpleFileDialog.test.ts` —— host 单测
- `packages/platform/src/dialog/fileDialogService.ts` —— 契约；`packages/platform/src/files/fileService.ts` —— IFileService（含可选 listDrives?()）
- `main/services/files/fileSystemMainService.ts` —— main 实现（listDrives 探测 A–Z）
- `packages/platform/src/workbench/quickInputService.ts` —— IQuickPick 接口；`services/quickInput/QuickInputService.ts` —— 实现
- `packages/workbench-ui/src/feedback/quickInput/{quickInputViewModel.ts,QuickInputPanel.tsx,QuickInput.module.css}`
- e2e：`apps/editor/e2e/specs/smoke.simpleFileDialog.spec.ts`
