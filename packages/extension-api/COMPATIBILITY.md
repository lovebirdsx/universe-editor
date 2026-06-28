# Extension API 兼容性策略

> `@universe-editor/extension-api` 是插件作者编程所依赖的表面（Universe 版的
> `vscode.d.ts`）。本文件定义该表面的**版本承诺、协商语义与破坏性变更流程**。
> 可执行抓手是 `src/__tests__/index.test.ts` 的契约测试——它就是 API 表面的快照。

## 版本即 API 版本

包的 `version` 字段（`src/index.ts` 导出的 `version` 常量与之保持一致）即为 API
版本。扩展在自己的 `package.json` 里用 `engines.universe` 声明所需的兼容区间，宿主
在扫描阶段用 semver 区间做满足性检查（`extensionScanner.ts` 的 `satisfies`）。

```jsonc
// 扩展的 package.json
{
  "engines": { "universe": "^0.1.0" }
}
```

## 各级版本号的表面承诺

遵循 semver，但针对"API 表面"给出明确口径：

| 变更级别 | 允许的改动 | 不允许的改动 |
|---|---|---|
| **patch**（`0.1.0 → 0.1.1`） | 修 bug、补全注释、不改变行为的内部实现 | 任何对导出名/方法签名/枚举值的改动 |
| **minor**（`0.1.x → 0.2.0`） | **新增** namespace / 方法 / 接口 / 可选参数 / 枚举成员 | 删除或重命名既有导出；改既有方法签名；改既有枚举值 |
| **major**（`0.x → 1.0`，`1.x → 2.0`） | 删除/重命名导出、改签名、改枚举值等破坏性改动 | —— |

> **0.x 特别说明**：1.0 之前 API 仍在演进，**minor 即可承载破坏性变更**（semver 对
> 0.x 的惯例）。但即便如此，破坏性改动也必须走下方的"破坏性变更流程"，让契约测试
> 快照显式更新、`version` 显式 bump，避免"悄悄删 API、扩展激活时才 `undefined is
> not a function`"。

## engines.universe 协商语义

- 扩展不写 `engines.universe` → 当前按"不校验"放行（见 `scanExtensions` 的
  `hostApiVersion` 为 `undefined` 分支）。**建议所有扩展显式声明**。
- 写了区间但宿主 API 版本不满足 → 该扩展被跳过并记日志，不影响其它扩展。
- 推荐写法：`"^0.1.0"`（接受同主版本下的新增）；对 0.x，`^0.1.0` 等价于
  `>=0.1.0 <0.2.0`，即一旦 minor bump 携带破坏性变更，老扩展会被正确挡下。

## 弃用机制

- 计划移除的接口先打 `@deprecated since x.y — 用 ... 替代` 的 JSDoc，至少保留到下一个
  major（0.x 下至少保留到下一个 minor）。
- 运行时若可行，对已弃用 API 的首次调用打一次 `console.warn`（不重复刷屏）。
- 当前表面**无**已弃用项；本节确立规范，后续新增弃用时遵循。

## 破坏性变更流程

任何会改变 API 表面（删除/重命名导出、改方法签名、改枚举值）的改动：

1. 更新 `src/__tests__/index.test.ts` 里的 `RUNTIME_EXPORTS` / `NAMESPACE_METHODS`
   / 枚举值断言——这是表面快照，diff 即变更评审点。
2. 按上表 bump `src/index.ts` 的 `version` 与 `package.json` 的 `version`。
3. 在本文件追加一条变更记录（见下）。
4. 受影响的内置扩展同步更新其 `engines.universe`。

## 1.0 冻结时间线

1.0 是 API 表面的稳定承诺起点。冻结条件（达成后发布 1.0）：

- 语言 provider 全量迁移到扩展（见 memory `language-features-plugin-migration-roadmap`）后，
  `languages` namespace 表面趋于稳定；
- `window` / `workspace` 的编辑器/文档能力补齐至覆盖内置扩展所需；
- 契约测试覆盖全部 namespace（已达成）。

1.0 之后：minor 仅做向后兼容的新增，破坏性变更一律走 major。

## 变更记录

- `0.1.0` — 首个有记录的 API 表面。namespaces：`commands` / `window` / `workspace` /
  `languages` / `scm` / `ai`。契约测试与本策略文档同时建立。

## 激活事件清单（activation events）

扩展在 `package.json` 的 `activationEvents` 声明唤醒时机。手写字符串易拼错（拼错则
永不激活），故：

- **优先用构造器**：`@universe-editor/extensions-common` 的 `ActivationEvents` /
  `commandActivationEvent` / `languageActivationEvent` / `viewActivationEvent`。
- **manifest 校验兜底**：宿主扫描时用 `isValidActivationEvent` 校验，未知事件直接
  报 `invalid manifest` 跳过该扩展（而非静默不激活）。

支持的事件：

| 事件 | 触发时机 | 构造器 |
|---|---|---|
| `*` | 扩展系统启动即激活（eager，慎用） | `ActivationEvents.startup` |
| `onStartupFinished` | 工作台完成初次恢复后 | `ActivationEvents.startupFinished` |
| `onCommand:<id>` | 贡献的命令首次被调用 | `ActivationEvents.onCommand(id)` |
| `onLanguage:<languageId>` | 该语言的文档首次打开 | `ActivationEvents.onLanguage(lang)` |
| `onView:<viewId>` | 贡献的视图首次显示 | `ActivationEvents.onView(viewId)` |

新增事件类型时：在 `extensions-common/src/activation.ts` 加构造器 + 把前缀加入
`PARAMETERIZED_PREFIXES`，并更新本清单。
