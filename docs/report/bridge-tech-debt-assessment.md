# universe-editor 的 monaco command/keybinding 桥接方案：技术债评估 + 优化方案

> 撰写日期：2026-06-12
> 调研方式：3 个 Explore agent 扫描 + 亲自核实 6 个核心文件
> 核实文件：`MonacoLoader.ts`、`FileEditor.tsx`、`monacoActionsBridge.ts`、`useGlobalKeybindingHandler.ts`、`monacoKeybindingDecoder.ts`、`keybindingRegistry.ts`、`action.ts`、`CommandsQuickAccessProvider.ts`

## 背景

前序评估已确立：当前「桥接 + 服务覆盖 + 焦点门控双路由」是 standalone monaco 下的**正确架构选择**，不应为消灭"两套系统"而重写——两个 DI 容器（自研 `InstantiationService` 与 monaco `StandaloneServices`）的 `ServicesAccessor` 不互通是物理约束，`editor.trigger()` 正是为绕开此约束而生。

本报告是在**保持现有架构**的前提下，对桥接方案做一次整体体检，识别不完备与设计债，并给出分级优化方案。

## 一、评估总览

桥接方案整体**健康**。约 400 行代码把"异源协调"的复杂度良好隔离，没有渗进 platform 内核，**没有正确性级别的严重缺陷**。

真实债务集中在两条主轴：

- **镜像保真度**：自研 `CommandsRegistry` 镜像 monaco action 时丢了 enablement / 参数，导致命令面板体验降级（非正确性问题，monaco 内部 precondition 兜底）。
- **分发健壮性**：`useGlobalKeybindingHandler` 的 IME 防护缺位、`defaultPrevented` 二元判决偏脆，导致边缘输入场景的潜在误触。

## 二、被否决的"高危"声明（核实后不成立）

调研初期的自动化扫描给出过三条"高危"声明，经亲读代码全部证伪，记录在此以免误导后续：

| 声明 | 判定 | 真相 |
|---|---|---|
| 桥接完成前存在 50–2000ms"按键空洞" | ❌ 错 | monaco 默认编辑器键**根本不进自研 `KeybindingsRegistry`**，自始至终由 monaco 自身 context-aware dispatch 处理。桥接只影响"命令面板/快捷键编辑器的可见性"和"被用户重绑命令的原始键拦截"。窗口期内默认键照常工作。 |
| 丢失 precondition → 只读文件能执行写命令 | ❌ 错 | `makeHandler` 走 `editor.trigger()` → monaco 内部 `EditorAction` 执行前会**再校验自身 precondition**。正确性不受影响，真实后果仅为 UX。 |
| 多窗口下模块级全局变量污染 | ❌ 错 | Electron 每个 `BrowserWindow` 是独立 renderer 进程 / 独立 JS 上下文，模块实例不共享，不存在跨窗口污染。 |

## 三、技术债清单（按亲核后的真实严重度）

### 中等

- **D1 镜像丢失 enablement → 命令面板不变灰 + 无反馈**
  `monacoActionsBridge.ts` 的 `registerCommand` 不带 precondition；命令面板（`CommandsQuickAccessProvider`）**直接枚举 `CommandsRegistry.getCommands()`，不读 `MenuRegistry`、不做 when 过滤**（已核实）。后果：所有桥接的 `editor.action.*` 在命令面板里永远可点（即使没有打开编辑器），点了 `makeHandler` 静默 return，无任何反馈。正确性安全，纯 UX 债。

- **D2 IME 组合态未参与路由决策**
  `useGlobalKeybindingHandler.ts` 采集了 `isComposing`（用于诊断）但 `runResolution` 全程不读。中文/日文 IME 组合期间（`keyCode===229`）理论可误触全局快捷键。

- **D3 bubble 路由依赖 `e.defaultPrevented` 二元判决**
  `bubbleHandler` 仅当 monaco 消费键时一定 `preventDefault()` 才成立。多数经 `StandaloneKeybindingService` 的 action 满足，但存在不经此路径消费键的情形 → 双路由风险。属结构性债，改动面大。

### 低（顺手清理 / 潜在）

- **D4 桥接命令参数固定 `{}`**：带参 monaco 命令无法经命令面板/用户键绑定正确触发。
- **D5 bridge 失败仅 log、不设终态**：`.catch` 不 fire `onDidBridgeActions` → 消费者 `MonacoKeybindingSyncContribution.reload()` 与 `MonacoDefaultKeybindingOverrideContribution._sync()` 永久挂起（已核实两个消费者）。极低概率，但后果是确定的挂起。
- **D6 `CORE_COMMANDS` 硬编码 keycode 魔数**：`CTRL | 56` 等与 `monacoKeybindingDecoder` 的 `KEYCODE_TO_TOKEN` 表脱钩的维护债。
- **D7 key 规范化逻辑跨文件重复**：`FileEditor.tsx` 的 `normalizeKey` 与 `useGlobalKeybindingHandler.ts` 的 `buildKeyString` 各写一份。**但两者服务于不同键空间**——前者保留 `arrowleft` 形式以匹配 decoder 输出，后者把 `arrowleft` 映射成 `left` 以匹配自研 registry 的 normalize。盲目合并会引 bug，故不收口。
- **D8 `resolveKeystroke` 纯 LIFO、无 weight**：`keybindingRegistry.ts` newest-first 遍历，缺 VSCode 式 `KeybindingWeight`（EditorCore/Contrib/Workbench/User 分层）。同键多绑定优先级只靠注册顺序 + when 过滤。当前同键冲突少，属潜在债。
- **D9 一次性快照漏动态注册 action**：`bridgeAllMonacoActions` 仅在 monaco 加载时枚举一次。当前 monaco editor action 全为编译期静态注册，运行时无新增，**实际无影响**，仅记录。

