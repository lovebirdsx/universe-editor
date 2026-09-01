---
name: uri-components-canonical-path-leading-slash
description: "手写 UriComponents 的 path 必须恰好一个前导斜杠：Windows 的 'C:/...' 要补、POSIX 的 '/tmp/...' 已带（无条件补会出双斜杠）"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb1fb7e8-1ee3-424b-bc83-ca0a127d4421
  modified: 2026-08-31T16:25:22.578Z
---

跨 IPC/探针手造 `UriComponents` 时，`path` 必须是规范形态（**恰好一个**前导斜杠：Windows `'/C:/...'` 要补，POSIX `'/tmp/...'` 本来就有），照抄 `URI.file(p).toJSON()` 的输出。

**Why:** 两个方向都会坏，且**只在一种 OS 上暴露**——Windows 本地开发绿、Linux CI 红（或反之），极易误判成 flake。
- **少一个**：`path: 'C:/...'` 经 `URI.revive` 后 `toString()` 产出 `file://C:/...`（两斜杠），`URI.parse` 把 `C:` 当 authority —— 字符串往返后 URI 身份改变，`IUriIdentityService.isEqual` 判定不等。e2e 里曾致 quick open 恢复路径静默失效（落回 resolver 重猜类型），且同资源出现两个 pick。注意 `isEqual` 对 `file:` 走 `normalizeFsPath(pathWithoutAuthority())`，非规范 URI 与规范 URI 直接比可能相等，但**经 toString→parse 往返后**不等——坑在往返。
- **多一个**：POSIX 上对已带 `/` 的 host path 再拼一个 → `//tmp/...`。`_uriToFsPath` 对它既不走 UNC 分支（无 authority）也不走盘符分支，**原样透传双斜杠**；下游凡是做**裸字符串前缀比对**的路径路由就会静默失配。2026-09-01 CI 实例：perforce e2e `perforceGraphFileHistory` 连红，链路 = spec 手拼 `'/' + perforce.file(...)` → `clientManager.resolveContaining` 的 `p.startsWith(root + '/')` 不命中 → scoped `getChanges` 返回 null → 图谱空。注意 `pathUtil.norm()` 只折尾斜杠**不折前导**，而 `platform` 的 `normalizeFsPath` 会折（`split('/').filter()`）——所以同一个畸形路径在不同模块下场不同，别指望某处归一化兜住。

**How to apply:** 写成 `p.startsWith('/') ? p : '/' + p`（**绝不无条件 `'/' + p`**）；URL 字符串形态则是 `` `file:///${p.replace(/^\/+/, '')}` ``。同一 fixture 里要用多次就收敛成 helper 别各写各的（perforce e2e 的 `perforce.fileUri()` / `fileUrl()` 即此，见 `extensions/perforce/e2e/fixtures/perforceApp.ts`）。排查 URI 身份问题先数 `toString()` 的斜杠数（`file:///` 规范 vs `file://` 少一个 vs `file:////` 多一个）。渲染进程 console 输出在 `<userData>/logs/<date>/window-<id>/console.log`，e2e userData 目录可从 trace.zip 的 launch 参数取。相关 [[path-comparison-convergence]]、[[eslint-path-identity-guardrails]]。
