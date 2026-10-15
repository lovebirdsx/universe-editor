# extensions/perforce/src/p4delta/CLAUDE.md

δ 引擎（`p4delta`，外部 Rust 单文件 CLI）在本扩展里的一切：**spawn 封装 + 副本解析**（`p4deltaService.ts`）+ **记录的纯解析**（`p4deltaParser.ts`）+ **运行日志的有界落盘**（`p4deltaRunLog.ts`）+ **托管副本的自动安装/升级**（其余四个文件）。δ 是可选加速：任何一环出问题都回退原生 p4，绝不改变语义（叙事与契约硬条款见 [`../../docs/reconcile.md`](../../docs/reconcile.md)）。

> 本目录**除 `p4deltaService.ts` 外一律不 import `@universe-editor/extension-api`**：宿主能力（存储路径、日志、通知、进度）全部注入，所以这几个新模块可纯单测、可整体上移成包。改这里时保持这条。

## 运行日志（`p4deltaRunLog.ts` + `extension.ts` 的 sink）

一次真实尝试 = 一个 `runId`（时间 + pid + 进程内序号 + 随机，`_spawn` 里生成）+ 一个日志文件。`P4deltaService` 只把**已格式化**的行（接收时间 + 单调相对耗时 + runId + 正文）推给注入的 `P4deltaLogSink`；输出走两条——`P4delta` 输出频道（实时）与 `<globalStoragePath>/p4delta-logs/<runId>.log`（落盘）。Perforce 频道只留开始 / 结束摘要与 runId（`client.ts` 的四处全量回放已删——时间戳会全同，且把 p4 自己的账埋掉）。

几条承重性质，改 `p4deltaRunLog.ts` 前先读 `__tests__/p4deltaRunLog.test.ts`：`append` 永不抛永不阻塞、异步串行写、正文预算耗尽后只留一次截断标记、**终态行有尾部预留**（`appendFooter`，截断也要留住结论）、`.writing` → `.log` 只在收尾时改名、清理只动已结束文件且**另一个窗口正在写的 `.writing` 不碰**（超期遗留才收）、更名/淘汰按 mtime 从新到旧。读取端（`readSnapshot`）先校验 runId 形状、再校验专用目录前缀、再拒绝符号链接：调用方给的 id 永远不能变成任意路径。

服务侧另有两处**内存有界**（不落盘也生效）：`P4deltaService` 的 `result.log` 是**有界尾部**（`P4deltaLogTail`，最后 200 行 / 128 KiB；逐行诊断照旧实时送 sink），`P4deltaRunEnd.summary` 是 summary 记录的**有界摘要**（只摘 mode / ok / counts / elapsedMs / p4Calls / p4CallsByCommand，<= 8 KiB；由 sink 收尾时作为**页脚**写出，正文被截断也留得住「这 N 次调用花在哪」，且不与实时进频道的 summary 记录逐字重复）。

落盘只在本机 / 远端 host，**不上传**；运行头不写环境变量、不探测引擎版本（路径与 argv 已经够定位）。日志里可能有工作区 / depot 路径，用户文档已声明。

## 副本优先级（五级，`resolveP4deltaCommand`）

`UNIVERSE_P4DELTA_PATH`(env) → `perforce.p4delta.path`(configured) → **托管副本**(managed) → PATH → `%LOCALAPPDATA%\Programs\p4delta\p4delta.exe`。返回 `P4deltaCandidate { exe, source }`，`source` 只用于日志与判定。**托管副本排在 PATH / 系统安装目录之前**：它是编辑器唯一能持续升级的那份，被机器上更旧的自装副本遮蔽就永远升不上去。env / configured / PATH / `%LOCALAPPDATA%` 任一级命中即完全不联网（不查上游、不下载）；托管副本命中则进入后台升级（它归编辑器维护，`autoInstall` 关掉时只停这条后台升级、不改变解析顺序）。地址门在 `extension.ts` 的 `resolveP4deltaEngine`（保持同步，只做一次 `existsSync`，**无版本地板**——见 [`../../docs/reconcile.md`](../../docs/reconcile.md) 的「无版本门槛」，别顺手加 `--version` 探测；唯一的采样是「显示 p4delta 信息」命令里那次纯显示的 `probeP4deltaVersion`，不参与准入，且它自己 `existsSync` 兜底——脚本形态下 `node <不存在的脚本> --version` 会答 node 自己的版本）。

