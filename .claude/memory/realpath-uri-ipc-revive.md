---
name: realpath-uri-ipc-revive
description: markdownLsp/peekNavigation @p1 真回归根因：IFileService.realpath 返回的 URI 跨 ProxyChannel IPC 后降级成普通 UriComponents，.fsPath 为空，MainThreadFs guard 误判 empty path 拒读未打开文件
metadata: 
  node_type: memory
  type: project
  originSessionId: 30b4592d-181c-485e-8740-8ffead34339a
---

`smoke.markdownLsp` / `smoke.peekNavigation` 两个 @p1 在重建产物后**稳定失败**（received 恒 `[]`），是**真回归不是环境噪音**。

**根因链**（commit `2d1c0048 fs 网关增加 realpath 纵深防御` 引入）：
1. `FileSystemMainService.realpath` 返回 `URI` 实例。
2. 经 ProxyChannel IPC，`URI` 被 `JSON.stringify` 成普通对象 `{"$mid":1,"scheme":"file","path":"/C:/..."}`；platform `ipc.ts` 的 reviver **只 revive `Uint8Array`（base64 tag），不 revive URI** → renderer 收到普通对象，`.fsPath` getter 缺失 → 空串。
3. `MainThreadFs._guardRealpath` 把空串传给 `AcpPathPolicy.check` → 命中 `if (!target) return 'empty path'` → 拒。
4. `mdFsBridge` 的 `$readFile/$readDirectory` catch 里**静默吞错**返回 `undefined`/`[]` → workspace symbols / cross-file definition 空。
5. document symbols 走 DocumentStore overlay **不经 fs 网关**，所以**能过**——「读已打开文档的能力 ✓ / 读未打开文件的能力 ✗」这个不对称是定位的决定性信号。

**修复**：`MainThreadFs._guardRealpath` 里 `URI.revive(await this._files.realpath(uri)) as URI` 再读 `.fsPath`（`MainThreadFs.ts`）。realpath 是 IFileService 里**唯一返回 URI 实例**的方法，故只有它跨 IPC 需消费端 revive；其它方法返回纯数据对象。回归单测：`MainThreadFs.test.ts` 用 `JSON.parse(JSON.stringify(URI.file(...)))` 模拟 IPC 降级 + 拒空 target 的 policy，无 revive 即红。

**为何之前以为是环境问题**（见 [[e2e-markdown-exthost-fail-locally]]）：旧 `out/` 产物的 renderer 构建于 realpath 提交合入前，不含该调用；只有 `pnpm build` 重建产物后回归才显形。**本机 e2e 跑的是 `out/` 产物，产物陈旧会完全改变结论——诊断 LSP/markdown e2e 前必先 `pnpm build`/`pnpm --filter @universe-editor/editor build`**（与 [[e2e-async-session-prompt-not-settled]] 同教训）。

**How to apply**：再见任何「main 端服务方法返回 URI、renderer 端读 `.fsPath` 得空」→ 第一反应是跨 IPC 没 revive，不是路径计算错。给跨 IPC 边界返回 URI 的新方法，消费端一律 `URI.revive`。
