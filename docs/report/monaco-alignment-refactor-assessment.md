# 评估：universe-editor 能否「完全往 monaco 靠拢」、避免两套方案

> 续《VSCode 与 universe-editor：command / keybinding 同 monaco 的适配对比》。本文回答：把项目重构成「完全往 monaco 靠拢、只保留一套命令/快捷键体系」是否可行、收益、问题、必要性。
>
> 关键事实已核实：`packages/platform/src` 共 **14,535 行**（21 个子模块），其中 command/keybinding 家族 **2,832 行（约 19%）**；依赖为纯 `monaco-editor@^0.55`（standalone 发行版），**未**引入 `@codingame/monaco-vscode-api` 等「完整 vscode 服务」方案。

---

## 0. 先厘清「完全往 monaco 靠拢」的两种含义

这句话有两条截然不同的技术路径，可行性与代价天差地别，必须分开评估：

| | 路径 A：用 monaco standalone services 当唯一内核 | 路径 B：迁移到 `@codingame/monaco-vscode-api`（真·vscode 服务） |
|---|---|---|
| 本质 | 抛弃自研 platform，用 monaco 包内自带的 `StandaloneServices` 驱动整个 workbench | 换内核——引入打包好的**完整 vscode 服务实现**，自研 platform 退役 |
| 一句话 | 拿编辑器的「玩具级 DI」去扛 IDE | 把项目重建在真正的 vscode 地基上 |
| 结论预览 | ❌ 不可行（能力根本不够） | ⚠️ 技术可行，但等于重写，且引入强锁定 |

很多人说「往 monaco 靠拢」其实模糊地混了这两者。下面分别拆解。

---

## 1. 当前架构事实：platform 远不止 command/keybinding

「避免两套方案」的前提是搞清楚——自研 platform 到底是不是「就一套命令系统」。答案是否定的。

`packages/platform/src` 的 21 个子模块（共 14,535 行）：

```
command(2832) base(~2465) workbench(~1778) di(~815) ipc(~491)
log configuration lifecycle dialog files glob host nls
notification progress storage telemetry userdata window workspace contribution
```

按职责归类：

- **命令/快捷键家族**（command，2832 行，19%）：`CommandsRegistry` / `KeybindingsRegistry` / `MenuRegistry` / `Action2` / `ContextKey` + when 表达式语法引擎（scanner/parser/eval）。
- **DI 地基**（di，~815 行）：`InstantiationService` / `ServiceCollection` / `createDecorator` / `registerSingleton`，支持延迟初始化 Proxy、循环依赖检测、dispose 链。**被 main 与 renderer 两端、约 100 个文件用 `@IServiceName` 装饰器消费**——这是整个 app 的骨架，不是配角。
- **workbench 级能力**（workbench，~1778 行）：`LayoutService`/`PartId`、`ViewRegistry`/`ViewsService`、`EditorService`/`EditorGroupsService`（分屏模型）、`StatusBarService`、`QuickInputService`、`FocusTracker`/`FocusStack`、`HistoryService`。**monaco standalone 完全没有这些抽象。**
- **跨进程与平台**（ipc/config/lifecycle/log/files/storage/window/workspace…）：`ProxyChannel` 把 main 端 18 个服务透明代理到 renderer；这套与 monaco **毫无关系**，main 进程同样跑自研 `InstantiationService`。

**关键洞察**：command/keybinding 是「重要但占比 ~19% 的一个模块」，platform 的真正不可替代价值在 DI + workbench 级服务 + 跨进程层。所谓「两套方案」实际只存在于 command/keybinding 这**一个**模块——其余部分 monaco 根本没有对应物，谈不上「两套」。

当前 monaco 集成是「黑盒 + 窄接口」：两个 DI 容器（自研 `InstantiationService` 与 monaco `StandaloneServices`）严格隔离，通讯面极小——向 monaco 注入 `FileBulkEditService`/`FileTextModelService` 两个 override，从 monaco 读 `EditorExtensionsRegistry`（命令镜像），加 worker 加载。整个桥接约 400 行。

---

## 2. 路径 A：用 monaco standalone services 当唯一内核 —— ❌ 不可行

### 为什么不行

monaco 的 `StandaloneServices` 是为「在网页里嵌一个编辑器」设计的，不是为「驱动一个 IDE workbench」设计的：

1. **它的 DI 是玩具级**：没有循环依赖检测、没有服务依赖图、没有延迟初始化 Proxy。而自研 DI 被 ~100 个文件依赖，承载 main/renderer 两端全部服务的生命周期。用 standalone DI 替它，等于推翻地基。
2. **它没有 workbench 级抽象**：LayoutService / ViewRegistry / EditorGroupsService（分屏）/ StatusBar / FocusStack / HistoryService —— monaco 一个都没有。即便切过去，这些仍得自己实现，即「重写一遍 platform」。
3. **它管不了跨进程**：ProxyChannel / IPC / main 进程服务与 monaco 无关，standalone services 无法覆盖。
4. **它的 command/keybinding 其实是 vscode 同源代码的子集，但被打包封死**：你能 import 到 `CommandsRegistry`、`EditorExtensionsRegistry`，但它们是 monaco 内部私有约定，版本升级（如 0.55 的 NLS 索引制变更，见 [[monaco-055-editcontext-nls]]）会无预警破坏——把核心命令体系建在这上面，等于把地基绑在一个不保证稳定的私有 API 上。

