# @universe-editor/extension-manifest

Universe Editor 扩展 manifest 协议包：扩展 `package.json`（manifest）的类型、zod 校验、激活事件构造器、`engines.universe` 版本协商、扩展分类集合。编辑器宿主与打包/发布工具链共用同一份真相，避免「CLI 打包通过、宿主拒载」的漂移。

> **0.x 版本政策**：1.0 之前 minor 版本即可携带破坏性变更（semver 0.x 惯例），升级时请阅读变更说明。

## 安装

```bash
npm install @universe-editor/extension-manifest
```

## 使用

```ts
import {
  ActivationEvents,
  isValidActivationEvent,
  satisfies,
  EXTENSION_CATEGORIES,
  type IExtensionManifest,
} from '@universe-editor/extension-manifest'

// 声明激活事件时优先用构造器，避免手写字符串拼错导致永不激活
const events = [ActivationEvents.onCommand('myExt.doThing')]

// 校验扩展的 engines.universe 区间是否满足宿主 API 版本
satisfies('0.7.0', '>=0.7.0 <1.0.0') // true
```

manifest 的 zod 校验走独立 subpath（避免把 zod 拉进只需类型的调用方）：

```ts
import { parseManifest } from '@universe-editor/extension-manifest/manifest-schema'

const manifest = parseManifest(JSON.parse(packageJsonText)) // 非法 manifest 抛出可读错误
```

## 相关包

- [`@universe-editor/extension-api`](https://www.npmjs.com/package/@universe-editor/extension-api) — 扩展编程 API 面（Universe 版 `vscode.d.ts`）
- [`@universe-editor/extension-packaging`](https://www.npmjs.com/package/@universe-editor/extension-packaging) — VSIX 打包（`createVsix`）

## 文档

开发者文档见仓库 `docs/extension-dev/`（随 Phase E 落地）；API 版本协商语义见 `packages/extension-api/COMPATIBILITY.md`。

## License

Apache-2.0
