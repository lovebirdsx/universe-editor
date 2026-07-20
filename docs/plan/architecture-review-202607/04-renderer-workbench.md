# 04 · renderer 工作台架构

> 事实/推测已分开标注；关键结论均经文件:行号核对。

## ① 现状速写

### 规模

- renderer 非测试源码约 **11.3 万行**（其中约 7,000 行为生成/数据文件：materialIconMap、editorOptionsSchema.generated）；测试 **352 个文件 / 约 7.5 万行**，测试:源码比约 0.66。
- 板块分布：`services/acp` 14.3k（最大单板块）、`workbench/agents` 10.4k、`workbench/editor` 6.3k、`services/editor` 4.5k、`workbench/files` 4.4k（主要是图标数据）。

### 目录职责

| 目录 | 职责 |
|---|---|
| `main.tsx` (845 行) | 单函数 `bootstrapWorkbench()` 手工装配全部 DI 服务（32 处 `new`、66 处 set/register），分 LifecyclePhase 推进 |
| `actions/` (18.8k) | Action2 命令层，`index.ts` 一次性 side-effect 注册 |
| `contributions/` (21.1k) | 92 个生命周期 contribution，按 4 个 WorkbenchPhase 拆文件注册 |
| `services/` (76.1k 含测试) | DI 服务层：acp（聊天内核）、editor（EditorInput 家族 23 个子类）、explorer、languageFeatures 等 |
| `workbench/` (70.1k 含测试) | React 视图层：agents（聊天 UI）、editor、scm、sidebar 等 |

### Top 20 大文件（非测试）

| # | 文件 | 行数 | 性质 |
|---|---|---|---|
| 1 | workbench/files/materialIconMap.ts | 4123 | 数据表（非热点） |
| 2 | contributions/generated/editorOptionsSchema.generated.ts | 2832 | 生成物（非热点） |
| 3 | workbench/gitGraph/GitGraphEditor.tsx | 1945 | 大组件（职责单一） |
| 4 | services/acp/acpSession.ts | 1640 | **上帝服务** |
| 5 | workbench/agents/ChatBody.tsx | 1623 | **上帝组件** |
| 6 | workbench/agents/PromptInput.tsx | 1366 | 大组件（Monaco 输入+药丸+图片） |
| 7 | e2e/probe.ts | 1327 | 测试探针 |
| 8 | workbench/scm/ScmView.tsx | 1303 | 大组件 |
| 9 | services/acp/acpSessionService.ts | 1250 | 大服务（多会话协调） |
| 10 | workbench/perforceGraph/PerforceGraphEditor.tsx | 1013 | 大组件 |
| 11 | actions/editorActions.ts | 982 | 命令集合 |
| 12 | workbench/editor/EditorGroupView.tsx | 915 | **上帝组件** |
| 13 | services/explorer/ExplorerTreeService.ts | 881 | 大服务 |
| 14 | workbench/swarm/SwarmReviewEditor.tsx | 848 | 大组件 |
| 15 | services/acp/acpClientService.ts | 847 | 连接层 |
| 16 | main.tsx | 845 | DI 装配 |
| 17 | services/acp/markdownRenderer.ts | 795 | 自研 md 解析器（纯函数） |
| 18 | services/acp/acpSessionHistory.ts | 761 | 历史持久化 |
| 19 | workbench/swarm/SwarmReviewsView.tsx | 720 | 大组件 |
| 20 | actions/index.ts | 699 | 手工注册表 |

**热点结论【事实】**：真正的复杂度重心是 ACP 三件套（acpSession / ChatBody / acpSessionService，合计 ~4.5k 行）+ EditorGroupView；gitGraph/perforceGraph/scm 属"大但职责单一"的展示组件。

## ② 做得好的点

