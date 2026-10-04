# @universe-editor/primitives

编辑器内核与扩展 SDK 共用的**零依赖基础件**：URI 编解码与规范形状、纯文本路径助手。

抽出来的理由是这两份实现曾经逐字重复（内核 `packages/platform/src/base/uri.ts` 与 SDK `packages/extension-api/src/uri.ts`），而重复的代价是真实的——两份**同时**漏掉成段百分号编码，任何 emoji / 增补平面路径都会抛 `URIError`。现在它们共享同一份核心，差异（`$mid` 标记、`strict` 解析、`fsPath` 平台策略等）留在各自上层。

## 零依赖不变量

本包**不得** import node 内置模块、`electron`、或任何其它 `@universe-editor/*` 包，`dependencies` 必须为空。原因是它要被**两端同时消费**：内核跑在 renderer（没有 node API），扩展代码被 bundle 进扩展产物。这条不变量由 `scripts/check-primitives-deps.mjs` 机械守护（`pnpm primitives-deps:check`，已接入 `pnpm check`）。

## 内部包，无稳定性承诺

> ⚠️ 本包不是给扩展作者直接使用的 API。它随 `@universe-editor/extension-api` 一起安装，**可以随时做破坏性变更**（任意版本、不提前通知、不保证 semver 语义）。请依赖 `@universe-editor/extension-api`，不要直接依赖本包。

## 使用

```ts
import { encodeURIComponentFast, parseUriComponents } from '@universe-editor/primitives'
```

| 导出面 | 内容 |
|---|---|
| `.` | URI 编解码族 + 路径助手（`parseUriComponents` / `formatUri` / `uriToFsPath` …，见 `dist/*.d.ts`） |
| `./testing` | 参数化行为用例表，供仓库内各层的测试消费（`PARSE_CASES` / `FORMAT_CASES` / `FS_PATH_CASES` …） |

`./testing` 是给本仓库四个消费点（primitives / platform / extension-api / extension-host）做差分回归用的，不是 API 面。

## 相关包

- [`@universe-editor/extension-api`](https://www.npmjs.com/package/@universe-editor/extension-api) — 扩展 API 面，依赖本包

## License

Apache-2.0