## 四、本次落地的优化（已实施）

| 项 | 债 | 改动 | 文件 |
|---|---|---|---|
| P0-1 | D2 | `runResolution` 入口加 `if (e.isComposing \|\| e.keyCode === 229) return`，debug 补 `formatGuardStop`，对齐 VSCode `_dispatch` 的 IME 防护 | `useGlobalKeybindingHandler.ts` |
| P0-2 | D1 | 命令面板无法靠 precondition 变灰（核实证伪），改为 `makeHandler` 无活动文本编辑器时 `INotificationService.status('该命令需要一个活动的文本编辑器')`，消除静默 | `monacoActionsBridge.ts` |
| P1-1 | D6 | `monacoKeybindingDecoder` 导出 `MASK_CTRLCMD` + 派生反查表 `TOKEN_TO_KEYCODE`；`CORE_COMMANDS` 用 `ctrl('z')` 等替代 `CTRL \| 56` 魔数 | `monacoKeybindingDecoder.ts`、`monacoActionsBridge.ts` |
| P1-3 | D5 | bridge `.catch` 里同样翻 `_actionsBridged` + fire 事件，消费者对已注册命令兜底执行，不再永久挂起 | `MonacoLoader.ts` |
| P1-4 | D4 | `makeHandler(commandId)` 改签名 `(accessor, ...args)`，透传 `editor.trigger('', commandId, args[0] ?? {})` | `monacoActionsBridge.ts` |

验证：`pnpm check`（lint + typecheck + test）32/32 通过。

## 五、有意不做（记录权衡）

- **P1-2（D7）收口 normalize**：两处 normalize 服务于不同键空间，合并风险 > 收益，保持各自实现。
- **P2-1（D3）双路由重构**：把 capture/bubble + `defaultPrevented` 改为"始终 capture，在 `runResolution` 内按 `editorFocus` 决策放行"。能去掉对 `defaultPrevented` 的依赖，但要重写焦点门控核心、重测全部和弦/ESC/Find/IntelliSense 交互，回归风险高。当前方案实测工作良好，不建议为此重写。
- **P2-2（D8）引入 `KeybindingWeight`**：仅在未来出现实际同键冲突时再做。
- **命令面板按 contextkey 过滤/置灰（D1 的彻底解法）**：需让 `CommandsQuickAccessProvider` 改读 `MenuRegistry(MenuId.CommandPalette)` + `contextMatchesRules`，并给桥接命令补 MenuRegistry 项。这是影响全局命令面板的架构改动，超出"桥接方案体检"范围，本次只做 fallback 反馈。

## 六、关键文件索引

| 关注点 | 文件 | 关键符号 |
|---|---|---|
| 命令镜像 | `apps/editor/src/renderer/workbench/editor/monaco/monacoActionsBridge.ts` | `bridgeAllMonacoActions` / `makeHandler` / `CORE_COMMANDS` / `_defaults` |
| keybinding 编码解码 | `apps/editor/src/renderer/workbench/editor/monaco/monacoKeybindingDecoder.ts` | `decodeMonacoKeybinding` / `KEYCODE_TO_TOKEN` / `TOKEN_TO_KEYCODE` / `MASK_CTRLCMD` |
| 全局按键分发 | `apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts` | `runResolution` / `captureHandler` / `bubbleHandler` |
| monaco 加载 + bridge 触发 | `apps/editor/src/renderer/workbench/editor/monaco/MonacoLoader.ts` | `loadMonaco` / `onDidBridgeActions` / `actionsBridged` |
| 编辑器焦点 + capture bridge | `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` | `normalizeKey` / `bridgeHandler` / focus context key |
| bridge 消费者 | `apps/editor/src/renderer/contributions/MonacoKeybindingSyncContribution.ts`、`MonacoDefaultKeybindingOverrideContribution.ts` | `reload` / `_sync` |
| 命令面板枚举 | `apps/editor/src/renderer/services/quickInput/providers/CommandsQuickAccessProvider.ts` | 直接枚举 `CommandsRegistry.getCommands()` |
| keybinding 解析 | `packages/platform/src/command/keybindingRegistry.ts` | `resolveKeystroke`（newest-first，无 weight） |
| Action2 → 三 registry | `packages/platform/src/command/action.ts` | `registerAction2`（precondition 只进 Menu/Keybinding，不进 Command） |
