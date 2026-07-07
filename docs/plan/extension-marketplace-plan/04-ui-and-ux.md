# 04 · 扩展管理 UI 与交互

> 决策沿袭：管理服务在 main，renderer 侧只做展示门面。
> 现有范式：视图注册用 `registerViewWithComponent`（[`BuiltInViewsContribution.ts`](../../../apps/editor/src/renderer/contributions/BuiltInViewsContribution.ts)）+ `ViewContainerRegistry.registerViewContainer`（[`BuiltInViewContainersContribution.ts`](../../../apps/editor/src/renderer/contributions/BuiltInViewContainersContribution.ts)）；详情页用虚拟 editor input（[`AiSettingsEditorInput.ts`](../../../apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts)）。

## 1. 两块 UI

| UI | 位置 | 对标 VSCode | 复用范式 |
|---|---|---|---|
| **Extensions 视图** | 侧栏 ViewContainer + View | Extensions viewlet | 套路 B：`registerViewContainer` + `registerViewWithComponent` |
| **扩展详情页** | 编辑器区（虚拟 input） | Extension Editor | `AiSettingsEditorInput` 同款虚拟 input |

## 2. `ExtensionsWorkbenchService`（🆕 renderer 门面）

放 `renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts`。**这是 UI 与两个 main 服务之间的唯一中介**——UI 组件只依赖它，不直接碰 gallery/management 服务。

职责：
- 通过 `ProxyChannel` 连 `IExtensionGalleryService` + `IExtensionManagementService`（对标套路 C）。
- **聚合视图模型**：把 `ILocalExtension`（已装）与 `IGalleryExtension`（市场）合并成统一的 `IExtensionEntry`，UI 只认这一个模型。
- 暴露响应式状态（用平台的 observable / Event），驱动 React 视图刷新。
- 订阅 `onDidChangeExtensions`，刷新已装状态徽标。

```ts
interface IExtensionEntry {
  id: string
  displayName: string
  publisher: string
  description: string
  iconUrl?: string
  // 状态（聚合而来）
  installed: boolean
  enabled: boolean
  installing?: boolean          // 进度中
  outdated?: boolean            // 有更新
  type?: 'user' | 'system'
  // 来源引用（操作时用）
  local?: ILocalExtension
  gallery?: IGalleryExtension
}
```

> 为什么要门面而非组件直连服务？① UI 需要"已装+市场"的聚合态（一个扩展可能同时已装且市场有新版），聚合逻辑不该散在组件里；② 隔离协议/服务细节，组件只认 `IExtensionEntry`；③ 对标 VSCode 的 `ExtensionsWorkbenchService`（它正是干这个的）。

## 3. Extensions 视图（侧栏）

### 注册（三处，套路 B）

```ts
// 1. ViewContainer（新的侧栏图标）
ViewContainerRegistry.registerViewContainer({
  id: 'workbench.view.extensions',
  label: localize('viewContainer.extensions', 'Extensions'),
  icon: 'extensions',
  order: 6,
  location: ViewContainerLocation.SideBar,
})

// 2. View + 组件（单点注册，componentKey 由 view id 派生）
registerViewWithComponent(
  { id: 'workbench.view.extensions.marketplace', name: ..., containerId: 'workbench.view.extensions', icon: 'extensions', order: 1 },
  ExtensionsView,
)
```

放一个新 contribution `ExtensionsViewContribution.ts`，在 `contributions/index.ts` 注册。

### 视图内容

```
┌─ EXTENSIONS ────────────────┐
│ 🔍 [搜索框]                  │   ← 输入触发 gallery.query（防抖）
├─────────────────────────────┤
│ ▾ INSTALLED                 │   ← getInstalled()，含 System（灰标）
│   [icon] Git         System │
│   [icon] Python  ✓ 已启用   │
│   [icon] YAML    ⟳ 有更新   │
│ ▾ MARKETPLACE (搜索结果)    │   ← gallery.query 结果
│   [icon] Rust     [安装]    │
│   [icon] Go       [安装]    │
└─────────────────────────────┘
```

