---
name: remote-dev-phase0-fs-provider
description: VSCode Remote 式远程开发的 Phase 0 地基——scheme 分派 FileService + fsPath 全量审计 + per-provider 大小写，以及审计的可行边界
metadata:
  type: project
---

2026-08-13 完成远程开发（VSCode Remote-SSH 式）的 **Phase 0 地基重构**，本地行为零回归（`check:full` 74/74 + `e2e:smoke` 68 个 @p0 全绿）。Phase 1 起（远端 server / SSH 传输 / 终端 / host / ACP 迁远端）**尚未开工**，用户明确决定停在 Phase 0 后再议。

落地三件事：
1. `packages/platform/src/files/fileSystemProvider.ts` 新增 `IFileSystemProvider` + `FileSystemProviderRegistry` + 按 `uri.scheme` 分派的 `FileService`；`FileSystemMainService` 瘦身为 `extends FileService` 并注册 `LocalFileSystemProvider`（原 node:fs 实现下沉），对外 IPC 契约与 DI 注册不变。`IFileService.listRecursive` 返回类型 `string[]` → `URI[]`。
2. `IUriIdentityService` 新增 `registerSchemeCaseSensitivity(scheme, caseSensitive)` / `isCaseSensitive(uri)`——大小写敏感性从 per-app 常量变成 per-scheme，否则 Windows 本机 + Linux 远端会把 `Foo.ts`/`foo.ts` 错误合并。
3. `.fsPath` 全量审计（224 处，4 个并行子 agent 分片改 + 我统一审校）。

**Why**：`URI.fsPath` 会把 authority 折进路径，对非 `file:` scheme 恒为错值——这是远程化最大的隐性地雷，必须在接远端**之前**收敛，否则届时全是静默读错本机路径的疑难 bug。

**How to apply**：

- **审计的可行边界**：原计划的「`.fsPath` 只允许出现在 allowlist 目录」不可行——合法本机语义站点约 200 处横跨 40 个目录，白名单会退化成列出整个仓库。最终护栏只覆盖 `packages/platform/src/**`（内核是唯一按构造就该 scheme 无关的层，白名单只有 3 个咽喉：`base/uri.ts`、`variableResolver.ts`、`undoRedoService.ts`）。规则常量 `schemeAgnosticRestrictedSyntax` 在 `packages/config-eslint/index.js`，接线在根 `eslint.config.js`。加这类 lint 护栏后**务必写个探针文件验证它真的报错**。
- **main / platform 优先加 scheme 守卫而非重写实现**：ripgrep 搜索、parcel watcher、项目 settings、跳转列表、变量替换这些服务在远端场景下会被远端 server 的同名服务整体取代，现在重写是空转；加守卫保证远端接入时 fail loud。
- **同一语义可能有两条独立路径，守一条不够**：`variableResolver` 的私有 `fsPath()` 加了守卫，但 `ConfigurationResolverService.getFilePath()` 是**另一条**供给 `${file}` 的通道、直接返回 `resource.fsPath`，绕开了守卫。审校时要顺着契约找全供给方。
- **把 `.fsPath` 换成 `.path` 会在 Windows 多出前导斜杠**（`D:/a` → `/D:/a`）。比较层无碍（`relativePathUnder` 在 win32 整体 toLowerCase），但**所有拿它做字符串前缀匹配的对侧必须同步换**（`resourceInfo.dirnameOfResource` ↔ `SessionChangesView.rootDir` 就是一对）。
- **公开 API 契约不能动**：`extension-api` 的 `Uri.fsPath` / `RelativePattern.base` 对齐 VSCode `vscode.d.ts`，改了破坏第三方插件兼容。
- **extension host 眼里的「本机」是它自己所在的机器**——未来它整个搬到远端，所以它读扩展安装目录、spawn tsserver 用 fsPath 是自洽的 L 类，不要改。

完整方案（B→A 架构、Phase 0–4 路线、推迟站点清单、风险表）见计划文件 `~/.claude/plans/vscode-remote-agent-proud-puddle.md`。相关：[[path-comparison-convergence]]（IUriIdentityService 单一入口）、[[eslint-path-identity-guardrails]]（既有路径身份护栏）、[[uri-components-canonical-path-leading-slash]]（URI path 前导斜杠约定）。
