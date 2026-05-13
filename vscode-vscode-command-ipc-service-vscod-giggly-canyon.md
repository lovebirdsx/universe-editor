# 游戏内容编辑器架构方案（VSCode 范式参考）

## Context

你要做一个面向游戏内容（关卡 / 任务 / 玩法 / 剧情 / 配置表）的内部编辑器，希望复用 VSCode 在跨平台、快速启动、Command、依赖注入、插件、IPC、配置、日志、调试等方面的成熟设计。但 fork 整个 VSCode 仓库改造代价过高 —— VSCode 经过十多年迭代，其 workbench 层已与"代码编辑"这一具体业务紧耦合，强行剥离比从头搭建还慢。

**约束**：3-5 人团队、3-6 个月做底座、独立桌面应用、TypeScript / Web 栈。

**目标**：用 3-6 个月搭出一个 **VSCode 同构的精简内核**，把"游戏编辑器"作为这个内核之上的"业务 contribution"实现。内核可独立测试、可复用到你后续其他工具上；业务模块（关卡 / 任务 / 配置表）通过 contribution 注册接入，互不耦合。

---

## 总体思路：路线 B —— 自建外壳 + 借鉴 VSCode 设计 + 摘用 VSCode 库

**不要做的**：fork [src/vs/workbench/](src/vs/workbench/)、复用整个 ExtensionHost 模型、用 [src/vs/platform/](src/vs/platform/) 现成代码而不读懂。