1. **DI↔React 单点桥接**：`workbench/useService.ts` 是唯一桥（ServicesContext + `useService` 246 处/80 文件 + `useObservable` 134 处/56 文件），组件层不碰 accessor；无第三方状态库，跨组件状态一律在 service。
2. **View 注册已收口**："三处必改"被 `registerViewWithComponent`（`services/views/ViewComponentRegistry.ts:54-62`）消灭：componentKey 从 view id 派生、类型上 `Omit<IViewDescriptor,'componentKey'>` 杜绝手填，全仓 12 个 View 无一旁路。
3. **性能形态成熟且克制**：三大高频列表（聊天时间线 `ChatBody.tsx:473`、文件树/搜索/SCM 共享 `workbench-ui/Tree`）全走 `@tanstack/react-virtual` 且带阈值开关；`React.memo` 全仓仅 12 处，精准打在列表行组件；流式路径三重优化（16ms 批处理事务 + sealed-prefix 增量 markdown 解析 + RAF 滚动收敛）。
4. **历史性能事故的防护已结构化**：filePathLink 正则回溯修复固化在文法结构里（disjoint 字符类 + 事故注释，`filePathLink.ts:105-129`）；tracer 增量 scan 指针 + 512KB 大帧丢弃 + base64 脱敏三道防线。
5. **泄漏防护有体系**：`markAsSingleton` + `GCBasedDisposableTracker`（platform lifecycle.ts:159,271），renderer 75 处使用，5 个专门 `*.leak.test.tsx` 用 `setDisposableTracker` 断言。
6. **markdown 渲染安全**：自研 tokenizer 输出 AST → React 元素；`dangerouslySetInnerHTML` 全仓仅 1 处且仅用于 Monaco colorize 可信输出。
7. **编辑器模型对 VSCode 高保真**：Grid 分栏、preview/pinned/locked、matches/typeId 身份、引用计数 MonacoModelRegistry 跨组共享模型、完整序列化恢复 + ClosedEditors LIFO 栈。省略 EditorPane、用 "Input→componentKey→React 组件" 直连是合理简化。
8. **分层护栏**：ESLint no-restricted-imports 强制 workbench→services 单向依赖（`apps/editor/eslint.config.js:18-79`）。

## ③ 问题清单

无 P1（未发现正确性缺陷级问题，以下均为结构/维护性风险）。

### P2

| # | 问题 | 证据 |
|---|---|---|
| 1 | **acpSession.ts 上帝服务**：单类 1640 行承担约 15 类职责——状态机、messages/toolCalls/timeline 三套派生模型、plan/usage/权限/提问/MCP/折叠/计时/历史重放/提示队列/批处理事务 | `acpSession.ts:135,153,437,1253,1437-1620` |
| 2 | **ChatBody.tsx 上帝组件**：1623 行耦合虚拟化配置、滚动物理（RAF 收敛/锚点/尺寸校正）、折叠、书签、find、键盘导航、右键菜单、行高估算、outline 联动 | `ChatBody.tsx:311-1554` |
| 3 | **EditorGroupView.tsx 上帝组件**：915 行含 tab 渲染、两套独立拖拽、外部资源 drop、右键菜单、编辑器实例化、溢出滚动、焦点管理、锁定指示 9 类职责 | `EditorGroupView.tsx:113-912` |
| 4 | **事件订阅模式三套并存、markAsSingleton 遵守参差**：`useObservable`（新）、手写 useEffect+dispose（旧）、useSyncExternalStore 混用；触发重渲染手段有 setTick/setVersion/useReducer/uSES 四种。ExtensionsView/AiDebugView/AiModelsPanel 等订阅未 markAsSingleton（reload 场景可能被 leak tracker 误报），而 Explorer/Dialog 系做了 | `ExtensionsView.tsx:44-51`、`AiDebugView.tsx:36-47`、`AiModelsPanel.tsx:113-117` vs `DialogHost.tsx:17`、`ExplorerView.tsx:85-91` |
| 5 | **actions/index.ts 注册顺序即语义**：272+ 处手工 `registerAction2`，漏注册静默失效；多处靠注册顺序控制 keybinding newest-wins tie-break（大段注释维系），重排即改行为 | `actions/index.ts:333-699`，顺序敏感注释 :479-482,509-511,651-685 |
| 6 | **main.tsx 装配顺序即正确性**：`services.set` 与 `getSingletonServiceDescriptors` 两条注册路径共存（注释自称 "incremental migration" 未完成）；依赖顺序靠 "Must exist before X" 注释维系 | `main.tsx:407-410,537,606-607,630,145-151` |

### P3

