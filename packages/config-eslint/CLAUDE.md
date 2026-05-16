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
- `eslint-config-prettier`（关掉与 Prettier 冲突的格式规则）
- `eslint-plugin-prettier`（`prettier/prettier` → `error`，让 Prettier 违规走 ESLint 报错）

## 关键约束

- ESLint **flat config**（`eslint.config.js`），不是旧式 `.eslintrc`
- Prettier 配置在仓库根（`.prettierrc` 或 `package.json#prettier`），ESLint 通过 plugin 复用，不要在 ESLint 配里重复定义
