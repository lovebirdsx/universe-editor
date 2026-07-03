# Memory Index

> 跨 clone / 跨机共享的 memory。真身在主仓库 `.claude/memory/`,各 clone 的全局 memory 目录通过 junction 指向此处。详见同目录 `README.md`。

## 功能实现进展

- [路径/URI 比较根治收敛](path-comparison-convergence.md) — 四套散乱手写机制→IUriIdentityService 单一入口(DI 绑一次 platform)+base 内核纯函数+ResourceMap；修 authority-only file URI 键碰撞；main 侧走内核+normalizePlatform；MonacoModelKey/SCM 键/acpPathPolicy 为刻意保留的独立身份域
- [编辑器身份隔离约定](editor-input-identity-isolation.md) — 同一文件多视图 EditorInput 必须覆写 id 隔离(虚拟 scheme 派 vs 仅覆写 id 派),否则被 openEditor/matches 去重成一个 tab；修 ImageEditorInput 漏此约定的 bug + 收紧基类 matches 只比 id + ClosedEditors/resolveTargetEditor/ReopenWith 纳入 typeId/editorId；追加:markdown 点开图片显乱码=两条打开路径绕过 IEditorResolverService 直建 FileEditorInput,改走 resolver(useMarkdownFileLink 无:line 时 + EditorOpenerContribution isImageResource 分支)
- [AI 基础服务层实施进展](ai-service-foundation-progress.md) — 模型抽象/provider 注册/流式/取消/三层配置/safeStorage 密钥全部完成；platform 契约+main 实现+renderer 门面三层，加 vendor 套路 I，密钥红线
- [插件系统实施进展](extension-system-progress.md) — VSCode 式外部插件系统 + Git 扩展，Phase 0–6 全部完成（双 host 信任级隔离 + fs 网关 + 真 diff + 崩溃/workspace 重启），关键设计决策与可选后续
- [插件 manifest NLS 本地化](extension-manifest-nls.md) — 命令title/子菜单label/配置description 走 VSCode 式 %key% + package.nls.json，host 扫描时按 locale 替换；locale 经 env 传入；nls 文件须列进 files 数组否则打包丢失
- [TypeScript 内置插件](typescript-builtin-plugin.md) — TS 语言能力迁为 extensions/typescript（选项 B 真 VSCode：插件内自 spawn tsserver + 10 类 provider + 文档同步 + 诊断），core 硬编码全删
- [通用 UI 抽取到 workbench-ui](workbench-ui-consolidation.md) — atoms/layout/overlay/feedback+tokens 全沉淀，editor 留薄 wrapper；展示组件纯数据+回调、图标 props 注入、tokens.css 子路径 alias
- [SCM submodule 多 repo](scm-submodule-multirepo.md) — submodule 各作独立 provider，命令路由用 rootUri（id 固定 'git'）+ resourceUri 最长前缀匹配
- [窗口私有日志隔离](window-private-log-isolation.md) — renderer 日志按 BrowserWindow.id 分流到 window-<id>/ 子目录，main 日志共享，logFiles 改 per-window 过滤合并
- [monaco 0.55 EditContext + NLS 索引制](monaco-055-editcontext-nls.md) — 升级修中文 IME 加粗（editContext:true）；0.55 NLS 改索引制致旧 string-key 机制失效，改英文桥接（vscode 源码 key→英文 ⋈ zh-cn.json）
- [Session 执行时间统计](session-timer-feature.md) — 只计 running 净时长，输入框下方 + AGENTS 面板均显示，useSessionTimer hook + 持久化恢复
- [Session 人民币开销显示](session-cost-feature.md) — agent 上报真实 USD（modelUsage 含子 Agent）→ _meta 带 per-model 明细 → ¥ chip + 按模型弹窗 + 汇率服务（er-api 24h 缓存回退 7.2）
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

- [自动更新弹目录选择+Defender 提示](autoupdate-silent-install-coupling.md) — 根因 quitAndInstall 须传 isSilent=true（给 NSIS 加 /S）；updateMainService + electron-updater doInstall + installer.nsh 的 IfSilent 三方耦合

