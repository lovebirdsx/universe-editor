# 计划 01 · main 主进程健壮性

> 配套总览：[README.md](./README.md)
> 范围：`apps/editor/src/main/`（约 11000 行，54 源文件，35 测试）
> 主轴：**收编散落的子进程管理** + **子进程健壮性（kill 超时 / 崩溃）** + **DI 注册去脆弱化** + **关键服务补测试**。

---

## 现状肯定（不要动的好设计）

- preload 严格白名单：`src/preload/index.ts` 只暴露 IPC bridge + 少量带类型守卫的方法，production 天然剥除 E2E 探针。
- 密钥红线落实：`safeStorage` 加密落盘，DTO 显式无密钥，renderer/settings.json 零明文。
- 生命周期统一：root 容器单例 eager 实例化，`will-quit` 统一 dispose（见 `main-services.ts` 头注释）。
- per-window 与 application 单例边界清晰（per-window 服务由 `windowMainService.createWindow()` 手动构造，不进 root 容器）。
- AI 流式泵送 `_pumpResponse`（`aiModelMainService.ts:387-405`）错误处理完备——**经核实非 bug，勿改**。

---

## P0 · 统一子进程管理抽象

### 问题
主进程有 **8 处独立 spawn 子进程**，各自重写 spawn 参数拼装、stdout/stderr 监听、kill、超时、崩溃恢复逻辑，**无任何统一抽象**（`git grep` 确认无 `ChildProcessManager` 类）。

### 证据
散落点（均含 `spawn(` / `ELECTRON_RUN_AS_NODE` / `child_process`）：
```
src/main/services/acpHost/acpHostMainService.ts          # ACP agent 子进程（claude/codex）
src/main/services/acpTerminal/acpTerminalMainService.ts  # agent 终端
src/main/services/claudeBinary/claudeBinaryMainService.ts # claude 二进制探测/下载
src/main/services/codexBinary/codexBinaryMainService.ts   # codex 二进制
src/main/services/extensionHost/extensionHostMainService.ts # 扩展宿主（双 host）
src/main/services/host/hostMainService.ts                 # 打开外部程序
src/main/services/terminal/terminalMainService.ts         # 集成终端（node-pty）
src/main/services/textSearch/textSearchMainService.ts     # ripgrep
```

### 影响
- **可维护性**：spawn 的环境变量处理（`ELECTRON_RUN_AS_NODE`、PATH、cwd）、Windows 转义、退出码语义各写一份，行为不一致。
- **可扩展性**：加新子进程（未来新 agent vendor / 新工具）= 抄一份现有 service，复制全部样板。
- **健壮性**：kill 超时、僵尸进程清理、异常退出重启策略无法集中保证（见下方 P0-2 的具体缺陷）。

### 落地步骤
1. 在 `src/main/services/process/`（新建）写 `ManagedChildProcess` + `IChildProcessManager`：
   - 统一封装 `spawn`（含 `ELECTRON_RUN_AS_NODE` 模式、env 合并、cwd、Windows `shell` 处理）；
   - 统一 stdout/stderr → `Emitter` 桥接（含可选行缓冲）；
   - 统一 `kill(signal?)`：**先 SIGTERM，超时（如 2s）未退则 SIGKILL**（解决 P0-2）；
   - 统一退出事件 `onDidExit({ code, signal, killed })`；
   - 可选崩溃重启策略（指数退避 + 最大次数），供 acpHost / extensionHost 复用。
2. **渐进迁移**：先迁 `textSearch`（最简单、风险低）验证抽象，再迁 `acpHost` / `extensionHost`（最复杂、收益最大），其余随手迁。
3. 单测覆盖：SIGTERM→SIGKILL 升级、超时、stdout 桥接、退出码语义（用 fake spawn 注入，不真起进程）。

### 验证
`pnpm check`；迁移每个 service 后跑其相关 e2e（acpHost 迁移后跑 `smoke.agents*`）。

---

## P0 · 子进程 kill 缺强制超时（僵尸风险）

### 问题
取消/限流时调用 `child.kill()`，默认 SIGTERM，**无 SIGKILL 兜底超时**。Windows 上部分子进程（ripgrep 大目录扫描中）可能不立即响应 SIGTERM。

### 证据
`src/main/services/textSearch/textSearchMainService.ts:229-232`：
```ts
const stopForLimit = (): void => {
  running.killedForLimit = true
  child.kill()        // 仅 SIGTERM，无超时升级
}
```
（`cancel()` 路径同样问题。其余子进程 service 的 kill 也需逐一核查。）

### 影响
搜索频繁取消时，未退出的子进程累积占用 CPU/句柄。虽然 ripgrep 通常会自行结束（故非"必崩"），但作为长期运行的桌面应用，缺超时兜底是确定的健壮性缺口。

### 落地步骤
- 随 P0（ChildProcessManager）一起解决：统一 `kill()` 实现 SIGTERM→（2s）→SIGKILL 升级，记录被强杀的进程到日志。
- 若不先做 ChildProcessManager，可先在 textSearch 局部加超时升级作为过渡。

### 验证
单测：kill 后超时触发 SIGKILL（fake child）。

---

## P0 · ACP stdio 流无背压

### 问题
agent 子进程的 stdout/stderr 监听器直接 `fire()` 事件转发给 renderer，无 pause/resume 背压。agent 密集输出（大段流式回复）时，若 renderer 消费慢，主进程侧事件/缓冲堆积。

### 证据
`src/main/services/acpHost/acpHostMainService.ts:228-235` 一带：data 监听直接 `fire`，未在下游拥塞时 `stream.pause()`。

### 影响
大输出会话内存尖峰；与计划 02 的 16ms 批处理竞态叠加，是流式卡顿的 main 侧诱因。

