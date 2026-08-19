# Memory Index

> 跨 clone / 跨机共享的 memory。真身在主仓库 `.claude/memory/`，各 clone 的全局 memory 目录通过 junction 指向此处。详见同目录 `README.md`。每行只是 hook，详情读对应文件。

## 功能实现进展

- [Explorer 删除到回收站 + Ctrl+Z 撤销](explorer-trash-and-undo-feature.md) — shell.trashItem+IUndoRedoService+op-service 编排撤销；坑=await 前取完 service
- [内置 agent skills + 用户版创建/移植扩展 skill](builtin-agent-skills-user-extension-commands.md) — resources/agent-skills 经 additionalDirectories 注入四条 wire 路径,两 fork 零改动发现;加 skill=放文件+补 sentinel;remote 不注入;内置 skill 统一 disable-model-invocation,codex 端 fork 桥接物化 openai.yaml(sentinel 可回收)
- [session 开销含子 Agent](session-cost-subagent-inclusion.md) — claude SDK 总额天然已含勿双计；codex 须 fork 订阅子 thread tokenUsage 聚合进 _meta.quota
- [agent 二进制静默下载 + e2e teardown 修复](agent-binary-silent-download-e2e-fix.md) — allowDownload 网关；tsserver 孤儿卡 app.close()→优雅关+扫孤儿
- [ACP 输入框 Monaco 化 + 药丸引用](prompt-monaco-input-migration.md) — textarea→内嵌 Monaco，@/# 统一 by-range 药丸；坑=变更源须区分
- [# 结构化上下文引用](prompt-hash-context-references-feature.md) — 引用=decoration 追踪 by-range 药丸，含空格 label 安全，提交读 range 不分词
- [路径/URI 比较根治收敛](path-comparison-convergence.md) — IUriIdentityService 单一入口+ResourceMap；MonacoModelKey/SCM 键为刻意独立身份域
- [编辑器身份隔离约定](editor-input-identity-isolation.md) — 多视图 EditorInput 必须覆写 id 否则 tab 去重；matches 只比 id；打开文件走 resolver
- [AI 基础服务层](ai-service-foundation-progress.md) — platform 契约+main 实现+renderer 门面；密钥 safeStorage 红线；加 vendor 见套路 I
- [插件系统](extension-system-progress.md) — 外部插件 Phase 0–6；2026-07 单 host+Workspace Trust（激活门控，built-in 豁免）
- [第三方插件生态计划](third-party-extension-ecosystem-plan.md) — 注册页+服务端发布签名已落地（2026-08-10 修订决策2）；发布闭环 register→login→publish→可装已通；uex 待用户手动发 npm
- [extension-api 0.9→0.12 API 面补全](extension-api-09-surface-expansion.md) — parity 计划 P1-P4 全落地；bump 版本常量已生成物化+publish 耦合拦截，示例仓库 check-sdk-drift 兜底；事件推兴趣订阅+防抖
- [插件 manifest NLS](extension-manifest-nls.md) — %key%+package.nls.json；nls 文件须列 files 数组否则打包丢失
- [TypeScript 内置插件](typescript-builtin-plugin.md) — 插件自 spawn tsserver+10 类 provider；地图见 extensions/typescript/CLAUDE.md
- [通用 UI 抽取 workbench-ui](workbench-ui-consolidation.md) — 通用件沉淀 workbench-ui，editor 留薄 wrapper；展示组件纯数据+回调
- [SCM submodule 多 repo](scm-submodule-multirepo.md) — submodule 各作独立 provider；rootUri+resourceUri 最长前缀路由
- [窗口私有日志隔离](window-private-log-isolation.md) — renderer 日志按 BrowserWindow.id 分流 window-`<id>`/
- [monaco 0.55 EditContext + NLS 索引制](monaco-055-editcontext-nls.md) — editContext 修中文 IME；NLS 索引制改英文桥接
- [Session 执行时间统计](session-timer-feature.md) — 只计 running 净时长；useSessionTimer+持久化
- [会话级 diff](session-diff-feature.md) — pinned baseline 快照制+fs-watch 兜底侦测；watched 推测徽标+忽略
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
- [commit changes 视图 + graph 打磨](commit-changes-view-graph-polish.md) — reveal 走 pendingReveal observable 防旧实例闭包；点击延迟=回调身份致全表重渲染；silent 跟随+LRU+latest-wins
- [快捷键编辑器对标 VSCode](keybindings-editor-vscode-parity.md) — model/视图分离+VirtualList 确定行高+行级多键 API；坑=浮层 Escape 须 window capture 自拦
- [Tree View（contributes.views + TreeDataProvider）](tree-view-feature.md) — 拉取式懒加载+三级稳定身份+子树失效；坑=epoch 归零致 stale 复活/label 派生身份塌陷改名行
- [extension-api 评审遗留优化 10 项收官](extension-api-review-followup-round.md) — 计划文件留改法/验收；教训=refcount 资源 dispose 须全量直发、cap 须在过滤后扣、引擎收敛前先列语义差异
- [远程开发 Phase 0 地基](remote-dev-phase0-fs-provider.md) — scheme 分派 FileService+per-scheme 大小写+fsPath 审计；护栏只守内核，main 侧加 scheme 守卫不重写
- [远程开发 Phase 1 remote-server](remote-dev-phase1-remote-server.md) — 路由在 main 侧/URI 互译收口/server 零 scheme 感知；UNIVERSE_REMOTE_SERVER_CMD 联调；@regression 须 ONLY_TAG
- [远程开发 v2 全栈](remote-dev-v2-full-stack.md) — daemon+TCP+PersistentProtocol；exthost/ACP 迁远端；host 内须 JSON codec 非 binary；vendor 绝不 scp node_modules；WSL 验收四坑
- [远程 agent binary 受管下载](remote-agent-binary-managed-download.md) — AgentBinaryStore 沉 node-services 双端共享+AgentBinary channel(协议v3)+按 authority 注入 env；坑=store 须并发去重防 .extract 互踩；部署 --omit=optional 省500MB
- [Remote Explorer 单 Targets 树](remote-explorer-merged-targets-tree.md) — 4 view 合一(分组→target→recent 子行)+buildRemoteTree 纯函数；连接双条根因=WSL authority 大小写未归一化，normalizeRemoteAuthority 只在 main 边界收敛
- [AI Settings 远程路由修复](agent-settings-remote-authority-routing.md) — authority 须订阅 onDidChangeWorkspace 勿 useMemo 读 current；useRemoteAuthority hook；协议匹配只回 index 不回秘密
- [远程连接安装过程透明化](remote-connect-progress-transparency.md) — progress 事件复用 onDidChangeState+needsInstall 门控 Output；坑=状态栏须回退 in-flight authority（connect 先于 openFolder）

## 性能 / 疑难根因

- [大文件十连修](largefile-reveal-dirtydiff-vscode-parity.md) — reveal 事件化/行级 diff/增量同步/tsserver OOM 化/IPC 分片/DTO 去 text/切tab看门狗
- [allotment 重挂载空窗口期](allotment-remount-empty-splitview-window.md) — 重挂载 viewItems 空至 RO tick；sizes 守卫只用当前实例报告值
- [sessionChanges 无界增长 OOM](sessionchanges-unbounded-growth-main-oom-abort.md) — tracker 预算+有界日志+64MB 写入兜底
- [子 agent 回放绕过预算 renderer OOM](subagent-replay-bypasses-budget-renderer-oom.md) — 预算窗口以 session/load 响应为界;fire-and-forget 回放=红线;修=await+sidecar 源头预算
- [renderer OOM 三缺口三修(0.1.69 复发)](renderer-oom-triple-fix-live-budget-replay-cap-orphan.md) — live 累计预算+主回放源头 cap+崩溃回收孤儿 agent;预算须覆盖每条入库路径
- [swarm 通知焦点门控吞 toast](swarm-notify-focus-gate-user-away.md) — Windows 锁屏/人离开 isFocused 恒 true；门控须叠 powerMonitor idle/locked；e2e 冻结 present
- [openFolder 切工作区主进程闪退](parcel-watcher-win32-unsubscribe-uaf-crash.md) — parcel win32 unsubscribe UAF；已修=升2.6.0+watcher入UtilityProcess自愈重启；含 minidump 解析法
- [虚拟列表滚动锚点恢复](virtual-list-scroll-anchor-restore.md) — 动态测量下纯 scrollTop 恢复必漂移，用内容锚点+收敛循环；三坑=尺寸锚定对抗/registry 重排/末尾组无法置顶

> NSIS 安装器 / 自动更新（守卫链、WM_SETTINGCHANGE 阻塞、Defender 排除、耗时方法学）收敛在 skill `nsis-installer-autoupdate`（按需加载，不占常驻索引）。

- [computeLineDiff 须保持 Myers O(ND)](linediff-myers-perf.md) — 勿退 O(m·n)；V 数组按 2*maxD+1+100ms 墙钟回退
- [codex session 新建慢 5 秒](codex-session-skills-scan-slow.md) — codex 原生 spawn git rev-parse Windows 挂起；adapter 修不了
- [claude CLI e.includes 崩溃根因](claude-cli-eincludes-usage-crash.md) — 网关 advisor_message 缺 model→CLI usage 记账 TypeError 作废整 turn;编辑器已归 transient 自动续跑;bun exe 可提明文 JS 分析
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
- [WSL pnpm install 缺 make 根因](windows-process-tree-pnpmfile-skip-linux-build.md) — binding.gyp 使 readPackage 剥脚本无效；.pnpmfile.cjs updateConfig 非 win32 置 allowBuilds=false

## 工程约定 / 护栏

- [win32 spawnSync shell:true 吞 ^](win32-spawnsync-cmd-caret-escaping.md) — cmd 元字符参数须包双引号；turbo `pkg^...` 静默变 `pkg...`
- [ESLint 路径身份护栏](eslint-path-identity-guardrails.md) — 禁手写 fsPath 折叠/路径身份键；flat config 替换非合并
- [UriComponents path 须带前导斜杠](uri-components-canonical-path-leading-slash.md) — 手写 'C:/...' 致 file://C:/ parse 不稳、URI 身份断裂；e2e 渲染日志在 userData/logs/window-N/console.log
- [Action2 async accessor 失效](action2-async-accessor-invalidation.md) — await 前同步取完所有 service；持久 accessor 测试假绿
- [when 不提权，weight 定胜负](keybinding-when-not-priority-weight-wins.md) — scoped 快捷键压全局同键必须显式加 weight
- [prompt 输入框不冒充全局 editorTextFocus](prompt-input-no-global-editortextfocus.md) — 嵌入式 Monaco 用专用 key；VSCode 导入层 User=1000 压过一切 scoped weight，"输入框失效别处正常"先查导入键位
- [spawn CLI 挂起 / 选错命令](cli-stdin-hang-on-prompt.md) — 交互 CLI 换只读命令；p4 查 ticket 用 `p4 tickets`/`login -s`
- [renderer Action2 被扩展命令遮蔽](renderer-action-shadowed-by-extension-command-decl.md) — renderer handler 命令只写 menus 别写扩展 commands
- [WSL 时钟漂移毒化 tsgo 增量缓存（已根治）](tsgo-stale-tsbuildinfo-phantom-typecheck-errors.md) — RTC 快 24h→未来 mtime→tsgo 误判 up-to-date；已修=ensure-fresh-mtimes 入口守卫+editor typecheck 失败自愈重试
- [可选注入参数破坏 createInstance + tsgo Windows 漏报](tsgo-optional-di-param-ci-only-typecheck-fail.md) — 注入服务禁写 `?`；「CI typecheck 挂本地绿」用 tsc 复现即真错
- [esbuild 跨包引源码须声明 workspace 依赖](esbuild-cross-pkg-src-needs-workspace-dep.md) — 裸 `../pkg/src` 引用对 turbo 隐形→依赖图缺边→上游 miss 时下游并发读未生成的 dist（CI-only 竞态）；声明 workspace:* 同时修调度与 hash 感知

## e2e flaky / 排查

> e2e 偶发失败（CI 挂/本地稳过）的排查流程与案例库（含已知环境 flake 登记）全部收敛在 skill `fix-ci-e2e-flake`（按需加载，不占常驻索引）。
