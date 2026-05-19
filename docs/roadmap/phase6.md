## 阶段六：Telemetry hook（不上报，只留接口）

### 目标

按用户决策"无埋点接口未来要加"，定义 `ITelemetryService` 接口 + 内置 `NoopTelemetryService` + 几个关键埋点。**不接任何 sink**。

### 关键文件

**新建**：
- `packages/platform/src/telemetry/telemetryService.ts` —— `ITelemetryService.publicLog(eventName, data)` / `publicLogError(errorEventName, data)` / `publicLogMeasure(eventName, value, dimensions)` / `getTelemetryInfo(): Promise<{ sessionId, machineId }>` / `ITelemetrySinkRegistry.registerSink(sink)`
- `packages/platform/src/telemetry/noopTelemetryService.ts` —— 所有方法空实现；sessionId 用 `crypto.randomUUID()`

**修改**：
- `apps/editor/src/renderer/main.tsx` —— 注册 `ITelemetryService = NoopTelemetryService`
- 关键埋点（仅 `publicLog`，noop 行为下不真上报）：
  - `apps/editor/src/renderer/workbench/CommandService.ts` → `telemetry.publicLog('commandExecuted', { commandId })`
  - `apps/editor/src/renderer/workbench/editor/EditorService.ts` → `telemetry.publicLog('editorOpened', { typeId, scheme })`
  - `apps/editor/src/renderer/workbench/workspace/RendererWorkspaceService.ts` → `telemetry.publicLog('workspaceOpened')`
  - `packages/platform/src/base/errors.ts` → `onUnexpectedError` 内 `telemetry?.publicLogError('unhandled', { stack })`
- `packages/platform/src/index.ts` —— re-export `telemetry`

### 设计要点

1. **接口对齐 VSCode `ITelemetryService` 但简化** —— 不引入 gdprTypings（GDPR classifications）。Future 接 sink 时再补。
2. **NoopTelemetryService 真正 no-op**（不开 logger 打印）—— 否则开发期日志被噪声淹没。
3. **埋点调用用可选链 `telemetry?.publicLog?.(...)`** —— service 缺失也不抛错。
4. **不要在埋点参数里收集 PII** —— 文件路径只传 scheme + extension（schema 强约束）。
5. **`ITelemetrySinkRegistry.registerSink(sink)`** —— sink 接口 `(event) => void`。Future 接 Sentry / OpenTelemetry 时实现 sink 即可，**不**改业务代码。

### 验收

- 单测新增 ~12：NoopTelemetryService 4、SinkRegistry 3、5 个埋点调用点 mock telemetry 后断言被调用
- E2E：无（noop 行为无可观察效果）

### 工作量

**S（1.5 天）**

---
