---
name: monaco-055-editcontext-nls
description: monaco 升级 0.52→0.55 修中文 IME 加粗 + NLS 从 string-key 变索引制后的英文桥接方案
metadata: 
  node_type: memory
  type: project
  originSessionId: e5198bfd-ce31-4b3d-b0c7-bf5f008c79c3
---

为修复 Monaco 中文 IME 组合输入时当前行加粗/变色，把 `monaco-editor` 从 0.52 升到 0.55（`pnpm-workspace.yaml` catalog `^0.55.0`，lockfile 0.55.1），并在三处 create 显式设 `editContext: true`（`FileEditor.tsx` / `DiffEditor.tsx` / `LogOutputView.tsx`）。0.52 用旧 textarea-overlay 输入机制（组合文字被 textarea + view-line 两层渲染 → 视觉加粗）；EditContext API（monaco ≥0.53、VSCode 1.96 引入/1.101 默认）让组合输入走 OS 层，无第二层叠加，与 VSCode 同源根治。

**两个升级踩坑（plan 未预见）：**

1. **命名空间顶层化**：0.55 把 `monaco.languages.{json,typescript,css,html}` 移到顶层 `monaco.{json,typescript,css,html}`。改了 `MonacoLoader.ts` 及两个 monaco mock 桩（`test-stubs/monaco-editor.ts`、`overrideServicesInit.test.ts` 的 `vi.mock`）——桩要把这四个命名空间从 `languages` 下提到顶层导出，否则全 renderer 测试在 setup 阶段崩（`_monaco.json` undefined）。

2. **NLS 从 string-key 变索引制（最关键）**：0.55 ESM 是 prebuilt，`localize('key', "EN")` 全变成 `localize(786, "EN")`，经 `lookupMessage` 查 `globalThis._VSCODE_NLS_MESSAGES[index]`，缺失回退英文。旧机制（patch nls.js 让 string-key 查 `__MONACO_NLS__[key]` + `zh-cn.json` 是 key→中文）整套失效，monaco 内置 UI（查找框/右键/peek 等）会回退英文。
   - **采用方案（英文桥接，零新依赖）**：`__MONACO_NLS__` 改为 **英文→中文** 表。patch `lookupMessage`：索引查不到时用英文 fallback 查表（`monacoNlsPatch.ts`，正则锚 `function lookupMessage(index, fallback)`，native 索引优先、英文表兜底）。
   - **数据流**：monaco 索引→英文(inline fallback) ⋈ vscode 源码 key→英文 ⋈ 现有 `zh-cn.json` key→中文 ⇒ 英文→中文。
   - **build 脚本** `scripts/build-monaco-nls.mjs` 改为扫 vscode 源码（`VSCODE_SRC_ROOT` 或默认 `D:/git_project/vscode`，需是 vscode 源码树非构建产物）生成 `vendor/monaco-nls/zh-cn.messages.json`（英文→中文，入库，bootstrap 读它）。源字典 `zh-cn.json`（key→中文）保留仅供 build 桥接。命中率 ~80.5%（1150/1428），未命中多为版本文案微调或本不该译的修饰键名。

预存噪音：`DiffEditor` 测试 stderr 有 `getModifiedEditor().getPosition is not a function`，是桩缺方法的被吞清理错误，不致 fail，与本次无关。

验证全绿：typecheck + 1994 单测 + lint + build（patch 经 Vite plugin 落入 `dom-*.js`）+ e2e 79 passed。**仍需人工**：`pnpm dev` 手测中文 IME 组合态不再加粗/变色 + monaco UI 中文未坏。