`p4deltaNamedExplicitly(configuredPath)` = env 或配置路径非空，即「操作者说这份是我的」；`resolveP4deltaCommand(configuredPath)`（**不传 `managedRoot`**）非空 = 这台机器自带副本。这两个谓词是安装器的两条早退判据，**复用它们，别另造判断**。

## 自动安装（`p4deltaEnsure.ts` 编排，`p4deltaStore.ts` 承重）

**该不该装**（`ensureP4delta`，六条零网络早退，各一行日志）：`root === ''` → 非 win32 → `!enabled`（总开关 `p4delta.enabled`）→ `!autoInstall && !force`（`autoInstall` 只约束后台路径）→ `namedExplicitly` → **本会话 p4 是脚本覆盖**（门在那种形状下根本不启用托管副本，装了只会闲置；注入 `p4IsScriptOverride`，`extension.ts` 从 `resolveP4Command()` 现算）→ 机器已有自装副本**且本安装尚无托管副本**（本安装已有托管副本就继续走升级，否则机器上更旧的自装副本会把它钉死在首次下载的版本上）。`force=true`（手动命令）跳过中间第二条与最后三条，**只有总开关拦得住它**——关掉 `autoInstall` 的人正是这条命令的目标用户。

**装成之后**（`result.changed` → `watchP4delta.refresh()` → 每个 client 的 `setP4delta`）：新的 exe 与「重排本会话扫描轮」是同一件事的两半——`setP4delta` 会撤回「δ 能答这个工作区」的扫描判定（证明属于跑过扫描的那个二进制），没有重排它就一直停在 native、装好也整会话用不上；升级（换 exe）同一条路径，且 δ 的 checkpoint 键带 exe 身份，旧 build 的快照不会被新 build 重放。见 [`../../docs/reconcile.md`](../../docs/reconcile.md) 的「扫描引擎按会话择一」。

**磁盘布局**（`<globalStoragePath>/p4delta`，全局共享、跨工作区跨窗口）：

```
<版本>/p4delta.exe          一版本一目录；升级 = 落新目录 + 翻指针，绝不覆盖运行中的 exe
<版本>.extract.<pid>.<n>/   解压暂存（同卷 → rename 廉价）
<版本>.zip.<pid>.<n>        下载暂存
.active                     纯文本，当前生效版本 —— 唯一真相
.check                      {nextCheckAt, ok, version?}：节流戳 + 上次结果 + 保留集所需 latest，一份文件兼三职
```

**四条并发不变量（不加锁文件，这是正确性承重条款不是容错润色）**：① 落盘前先 adopt（`<ver>/p4delta.exe` 已在盘 → 零网络直接成功）；② **rename 失败但目标已有 exe = 成功**（另一窗口抢先做完同一件事，两份字节相同——摘要已对同一 release 校验过），否则 5 次退避重试防杀软短锁；落盘时目标目录**移开而不是删除**、失败再移回——那份可能是另一窗口刚放好且 `.active` 已指向的副本，删了它再失败就留下悬空指针（＝整个会话静默回落原生）；③ 暂存目录带 `pid` + 进程内序号，两个 store 实例不互踩；④ 进程内 `inflightSyncs` 按 root 去重，并发 `sync()` 共享一个 promise，**但 `force` 调用例外**：等那次落定后自己再跑一遍——用户点「安装」时自带进度与取消，不能被别人的那次代答（节流决定与回调都不是他的）。指针写入一律 `写 <name>.<pid>.tmp → rename`。

**下载流程**：查 latest（github 走发布页 `…/releases/latest` 的 302，`redirect:'manual'` 读 `Location` 解 `…/releases/tag/<tag>`；镜像读 `<base>/latest.json`）→ 版本比较（`latest <= active` 即 `up-to-date`，零字节下载）→ **先取 `SHA256SUMS` 再下载**（缺清单/无该条目/摘要不符 = **拒绝安装**，fail-closed，不留目录不留指针）→ 流式下载（`Readable.fromWeb` + Transform 同时计量与 `createHash('sha256')`）+ `maxDownloadBytes`(64MB) 兜底 → adm-zip 只按**精确名字**取 `p4delta.exe` 一个 entry（zip-slip 不可达）→ rename 落盘 → 翻指针 → 删暂存。**URL 一律构造，不读 `assets[].browser_download_url`**（镜像那项的该字段会指回 github.com）；**资产** URL 的两源差异只落在 `p4deltaUpstream.ts` 的 `releaseBaseUrl()`。

