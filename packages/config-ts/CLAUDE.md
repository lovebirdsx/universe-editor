# packages/config-ts/CLAUDE.md

共享 tsconfig 预设。三套：

| 入口 | 用途 |
|---|---|
| `@universe-editor/config-ts/base` | strict 基础：`target ES2022`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, `skipLibCheck` |
| `@universe-editor/config-ts/react` | base + `jsx: react-jsx`、`module: ESNext`、`moduleResolution: bundler`、DOM lib |
| `@universe-editor/config-ts/node` | base + `module/moduleResolution: NodeNext` |

## 在子包里用

```jsonc
// apps/web/tsconfig.json
{
  "extends": "@universe-editor/config-ts/react",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src"]
}
```

## 关键约束

**不要在子包里覆盖关掉**：
- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`

整个仓库依赖这三项保证类型安全。需要放宽时改的是单个表达式（加显式判断），不是关全局开关。

## 加新预设

如需 `./node-strict-esm` 之类的新组合：
1. 新建 `node-strict-esm.json`，`"extends": "./base.json"`，覆盖必要项
2. 在 `package.json` 的 `exports` 加 `"./node-strict-esm": "./node-strict-esm.json"`
