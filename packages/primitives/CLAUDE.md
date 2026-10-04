# packages/primitives/CLAUDE.md

内核与扩展 SDK 共享的**零依赖叶子包**。抽包原因：`platform/src/base/uri.ts` 与 `extension-api/src/uri.ts` 曾逐字重复，两份同时漏掉成段百分号编码（emoji 路径抛 `URIError`）——共享核心后这类 bug 只需修一次。

## 红线：零依赖

- 不得 import node 内置模块（含裸名 `fs`/`path`）、`electron`、任何其它 `@universe-editor/*` 包；`dependencies` 必须为空。
- 原因：内核跑在 renderer（无 node API），扩展代码被 bundle 进扩展产物——它是两端唯一的共同底座，破一次就不成立。
- 守护：`scripts/check-primitives-deps.mjs`（`pnpm primitives-deps:check`，已接入 `pnpm check`）。确属无害巧合时在该行加 `primitives-allow` 注释豁免。
- **devDependencies 只允许出现在 `__tests__/` 下**：要交付出去的 `src/` 连 devDependency 也不许碰（vitest 这类只能在测试里用）。

## 谁能依赖它

`packages/platform`（`workspace:*`）、`packages/extension-api`（`workspace:^`，发布时展开为区间）、`packages/extension-host`（仅 devDependencies，取用例表）。新增第三方依赖方前先问：它是否也「零依赖 + renderer 可用」。答案是否就不要加。

## 边界纪律：只放「同不变量」的东西

包名取宽（`primitives` 而非 `uri`）是为了容纳后续真重复，代价是容易退化成抽屉。准入判据：**该实现被两端以同一不变量消费**。典型反例（都在 `extension-api/src/util.ts`，**不进本包**）：`Disposable` / `EventEmitter` 与内核的 `lifecycle.ts` / `event.ts` 只是同名，WeakMap 结构兼容契约与事件排队语义都不同。

## 两份实现的差异**不是** bug，不要统一

本包只提供**没有立场**的机制，策略留在上层：

| 差异点 | 内核 `URI` | SDK `Uri` | 机制 |
|---|---|---|---|
| `fsPath` | 不判平台：盘符原大小写、始终 `/` | win32 换 `\` + 盘符小写 | `uriToFsPath(uri, {nativeSeparators, lowercaseDriveLetter})`，options **必填无默认值** |
| `toString` | 只有完整编码 | 另有 `skipEncoding` 模式 | `formatUri(uri, encodeComponent)`，编码器作为参数传入 |
| `parse` | 宽松 | 可选 `strict` | 核心返回 `undefined`，**抛错文案留上层** |
| 实例身份 | `with` 无变化返回 `this` | 总是 new | 核心不提供 `with` |
| `$mid` / `revive` / `isUri` | 有 | 无 | 核心里，不进本包 |

**核心不构造任何 `Error`**（错误文案逐字保留是两份差异能保住的分界线），也不提供 `toJSON` / `revive` / `with`。改 `formatUri` 前先读 `testing/uriCases.ts` 的表——`toString()` 是非 `file:` scheme 的资源比较键、workspace storage 分桶键，**输出必须逐字节不变**。

## `./testing` 子路径

`src/testing/{uriCases,pathCases}.ts` 是参数化行为表：纯数据 + 纯类型，四个消费点（本包 / platform / extension-api / extension-host）各自拿它跑自己的实现（uri 表四方都吃，path 表本包 / extension-api / platform 侧另有用例）。放在 `src/testing/` 而非 `__tests__/` 是有意的——后者会被 `files` 的负向模式从 tarball 排掉。新增用例优先加表，别在各层各写一份。

## 隔离/构建注意

- 走 pnpm 隔离 node_modules：任何包（含仅测试用）import 本包必须在**自己的** `package.json` 里声明。
- 本包是 dist 消费包，改完手动 `pnpm --filter @universe-editor/primitives build`（离开 dev 模式时）。
