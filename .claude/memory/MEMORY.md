# Memory Index

> 跨 clone / 跨机共享的 memory。真身在主仓库 `.claude/memory/`,各 clone 的全局 memory 目录通过 junction 指向此处。详见同目录 `README.md`。

## 功能实现进展

- [Explorer 删除到回收站 + Ctrl+Z 撤销](explorer-trash-and-undo-feature.md) — delete 加 useTrash 走 shell.trashItem；完整移植 VSCode IUndoRedoService 到 platform；新 ExplorerFileOperationService 编排撤销(删前内存备份重建,>10MB 不备份)+命令层键位 ctrl+z/ctrl+y；坑=action 须 await 前取完 service [[action2-async-accessor-invalidation]]

- [agent 二进制静默下载 + e2e teardown 回归修复](agent-binary-silent-download-e2e-fix.md) — 通知噪音→connect silent 选项→codex/claude 二进制守卫按 agentId 修复→意外揭露 codex 真下载导致 e2e teardown timeout→allowDownload 网关 + prefetch e2e 门禁；**续修真根因**=预热引入的 tsserver 在 Windows 变孤儿卡 app.close()：vendored CLI 只在优雅退(stdin EOF/watchdog)跑 exit hook 回收 tsserver，treeKill /F 硬杀跳过它+甩掉 race 的 semantic server→改 lspClient/exthost 全链优雅关(stdin EOF 级联)+Playwright SIGKILL 不跑 in-app 钩子故 e2e 靠 fixture killOrphanedLanguageServers 扫死父孤儿

