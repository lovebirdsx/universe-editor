# 跨 worktree session 的「看/用分离」修复方案

## 背景与根因

worktree scope 下,session 列表会混入兄弟 worktree（含主仓库）的 session。当前实现有两个缺陷:

1. **配置读错(表层 bug)**:config options 解析只读「当前打开的 workspace 桶」,而跨 worktree session 的真实配置存在它自己的 cwd 对应的桶里。worktree 桶里这条 entry 的 `configOptions` 是 `undefined`,退化成默认值。
2. **split-brain(深层隐患)**:resume 时 agent 用 `entry.cwd`（源目录）spawn,而 UI 文件树/SCM/搜索看的是当前 workspace。在 task1 窗口"继续"主仓库 session,会让 agent 实际改主仓库 —— UI 与副作用脱钩,用户可能改错仓库。

## 设计原则

**看可以跨界,用必须归位。** 单根 workspace 模型下,session 是「有副作用的执行上下文」,必须满足「所见即所改」。不让 git/文件改动跟着 session 漂移,而是让窗口上下文跟着 session 的 cwd 走。

## 三层方案

### 第 0 层(正确性必做):跨桶只读 config

新增「按指定 cwd 读任意 workspace 桶」的只读能力,仅用于预览展示。

- **`packages/platform/src/storage/storageService.ts`**:`IStorageService` 加方法
  `getForWorkspaceCwd<T>(key: string, cwd: string): Promise<T | undefined>`,并在 platform `index.ts` re-export(已 export 的话无需动)。
- **`apps/editor/src/main/services/storage/storageMainService.ts`**:实现该方法。
  - `const id = workspaceIdFromUri(URI.file(cwd).toString())`（注意:entry.cwd 是 fsPath,必须先 `URI.file().toString()` 再 hash,与 `workspaceIdFromUri` 约定一致）。
  - 命中当前桶(`id === this._workspaceId`)走活实例 `this._workspace.get`,避免读到未 flush 的旧盘内容;否则 `createStorage(workspaceStoragePath(id)).get<T>(key)` 旁路只读。
- 哈希算法收敛在 main 侧(renderer 不复刻,避免 fsPath/URI 踩坑)。
- **不动 PersistedStateBase** —— 它的 reload/flush/swap 围绕「单一当前桶」设计,加旁路读会破坏不变量。三个 ACP service 谁需要谁直接调 storage API。

### 第 1 层(体验):列表来源标记

- **`apps/editor/src/renderer/workbench/agents/SessionListBody.tsx`** `SessionRow`(139-208 行):
  - 计算 `isForeign = entry.cwd !== undefined && currentCwd !== undefined && !arePathsEqual(entry.cwd, currentCwd, platform)`（`arePathsEqual`/`platform` 已 import）。
  - 外来行加 worktree 角标(复用 `sessionRowScope` 样式 + lucide `GitBranch` 图标,tooltip 显示 `entry.branch`/`entry.cwd`)。
- 数据已齐(`entry.cwd` + `entry.branch`),无需改后端。

### 第 2 层(体验):点击外来 session → 只读元数据预览

采用**元数据预览**(不连 agent、零副作用):

- **`SessionListBody.tsx`** `onActivate`(303-314 行)改造:
  - cwd 一致(或 entry.cwd 未定义) → 走现有 `setActive`/`resumeSession`(行为不变)。
  - cwd 不一致 → **不 resume**,打开只读预览(不 spawn agent)。预览展示 entry 已有元数据(title/branch/cwd/耗时/费用)+ 第 0 层读到的正确 config + 「激活会话」入口。
- 预览呈现方式:在 ChatBody 区域渲染一个轻量只读面板(仿 `AcpSessionEditor.tsx` 的 `sessionLoadingHeader` 横条样式),**不复用 PromptInput**(避免改 readOnly 透传链)。面板内容 = 元数据卡 + config 列表 + 激活按钮。
  - 具体落点:在 `AcpSessionEditor.tsx` / `ChatBody.tsx` 增加「foreign preview」分支。若改动过大,退一步:点击外来 session 仅在侧栏弹出元数据预览(不进 editor area),进一步简化。最终落点在实现时按代码实际结构定,原则是最小侵入。

### 第 3 层(正确性必做):激活双模式 + resume 防呆

- **激活双模式**(在预览面板的「激活会话」按钮 + 列表项交互):
  - 普通点击 → `IWindowsService.openWindow(URI.file(entry.cwd))` 新窗口打开该 worktree,目标窗口自然 resume。
  - 修饰键(Ctrl/Cmd,读 React 事件 `e.ctrlKey/e.metaKey`)→ `ILifecycleService.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)` 通过后 `IWorkspaceService.openFolder(URI.file(entry.cwd))` 同窗切换。
  - 抽成共享函数 `activateSessionAcrossWorktree(deps, entry, { newWindow })` 供 UI 复用。
  - SessionListBody 需新增注入 `IWindowsService`、`ILifecycleService`,import `URI`。
- **resume 防呆**(堵 split-brain 洞):
  - **`apps/editor/src/renderer/services/acp/acpSessionService.ts`** `_resumeSessionInner`(555 行起):在用 `entry.cwd` connect 前,校验 `entry.cwd` 与 `workspace.current.folder.fsPath` 一致性。不一致则**拒绝静默 spawn**,抛出可识别错误(让 UI 引导走激活流程)。
  - 这道校验是兜底:即便 `AcpSessionEditor` 的 `AcpSessionResumer`(自动 resume)或其他路径触发,也不会发生 UI/副作用脱钩。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/platform/src/storage/storageService.ts` | `IStorageService` 加 `getForWorkspaceCwd` |
| `apps/editor/src/main/services/storage/storageMainService.ts` | 实现 `getForWorkspaceCwd`(旁路只读桶) |
| `apps/editor/src/renderer/services/acp/acpSessionHistory.ts`（或新 helper） | 提供「按 cwd 读该 session 真实 config」的读取方法 |
| `apps/editor/src/renderer/workbench/agents/SessionListBody.tsx` | isForeign 标记 + onActivate 分支 + 注入 windows/lifecycle |
| `apps/editor/src/renderer/workbench/agents/AcpSessionEditor.tsx` / `ChatBody.tsx` | 外来 session 只读元数据预览面板 + 激活按钮 |
| `apps/editor/src/renderer/services/acp/acpSessionService.ts` | `_resumeSessionInner` cwd 一致性防呆 |
| `apps/editor/src/renderer/services/acp/`（共享函数） | `activateSessionAcrossWorktree` |
| `apps/editor/src/renderer/workbench/agents/agents.module.css` | 角标/预览面板样式 |

## 验证

- `pnpm check`(lint + typecheck + test),仅截错误。
- 新增单测:复现 split-brain —— 构造 entry.cwd ≠ current,断言 `_resumeSessionInner` 拒绝 spawn;断言 `getForWorkspaceCwd` 能读到目标桶的 config。
- `pnpm e2e` 冒烟(涉及编辑器交互),仅截错误。

## 实现顺序

1. 第 0 层(storage 跨桶读)+ 第 3 层防呆 —— 正确性核心,先做。
2. 第 1 层来源标记 —— 小改动。
3. 第 2 层只读预览 + 第 3 层激活双模式 —— 体验完善。

## 已确认的决策

- 激活方式:**双模式**(普通=新窗口,修饰键=同窗切换)。
- 只读预览:**元数据预览**(不连 agent,零副作用)。
