# 05 · renderer 注册与订阅收口

> 依据：[04-renderer-workbench.md](../architecture-review-202607/04-renderer-workbench.md) P2 #4/#5 + P3 #7/#8/#9 + 建议 2/3/4。
> 批次：任务 1/2/3 第二批（P2）；机会型见末尾。
> 原则：全部是"复制已验证的收口经验"（View 注册单点化已成功），不引入新范式。

## 任务 1：editor 注册收口 `registerEditorWithComponent` ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：
> - **新 `EditorComponentRegistry.ts`**（照抄 `ViewComponentRegistry` 形态）：模块级单例 + `registerEditorWithComponent(registration, component)`，componentKey 默认从 `typeId` 派生，类型上 `Omit<IEditorProvider, 'componentKey'> & { componentKey?: string }`——只在**刻意跨类型共享同一组件**时显式给（全仓仅 3 处：`untitled`/`schemaViewer` → `file` 组件、`webviewDiff` → `customEditor` 组件即 `CustomEditorHost`、`acp.session` → `agents.session`）。
> - **24 处 provider + 21 条 editorComponentMap 收口**：`BuiltInEditorProvidersContribution` 22 个 built-in + `AgentsContributions` 的 `acp.session` 全部改单点 `registerEditorWithComponent`。`EditorArea` 删除整张 `editorComponentMap`，改由 `EditorComponentRegistry.get` 解析；`EditorGroupView` 的 `componentMap` prop 换成 `resolveComponent` 回调。所有 typeId/componentKey 派生结果与旧值逐一核对一致，e2e 选择器零改动。
> - **关键认知**：旧注释"组件必须留在 EditorArea（chunk 时序）"已过时——`BuiltInViewsContribution` 早就在 BlockStartup 里 eager import React 组件，同 chunk 无时序缺口，editor 遂对齐 View 模式在 BlockStartup 贡献里直接 import 组件。
> - **占位兜底保留 + dev 断言**：`EditorGroupView` 未命中组件仍渲染占位 div，另加 `import.meta.env.DEV` 下 `console.error`。
> - **步骤 4（游离 map 归位）**：`registerViewWithComponent` 加可选第三参 `toolbar` → 新 `ViewToolbarRegistry`，8 条 `viewToolbarMap` 全部随 view 注册就地声明，删除 `viewToolbarMap.ts` + `toolbarMap` prop 线（PaneCompositeHeader/PaneCompositePart/ViewPaneContainer 改查 registry）。panel `ICON_MAP`（`icon-map.ts`）经核实**全仓无引用**（死代码），直接删除。
> - **验证**：`pnpm check` 全绿（editor 3,872 例）+ lint 0；`pnpm e2e` 所有编辑器类型均能打开（image/settings/keybindings/diff/doc/acp.session/…）。唯一失败 `smoke.agentsStickyScroll` 经 stash 对照确认为**既有 flake**（基线同样 1 挂 1 过 1 挂，失败点在最终折叠收敛轮询而非编辑器打开），非本任务回归。

## 任务 2：keybinding 去顺序化 ✅（P2，第二批）

> ✅ 已完成（2026-07-21，交付步骤 1+2）：
> - **weight 字段本已存在**（`KeybindingWeight` 枚举 + `IKeybindingItem.weight` + `IAction2Keybinding.weight`，registry 按升序 weight 插入、同 weight 追加、反向遍历 → 高 weight 优先、同 weight 再看 newest-first）；本任务把所有靠注册顺序取胜的 context-scoped 键位显式抬到 `WorkbenchContrib + 50`，彻底摆脱 newest-wins 依赖。
> - **迁移处**：`outlineActions`（Ctrl+P/N/B/F）、`quickInputActions`（Escape）、`agentTimelineActions`（prompt 建议弹窗 down/up/tab/enter/escape/ctrl+n/ctrl+p/ctrl+j + in-session find ctrl+f/f3/shift+f3/escape）、`explorerUndoActions`（Ctrl+Z/Y/Shift+Z）。均引入本文件局部 `*_KEY_WEIGHT` 常量并加注释说明"高 weight → 与注册顺序无关"。
> - **删注释**：`actions/index.ts` 中 5 处"registered last so … newest-wins tie-break"顺序依赖注释改写为 weight 语义；顺带清理已失效的"chat font-size trio"注释（该 trio 早已不再绑键，是过时竞争者）。
> - **测试锁定**：新增 `keybindingOrderIndependence.test.ts`（36 例）——每个 scoped 键位分别以"global 先/scoped 后""scoped 先/global 后"两种注册顺序注册竞争 binding，断言 context 生效时 scoped 恒胜（后者正是 newest-wins 会答错的用例），并断言 context 未生效时 global 胜（weight 不越界泄漏）。
> - **验证**：`pnpm check` 全绿（editor 3,908 例，57 tasks FULL TURBO）；`pnpm e2e` 跑 `smoke.vscodeKeybindings` + `smoke.outlineKeyboard` 3 例全过。
> - **步骤 3（各 Actions 自注册 + "命令 ID 声明 vs 注册"对账测试）**作为后续小步另行推进：风险正交（本轮已达成"顺序不再影响 tie-break、有测试锁住"的验收核心），拆分降低回归面。

**背景**：`actions/index.ts` 272+ 处手工 `registerAction2`，多处靠注册顺序控制 keybinding newest-wins tie-break，大段注释维系（`:479-482,509-511,651-685`）——重排 import 即改行为，是最脆的隐式契约。

**步骤**：

