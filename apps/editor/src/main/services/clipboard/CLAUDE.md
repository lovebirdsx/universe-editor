# apps/editor/src/main/services/clipboard/CLAUDE.md

文件剪贴板的 main 侧实现（`FileClipboardMainService` + 三个 OS backend + 远端物化器）。剪贴板状态**权威在 main 内存**（跨窗口共享、快照可带远端 URI），同时镜像到 OS 剪贴板供系统文件管理器粘贴。renderer 侧契约与阈值常量在 `apps/editor/src/shared/ipc/fileClipboardService.ts`，Explorer 侧的镜像/单向事件/粘贴决策在 `apps/editor/src/renderer/services/explorer/CLAUDE.md`。本文是该目录的上下文地图（处理相关任务前通读）。

## 上下文地图

```
renderer 命令（IFileClipboardService proxy：writeResources / readResources / checkWriteCost / clear）
  │  ServiceChannels.FileClipboard（ProxyChannel）
  ▼
FileClipboardMainService  —— 权威状态（entries/isCut/osSignature/wroteAtMs/generation）+ 所有权模型 + 阈值预算
  ├─ IOsClipboardBackend（createOsClipboardBackend 按平台分派）→ OS 剪贴板
  │    Windows: CF_HDROP（spawn PowerShell）  Linux: x-special/gnome-copied-files  mac: NSFilenamesPboardType
  └─ ClipboardMaterializer（localRevealFsPath 无本地路径时）→ <temp>/universe-editor/clipboard/<session>/
```

接线按套路 C 五处：`shared/ipc/channelNames.ts`（`FileClipboard` 通道名）、`shared/ipc/fileClipboardService.ts`（契约 + 阈值常量）、`main/services/main-services.ts`（`registerSingletonFactory`；backend 的 tempDir 与物化根分别取 `app.getPath('temp')` 与 `<temp>/universe-editor/clipboard`）、`main/ipc/registerMainServices.ts`（`fromService`）、`renderer/ipc/registerProxyServices.ts`（`toService`）。是 application 级单例（`ApplicationServices.fileClipboard`），**所有窗口共享同一份状态**。

## 所有权模型（FileClipboardMainService）

「OS 剪贴板还是不是我们写的」决定读哪个真相：

- 每次 write 提交 `osSignature` = **backend 实际写入 OS 剪贴板的内容串本身**（Windows 换行拼接路径 / Linux gnome 载荷 / mac plist 文本），不是另造的格式标记。
- `readResources`：写入后 **5s 宽限期**内（或有 in-flight 写入）不读 OS，直接返回内存快照——我们自己 spawn 的写入还没落地，此刻读 OS 必然误判「所有权丢失」。宽限期过后才读 OS 比对 signature：一致 → 仍是 owner（顺带刷新宽限期，连续粘贴不必每次都 spawn 读）；不一致 → 被别的应用覆盖，内存状态作废、回退 OS 内容（`source: 'os'`）。
- `clear()` 只在**仍持有所有权**（signature 比对通过）时清 OS 剪贴板，否则只清内存——无条件清 OS 会把用户刚在别的应用里复制的东西抹掉。清之前还要等完所有 in-flight 写入（它们可能晚落地，把已清的剪贴板重新填上）。
- `generation` 防过期写入：写入中途又有新 write，旧的物化结果/OS 写入结果一律丢弃，不覆盖新状态。
- 内存快照永远保存**原始高保真 URI**（含 `remote-ssh://`），物化只影响写进 OS 的那份路径——跨窗口粘贴走内存快照，远端资源不降级。

## 三个 OS backend

### Windows（osClipboardWindows.ts）—— spawn PowerShell 写真 CF_HDROP

**为什么必须 spawn PowerShell**：Electron `clipboard.writeBuffer('CF_HDROP', …)` 走 `RegisterClipboardFormat`，注册出的是**新格式 ID（0xC000+）而不是预定义的 15 号 CF_HDROP**，资源管理器读不到文件列表。写真 CF_HDROP 只能经 `System.Windows.Forms.DataObject`。

**为什么固定 `powershell.exe`（5.1）不用 pwsh 7**：pwsh 移除了 `-STA`，而 `Windows.Forms.Clipboard` 在 MTA 下不可用。

**为什么不走 `-Command -` + stdin 传脚本/数据**：PS 5.1 按控制台 codepage 解码 stdin，非 ASCII 路径必乱码。所以用三文件协议：静态 `.ps1` 脚本 + 用户数据 JSON 文件 + 结果 out 文件。脚本文件必须 **UTF-8 带 BOM**（PS 5.1 把无 BOM 文件按 ANSI 解码）；结果也不走 stdout（`[Console]::OutputEncoding` OEM codepage 会乱码）。**脚本模板静态、用户数据（路径列表 + dropEffect）只进 JSON 文件**——路径永远不出现在脚本文本里（注入安全设计）。

