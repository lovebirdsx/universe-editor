---
name: uri-components-canonical-path-leading-slash
description: "手写 UriComponents 的 path 必须带前导斜杠（'/C:/...'），否则 toString 出 parse 不稳定的 file://C:/... 破坏 URI 身份比较"
metadata: 
  node_type: memory
  type: feedback
---

跨 IPC/探针手造 `UriComponents` 时，`path` 必须是规范形态（Windows 下 `'/C:/...'`，带前导斜杠），照抄 `URI.file(p).toJSON()` 的输出。

**Why:** 缺前导斜杠的 `path: 'C:/...'` 经 `URI.revive` 后 `toString()` 产出 `file://C:/...`（两斜杠），`URI.parse` 会把 `C:` 当成 authority —— 字符串往返后 URI 身份改变，`IUriIdentityService.isEqual` 判定不等。e2e 里曾因此导致 quick open 恢复路径静默失效（落回 resolver 重猜类型），且同资源出现两个 pick。注意 `isEqual` 对 `file:` 走 `normalizeFsPath(pathWithoutAuthority())`，非规范 URI 与规范 URI 直接比可能相等，但**经 toString→parse 往返后**不等——坑在往返。

**How to apply:** e2e spec 或任何手写 UriComponents 处，path 用 `'/' + fsPath.replace(/\\/g,'/')`；排查 URI 身份问题先看 `toString()` 的斜杠数（`file:///` 规范 vs `file://` 异常）。渲染进程 console 输出在 `<userData>/logs/<date>/window-<id>/console.log`，e2e userData 目录可从 trace.zip 的 launch 参数取。相关 [[path-comparison-convergence]]。
