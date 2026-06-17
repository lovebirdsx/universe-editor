---
name: drag-and-drop-context
description: 处理拖放（drag and drop / DnD）相关功能时召回，提供本仓库（Electron + React 的 VSCode 范式编辑器）整套资源拖放的上下文地图——源端（写 text/uri-list + 私有镜像 MIME + 可选 React payload）与目标端（readDroppedResources 统一读取，folder→新窗口 / file→编辑器 / @mention / 终端粘贴）的分工、跨 subtree 的 DragSessionContext payload 为何读不到、Windows 把 text/uri-list 粘连成单条的原生坑与私有 MIME 解法、CR-only 分隔、Electron 33 用 webUtils.getPathForFile 取 OS 文件路径、URI 编码差异如何用来判断拖拽来源、resourceDragProps 为何是普通函数而非 Hook、以及 Playwright 无法跑真实原生 DnD 的取证手法。当任务涉及「让某视图的文件项可拖拽」「拖到 X 落点做 Y」「拖多个文件只生效一个 / 出现乱码拼接 / @mention 拼接」「拖文件夹到标签栏开新窗口」「text/uri-list / DataTransfer / getPathForFile / DragSessionContext / useDragHandle / useDropTarget」时，先读它建立全局认知。
disable-model-invocation: true
---

# 资源拖放（DnD）上下文地图

universe-editor 的资源拖放统一成「**源端发布资源 URI → 目标端读取并决定干什么**」两层。核心抽象集中在 `packages/workbench-ui/src/dnd/`（纯 React，无 Electron），应用侧的读取/落点逻辑在 `apps/editor/src/renderer/services/dnd/` 与各视图组件。

> ⚠️ 第一原则：动手前先定位你改的是**源端**（哪个视图变得可拖）还是**目标端**（哪个落点收到拖拽后做什么）。两端通过 `text/uri-list` 解耦，绝大多数新需求只需动一端。

## 数据流一图

```
源端（dragstart 写 DataTransfer）
  ├─ resourceDragProps(getUris)        普通函数：只写 uri-list，无 in-tree payload —— 用于 renderRow 渲染循环
  └─ useDragHandle(payload, {uriList})  Hook：写 uri-list + 设 DragSessionContext payload —— 用于需要"树内移动"的源（Explorer 文件夹）
        │  二者都经 writeUriList(dt, uris) 写三种 MIME（见下）
        ▼
   DataTransfer  ──（真实拖拽时经 OS 原生剪贴板往返，可能损坏 text/uri-list！见坑①）──▶
        ▼
目标端（drop 读 DataTransfer）
  readDroppedResources(e): URI[]   apps/editor/src/renderer/services/dnd/resourceDropTransfer.ts
    1. dt.files 非空（OS 外部拖入）→ window.ipc.getPathForFile(file) → URI.file()   见坑③
    2. 否则 readUriList(dt) → URI.parse()                                          见坑①
    （按 uri.toString() 去重）
        ▼ 各落点拿到 URI[] 后自行决定：
  ├─ EditorGroupView（标签栏 + 编辑区）→ openDroppedResource：folder→新窗口 / file→openEditor
  ├─ PromptInput（agent 输入框）       → toMentionName → 插入 @相对路径 mention
  ├─ TerminalInstance                  → formatPathForTerminal → 粘贴路径
  └─ ExplorerView（文件夹）            → importDroppedFiles（导入/复制）
```

## 源端：让某视图的文件项可拖拽

**两种写法，按"是否需要树内移动 payload"二选一：**

- **`resourceDragProps(getUris: () => readonly string[]): {draggable, onDragStart}`**（`dnd/resourceDrag.ts`）
  **普通函数，不是 Hook** —— 所以能在 `SearchResultsTree` 的 `renderRow` 等渲染循环里直接展开（那里不能调 Hook）。只写 `text/uri-list`（+ 私有镜像 + text/plain），不设 React payload。SCM / Search / Session Changes 用它。
