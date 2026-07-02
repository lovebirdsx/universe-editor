# packages/config-eslint/CLAUDE.md

共享 ESLint flat config。两套：

| 入口 | 用途 |
|---|---|
| `@universe-editor/config-eslint` | base：`typescript-eslint/recommended` + Prettier 集成 + 自定义 unused-vars / no-explicit-any |
| `@universe-editor/config-eslint/react` | base + `react-hooks/recommended`（只对 `.tsx`/`.jsx`） |

## 在子包里用

```js
// apps/web/eslint.config.js
import reactConfig from '@universe-editor/config-eslint/react'
export default reactConfig

// apps/api/eslint.config.js
import baseConfig from '@universe-editor/config-eslint'
export default baseConfig
```

子包可以追加规则：
```js
import baseConfig from '@universe-editor/config-eslint'
export default [
  ...baseConfig,
  { rules: { 'no-console': 'warn' } },
]
```

## 包含的规则集

- `typescript-eslint.configs.recommended`
- `@typescript-eslint/no-unused-vars`（`_` 前缀豁免）
- `@typescript-eslint/no-explicit-any` → `error`
- `no-restricted-syntax` → 路径身份护栏：禁手写 `fsPath.toLowerCase()` 与 `toLowerCase()`⋈`replace(/\\/g,…)` 的路径身份键（引导用 `IUriIdentityService` / 内核 `getPathComparisonKey`）。**测试文件豁免**（`__tests__`/`*.test.*`，断言里可手写归一）。精准匹配"大小写折叠+反斜杠归一"形态，不误伤 slug / 模型 id 归一化。
- `no-restricted-imports` → 禁 import 已删除的 `canonicalResourceKey`
- `eslint-config-prettier`（关掉与 Prettier 冲突的格式规则）
- `eslint-plugin-prettier`（`prettier/prettier` → `error`，让 Prettier 违规走 ESLint 报错）

> 子包若 override `no-restricted-imports`（如 `apps/editor` 的目录约束），需在 override 里同时保留 `paths` 的 `canonicalResourceKey` 限制，否则该限制在被 override 的目录失效（flat config 同名规则是替换而非合并）。SCM 域的集中键函数（`scmPathKey` / ScmView 的 `pathKey`）是刻意保留的独立身份域，用行内 `eslint-disable-next-line` 豁免。

## 关键约束

- ESLint **flat config**（`eslint.config.js`），不是旧式 `.eslintrc`
- Prettier 配置在仓库根（`.prettierrc` 或 `package.json#prettier`），ESLint 通过 plugin 复用，不要在 ESLint 配里重复定义