**latest 为什么不查 api.github.com**：未认证 REST 配额是 **60 次/小时/IP**（按出口 IP，不按机器/用户），一个公司 NAT 后所有机器共享同一个桶——先装的把还没装的挤成 403 `API rate limit exceeded`（已实测复现：同请求第 60 发 200、第 61 发 403）。发布页 302 不占该配额，所以默认源只打 github.com；**别再"顺手"换回 API**。失败原因现在带响应体前 200 字符 + `x-ratelimit-*` 计数——只记 `HTTP 403` 时**限流与代理拦截无法区分**（两种都实测过）。

**永不 throw**：每段 try/catch 把任何异常转成 `{kind:'failed', reason}`，`sync()` 再套一层 `.catch`；`finally` 必清暂存（失败不清会让状态永远卡住）。`failed` 的日志由 `ensureP4delta` 统一写（store 只上报）。

**取消 ≠ 失败**：`{kind:'cancelled'}` 单列一支，**不写 `.check`**——用户取消是他自己的决定，不是对上流的判决；写成失败退避会让「取消一次手动安装」把后台自动检查静音一小时。

**节流**（GitHub 未认证 60 req/h）：成功 24h、失败 1h、尊重 `Retry-After` 与 `x-ratelimit-reset`（下限 1h、上限 24h）；`force` 绕过节流。

**保留集** = `{.active 指向的} ∪ {.check.version} ∪ {盘上最高版本}`，安装成功后每会话至多清一次；`.extract.*`/`.zip.*` 超 1h 才扫（别误删另一个进程正在写的）。

**镜像契约**（`perforce.p4delta.downloadBaseUrl`，machine scope，默认空 = GitHub；`UNIVERSE_P4DELTA_DOWNLOAD_BASE` env 优先，与 `UNIVERSE_P4DELTA_PATH` 同族）：`<base>/latest.json`(`{"version":"x.y.z"}`) + `<base>/SHA256SUMS`（上游原文件，无需改写）+ `<base>/p4delta-<版本>-x86_64-pc-windows-msvc.zip`。取值链与降级在 `resolveP4deltaSource(env, configured, log)`：值必须以 `http(s)://` 开头，否则**降级为 GitHub 默认源** + 日志一行——逃生舱不该有能力弄坏一台本来能用的机器；`http://` 允许（内网静态镜像多半没证书）但记一行警告，摘要与归档同走明文信道，它防的是下载损坏不是中间人。**镜像下 `SHA256SUMS` 同样强制**。

**平台**：`p4deltaTargetTriple` 只映射 `win32`+`x64`（上游仅此资产），arm64 与其它平台 → 日志一行 + 跳过。

## 验证

```bash
pnpm --filter @universe-editor/perforce test
pnpm --filter @universe-editor/perforce typecheck
```

测试全走**注入 `fetchImpl`**（不是 `vi.spyOn(globalThis,'fetch')`——注入是 store 自己的契约），zip fixture 用 adm-zip 现造，临时根用 `@universe-editor/temp-root` 的 `mkTempDir` + `removeDirWithRetry`。

e2e 对本目录免疫，而且不靠 fixture 做任何事（见 [`../../e2e/CLAUDE.md`](../../e2e/CLAUDE.md)）：perforce 的 e2e 一律把 p4 指成脚本（`UNIVERSE_P4_PATH` → fake-p4），命中上面那条早退，**每个 spec** 都是零网络、零磁盘写入。日后要 e2e 走「下载 → 激活 → spawn」时，惰性靠给 `UNIVERSE_P4DELTA_PATH` 命名一个引擎解除（δ 的那几个 spec 本来就这么做），下载源用 `UNIVERSE_P4DELTA_DOWNLOAD_BASE` 指到一个静态目录即可（无新代码）。
