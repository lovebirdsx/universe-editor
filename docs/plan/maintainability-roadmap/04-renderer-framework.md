# 计划 04 · renderer 框架

> 配套总览：[README.md](./README.md)
> 范围：`renderer/{services,contributions,actions,workbench,main.tsx}`（不含 acp/ai 业务，见计划 02）+ `packages/workbench-ui/`
> 主轴：**收口"N 处必改"的脆弱注册** + **大组件 React 性能** + **bootstrap/contributions 数据化**。

---

## 现状肯定

- `useObservable` 基于 `useSyncExternalStore` + `markAsSingleton(autorun)`，React 18 并发安全，避免假泄漏（见 memory「reload disposable 泄漏」）。
- bootstrap 分相位（BlockStartup/BlockRestore/AfterRestore/Eventually）遵循 VSCode 范式。
- View 注册三层分离（ViewContainerRegistry / ViewRegistry / ViewComponentRegistry）职责清晰。
- 大列表虚拟化已普遍（Explorer/Search 走 `workbench-ui/src/tree/` 的 `<Tree>`）——**勿重复造轮子**。
- 通用 UI 已大量沉淀到 workbench-ui（atoms/layout/overlay/feedback + tokens）。

---

## P0 · View 注册"三处必改"易漏（componentKey 字符串跨文件耦合）

### 问题
加一个 View 要改 3 个文件，且 `componentKey` 是**跨文件硬编码字符串**，任一处打错或漏改，**不报编译错，运行时才崩**（视图空白）。

### 证据
CLAUDE.md 套路 B 明确"三处必改"：
```
contributions/BuiltInViewContainersContribution.ts   # Container 注册
contributions/BuiltInViewsContribution.ts            # View 描述符（含 componentKey: 'explorer.tree'）
contributions/ViewComponentsContribution.ts          # ViewComponentRegistry.register('explorer.tree', ExplorerView)
```
后两处的 `'explorer.tree'` 字符串必须逐字相同，无类型约束保证。

### 影响
新增 View 的高频踩坑点；重构 componentKey 风险高；与"加 ViewContainer 易漏"是同类脆弱约定。

### 落地步骤
- 提供合并注册 API，让"描述符 + 组件"在**单点**声明：
  ```ts
  ViewRegistry.registerViewWithComponent({
    id: 'workbench.view.explorer.main',
    containerId: 'workbench.view.explorer',
    name: 'Explorer',
    component: ExplorerView,        // 直接给组件，内部派生/绑定 componentKey
    order: 1,
  })
  ```
  内部用稳定 key（如 view id）替代手写 componentKey 字符串，消除跨文件字符串耦合。
- 兼容期可保留旧三段 API，新 View 一律走单点 API。
- 若坚持保留 componentKey 概念，至少把它定义为 `const ViewComponentKeys = {...} as const`，三处引用同一常量，让 tsc 兜底。

### 验证
`pnpm check`；新增一个测试 View 走单点 API 能正常挂载；故意不绑组件时有**明确报错**而非空白。

---

## P1 · contributions/index.ts 单文件 709 行、88 处注册

### 问题
所有 contribution 的相位注册挤在一个 709 行文件，难定位"某相位有哪些贡献"，新增必改核心文件。

### 证据
`renderer/contributions/index.ts` 709 行，约 88 处 `ContributionsRegistry.registerContribution(...)`，相位混排（BlockStartup ~30 / AfterRestore ~49 / …）。

### 影响
导航困难；相位选择正确性全靠开发者人肉判断；merge 冲突高发。

### 落地步骤
- 按相位分文件：
  ```
  contributions/registration/
    blockStartup.ts    blockRestore.ts    afterRestore.ts    eventually.ts
  contributions/index.ts   # 只 import 四个分文件
  ```
- 或让每个 Contribution 类静态声明自身相位（`static readonly phase = WorkbenchPhase.AfterRestore`），index 反射注册——更彻底但改动大，按需选。
- 优先按相位分文件（机械、低风险）。

### 验证
`pnpm check` + 启动 e2e（`smoke.startup`）确认相位顺序不变。

---

