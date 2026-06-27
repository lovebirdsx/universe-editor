---
name: language-features-plugin-migration-roadmap
description: 把 TS/Markdown 语言能力迁入插件体系的现状分析与路线图（git 已是插件，ts/md 没有）
metadata: 
  node_type: memory
  type: project
  originSessionId: eef1661c-9689-4223-8f94-18e0e7d827db
---

用户方向：未来想把 markdown/ts/git 都按 VSCode 范式做成插件。2026-06-09 做过一次「分析+路线图」（不写代码），样板定为 TypeScript 优先。

**关键事实判断**（决定从哪下手）：
- **Git 已经是 100% 插件**（`extensions/git/`），是现成样板，只用了 extension-api 的 commands/window/workspace/scm。
- **TypeScript 完全没走插件体系**：renderer core 的 `contributions/Typescript{LanguageFeatures,DocumentSync}Contribution.ts` + `services/languageFeatures/typescript/*` provider（吃/吐 monaco 原生类型）+ 主进程 IPC `ITypescriptLanguageService`（LSP server 在主进程 `main-services.ts` spawn）。
- **Markdown 半硬编码**：语言特性同 TS，预览 UI `MarkdownPreviewInput` 硬编码。

**最大缺口**：`extension-api` 只有 commands/window/workspace/scm，缺语言插件必需的：①`languages` 命名空间（9 类 register*Provider + DocumentSelector + createDiagnosticCollection + 中立类型，不能依赖 monaco）；②`workspace` 的 `TextDocument` + onDidChangeTextDocument 文档模型；③`onLanguage:<id>` 激活事件（现 `extensions-common/activation.ts` 只支持 `*`/`onStartupFinished`/`onCommand:`）。

**核心权衡**：语言特性是高频低延迟路径，插件化后调用链从「1 跳跨进程」变「2~3 跳 stdio JSON-RPC」——延迟是最大风险。建议先走「瘦插件」（LSP server 仍在主进程，插件只注册 provider + 转发），并先做 1 个 definition provider 端到端原型实测延迟再决定全量迁。现有 `hostScm.ts`+`ScmService.ts`（句柄+双向通道）、`ExtensionPointTranslator.ts` 是接线样板。

完整路线图见 plan：`C:\Users\kuro\.claude\plans\vscode-markdown-ts-git-vscode-vscode-cuddly-sunbeam.md`。延续自 [[extension-system-progress]]。
</content>
