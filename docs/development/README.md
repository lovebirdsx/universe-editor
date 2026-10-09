# 开发者文档

面向本仓库开发者与部署方的文档索引。用户向的使用说明在 [`docs/user/`](../user/zh-CN/index.md)。

## 测试

- [测试](testing.md) — 单元 / 集成 / E2E 三层测试，E2E 内核·插件分离与最小扩展集启动、tag 体系、CI affected 选择性执行、临时目录策略（`temp-root` / `pnpm tmp:clean`）。

## 诊断

- [错误收集与诊断机制](error-diagnostics.md) — errors.jsonl 结构化错误收集（指纹折叠 / 脱敏）、崩溃闭环、「报告问题」与诊断包导出链路。
- [内存压力与 IPC 帧闸门](memory-pressure.md) — renderer 堆水位与缓存释放、IPC 帧体量上限与崩溃前帧记录、崩溃恢复链路（EPIPE / IPC 洪流 / 延迟 reload）。
- [Bug 录制（bug recording）](bug-recording.md) — 录制操作步骤流 + 关键截图 + 会话日志成 zip 证据包（面向 AI 阅读的时间线、三档脱敏、崩溃兜底导出）。
- [日志：窗口私有隔离](logging.md) — 进程边界=隔离边界：main 日志全窗口共享、renderer/acp 日志按权威 `BrowserWindow.id` 写 `window-<id>/` 子目录，接线（WindowScopedServices）与消费方（Output / 自动 reveal）为何无需改动。

## 构建与发布

- [构建与工具链](build-tooling.md) — turbo 依赖图（跨包引源码/dist 必须声明 workspace 依赖，缺边=CI-only 竞态）、子进程 spawn 三坑（交互 CLI stdin 挂起 / win32 cmd caret 转义 / 转义为何单测测不到）、tsgo 类型检查（WSL 时钟漂移幽灵报错与仓库侧守卫 / tsgo·tsc 跨平台分歧的 tsc 复现法）、electron-builder 打包与 pnpm 安装、`check` 与 `check:full` 的组成差异（非超集）。
- [发布外部扩展](publishing-extensions.md) — `pnpm ext:release` 把 `extensions-external/*` 自动打包成 `.vsix` 并发布进市场（自动发现、增量跳过）。
- [发布扩展 SDK（npm）](publishing-sdk.md) — `@universe-editor/extension-api` 等发布集合发公开 npm 的手动流程 + 内网 tarball 托管 fallback。
- [配置扩展市场服务器](marketplace-server.md) — 自建市场后端：`/extensionquery` 协议、registry 格式、部署与联调。

App 本体的发布（版本 bump、打包、上传，及 push `vX.Y.Z` tag 后自动创建 GitHub Release 并触发 samples 仓库 CI）见 [`scripts/release/README.md`](../../scripts/release/README.md)；市场运维脚本细节见 [`scripts/gallery/README.md`](../../scripts/gallery/README.md)。

版本介绍（release notes）的单源流程——`docs/release-notes/<version>.md` 起草 → 人工确认 → 发版确定性编译到应用 / 下载站 / GitHub Release，起草用 skill `generate-release-notes` — 见 [docs/release-notes/README.md](../release-notes/README.md)。

## 架构与约定

