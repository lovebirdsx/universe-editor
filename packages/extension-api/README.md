# @universe-editor/extension-api

Universe Editor 的扩展 API 面——相当于 VSCode 的 `vscode.d.ts`。**包版本即扩展 API 版本**：扩展在自己的 `package.json` 里用 `engines.universe` 声明兼容区间，宿主按 semver 区间校验后加载。

> **0.x 版本政策**：1.0 之前 API 仍在演进，**minor 版本即可携带破坏性变更**（semver 0.x 惯例）。破坏性变更走显式流程（契约测试快照 + 版本 bump + 变更记录），见仓库内 `COMPATIBILITY.md`。锁定依赖时请使用区间 `">=0.7.0 <1.0.0"`，**不要用 `^0.x`**（caret 在 0.x 下会把兼容的 minor 新增也挡掉）。

## 安装

```bash
npm install @universe-editor/extension-api
```

扩展以 VSIX 分发、不经 npm，因此本包通常放在扩展的 `devDependencies`（运行时代理由宿主注入的 bridge 提供，见下文）。

## 最小示例

```ts
import { commands, window, version } from '@universe-editor/extension-api'

export function activate() {
  commands.registerCommand('hello.sayHi', () => {
    window.showInformationMessage(`Hello from extension (API ${version})`)
  })
}
```

```jsonc
// 扩展的 package.json
{
  "name": "hello",
  "publisher": "you",
  "version": "0.0.1",
  "main": "dist/extension.js",
  "engines": { "universe": ">=0.7.0 <1.0.0" },
  "activationEvents": ["onCommand:hello.sayHi"]
}
```

## 运行机制

本包会被 esbuild **bundle 进扩展产物**；运行时其 namespace 代理到宿主在 `globalThis` 上注入的 bridge（RPC 到编辑器进程），扩展静态 import 本包、实际调用全部由宿主服务。语言 provider 相关的 LSP 类型（`CompletionItem`、`Diagnostic` 等）从 [`vscode-languageserver-types`](https://www.npmjs.com/package/vscode-languageserver-types) re-export，API 面自包含。

## 相关包

- [`@universe-editor/extension-manifest`](https://www.npmjs.com/package/@universe-editor/extension-manifest) — 激活事件构造器 / manifest 类型与校验 / `engines.universe` 协商
- [`@universe-editor/extension-packaging`](https://www.npmjs.com/package/@universe-editor/extension-packaging) — VSIX 打包

## 文档

- API 版本承诺与破坏性变更流程：仓库 `packages/extension-api/COMPATIBILITY.md`
- 第三方开发者文档：`docs/extension-dev/`（随生态 Phase E 落地）

## License

Apache-2.0
