# API 版本与 `engines.universe`

> 面向扩展作者的版本协商说明：你的扩展会被什么版本的宿主加载、`engines.universe` 怎么写才安全。

## 三句话

1. `engines.universe` 声明的是**扩展 API 版本**（= `@universe-editor/extension-api` 的 npm 包版本），**不是编辑器版本**（编辑器自身的 0.1.x 版本号与 API 版本无关）。
2. 推荐区间：`">=0.7.0 <1.0.0"`——下界是你实际用到的最低 API 版本（用了哪次 minor 引入的新能力，就把下界抬到那次 minor；例如用到 0.8.0 引入的 `contributes.mcpServers`，下界就抬到 `>=0.8.0`），上界锁定 1.0 之前。
3. **不要用 `^0.x`**：caret 在 0.x 下等价于 `>=0.x.0 <0.(x+1).0`，会把任何 minor bump——哪怕是向后兼容的纯新增——都挡在门外，导致你的扩展在宿主升级后被拒载。

```jsonc
// 扩展的 package.json
{
  "engines": { "universe": ">=0.7.0 <1.0.0" }
}
```

## 0.x 版本政策

1.0 之前 API 仍在演进，**minor 版本即可携带破坏性变更**（semver 0.x 惯例）。每次破坏性变更都经过显式流程把关：契约测试快照更新 + 版本 bump + 变更记录（见仓库 [`packages/extension-api/COMPATIBILITY.md`](../../../packages/extension-api/COMPATIBILITY.md)，含各级版本号的表面承诺与完整变更历史）。1.0 之后 minor 只做向后兼容的新增，破坏性变更一律走 major。

## 查询宿主的 API 版本

你的扩展会被什么版本的宿主加载，取决于用户安装的编辑器内嵌的 API 版本：

- 命令行：`universe-editor --version`（输出含 `Extension API 0.12.0` 行）
- 编辑器内：菜单栏 帮助 → 关于 Universe Editor（About 对话框含 Extension API 行）
- 编辑器每次 Release Notes 都会标注本次的 API 版本

不满足 `engines.universe` 区间的扩展：宿主扫描阶段跳过并记日志，不影响其他扩展。未声明 `engines.universe` 的扩展当前按「不校验」放行，但**请务必显式声明**——不校验是给历史的宽限，不是推荐做法。

## 相关阅读

- [扩展开发文档首页](./README.md) — 完整的开发者旅程与文档地图
- [发布扩展](./publishing.md) — 版本不可变规则与发布流程
- [`@universe-editor/extension-api`](https://www.npmjs.com/package/@universe-editor/extension-api) — API 面包（版本即 API 版本）
- [`@universe-editor/extension-manifest`](https://www.npmjs.com/package/@universe-editor/extension-manifest) — 激活事件构造器 / manifest 类型与校验 / `satisfies` 协商实现
