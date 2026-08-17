# @universe-editor/e2e-contract

Universe Editor e2e 探针契约包：`window.__E2E__` 探针的类型与常量（`E2EProbe` 接口 + 探针键常量），供 [`@universe-editor/e2e-harness`](https://www.npmjs.com/package/@universe-editor/e2e-harness) 与编辑器共享同一份真相，避免「测试侧调用的方法与渲染侧实际安装的探针」漂移。

编辑器在 `UNIVERSE_E2E=1` 启动时，把探针安装到 renderer 主世界的 `window.__E2E__`（安装点在 `apps/editor/src/renderer/e2e/probe.ts`）；e2e 侧经本包的类型安全地调用探针方法。

> **0.x 版本政策**：1.0 之前 minor 版本即可携带破坏性变更（semver 0.x 惯例）。

## 契约漂移约定

契约随编辑器演进：本包的 `E2EProbe` 类型与编辑器侧探针安装代码保持一致。升级编辑器时请同步升级本包，否则测试侧会拿到过时或缺失的探针方法定义。

## 安装

```bash
npm install --save-dev @universe-editor/e2e-contract
```

## License

Apache-2.0
