---
name: extension-api-09-surface-expansion
description: extension-api 0.9.0 对标 vscode.d.ts 大幅补全 API 面的实施要点与版本联动清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 6cea3abf-b6c0-45ae-ab33-f9bffaf42c4d
  modified: 2026-08-11T17:47:42.465Z
---

extension-api 0.8.0→0.9.0（2026-08-12）：对标 vscode.d.ts 补全对外 API，四批实施。工具类
（Disposable class 化/EventEmitter/CancellationTokenSource/Uri）+ 新 namespace env、extensions +
commands.getCommands + window（withProgress/setStatusBarMessage/文件对话框/showTextDocument/
选区事件）+ workspace（openTextDocument/workspaceFolders/findFiles/onDidSave/applyEdit/
onDidChangeConfiguration/createFileSystemWatcher/fs.rename+copy）+ languages（getLanguages +
rangeFormatting/onTypeFormatting/inlayHints，18→21 类 provider）。新 RPC 通道仅 extHostWindow、
extHostFileEvents/mainThreadFileEvents，其余全挂现有通道。

**Why:** 外部插件开发开放前 API 面不足；变更全记录在 packages/extension-api/COMPATIBILITY.md 0.9.0 条目（含全部限制项）。

**How to apply:**
- **bump extension-api 版本必须五处联动**：extension-api 的 index.ts version 常量 + package.json、
  `packages/uex/src/lib/sdkVersion.ts` 的 CURRENT_API_VERSION、`packages/create-extension/src/sdkVersions.ts`、
  `samples/hello-world/package.json`（engines+devDep，CI drift check 要求与 scaffold 字节一致）。前两处有守卫测试锁定。
- openTextDocument 走模型级同步（MonacoModelRegistry.acquire + DocumentMirrorTracking 挂进
  DocumentSyncContribution 管线），与编辑器打开的文档在 host 同构；ref 有意驻留不释放。
- 文件事件按兴趣订阅：host 首个 watcher $subscribeFileEvents、末个 dispose 退订，无 watcher 零 RPC（防洪泛 OOM）；
  glob→RegExp 共享工具在 `packages/extensions-common/src/glob/`（findFiles 与 watcher 共用）。
- 已知限制（升级时的候选）：对话框单选无过滤（等 IFileDialogService）、applyEdit 仅文本编辑、
  onDidSave 仅 FileEditorInput 路径、inlay hints 无 resolve、TreeView/createWebviewPanel/
  visibleTextEditors/diagnostics 读取未做。
- 相关 [[extension-system-progress]] [[third-party-extension-ecosystem-plan]]
