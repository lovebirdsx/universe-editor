---
name: remote-agent-binary-managed-download
description: 远程工作区 agent 原生二进制受管下载到远端主机（AgentBinaryStore 双端共享 + RemoteChannels.AgentBinary + renderer 按 authority 注入 env）
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-16T01:37:15.000Z
---

远程工作区下 claude/codex 原生二进制改为下载到**远端主机** `<dataDir>/agent-bin/<agent>/`（2026-08-15 落地）。此前 renderer 对 `spec.authority` 直接短路 → 远端 claude-code 必挂（fork 的 claudeCliPath() 无 `CLAUDE_CODE_EXECUTABLE` 直接 throw），codex 靠部署时 npm ci 隐式拉 300MB 平台包。

**架构**：下载核心抽为 `packages/node-services/src/agentBinary/`（`AgentBinaryStore` + claude/codex flavor，Electron-free），main 两个 binary 服务薄壳化（保留 source 分派/dev vendored 复用/electron 路径）；远端走 `RemoteChannels.AgentBinary`（协议 v2→v3），server 端 `RemoteAgentBinaryService` 惰性建 store + 进度节流（≥100ms）跨隧道；main 按 `opts.authority` 分流（照 acpHost 模式，onDidClose 失效 proxy 缓存）；renderer 远程分支固定 `source:'download'` 并注入远端 native path 到 `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH`，settings env 改读远端 `~/.claude`（`claudeConfig.read(authority)`）。

**Why**: 二进制放非版本化目录（server 升级不重下几百 MB）；远端部署 `npm ci --omit=dev --omit=optional` 省 ~500MB（原生二进制均为 optionalDependencies，改由受管下载补）。

**How to apply / 坑**:
- 红线不变：本地 source/customPath 配置与 `acp.codex.apiKey` 绝不过隧道；进度事件按 `authority` 过滤（本地事件 authority=undefined），本地/远端下载互不驱动对方通知。
- **store 层必须并发去重**（飞行中共享 promise、settle 后释放）：server 同进程内两个 session 并发首启会写同一 `.extract.<pid>` 临时目录互踩损坏；main 层 _inflight 只保护本地。settle 后释放是为了 forceDownload 版本翻转能被下一次 resolve 看见。
- BinaryPanel/CodexBinaryPanel 已远程化（2026-08-16，协议 v3→v4）：`IRemoteAgentBinaryService` 增 `getVersionInfo(agent)`/`forceDownload(agent, version)`，editor 契约 `getVersionInfo(authority?)`/`forceDownload(version, authority?)` 按 authority 分流；面板远程模式隐藏 source 区（远端固定受管下载）、进度按 authority 过滤、authority 切换先清陈旧 versionInfo。
- 预下载已补齐远端（2026-08-22，协议 v6→v7）：`IRemoteAgentBinaryService` 增 `prefetch(agent)`/`cleanupStaleVersions(agent)`，editor 契约同加 `authority?` 尾参。`AgentBinaryPrefetchContribution` 从「runWhenIdle 跑一次」改成事件驱动多入口（idle 初始触发 + `onDidChangeWorkspace` + `IRemoteStatusService.onDidChangeState` + 构造期 `getConnections()` seed），语义=**每 authority 每会话至多一次**；prefetch 跟随当前工作区（remote 只预取远端，不看本地 `acp.*.source`；本地照旧），cleanup 本地恒跑 + 远端额外一次，`acp.prefetchBinaries` 与 e2e 探针门禁覆盖全部下载路径。
- **后台维护绝不能触发连接**：`getServiceProxy` 本身不连，但其代理首次 `.call()` 会 `getConnection()` 走完整 bring-up（SSH 部署+安装）。远端 prefetch/cleanup 必须门控在 `IRemoteStatusService` 报告的 `connected` 上；`getConnections()` 是被动读可安全轮询。
- 多入口去重两条不变量：①`_maintained.add(authority)` 必须在 **connected 检查之后**（前置会让「未连接→后连接」的 authority 永久漏维护）、且在任何 `await` **之前**（否则同帧两事件重复下载）；②`onDidChangeState` 是 live emitter 不重放历史，故需 seed，而 seed 失败的按需重试必须**有次数上限**——否则 `seed → _maintain → re-seed` 自成环，IPC 持续失败时无限刷日志。

关联：[[remote-dev-v2-full-stack]]、[[agent-binary-silent-download-e2e-fix]]

**版本保留 + 下载状态改造（2026-09-16，协议 v10→v11）**：需求「回退/升级不该重下几百 MB」的根因是 `forceDownload` 会先 `_rmQuiet(版本目录)` 删掉盘上已有版本再重下。改法：`_ensureVersion(version, background)` 收成**唯一入口**（盘上命中即返回 → `_inflightEnsures` 按版本去重 → 才下载），`forceDownload` = ensure + 写 `.active`。保留集 = `{active, bundled, 上次见到的 registry latest}`；latest 落 `<baseDir>/.latest` 文本文件而**不是** cleanup 时联网查（cleanup 在启动路径上，10s registry 超时是最坏路径，且与并发的 prefetch 抢同一份查询）；`.prefetch` 暂存区删掉（暂存目录 ≠ 版本目录时「一个版本只下一次」不可能成立），`_adoptLegacyPrefetch` 只做一次性搬家。下载状态从面板组件局部 state 搬进 store：`onDidChangeDownload` 用**数组载荷**（后台 prefetch 与用户点击可真实并发，`[]` = 空闲，也避开 JSON 信封丢 `undefined` key），`getVersionInfo().downloads` 是同状态快照 —— 面板常驻订阅 + 快照重建，切走再回来才看得到进度、正在下载的版本不再渲染按钮。

**Why**: 局部 state 跨组件卸载必然丢；无查询接口就没法判断「这个版本正在下载」，重复点击会并发写同一个 `.extract.<pid>` 而互相踩踏。

**How to apply / 坑**：① `cleanupStaleVersions` 里 `bundledVersion()` 抛错时**绝不能拿空 keep-set 往下走**（= 把用户下过的版本全删），要么跳过这轮；② `background` 是「谁先发起」不是「我是谁」，前台 join 后台下载会继承 `true`，别拿它判断「是不是我发起的」；③ 失败路径必须在 `finally` 清下载状态，否则 UI 永远卡在「下载中」；④ 面板是三层防重复的最外一层（store 去重才是真保证），别把状态退回组件里；⑤ **判定「某版本正在下载」只能喂实时 `downloads`**，喂 `getVersionInfo` 快照会让点击后「进度行 + 仍可点的按钮」并存（快照只在挂载瞬间用来恢复状态）——这条被子 agent 审查抓到，且测试是靠种快照取巧才没暴露，补的用例必须走「点击 → 收实时事件 → 断言按钮消失」；⑥ 时间窗口类保留问题要一起想全：下载 settle 到 `.active` 落盘之间、以及 idle cleanup 早于用户点击回收遗留 `.prefetch` 暂存区，两者都会让「刚下好的版本被清掉」，前者靠 `_activating` 集合、后者靠 cleanup 内先搬家并把搬回来的版本计入 keep-set。
