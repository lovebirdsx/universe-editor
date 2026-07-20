# 02 · packages 内核与分层架构

> 标注约定：未标注即为**事实**（有代码/配置证据）；标注【推测】为基于证据的判断。

## ① 现状架构速写

### 包依赖图（文字版，→ 表示 runtime dependency）

```
config-ts / config-eslint          （叶子，仅被 devDep 引用）

platform（零 dependencies，仅 devDeps）
  ↑
  ├── workbench-ui        → platform, react/react-dom, @floating-ui, @tanstack/react-virtual
  ├── extensions-common   → platform, zod, vscode-languageserver-types
  │     ↑
  │     ├── extension-gallery    → extensions-common
  │     ├── extension-packaging  → extensions-common, adm-zip
  │     └── extension-host       → extension-api, extensions-common, zod
  │                                （platform 为 devDep，esbuild 整包内联，见 esbuild.config.mjs 头注）
  ├── extension-api       → （零依赖，仿 vscode.d.ts 的纯类型面）
  │
  e2e-contract（零依赖，playwright-free 探针契约）
  ↑
  e2e-harness → e2e-contract, @playwright/test

apps/editor → 以上全部 + extensions/*（作 devDep，仅为构建编排）
extensions/* → 仅 devDep extension-api（esbuild 独立打包，零 runtime workspace 依赖）
```

**无反向依赖、无循环依赖**（全部 package.json 核对）。方向严格单向：config → platform → {workbench-ui, extensions-common} → extension-* → apps。

### 各包规模（src 非测试行数 / 测试文件数）

| 包 | 行数 | 测试文件 | 说明 |
|---|---:|---:|---|
| platform | 19,864 | 58 | 28 个子模块；最大 base/ 6,709、command/ 3,012、workbench/ 2,104、undoRedo/ 1,852 |
| workbench-ui | 4,440 | 26 | atoms/layout/overlay/feedback/tree/list/dnd/contextView + tokens.css |
| extension-host | 3,328 | 13 | esbuild 单文件 bundle，ELECTRON_RUN_AS_NODE 启动 |
| extensions-common | 2,349 | **0** | manifest/semver/rpc/stdioProtocol + git/swarm/perforce 领域 wire DTO |
| extension-api | 1,190 | 1 | index.ts 960 行单文件类型面（仿 vscode.d.ts），version='0.5.0' |
| e2e-harness | 1,039 | 0 | fixtures + 7 个 Page Object |
| e2e-contract | 741 | 0 | `window.__E2E__` 探针 DTO |
| extension-gallery | 330 | 1 | |
| extension-packaging | 191 | 2 | vsix 打包 |
| markdown-language-server | 0 | 0 | **幽灵目录**，只剩 node_modules（历史上 ef679780 移入 markdown 扩展） |

对照 apps/editor：main 14,183 / renderer 46,188 / shared 4,757 / preload 83 行。

## ② 做得好的点

1. **platform 真正做到零 UI / 零 Electron / 零 DOM**。package.json 无 `dependencies` 字段；全源码 grep 无 `electron`/`react`/`monaco` import；`window.`/`document.` 命中全部是注释。这是整个分层的地基，且是被守住的。
2. **barrel 有自动化守卫**。根 barrel 仅 37 行、只转发 28 个子目录 barrel；`packages/platform/src/__tests__/index.test.ts:95` 的 "barrel coverage" 测试用 `export * from` 可达性扫描，保证任何导出符号的源文件必须挂进 barrel 链，否则 CI 失败。巨型 barrel 的常见腐化路径（漏挂、死导出）被机制化拦住。
3. **进程边界干净**。renderer 46k 行代码里 `ipcRenderer` 只出现在注释中，全部经 preload `contextBridge` + ProxyChannel；main 与 renderer 互相零 import。e2e 探针契约抽成 playwright-free 的 e2e-contract 包，app 侧只留 17 行 re-export shim。
4. **workbench-ui 抽取完成度高**。69 个 renderer 文件消费它；renderer 侧 dialog/quickinput/notification/progress 只剩 19–83 行薄 wrapper；抽查未发现明显"该沉淀未沉淀"的成块通用组件。renderer/workbench/dnd 与 workbench-ui/dnd 非重复（前者是 view-drop 领域逻辑，后者是拖拽基建）。
5. **构建拓扑有文档化的决策记录**。turbo.json、extension-host esbuild 配置的"为什么"注释密度恰当。

## ③ 问题清单

### P2-1 扩展 wire DTO 靠"结构化复制"共享，无 drift 守卫

- 证据：`packages/extensions-common/src/gitGraph.ts:2-9` 注释自述 *"the `git` extension … keeps a local copy of these shapes to avoid bundling this package"*；平行副本在 `extensions/git/src/gitGraphSource.ts:20-45`；swarm.ts 头注同样声明 perforce 扩展持有副本。
- 影响面：renderer（消费方）与扩展（实现方）之间的 JSON 契约靠人肉对齐，字段改名/语义漂移只能在运行时或 e2e 暴露；extensions-common 又是 0 测试包，两头都没有守卫。
- 【推测】"避免 bundling" 的理由站不住：`import type` 在 esbuild 下零成本。这层复制可以无代价消除。

### P2-2 extensions-common 2,349 行零单元测试，含手写 semver

