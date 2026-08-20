# API 版本与 `engines.universe`

> 面向扩展作者的版本协商说明：你的扩展会被什么版本的宿主加载、`engines.universe` 怎么写才安全。

## 三句话

1. 自 `0.13.0` 起，`@universe-editor/extension-api` 包版本与**编辑器 App 版本**（`apps/editor/package.json`）是同一个版本空间（对齐 VSCode 的 product version 即 API 版本）。因此 `engines.universe` 声明的是**编辑器版本**兼容区间，不再是「API 包版本」；宿主用运行时编辑器版本（`app.getVersion()`，经 `UNIVERSE_APP_VERSION` 传给扩展宿主）做 semver 满足性检查。
2. 推荐区间：`">=0.13.0 <1.0.0"`——下界抬到你实际依赖的最低编辑器版本，上界开放整个 0.x 演进。
3. **不要用 `^0.13.0`**：0.x 下 caret 等价于 `>=0.13.0 <0.14.0`，会把任何 minor bump——哪怕是向后兼容的纯新增——都挡在门外，导致你的扩展在宿主升级后被禁用。

```jsonc
// 扩展的 package.json
{
  "engines": { "universe": ">=0.13.0 <1.0.0" }
}
```

## 0.x 版本政策

1.0 之前 API 仍在演进，**minor 版本即可携带破坏性变更**（semver 0.x 惯例）。每次破坏性变更都经过显式流程把关：契约测试快照更新 + 版本 bump + 变更记录（见仓库 [`packages/extension-api/COMPATIBILITY.md`](../../../packages/extension-api/COMPATIBILITY.md)，含各级版本号的表面承诺与完整变更历史）。1.0 之后 minor 只做向后兼容的新增，破坏性变更一律走 major。

## 查询宿主版本

你的扩展会被什么版本的宿主加载，取决于用户安装的编辑器版本：

- 运行时：扩展里用 `env.appVersion` 读宿主真实编辑器版本——这是唯一可靠方式。`@universe-editor/extension-api` 导出的 `version` 常量是**打包期常量**（本 SDK 编译目标的编辑器版本，类比 `@types/vscode` 的版本），不是运行时宿主版本。
- 命令行：`universe-editor --version`（输出含 App 版本与 `Extension API` 行，0.13.0 起两者同值）
- 编辑器内：菜单栏 帮助 → 关于 Universe Editor（About 对话框同样显示编辑器版本与 Extension API 行）
- 编辑器每次 Release Notes 都会标注本次的版本

`engines.universe` 是 manifest 的**必填字段**，缺失即 `invalid manifest`，扩展不会被加载。写了区间但宿主版本不满足的扩展：**不再静默跳过**——宿主把它标记为版本不兼容并**禁用**（扩展面板显示原因「已禁用，需要 universe X，当前 Y」+ 一次性通知），不影响其他扩展；市场安装/更新时会自动选择兼容当前编辑器版本的最新版本，无兼容版本则报错。

## 相关阅读

- [扩展开发文档首页](./README.md) — 完整的开发者旅程与文档地图
- [发布扩展](./publishing.md) — 版本不可变规则与发布流程
- [`@universe-editor/extension-api`](https://www.npmjs.com/package/@universe-editor/extension-api) — API 面（版本与编辑器 App 同空间）
- [`@universe-editor/extension-manifest`](https://www.npmjs.com/package/@universe-editor/extension-manifest) — 激活事件构造器 / manifest 类型与校验 / `satisfies` 协商实现