**cut 语义**：CF_HDROP 本身没有动作位 → 同一个 DataObject 里加 `Preferred DropEffect` 流（DWORD：1=copy / 2=move），Explorer 粘贴时按它行事；读侧从该流恢复 isCut（缺失按 copy）。同一个 DataObject 还 `SetText` 了路径文本——所以 Windows 上复制文件后终端 Ctrl+V 能拿到路径（与 Linux 对照，见下）。

**固有限制**：CF_HDROP 是 ANSI（DROPFILES），系统 codepage 之外的字符会变 `?`——OS 层限制（Explorer 自己的复制同样如此），无解。

**降级**：PowerShell 不可用/超时/失败 → `clipboard.writeText` 写纯文本兜底并返回 `ok:false`，内存剪贴板状态照常可用。

### Linux（osClipboardLinux.ts）—— 单格式 gnome-copied-files

写 `x-special/gnome-copied-files`（Nautilus / Nemo / Caja / Thunar 都读，且能带 cut 动作）；**KDE Dolphin 不支持**。

**实测事实（Electron 43 本机真跑过，最值钱的三条）**：
- 每个 `clipboard.write*` 调用提交一份**全新剪贴板状态、替换掉所有格式**——`writeBuffer` 会把 text/plain 抹掉，反之亦然；
- 多格式 API `clipboard.write()` 在 Linux 上**完全不生效**；
- `availableFormats()` 在 Linux **不枚举自定义格式**（自己刚 writeBuffer 完也返回空），`readBuffer`/`has` 却能看到——所以读取侧直接 `readBuffer` 探测，别用 availableFormats 预检。

**取舍**：因为格式互斥，只写 gnome 格式、不能叠写 text/plain——代价是 Linux 上复制文件后**终端 Ctrl+V 拿不到路径文本**（Windows 因一个 DataObject 同时带 CF_HDROP 和文本所以两者都有）。读侧还回退读 `text/uri-list`（承接别的应用复制/拖放来的文件列表）。

### mac（osClipboardMac.ts）—— NSFilenamesPboardType

Finder 读的文件粘贴类型（XML plist 数组）。**best-effort**：仓库没有 mac 打包，代码路径必须存在但没真机验证过。该类型无 cut 动作位 → isCut 写侧忽略、读侧恒 false。

## 远端物化（clipboardMaterialize.ts）

- **何时物化**：`localRevealFsPath(uri)` 为 undefined（`remote-ssh://` 且不是 Windows 上的 WSL——WSL 可直接给 `\\wsl$\…` UNC 路径）。
- **布局**：`<temp>/universe-editor/clipboard/<sessionId>/<index>-<basename>`，每次写入开一个新 session 目录。
- **清理策略**：保留最近 2 个 session（OS 文件管理器里可能还有「粘贴」正在进行，别把文件从它脚下删掉）；启动时异步清 >24h 旧目录（同步清在 will-quit 会卡退出）。`clear()` 删当前 session。**排序不能只按 mtime**：同一时间戳 tick 内的两次写入会任意排序、可能删掉刚写的那个——`selectSessionsToDelete` 用目录名里单调的 `s<seq>` 做 tie-break（`sessionSeq`，非我们创建的目录返回 -1 排最后）。
- 物化走 `IFileService.copy`——跨 scheme 自动走 `copyAcrossProviders`（`packages/platform/src/files/fileSystemProvider.ts`）；**目标父目录要先 `mkdir`**（helper 不建父目录）。单个失败跳过 + 日志，不整体失败。递归深度上限 `MAX_COPY_DEPTH`（64，抛 `ELOOP`）防目录 symlink 环。

## 关键架构决策与「为什么」

- **main 内存做跨窗口剪贴板**：所有窗口共用 main 进程，内存即天然共享态；OS 剪贴板只是「给系统文件管理器粘贴」的镜像（OS 剪贴板只能带本地路径，承载不了远端 URI 与 isCut 语义）。
- **signature 比对 + 宽限期，而不是焦点轮询**：判定「OS 剪贴板还是不是我们写的」靠内容比对（我们自己刚写的内容串），不靠「当前焦点是不是我们的窗口」——后者跨窗口/跨应用都不可靠。宽限期防的是「自己 spawn 的写入还没落地」的竞态。
- **不做 OS 剪贴板焦点轮询**（renderer 侧同理）：剪贴板空不空只有读的时候才知道，所以 paste 键位/菜单不去门控（取舍见 services/explorer/CLAUDE.md）。

