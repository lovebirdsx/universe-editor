# 03 · main 主进程与跨进程通信

> 事实基于代码阅读（文件:行号可复核）；标注【推测】的为推断。上一轮 `01-main-process.md` 的大部分条目已落地（见 [01-roadmap-audit.md](./01-roadmap-audit.md)）。

## ① 现状速写

主进程约 **14,200 行 / ~50 个源文件**，`apps/editor/src/main/services/` 下 30+ 个服务目录。

**服务分组**

| 组 | 服务 |
|---|---|
| 内核/基础 | files、fileSearch、textSearch、fileWatcher、storage、log、userData、environment |
| 窗口/工作区 | window（WindowMainService + windowsMainService + jumpList）、workspace、recentWorkspaces、host、sessionSwitcher |
| AI/Agent | ai（model/secret/debug）、acpHost、acpTerminal、claudeBinary/claudeConfig、codexBinary/codexConfig |
| 扩展系统 | extensionHost、extensionManagement、extensionGallery |
| 外围 | update、releaseNotes、docs、usage、exchangeRate、remoteSchema、resourceAccess、environmentSnapshot、performance、terminal、ping、disposableLeak、configLocation |
| 进程基建 | process/（managedChildProcess + env + decode） |

**规模 Top**：windowMainService.ts 725 / claudeBinaryMainService.ts 603 / main/index.ts 565 / aiModelMainService.ts 564 / codexBinaryMainService.ts 553 / extensionManagementService.ts 531。

**两层服务模型**（`window/scopedServicesFactory.ts:50-107`）：ApplicationServices（应用单例，root DI 容器 eager 物化，will-quit 统一 dispose）+ WindowScopedServices（每窗口 8 个，由 `windowMainService.createWindow()` 手动 new，不进容器）。

**IPC 架构**：单一 Electron 通道 `ue:ipc`（`shared/ipc/channelNames.ts:7`）多路复用 38 个命名 service channel；main 侧按 WebContents id 分发到每窗口 `ElectronProtocol` → `ChannelServer`；同一协议反向开 `ChannelClient`，main 可调 renderer 的 `lifecycle` / `rendererSessions` 两个反向通道（`registerMainServices.ts:109-114`）。preload 仅暴露字节桥 + 5 个带类型守卫的窄 API。

## ② 做得好的点

1. **上一轮 P0/P1 大头已兑现**：`ManagedChildProcess` 收编 acpHost/acpTerminal/extensionHost/textSearch，带 SIGTERM→2s→SIGKILL 升级（:176-193）、Windows `taskkill /T` 树杀、quit 路径同步阻塞树杀，配完备单测；DI padding 被 `registerSingletonFactory` 消灭（`main-services.ts:88-96`），改签名即编译错；点名的零测试服务均已补齐（main 侧测试文件 ~40 个）。
2. **preload 严格白名单**：IPC 字节桥 + platform/home/getPathForFile + 3 个 `ue:open-*` 监听（全部 typeof 守卫）；E2E 探针三层门禁，production 天然剥除。
3. **崩溃反馈环治理**：`ElectronProtocol._frameAlive` 闸门（`electronProtocol.ts:49-128`）掐断"死帧 send→console.error→日志→再 send"死循环；渲染崩溃一键 reload + 防风暴去抖（`windowMainService.ts:217-254`）。
4. **关闭路径分层清楚**：before-quit 两段式（renderer veto → captureSession → storage.flush → await extensionHost.stopAll() 的 stdin-EOF 优雅级联，`index.ts:513-545`）；will-quit 同步兜底（rootInstantiation.dispose 统一杀子进程 + flushSync + shutdown trace）。
5. **二进制 IPC 正确性**：`Uint8Array` 经 JSON 信封显式 base64 标记往返（`platform/src/ipc/ipc.ts:120-153`）。
6. **每窗口状态隔离**：workspace/storage/userData/fileWatcher 均 per-window；同一 workspace 双开被拦截（单写者约束，`windowMainService.ts:653-661`）；renderer 日志按 window id 分目录。
7. **spawn 环境统一**：`process/env.ts` 的 `buildChildEnv` + `decode.ts`（Windows OEM 编码 stderr）被各 spawn 点复用。

## ③ 问题清单

### P2 — main→renderer 反向 RPC 无超时、无 dispose 拒绝，悬挂即永久

- 证据：`packages/platform/src/ipc/ipc.ts:203-211`（call 的 Promise 只在收到 response 时 settle）；`ipc.ts:234-236`（`dispose()` 只 clear 不 reject）；`electronProtocol.ts:115-128`（帧死后 send 静默丢弃）。
- 失败场景：renderer 假死（非崩溃，`render-process-gone` 不触发）时，`confirmQuit` 里 `await rendererLifecycle.confirmShutdown(...)`（`windowMainService.ts:642`）永不返回，退出流程被无声卡住。窗口正常关闭时 pending 请求的 async 闭包也随之泄漏。
- 建议：ChannelClient dispose 时 reject 全部 pending；反向 lifecycle 调用套 `Promise.race` 超时。

### P2 — URI 跨 IPC 序列化无统一机制，revive 靠每个调用点手写

