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

**Ctrl+P 重复行的成因与两处约束**（2026-09 修）：形态分叉来自**源头**——工作区根保留对话框的盘符大小写（`file:///E:/…`），而 Explorer 曾把盘符折成小写，于是同一文件有两串文本；Ctrl+P 若用原始 `uri.toString()` 比较就各占一行（描述还因大小写敏感的 `startsWith` 回落成绝对路径）。收口方式：所有工作区根生产者统一走 `canonicalizeWorkspaceFolderUri`（`packages/platform/src/base/uri.ts` 的 `canonicalizeFileUri` 折盘符**向上**，与 `normalizeFsPath` 同向；折下会让整个 `workspaces/<sha1>.json` 换桶）。**唯一刻意不走 comparison key 的地方**是每击键扫 10 万条清单的 `FileQuickAccessProvider.scanPool`，它按 `entry.relPath` 建 `Set`（清单本身即 `URI.joinPath(root, relPath)`）；小集合（打开编辑器/视图/recent/最终发布行）一律走 `getComparisonKey`，**别把原始 URI 串比较请回来**。

**同源异层的姊妹问题**：编辑器身份（`EditorInput.id`/`matches`）碰撞见 [[editor-input-identity-isolation]]——同一思路不同层。
