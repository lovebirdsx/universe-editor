---
name: e2e-async-session-prompt-not-settled
description: 新建会话异步化后 sendAcpPrompt 的 await 不等 echo 回复渲染，E2E 测试在内容未稳定时滚动/断言会偶发或确定性失败
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d819ea4-336c-4677-a3d4-511a41287920
---

`d71efb25`（创建 session 不再等待，见 [[async-session-create]]）改了 prompt 派发时序后，E2E 探针 `sendAcpPrompt` 的 `await s.sendPrompt(text)` **只保证 prompt 发出，不等 agent 的流式回复（session/update chunk）渲染进 timeline**。

**踩坑实例**：`smoke.agentsScrollRestore.spec.ts` 连发 8 个 prompt 后立即滚动到中点并记位置。但此刻 timeline 只有 8 条 user 消息（echo 的 8 条 agent 回复还在 stdio 管道里没到），`8 < 阈值10` → 走非虚拟路径、不记锚点、scrollHeight≈1570。随后 echo 涌入 → timeline=16、虚拟化生效、scrollHeight 暴涨到 ~8830，之前那个裸 scrollTop=606 退化成顶部（readFrac 0.07 < 期望 0.15）→ 确定性失败。

**注意**：这类失败用 `git stash` 对比基线时**两边都失败**，容易误判为「与本次改动无关的预存问题」——其实是 `out/` 跑的是过期构建（子包级 `pnpm exec playwright test` **不会** rebuild，只有根 `pnpm e2e` 先 `pnpm build`）。诊断 E2E 前务必先 `pnpm build`。

**修复套路**：发完 prompt 后，先 `expect.poll(getAcpMessages().length).toBe(预期总数)` 等回复落地，再用「两次采样 scrollHeight 相等」等高度收敛，然后才滚动/断言。

**Why**：异步化把「prompt 完成」与「内容渲染完成」解耦了，旧测试隐含假设二者同步。
**How to apply**：任何依赖 timeline 高度/虚拟化/滚动位置的 ACP E2E，滚动或断言前必须显式等待消息数到位 + 高度稳定，不能依赖 sendAcpPrompt 的 await。
