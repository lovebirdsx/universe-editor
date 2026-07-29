# @universe-editor/extension-packaging

Universe Editor 扩展的 VSIX 打包与读取。与编辑器宿主共用同一份 manifest 校验真相（`@universe-editor/extension-manifest`），保证「CLI 打包通过」与「宿主可加载」不漂移。

> **0.x 版本政策**：1.0 之前 minor 版本即可携带破坏性变更（semver 0.x 惯例）。

## 安装

```bash
npm install @universe-editor/extension-packaging
```

## 使用

```ts
import { createVsix, readVsixManifest } from '@universe-editor/extension-packaging'

// 把一个扩展目录打成 VSIX：先经 zod 校验 manifest，再按 package.json 的
// files[] 白名单收文件（存在时附带 README.md / CHANGELOG.md），zip-slip 防护。
await createVsix('./my-extension', './publisher.my-extension-0.1.0.vsix')

// 读取已有 VSIX 内 extension/package.json 的 manifest（校验后返回）
const manifest = readVsixManifest('./publisher.my-extension-0.1.0.vsix')
```

## 相关包

- [`@universe-editor/extension-api`](https://www.npmjs.com/package/@universe-editor/extension-api) — 扩展编程 API 面
- [`@universe-editor/extension-manifest`](https://www.npmjs.com/package/@universe-editor/extension-manifest) — manifest 类型 / 校验 / 激活事件 / 版本协商

## License

Apache-2.0