- 证据：IPC 信封只对 `Uint8Array` 做了标记还原，URI 落地成裸 `UriComponents`；全仓 50+ 处手写 `URI.revive`，main 侧同一 `toURI` helper 抄了 5 份（fileSystemMainService.ts:27 / fileSearchMainService.ts:32 / fileWatcherMainService.ts:98 / textSearchMainService.ts:90 / workspaceMainService.ts:55）。
- 已发生真实回归：realpath 返回 URI 未 revive 致 `.fsPath` 为空的 @p1 bug（修复痕迹 `renderer/services/extensions/MainThreadFs.ts:63`）。
- 建议：信封 replacer/reviver 对 URI 加 `$mid` 式标记（照抄 VSCode marshalling），一次性消灭该 bug 类。

### P2 — ACP stdout 转发仍无背压（上一轮 P0-3 未做）

- 证据：`acpHostMainService.ts:201-211` stdout/stderr 直接 `fire`，无任何 `pause/resume/highWaterMark`；ChannelServer 事件推送 fire-and-forget（`ipc.ts:310-315`）。
- 影响：agent 大流量输出 + renderer 消费慢时 main 侧缓冲无界堆积。【推测：实际内存尖峰幅度未测量，维持"先测量再决定"】

### P3 — `ProxyChannel.fromService` 暴露实现类全部公有方法，无 wire 契约白名单

- 证据：`proxyChannel.ts:77-102` 按名字分发到任意 function 属性；`registerMainServices.ts:104-107` 把具体类挂上通道，main-internal 的 `registerWindow/unregisterWindow` 及所有服务的 `dispose()` 都可被 renderer 经 IPC 调到。
- 影响：renderer 是可信端，无直接安全洞，但一次误调（或将来嵌不可信 webview 复用此协议）可打挂单例服务。建议 fromService 支持显式方法白名单或以 wire 接口 Pick 收窄。

### P3 — IPC 错误只传 message 字符串，类型/code/stack 丢失

- 证据：`ipc.ts:295-297`；下游被迫正则匹配错误语义（`acpHostMainService.ts:249` `/not writable|has exited/`）。改一处 message 措辞即破坏远端判断。

### P3 — windowMainService 仍是 725 行多职责聚合

- 证据：一个类承担窗口创建+webPreferences、per-window 服务工厂（:267-314）、IPC bootstrap、崩溃恢复、close/quit veto 编排、session 持久化+几何恢复（:674-710）。前置条件（补测试）已完成，拆分风险已降。

### P3 — 通道注册三处手工同步，纯靠 convention

- 证据：加一个跨进程服务要同时改 `channelNames.ts`、`main-services.ts` + ApplicationServices + `getOrCreateServices`（`index.ts:393-422` 的 28 行手抄表）+ `registerMainServices.ts` + `renderer/main.tsx`，共 5-6 处；漏一处是运行时 "Channel not found" 而非编译错。【推测：可用"通道描述符表"一处声明收敛】

### P3 — 事件订阅按 `${channel}:${event}` 去重，忽略 `arg`

- 证据：`ipc.ts:308` 与 `ipc.ts:214-228`。当前无参数化事件消费方故未爆；将来若有人给 `listen(event, arg)` 传不同 arg，两个订阅会互相顶掉。

### P3 — node-pty 与散点 spawn 未入 ManagedChildProcess（有意的非统一，非缺陷）

- `terminalMainService.ts:204-239` `pty.kill()` 无超时升级；探测类短命进程（where/which）与 detached fire-and-forget 属合理豁免；node-pty 有自身生命周期语义，收编收益低。

**Windows 孤儿进程现状**：主链路已治理（stdin-EOF 级联 + 树杀兜底 + before-quit await stopAll + will-quit 同步 taskkill）；e2e 侧孤儿清扫已随基建迁入 `@universe-editor/e2e-harness`。

## ④ 方向性建议

1. **优先补 IPC 层的两个系统性缺口**（性价比最高，都在 `packages/platform/src/ipc/` 一处改）：URI 自动 marshalling + ChannelClient dispose-reject / 反向 RPC 超时。二者都有既往真实回归背书。
2. **背压先测量再动**：给 acpHost stdout 加字节计数/水位日志，确认真实堆积量级后再决定是否上 pause/resume（全链路背压需应用层 ack，成本高）。
3. **windowMainService 拆分可以启动了**：先抽最独立的 session 持久化（`_persistSessionNow`/geometry 一族 → WindowSessionStore），再抽 per-window 服务装配。
4. **通道注册收敛为单一描述符表**：`{ name, contract, resolve(accessor), scope: 'app'|'window' }` 一处声明，三张手抄表由它派生；顺带让 fromService 吃 contract key 白名单，解决方法过曝。
5. **错误 marshalling 升级**：wire 上带 `{ name, message, code? }` 结构化错误，与第 1 条同批做。
6. **claudeBinary/codexBinary 高度平行**（resolve/download/prefetch/activeVersion/cleanup）：【推测】当前两份尚可容忍，**第三个 agent vendor 出现时**是抽 `BinaryDownloadManager` 骨架的重构触发点。
