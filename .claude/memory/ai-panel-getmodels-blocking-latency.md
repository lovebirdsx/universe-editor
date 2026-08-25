---
name: ai-panel-getmodels-blocking-latency
description: AI provider 面板「保存慢/列表闪空」根因＝getModels 在线枚举被绑进 reload 关键路径；修法＝后台化+三态 loading+registry 按指纹保留缓存
metadata:
  type: project
---

症状两个、根因一个（2026-08）：① 改 provider 字段后「已保存」隔数秒才出现；② 外部改 `aiSettings.json` 回到面板，provider 列表先空数秒。

根因：`AiModelsPanel.reload()` 用一个 `Promise.all` 把四个 main 内存快速读（`getProviders`/`getProviderIssues`/`isLegacySettingsFormat`/`getModelKnowledge`）和 `aiModel.getModels()` 绑在一起。`getModels` 对 **discover 型 provider（`protocolMap: []`，所有内置模板默认如此）会发真实 `/v1/models`**，端点是「黑洞」（连得上但不响应）时整批等满 `METADATA_REQUEST_TIMEOUT_MS = 10_000`。Saved 戳等的是 `updateEntry → updateProviders → await reload()` 整条链；列表闪空是 `providers` 初值 `[]` + 无 loading 标志，UI 把「加载中」渲染成空态。

跨会话教训：

1. **别把「网络枚举」和「内存读」放进同一个 `Promise.all`。** 面板刷新里只要有一个 await 会打网络，整块 UI 的延迟就等于最慢端点的超时。快读先落地、慢读后台化 + latest-wins token 守卫。
2. **「加载中」和「没有」必须是两个状态，而且这条规则要一路贯穿到叶子组件。** 第一版只在面板层加了 `loaded`，缺陷原样搬到卡片层——徽标显示 `0 models`、discover 块显示 "No models resolved"、Pin 按钮谎报 0，用户照样以为端点没模型。所以 `modelsLoading` 要传到 `ProviderEntryCard`/`ProtocolsSection`，且**只对 discover 模式区分**（static 的 refs 来自配置文件，不依赖网络）。同类前例见 [[ai-providers-visual-editing]] 的 `UsageState` 三态。
3. **去掉 `await reload()` 时必须补 write 版本守卫。** 事件驱动的 reload（`onDidChangeModels`/`onDidChangeRemote`）不走 `enqueueWrite` 队列，可能在一次写的中途启动，用旧快照回写 `providersRef.current` 抹掉刚提交的改动——这正是 [[ai-providers-visual-editing]] 教训 1 的那类竞态换了个入口复发。修法＝`writeSeqRef` 每次全量替换 `++`，reload 落地时版本已前进就跳过写 `providersRef`/`setProviders`。
4. **治本在 `AiModelRegistry.setProviders`：它原来无条件 `_entries.clear()`。** 而 `AiModelMainService._reload()` 在**每次写盘后**都跑（`updateProviders`/`setApiKey`/`setModelConfiguration` 全走它），于是改 `pricingSource` 这种与模型清单无关的字段也会清缓存、下次 `getModels` 重打网络。改为按 provider 内容指纹（id/baseUrl/apiKey/defaultProtocol/protocols，**排除** pricingSource/usageSource）复用 entry，纯函数在 `packages/platform/src/ai/aiModelFingerprint.ts`（内部件，未进 barrel，须登记 `index.test.ts` 的 INTERNAL 白名单）。
5. **knowledge 变化必须全量失效。** discover 型 provider 的指纹天然不含 knowledge（`protocols` 是空数组），但枚举时会把 `this._knowledge[channelModel]` 合并进元数据——保留缓存就会返回过时的 name/family/capabilities。正确性优先于省一次网络请求。
6. 复用 in-flight `pending` 是安全的：commit 闭包按 `this._entries.get(key) === entry` 判定 entry 身份，指纹相同则原地换 `provider` 引用即可；指纹变化时旧 entry 被踢出 map，其在途结果自然不 commit。

相关：[[ai-providers-visual-editing]]（写盘串行化与 effective 值三条教训）、[[ai-service-foundation-progress]]（服务三层）