- **`useDragHandle<T>(payload, { uriList })`**（`dnd/useDragHandle.ts`）
  Hook，除写 uri-list 外还把 `payload` 存进 `DragSessionContext`，供**同一 React 子树**的放置目标做"树内移动"（Explorer 文件夹拖到另一个文件夹 = rename）。Explorer 用它，payload 是 `{resource, isDirectory}`。

**多选规则统一走** `selectionDragUris(self, selection?)`（`dnd/resourceDrag.ts`）：选区含被拖项且 >1 项 → 拖整个选区，否则只拖被拖项。各源都这么调：
```ts
{...resourceDragProps(() => selectionDragUris(uri.toString(), getSelectedUris()))}
```
取选区 URI 的 `getSelectedUris` 用 `useCallback([model])` 保持引用稳定，别破坏行组件的 `memo`。

已接入的源（参考实现）：`ExplorerTreeNode.tsx`、`scm/ScmView.tsx`(ScmFileRow)、`search/SearchResultsTree.tsx`(file/match 行，folder 行不可拖)、`agents/SessionChangesView.tsx`(ChangeRow，单项)。

## 线格式：writeUriList / readUriList / parseUriList（`dnd/uriList.ts`）

`writeUriList(dt, uris)` 写**三种 MIME**：
- `text/uri-list`（CRLF 连接，RFC 2483 标准，给外部 app / OS）
- `application/vnd.universe-editor.uri-list`（**私有镜像**，LF 连接，**应用内可靠传输**，见坑①）
- `text/plain`（LF 连接，给终端/纯文本目标）

`readUriList(dt)`：**优先读私有镜像**，没有再回退标准 `text/uri-list`。**目标端一律用它，别直接 `dt.getData('text/uri-list')`**。
`parseUriList(text)`：按 `/[\r\n]+/` 切分（CR / LF / CRLF 都吃，见坑②），跳过空行与 `#` 注释。
`dragContainsResources(dt)`：dragover 阶段浏览器禁止读数据内容，只能查 `dt.types` 是否含 `Files` 或 `text/uri-list` —— 用它做 dragover 的 `preventDefault` 门控。

## 目标端：读取与落点

`readDroppedResources(e)` 是所有落点的统一入口（OS 文件 + 应用内 uri-list，去重）。它之后各落点各自处理：
- **toMentionName(uri, workspaceRoot?)**：工作区内 → 正斜杠相对路径；区外 / 无根 → `uri.fsPath`。**绝不返回 `file://`**。PromptInput 的 `@mention` 用它。
- **openDroppedResource(resource, {fileService, windowsService, editorResolverService})**（`dnd/openDroppedResource.ts`）：`stat().isDirectory` → `windowsService.openWindow`（**新窗口，多文件夹开多窗**）；否则 `editorResolverService.openEditor`；无法 stat 的 URI 当文件。EditorGroupView 标签栏与编辑区共用。
- **formatPathForTerminal(fsPath)**：含空格则加引号。

## DragSessionContext payload 为何常读不到（关键认知）

`DragSessionProvider` 用 `useRef` 同步持有 payload，但**每个 React 子树各挂一个 Provider**（ExplorerView 一个、EditorArea 一个…）。所以：
- **同子树内**拖放（Explorer 内部）→ 放置目标能读到 payload（做 rename / move）。
- **跨子树**拖放（Explorer → 编辑器 / → agent 输入框）→ 目标的 `dragSession.payload` 是 `undefined`，**只能走 dataTransfer 的 uri-list**。

这就是为什么新视图源**只需写 uri-list、不该写 React payload**（写了反而会让 Explorer 文件夹误判为"内部移动"）。EditorGroupView 的 drop 里 `if (!payload) openDroppedResources(e)` 正是借此区分"编辑器标签移动"（有 `{editor,sourceGroupId}` payload）与"外部资源投放"。

## 踩过的坑（务必先读）

**① Windows 把 `text/uri-list` 粘连成单条。** 真实拖拽时 Chromium 把标准 `text/uri-list` 映射成单 URL 的原生剪贴板格式（`CFSTR_INETURL`），多条目在 drop 端被**拼成一行、无分隔符**（`file:///a…file:///b…`）。同 scheme 的 file URI **无法按词法拆回**（`test2.mdfile://` 里 `md`/`mdfile`/`file` 都是合法 scheme 字符，分界不可判定）。解法 = **私有 MIME 镜像**（对 OS 不透明，原样往返），`readUriList` 优先读它。**不要再尝试"按 scheme:// 拆分粘连串"**，那条路证明走不通。

