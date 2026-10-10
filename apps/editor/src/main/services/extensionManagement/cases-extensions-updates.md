# 扩展更新提示 + 自动更新（对标 VSCode）

`extensions.autoCheckUpdates` / `extensions.autoUpdate` / `extensions.autoUpdateDelay` 三个设置驱动的整条链路。本文覆盖**状态机、排程、延迟语义、退订、升级残留清理**；四道安全闸门与安装落盘见 [CLAUDE.md](CLAUDE.md)。

## 分层与单一职责

| 层 | 文件 | 负责 |
|---|---|---|
| 主进程 | `extensionManagementService.ts` `checkForUpdates` / `updateExtensions` | 反查市场版本、批量安装（一次 `_enqueue`） |
| 契约 | `shared/ipc/extensionManagementService.ts` | `IExtensionUpdateCheckResult{updates,failure}` / `IExtensionUpdateOutcome{identifier,version?,error?}` |
| 门面 | `services/extensionsWorkbench/ExtensionsWorkbenchService.ts` | pending 状态、信任门禁、通知策略、退订读写 |
| 纯策略 | `services/extensionsUpdates/extensionUpdatePolicy.ts` | `planAutoUpdates` / `parsePublishedAt` / `updateSetSignature`（无 DI，node 单测） |
| 周期 | `services/extensionsUpdates/ExtensionsUpdateService.ts` | **唯一**读那两个设置并调 `updateAll(..., {silent:true})` 的地方 |
| 定时/徽标 | `contributions/ExtensionsUpdateContribution.ts` | 30s 首次 + 12h 间隔、活动栏徽标、`extensionsHasUpdates` context key |
| 设置项 | `contributions/ExtensionsConfigurationContribution.ts` | `ConfigurationRegistry` 三条（BlockStartup 注册） |
| UI | `workbench/extensions/{ExtensionsView,ExtensionsViewNotification,ExtensionEditor,ExtensionActionsMenu}.tsx` | 提示条 / 行内更新按钮 / 详情页按钮 / 自动更新开关 |

## 状态机（门面）

- `_pending: Map<id, IExtensionUpdate>` + `_pendingAuthority`：**一次检查只覆盖一侧**。`_pendingFor(id, remote)` 在 `remote !== (_pendingAuthority !== undefined)` 时返回 `undefined` —— 远端工作区里检查的是生效侧（远端），本机侧行因此天然没有更新按钮。
- `_entryFromLocal` 由 `_pending` 填 `outdated` / `updateVersion`；`refreshInstalled()` 末尾 `_prunePendingUpdates()` 剔除已卸载或版本已追平的条目（徽标随之消失，无需额外清理）。
- `_checkOutcome: {kind:'failed',message} | {kind:'up-to-date'}` 供提示条的「失败 / 最新」两个变体；`checkForUpdates` 每次都重置 `_dismissedSignature`。
- 提示条签名 = `updateSetSignature(pending) + '|' + _checkOutcome?.kind`：pending 集合或结果变化即重新出现，关闭（`dismissExtensionsNotification`）只记内存态，**不用 `INeverShowAgainOptions`**（那是永久全局 opt-out，对状态型提示语义不对）。

## 通知策略：事件才提示，状态不提示

- 后台检查走 `_notifyPendingTransition`：签名与上次相同则**不提示**（12 小时重复「有 3 个更新」是噪音；徽标 + 提示条已承载状态），空集合不提示。
- 显式检查走 `_notifyExplicitOutcome`：**总是**汇报，含「已是最新」与失败。
- `updateAll` 最多一条 Info + 一条 Error（`_notifyUpdateRun`），绝不每扩展一条；第三条只在**用户发起**的运行里出现——`skipped` 非空时补一条 Info。自动运行按设计跳过未受信任 publisher 且保持安静（更新仍挂在徽标与提示条上，等用户手点），用户自己发起的运行则欠他一句交代。

## 排程（`ExtensionsUpdateContribution`）

