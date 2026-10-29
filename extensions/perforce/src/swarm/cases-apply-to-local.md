> 本文从 [CLAUDE.md](CLAUDE.md) 拆出的案例细节：`applyToLocal`（详情页 Apply to Local 按钮）完整流程。红线结论见主文档。

### applyToLocal（纯 p4 数据命令，不走 guard()）

`applyToLocal`（详情页 Apply to Local 按钮）是**纯 p4 数据命令**（`p4 unshelve -s <change> -f <筛选后的 depot 文件>`），**不走 `guard()`**——guard 构造 SwarmClient、401→login、失败 toast 全是 Swarm REST 语义。入参 change 同样走 `archiveChange ?? change` 不可变快照铁律（renderer 传的是 `selectedChange`，别重新推导）。整批失败时逐文件重试，p4 拒绝的（已打开/基线过期）进 `skipped[]` 报告；renderer 侧弹确认框（含「工作区外文件」与「在默认 changelist 中打开」两个持久化开关，store 在 `services/swarm/swarmApplyStore.ts`），分类纯函数 `swarmApplyPlan.ts` 带单测。**「在默认 changelist 中打开」关闭时**（请求带 `intoChangelist:false`）：unshelve 成功后对 applied 文件追加 `p4 revert -k`（`client.ts` `_unopenFilesKeepContent`，批量失败逐文件重试，失败项进 `keptOpen[]` = 留在 default CL、内容不丢）——内容写盘但不签出，磁盘内容因此偏离 depot，会在资源管理器按需显示 `RC` 徽标（「待收集」常驻分组已删除，无需也不应主动扫描）。**已提交（approve:commit）的 change 无 shelf 可 unshelve**（p4 报 `already committed`）→ 回退 `_applyCommittedChange`：`p4 where` 解析本地路径 →（`intoChangelist` 时先 `p4 edit` 签出进 default CL 并解除只读）→ `p4 print <depot>@=<change>` 拿提交快照（`execBinary` 保二进制）→ 写盘（未签出只读文件 EPERM 时 chmod 666 重试）；edit/print/写盘失败进 `skipped`，此路径 `keptOpen` 恒空。reason 提取统一走模块级 `firstStderrLine`。fake-p4 的 `unshelve` case 对 `state.submitted` 里的 change 报同款错误。

### 跨 stream 强制 apply（force + stream）

**wire**：`SwarmApplyToLocalRequest` 现在带 `files: { depotFile, status }[]`（`status` 供 A/D 分流）、`force?`、`stream?`（`//depot/...`）、`workspaceRoot?`、`includeOutside?`；命令层 `parseApplyFiles` 仍接受 legacy `depotFiles: string[]`（视作 `M`）并按 depotFile 去重。`force` 只在 `normalizeStreamSpec(stream)` 有效时生效，否则降级为普通 apply 并 `logger.warn`。

**renderer 决策表**（`swarmApplyPlan.ts` + `swarmApplyToLocal.ts`）：

| 场景                     | 确认框                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 有已映射文件             | 原对话框；若有未映射文件且 stream 已知，加 `secondaryButton: 'Force Apply'`（primary 仍只发 mapped）                   |
| 全部未映射 + stream 已知 | warning 确认框，`buttons: ['Force Apply']` + dismiss（`defaultButton: 'dismiss'`，默认焦点在取消）；两个 checkbox 保留 |
| 全部未映射 + 无 stream   | 原 mismatch toast，不弹框                                                                                              |
| 取消                     | 不持久化 checkbox、不发命令                                                                                            |

`resolveReviewStream` 的保守回退：优先所选版本的 `versions[idx].stream`；**只有所有版本都没有 stream** 时才用 `detail.stream`（后者是「最新带 stream 的版本」派生值，绝不能拿它映射旧版本）。强制请求的 `files` 是 **mapped（受 outside 开关约束）+ unmapped 的原顺序并集**；`includeOutside` 只控制已映射但在工作区外的文件。

**host 流水线**（`PerforceClient.unshelveFiles`）：

1. `force` 时先 `p4 where` 对全部源路径分区：命中 → mapped group（原批量 → 逐文件 → committed print 流程原样复用）；未命中 → cross-stream group。`where` 整体失败 → 全部 skipped。
2. cross group 先读当前 client stream（`p4 client -o` 的 `Stream` 字段，`parseClientStream` **不缓存**——`p4 switch` 会换 stream，缓存旧值会写错盘）。
3. `mapDepotAcrossStreams(source, reviewStream, clientStream)` 只做 `${reviewStream}/` 前缀替换；`p4 where` 校验 target 已映射且 local 在 client root 内；`includeOutside !== true` 且给了 `workspaceRoot` 时还必须在工作区内。
4. `intoChangelist === false`：**直接 print 兜底、从不 open**（因此不需要 target 路径做 `revert -k`；`applied`/`keptOpen` 一律用请求里的源路径）。
5. `intoChangelist === true`：先整组 `p4 unshelve -s <change> -f -S <reviewStream> -P <clientStream> <sources>`；失败按 `classifyUnshelveFailure`：
   - `committed` / `stream-unsupported` → 整组直接 print 兜底（无 shelf / 不支持 `-S`，对每个文件都一样）；
   - `stream-relation` / `other` → 逐文件重试 `-S -P`（批量可能部分成功，逐文件重试让已成功的文件留在原生路径），仍失败的进 print 兜底。
6. print 兜底：`p4 print -q <source>@=<change>`（`execBinary` + `noClient`，pending shelf 与 committed change 都可用）→ `M` 走 `p4 edit` 后写盘；`A`/`R`（move/add 的新路径）先尝试 edit，失败则**先写盘（自动建父目录）再 `p4 add`**（add 失败且文件原本不存在时 unlink）；写盘失败只对**本次新 open** 的 target 做 best-effort `revert -k`（`already opened` 的用户签出不动）并 skipped；`D` 只走原生命令，print 兜底中明确 skipped。
7. mapped + cross 结果合并：applied 去重、skipped 与 applied 互斥去重、keptOpen 只来自 mapped group；applied > 0 时 `_invalidateWorkspaceState()` + `refresh()` 一次。

**已知近似**：前缀替换不理解 virtual/import/sparse stream 的真实映射，只能靠 `p4 where` + 包含性校验兜底（映射不上就 skipped）；`p4 where` 有短 TTL 缓存，`p4 switch` 后极端情况下分区可能短暂过期。e2e 用 `fake-p4` 的 `clientStream` / `unmappedPrefixes` / `streamUnsupported` + shelf 920/921 覆盖原生 `-S -P`、整组兜底、混合与无 stream 四种路径。
