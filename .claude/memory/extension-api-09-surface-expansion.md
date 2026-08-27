---
name: extension-api-09-surface-expansion
description: extension-api 0.9.0→0.12.0 对标 vscode.d.ts 补全 API 面的实施要点与版本联动清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 6cea3abf-b6c0-45ae-ab33-f9bffaf42c4d
  modified: 2026-08-12T00:00:00.000Z
---

extension-api 0.8.0→0.9.0→0.12.0（2026-08-12）：对标 vscode.d.ts 分四个 minor 补全 API 面。
0.9.0=工具类 class 化 + env/extensions namespace + window/workspace/languages 大批方法（18→21 类
provider）。0.10.0（parity 计划 P1+P2）=解除 0.9.0 降级限制（对话框多选/filters、applyEdit 文件级
操作、onDidSave 覆盖 Untitled/另存为/Merge、findFiles 真取消+RelativePattern、watcher 工作区外监听、
openTextDocument untitled/content 重载+isUntitled）+ 新面（getDiagnostics/onDidChangeDiagnostics
全源诊断、visibleTextEditors、inlay hints resolve、env.machineId/appRoot）。0.11.0（P3）=
window.createWebviewPanel（host 负数 handle 空间与 renderer 非负 custom-editor handle 共存；无
ViewColumn/serializer；iframe 不重建故隐藏期状态天然保留）。0.12.0（P4）=Tree View（contributes.
viewsContainers/views + registerTreeDataProvider/createTreeView，见 [[tree-view-feature]]）。
上述 parity 计划已全部执行完毕（仅 P1.5 Command 归因按计划
留待真实诉求）。

**Why:** 外部插件开发开放前 API 面不足；各版变更与限制全记录在 packages/extension-api/COMPATIBILITY.md 对应条目。

**How to apply:**
- **bump extension-api 版本**：uex/create-extension 内嵌的版本常量已是生成物（`pnpm ext-packages:gen`，
  发布 preflight 自动再生成，勿手改），仍须手动联动的只剩 extension-api 自己的 index.ts version 常量 +
  package.json；bump 后 uex 与 create-extension 须一并 bump 版本同发，publish 的耦合检查
  （SDK_VERSION_COUPLINGS）会强制拦截漏发。示例仓库 `universe-editor-extension-samples` 侧由其
  `check-sdk-drift.mjs` 兜底。
- openTextDocument 走模型级同步（MonacoModelRegistry.acquire + DocumentMirrorTracking 挂进
  DocumentSyncContribution 管线），与编辑器打开的文档在 host 同构；ref 有意驻留不释放。untitled 也进镜像，
  save-as 语义 close(untitled)→open(file)→didSave(file)，didSave 经 whenOpened 门控保证排在镜像 open 后。
- 事件推送两护栏（洪泛前科）：兴趣订阅（首个监听者 $subscribe、末个退订，无监听零 RPC——文件事件/诊断/树视图同模式）
  + 防抖合并（诊断 50ms、可见编辑器 microtask）。
- 可选 wire 参数 undefined 过 newline-JSON 变 null：调用点省略参数、接收端 `== null` 判"未传"。
- 剩余候选（COMPATIBILITY 各版限制节）：TreeView reveal/dnd/checkbox、webview serializer/ViewColumn、
  views 的 when 门控、onDidCreate/Delete/RenameFiles、getDiagnostics 同步语义。
- 相关 [[extension-system-progress]] [[third-party-extension-ecosystem-plan]] [[tree-view-feature]]
