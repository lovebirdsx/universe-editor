---
name: ctrlp-giant-workspace-listing-perf
description: Ctrl+P 巨型工作区（~4.3M 文件）卡顿根治 — 慢在 IPC decode 不在业务；DTO 判别联合+截断整份丢弃+预热预算+rg --iglob 下推+200ms 输入防抖；附 rg glob 优先级与 createInstance 尾随普通参数两条红线
metadata:
  type: project
---

巨型目录（如 `C:/Users/<user>`，数百万文件）作为工作区时 Ctrl+P 跳转卡顿的根治方案（2026-09 task3 分支合并 task1+task2 落地）。**慢在 IPC 解码层，不在业务层**：`ipc.decode` 同步 `JSON.parse` 40MB 载荷要 418~695ms，10 万条 `IFileSearchMatch` 每条把 resource/fsPath/relativePath/basename 重复 3 次。

**Why:** 修法极易被「优化业务逻辑」带偏；真正的杠杆是把 40MB 载荷从线上拿掉，而不是把 parse 挪快。

**How to apply:**
- DTO 判别联合：`IFileSearchComplete = IFileSearchMatches {results} | IFileSearchListing {relPaths}`——`matchAll` 场景只传相对路径字符串数组，不物化 match 对象。
- main 侧整份丢弃截断清单（`omitTruncatedListing`）：残缺子集会把「子集外」呈现成「搜不到」，比不给更糟。
- 预热双常量正交：`PREWARM_DELAY_MS`（何时开始）/ `PREWARM_BUDGET_MS`（开始后最多走多久），`listingWaitMs` 可注入便于测试钳制。
- Ctrl+P 输入防抖单闸门 `SEARCH_DEBOUNCE_MS = 200`（对齐 VSCode `TYPING_SEARCH_DELAY`，吸收原 `FALLBACK_DEBOUNCE_MS`，不叠加）：零延迟路径=空输入 MRU / 小池（≤`SYNC_FILTER_LIMIT` 且 `listingComplete`）同步过滤 / 预热未落地；走闸门=大池分块扫描或需主进程兜底。**进贵路径时先把列表换成当前 query 的同步 `matchEditors` 命中**——`filterExternally` 面板不过滤，窗内 Enter 会接受不属于当前 query 的上轮残留项。
- 慢帧归因：`slowPhaseInstrument(name, minMs, detail?)`，`detail` 惰性求值；wrapper 提到模块级（每帧新建闭包是纯浪费，字节数由 detail 闭包捕获）。
- 远程协议随 DTO 变更 bump 版本（v9→v10），注释写明远端用户须重启 daemon。

**两条红线（本次实测确诊）：**

1. **rg 的 `--iglob` 集合恒定压过 `-g` 集合**（rg 15 实测，与命令行顺序无关；同族内多个 glob「最后一个匹配生效」）。所以正向 glob 一旦走 `--iglob`（修大小写），负向排除**也必须**用 `--iglob '!...'` 才能生效——代价是排除也变大小写不敏感（排除面变宽，对 search.exclude 是可接受的保守方向）。混用 `-g` 排除 + `--iglob` 正向 = 排除静默失效。

2. **`createInstance` 的类型重载只在「尾随参数全是 BrandedService」时能剥离**（`GetLeadingNonServiceArgs`）。尾随带默认值的普通参数（如 `prewarmDelayMs: number = 3000`）使递归失败，`createInstance(Class)` 直接调用匹配不上任何重载（tsc 与 tsgo 一致）。生产路径靠 `descriptor.ctor: new (...args: any[])` 运行时不报错 + 运行时按装饰器索引拼服务参数、尾随位收 undefined 被默认值吃掉。**此位置之后不得再追加任何 `@I...` 注入参数**——参数会整体错位且无报错。
