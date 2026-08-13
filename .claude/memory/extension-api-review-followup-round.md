# extension-api 评审遗留优化（fe301598 后续，10 项收官）

> 计划文件 `docs/plan/extension-api-review-followup-plan.md` 十项已全部完成（2026-08-13），每节都留了「改法 + 验收」。这里只记跨会话可复用的教训，落点细节读计划文件与各包 CLAUDE.md。

## 各项落点速查

P1.1 Tree View 增量刷新（详见 [[tree-view-feature]]）｜P1.2 WebviewPanel active/visible 由 editor groups 推导｜P1.3 `contributes.views` 的 when 门控落在 `ViewDescriptorService`｜P1.4 `visibleTextEditors` 改「getter 即重建 + 500ms 宽限 + onDidOpen 增量并入」｜P1.5 杂项五件｜P2.1 文件事件兴趣 lease + 源头过滤｜P2.2 findFiles 数组 exclude 下沉引擎（cap 只统计有效候选）｜P3.1 glob 引擎统一到 platform｜P3.2 副本收敛八件｜P3.3 `ProxyChannel.toService` 剥尾部 undefined。

## 可复用教训

- **引用计数型资源的 dispose 不能走「释放一次」路径**：兴趣 lease（`InterestGate`）count>1 时 `dispose()` 走 `release()` 会漏发 unsubscribe。dispose 语义必须是「每个唯一 key 全量直发一次 + 清表」。同类坑见 P2.1。
- **JSDoc / 块注释里禁止字面写 `双星号+斜杠`**：会提前闭合 `/** */`，tsgo 报 TS1161/TS1109。glob 文档一律写成「double-star-slash / 斜杠后缀形态」。
- **两套同类引擎收敛前先逐条列语义差异**：platform 与 extensions-common 的 glob 引擎有 4 处真实差异，其中 slashless-basename 一旦硬统一会静默改变 `files.exclude`/`search.exclude` 的用户可见行为——刻意保留，用 `normalizeExtensionGlobPattern` 在入口层显式表达差异，而不是藏进编译器。
- **cap / 截断额度必须在过滤之后消耗**：findFiles 的 `FIND_FILES_ENUMERATION_CAP` 原先在 renderer 后过滤之前扣，被排除目录吃光额度后真命中被静默截断还报误导 warn。凡「先枚举再过滤 + 有上限」的管线都要检查这一点。
- 单 host 内 fire-and-forget RPC 的 reject 会变成 unhandledRejection——同步 API（如 `window.createWebviewPanel`）无法用 reject 表达失败，改用排队回放（P1.5a）。
