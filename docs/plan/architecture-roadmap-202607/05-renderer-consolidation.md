# 05 · renderer 注册与订阅收口

> 依据：[04-renderer-workbench.md](../architecture-review-202607/04-renderer-workbench.md) P2 #4/#5 + P3 #7/#8/#9 + 建议 2/3/4。
> 批次：任务 1/2/3 第二批（P2）；机会型见末尾。
> 原则：全部是"复制已验证的收口经验"（View 注册单点化已成功），不引入新范式。

## 任务 1：editor 注册收口 `registerEditorWithComponent` ⬜（P2，第二批）

**背景**：View 的"三处必改"已被 `registerViewWithComponent`（`ViewComponentRegistry.ts:54-62`）消灭，但 editor 注册仍是两处裸字符串对齐：24 处 `registerEditorProvider({componentKey})`（`BuiltInEditorProvidersContribution.ts:48-202`）与 21 条 `editorComponentMap.set()`（`EditorArea.tsx:36-57`），缺失时仅运行时占位 div 兜底（`EditorGroupView.tsx:745-752`）。

**步骤**：

1. 照抄 View 收口模式实现 `registerEditorWithComponent`：componentKey 从 typeId 派生，类型上 `Omit<..., 'componentKey'>` 杜绝手填；descriptor + React 组件单点声明。
2. 24+21 处存量迁移（机械替换，保持 typeId / componentKey 派生结果与现值一致，e2e 选择器零改动）。
3. 运行时占位 div 兜底保留（防御未注册），但补 dev 断言日志。
4. 顺手把 `viewToolbarMap`（`viewToolbarMap.ts:18-27`，8 个裸字符串 view id → toolbar 组件）与 panel `ICON_MAP`（`panel/icon-map.ts:3-9`）并入 View 注册 descriptor 的可选字段，消掉两个游离小 map。

**验证**：`pnpm check` + 全量 `pnpm e2e`（所有编辑器类型都要能打开）。

**验收**：editor 注册与 View 注册同构；componentKey 裸字符串对齐清零。

## 任务 2：keybinding 去顺序化 ⬜（P2，第二批）

**背景**：`actions/index.ts` 272+ 处手工 `registerAction2`，多处靠注册顺序控制 keybinding newest-wins tie-break，大段注释维系（`:479-482,509-511,651-685`）——重排 import 即改行为，是最脆的隐式契约。

**步骤**：

1. KeybindingsRegistry 加显式 `weight`/`priority` 字段，tie-break 规则改为 weight 优先、同 weight 再看注册顺序（过渡期语义兼容）。
2. 逐条把顺序敏感注释处的键位改为显式 weight，删除顺序依赖注释；迁移时逐条核对现行为（先写键位冲突的单测钉住现状，再迁移）。
3. 第二步（可与第一步分批）：各 `xxxActions.ts` 改自注册，`actions/index.ts` 只剩 import 列表；配"命令 ID 声明 vs 注册"对账测试，兜住"漏 import 静默失效"。

**验证**：键位相关 e2e 冒烟 + 冲突键位单测；重排 index.ts import 顺序后行为不变（这是目标本身，可作最终验证手段）。

## 任务 3：统一组件订阅范式 `useEventValue` ⬜（P2，第二批）

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