**② CR-only 分隔的 uri-list。** 某些外部/OS 来源用裸 `\r` 分隔，旧的 `/\r?\n/` 不切分会把多条折叠成一条 → "拖多个只开一个 / @mention 乱码拼接"。`parseUriList` 已改 `/[\r\n]+/`。

**③ Electron 33 取 OS 文件路径。** `File.path` 已移除，唯一方式是 `webUtils.getPathForFile`，经 preload 暴露为 `window.ipc.getPathForFile(file)`（`apps/editor/src/preload/index.ts`）。对所有文件（含中文名）都有效。

**④ 用 URI 编码差异判断拖拽来源。** `URI.toString()` 会把中文 `%`-编码；OS/外部来源的 uri-list 是**未编码**的。所以排查时：payload 里中文是 `%E8...` → 来自我们的 `writeUriList`（应用内拖拽）；未编码 → OS/外部来源。这是定位"到底哪条路径出问题"的利器。

**⑤ dragover 读不到数据。** 浏览器安全限制，dragover/dragenter 阶段 `getData` 返回空，只能用 `dragContainsResources(dt)` 看类型列表。drop 阶段才能读内容。

## 测试与取证

- **单测**（快、确定）：`packages/workbench-ui/src/__tests__/uriList.test.ts`（readUriList 优先私有镜像 / 粘连恢复 / CR / 回退）、`apps/editor/src/renderer/services/dnd/__tests__/`（`resourceDropTransfer` / `openDroppedResource` / `resourceDrag`）。新逻辑优先抽成纯函数放 `services/dnd/` 单测。
- **e2e**（`apps/editor/e2e/specs/smoke.multiFile*` / `smoke.folderDragNewWindow.spec.ts`）：
  - **Playwright 跑不了真实原生 HTML5 DnD**，只能合成 dispatch（用一个共享 `DataTransfer` 触发 dragstart/dragover/drop）。合成 DataTransfer **会完整保留分隔符**，所以**复现不了坑①的原生粘连** —— 要测粘连恢复，手动 `setData('text/uri-list', 拼接串)` + `setData(私有MIME, 正常串)` 模拟 OS 损坏。
  - 测 **OS 文件拖拽**：用 `<input type=file>` + `setInputFiles` 拿到**真实 OS 文件句柄**塞进 `DataTransfer`，`getPathForFile` 才会返回真路径（合成 `new File()` 无句柄）。
  - 测 **folder→新窗口**：会真开 BrowserWindow，**必须用冷启动 fixture `electronApp.ts`**（不是 `sharedApp.ts`），断言 `electronApp.windows().length` / 新窗口 `getCurrentWorkspacePath`。
  - 临时 `--grep` 经 `pnpm e2e --` 转发不进去（会跑全量 + @serial 段报 "No tests found"），看自己用例的 `ok <n> …` 行确认即可。

## 改动落点速查

| 你想做 | 动哪 |
|---|---|
| 让某视图文件项可拖（无树内移动） | 该行组件展开 `resourceDragProps(() => selectionDragUris(...))` + 一个稳定的 `getSelectedUris` |
| 让某视图支持树内移动（rename/move） | `useDragHandle(payload,{uriList})` + 同子树 `useDropTarget` 读 payload |
| 新增一个落点行为 | 落点组件里 `readDroppedResources(e)` 后自定义处理；通用逻辑抽到 `services/dnd/` 纯函数 |
| 改线格式 / 解析 | `packages/workbench-ui/src/dnd/uriList.ts`（改后 `pnpm --filter @universe-editor/workbench-ui build`，apps 吃 src alias，dev 直接生效） |
| 文件夹拖到编辑器的行为 | `services/dnd/openDroppedResource.ts` |

## 其它
- 后续用本 skill，发现新经验，需同步更新
