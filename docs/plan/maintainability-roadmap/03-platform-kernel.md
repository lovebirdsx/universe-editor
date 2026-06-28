# 计划 03 · platform 内核

> 配套总览：[README.md](./README.md)
> 范围：`packages/platform/src/`（约 16000 行，109 源文件，49 测试）+ `apps/editor/src/shared/`
> 主轴：**去手工约定（re-export）** + **注册表健壮性（重复 ID）** + **关键内核补测试**。

> platform 大量抄自 VSCode 且经过验证（DI / Event / observable / URI / IPC）。除"补测试"外，**核心算法不轻易动**。

---

## 现状肯定

- DI（`instantiation.ts` / `graph.ts`）：环检测、lazy 实例化、parent 委托完整。
- Event（`event.ts`）：`once`/`map`/`filter`/`debounce` 组合子齐全，`PauseableEmitter` 批处理到位。
- Lifecycle 相位划分清晰；URI 抽象完善；IPC 的 JSON+Uint8Array 混合序列化处理周密。
- 类型安全好：生产代码 `as unknown as` 极少（最多的 `lifecycle.ts` 也仅 6 处底层体操）。

---

## P1 · index.ts re-export 是脆弱的手工约定

### 问题
"所有对外符号必须手动在 `src/index.ts` 加 `export * from`，否则 apps 编译失败"是 CLAUDE.md 强约束。新增/移动文件忘记加，错误只在 apps 侧以"找不到名字"出现，浪费排查。

### 证据
`packages/platform/src/index.ts` 是一长串逐文件 `export * from './xxx/yyy.js'`；CLAUDE.md 顶部红字强约束。

### 影响
高频踩坑点（尤其新人 / 跨分支 merge）；export 列表易与实际文件漂移。

### 落地步骤
- 改为**分组 barrel**：每个子目录建 `index.ts`（`base/index.ts`、`command/index.ts`…），根 `index.ts` 只 re-export 各组 barrel。
- 新增文件只需在**所在组**的 barrel 加一行，心智负担从"全局唯一大文件"降到"就近一行"。
- 可选：加一个 lint/test 脚本扫描"导出了但未被任何 barrel 收纳"的文件，CI 兜底。

### 验证
`pnpm --filter @universe-editor/platform build` + apps typecheck 通过；故意漏收一个文件，CI 脚本能报。

---

## P1 · CommandsRegistry / MenuRegistry 重复 ID 静默覆盖

### 问题
命令注册用 LinkedList 栈、newest-first，**重复 ID 直接覆盖且无任何告警**。多个贡献者（含未来扩展）注册同名命令时，后者悄悄盖掉前者，用户看不到、无法诊断。

### 证据
`packages/platform/src/command/commandRegistry.ts:58-92`：`registerCommand` 对已存在 id 直接 `list.unshift(cmd)`，无重复检测。`menuRegistry.ts` 插入菜单树同样无唯一性约束。

### 影响
当前内置命令冲突少，但这是扩展生态规模化后的概率性 bug，且静默——属潜在正确性债（与 `docs/report/bridge-tech-debt-assessment.md` 的 D1 同源）。

### 落地步骤
- `registerCommand` 在 id 已存在时 `logger.warn(duplicate command id)`（保留覆盖语义以兼容 VSCode 的 override 用法，但让它可见）。
- 可选：提供 `registerCommand(..., { allowOverride: true })` 显式声明意图，未声明而覆盖则 warn。
- 在 contribution 加载完成后做一次性扫描，汇总报告重复 id（dev 模式）。

### 验证
单测：重复注册触发 warn；override 选项抑制 warn；dispose 后回退到前一个 handler。

---

## P1 · 关键内核逻辑缺测试

### 问题
若干承载核心行为的模块无单测，重构无安全网。

### 证据（无对应 `__tests__` 的关键模块）
```
workbench/editorGroupModel.ts   编辑器组（open/close/preview/active 状态机）
workbench/editorService.ts      编辑器生命周期
configuration/configurationService.ts  配置层合并/优先级
base/observable/observables/derivedImpl.ts  / autorunImpl.ts  observable 计算引擎
```

### 影响
editor group 与 configuration 是高频改动核心；observable 引擎一旦回归影响全局响应式。

### 落地步骤（按 ROI 补，每个先 30-50 行）
1. `editorGroupModel.test.ts`：open / close / preview 替换 / active 切换 / pinned 边界。
2. `configurationService.test.ts`：default→user→workspace→memory 层合并与优先级、update 通知。
3. `derivedImpl.test.ts`：observer 热插拔、依赖变更传播、（顺带验证 P2 环检测行为）。

### 验证
`pnpm --filter @universe-editor/platform test`。

---

## P2 · observable 环检测默认关闭

### 问题
`derived.get()` 的环依赖检测被 `checkEnabled = false` 关闭，环依赖会在运行时崩而非提前报。

### 证据
`base/observable/observables/derivedImpl.ts:134-139`：
```ts
const checkEnabled = false // TODO set to true
if (this._isComputing && checkEnabled) {
  // investigate why this fails in the diff editor!
  throw new BugIndicatingError('Cyclic deriveds are not supported yet!')
}
```

### 重要背景
这段**与 VSCode 上游逐字一致**（连"diff editor"注释都一样），上游同样默认关闭。**不是本仓库引入的缺陷**，故列 P2。

### 落地步骤
- 不建议简单翻 `true`（上游关着是有原因的——某些合法场景会误报）。
- 替代：在 **dev 模式**加一个**非抛错的环检测告警**（检测到 `_isComputing` 重入时 `console.warn` + 打印依赖链），既能暴露问题又不破坏现有合法路径。
- 配合 P1 的 `derivedImpl.test.ts` 固化预期行为。

### 验证
dev 模式构造环依赖能看到 warn；release 无影响；现有测试不回归。

---

## P2 · 顺手清理

- **shared/perf marks 覆盖**：见计划 06（启动打点细化）。
- **configuration target 优先级靠 enum 数值顺序**（`configurationService.ts` 的 `ConfigurationTarget` enum）：改 enum 顺序会静默破坏优先级。低危，可加注释锁定或改显式 priority 字段——非必要不动。

---

## 任务依赖与建议顺序

```
P1 补测试（editorGroupModel / configurationService）── 独立、先做，为后续改动兜底
P1 重复 ID 告警（独立、小）
P1 index barrel 化（独立，但改动面广，挑低峰期做）
P2 observable dev 环告警（依赖 derivedImpl 测试先就位）
```

建议先补 editorGroupModel / configurationService 测试（其他计划的重构会碰这些），再做重复 ID 告警与 barrel 化。
