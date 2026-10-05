# cases-language-service.md

本文从 `workbench/markdown/CLAUDE.md` 拆出，范围是**线①语言特性**的一个隐蔽 bug 复盘：移动被引用文件后语言服务残留旧路径诊断。改 `extensions/markdown/src/server/*` 或 `MarkdownUpdateLinksOnRenameContribution` 前通读。

## 症状与根因

「移动文件自动更新链接」：A 引用 B，B 被移动（A 关闭），bulk edit 正确改写了 A 的磁盘链接，但重新打开 A 时语言服务仍警告旧 B 路径 `file does not exist`。三层叠加：

- `vscode-markdown-languageservice` 的 `MdDocumentInfoCache`（linkProvider 的**按文档**缓存）只监听 `onDidChangeMarkdownDocument` + `onDidDeleteMarkdownDocument`，**不听 create**（对比 `MdWorkspaceInfoCache` 三个都听）。
- 我们的 `LspWorkspace` **没有文件系统监听**——缺 VSCode 的 `watchFile`，`createPullDiagnosticsManager` 因此走不通，用的是裸 `DiagnosticComputer.compute`。
- bulk edit 对**关闭的文件**直接磁盘读写，不触发任何 `$did*` 文档事件 → 语言服务永远不知道 A 的磁盘内容变了 → 复用陈旧的链接解析结果。`DocumentStore.close()` 也不 fire delete；`open()` 对不在 store 的文件 fire create（缓存不听）。

> 同类教训（别批）：「事件语义不匹配导致缓存/去重错乱」也见于 `editor-input-identity-isolation`。

## 修复链路（补偿缺失的 watchFile）

`IMdServer.$didChangeFiles(uris)`：对每个**未在 overlay 打开**的 URI 读盘——存在则 `store.notifyDiskChange`（fire onDidChange，失效按文档缓存），不存在则 `store.notifyDiskDelete`（fire onDidDelete）；**open 文件跳过**（overlay 是权威）。

锚：`extensions/markdown/src/server/types.ts:76`（接口）、`server/mdServer.ts:149`（实现）、`server/documentStore.ts:57/61`（notifyDiskChange / notifyDiskDelete）、`edit/commands.ts:33`（命令名 `markdown.didChangeFiles`）、`extension.ts:93`（注册进插件）、`apps/editor/src/renderer/contributions/MarkdownUpdateLinksOnRenameContribution.ts:245`（bulk edit 成功后调用）。**通知集 = 被编辑文件 + 所有 rename 的 old/new URI**——新路径一侧同样要通知，否则换个方向的陈旧缓存照样残留。

## 复现与回归资产

- **精确路径才触发，泛泛复现必失败**：必须 A **曾打开过**（已填充按文档缓存）→ 关闭 → 移动 B → 重开 A，三个条件缺一不可。
- 服务层：`extensions/markdown/src/server/__tests__/mdServer.test.ts` 的 `$didChangeFiles refreshes stale caches`。
- E2E：`extensions/markdown/e2e/specs/markdownMoveStaleDiagnostic.spec.ts`。

## 红线

任何「绕过编辑器直接改磁盘文件」的操作（bulk edit、外部工具、SCM checkout…）只要影响 markdown 链接图，都必须经 `$didChangeFiles` 通知语言服务，否则诊断陈旧。根治是给 `LspWorkspace` 实现真正的 `watchFile`（届时可撤掉这层主动通知）；当前用主动通知补偿。