### 结论

路径 A 不是「统一成一套」，而是「用一套能力远不够的东西，去替换一套刚好够用的东西」。**否决。**

### 2.1 子问题：只把 command/keybinding 换成 monaco 内部模块行不行？

这是路径 A 的精确化——不换整个内核，只拿 monaco 的 `CommandsRegistry` / `KeybindingsRegistry` / `ContextKeyService`（位于 `monaco-editor/esm/vs/platform/...`，vscode 同源、可 import）替掉自研 command 家族。结论仍是**不能借此消灭两套**，拦路虎不是「能不能 import」，而是「两个 DI 容器 + accessor 不互通」：

- **两个隔离容器**：自研 `InstantiationService`（~100 个服务）与 monaco `StandaloneServices` 的 `ServicesAccessor` 不互通。命令 handler 执行依赖 accessor。
- **CommandsRegistry 可共享一张表，但执行仍两套**：monaco 命令需 monaco accessor（`get(ICodeEditorService)`），自研命令需自研 accessor（`get(ILayoutService)`）。要真合一只能把一边全迁进另一边容器 = 退回路径 A 整体换内核。
- **KeybindingService 不合适**：monaco `StandaloneKeybindingService` 的按键监听绑在编辑器 DOM 容器、只服务编辑器局部；workbench 级全局快捷键仍需自己做 window 级监听 + context 注入，即 `useGlobalKeybindingHandler` 一层省不掉。
- **ContextKeyService 必须单实例**：`when` 跨域求值（`editorTextFocus` 与 `hasActiveEditor` 同表）要求 context service 同一实例；两容器各一个则无法统一。
- **Action2 私有签名**：~150 个自研 `Action2` 需逐个迁到 monaco 的注册路径。
- **关键反讽**：当前 `monacoActionsBridge` 用 `editor.trigger()` 把执行**委托回 monaco**，存在的唯一理由就是绕开「accessor 不互通」——若「直接复用」可行，现在就不需要 trigger。它本身就是此路不通的证据。
- **私有 API 风险**：`esm/vs/platform/...` 非 monaco 公共 API（公共面仅 `monaco.editor.*`/`monaco.languages.*`），跨版本不稳，0.55 NLS 变更即先例（见 [[monaco-055-editcontext-nls]]）。

**小结**：「直接用 monaco 模块」要么坍缩回整体换内核（路径 A，否决），要么仍是两套（桥接方向变了，还多依赖私有 API，净亏）。若只为**减少重复**，唯一低风险方向是继续强化现有「镜像 monaco 命令 → 自研表」（镜像做全、默认键/command id 对齐 vscode），而非反向依赖 monaco 内部模块。

---

## 3. 路径 B：迁移到 `@codingame/monaco-vscode-api` —— ⚠️ 技术可行，但是「换内核」

这才是业界真正「让 monaco 拥有完整 vscode 行为」的成熟路径。该库把 vscode 的**真实** service 实现（command/keybinding/configuration/views/quickinput/输出/SCM…）打包暴露，支持按需启用 service override，让一个 monaco 实例获得近乎完整的 vscode workbench 能力。

### 收益（如果迁移成功）

- ✅ **真正消灭「两套」**：命令、快捷键、when 表达式、菜单、配置全部用 vscode 原生实现，不再需要 `monacoActionsBridge` 镜像、不再需要焦点门控双路由——编辑器内外的按键由同一个 `KeybindingResolver` + when 子句统一调度（即对比报告里描述的 VSCode「统一调度」范式）。
- ✅ **行为与 VSCode 高度一致**：`editor.action.*` 默认键、和弦、context key、用户 `keybindings.json` 语义天然对齐（呼应 CLAUDE.md「对标 vscode 的功能请保持 command id / 默认键一致」的诉求）。
- ✅ **生态红利**：可直接复用 vscode 扩展贡献点（keybindings/menus/commands）、甚至部分 vscode 扩展。
- ✅ **删代码**：command 家族 2832 行 + 桥接 ~400 行里的相当一部分可由库接管。

### 问题与风险（为什么代价巨大）

