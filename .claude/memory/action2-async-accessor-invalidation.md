---
name: action2-async-accessor-invalidation
description: Action2.run 的 ServicesAccessor 遇第一个 await 即失效；async run 必须在 await 前同步取完所有 service
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8460b79a-7d83-4678-8b67-8d536f61d7ae
---

`Action2.run(accessor, ...)` 里的 `ServicesAccessor` **只在同步执行期有效**，一旦命中第一个 `await` 就失效，之后 `accessor.get(...)` 抛 `service accessor is only valid during the invocation of its target method`（源在 `packages/platform/src/di/instantiationService.ts` 的 Object.get 守卫）。

**How to apply**：async 的 `run` 必须在任何 `await` **之前**把所需 service 全部同步 `accessor.get` 出来（打包成一个快照对象传给后续 helper），await 之后绝不再碰 accessor。抽取 async helper 时尤其危险——一个无条件的 async 调用就会把后续代码推到失效边界之后。

**判例**：`agentContextActions.ts` 的 `SendCommitToAgentChatAction` / `AddSelectionToAgentChatAction` 用 `captureRevealServices(accessor)` 先同步快照 8 个 service，再传给 `resolveTargetSession` / `revealChat`。

**测试陷阱**：用自造的持久有效 accessor（`{get: id => collection.get(id)}`）或让 helper 在同步块内跑完的 `invokeFunction`，都**不会**复现此 bug——测试会假绿。要么在测试里模拟 await 后 accessor 失效，要么（更好）让代码本身不依赖 accessor 存活。相关：[[editor-input-identity-isolation]]
