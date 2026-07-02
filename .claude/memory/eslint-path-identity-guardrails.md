---
name: eslint-path-identity-guardrails
description: config-eslint 的路径身份护栏——no-restricted-syntax 禁手写 fsPath 大小写折叠/路径身份键，精准不误伤 slug/模型 id
metadata: 
  node_type: memory
  type: reference
  originSessionId: 18ef86fa-63d0-4b47-8b18-5dfe4d6a3fe3
---

`packages/config-eslint/index.js` 加了防"手写路径身份比较回潮"的护栏，配合 [[path-comparison-convergence]]。

**三条 `no-restricted-syntax` selector**（精准匹配"路径身份键"形态，不误伤 slug/模型 id 归一化）：
1. `foo.fsPath.toLowerCase()` —— fsPath 直接小写化。
2. `x.toLowerCase().replace(/\\/g, ...)` —— 大小写折叠 ⋈ 反斜杠归一（selector 里 regex.pattern 要匹配 `\\\\`，即四反斜杠转义）。
3. `x.replace(/\\/g, ...).toLowerCase()` —— 同上，另一种链序。

关键：selector 要求"toLowerCase + 反斜杠 replace 连用"，所以 slug（`replace(/\s+/g,'-')`）、模型 id（`replace(/-\d{8}$/)`）这类**不替换反斜杠**的合法链不命中。验证过 3 违规全抓、2 合法全放。

**`no-restricted-imports`**：禁 import 已删的 `canonicalResourceKey`。

**坑**：flat config 同名规则是**替换不是合并**。`apps/editor/eslint.config.js` 自己 override 了 `no-restricted-imports`（目录约束），所以必须在它那两个 override block 里各自补回 `paths` 的 canonicalResourceKey 限制，否则该限制在 renderer 目录失效。

**豁免**：
- 测试文件（`**/__tests__/**`、`**/*.test.*`）在 base config 里 `no-restricted-syntax: 'off'`（断言辅助可手写归一）。
- SCM 域集中键用行内 `// eslint-disable-next-line no-restricted-syntax`（放在 return 行正上方，不是函数声明行——PostToolUse formatter 会移动/删除错位的 disable 注释）。