| # | 问题 | 证据 |
|---|---|---|
| 7 | **编辑器注册仍是两处裸字符串对齐**：24 处 `registerEditorProvider({componentKey})` 与 21 条 `editorComponentMap.set()` 靠字符串对齐，无类型约束；缺失时仅运行时占位 div 兜底。View 已有单点 API，editor 未做等价收口 | `BuiltInEditorProvidersContribution.ts:48-202` vs `EditorArea.tsx:36-57`；兜底 `EditorGroupView.tsx:745-752` |
| 8 | **两个平行手工小 map 游离在注册体系外**：`viewToolbarMap`（8 个裸字符串 view id → toolbar 组件）与 panel `ICON_MAP` | `viewToolbarMap.ts:18-27`、`panel/icon-map.ts:3-9` |
| 9 | **diff wrapper 家族重复**：DiffEditor/SwarmDiffEditor/MergeEditor 三套 React wrapper 各自重写 "MonacoLoader→create→setModel→dispose" 骨架；配置组重复 4 遍、theme 三元写 3 遍。【推测】抽 `useMonacoDiffEditor` hook 可省约 150-200 行。session diff 复用通用 DiffEditorInput 无独立实现，dirty-diff peek 形态不同不算重复 | `DiffEditor.tsx:81-180`、`SwarmDiffEditor.tsx:108-165`、`MergeEditor.tsx:54-104` |
| 10 | **本地 state 与 service 状态乐观双写**：`useClaudeConfig` 的 saveProfile/deleteProfile 直接 setState 不重读 service（磁盘被 CLI 外部改动时短暂不同步，且无 onDidChange 可订阅）；BinaryPanel 先 setState 再 config.update，失败则 UI 与配置漂移【后半为推测】 | `useClaudeConfig.ts:90-119`、`BinaryPanel.tsx:67-71` |
| 11 | **BinaryPanel 用 useRef 持有 disposable、在事件回调里创建订阅**——与 memory "useRef 持有的 disposable 绝不在 cleanup dispose" 教训同形态的风险区（CodexBinaryPanel 同构），且未 markAsSingleton | `BinaryPanel.tsx:50,89-90,116` |
| 12 | **SessionListBody 无虚拟化**：`<ul>` 全量 map 渲染，历史会话极多时是隐性成本【影响推测】 | `SessionListBody.tsx:466-467` |
| 13 | **测试覆盖不均**：acp(51 文件/17.4k 行)、editor 双侧(58/9k)、actions(30/7.5k)、contributions(40/6.9k) 厚实；但 `workbench/agentSettings` 3351 行仅 1 个测试(51 行)、SwarmReviewEditor 848 行几乎裸奔、PromptInput 1366 行仅 3 处测试引用 | 统计对照源码行数 |

## ④ 方向性建议

1. **拆 ACP 双巨头，按"模型投影"切**：acpSession 的三套派生模型 + 批处理事务是内聚核心可保留；plan/usage/权限/提问/MCP/计时/折叠这类"会话外围状态"各自是独立 observable 簇，拆成组合进 session 的小对象（session 只做装配）。ChatBody 优先抽滚动物理为 `useChatScroll` hook（复杂度重心，已有 6 个滚动回归 e2e 兜底），折叠/书签/find 已有边界，拆分成本低。
2. **统一事件订阅范式**：方向已明（useObservable），补 `useEventValue(event, getValue)` 覆盖旧式 Event 服务，hook 内部统一 markAsSingleton，用 lint 或 leak test 模板强制组件订阅走统一 hook——消灭参差而不是逐组件补。
3. **把 View 收口经验复制到 editor 注册**：`registerEditorWithComponent({typeId, deserialize}, Component)`，componentKey 从 typeId 派生；顺手把 viewToolbarMap/icon-map 并进 View 注册 descriptor 可选字段。
4. **actions/index.ts 去顺序化**：给 KeybindingsRegistry 显式 weight/priority 字段替代"后注册者赢"；再把 index.ts 改为各 `xxxActions.ts` 自注册，index 只剩 import 列表，配"命令 ID 声明 vs 注册"对账测试兜底。
5. **main.tsx 完成 registerSingleton 迁移**：手工 `new` 收敛到确需精确时序的少数服务（Lifecycle/ContextKey/Storage），其余走声明式描述符懒解析。
6. **diff 家族抽一个 hook 即可**：`useMonacoDiffEditor(containerRef, options)` 承接加载骨架 + 通用配置 + theme + 抢焦点；不必强求 dirty-diff peek 入伙。
7. **测试补位按风险排序**：agentSettings（配置双写区，恰是 #10/#11 风险所在）> PromptInput > SwarmReviewEditor。gitGraph/perforceGraph 属展示型，优先级可低。

**总评【推测】**：注册收口、泄漏防护、虚拟化、事故防护结构化四点明显好于同规模项目平均水平；主要结构债集中且清晰（ACP 双巨头 + EditorGroupView + 两处未完成的注册迁移），属于"知道往哪拆"的债而非"腐化"的债。