- 证据：`packages/extensions-common/src` 无 `__tests__`；`semver.ts` 是手写的 semver satisfies/compare（"Unparseable versions sort as 0.0.0"），extension-host 的 13 个测试文件中无 semver 直接覆盖。
- 影响面：semver 判定直接决定扩展 engine 兼容性与 gallery 版本比较；manifest-schema（zod）是扩展安全边界的入口校验。这是 packages 层最大的测试裸奔点，与 platform（58 个测试文件）反差明显。

### P3-1 platform 吞并了 VSCode 的 workbench 层概念

- 证据：`packages/platform/src/workbench/`（2,104 行）含 editorGroupModel、editorService、editorResolverService、viewRegistry、quickInputService、layoutService、statusbarService 等——上游这些属于 `vs/workbench` 而非 `vs/platform`。
- 影响面：目前这些文件保持 UI-free（契约 + 纯模型），分层未破坏，是**合理简化**。但该目录已是 platform 第三大模块且承载真实逻辑。【推测】随功能增长它会持续膨胀，"platform=内核"的语义被稀释，新人难以判断"服务契约该放 platform/workbench 还是 renderer/services"。

### P3-2 包边界靠自觉，无 lint 护栏

- 证据：`apps/editor/eslint.config.js:18-70` 的 no-restricted-imports 只管 canonicalResourceKey 弃用和 renderer 内部目录规范；没有规则禁止 renderer import electron、main import renderer、packages import apps。
- 影响面：当前实测全部干净，但这是"考出来的干净"不是"锁出来的干净"。

### P3-3 platform 无 sideEffects 声明 + 仅根 barrel 出口，摇树保守

- 证据：`grep sideEffects packages/*/package.json` 无命中；platform exports 只有 `"."`；CommandsRegistry 等是模块级单例（真副作用模块）。
- 影响面：renderer（rollup）有自己的副作用分析，实际影响有限；主要代价在 extension-host bundle 体积。【推测】即使加 sideEffects 也必须把 registry 模块列为例外——这是"模块级单例注册表"架构选择固有的税。

### P3-4 renderer 三处手写 setTimeout debounce，platform 缺通用异步原语

- 证据：`ExtensionsView.tsx:63,88-89`、`useSearchEngine.ts:68,166-167`、`SwarmReviewsView.tsx:151,307-308` 三份同构 debounceRef 模式；`packages/platform/src/base/async.ts` 无 VSCode 的 Delayer/Throttler。
- 影响面：小。属"该沉淀未沉淀"，但规模不足以称病。

### P3-5 幽灵目录 packages/markdown-language-server

- 证据：目录下只有 node_modules，无 package.json，git 未跟踪任何文件。纯卫生问题，但会误导阅读者。

### P3-6 杂项

- workbench-ui 的 react 同时出现在 `dependencies`（package.json:30）与 `peerDependencies`（:45），语义矛盾；workspace + catalog 下无实际双实例，若将来对外发布会出问题。
- workbench-ui 的 43 行 barrel 是手工逐文件列举，没有 platform 那样的 coverage guard 测试。
- e2e-contract 741 行单文件含大量 UI 细节 DTO——app UI 一动就要动"契约包"。这是刻意换取 harness 解耦的代价，事实陈述，不算缺陷。

### 与 VSCode 上游对齐度小结

- **高保真对齐**：DI、Emitter/DisposableStore、CommandsRegistry/MenuRegistry/MenuId、ConfigurationRegistry、LifecyclePhase、URI/ResourceMap、IUndoRedoService、ProxyChannel、extension-api 单文件类型面。
- **合理简化**：单 barrel 出口 + 自动守卫（上游是路径 import + layer checker）；extension host 用 zod 校验的自定义 RPC 而非上游 proxy 协议。
- **可能成为长期负担的偏离**：(a) platform/workbench 混层（P3-1）；(b) wire 类型复制（P2-1，上游用共享 d.ts 单一事实源）；(c)【推测】UI 走 React 而 Monaco 命令式，两套心智模型的接缝已多次出 bug（StrictMode dispose、useRef Emitter、blur 时序），是选型代价，需持续用护栏对冲而非能"修完"。

## ④ 方向性建议

1. **消灭 wire 类型复制，改为 type-only 单一事实源**。extensions/git、extensions/perforce 直接 `import type` 自 extensions-common（devDep 即可），删平行定义；若坚持不引包，至少加编译期 `satisfies`/双向赋值断言测试钉住两侧形状。**本报告性价比最高的一项。**
2. **把 extensions-common 拆成"协议基建"与"领域契约"两层**。rpc/stdioProtocol/manifest/semver/activation 是基建；gitGraph/swarm/perforceGraph/blame/dirtyDiff 是领域 DTO——后者混进"common"使这个包变成只增不减的抓斗。同时给基建层补 semver/manifest-schema 单测。
3. **给 platform/workbench 设增长边界**。短期：CLAUDE.md 写明该目录只收"契约 + 纯模型"，实现留在 renderer/services。中期：若逼近 base/ 体量，拆 `workbench-core` 包。
4. **把已验证的边界固化成 lint 规则**。现状干净是最佳固化时机：renderer 禁 `electron`、main/renderer 互禁、packages 禁 import apps、platform 禁 import 其它 workspace 包。成本一天以内，收益是边界从"实测"变"不变量"。
5. **卫生项**：删 markdown-language-server 残留目录；workbench-ui 去掉 dependencies 里的 react；barrel coverage guard 泛化为可复用测试工具。

**总体判断**：分层意图明确且大体执行到位——platform 零依赖内核是真的，进程边界是真的，workbench-ui 抽取基本完成。主要债务集中在扩展子系统的"契约层"（复制共享 + 零测试），而不是内核分层本身。