- 无搜索词：显示 INSTALLED 分组（含 System）+ 可选"推荐/热门"（后置）。
- 有搜索词：显示 MARKETPLACE 结果，已装的标"已安装"。
- **市场未配置**（`GALLERY_URL` 空）：隐藏搜索与 MARKETPLACE，只留 INSTALLED + "从 VSIX 安装"入口。

## 4. 扩展详情页（虚拟 editor）

点列表项 → 在编辑器区打开 `ExtensionEditorInput`（照抄 `AiSettingsEditorInput` 结构：无状态、`scheme: 'universe'`、resource path 带扩展 id）：

```ts
const uri = URI.from({ scheme: 'universe', path: `/extension/${id}` })
```

详情页（`ExtensionEditor.tsx`）内容：

```
┌────────────────────────────────────────────┐
│ [icon] Python  v2024.1.0   [安装/卸载/禁用] │
│ ms-python · 12,345 安装 · ★4.5              │
├──────┬─────────────────────────────────────┤
│ 详情 │ README (从 gallery.getReadme 拉取)   │
│ 贡献 │ 命令表 / 配置项 / 快捷键（读 manifest.contributes）│
│ 变更 │ CHANGELOG                            │
└──────┴─────────────────────────────────────┘
```

- **贡献点标签页**：直接读 `manifest.contributes`，列出该扩展提供的命令/配置/快捷键——这对用户判断"这扩展装了会加什么"很有用，且数据已在 manifest 里，零额外成本。
- README/CHANGELOG：`gallery.getReadme`（已装的可直接读本地文件）。

## 5. 命令（🆕 actions，套路 A）

放 `renderer/actions/extensionsActions.ts`，`registerAction2` 注册：

| 命令 id | 标题 | 说明 |
|---|---|---|
| `extensions.action.installFromVSIX` | 扩展: 从 VSIX 安装… | 文件选择器 → `installVSIX`（Phase A 就有） |
| `extensions.action.showExtensions` | 扩展: 显示已安装扩展 | 打开视图 |
| `extensions.action.checkForUpdates` | 扩展: 检查扩展更新 | `checkForUpdates` |
| `extensions.action.install` | （上下文）安装 | 列表/详情按钮触发 |
| `extensions.action.uninstall` | （上下文）卸载 | 同上 |
| `extensions.action.enable` / `disable` | 启用/禁用 | 同上 |

## 6. 进度与状态反馈

- **安装进度**：订阅 `onInstallProgress`，列表项显示"下载中 45%"→"安装中"→完成。
- **需重载提示**：安装/卸载后若走"重启 host 重扫"（见 03 文档 §7），显示一个轻量提示"扩展将在重新加载后生效"，或静默重启（取决于中断可接受度）。VSCode 用"Reload Required"按钮，我们可先静默重启（restricted host 重启对用户几乎无感，因为多数时候没有活跃的 UI 依赖它）。
- **错误**：安装失败（引擎不兼容/下载失败/校验失败）弹通知，文案明确原因。

## 7. e2e 冒烟（套路 F）

Phase C 落地时加：
- `extensions/browser` 场景：打开 Extensions 视图 → 断言容器存在。
- 从 VSIX 安装：`window.__E2E__` 探针调 `installVSIX(fixture.vsix)` → 断言 `getInstalled` 含该扩展 → 断言其命令出现在命令面板 → 卸载 → 断言消失。
- 不标 `@p0`（非阻塞 CI），除非市场成为核心路径。

## 8. i18n

所有面向用户的文案走 `localize`，中文优先（项目语言约定）。同步检查 `docs/user/` 下是否需新增"使用扩展市场"文档（`docs/user/zh-CN/customization/extensions.md` 已存在，需补市场章节）。

---

**本文结论**：UI 两块——侧栏视图（套路 B）+ 详情虚拟编辑器（`AiSettingsEditorInput` 同款）；中间夹一个 `ExtensionsWorkbenchService` 门面做"已装+市场"聚合，组件只认统一的 `IExtensionEntry`。命令走套路 A。全部复用现有 renderer 范式，无新机制。
