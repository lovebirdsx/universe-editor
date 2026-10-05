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

> 子包若 override `no-restricted-imports`（如 `apps/editor` 的目录约束），需在 override 里同时保留 `paths` 的 `canonicalResourceKey` 限制，否则该限制在被 override 的目录失效（flat config 同名规则是替换而非合并；`packages/config-eslint/index.js` 已导出可复用的 `pathIdentityRestrictedImports` 片段，新 override 应 compose 它而不是抄一份）。SCM 域的集中键函数（`scmPathKey` / ScmView 的 `pathKey`）是刻意保留的独立身份域，用行内 `eslint-disable-next-line` 豁免——**豁免注释必须紧贴目标行**：要放在真正触发规则的那一行（如 `return` 行）**正上方**，不是函数声明行；放错时 PostToolUse formatter 会把它移动/删除，护栏于是静默失效。

## schemeAgnosticRestrictedSyntax（内核 `.fsPath` 红线）

`index.js` 导出的常量 `schemeAgnosticRestrictedSyntax` 是一条 `no-restricted-syntax` selector（`MemberExpression[property.name='fsPath']`），**只对 `packages/platform/src/**` 生效**——作用域与豁免清单都接线在仓库根 `eslint.config.js`，不在本包内。

- **为什么只覆盖内核**：内核按构造就该 scheme 无关（任何资源都可能由非本地 provider 供给），`.fsPath` 对非 `file:` scheme 会把 authority 折进路径、恒为错值。应用层与扩展保留 `.fsPath` 是对的——userData、随包二进制、原生对话框、本地子进程 cwd 都是合法的本机语义。
- **「全仓 allowlist」被实测否掉**：合法本机语义站点约 200 处、横跨 40 个目录，白名单会退化成列出整个仓库。
- **豁免四个咽喉**（每个都在 `eslint.config.js` 里带一行理由）：`base/uri.ts`（定义 getter 本身）、`configurationResolver/variableResolver.ts`（唯一的私有 `fsPath()` helper，变量替换都从它走）、`undoRedo/undoRedoService.ts`（守卫三元 `scheme === 'file' ? fsPath : path`）、`remote/remoteUri.ts`（唯一把 remote-ssh URI 译成 server-local fsPath 的地方），外加测试文件。
- **加这类 lint 护栏后务必写一个探针文件验证它真的报错**：selector 写错、`files` 没命中、被后置 config 覆盖，症状都是「静默通过」；不跑一次故意违规的探针，就分不清「没有违规」和「护栏根本没生效」。

## 关键约束

- ESLint **flat config**（`eslint.config.js`），不是旧式 `.eslintrc`
- Prettier 配置在仓库根（`.prettierrc` 或 `package.json#prettier`），ESLint 通过 plugin 复用，不要在 ESLint 配里重复定义
