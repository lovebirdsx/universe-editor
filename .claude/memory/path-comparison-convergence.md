---
name: path-comparison-convergence
description: 路径/URI 比较根治方案——IUriIdentityService 单一入口 + 内核纯函数 + ESLint 护栏，替代四套散乱手写机制
metadata: 
  node_type: memory
  type: project
---

路径比较有**单一入口 `IUriIdentityService`**（`packages/platform/src/uriIdentity/`，消费端经 DI 拿，不再手写比较、不手动传 platform）；内核纯函数在 `base/path.ts` / `base/uri.ts` / `base/resourceMap.ts`（main 进程无 DI 容器，直接调纯函数 + `normalizePlatform(process.platform)`）。新增比较逻辑前一律先查它有没有现成方法。

**工程坑**：`acpClientService.ts` 的 `_poolKey` 用 `\0`（NUL）作分隔符是**设计**（agentId/路径里不可能出现 NUL）——该文件含 NUL 字节，Read/Grep 会报 binary，Edit 精确匹配含 NUL 行会失败，改动用 sed 按 ASCII 子串替换。

**刻意保留的独立身份域**（不接 IUriIdentityService，勿「顺手统一」）：`MonacoModelRegistry.monacoModelKey`（匹配 Monaco 内部模型表）、SCM 域键 `scmPathKey`/`pathKey`（自洽闭环）、`acpPathPolicy.ts`（安全边界自持 platform）、`markdownPasteLinks` 等 DI-free 可单测文件（platform 走 ctx）、两个 vendor submodule。

防回潮靠 ESLint 护栏（禁手写 fsPath 折叠/路径身份键），见 [[eslint-path-identity-guardrails]]。已删除的 `canonicalResourceKey` 由 no-restricted-imports 拦截；`isEqualResource` 签名已变（必带 platform）。

**同源异层的姊妹问题**：编辑器身份（`EditorInput.id`/`matches`）碰撞见 [[editor-input-identity-isolation]]——同一思路不同层。
