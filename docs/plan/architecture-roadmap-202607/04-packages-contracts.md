# 04 · packages 契约层

> 依据：[02-packages-layering.md](../architecture-review-202607/02-packages-layering.md) P2-1/P2-2/P3-2 + 卫生项。
> 批次：任务 1/2/3 第二批（P2）；卫生项见末尾。
> 总体判断（承接报告）：内核分层本身健康（platform 零依赖是真的、进程边界是真的），债务集中在**扩展子系统的契约层**。

## 任务 1：wire DTO 单一事实源 ✅（P2，第二批，预估 0.5 天；报告评"性价比最高"）

> 已完成（2026-07-21）。落地：
> - **git 扩展**：加 `extensions-common` devDep；`gitGraphSource.ts` 的 12 个本地 interface + `blameSource.ts` 的 2 个 → `import type` 别名（`export type GitGraphTag = GitGraphTagDto` …），保留 `Dto`-less 本地名，扩展内 ~20 处引用零改动；`GitGraphLoadOptions` 别名为 `Dto & { workspaceRoot? }`（host-only 字段不过线）；`GitGraphFileDiffContent` 为 git 独有非共享 DTO，保留本地声明。
> - **perforce 扩展**：加 devDep；`swarm/swarmParser.ts` 8 个类型 → `import type` 别名（`SwarmReviewDetail` = `Omit<SwarmReviewDetailDto, 'transitions'>`，parser 不产出 transitions）；`extension.ts` 的 perforce-graph 三处内联字面量加 `satisfies P4Graph*Dto` 锁形状。
> - **命令 id 常量的坑**：`SwarmCommands` 是**值**，经 barrel import 会被 esbuild 连 platform 一起拉进 bundle（实测 247→432KB、`createDecorator` 0→44，因 `export *` 无法 tree-shake 到 platform-dep 的 rpc.ts）。故命令 id 保留本地字面量 + 加**类型级漂移守卫**：`type _Assert = SwarmCommandId extends (typeof Cmd)[keyof typeof Cmd] ? true : never`，wire id 改名/新增即 typecheck 红，零运行时。
> - **破坏性验证**：改 common 里 `GitGraphCommitDto` 字段名 → git typecheck 红（6 err）；改 `SwarmCommands` 一个 wire id 值 → perforce 守卫 TS2322 红；恢复后绿。bundle 尺寸/`createDecorator` 计数不变（git 149.7KB、perforce 247.5KB，均 0 platform 泄漏）。
> - 两侧 "keeps a local copy" 注释替换为"单源在 extensions-common"的指向。`pnpm check` 全绿。

**背景**：`extensions-common/src/gitGraph.ts:2-9` 注释自述 git 扩展持有本地副本"避免 bundling"；平行副本在 `extensions/git/src/gitGraphSource.ts:20-45`；swarm.ts 同样声明 perforce 扩展持副本。但 `import type` 在 esbuild 下零成本，复制的理由不成立——renderer 与扩展间的 JSON 契约靠人肉对齐，两头无守卫。

**步骤**：

1. extensions/git、extensions/perforce 加 `extensions-common` 为 devDependency，wire 形状全部改为 `import type` 自 extensions-common，删平行定义。
2. 确认 esbuild 产物不变（`import type` 零运行时引入；build 后 diff bundle 或跑现有 e2e 套件）。
3. 删除两侧 "keeps a local copy" 注释，替换为"单一事实源在 extensions-common"的指向。

**验证**：`pnpm check` + git/perforce 相关 e2e 套件。契约字段改名时，扩展侧编译立即红（这就是此项的全部意义）。

## 任务 2：extensions-common 拆层 + 补测 ✅（P2，第二批）

> 已完成（2026-07-21）。落地：
> - **拆层（保留 barrel 零破坏）**：`src/` 下 9 个基建文件 `git mv` 进 `protocol/`（rpc/stdioProtocol/manifest/manifest-schema/semver/activation/webviewProtocol/bytes/categories），7 个领域 DTO 进 `contracts/`（gitGraph/swarm/perforceGraph/scmWire/blame/dirtyDiff/aiWire）；各组加 barrel `index.ts`，根 `index.ts` 改 `export * from './protocol/index.js' + './contracts/index.js'`。内部 sibling import 均同组，路径不变。**119 处消费方主入口 import 零改动**（实测 extension-host/git/perforce typecheck 全绿）。
> - **manifest-schema 子路径**：`package.json` exports 的 `./manifest-schema` dist 路径改 `dist/protocol/manifest-schema.*`（3 处消费方子路径 import 不变）；zod 隔离保持（不入 barrel）。
> - **补测**：加 `vitest.config.ts` + `test` 脚本 + vitest devDep。新增 6 个测试文件共 **54 例**（从 0）：`semver`（satisfies 全分支：exact/partial/wildcard/caret 0.x/tilde/AND/fail-closed + compareVersions 边界，19 例）、`manifest-schema`（合法/必填缺失/activation typo/untrustedWorkspaces 三形态/passthrough，13 例）、`activation`（9）、`bytes` round-trip（含跨 0x8000 chunk，4）、`webviewProtocol`（percent-encode/backslash 归一，4）、`stdioProtocol`（分帧/粘包/空帧/双协议往返，5）。
> - 领域 DTO 层无逻辑，由任务 1 编译期约束守卫，不强求测试。`pnpm check` 全绿，turbo 自动纳入该包 lint/test/typecheck/build。

