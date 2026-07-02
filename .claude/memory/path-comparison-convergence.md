---
name: path-comparison-convergence
description: 路径/URI 比较根治方案——IUriIdentityService 单一入口 + 内核纯函数 + ESLint 护栏，替代四套散乱手写机制
metadata: 
  node_type: memory
  type: project
  originSessionId: 18ef86fa-63d0-4b47-8b18-5dfe4d6a3fe3
---

路径比较此前"混乱随意"（4 套并存机制，`isEqualResource`/`canonicalResourceKey` 只折盘符、与平台感知的 `arePathsEqual` 冲突），已导致编辑器去重/history/model/search 把同一文件当两个的 bug。2026-07 做了全面收敛。

**分层架构**（`packages/platform/src/`）：
- `base/path.ts`：字符串路径纯函数 `normalizeFsPath` / `isCaseInsensitive`（大小写策略单一真相：win32/darwin 折叠，linux 敏感）/ `arePathsEqual` / `relativePathUnder` / `getPathComparisonKey`（字符串路径的 map 键，保留 `__ESCAPED__` 不塌陷）。
- `base/uri.ts`：URI 纯函数 `getResourceComparisonKey` / `isEqualResource` / `isEqualOrParentResource`（都带 `platform` 参数）。**关键修复**：file: scheme 的 key 不再走 `fsPath`（authority-only 如 `file://a`/`file://b` 的 fsPath 为空会碰撞），改为 `pathWithoutAuthority` + 单独保留 authority。
- `base/resourceMap.ts`：`ResourceMap`/`ResourceSet`，注入 keyFn，与上面同源。
- `uriIdentity/uriIdentityService.ts`：`IUriIdentityService`（DI 装饰器 + `UriIdentityService` 类），构造只吃一次 `platform`，方法 `isEqual`/`isEqualOrParent`/`getComparisonKey`/`arePathsEqual`/`getPathComparisonKey`/`relativePathUnder`/`createResourceMap`/`createResourceSet` 全委托内核。**必须在 `platform/src/index.ts` re-export**。

**消费惯例**：
- renderer：React 用 `useService(IUriIdentityService)`；Action2 用 `accessor.get(IUriIdentityService)`；服务类 `@IUriIdentityService` 注入。**不再手动传 platform**。`main.tsx` 里 `services.set(IUriIdentityService, new UriIdentityService(platform))`。
- main 进程无 DI 容器，直接调内核纯函数 + `normalizePlatform(process.platform)` 收窄类型（Node 的 `Platform` ≠ 项目 `HostPlatform`）。已收敛：`main/index.ts`、`windowMainService.ts`（restoreSession 文件路由改 `isEqualOrParentResource`，顺带修好无边界 startsWith bug）、`fileSearchMainService.ts`(去重键)、`fileWatcherMainService.ts`(`isUnder` 改 `relativePathUnder`)。
- `acpClientService.ts` 的 `_poolKey`：连接池键改用 `getPathComparisonKey`，保留 `\0`（NUL）分隔符——**那是设计不是 bug**（agentId/路径里不可能出现 NUL）。注意该文件含 NUL 字节，Read/Grep 会报 binary，Edit 精确匹配含 NUL 行会失败，改动用 sed 按 ASCII 子串替换。

**刻意保留的独立身份域**（不接 IUriIdentityService，各带说明）：
- `MonacoModelRegistry.monacoModelKey`：只折盘符，匹配 Monaco 内部模型表（Batch 1）。
- SCM 域键 `scmPathKey`(ScmDecorationsService) / ScmView 的 `pathKey`：自洽闭环键，带 `// eslint-disable-next-line no-restricted-syntax`。理论上 linux 大小写有隐患，要修就集中在这两处。
- `acpPathPolicy.ts`：安全边界纯函数，`_env.platform` 自持。
- `markdownPasteLinks.ts`/`markdownLinkProviderShared.ts`：header 声明 DI-free 可单测，platform 走 ctx 携带；DI 组装点（Markdown{Paste,Drop}Contribution）已改注 IUriIdentityService。
- `vendor/codex-acp`、`vendor/claude-agent-acp`：submodule 不在 workspace，不碰。

**ESLint 护栏**（`packages/config-eslint/index.js`，见 [[eslint-path-identity-guardrails]]）防回潮。

已删除标识符：`canonicalResourceKey`（彻底删，import 会 TS 报错 + no-restricted-imports 拦）。`isEqualResource` 仍在但签名变了（现在必带 platform）。

**同源异层的姊妹问题**：编辑器身份（`EditorInput.id`/`matches`）碰撞见 [[editor-input-identity-isolation]]——那个治"同一文件多视图被去重成一个 tab"，与这里治"文件系统身份键碰撞"是同一思路的不同层。