**要做的**：
1. 用 Electron 做外壳（**不用 Tauri** —— 理由见下）。
2. 自己实现一套 **精简版** VSCode 内核（约 8 个核心模块，下面详细列），代码量预估 5000-8000 行 TS。
3. 摘用 VSCode 已经做成独立 npm 包的部分：[`monaco-editor`](https://www.npmjs.com/package/monaco-editor)（脚本/JSON/Lua 编辑）、[`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc)（IPC 协议）、[`vscode-languageserver-protocol`](https://www.npmjs.com/package/vscode-languageserver-protocol)（如未来要做 DSL）、[`@vscode/debugadapter`](https://www.npmjs.com/package/@vscode/debugadapter)（如要做 In-Game 调试器）。
4. 业务层（关卡 / 任务 / 配置表编辑器）一律走 contribution 模型注册，UI 用 React。

### 为什么选 Electron 而不是 Tauri

| 维度 | Electron | Tauri |
|---|---|---|
| VSCode 生态对接 | 几乎零摩擦（VSCode 自己就是 Electron） | 需要解决 Node API ↔ Rust 桥接 |
| Monaco / Node-IPC | 直接可用 | 需要重写或绕路 |
| 启动速度 / 包体积 | 慢 / 大（150MB+） | 快 / 小（10MB） |
| 团队语言负担 | 全 TS | 引入 Rust |
| 自动更新 / 原生菜单 | 成熟 | 较新 |

3-5 人团队、3-6 个月底座、想最大化复用 VSCode 库 —— Electron 是务实选择。等业务稳定后再考虑迁移 Tauri 不迟。

---

## 内核模块设计（8 个，按依赖顺序）

每个模块给出：**借鉴的 VSCode 文件**、**精简策略**、**预估代码量**。

### 1. DI / Service 容器（200-400 行）

**借鉴**：
- [src/vs/platform/instantiation/common/instantiation.ts](src/vs/platform/instantiation/common/instantiation.ts) — `createDecorator`、`ServiceIdentifier`
- [src/vs/platform/instantiation/common/instantiationService.ts](src/vs/platform/instantiation/common/instantiationService.ts) — `InstantiationService._createInstance`
- [src/vs/platform/instantiation/common/serviceCollection.ts](src/vs/platform/instantiation/common/serviceCollection.ts) — `ServiceCollection`
- [src/vs/platform/instantiation/common/descriptors.ts](src/vs/platform/instantiation/common/descriptors.ts) — `SyncDescriptor` 延迟实例化

**精简策略**：
- 保留：`createDecorator` + 参数装饰器 + 元数据反射 + 构造函数注入 + `SyncDescriptor` 惰性实例化 + `createChild` 作用域。
- 砍掉：分布式调用、`invokeFunction` 的 `accessor` API 可保留但简化。
- 注意：TS 装饰器在 ECMA 与 experimental 两套语法下行为不同，VSCode 用的是 experimental + `emitDecoratorMetadata`。直接照搬即可。

### 2. Lifecycle / Phase（150-250 行）

**借鉴**：
- [src/vs/workbench/services/lifecycle/common/lifecycleService.ts](src/vs/workbench/services/lifecycle/common/lifecycleService.ts) — `AbstractLifecycleService`、`Barrier`
- [src/vs/platform/lifecycle/common/lifecycle.ts](src/vs/platform/lifecycle/common/lifecycle.ts) — `handleVetos`

**精简策略**：
- 保留 `LifecyclePhase`：Starting → Ready → Restored → Eventually 四档。
- 保留 `onBeforeShutdown`（veto）+ `onWillShutdown`（join）两个事件。
- 砍掉：hot exit 复杂的崩溃恢复，先用简单的"上次窗口位置/已打开文档"持久化即可。

### 3. Command + Keybinding + Menu 三件套（500-700 行）

**借鉴**：
- [src/vs/platform/commands/common/commands.ts](src/vs/platform/commands/common/commands.ts) — `CommandsRegistry`，LinkedList 栈式 handler
- [src/vs/platform/actions/common/actions.ts](src/vs/platform/actions/common/actions.ts) — `MenuRegistry`、`MenuId`
- [src/vs/platform/keybinding/common/keybindingsRegistry.ts](src/vs/platform/keybinding/common/keybindingsRegistry.ts)
- [src/vs/platform/keybinding/common/keybindingResolver.ts](src/vs/platform/keybinding/common/keybindingResolver.ts) — 和弦快捷键解析

**精简策略**：
- 三个独立 Registry，**仅通过 commandId 字符串关联**（这是 VSCode 最值钱的设计之一，强烈照搬）。
- Command handler 签名统一：`(accessor: ServicesAccessor, ...args) => R`。
- ContextKey 系统先做简化版（key-value + 简单 when 表达式如 `editorFocused && resourceLangId == 'json'`）—— 完整版表达式解析有点重，必要时再扩。
- 命令面板（Quick Pick）作为内核基础设施先做出来，所有 command 都可被搜索。

### 4. Contribution / 注册中心（300-500 行）

**借鉴**：
- [src/vs/workbench/common/contributions.ts](src/vs/workbench/common/contributions.ts) — `WorkbenchContributionsRegistry`、`registerWorkbenchContribution2`、`WorkbenchPhase`

**精简策略**：
- 内部 contribution（你自己写的关卡编辑器、任务编辑器）通过 `registerContribution(id, Ctor, phase)` 注册，由 DI 实例化。
- 暂不做外部插件加载（不做 ExtensionHost）—— 这是 3-6 个月内最容易超时的部分，先把所有功能当作内部 contribution，留好接口，**未来再补外部插件**。
- 用 contribution 串起 ViewContainer、Editor、Command、Menu、Configuration —— 像 VSCode `*.contribution.ts` 那样每个业务模块一个集中注册入口。

### 5. IPC 框架（400-600 行）

**借鉴**：
- [src/vs/base/parts/ipc/common/ipc.ts](src/vs/base/parts/ipc/common/ipc.ts) — `IChannel`、`ChannelClient/Server`、`IMessagePassingProtocol` 抽象
- 直接复用 npm 包 [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc) 作为底层协议

**精简策略**：
- 三类 IPC 通道：
  1. **主进程 ↔ 渲染进程**：直接用 Electron `ipcMain/ipcRenderer`，封装成 `IChannel`。
  2. **编辑器 ↔ 游戏运行时**：用 TCP/WebSocket + `vscode-jsonrpc`，定义 `IGameRuntimeChannel`（这就是你的"DAP 等价物"）。
  3. **进程内事件总线**：用 EventEmitter 加 `IDisposable` 收尾即可。
- 抽象出 `IMessagePassingProtocol`（只有 `send(buffer)` 和 `onMessage` 两个 API），让上层 `ChannelServer/Client` 与传输层完全解耦。

### 6. Configuration（300-500 行）

**借鉴**：
- [src/vs/platform/configuration/common/configurationRegistry.ts](src/vs/platform/configuration/common/configurationRegistry.ts) — schema 注册
- [src/vs/platform/configuration/common/configurationModels.ts](src/vs/platform/configuration/common/configurationModels.ts) — 分层合并

**精简策略**：
- 分层：Default（contribution 注册时声明）→ User（用户全局）→ Project（项目级 `editor.config.json`）→ Memory（运行时覆盖）。先不要 workspaceFolder 多根。
- schema 用 JSON Schema，让任何 contribution 都能在 register 时声明配置项 + 默认值 + 类型 + 描述。
- 变更事件：`onDidChangeConfiguration(e => e.affectsConfiguration('level.gridSize'))`。
- 配套做一个内置 Settings UI（VSCode 的 settings.json + GUI 同步双形态），用 schema 自动生成 GUI。

### 7. Log（200-300 行）

**借鉴**：
- [src/vs/platform/log/common/log.ts](src/vs/platform/log/common/log.ts) — `AbstractLogger`、`MultiplexLogger`、`LogLevel`

**精简策略**：
- 三层：`AbstractLogger`（level 管理）→ `AbstractMessageLogger`（格式化）→ 具体实现。
- 三个具体实现：`ConsoleLogger`（开发用）、`FileLogger`（rotating，用 npm `winston` 或自己写）、`OutputChannelLogger`（编辑器内 Output 面板，给业务模块用）。
- `MultiplexLogger` 把三者串起来，按 level 分发。
- 性能：**日志 API 必须先检查 level 再格式化**，VSCode 这点很关键。

### 8. Debug Adapter / In-Game 调试（可选，500-1000 行）

如果你将来要做"编辑器里下断点、查看游戏状态、热更新数据"这种 In-Game 调试体验，**直接照搬 DAP**。

**借鉴**：
- [src/vs/workbench/contrib/debug/common/abstractDebugAdapter.ts](src/vs/workbench/contrib/debug/common/abstractDebugAdapter.ts) — seq + pending request Map
- [src/vs/workbench/contrib/debug/browser/rawDebugSession.ts](src/vs/workbench/contrib/debug/browser/rawDebugSession.ts) — DAP 请求/响应/事件三层

**精简策略**：
- 游戏运行时实现一个 DAP server（用 `@vscode/debugadapter` 包），编辑器作为 DAP client。
- 标准 DAP 已经定义了 setBreakpoints / stackTrace / variables / evaluate —— 把你的"关卡当前状态 / NPC 对话当前节点 / 配置表当前值"映射到这套抽象上。
- 好处：免费支持热更新、断点、变量观察、REPL，且未来如果想用 VSCode 自己当游戏调试器都不需要改协议。

---

## 游戏编辑器特有部分（VSCode 没有，要自建）

VSCode 是文本编辑器，下面这些它没有原生支持，需要你自己设计：

### A. 数据模型层
- 关卡 / 任务 / 剧情 / 配置表都是 **结构化数据**，不是文本。
- 推荐用 [Immer](https://immerjs.github.io/immer/) + 命令模式实现 Undo/Redo；每个数据类型一个 Schema（zod 或 JSON Schema），UI 自动生成。
- 持久化用 JSON / YAML 文件 + git 友好的格式化（保证 diff 可读）。

### B. 通用表单 / 表格 / 树 / 节点图组件
- 表格：[AG Grid](https://www.ag-grid.com/) 或 [TanStack Table](https://tanstack.com/table)。
- 节点图（玩法/剧情流程）：[React Flow](https://reactflow.dev/)。
- 表单：根据 schema 自动生成（[react-jsonschema-form](https://github.com/rjsf-team/react-jsonschema-form) 起步即可）。
- 这些放在内核之上的 `ui-kit` 包里，所有业务 contribution 共享。

### C. 资产 / 引用追踪服务
- 类似 LSP 的 "go to definition" 但作用于游戏数据：例如任务引用 NPC ID、关卡引用 Prefab —— 需要一个 `IIndexService` 在后台扫描所有数据文件，建立反向引用，支持"查找用法 / 跳转定义 / 重命名"。
- 这是游戏编辑器和 IDE 用户体验的最大差距，**早做早受益**。

### D. 与游戏运行时的同步
- 内核里那个 `IGameRuntimeChannel`（IPC 模块的子项）承载：
  - 推送数据更新（编辑器 → 游戏，实现热重载）
  - 拉取运行时状态（游戏 → 编辑器，实现 In-Game Preview）
  - 调试事件（用 DAP，见模块 8）

---

## 实施路线图（3-6 个月，3-5 人）

| 阶段 | 周期 | 人力 | 产出 |
|---|---|---|---|
| **M0 选型 + 脚手架** | 2 周 | 1-2 | Electron + TS + React + Vite + Vitest 工程脚手架；CI/CD；启动一个白屏窗口 |
| **M1 内核底座（关键路径）** | 6-8 周 | 2-3 | 模块 1-7（DI / Lifecycle / Command 三件套 / Contribution / IPC / Config / Log），单元测试覆盖率 70%+ |
| **M2 UI 框架 + 编辑器壳** | 与 M1 并行 | 1-2 | ActivityBar / SideBar / EditorGroup / StatusBar / Quick Pick / Output 面板，全部走 contribution 注册 |
| **M3 首个业务 contribution（配置表编辑器）** | 4 周 | 2 | 用配置表跑通"从打开项目 → 编辑 → 保存 → 推送游戏运行时"全链路，验证内核可用性 |
| **M4 其它业务 contribution** | 4-6 周 | 全员 | 关卡 / 任务 / 剧情各一个 contribution，并行开发 |
| **M5（可选）DAP 调试器** | 4 周 | 1-2 | 游戏运行时 DAP server + 编辑器 DAP client |

**关键里程碑**：M3 结束时，你应该能用 **<300 行业务代码** 注册一个完整的"配置表编辑器" contribution，否则说明内核 API 太重，需要调整。

---

## 关键参考文件清单（按需查阅 VSCode 源码）

| 主题 | 文件 |
|---|---|
| DI 容器 | [src/vs/platform/instantiation/common/instantiationService.ts](src/vs/platform/instantiation/common/instantiationService.ts) |
| Service 装饰器 | [src/vs/platform/instantiation/common/instantiation.ts](src/vs/platform/instantiation/common/instantiation.ts) |
| Command 注册 | [src/vs/platform/commands/common/commands.ts](src/vs/platform/commands/common/commands.ts) |
| Menu 注册 | [src/vs/platform/actions/common/actions.ts](src/vs/platform/actions/common/actions.ts) |
| 快捷键解析 | [src/vs/platform/keybinding/common/keybindingResolver.ts](src/vs/platform/keybinding/common/keybindingResolver.ts) |
| Contribution | [src/vs/workbench/common/contributions.ts](src/vs/workbench/common/contributions.ts) |
| IPC 抽象 | [src/vs/base/parts/ipc/common/ipc.ts](src/vs/base/parts/ipc/common/ipc.ts) |
| 配置模型 | [src/vs/platform/configuration/common/configurationModels.ts](src/vs/platform/configuration/common/configurationModels.ts) |
| 配置注册 | [src/vs/platform/configuration/common/configurationRegistry.ts](src/vs/platform/configuration/common/configurationRegistry.ts) |
| 日志抽象 | [src/vs/platform/log/common/log.ts](src/vs/platform/log/common/log.ts) |
| 生命周期 | [src/vs/workbench/services/lifecycle/common/lifecycleService.ts](src/vs/workbench/services/lifecycle/common/lifecycleService.ts) |
| DAP 适配器 | [src/vs/workbench/contrib/debug/common/abstractDebugAdapter.ts](src/vs/workbench/contrib/debug/common/abstractDebugAdapter.ts) |
| DAP 会话 | [src/vs/workbench/contrib/debug/browser/rawDebugSession.ts](src/vs/workbench/contrib/debug/browser/rawDebugSession.ts) |
| 基础工具（Event/Disposable） | [src/vs/base/common/event.ts](src/vs/base/common/event.ts), [src/vs/base/common/lifecycle.ts](src/vs/base/common/lifecycle.ts) |

> **`base/common/` 下的 Event、Disposable、Cancellable、Async 工具可以接近原样照搬**，VSCode 团队十年打磨过，没有重写的必要。注意保留 MIT license。

---

## 验证 / 评估方式

1. **内核独立性**：把内核 8 个模块打成独立 npm 包，能在不依赖任何业务代码的情况下启动一个空 Electron 窗口，并通过命令面板执行测试 command。
2. **业务接入复杂度**：M3 完成时，新增一个"道具编辑器" contribution 不超过 300 行代码 + 1 个开发日。
3. **启动速度**：冷启动到可交互 < 2 秒（VSCode 同等规模时也是这个数量级）。
4. **IPC 延迟**：编辑器到游戏运行时单次往返 < 50ms（本地）。
5. **API 稳定性**：M3 后，内核 API 改动不超过两次破坏性变更。

---

## 几个常见的坑（提前预警）

1. **不要在 M1 就尝试做外部插件加载（ExtensionHost）**。VSCode 的 ExtensionHost 是个独立 Node 进程，加上 ProxyChannel、ActivationEvents、API 反向代理 —— 至少要 1-2 人月，且需求大概率不是 v1 必须。先把 contribution 抽象做对，未来加 ExtensionHost 是平滑扩展。
2. **不要照搬 ContextKey 表达式引擎**。VSCode 的 [contextkeys.ts](src/vs/platform/contextkey/common/contextkey.ts) 是个完整 DSL 解析器，先用 key=value 简化版即可。
3. **不要用 Monaco 来编辑结构化数据**。Monaco 只在编辑配置表里的脚本字段、JSON 字段时用，其他地方用 React 组件。
4. **小心 Electron 的 contextIsolation + nodeIntegration**。新版本默认隔离，IPC 必须走 preload script + contextBridge，提前规划好。
5. **VSCode 大量使用 `IDisposable`+`DisposableStore` 管理资源**。这套写法学习曲线陡但 ROI 极高，团队需要早建立规范。
