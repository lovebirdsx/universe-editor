# Ctrl+P 与工作区文件清单（巨型工作区）

巨型目录（如 `C:/Users/<user>`，实测约 **4.3M 文件**）作为工作区时 Ctrl+P 卡顿的根治复盘。**慢在 IPC 解码层，不在业务层**——这是本主题唯一真正需要记住的判断。

## 判序：先量 decode，再动业务

`ipc.decode` 同步 `JSON.parse` 一份 40MB 载荷要 **418–695ms**；10 万条 `IFileSearchMatch` 每条把 resource / fsPath / relativePath / basename 重复三遍。所以**真正的杠杆是把载荷从线上拿掉，不是把 parse 挪快**——当年的弯路正是「优化业务逻辑」（扫描、排序、评分）找错层次。度量入口：`renderer/ipc/bootstrap.ts:119` 的具名慢解码相位（`ipc.decode (response fileSearch.findFiles #42, 18.4MB)`）+ ≥4MiB 帧告警，读法见 [memory-pressure.md](memory-pressure.md) 的 IPC 帧闸门一节。

## 载荷形状（三条，代码注释即契约）

- **DTO 判别联合**：`IFileSearchComplete = IFileSearchMatches {results} | IFileSearchListing {relPaths}`（`packages/platform/src/workbench/fileSearchService.ts:84-113`）。`matchAll` 场景只传**相对路径字符串数组**——`basename` 落末段、绝对 URI 由 join `root` 得出，不物化 match 对象。
- **截断清单整份丢弃**：`omitTruncatedListing`（字段 doc comment `fileSearchService.ts:44-53`；实施在 `packages/node-services/src/search/fileSearchService.ts:450`）。残缺子集会把「子集外」呈现成「搜不到」，比不给更糟；renderer 因此从不持有残缺清单。注意 doc comment 里的**单向蕴含**：丢弃 ⇒ 空 `relPaths`，但 `limitHit: true` 不带该 flag 时仍返回走查到的部分。
- **预热双常量正交**（`apps/editor/src/renderer/contributions/WorkspaceFileListingContribution.ts:30-38`）：`PREWARM_DELAY_MS = 3000`（何时开始，让首屏先稳定）/ `PREWARM_BUDGET_MS = 5000`（开始后最多走多久，到点整份丢弃由击键兜底）。当初用 `runWhenIdle` 不可靠——多窗口下新恢复的窗口几乎永远不 idle，首次 Ctrl+P 的走查全压在第一击键上。`listingWaitMs` 可注入，便于测试钳制。

## 输入侧闸门与残留项

- **只有一个防抖闸门** `SEARCH_DEBOUNCE_MS = 200`（`FileQuickAccessProvider.ts:94-100`，对齐 VSCode `TYPING_SEARCH_DELAY`；它**吸收**了原先只包住主进程兜底的 `FALLBACK_DEBOUNCE_MS`，两个延迟不叠加）。零延迟路径=空输入走 MRU / 小池（`≤ SYNC_FILTER_LIMIT = 5000` 且 `listingComplete`）同步过滤 / 预热未落地的兜底分支；走闸门=大池分块扫描（`CHUNK_BUDGET_MS = 8`）或需主进程兜底搜索。
- **进贵路径前必须把列表换成当前 query 的同步 `matchEditors` 命中**（`FileQuickAccessProvider.ts:851-857`）：面板 `filterExternally` 时**不过滤**，防抖窗内按回车会接受不属于当前 query 的上轮残留项；editor 命中为空也**不退回旧结果**——显示空比拖旧结果好，前者是「清单就是这个 query 的现状」。

## 红线：rg 的 glob 族优先级（rg 15 实测）

`--iglob` 集合**恒定压过** `-g` 集合（与命令行顺序无关）；同族内「最后一个匹配生效」。所以正向 glob 一旦走 `--iglob`（大小写不敏感预筛），负向排除**也必须**同族 `--iglob '!...'` 才生效——**混用 `-g` 排除 = 排除静默失效**；代价是排除也变大小写不敏感（排除面变宽，对 `search.exclude` 是可接受的保守方向）。原地已载：`packages/node-services/src/search/fileSearchService.ts:206-228` + 回归 `fileSearchService.test.ts:406`。

## 关联

- 每击键全量扫描（大池分块 + 命中池收窄）的优化案例见 skill `analyze-interaction-performance` 的「已修案例」；渲染侧归因见 [apps/editor/cases-interaction-perf.md](../../apps/editor/cases-interaction-perf.md)。
- 清单缓存的失效/预热编排（文件变更与 watcher 重启即失效）在 `WorkspaceFileListingContribution.ts` 文件头注释。