### 落地步骤
- 在 ChildProcessManager 的 stdout 桥接中支持背压：下游（IPC）拥塞信号到达时 `pause()`，排空后 `resume()`。
- 或在 acpHost 侧对 stdout 加高水位缓冲 + 暂停读取。
- 需先确认 IPC 层能否反馈拥塞（ProxyChannel 事件是 fire-and-forget，可能需要应用层 ack/窗口机制）——**先测量再决定实现深度**。

### 验证
构造慢消费者 + 高频 producer 的单测，断言不无界堆积。

---

## P1 · main DI 注册的 `undefined` padding 脆弱

### 问题
`registerSingleton` 用 `SyncDescriptor` 时，构造函数前置静态参数要手动用 `[undefined, undefined, ...]` 补齐槽位，数量必须与 `@inject` 起始位置精确对齐，否则内核 `console.trace` 并自行 padding。

### 证据
`src/main/services/main-services.ts:93-112`：
```ts
registerSingleton(
  IAcpHostService,
  // 3 leading static params (spawn, lookup, resolveNodeEntry) before @ILoggerService.
  new SyncDescriptor<IAcpHostService>(AcpHostMainService, [undefined, undefined, undefined], false),
)
// ExtensionHost 要 5 个 undefined；改构造函数签名就要同步数 undefined 个数
```

### 影响
改某个 service 的构造函数参数顺序/数量时，极易忘记同步 padding 个数，且错误只在运行时以 `console.trace` 出现，不报编译错。注释自己都承认这个坑。

### 落地步骤
- 给这类"前置静态参数有默认值"的 service 提供**具名工厂**而非位置 padding。两种方案择一：
  - A) 让这些 service 的静态依赖（spawn stub / 路径解析）改为**可选构造参数对象** `{ spawn?, resolveEntry?, ... }`，默认值在构造内部兜底 → `SyncDescriptor` 不再需要 padding。
  - B) 引入 `registerSingletonFactory(IFoo, (accessor) => new Foo(realStatics, accessor.get(...)))` 的注册重载，显式构造，消灭 undefined 数槽。
- 优先 A（改动局部、最贴近现状语义）。

### 验证
`pnpm check`；确认改后 `main-services.ts` 无裸 `undefined` 数组；启动无 `console.trace` padding 警告。

---

## P1 · 关键 main 服务零测试

### 问题
多个高频改动、承载核心职责的 main 服务 `__tests__` 为空。

### 证据（`__tests__` 为 0 行的服务，节选高风险者）
```
window/      631 行  windowMainService（窗口创建/IPC bootstrap/session 持久化/生命周期，职责最重）
fileWatcher/ 313 行  （parcel watcher，memory 记录过 flaky）
userData/    373 行  （用户数据读写一致性）
workspace/   336 行  （打开文件夹 / recent）
textSearch/  369 行  （ripgrep 编排 + 取消 + 限流）
codexConfig/ 440 行
```

### 影响
这些是回归高发区（窗口/会话/文件），无测试网时重构和改 bug 风险大。

### 落地步骤（按风险排序补测试，每个 30-60 行起步）
1. `windowMainService`：窗口创建 → IPC bootstrap → dispose 时序；session 持久化往返。
2. `fileWatcherMainService`：watch / setExcludes / unwatch；debounce 行为（注意 memory 记录的 flaky，用 fake timer）。
3. `userDataMainService`：读写一致性、并发写、损坏文件降级。
4. `textSearchMainService`：取消路径、限流（maxResults / maxMatchesPerFile）、kill 超时（配合 P0-2）。

### 验证
`pnpm --filter @universe-editor/editor test`（main project，node 环境）。

---

## P1 · windowMainService 职责过载（631 行）

### 问题
单个 service 混了：窗口创建+配置、IPC bootstrap、per-window 服务工厂、session 持久化、生命周期确认。

### 证据
`src/main/services/window/windowMainService.ts`（575 行主文件 + 关联）——多职责集中。

### 影响
新功能改动易冲突，且无测试（见 P1 上条）。

### 落地步骤
- **先补测试再拆**。拆分方向（保持对外接口不变）：
  - `WindowFactory`：BrowserWindow 创建 + webPreferences + per-window 服务装配；
  - `WindowSessionStore`：窗口/会话状态持久化与恢复；
  - `WindowLifecycle`：close 确认、will-quit 协调。
- 渐进式：先抽 session 持久化（最独立），再抽 factory。

### 验证
`pnpm check` + `pnpm e2e`（窗口/会话相关 smoke）。

---

## P2 · 顺手清理

- **AI 配置文件热重载竞态**（`aiModelMainService.ts:371-385`）：`_suppressUntil` 时间窗 + `fsWatch` + 200ms debounce 的组合，多窗口/外部编辑同时改 `aiSettings.json` 时理论上有读到中间态的窗口。后果上限是一次 `warn` + 重读，**低危**。可在 `_reload` 增加文件内容哈希比对，无变化则跳过。
- **主进程生命周期文档缺失**：ApplicationServices vs per-window 服务的实例化/dispose 时序、root 容器 eager 策略无成文。建议在 `apps/editor/CLAUDE.md` 补一节（仅在"确有必要"时，遵循项目非必要不更新原则）。

---

## 任务依赖与建议顺序

```
P0 ChildProcessManager ──┬─► 收编 textSearch（含 kill 超时 P0-2）
                         ├─► 收编 acpHost（含背压 P0-3）
                         └─► 收编 extensionHost / 其余
P1 DI padding（独立，可随时做）
P1 补测试 ──► P1 windowMainService 拆分（测试先行）
```

建议先做 P1 的 DI padding（小而独立、立竿见影）与 textSearch 补测试，再启动 ChildProcessManager 抽象（先拿 textSearch 练手）。
