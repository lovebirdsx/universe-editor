---
name: keybinding-when-not-priority-weight-wins
description: KeybindingsRegistry 解析是 weight 优先+后注册优先，when 只过滤不提权——scoped 快捷键压全局同键必须显式加 weight
metadata: 
  node_type: memory
  type: project
---

`packages/platform/src/command/keybindingRegistry.ts` 的按键解析**不是** VSCode 的「when 匹配优先」：排序只看 weight（高优先）→ 同 weight 后注册优先；`when` 仅做过滤，不提升优先级。

**Why:** 给图谱加 `ctrl+r` 刷新（`when: activeEditorId == 'universe:/gitGraph'`）时，被全局无 when 的 Open Recent（同键、同默认 weight 200）抢走——VSCode 里 scoped 绑定会赢，这里不会。

**How to apply:** 带 `when` 的快捷键若与无 when 的全局绑定同键，必须显式 `weight: KeybindingWeight.WorkbenchContrib + 50`（对照 `CloseDirtyDiffPeekAction` 的 Esc 同款写法）。用户自定义（User=1000）仍可覆盖，不受影响。排查看 `KeybindingsRegistry.traceKeystroke` 的 candidates（selected/outcomeReason）。
