---
name: workbench-ui-consolidation
description: apps/editor 通用 UI 组件已全部抽取到 packages/workbench-ui（atoms/layout/overlay/feedback + tokens），feature 目录只留薄 wrapper
metadata: 
  node_type: memory
  type: project
  originSessionId: 52f68668-17c4-4187-9bf4-9bbda45945f7
---

通用 UI 统一抽取重构（2026-06-07 完成，批次 0–9 全过）。

**成果**：`packages/workbench-ui` 现承载 atoms（Button/IconButton/Input/Checkbox/Badge/Spinner+cx）、layout（Sash/GridLayout/CollapsibleSlot）、overlay（FocusScopeOverlay/PopoverList）、feedback（notifications/quickInput/progress/dialog）、text/fuzzyMatch、theme/tokens.css。`apps/editor` 同名文件改薄 wrapper（useService+订阅+createPortal+图标注入），文件名/导出名/data-testid 不变。

**关键模式**（写新通用组件务必遵守）：
- 展示组件纯数据+回调，无 DI、无 Portal；service 接口走 `import type`（单向合法），状态类型（QuickPickState/DialogProgressState）下沉 workbench-ui，editor `export type` re-export。
- 图标走 props/`renderIcon` 注入，不引 lucide。
- 可选 className props 声明 `string | undefined`（应对 noUncheckedIndexedAccess + exactOptionalPropertyTypes）。
- tokens.css 走子路径 `@universe-editor/workbench-ui/tokens.css`；electron.vite.config.ts 需为该子路径单列 alias 指向 `src/theme/tokens.css`（否则通用 alias 把它拼成 `src/index.ts/tokens.css` 致 build 失败）。

**Why:** 设计统一 + 可维护性，消除 4+ 份雷同弹出列表/6+ toolbar button/散落硬编码。

**How to apply:** 新增通用控件优先在 workbench-ui 沉淀，别在 feature 目录再写 `<button>`+css。**渐进迁移技术债**：Diff/Terminal/SCM/Config/Search 的 `.iconBtn`、SessionsPopover/ConfigOptionsBar（交互模型不同）、未触及旧 css 的 token 化——动到相关文件时顺手迁。详见两份 CLAUDE.md。相关：[[e2e-electron-launch-broken-local]]