- [ACP 输入框 Monaco 化 + 药丸引用](prompt-monaco-input-migration.md) — textarea→内嵌 Monaco，@/# 统一 by-range 药丸(对标 VSCode Copilot);M0–M4 全完成全绿;坑=programmatic vs user 变更源(非受控 Monaco 每次 setValue 都 fire onChange,须计数器区分)/ArrowUp 用 getTopForPosition 判视觉首行/e2e 无 input 改探针 getAcpPromptText+drop 宿主 testid acp-prompt-drop-host
- [# 结构化上下文引用](prompt-hash-context-references-feature.md) — ACP 输入框重构为**内嵌 Monaco + by-range 药丸**：@/# 统一成 decoration 追踪的引用，含空格 label 安全，提交读 range 列表不分词；旧 by-name 管线全删；模型 promptRef.ts + 追踪 promptRefTracker.ts + 句柄 PromptMonacoEditor.tsx（实施坑见 [[prompt-monaco-input-migration]]）
- [路径/URI 比较根治收敛](path-comparison-convergence.md) — 四套散乱手写机制→IUriIdentityService 单一入口(DI 绑一次 platform)+base 内核纯函数+ResourceMap；修 authority-only file URI 键碰撞；main 侧走内核+normalizePlatform；MonacoModelKey/SCM 键/acpPathPolicy 为刻意保留的独立身份域
- [编辑器身份隔离约定](editor-input-identity-isolation.md) — 同一文件多视图 EditorInput 必须覆写 id 隔离(虚拟 scheme 派 vs 仅覆写 id 派),否则被 openEditor/matches 去重成一个 tab；修 ImageEditorInput 漏此约定的 bug + 收紧基类 matches 只比 id + ClosedEditors/resolveTargetEditor/ReopenWith 纳入 typeId/editorId；追加:markdown 点开图片显乱码=两条打开路径绕过 IEditorResolverService 直建 FileEditorInput,改走 resolver(useMarkdownFileLink 无:line 时 + EditorOpenerContribution isImageResource 分支)
- [AI 基础服务层实施进展](ai-service-foundation-progress.md) — 模型抽象/provider 注册/流式/取消/三层配置/safeStorage 密钥全部完成；platform 契约+main 实现+renderer 门面三层，加 vendor 套路 I，密钥红线
- [插件系统实施进展](extension-system-progress.md) — VSCode 式外部插件系统 + Git 扩展，Phase 0–6 全完成；**2026-07 重构：双 host→单 host + Workspace Trust**（照抄 VSCode，激活门控 capabilities.untrustedWorkspaces，built-in 豁免，授予 replay/撤销重启），修 eslint 在 restricted host 拿不到 languages 通道的诊断丢失 bug
- [插件 manifest NLS 本地化](extension-manifest-nls.md) — 命令title/子菜单label/配置description 走 VSCode 式 %key% + package.nls.json，host 扫描时按 locale 替换；locale 经 env 传入；nls 文件须列进 files 数组否则打包丢失
- [TypeScript 内置插件](typescript-builtin-plugin.md) — TS 语言能力迁为 extensions/typescript（选项 B 真 VSCode：插件内自 spawn tsserver + 10 类 provider + 文档同步 + 诊断），core 硬编码全删
- [通用 UI 抽取到 workbench-ui](workbench-ui-consolidation.md) — atoms/layout/overlay/feedback+tokens 全沉淀，editor 留薄 wrapper；展示组件纯数据+回调、图标 props 注入、tokens.css 子路径 alias
- [SCM submodule 多 repo](scm-submodule-multirepo.md) — submodule 各作独立 provider，命令路由用 rootUri（id 固定 'git'）+ resourceUri 最长前缀匹配
- [窗口私有日志隔离](window-private-log-isolation.md) — renderer 日志按 BrowserWindow.id 分流到 window-<id>/ 子目录，main 日志共享，logFiles 改 per-window 过滤合并
- [monaco 0.55 EditContext + NLS 索引制](monaco-055-editcontext-nls.md) — 升级修中文 IME 加粗（editContext:true）；0.55 NLS 改索引制致旧 string-key 机制失效，改英文桥接（vscode 源码 key→英文 ⋈ zh-cn.json）
- [Session 执行时间统计](session-timer-feature.md) — 只计 running 净时长，输入框下方 + AGENTS 面板均显示，useSessionTimer hook + 持久化恢复
- [会话级 diff 功能](session-diff-feature.md) — 逆推 baseline 跟踪 agent 改动，Side Bar list/tree 视图 + 单击预览双击钉住，Activity Bar 用 FileStack
- [新建 session 异步化](async-session-create.md) — createSession 同步返回立即渲染，后台握手；双 id（本地 uuid id vs agent 颁发 sessionIdOnAgent）；queued prompts 自动派发；whenConnected 为测试 await 点
- [Codex 三种登录方案建模](codex-three-auth-modes.md) — gateway 须自包含 provider（experimental_bearer_token），绝不碰 openai_base_url/requires_openai_auth；统一 applyCredential 原子入口
- [markdown 预览 vimium 式键盘导航](markdown-preview-link-hints.md) — 线②预览:f/F link hints(BFS 标签算法+capture 键盘+合成 click 复用 onClick)+滚动/前进后退,controller+contextKey+Action2 对称结构
- [Codex 对齐 Claude skills/memory](codex-claude-skills-memory-parity.md) — codex-acp fork 在 adapter 层读 .claude/skills(extraRoots)+自动注入 .claude/memory/MEMORY.md(developerInstructions);手动开关靠每 skill 静态 openai.yaml + sync-codex-skill-policy.mjs;3 个测试 Windows 反斜杠失败 CI 过
- [Codex AI 标题跨工作区持久化](codex-ai-title-persistence-parity.md) — codex 非当前工作区 session 标题回退成首条用户消息;根因 fork 缺 set_session_title ext-method,AI 标题只留工作区本地;对称补 thread/name/set 桥接;含 eslint hook 污染 vendor 的运维坑
- [外部 session AI 标题跨 bucket 回填](foreign-session-ai-title-crossbucket-backfill.md) — 跨 worktree 窗口看外部 session 标题卡首条消息(渲染层,非 agent 侧);hydrate 每 cwd 只跑一次+JSONL 删后 session/list 修不回;复用 useForeignSessionStats 从归属 bucket 回填 title(仅 aiTitle 才覆盖)+reconcile 写回(title-only 不打 aiTitle)
- [dirty-diff 内联 peek](dirty-diff-inline-peek-feature.md) — 点击修改色条弹内联 diff(内嵌真 Monaco diff editor:双侧行号+语法高亮+内部滚动;Esc关闭/拖动调高/出视口才滚入;导航+Revert+Stage+打开完整diff);overlay-widget+空view-zone占位(手写DOM diff已删勿回退);Stage 走 git diff -U0→selectHunkPatch→apply --cached(stdin);套路见 skill dirty-diff-inline-peek
- [markdown 预览本地图片](markdown-preview-local-images-app-scheme.md) — prod renderer 页面从 file:// 改为自定义 universe-app scheme(shell+资源同源,_resource_ 路径前缀);对齐 VSCode asWebviewUri+localResourceRoots(工作区根+文档目录边界,renderer 经 IResourceAccessService 声明);根因=自定义 secure scheme 从 file:// 页跨源被 Chromium 拦在 handler 前
- [ACP 输入框图片支持](acp-prompt-image-feature.md) — 粘贴/拖拽/附件三入口+能力降级+限额可配;88×88 共享 ChatImage 控件(缩略图+锚定预览弹窗 portal+fixed 视口定位防遮挡);恢复卡死**真因=filePathLink.ts 正则灾难回溯**(SEG 含/退化成(a+)+,遇 data:URL >35s),非 tracer;codex 恢复图片**在渲染层解析文本 image**(markdownRenderer.isImageDataUrl+MarkdownView.renderImage 注入,不改 vendor);tracer O(m²)+超大行丢弃是独立修复
- [链接打开机制 IOpenerService + 深链接](opener-service-deeplink-feature.md) — 对等 VSCode 发地址即开文件定位/执行白名单命令;platform 契约(fragment #L行,列 1-based)+renderer 三档 opener(External/Command 白名单/File)+revealEditorPosition 收敛 3 处重复定位;OS 级 universe-editor://file|command 深链(shared/deepLink.ts+setAsDefaultProtocolClient+ue:open-uri);坑=built-in opener disposable 须 this._register 否则 e2e 泄漏全红

## 性能 / 疑难根因

- [allotment 重挂载空 SplitView 窗口期](allotment-remount-empty-splitview-window.md) — key 重挂载后 viewItems 为空直到 ResizeObserver tick,窗口跨多次 commit;imperative resize 只能用当前实例 onChange 报告过的 sizes 守卫,重挂载即清缓存 sizes;切工作区 collapsed 水合落进窗口→minimumSize of undefined
- [sessionChanges 无界增长主进程 OOM exit 134](sessionchanges-unbounded-growth-main-oom-abort.md) — 工作区状态 200MB(sessionChanges 152MB)启动 8 秒闪退;根因=全量 IPC+全量 state 日志 stringify+整文件重写三管道叠加;修=tracker 预算(8MB/会话全有全无+32MB 全局+20 LRU+加载剪枝自愈)+_describeState 有界日志+storage 64MB 写入兜底

> NSIS 安装器 / 自动更新（非静默进度弹窗守卫链、WM_SETTINGCHANGE 广播阻塞、Defender 排除、安装耗时测量方法学）全部收敛在 skill `nsis-installer-autoupdate`（按需加载，不占常驻索引）。

- [computeLineDiff 须保持 Myers O(ND)](linediff-myers-perf.md) — dirty-diff 复用它对大文件切换做全文 diff，勿退回 O(m·n)
- [codex session 新建慢 5 秒](codex-session-skills-scan-slow.md) — 真因:thread/start 内 codex 原生 spawn 的 git rev-parse --git-dir 在 Windows 挂起 ~4.5s(cwd 是 git 仓库才触发);kill 该 git 即恢复;adapter 修不了
- [reload disposable 泄漏误报](reload-disposable-leak-marksingleton.md) — reload 时 React 组件订阅被 tracker 误报，用 markAsSingleton 兜底；render 期 new disposable 孤儿用 ref 守卫+级联测试
- [EditorGroupModel.openEditor 孤儿泄漏](editor-group-open-orphan-leak.md) — 命中重复身份早退但不释放调用方交出所有权的新 input(ReopenClosed/moveEditor);修=早退前 existing.updateFrom?.()+editor.dispose();现有 @regression e2e 抓不到(它先关再开无副本),靠单元 withLeakCheck 定位
- [realpath URI 跨 IPC 未 revive](realpath-uri-ipc-revive.md) — markdownLsp/peekNavigation @p1 真回归：IFileService.realpath 返回的 URI 经 ProxyChannel 降级成普通对象 .fsPath 空，guard 误判 empty path 拒读未打开文件；消费端须 URI.revive；诊断前必先 pnpm build
- [editorTextFocus 残留吞裸字符键](editor-text-focus-stuck-swallows-keys.md) — Monaco blur 订阅先于编辑器 dispose 致 editorTextFocus 卡 true，全局键盘守卫把裸 f 当打字吞掉；syncEditorFocusContext 焦点离开 Monaco 时清掉；测裸字符键须真键盘别用 runCommand 绕
- [Monaco addCommand 全局键位泄漏吞键](monaco-addcommand-global-key-leak.md) — standalone Monaco 的 addCommand 注册在共享键位服务(无编辑器作用域)→在所有编辑器触发;ACP 输入框回车 addCommand 吞掉文件编辑器 Enter,.md 因高权重 markdown.editing.onEnter 免疫;修=改作用域化 DOM keydown
- [diff 视图重开显示旧内容](diff-view-stale-on-reopen.md) — session diff 文件二次改动后重开 tab 仍旧内容；根因 openEditor 去重时 dispose 新 input 复用旧快照；加 EditorInput.updateFrom 钩子，DiffEditorInput 实现之
- [markdown 移动后残留旧路径诊断](markdown-move-stale-diagnostic-fix.md) — B 移动(A 关闭)后重开 A 仍警告旧 B 路径；根因 MdDocumentInfoCache 不听 create + LspWorkspace 缺 watchFile，bulk edit 改关闭文件无文档事件；修法新增 $didChangeFiles 主动通知语言服务磁盘变更
- [StrictMode 空跑 dispose useRef 持有的 Emitter](strictmode-useref-emitter-dispose-dev-only.md) — session outline 高亮 dev-only 不跟随键盘移动；根因=effect cleanup 里 dispose useRef 持有的 Emitter，StrictMode 空跑把它 dispose 而 ref 不重建→.fire() 落死对象；修法惰性创建+不 dispose；教训:useRef 持有的 disposable 绝不在 cleanup dispose
- [渲染崩溃→日志死循环→黑屏不自愈](renderer-crash-log-feedback-loop-blackscreen.md) — 长任务窗口变黑(可拖动)=渲染崩溃后主进程仍向死帧 send,Electron 33 不抛异常而内部 console.error→被拦截写日志→onDidAppendEntry 又推回死帧→无限循环写爆盘打满 CPU;修=ElectronProtocol 加 render-process-gone/reload 事件闸门(try/catch+isDestroyed 拦不住)+崩溃弹窗一键 reload+FileLogger rotate 突发熔断
- [Peek 预览面板 blank](peek-preview-blank-embedded-automaticlayout.md) — 真根因=`.preview.inline`(inline-block 收缩到内容)与继承来的 automaticLayout ResizeObserver 互相观察成 5×5 死锁;首个引用跨文件(异步读盘)稳定复现;修=CSS 让 `.preview` 填满恒定的 split-view slot 断环(updateOptions 关 observer 无效,构造后才 fire 且从不 stopObserving)
- [最大化重启二级侧栏宽度重置](secondary-sidebar-maximize-restart-width-reset.md) — LayoutPriority.High 只是半修;真根因=allotment 构造期捕获过期 onChange 闭包(init 目标把可见侧栏当隐藏)+瞬态帧被无条件持久化(挤到 minSize 170 写回);修=init 目标经 ref 现读+侧栏宽度只在 onDragEnd 持久化(VSCode 语义);教训:allotment 回调内读 props 一律走 ref

## 打包 / 构建

- [electron-builder asarUnpack + pnpm workspace](electron-builder-asarunpack-pnpm-workspace.md) — platform/workbench-ui 必须放 devDependencies，否则打包崩

## 工程约定 / 护栏

- [ESLint 路径身份护栏](eslint-path-identity-guardrails.md) — no-restricted-syntax 禁手写 fsPath 大小写折叠/路径身份键(精准不误伤 slug/模型 id)；flat config 同名规则替换非合并的坑；测试+SCM 域豁免
- [Action2 async run 的 accessor 失效坑](action2-async-accessor-invalidation.md) — ServicesAccessor 遇第一个 await 即失效；async run 须在 await 前同步取完所有 service(快照传后续 helper)；持久 accessor 的测试会假绿抓不到
- [spawn CLI 不关 stdin 挂起 / 选错命令](cli-stdin-hang-on-prompt.md) — spawn 交互型 CLI 需要输入时永久挂起；空 stdin 只防挂起不解决问题，真正解法是换只读命令。p4 案例：`login -p` 是重新认证(会要密码)非读 ticket，正解 `p4 tickets`(只读缓存文件)；查状态用 `login -s`
- [renderer Action2 被扩展命令声明遮蔽](renderer-action-shadowed-by-extension-command-decl.md) — handler 在 renderer Action2 的命令(如 *-graph.view)绝不能写进扩展 package.json 的 commands 数组,否则被无 handler 的扩展宿主命令静默遮蔽成 no-op(executeCommand 不抛错、编辑器不开);只写进 menus 即可

## e2e flaky / 排查

> e2e 偶发失败（CI 挂/本地稳过）的排查流程、案例库、速记全部收敛在 skill `fix-ci-e2e-flake`（按需加载，不占常驻索引）；已知环境 flake 的一句话登记见 `apps/editor/e2e/RUNBOOK.md`。