1. KeybindingsRegistry 加显式 `weight`/`priority` 字段，tie-break 规则改为 weight 优先、同 weight 再看注册顺序（过渡期语义兼容）。
2. 逐条把顺序敏感注释处的键位改为显式 weight，删除顺序依赖注释；迁移时逐条核对现行为（先写键位冲突的单测钉住现状，再迁移）。
3. 第二步（可与第一步分批）：各 `xxxActions.ts` 改自注册，`actions/index.ts` 只剩 import 列表；配"命令 ID 声明 vs 注册"对账测试，兜住"漏 import 静默失效"。

**验证**：键位相关 e2e 冒烟 + 冲突键位单测；重排 index.ts import 顺序后行为不变（这是目标本身，可作最终验证手段）。

## 任务 3：统一组件订阅范式 `useEventValue` ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：
> - **新增两个 hook**（`useService.ts`）：`useEventValue(event, getValue)` 对标 `useObservable`，服务于"旧式 `onDid*` Event + 命令式 getter"的取值型订阅——内部 `useSyncExternalStore` + ref 缓存快照（`getValue` 每次可返回全新数组/对象引用而不触发 uncached-snapshot 死循环，与 `useObservable` 同款守卫）+ `markAsSingleton` 包裹；`useEventSubscription(subscribe, deps)` 服务于"纯副作用型订阅"（异步重取 / 累积流式 chunk），`subscribe` 可返回单个/数组/无 Disposable，统一 `markAsSingleton` + 卸载时释放。两者都遵守 memory 教训（不在 cleanup dispose useRef 持有的 disposable；StrictMode 空跑安全）。
> - **迁移**：ExtensionsView（`useWorkbenchTick` tick → `useEventValue` 直接取 installed/searching/results 快照）、AiDebugView（主视图 record/clear 订阅 + RecordDetail replay-chunk 订阅 → `useEventSubscription`）、AiModelsPanel（`onDidChangeModels` → `useEventSubscription`）、BinaryPanel/CodexBinaryPanel（下载进度订阅在回调内建、`.finally` 释放，非 mount 生命周期，故不套 hook，仅补 `markAsSingleton` 包裹消除中途 leak 快照误报）。
> - **护栏**：新增 `useEventValue.test.tsx`（8 例：初值/fire 重渲染/全新引用快照/卸载释放/mount 期非 leak/多订阅/单订阅/deps 变更重订阅）+ `ExtensionsView.leak.test.tsx`（2 例，作为迁移组件 leak 测试模板：mount 期订阅不被 tracker 报 leak + 卸载真释放）。
> - **验证**：`pnpm check` 全绿（editor 3,918 例，+10；57 tasks FULL TURBO；lint 0）；`pnpm e2e` 跑 `smoke.extensions` 3 例全过。
> - **验收达成**：组件层取值型订阅收敛为 `useObservable` + `useEventValue`，副作用型订阅走 `useEventSubscription`，`useSyncExternalStore` 仅存于 hook 实现层。护栏采用 leak 测试模板路线（未加 lint 规则限制裸 `.onDid*(`——当前无误报，后续如需再升级为 warn→error）。

**背景**：事件订阅三套并存（`useObservable` / 手写 useEffect+dispose / useSyncExternalStore），重渲染手段四种；markAsSingleton 遵守参差——ExtensionsView/AiDebugView/AiModelsPanel 未做（reload 场景 leak tracker 误报风险），Explorer/Dialog 系做了。方向已定（useObservable），缺的是旧式 Event 服务的等价 hook。

**步骤**：

1. 实现 `useEventValue(event, getValue)`：内部统一 markAsSingleton + 正确 cleanup（注意 memory 教训：useRef 持有的 disposable 绝不在 cleanup dispose，StrictMode 空跑安全）。
2. 迁移点名的参差组件：ExtensionsView（`:44-51`）、AiDebugView（`:36-47`）、AiModelsPanel（`:113-117`）、BinaryPanel/CodexBinaryPanel（`BinaryPanel.tsx:50,89-90,116`，useRef 持 disposable + 事件回调里建订阅的风险形态）。
3. 护栏：leak test 模板或 lint 规则（限制组件内直接 `.onDid*(` 订阅，引导走 hook）——先 warn 级观察，无误报再升 error。

**验证**：现有 5 个 `*.leak.test.tsx` 全绿 + 为迁移组件补 leak 测试；dev reload 无 leak tracker 误报。

**验收**：组件层订阅只剩 `useObservable` + `useEventValue` 两条路（useSyncExternalStore 保留在 hook 内部实现层）。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ diff wrapper 家族抽 `useMonacoDiffEditor(containerRef, options)` hook：DiffEditor/SwarmDiffEditor/MergeEditor 三套 "MonacoLoader→create→setModel→dispose" 骨架收敛（约省 150-200 行；dirty-diff peek 形态不同，不强求入伙）。
- ⬜ 测试补位按风险排序：**agentSettings**（3,351 行仅 1 测试，恰是 useClaudeConfig/BinaryPanel 配置双写风险区）> PromptInput（1,366 行仅 3 处测试引用）> SwarmReviewEditor（848 行）。gitGraph/perforceGraph 展示型，优先级低。
- ⬜ `useClaudeConfig` 乐观双写改为写后重读 service 或补 onDidChange 订阅（`useClaudeConfig.ts:90-119`）；BinaryPanel 先 setState 后 config.update 的失败漂移同批看。
- ⬜ SessionListBody 上虚拟化（`SessionListBody.tsx:466-467` 全量 map，历史会话极多时的隐性成本；复用 `@tanstack/react-virtual` 既有形态）。
- ⬜ EditorGroupView（915 行 9 类职责）随功能改动渐进抽 hook/子组件，不做一次性重构。