- [computeLineDiff 须保持 Myers O(ND)](linediff-myers-perf.md) — dirty-diff 复用它对大文件切换做全文 diff，勿退回 O(m·n)
- [codex session 新建慢 5 秒](codex-session-skills-scan-slow.md) — 真因:thread/start 内 codex 原生 spawn 的 git rev-parse --git-dir 在 Windows 挂起 ~4.5s(cwd 是 git 仓库才触发);kill 该 git 即恢复;adapter 修不了
- [reload disposable 泄漏误报](reload-disposable-leak-marksingleton.md) — reload 时 React 组件订阅被 tracker 误报，用 markAsSingleton 兜底；render 期 new disposable 孤儿用 ref 守卫+级联测试
- [realpath URI 跨 IPC 未 revive](realpath-uri-ipc-revive.md) — markdownLsp/peekNavigation @p1 真回归：IFileService.realpath 返回的 URI 经 ProxyChannel 降级成普通对象 .fsPath 空，guard 误判 empty path 拒读未打开文件；消费端须 URI.revive；诊断前必先 pnpm build
- [editorTextFocus 残留吞裸字符键](editor-text-focus-stuck-swallows-keys.md) — Monaco blur 订阅先于编辑器 dispose 致 editorTextFocus 卡 true，全局键盘守卫把裸 f 当打字吞掉；syncEditorFocusContext 焦点离开 Monaco 时清掉；测裸字符键须真键盘别用 runCommand 绕
- [diff 视图重开显示旧内容](diff-view-stale-on-reopen.md) — session diff 文件二次改动后重开 tab 仍旧内容；根因 openEditor 去重时 dispose 新 input 复用旧快照；加 EditorInput.updateFrom 钩子，DiffEditorInput 实现之
- [markdown 移动后残留旧路径诊断](markdown-move-stale-diagnostic-fix.md) — B 移动(A 关闭)后重开 A 仍警告旧 B 路径；根因 MdDocumentInfoCache 不听 create + LspWorkspace 缺 watchFile，bulk edit 改关闭文件无文档事件；修法新增 $didChangeFiles 主动通知语言服务磁盘变更
- [StrictMode 空跑 dispose useRef 持有的 Emitter](strictmode-useref-emitter-dispose-dev-only.md) — session outline 高亮 dev-only 不跟随键盘移动；根因=effect cleanup 里 dispose useRef 持有的 Emitter，StrictMode 空跑把它 dispose 而 ref 不重建→.fire() 落死对象；修法惰性创建+不 dispose；教训:useRef 持有的 disposable 绝不在 cleanup dispose

## 打包 / 构建

- [electron-builder asarUnpack + pnpm workspace](electron-builder-asarunpack-pnpm-workspace.md) — platform/workbench-ui 必须放 devDependencies，否则打包崩

## 工程约定 / 护栏

- [ESLint 路径身份护栏](eslint-path-identity-guardrails.md) — no-restricted-syntax 禁手写 fsPath 大小写折叠/路径身份键(精准不误伤 slug/模型 id)；flat config 同名规则替换非合并的坑；测试+SCM 域豁免
- [Action2 async run 的 accessor 失效坑](action2-async-accessor-invalidation.md) — ServicesAccessor 遇第一个 await 即失效；async run 须在 await 前同步取完所有 service(快照传后续 helper)；持久 accessor 的测试会假绿抓不到

## 测试 flaky / 环境问题(非回归)

- [本机 Windows e2e 启动 flake](e2e-windows-launch-flake.md) — 裸 electron.launch 的 restore/relaunch 类 @p1 偶发 "Process failed to launch!" 是环境问题非回归；含 ELECTRON_RUN_AS_NODE fixture 修复与判别要点
- [parcel watcher 多worker崩溃](e2e-parcel-watcher-multiworker-crash.md) — simpleFileDialog 切workspace用例多worker偶发 0xC0000005，是 @parcel/watcher 跨进程竞态，已 @serial 隔离
- [E2E prompt 回复未落地](e2e-async-session-prompt-not-settled.md) — sendAcpPrompt 的 await 不等 echo 流式回复渲染；滚动/虚拟化类 ACP E2E 断言前须先 poll 消息数到位+高度收敛；诊断前先 pnpm build
