---
name: extension-host-silent-failure-hardening
description: rainbow_csv 移植反馈驱动的 ext-host「无声失败」治理：getActiveTextEditor 防死锁、open 补发、语言重扫、rejection 上浮
metadata:
  type: project
---

2026-08-20，依据 rainbow_csv 移植复盘（核心教训：**最烧时间的不是 API 缺口而是无声失败**——挂起的 Promise、默默构建错入口、不刷新的 context key、只在日志里的异常）落地一轮治理：

- **getActiveTextEditor 防死锁**：renderer 的 `DocumentSyncContribution._openDoc` 把文档镜像推送排在 `await activateByEvent` 之后 → 在 `activate()` 里等镜像必死锁。修法 = `ExtensionActivationService.isActivating`（`_activating.size>0`）时立即 resolve undefined + 日志；非激活期等待缩到 2s（`GET_ACTIVE_EDITOR_DOC_WAIT_MS`）。原则：**API getter 永不无限挂起，挂起比报错难诊断一个量级**。
- **onDidOpenTextDocument 订阅时补发**：`ExtHostDocuments.onDidOpenWithBackfill`——新 listener 微任务内补发订阅时已镜像的文档，exactly-once（快照成员被 close/语言重开替换则跳过，live 事件已送达）。消灭"激活后轮询首文档"样板。
- **冷启动语言竞态**：编辑器恢复（createModel+languageForResource）先于 contributes.languages 翻译 → 纯贡献关联落 plaintext 且镜像带错语言。修法 = `ModelLanguageResyncContribution` 订阅 `languageRegistry.onDidChangeLanguages`，微任务后只对 plaintext 模型重解析升级（先自愈 register 未知 id 防 monaco 静默回退）。
- **unhandled rejection 上浮**：host `$onUnhandledRejection` 经 `IMainThreadExtensions` 推 renderer——dev 弹通知，e2e 经探针 `getExtHostUnhandledRejections` + harness teardown 门（与 `expectNoLeaks` 同位）判失败。**测试全绿 ≠ 无运行时错误**。
- 其它同轮：`editorLangId` context key 补订 `FileEditorInput.onDidChangeLanguage`（[[extension-api-013-language-theme-menu-surface]] 的 setTextDocumentLanguage 链路下游）；扩展 OutputChannel 行首 `[HH:mm:ss.SSS]` 时间戳（MainThreadOutput per-handle 行首状态机）；port-vscode-extension skill 附 `apps/editor/resources/agent-skills/.claude/skills/port-vscode-extension/references/vscode-compat-template.js` 模板+陷阱清单+市场类目映射；create-extension 模板与实例的 `packages/create-extension/templates/basic/scripts/e2e.mjs` 透传 argv；docs/extension-dev 新增 activation-timing.md/testing.md。

**坑（测试侧）**：gate 住 activate 的测试扩展模块，release 钩子在异步 import 完成后才挂上 globalThis——可选调用 `?.()` 静默 no-op 会让 `await activating` 永挂，须先 poll 钩子就位。
