# Memory Index

> 跨 clone / 跨机共享的 memory。真身在主仓库 `.claude/memory/`，各 clone 的全局 memory 目录通过 junction 指向此处。详见同目录 `README.md`。每行只是 hook，详情读对应文件。

## 功能实现进展

- [Explorer 删除到回收站 + Ctrl+Z 撤销](explorer-trash-and-undo-feature.md) — shell.trashItem+IUndoRedoService+op-service 编排撤销；坑=await 前取完 service
- [agent 二进制静默下载 + e2e teardown 修复](agent-binary-silent-download-e2e-fix.md) — allowDownload 网关；tsserver 孤儿卡 app.close()→优雅关+扫孤儿
- [ACP 输入框 Monaco 化 + 药丸引用](prompt-monaco-input-migration.md) — textarea→内嵌 Monaco，@/# 统一 by-range 药丸；坑=变更源须区分
- [# 结构化上下文引用](prompt-hash-context-references-feature.md) — 引用=decoration 追踪 by-range 药丸，含空格 label 安全，提交读 range 不分词
- [路径/URI 比较根治收敛](path-comparison-convergence.md) — IUriIdentityService 单一入口+ResourceMap；MonacoModelKey/SCM 键为刻意独立身份域
- [编辑器身份隔离约定](editor-input-identity-isolation.md) — 多视图 EditorInput 必须覆写 id 否则 tab 去重；matches 只比 id；打开文件走 resolver
- [AI 基础服务层](ai-service-foundation-progress.md) — platform 契约+main 实现+renderer 门面；密钥 safeStorage 红线；加 vendor 见套路 I
- [插件系统](extension-system-progress.md) — 外部插件 Phase 0–6；2026-07 单 host+Workspace Trust（激活门控，built-in 豁免）
- [第三方插件生态计划](third-party-extension-ecosystem-plan.md) — Phase A 已落地（extension-manifest 新包替代 common 直发）；四决策已拍板（先内后公/token 自助发布/完整 DX/不做 vscode shim）
- [插件 manifest NLS](extension-manifest-nls.md) — %key%+package.nls.json；nls 文件须列 files 数组否则打包丢失
- [TypeScript 内置插件](typescript-builtin-plugin.md) — 插件自 spawn tsserver+10 类 provider；地图见 extensions/typescript/CLAUDE.md
- [通用 UI 抽取 workbench-ui](workbench-ui-consolidation.md) — 通用件沉淀 workbench-ui，editor 留薄 wrapper；展示组件纯数据+回调
- [SCM submodule 多 repo](scm-submodule-multirepo.md) — submodule 各作独立 provider；rootUri+resourceUri 最长前缀路由
- [窗口私有日志隔离](window-private-log-isolation.md) — renderer 日志按 BrowserWindow.id 分流 window-`<id>`/
- [monaco 0.55 EditContext + NLS 索引制](monaco-055-editcontext-nls.md) — editContext 修中文 IME；NLS 索引制改英文桥接
- [Session 执行时间统计](session-timer-feature.md) — 只计 running 净时长；useSessionTimer+持久化
- [会话级 diff](session-diff-feature.md) — 逆推 baseline 跟踪 agent 改动；list/tree 视图+预览/钉住
- [新建 session 异步化](async-session-create.md) — 同步渲染后台握手；双 id；queued prompts 自动派发
- [Codex 三种登录方案](codex-three-auth-modes.md) — gateway 须自包含 provider；统一 applyCredential 原子入口
- [markdown 预览键盘导航](markdown-preview-link-hints.md) — f/F link hints+滚动/前进后退；controller+contextKey+Action2
- [Codex 对齐 Claude skills/memory](codex-claude-skills-memory-parity.md) — codex fork 读 .claude/skills+注入 MEMORY.md；openai.yaml+sync 脚本
- [Codex AI 标题跨工作区持久化](codex-ai-title-persistence-parity.md) — fork 补 thread/name/set 桥接；eslint hook 污染 vendor 坑
- [外部 session AI 标题回填](foreign-session-ai-title-crossbucket-backfill.md) — 从归属 bucket 回填(仅 aiTitle 覆盖)+reconcile 写回
- [dirty-diff 内联 peek](dirty-diff-inline-peek-feature.md) — 点色条弹内嵌 Monaco diff；overlay-widget+空 view-zone；套路见 workbench/scm/CLAUDE.md
- [markdown 预览本地图片](markdown-preview-local-images-app-scheme.md) — universe-app scheme；asWebviewUri+localResourceRoots 对齐
- [ACP 输入框图片](acp-prompt-image-feature.md) — 三入口+能力降级；卡死真因=filePathLink 正则回溯；codex 渲染层解析
- [链接打开机制 + 深链接](opener-service-deeplink-feature.md) — IOpenerService 三档+#L 行列；universe-editor:// 深链；套路见 services/opener/CLAUDE.md

## 性能 / 疑难根因

- [大文件十连修](largefile-reveal-dirtydiff-vscode-parity.md) — reveal 事件化/行级 diff/增量同步/tsserver OOM 化/IPC 分片/DTO 去 text/切tab看门狗
- [allotment 重挂载空窗口期](allotment-remount-empty-splitview-window.md) — 重挂载 viewItems 空至 RO tick；sizes 守卫只用当前实例报告值
- [sessionChanges 无界增长 OOM](sessionchanges-unbounded-growth-main-oom-abort.md) — tracker 预算+有界日志+64MB 写入兜底
- [swarm 通知焦点门控吞 toast](swarm-notify-focus-gate-user-away.md) — Windows 锁屏/人离开 isFocused 恒 true；门控须叠 powerMonitor idle/locked；e2e 冻结 present
- [openFolder 切工作区主进程闪退](parcel-watcher-win32-unsubscribe-uaf-crash.md) — parcel win32 unsubscribe UAF；已修=升2.6.0+watcher入UtilityProcess自愈重启；含 minidump 解析法
- [虚拟列表滚动锚点恢复](virtual-list-scroll-anchor-restore.md) — 动态测量下纯 scrollTop 恢复必漂移，用内容锚点+收敛循环；三坑=尺寸锚定对抗/registry 重排/末尾组无法置顶

> NSIS 安装器 / 自动更新（守卫链、WM_SETTINGCHANGE 阻塞、Defender 排除、耗时方法学）收敛在 skill `nsis-installer-autoupdate`（按需加载，不占常驻索引）。

- [computeLineDiff 须保持 Myers O(ND)](linediff-myers-perf.md) — 勿退 O(m·n)；V 数组按 2*maxD+1+100ms 墙钟回退
- [codex session 新建慢 5 秒](codex-session-skills-scan-slow.md) — codex 原生 spawn git rev-parse Windows 挂起；adapter 修不了
- [reload disposable 泄漏误报](reload-disposable-leak-marksingleton.md) — markAsSingleton 兜底；render 期 new disposable 用 ref 守卫
- [openEditor 孤儿泄漏](editor-group-open-orphan-leak.md) — 重复身份早退须 updateFrom?.()+dispose 新 input
- [realpath URI 跨 IPC 未 revive](realpath-uri-ipc-revive.md) — 消费端须 URI.revive；诊断前必先 pnpm build
- [editorTextFocus 残留吞键](editor-text-focus-stuck-swallows-keys.md) — 焦点离开 Monaco 即清；测裸字符键用真键盘
- [Monaco addCommand 全局泄漏](monaco-addcommand-global-key-leak.md) — 无编辑器作用域吞键；改作用域化 DOM keydown
- [diff 视图重开显示旧内容](diff-view-stale-on-reopen.md) — 去重复用旧快照；EditorInput.updateFrom 钩子
- [markdown 移动后残留旧路径诊断](markdown-move-stale-diagnostic-fix.md) — $didChangeFiles 主动通知磁盘变更
- [StrictMode dispose useRef 的 Emitter](strictmode-useref-emitter-dispose-dev-only.md) — useRef 持有的 disposable 绝不在 cleanup dispose
- [渲染崩溃→日志死循环黑屏](renderer-crash-log-feedback-loop-blackscreen.md) — ElectronProtocol 事件闸门+FileLogger 熔断
- [Peek 预览面板 blank](peek-preview-blank-embedded-automaticlayout.md) — .preview.inline 与 automaticLayout 死锁；CSS 填满 slot 断环
- [最大化重启二级侧栏宽度重置](secondary-sidebar-maximize-restart-width-reset.md) — allotment 回调读 props 走 ref；宽度只在 onDragEnd 持久化
- [agent shell 的 ELECTRON_RUN_AS_NODE](agent-shell-electron-run-as-node.md) — 跑 electron/pnpm dev 前必须 unset，否则 ESM 主进程必崩
- [纯语法语言 plaintext 回退无高亮](textmate-grammar-only-language-plaintext-fallback.md) — createModel 对未注册语言 id 静默回退 plaintext；TextMateService.initialize 补 register 自愈

## 打包 / 构建

- [electron-builder asarUnpack + pnpm workspace](electron-builder-asarunpack-pnpm-workspace.md) — platform/workbench-ui 必须放 devDependencies

## 工程约定 / 护栏

- [win32 spawnSync shell:true 吞 ^](win32-spawnsync-cmd-caret-escaping.md) — cmd 元字符参数须包双引号；turbo `pkg^...` 静默变 `pkg...`
- [ESLint 路径身份护栏](eslint-path-identity-guardrails.md) — 禁手写 fsPath 折叠/路径身份键；flat config 替换非合并
- [UriComponents path 须带前导斜杠](uri-components-canonical-path-leading-slash.md) — 手写 'C:/...' 致 file://C:/ parse 不稳、URI 身份断裂；e2e 渲染日志在 userData/logs/window-N/console.log
- [Action2 async accessor 失效](action2-async-accessor-invalidation.md) — await 前同步取完所有 service；持久 accessor 测试假绿
- [when 不提权，weight 定胜负](keybinding-when-not-priority-weight-wins.md) — scoped 快捷键压全局同键必须显式加 weight
- [spawn CLI 挂起 / 选错命令](cli-stdin-hang-on-prompt.md) — 交互 CLI 换只读命令；p4 查 ticket 用 `p4 tickets`/`login -s`
- [renderer Action2 被扩展命令遮蔽](renderer-action-shadowed-by-extension-command-decl.md) — renderer handler 命令只写 menus 别写扩展 commands

## e2e flaky / 排查

> e2e 偶发失败（CI 挂/本地稳过）的排查流程与案例库（含已知环境 flake 登记）全部收敛在 skill `fix-ci-e2e-flake`（按需加载，不占常驻索引）。
