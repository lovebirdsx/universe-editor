---
name: e2e-local-windows-launch-fails
description: 本地 Windows 跑 Playwright E2E 的启动状态（曾因 --remote-debugging-port=0 被拒，现已能启动）
metadata:
  node_type: memory
  type: project
  originSessionId: 0422346b-7013-47c8-985c-2d0f9fe2607c
---

本地 Windows（pnpm + electron@33 + playwright-core）跑 E2E 的历史问题：早期 `electron.launch` 会报 `bad option: --remote-debugging-port=0` 启动失败。

**更新（2026-06-09）：** 该问题已不再复现。`pnpm e2e` 本地能正常启动并跑完整套冒烟（实测 72 个用例，仅 `smoke.explorerDnD` 偶发失败，与功能改动无关）。

**How to apply:** 本地改完编辑器交互后可直接跑 `pnpm e2e` 验证；若个别用例失败，先判断是否与改动相关（看失败 spec 名），DnD 类用例本地偶发不阻塞。最终以 CI（ubuntu+windows runner）为准。