- [浮层层级与裁剪](overlay-layers.md) — tooltip / 菜单 / 对话框的四条挂载链路（React portal、monaco 平台层、monaco 编辑器内容层、视图自绘）、`--z-*` 三段式分层与「该不该 token 化」的判据、外部占位层、浮层排查套路。
- [滚动列表的渲染约定](scroll-lists.md) — 树 / 虚拟列表的三条绘制约定（滚动内容的不透明底衬 `--view-background`、行定位用 `top` 不用 `transform`、reveal 只滚自己的 scroller）、残影类故障的现场判据与护栏、动态测量下的内容锚点恢复与收敛循环。
- [Allotment 分割布局](allotment-layout.md) — SplitView 重挂载空窗（未传 `defaultSizes` 时 viewItems 懒填充）、imperative `resize()` 的守卫纪律、`onChange` 构造期闭包与瞬态帧持久化、最大化重启宽度重置的复盘与 e2e 窗口尺寸约束。
- [嵌入 Monaco](monaco-embedding.md) — 嵌入编辑器的四类陷阱：宿主 `automaticLayout` 经 `getRawOptions` 渗进所有嵌入编辑器（peek / hover / diff）与 `inline-block` 容器互相观察成环（Peek References 预览 blank 的根因与 CSS 断环）；`editContext` 下的输入事件派发边界（宿主元素 + capture）；嵌入实例的焦点桥接（专用 context key，勿冒充 `editorTextFocus`）；standalone `addCommand` 的跨编辑器键泄漏；0.55 升级（命名空间顶层化 / NLS 索引制英文桥接）。
- [命令、快捷键与上下文键](commands-and-context-keys.md) — `Action2` 的 `menu`（`precondition` 会 AND 进每一行、面板打开时 `editorAreaFocus` 必为 false）、快捷键解析（weight 优先、`when` 只过滤）、焦点类上下文键一律 DOM 派生、`ScopedContextKeyService` 的静默 dispose、异步 run 的 accessor 寿命、扩展命令遮蔽 renderer Action2——六条会静默失效的判据与正确写法。
- [Quick-navigate picker](quick-navigate-pickers.md) — 「按住修饰键、松开即选中」手势：`IQuickNavigateOptions`（modifier / triggerKey / initialSelectionIndex）、面板锁定态与 keyup-accept 语义、两条边界（宿主 `when: '!quickInputVisible'` 管不到 IPC 窗口、quickNavigate 下 `activeItemId` 惰性）与验证资产。
- [Git 提交信息规范](git-commit-msg-rule.md) — 提交格式、类型前缀（发布说明不再由提交生成，见下条）。
- [远程开发（remote-ssh / WSL）](remote-dev.md) — daemon+TCP 传输与协议 bump 自愈链、URI/scheme 与 authority 规范形、部署链（tar/scp 盘符、bundle 哈希）、Windows 远端主机（平台探测 / cmd 契约 / WMI 逃 job kill / 路径展示）、WSL 直连、远端终端与 extension host、远端 agent 二进制受管下载、实机验收方法论与已知限制。
- [AI 模型层：定向解析、发现超时与枚举缓存](ai-model-layer.md) — 热路径按 modelId 定向解析（禁「拉全量再 find」）、discovery deadline 2.5s 与失败冷却 30s（只记 timeout）、枚举缓存的 provider 指纹与 knowledge 全量失效。
- [文件监视：UtilityProcess 隔离与 win32 崩溃复盘](file-watcher.md) — parcel watcher 的 win32 unsubscribe UAF 证据链（两 dump 同偏移）、native 崩溃为何不能留在 main 进程、desired-state 重放自愈链与 re-subscribe 合并常量、崩溃复现的 e2e 视角交叉引用。
- [Ctrl+P 与工作区文件清单](file-search-and-listing.md) — 巨型工作区「慢在 IPC 解码不在业务」的判序、DTO 判别联合与截断整份丢弃、预热双常量与 200ms 单闸门防抖、rg `--iglob` / `-g` 优先级红线。
- [终端跨折行文件链接](terminal-links.md) — 三个独立根因（conpty 未透传 `windowsPty` / `provideLinks` 越行链接被剪枝 / trimRight 拼串与完整网格坐标失配）的索引与上游 xterm 坐标、测试盲区互补、必须断言 range 的验证流程。
- [renderer 自定义协议 `universe-app`](app-protocol.md) — 为何 shell 必须搬离 `file://`（Chromium 在请求发起前就拦截跨 origin 的自定义 scheme 资源）、单 handler 双用途（`/_resource_/` 走 allow-list + 服务 shell）、`registerSchemesAsPrivileged` 只能一次且早于 whenReady、dev `webSecurity:false` 的边界与 origin 变更对 localStorage 的影响。
- [Tree View（扩展贡献的树视图）](tree-views.md) — 链路与拉取式懒加载、handle 跨刷新的三级身份与回收、host 侧命令解析（`$executeTreeItemCommand`，`arguments` 不上 wire）、展开态保留、两个坑（行点击双触发 / epoch 归零致 stale 复活）与验证资产。
- [claude-agent-acp fork 维护](claude-agent-maintenance.md) — 独立维护定位与 SDK/CLI/ACP/transcript 边界、基线台账与功能契约表、上游选择性吸收的评估记录、发布入口阻断项。

## 环境与工具（个人笔记）

- [开发加速方案](lag-detect.md) — Windows 下排除 Defender / 关闭索引服务，减少 `pnpm dev`/`e2e` 的磁盘抖动。
- [在 WSL2/Ubuntu 下跑 e2e](wsl-e2e.md) — 用 xvfb 离屏跑 Playwright e2e，避免测试窗口抢 Windows 前台焦点；含 AI agent 在 WSL 内工作的一键初始化与 xvfb 包装、WSLg Wayland 注入与 runtime dir 丢失的排查。
- [Claude 使用注意事项](claude.md) — 上下文压缩窗口配置。