## P1 · 大组件缺 memo 导致级联重渲

### 问题
若干大组件未 `React.memo` 包装 / 子组件未拆分 memo，父级重渲时整棵子树重算。

### 证据
- `renderer/workbench/editor/EditorGroupView.tsx`（727 行）：未 `memo`，props 含 `componentMap` 等，EditorArea 重渲时所有分屏组重算。
- `renderer/workbench/agents/ChatBody.tsx`（1344 行）：`useCallback` 依赖 `[mode, overrides]` 频繁变化，下游 `MessageContent` 等未 memo（仅 `ToolCallCard` 用了 memo）。

### 影响
多分屏编辑、大会话场景的无关重渲，叠加计划 02 的流式重解析，卡顿可感知。

### 落地步骤
1. `EditorGroupView` 用 `memo` 包装；把 EditorTab / TabBar 拆为独立 memo 子组件。
2. ChatBody：折叠状态改 `useReducer`（`dispatch` 引用稳定），消除 `useCallback` 的 `[mode, overrides]` 依赖；对 `MessageContent` 等列表项 memo。
3. 用 React DevTools Profiler **先测量再改**，避免无效 memo（memo 本身有比较成本）。

### 验证
Profiler 对比改前后重渲次数；`pnpm check` + agents/editor e2e 不回归。

---

## P1 · bootstrap（main.tsx 686 行）服务装配命令式、易漏

### 问题
`main.tsx` 用 686 行命令式逐个 `services.set(...)` 装配 ~60 个服务，漏写一个 IPC 代理绑定运行时才崩，无编译期保护，也难按相位优化启动。

### 证据
`renderer/main.tsx`：大段 `services.set(IFoo, ProxyChannel.toService(...))` 与 `instantiation.createInstance(...)`，IPC 代理绑定集中在中段。

### 影响
新增跨进程服务要在 main.tsx + channelNames + main 侧多处接线（套路 C），漏点多；启动期工作难以重排到 Eventually。

### 落地步骤
- 把"IPC 代理服务"抽成**声明表**：`[{ decorator: IFoo, channel: ServiceChannels.Foo }]`，循环绑定，替代逐行 `set`。漏接线变成"表里少一项"，更易 review，也可加测试校验"每个 ServiceChannels 都有对应绑定"。
- 纯 renderer 服务装配同理可表驱动。
- 评估哪些 `createInstance` 可延后到 `AfterRestore`/`Eventually`（配合计划 06 的启动打点先定位瓶颈，再延后）。

### 验证
`pnpm check`；加测试断言 ServiceChannels 与绑定表一一对应；`smoke.startup` e2e。

---

## P2 · workbench-ui 渐进迁移技术债

### 问题
CLAUDE.md 自述的"渐进迁移项"：Diff/Terminal/SCM/Config/Search 的局部 `.iconBtn`、SessionsPopover/ConfigOptionsBar 等未收编到 workbench-ui，未 token 化的旧 css。

### 影响
通用控件有多份实现，复用率受损。非紧急。

### 落地步骤
- 维持 CLAUDE.md 既定策略："动到相关文件时顺手迁移"。
- 可列一个 checklist 跟踪未迁清单，避免遗忘，但不专门排期大迁移。

---

## P2 · actions 的 id 用裸字符串

### 问题
~60 处 `registerAction2` 与命令引用用裸字符串 id，拼错只在运行时（命令面板找不到）暴露。

### 影响
低危（VSCode 也用字符串 id），但跨 action 引用命令时无 tsc 兜底。

### 落地步骤
- 对**被其他代码引用**的命令 id 收敛为 `as const` 常量（很多 Action 已有 `static readonly ID`，鼓励一致使用并在引用处用该常量）。不必为所有 id 强制生成常量表。

---

## 任务依赖与建议顺序

```
P0 View 单点注册（独立、消除整类踩坑）── 先做
P1 contributions 按相位分文件（机械、低风险）
P1 bootstrap IPC 绑定表驱动（独立）
P1 大组件 memo（先 Profiler 测量）── 配合计划 02
P2 迁移债 / action id 常量（机会型，动到就做）
```