- 🔴 **这是换内核，不是改模块**。自研 `InstantiationService` 与 vscode 的 DI 是两套；要享受 vscode 服务，整个服务注册/消费层（~100 个文件的 `@IServiceName`、`registerSingleton`、`createInstance`）都要迁到 vscode 的 instantiation 体系。Layout / View / EditorGroups / StatusBar / Focus / History 全部要从自研换成 vscode 实现并重接 React 层。
- 🔴 **强供应商锁定**：项目深度绑定 `@codingame/monaco-vscode-api` 的版本节奏与 API 形态。它紧跟 vscode 上游，破坏性更新频繁；体积显著增大；service override 的启用组合有不少坑。
- 🔴 **与现有 Electron 多进程架构的摩擦**：本项目把 FileSystem/Watcher/Workspace/Terminal 等放在 main 进程经 ProxyChannel 暴露；vscode 服务体系自带一套 fs/workspace 模型，二者需要做适配桥，未必比现在省事。
- 🔴 **插件系统会冲突/重叠**：项目已自建 VSCode 式外部插件系统（双 host 信任隔离 + fs 网关 + 真 diff，见 [[extension-system-progress]]）与内置 TS 插件（[[typescript-builtin-plugin]]）。引入 monaco-vscode-api 后，两套「贡献点/服务」模型会重叠甚至打架，需重新设计边界。
- 🔴 **迁移期是「三套并存」而非「一套」**：迁移不可能一夜完成，过程中自研 platform、当前 monaco 桥接、新的 vscode 服务三者并存，复杂度短期不降反升。
- 🟡 **回归风险面巨大**：command/keybinding/layout/editor 全部改写，现有 e2e 冒烟（`@p0`）需大规模重写与验证。

### 结论

路径 B **能**达成「统一成一套」的目标，但它的本质是「在 vscode 真内核上重建本项目」。这是一次战略级重写，不是重构。

---

## 4. 当前「两套」其实没那么痛——成本已被很好地隔离

判断必要性，要看现状的痛点到底有多大。客观看，当前方案把「两套」的成本压得很低：

- 真正分裂的只有 command/keybinding **一个**模块；其余 80% 的 platform 与 monaco 无重叠。
- 桥接面收敛在 ~400 行三块代码（`StandaloneServices.initialize` override、`bridgeAllMonacoActions` 镜像、`useGlobalKeybindingHandler` 双路由），且都有测试 seam（`bridgeMonacoActionsForTests`）。
- monaco 命令已能在命令面板列出并可 rebind；用户 `keybindings.json` 三层加载已工作；和弦、when、守卫齐备。
- 不魔改 monaco 内核 → monaco 版本升级成本低（这正是 standalone 黑盒方案的核心优势）。

已知的真实代价只有两条，且都较边缘：① 编辑器聚焦时项目自己的 `Ctrl+K` 系和弦让位 monaco；② monaco 内嵌 widget（find/IntelliSense）的键不可 rebind。这两条都不构成「必须重写内核」的理由。

---

## 5. 必要性判断与建议

### 必要性：低

「完全往 monaco 靠拢」要么走不通（路径 A），要么是一次伤筋动骨、收益与风险严重不对称的换内核（路径 B）。当前「两套」的成本已被隔离得很好，没有产生与重写代价相称的痛点。**不建议为「消灭两套」而重构。**

### 分场景建议

| 你的真实目标 | 推荐做法 | 量级 |
|---|---|---|
| 嫌 command/keybinding 维护双份心智累 | **保持现状**，强化 `keyboardDebugService` 与文档，把「默认键归 monaco、全局键归自研」讲清楚 | 文档级 |
| 想让快捷键/命令更贴近 vscode 行为 | 在现有桥接上**增量改良**：扩大 monaco 命令镜像覆盖、对齐默认键与 command id（CLAUDE.md 已有此约定） | 数百行 |
| 想要 vscode 扩展生态 / 完整 vscode 行为，且愿意承担战略级重写 | 才考虑 **路径 B**，并务必先做一次性 PoC：单独起一个最小工程验证 monaco-vscode-api + Electron 多进程 + 现有插件系统能否共存 | 重写级 |

### 如果未来真要评估路径 B，先回答三个否决性问题

1. 现有自研**插件系统**（[[extension-system-progress]]）与 monaco-vscode-api 的贡献点/服务模型能否共存，还是必须二选一？
2. main 进程的 **ProxyChannel/IPC 服务**（FileSystem/Watcher/Workspace/Terminal）如何嫁接到 vscode 的 fs/workspace 服务模型？
3. 团队能否承受**强版本锁定**与跟随 vscode 上游的破坏性更新节奏？

这三题里只要有一个答案是「不行/不愿意」，路径 B 就该搁置。

---

## 6. 一句话总结

- **路径 A（用 monaco standalone services 当内核）**：不可行——拿编辑器的玩具 DI 扛不起 IDE 的 workbench。
- **路径 B（迁到 monaco-vscode-api）**：可行但是换内核，强锁定 + 战略级重写 + 与现有插件/多进程架构摩擦，收益与风险不对称。
- **现状**：「两套」只存在于占比 ~19% 的 command/keybinding，且成本已被 ~400 行桥接很好地隔离。
- **必要性：低。建议保持当前「分治」架构，按需做增量改良，不为「统一成一套」而重写。**
