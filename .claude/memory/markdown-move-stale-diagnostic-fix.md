---
name: markdown-move-stale-diagnostic-fix
description: markdown 移动被引用文件后语言服务残留旧路径诊断的根因与修复($didChangeFiles 补偿缺失的 watchFile)
metadata: 
  node_type: memory
  type: project
  originSessionId: dbb45f76-b2a6-460a-8601-1a898ecc5b79
---

markdown "移动文件自动更新链接" 功能有隐蔽 bug:A 引用 B,B 被移动(A 关闭),bulk edit 正确改写 A 磁盘链接,但重新打开 A 时语言服务仍警告旧 B 路径 "file does not exist"。

**根因**：`vscode-markdown-languageservice` 的 `MdDocumentInfoCache`（linkProvider 的按文档缓存）只监听 `onDidChangeMarkdownDocument` + `onDidDeleteMarkdownDocument`，**不监听 create**（对比 `MdWorkspaceInfoCache` 三个都听）。而我们的 `LspWorkspace` 没有文件系统监听（缺 VSCode 的 `watchFile`，`createPullDiagnosticsManager` 因此走不通，用的是裸 `DiagnosticComputer.compute`）。bulk edit 对**关闭的文件**直接磁盘读写，不触发任何 `$did*` 文档事件 → 语言服务永远不知道 A 磁盘内容变了 → 缓存残留旧链接解析结果。`DocumentStore.close()` 也不 fire delete、`open()` 对不在 store 的文件 fire create（缓存不听）→ 陈旧解析被复用。

**修复（根因层，补偿缺失的 watchFile）**：新增 `IMdServer.$didChangeFiles(uris)` → 对每个未在 overlay 打开的 URI 读磁盘：存在则 `store.notifyDiskChange`（fire onDidChange 失效按文档缓存），不存在则 `store.notifyDiskDelete`（fire onDidDelete）。open 文件跳过（overlay 是权威）。链路：extension 注册 `markdown.didChangeFiles` command → `MarkdownUpdateLinksOnRenameContribution` 在 bulk edit 成功后调用，通知集合 = 被编辑文件 + 所有 rename 的 old/new URI。

复现要点（多次泛泛复现失败,精确路径才触发）：必须 A **曾打开过**（填充按文档缓存）再关闭,B 移动,再重开 A。服务层回归见 `mdServer.test.ts` 的 `$didChangeFiles refreshes stale caches`；E2E 见 `smoke.markdownMoveStaleDiagnostic.spec.ts`。

**How to apply**：任何"绕过编辑器直接改磁盘文件"的操作（bulk edit、外部工具、SCM checkout 等）若影响 markdown 链接图,都要通过 `$didChangeFiles` 通知语言服务,否则诊断会陈旧。根治办法是给 `LspWorkspace` 实现真正的 `watchFile`,但当前用主动通知补偿。相关：[[editor-input-identity-isolation]] 同样是"事件语义不匹配导致缓存/去重错乱"一类。