**背景**：extensions-common 2,349 行 **0 测试**，混装两类东西：协议基建（rpc/stdioProtocol/manifest/semver/activation）与领域 wire DTO（gitGraph/swarm/perforceGraph/blame/dirtyDiff）。手写 semver 直接决定扩展 engine 兼容性与 gallery 版本比较；manifest zod schema 是扩展安全边界的入口校验——packages 层最大的测试裸奔点。

**步骤**：

1. 包内目录分层（不必拆包）：`src/protocol/`（基建）与 `src/contracts/`（领域 DTO），barrel 分组导出；消费方 import 路径不变或一次性机械替换。
2. 基建层补单测（优先级从高到低）：
   - `semver.ts`：satisfies/compare 全分支 + "Unparseable versions sort as 0.0.0" 边界 + 预发布/区间语法；
   - manifest zod schema：合法/非法 manifest 样例（重点：engines 缺省、capabilities.untrustedWorkspaces 形态）；
   - rpc/stdioProtocol：分帧编解码往返。
3. 领域 DTO 层无逻辑不强求测试，由任务 1 的编译期约束守卫。

**验收**：extensions-common 测试文件从 0 到覆盖三块基建；semver 行为被钉住。

## 任务 3：包边界固化为 lint ✅（P2，第二批，预估 0.5 天）

> 已完成（2026-07-21）。落地：
> - **拓扑**：`apps/editor` 有自己的 eslint.config.js；`packages/*` + `extensions/*` 全部落根 `eslint.config.js`。故 packages→apps + platform→workspace 两条边界加在**根配置**，renderer→electron/main + main→renderer 两条加在 **apps/editor 配置**。
> - **flat config 替换非合并的坑**：`config-eslint/index.js` 新增 `export { pathIdentityRestrictedImports }`；所有重定义 `no-restricted-imports` 的块（根 packages 块、platform 块、两个 renderer 块）都把该 paths 折回，避免静默丢掉 canonicalResourceKey 守卫（已单测验证守卫仍生效）。
> - **四条规则**：① `packages/**`+`extensions/**` 禁 import `apps/**` 与 `@universe-editor/editor`；② `platform/src/**` 禁 import 任何 `@universe-editor/*` 与 apps；③ `renderer/**` 禁 `electron`/`electron/*` 与 `**/main/**`；④ `main/**` 禁 `**/renderer/**`。preload（合法用 electron）与 shared/（两进程共享）不在受限 files 域内，自然豁免；坚持 import 语句级 `no-restricted-imports`（不用字符串 no-restricted-syntax），不误伤注释里的 apps 路径。
> - **破坏性验证**：四条各埋一个 probe import → lint 全部红并给出对应中文/英文 message；probe 删除后 `pnpm -r lint` 零违例。`pnpm check` 全绿。四条边界从"实测干净"升为 lint 不变量。

**背景**：包边界现状实测零违例，但这是"考出来的干净"不是"锁出来的干净"（`apps/editor/eslint.config.js:18-70` 现有 no-restricted-imports 不管进程/包边界）。趁干净锁死是最佳时机。

**步骤**：

1. 加 no-restricted-imports / no-restricted-syntax 规则（放 `packages/config-eslint`，按目录 override 生效）：
   - renderer 源码禁 `electron`（含 `electron/*`）；
   - `src/main/**` 与 `src/renderer/**` 互禁 import（shared 除外）；
   - `packages/**` 禁 import `apps/**`；
   - platform 禁 import 其它 workspace 包（保持零依赖内核语义）。
2. 参考既有护栏经验（memory `eslint-path-identity-guardrails`）：flat config 同名规则是**替换**不是合并，注意与现有 no-restricted-imports 的合并方式；测试目录按需豁免。
3. 跑全仓 lint 确认零违例即落地（若发现违例——那正说明该规则该加）。

**验收**：四条边界从"实测干净"变为 lint 不变量。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ 删 `packages/markdown-language-server` 幽灵目录（只剩 node_modules，git 未跟踪）。
- ⬜ workbench-ui 去掉 `dependencies` 里的 react（保留 peer + devDep，`package.json:30` vs `:45` 语义矛盾）；peerDependencies 的 `^19.0.0` 硬编码顺手核对与 catalog 一致。
- ⬜ platform 的 barrel coverage guard（`index.test.ts:95`）泛化为可复用测试工具，给 workbench-ui（43 行手工 barrel）/ extensions-common 共用。
- ⬜ `platform/workbench` 目录（2,104 行）设增长边界：`packages/platform/CLAUDE.md` 写明该目录只收"契约 + 纯模型"，实现留在 renderer/services；逼近 base/ 体量（6.7k）时再评估拆 `workbench-core` 包。
- ⬜ platform base/async 补 Delayer/Throttler 通用原语，收编 renderer 三处手写 setTimeout debounce（`ExtensionsView.tsx:63` / `useSearchEngine.ts:68` / `SwarmReviewsView.tsx:151`）。
