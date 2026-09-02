---
name: perforce-explorer-behind-decoration-restore
description: 恢复 d62392d9 误删的 Explorer「远端有更新 ↓」装饰；机制=可见行惰性 pull + perforce push 双通道合并
metadata:
  type: project
---

# Perforce Explorer「远端有更新 ↓」装饰恢复（2026-09）

**背景**：提交 `d62392d9`（删状态栏「N 个可更新」条目）误删了 Explorer behind 装饰的生产者，导致状态栏显示 `↓#172` 但 Explorer 无 ↓ 灰字。用户确认是意外回归。

**关键决策**：**不恢复原 `runSyncPreviewScan` 整仓 `sync -n` 扫描**（真机实测活跃 depot 下每 5 分钟白烧一次 20s 超时）。改用「活动编辑器文件 + 可见文件行逐行 fstat」。

## 双通道机制（为什么必须两个都做）

behind 信息要同时从两侧驱动，缺一不可：

1. **renderer pull**（`ScmBehindHintService`）：Explorer render 期读 `isBehind()` 惰性入队 → 150ms 去抖批量 → `perforce.checkBehind` capability 命令 → 返回 behind 子集。作用 = **终止重复查询循环**（miss 缓存 false 让行不再重查），不做渲染。
2. **perforce push**（`_publishSupplementaryDecorations`）：`checkBehind` 内部把 fstat 结果写进 `_behindDecorations` map → 与 `_othersDecorations`（✎ 占用）**按路径合并**成单一 marker → `setSupplementaryDecorations` push → Explorer 行尾灰字。作用 = **真正的装饰**。

**为什么 push 不能只靠 pull 的返回值**：pull 缓存的 boolean 只回答「是否 behind」，装饰的 description/tooltip（`↓#head`）必须由 perforce 侧 push。两条通道共享 `_setBehindFromInfo` 单一写入口。

## 关键不变量（改动前必读）

- **✎（occupied）与 ↓（behind）共享 supplementary 槽位**（按路径 key）：必须合并为 `✎ ↓`（tooltip 换行拼接），否则两个独立条目互相覆盖。合并收口在 `_publishSupplementaryDecorations`。
- **状态栏 chip 复用漏斗**：`p4StatusBar._renderRev` 已跑的 fstat 结果经 `updateBehindFromFstat` 喂进 `_setBehindFromInfo`——同一文件不跑第二次服务器查询。
- **checkBehind 三条红线**：background 优先级（不占交互预留槽）+ `CHECK_BEHIND_TIMEOUT_MS`（20s）紧超时 + 入口离线守卫（`_connection !== 'connected'` 直接返回 `[]`）。
- **失败 ≠ clean**：瞬时 fstat 失败（超时/连接抖动）**保留**已有 behind 标记，只把该路径从返回子集剔除（对照 `runOpenedByOthersScan` / `checkIgnore` 的「失败保留」先例）。
- **批量单次 republish**：`_setBehindFromInfo` 返回 boolean、不自己 republish；`checkBehind` 收集 changed 标志最后只发一次 `setSupplementaryDecorations`（否则 100 行重查 = 100 次 O(N) 全量 diff）。
- **sync 成功清场**：sync 后 `_clearBehindDecorations()` + `_invalidateWorkspaceState()`——装饰靠渲染重触发 + push，fstat 短 TTL（15s）只吸收重复读突发，不是持久层。

## 循环安全论证

supplementary observable 变更 → invalidate → re-render → re-probe → push → supplementary 变更——靠 hostScm `diffSupplementaryDecorations` delta 去重收敛（相同集合零 RPC）。renderer 侧的 supplementary-变更-全清失效也因此安全。

## 文件地图

- renderer pull：`apps/editor/src/renderer/services/scm/ScmBehindHintService.ts`（镜像 `ScmWorkingTreeHintService` 的 in-flight token latest-wins）
- perforce push：`extensions/perforce/src/client.ts`（`_behindDecorations` / `_setBehindFromInfo` / `_publishSupplementaryDecorations` / `checkBehind` / `updateBehindFromFstat`）
- 纯逻辑：`fstatParser.ts` 的 `asRev` / `fstatBehind`（`have < head` 且排除 `action==='add'` / `haveRev==='none'`）
- 契约：`packages/extensions-common/src/contracts/dirtyDiff.ts` 的 `DirtyDiffCapabilities.checkBehind`
- e2e：`extensions/perforce/e2e/specs/perforceStatusDecorations.spec.ts`（5 用例：✎ / ↓ / 合并 / sync-clear / clean 无装饰）

相关：[[scm-host-scoped-path-gating]]、[[eslint-path-identity-guardrails]]
