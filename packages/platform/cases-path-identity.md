# cases-path-identity.md

本文从 `packages/platform/CLAUDE.md` 拆出，范围是**路径/URI 比较的形态陷阱**——两条都「只在一种 OS 上暴露」，最容易被当成 flake 或环境噪音。单一入口 `IUriIdentityService` 的约定见该 CLAUDE.md 的「路径 / URI 身份比较」节。

## 工作区根盘符大小写（Ctrl+P 重复行）

形态分叉来自**源头**：工作区根保留对话框给的 `file:///E:/…`（盘符大写），而 Explorer 曾把盘符折成小写，于是同一个文件有两串文本；Ctrl+P 若用原始 `uri.toString()` 比较就各占一行，描述还因大小写敏感的 `startsWith` 回落成绝对路径。

收口方式：**所有工作区根生产者统一走 `canonicalizeWorkspaceFolderUri`**（`apps/editor/src/main/services/remote/remoteUri.ts`，内层是 `packages/platform/src/base/uri.ts` 的 `canonicalizeFileUri`）——它把盘符折**向上**（大写），与 `normalizeFsPath` 同向。**折下会让整个 `workspaces/<sha1>.json` 换桶**（工作区存储按 `toString()` 的 hash 分桶），历史状态整体丢失。

**唯一刻意不走 comparison key 的热路径**：`FileQuickAccessProvider.scanPool`（`apps/editor/src/renderer/services/quickInput/providers/FileQuickAccessProvider.ts:597`）——它每击键要扫 10 万条清单，按 `entry.relPath` 建 `Set`，清单本身即 `URI.joinPath(root, relPath)`，relPath 已是条目的身份，逐条算 key 会多出一次 URI parse + 路径归一。已知缺口：编辑器 resource 与 walk 的 relPath 之间**除盘符外的**路径大小写差异不折叠（listing cache 装不下每条的预计算 key）。小集合（打开编辑器 / 视图 / recent / 描述行）一律走 `getComparisonKey`——别把原始 URI 串比较请回来。

## 手写 `UriComponents` 的 path 必须恰好一个前导斜杠

跨 IPC / 探针手造 `UriComponents` 时，`path` 照抄 `URI.file(p).toJSON()` 的规范形态：**恰好一个**前导斜杠（Windows 的 `'C:/...'` 要补，POSIX 的 `'/tmp/...'` 本来就有）。

- 写法：`p.startsWith('/') ? p : '/' + p`——**绝不无条件 `'/' + p`**。
- URL 字符串形态：`` `file:///${p.replace(/^\/+/, '')}` ``。
- 同一 fixture 里用多次就收敛成 helper，别各写各的（蓝本 `extensions/perforce/e2e/fixtures/perforceApp.ts:478-482` 的 `fileUri` / `fileUrl`）。

两个方向都会坏：

- **少一个**：`path: 'C:/...'` 经 `URI.revive` 后 `toString()` 产 `file://C:/...`，`URI.parse` 把 `C:` 当 authority——**经 toString→parse 往返后**身份改变。注意 `isEqual` 对 `file:` 走 `normalizeFsPath(pathWithoutAuthority())`，非规范 URI 与规范 URI **直接比可能相等**，坑在往返。e2e 里曾致 quick open 恢复路径静默失效（落回 resolver 重猜类型），同资源出现两个 pick。
- **多一个**：POSIX 上对已带 `/` 的 host path 再拼一个 → `//tmp/...`。`uriToFsPath`（`packages/primitives/src/uri.ts:241`，经 `base/uri.ts` re-export）对它既不走 UNC 分支（无 authority）也不走盘符分支，**原样透传双斜杠**；下游凡是做**裸字符串前缀比对**的路径路由就静默失配。2026-09-01 CI 实例：perforce e2e `perforceGraphFileHistory` 连红，链路 = spec 手拼 `'/' + perforce.file(...)` → `clientManager.resolveContaining` 的 `p.startsWith(root + '/')` 不命中 → scoped `getChanges` 返 null → 图谱空。

**别指望某处归一化兜住**：`pathUtil.norm()` 只折尾斜杠**不折前导**，而 platform 的 `normalizeFsPath` 会折（`split('/').filter()`）——同一个畸形路径在不同模块下场不同。排查先数 `toString()` 的斜杠数：`file:///` 规范 / `file://` 少一个 / `file:////` 多一个。

## 验证

```bash
pnpm --filter @universe-editor/platform test
pnpm e2e specs/smoke.quickAccess.spec.ts
```