## 常见任务 → 改哪里

| 你想做 | 动哪 |
|---|---|
| 改确认/拒绝阈值 | `shared/ipc/fileClipboardService.ts` 常量（`FILE_CLIPBOARD_*`）+ `checkWriteCost` 预算逻辑；`_measureTree` 的遍历并发由 `fileClipboardMainService.ts` 的 `MEASURE_CONCURRENCY`（全局信号量，跨整个 walk 共享，嵌套树不会按深度放大洪峰）控制；测试可用构造器可选第 5 参 `limits?: Partial<FileClipboardMeasureLimits>` 注入小阈值驱动同一拒绝路径，避免 100k 节点的 CI 超时 |
| 改 OS 写入格式 / 读回逻辑 | 对应 `osClipboard{Windows,Linux,Mac}.ts` |
| 改所有权判定 / 宽限期 | `fileClipboardMainService.ts`（`OWNERSHIP_GRACE_MS` 等） |
| 加新平台 | 新 backend 实现 `IOsClipboardBackend` + `createOsClipboardBackend` 分派一行 |
| 改物化目录/清理策略 | `clipboardMaterialize.ts`（常量 `MATERIALIZE_*`） |

## 易踩坑速记

1. **别分次 writeBuffer 想共存多格式**：Electron 每个 write* 都替换整个剪贴板。Windows 上多格式靠「一个 DataObject 带全」；Linux 上无解，只能单格式取舍。
2. **PS 5.1 三坑**：必须 `-STA`（pwsh 7 没有）；`.ps1` 必须 UTF-8 带 BOM；数据别走 stdin/stdout（codepage 乱码），走 JSON 文件 + out 文件。
3. **宽限期内别读 OS**：`readResources` 写入后 5s 内 / 有 in-flight 写入时直接返回内存快照，否则必误判「所有权丢失」。
4. **Linux 探测自定义格式用 `readBuffer`**：`availableFormats()` 不枚举自定义格式，预检会得到「没有」的假阴性。
5. **CF_HDROP 是 ANSI**：非系统 codepage 字符变 `?`，不是 bug 是 OS 限制。
6. **cut 语义三个平台三种编码**：Windows 走 Preferred DropEffect 流、Linux 走 gnome 载荷首行、mac 没有——读侧各自恢复，别把 isCut 当成 OS 剪贴板的普遍能力。
7. **`Preferred DropEffect` 的 MemoryStream 写完必须 `Seek(0)`**：消费者从流的**当前位置**读，留在末尾就读到 0 字节 → cut 静默退化成 copy（无报错，最难查）。读侧同理，对可 seek 的流先 rewind 再 `CopyTo`。

## 测试与取证

- 单测（`__tests__/`）：`fileClipboardMainService.test.ts` 用 **fake backend** 测所有权模型（signature 匹配/不匹配/宽限期/clear 条件/过期写入）；三个 backend 的测试测纯函数（encode/parse payload、BOM 脚本生成、plist 转义）。**Electron `clipboard` 模块在单测环境不存在**——backend 里对它的一切调用只能靠真机/e2e 验证。
- e2e：`apps/editor/e2e/specs/smoke.fileClipboard.spec.ts`（@p1 且 **@serial**——每个用例都写 OS 剪贴板这个全局资源，并行 worker 的写入会在宽限期后互相触发所有权误判；最后一条用例从 main 直接注入 gnome 格式测 `source: 'os'` 路径）、`remote.fileClipboard.spec.ts`（@regression，`UNIVERSE_REMOTE_SERVER_CMD` 直连模式，测跨 provider 粘贴走 `copyAcrossProviders`）。「别的应用覆盖我们的剪贴板 → 快照降级 os」这条路径 e2e 无法可靠制造所有权竞争，由单测覆盖。

## 关键参考路径

- `apps/editor/src/shared/ipc/fileClipboardService.ts` —— 契约 + 阈值常量（50MB 确认 / 2GB、100k 拒绝）
- `fileClipboardMainService.ts` —— 权威状态 + 所有权模型 + 宽限期
- `osClipboard{Windows,Linux,Mac}.ts` / `createOsClipboardBackend.ts` / `osClipboardBackend.ts` —— 平台写入/读回/清除
- `clipboardMaterialize.ts` —— 远端物化 + session 清理
- 消费侧：`apps/editor/src/renderer/actions/fileClipboardActions.ts` + `apps/editor/src/renderer/services/explorer/CLAUDE.md`（镜像/单向事件/粘贴决策表）

## 其它

- 后续发现新经验，需同步更新本文件。