- `AfterRestore` 注册；首次延迟 30s（避让启动高峰，同 `UpdateContribution` 先例），之后 `setInterval` 12h。
- `check()` 返回 `nextEligibleAt?`（延迟窗口里最早可应用的时刻）时，插一个一次性 timer 到点重跑——这是**唯一**的提前重查入口；`MIN_RECHECK_MS = 1s` 防止时间戳异常导致 0 延迟忙轮。
- 配置变更只重排定时器，不立即检查（`affectsConfiguration` 是**精确 key 匹配**，三个 key 逐个枚举，写 section 名会静默漏事件）。

## 延迟语义（`extensions.autoUpdateDelay`，默认 2 小时）

- **只作用于自动更新**：手动点按钮、`Update All`、显式检查都不看它。
- 时间戳缺失 / 不可解析 → **立即应用**。延迟是防「刚发布的坏版本被自动拉进来」的礼貌窗口，**不是安全闸门**，不能 fail-closed。
- `nextEligibleAt = min(publishedAt + delayMs)`，只在有 `delay` 类跳过项时才有值。
- **刻意不做「受信任 publisher 免延迟」**：本仓库里能装上的 gallery 扩展，publisher 必然已在 `extensions.trustedPublishers`（装的时候问过了），豁免等于恒真 → 会变成一个骗人的旋钮。当前 VSCode 也已改为纯延迟。

## 逐扩展退订

- `setAutoUpdateEnabled(id, false)` → GLOBAL storage key `extensions.autoUpdateDisabled`（`string[]`），构造时 `_loadAutoUpdateOptOut` 读回；镜像 `_trustedPublishers` 的读写形态。
- **不做 `pinned`**：仓库设置编辑器没有列表型 UI，存储先例即 `trustedPublishers`。
- 只挡自动更新——`planAutoUpdates` 把它记成 `optedOut` 跳过，手动更新照常。

## silent ≠ 跳过信任门

`update(id, {silent:true})` 与 `updateAll(ids, {silent:true})` 的语义是**不弹信任框**，不是跳过闸门：`silent` 时 publisher 未受信任 → 该更新**跳过**（等用户手点），绝不自动确认。自动更新路径因此不会替用户建立信任。跳过项记进返回值的 `skipped`，由调用方决定说不说（当前：`updateAll` 在非 silent 时补一条 Info）。

## 批次 = 一次宿主重启

`_restartQueue` 串行但**不合并**，N 次安装 = N 次宿主重启（连带杀语言服务器）。所以：

- 自动更新与 `Update All` 走 `updateExtensions`（单次 `_enqueue`），主进程用 `_batchDepth` 计数让 `_notifyChanged()` 整批只 fire 一次 → `onDidChangeExtensions` 一次 → host 重启一次。
- 信任检查在 renderer 侧**先顺序做完**再发一次批量调用（信任框是逐 publisher 的，不能并发弹）。

## 升级残留：升级即替换旧版本

`installVsix` 曾只写新记录、不删同 id 旧记录与旧文件夹 → `extensions.json` 与宿主扫描同时列出新旧两版（`findInstalledExtension` 返回旧记录、卸载只删一个文件夹、详情页显示旧版本号）。现在：

- `planSupersede(records, id, keepLocation, {keepRecordAtLocation})` 返回 `{kept, folders}`（纯函数）。`keepRecordAtLocation` 区分两种路径：普通安装传 `false`（同位置旧记录也要换掉），幂等短路（磁盘内容已是目标版本）传 `true`（保留该记录，只回收**别的**文件夹）。**按 `location` 而非 `version` 过滤**——同版本指向别的文件夹也要回收。同版本 gallery 重装若传错，会写出两条同位置记录（有单测守着）。
- `deleteSupersededFolders`：rename-then-delete，占用则退回 `.obsolete` 标记，交给 `sweepObsolete` 下次启动清。
- 顺序仍是**先写记录、再删文件夹**（与 `uninstallExtension` 一致）：中途失败留下的是可被下次扫描回收的孤儿目录，而不是「记录指向已删目录」。
- `uninstallExtension` 删同 id **全部**文件夹；`findInstalledExtension` 取 `compareVersions` 最大的记录。
- `reconcileInstalledRecords(dir, logger)`：清历史遗留的重复记录（每个 id 只留最新）。挂在两个启动清扫点——main `_sweepObsolete` 与 remote `_sweepOnStartup`。

