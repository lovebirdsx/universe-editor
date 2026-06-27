# Memory Index

> 跨 clone / 跨机共享的 memory。真身在主仓库 `.claude-memory/`,各 clone 的全局 memory 目录通过 junction 指向此处。详见同目录 `README.md`。

## 功能实现进展

- [AI 基础服务层实施进展](ai-service-foundation-progress.md) — 模型抽象/provider 注册/流式/取消/三层配置/safeStorage 密钥全部完成；platform 契约+main 实现+renderer 门面三层，加 vendor 套路 I，密钥红线
- [插件系统实施进展](extension-system-progress.md) — VSCode 式外部插件系统 + Git 扩展，Phase 0–6 全部完成（双 host 信任级隔离 + fs 网关 + 真 diff + 崩溃/workspace 重启），关键设计决策与可选后续
- [TypeScript 内置插件](typescript-builtin-plugin.md) — TS 语言能力迁为 extensions/typescript（选项 B 真 VSCode：插件内自 spawn tsserver + 10 类 provider + 文档同步 + 诊断），core 硬编码全删
- [language-features 插件迁移路线](language-features-plugin-migration-roadmap.md) — 语言能力插件化迁移路线图
- [通用 UI 抽取到 workbench-ui](workbench-ui-consolidation.md) — atoms/layout/overlay/feedback+tokens 全沉淀，editor 留薄 wrapper；展示组件纯数据+回调、图标 props 注入、tokens.css 子路径 alias
- [SCM submodule 多 repo](scm-submodule-multirepo.md) — submodule 各作独立 provider，命令路由用 rootUri（id 固定 'git'）+ resourceUri 最长前缀匹配
- [窗口私有日志隔离](window-private-log-isolation.md) — renderer 日志按 BrowserWindow.id 分流到 window-<id>/ 子目录，main 日志共享，logFiles 改 per-window 过滤合并
- [monaco 0.55 EditContext + NLS 索引制](monaco-055-editcontext-nls.md) — 升级修中文 IME 加粗（editContext:true）；0.55 NLS 改索引制致旧 string-key 机制失效，改英文桥接（vscode 源码 key→英文 ⋈ zh-cn.json）
- [Session 执行时间统计](session-timer-feature.md) — 只计 running 净时长，输入框下方 + AGENTS 面板均显示，useSessionTimer hook + 持久化恢复
- [Session 人民币开销显示](session-cost-feature.md) — agent 上报真实 USD（modelUsage 含子 Agent）→ _meta 带 per-model 明细 → ¥ chip + 按模型弹窗 + 汇率服务（er-api 24h 缓存回退 7.2）
- [会话级 diff 功能](session-diff-feature.md) — 逆推 baseline 跟踪 agent 改动，Side Bar list/tree 视图 + 单击预览双击钉住，Activity Bar 用 FileStack
- [新建 session 异步化](async-session-create.md) — createSession 同步返回立即渲染，后台握手；双 id（本地 uuid id vs agent 颁发 sessionIdOnAgent）；queued prompts 自动派发；whenConnected 为测试 await 点
- [Codex 三种登录方案建模](codex-three-auth-modes.md) — gateway 须自包含 provider（experimental_bearer_token），绝不碰 openai_base_url/requires_openai_auth；统一 applyCredential 原子入口

## 性能 / 疑难根因

- [computeLineDiff 须保持 Myers O(ND)](linediff-myers-perf.md) — dirty-diff 复用它对大文件切换做全文 diff，勿退回 O(m·n)
- [codex session 新建慢 5 秒](codex-session-skills-scan-slow.md) — 真因:thread/start 内 codex 原生 spawn 的 git rev-parse --git-dir 在 Windows 挂起 ~4.5s(cwd 是 git 仓库才触发);kill 该 git 即恢复;adapter 修不了
- [reload disposable 泄漏误报](reload-disposable-leak-marksingleton.md) — reload 时 React 组件订阅被 tracker 误报，用 markAsSingleton 兜底；render 期 new disposable 孤儿用 ref 守卫+级联测试

## 打包 / 构建

- [electron-builder asarUnpack + pnpm workspace](electron-builder-asarunpack-pnpm-workspace.md) — platform/workbench-ui 必须放 devDependencies，否则打包崩

## 测试 flaky / 环境问题(非回归)

- [本机 e2e restore spec flaky](e2e-restore-specs-flaky-locally.md) — restore/persistence 类 @p1 因 electron 二次启动失败，是环境问题非回归
- [本机 e2e markdown exthost 失败](e2e-markdown-exthost-fail-locally.md) — markdownEditing/markdownLsp @p1 因 exthost 拒执行 markdown.editing.* 失败，本机环境问题非回归
- [e2e 禁用 extension host 根治 flake](e2e-disable-exthost-flake.md) — 已作废：markdown 迁插件后 e2e 改启用 host，根因(bootstrap 路径+二进制 IPC)另修
- [parcel watcher 多worker崩溃](e2e-parcel-watcher-multiworker-crash.md) — simpleFileDialog 切workspace用例多worker偶发 0xC0000005，是 @parcel/watcher 跨进程竞态，已 @serial 隔离
- [fileWatcher debounce 测试 flaky](fileWatcher-debounce-test-flaky.md) — 全量 vitest 下偶发 5s 超时，单跑必过，parcel native watcher 时序非回归
- [e2e Electron 启动修复](e2e-electron-launch-broken-local.md) — ELECTRON_RUN_AS_NODE=1 导致 --remote-debugging-port=0 被拒，fixture 需显式清除该变量（已修复）
- [本地 Windows E2E 启动失败](e2e-local-windows-launch-fails.md) — Playwright electron.launch 因 --remote-debugging-port=0 被拒，E2E 交给 CI 验证
- [e2e relaunch flake (Windows)](e2e-relaunch-flake-windows.md) — 重启类 @p1 报 "Process failed to launch" 是环境问题，非回归
- [acp fork Windows 路径测试 flake](acp-fork-windows-path-test-flake.md) — claude-agent-acp 的 toDisplayPath 两个测试在 Windows 必失败，是上游跨平台缺陷非回归
- [History nav @p0 预存失败](history-nav-p0-preexisting-fail.md) — smoke.historyNavigation 的 @p0 在预存 markdown LSP 工作上已失败，与 go-to-symbol 无关
- [E2E prompt 回复未落地](e2e-async-session-prompt-not-settled.md) — sendAcpPrompt 的 await 不等 echo 流式回复渲染；滚动/虚拟化类 ACP E2E 断言前须先 poll 消息数到位+高度收敛；诊断前先 pnpm build