## 检查结果必须诚实

「注册表不可达」与「全部最新」不能是同一个答案。但市场服务有一条**红线**：`query` / `getExtensions` 任何网络失败都降级返回空（浏览列表不可用比崩掉好）。所以更新检查走**另一个查询口** `getExtensionsForUpdate(ids) → {extensions, failure?}`（`IManagementGallery` 只有这个方法，`_computeUpdates` 因此**没有 try/catch**）：未配置市场、网络失败都报 `failure`，`checkForUpdates` 原样带回 renderer。契约类型因此变了——所有调用点读 `.updates`。

## 状态归属：pending 属于「某工作区的某一侧」

- `_pendingBelongsToCurrentWorkspace()` = `_pendingAuthority === this._authority`（`undefined` 是合法 authority，**比较而非真值判断**）。`getPendingUpdates` / `update` / `updateAll` / `_pendingFor` 全部先过这道闸：切换工作区后旧集合不能继续提供按钮，更不能把安装打到用户已经离开的宿主上。
- 工作区切换（authority 变化）时清 `_pending` / `_pendingAuthority` / `_checkOutcome` / `_dismissedSignature` 再 `refreshInstalled()`。
- `updateAll` 的返回带 `skipped: string[]`——因信任被跳过（用户拒了信任框，或 silent 路径下 publisher 未受信任）的 id。**找不到 entry 的 pending 项不算 skipped**：那是下次刷新会剪掉的陈旧项，不是用户决定。

## 刻意不做

- **不加 `extensions.autoRestart`，不做「需要重启」提示**：`ExtensionsContribution` 在每次 `onDidChangeExtensions` 都 `refreshExtensions()`（stop→start→重翻译→重放激活），更新秒级生效，本仓库**不存在** restart-required 状态。
- **不把 `outdated` 做成 renderer 侧的独立反查**：复用主进程 `checkForUpdates`（已有 `source==='gallery'` 过滤 + `pickCompatibleVersion` + semver 比较，本地/远端都覆盖）；泛化 `_prefetchRemoteGallery` 会给每次 `refreshInstalled()` 加一趟网络且仍不覆盖远端。
- **远端只查生效侧**：扩到双侧只需多一次 `checkForUpdates(undefined)` 与第二个 map key，本次不做。

## 已知边界

1. 只有 `source === 'gallery'` 的扩展参与（本地 `.vsix` 装的、内置的、dev 都不提示）。
2. 自动更新在用户工作时触发宿主重启，靠 12h 节奏 + 延迟窗口收敛；若打扰明显，后续再加「宿主空闲才应用」。
3. **设置节 `id: 'extensions'` 有两个注册点**：本功能的 `ExtensionsConfigurationContribution`（BlockStartup，常态窗口生效）与 `ExtensionDevelopmentAutoReloadContribution`（extension-dev 环境才注册）。三处合一在 ext-dev 窗口外会让 `autoRestartOnChange` 消失，故**不合并**——代价只是 extension-dev 窗口的设置页出现两个同名分组（`explorer` 节已有同样先例）。

## e2e 注意

`smoke.extensionsGallery.spec.ts` 必须 `beforeEach` 关掉 `extensions.autoCheckUpdates`：30s 首次检查可能在 spec 中途落地并偷偷装上更新（**这是本功能最可能的 CI flake 源**）。探针 `runExtensionsUpdateCycle(auto?)` 确定性驱动一个周期；`installGalleryExtension` 现顺带把 publisher 记进 `extensions.trustedPublishers`（否则 facade 的更新路径会弹信任框卡死 spec）。
