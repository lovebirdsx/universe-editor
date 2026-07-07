# 01 · 打包格式与 manifest 扩展

> 决策：**兼容 VSIX**（ZIP + `extension/package.json`），不发明私有格式。
> 现有代码：manifest 类型在 [`packages/extensions-common/src/manifest.ts`](../../../packages/extensions-common/src/manifest.ts)，zod 校验在 [`packages/extension-host/src/manifest.ts`](../../../packages/extension-host/src/manifest.ts)。

## 1. VSIX 结构（兼容 VSCode）

VSIX 就是一个 ZIP，约定内部布局：

```
my-ext-0.1.0.vsix   (ZIP)
├── extension.vsixmanifest     ← XML，服务端索引用；客户端不读
├── [Content_Types].xml        ← OPC 规范文件；客户端不读
└── extension/                 ← 扩展本体
    ├── package.json           ← 客户端只认这个
    ├── dist/extension.js
    ├── images/icon.png
    ├── README.md
    ├── CHANGELOG.md
    └── package.nls.json       ← 已支持的 NLS 本地化
```

**客户端契约（关键）**：安装时只解压 `extension/` 子目录，只读 `extension/package.json` 做校验与翻译。`extension.vsixmanifest`（XML）纯服务端产物，客户端完全忽略——这与 VSCode 客户端行为一致，也让我们的读取逻辑简单（不必解析 XML）。

落盘后目录结构与现在的内置扩展**完全一致**（`<ext>/package.json` + `<ext>/dist/...`），因此 [`extensionScanner.ts`](../../../packages/extension-host/src/extensionScanner.ts) 的 `scanOne` 无需任何改动就能认领它。

## 2. `extension-packaging` 包（🆕 纯逻辑）

新建 `packages/extension-packaging`，只做 ZIP/manifest 处理，无网络、可单测：

```
readVsixManifest(vsixPath): Promise<IExtensionManifest>   // 只解 extension/package.json
extractVsix(vsixPath, targetDir): Promise<void>            // 只解 extension/** 到 targetDir
validateVsixIntegrity(vsixPath, expected?): Promise<void>  // 见 §5 完整性校验
```

依赖：一个成熟的 zip 读取库（如 `yauzl` / `adm-zip`，走 catalog 版本管理）。**不引入 `@vscode/vsce`** 作为运行时依赖——vsce 是发布侧工具，不进客户端。

## 3. manifest 市场元数据字段扩展

当前 `IExtensionManifest` 只有运行时字段（name/version/main/engines/contributes...）。市场需要**展示用**的加法字段。全部可选、纯加法，不破坏现有扩展。

### MVP 必需（展示与检索）

| 字段 | 类型 | 用途 | VSCode 对应 |
|---|---|---|---|
| `categories` | `string[]` | 分类筛选 | 同名（我们定义自己的分类集，见 §4） |
| `keywords` | `string[]` | 搜索命中 | 同名 |
| `icon` | `string` | 列表/详情图标（相对路径，建议 128×128 png） | 同名 |
| `repository` | `string \| { type, url }` | 详情页"源码"链接 | 同名 |
| `homepage` | `string` | 详情页链接 | 同名 |
| `license` | `string` | 许可标识（SPDX） | 同名 |
| `preview` | `boolean` | "预览版"徽标 | 同名 |

### 后续阶段（功能性，MVP 不做）

| 字段 | 说明 |
|---|---|
| `extensionDependencies` | 依赖其它扩展 id；需要依赖解析器 |
| `extensionPack` | 扩展包；一次装一组 |
| `galleryBanner` / `badges` / `sponsor` | 纯装饰，优先级低 |
| `extensionKind` | 远程/UI 分离；单机版无意义 |

### 类型与 zod 同步（两处必改）

1. `extensions-common/src/manifest.ts`：给 `IExtensionManifest` 加上述可选字段。
2. `extension-host/src/manifest.ts`：给 `manifestSchema` 加对应校验。

> zod 的 `manifestSchema` 目前对**顶层**字段是"精确匹配"（未 `.passthrough()`），只有 `contributesSchema` 是 `.passthrough()`。因此新加的顶层市场字段**必须**在 `manifestSchema` 里显式声明，否则会被 zod 当作合法（zod object 默认 strip 未知键，不报错）——但为了让扫描器把它们透传给 renderer，仍需显式加进 schema 和 `IExtensionDescriptionDto`。

3. `IExtensionDescriptionDto`（renderer 面向对象）：把展示字段（displayName/description/icon/categories...）纳入，供 UI 渲染。目前该 DTO 只带 id/name/displayName/activationEvents/contributes——UI 需要更多展示字段。

## 4. 扩展分类集（自定义）

VSCode 的分类是固定枚举（"Programming Languages"/"Themes"/"Snippets"...）。因为 universe-editor 是**游戏内容编辑器**，应定义贴合领域的分类，例如：

```
Language Features   语言/语法支持
Content Tools       内容制作工具
Data / Schema       数据与 schema 校验
SCM / Git           版本控制
AI                  AI 辅助
Themes              主题（未来）
Other               其它
```

分类集是**客户端与后端共享的常量**，建议放 `extensions-common`，供 manifest 校验、市场筛选、UI 三处共用。

## 5. 完整性与一致性校验（防投毒）

下载/安装时必须校验（在 `extension-packaging` + 管理服务里做）：

1. **manifest 可解析**：`extension/package.json` 存在且过 zod 校验。
2. **引擎兼容**：`satisfies(hostApiVersion, engines.universe)`（复用 [`semver.ts`](../../../packages/extensions-common/src/semver.ts)），fail-closed。**装的时候就校验**，别等到扫描时才拒。
3. **市场一致性**：从市场装时，VSIX 里的 `publisher.name` / `version` 必须与市场元数据一致——防止"市场说是 A，包里是 B"的投毒。
4. **zip 安全**：解压路径必须限制在 targetDir 内（防 `../` 路径穿越 / zip slip）。

## 6. 扩展 id 规范 ⚠️ 需你拍板

**问题**：当前 `publisher` 可选，id 退化为 `<name>`（见 `extensionId()`）。但市场需要**全局唯一 id**。

**建议**：从市场发布的扩展**强制 `publisher` 必填**，id 恒为 `<publisher>.<name>`（全小写），与 VSCode 一致。本地内置扩展可继续宽松（无 publisher），因为它们不进市场、不需要全局唯一。

**落地**：不改 `manifestSchema`（保持 publisher 可选，内置扩展兼容），而在**发布/上架侧**和**市场安装侧**强制 publisher。这样运行时宽松、分发侧严格，互不干扰。

> 需你确认：是否接受"内置宽松 / 市场严格"这个双轨规则？

## 7. 打包工具链 ⚠️ 需你拍板

VSCode 生态用 `vsce package` 生成 VSIX。但 **vsce 强制校验 `engines.vscode`**，我们用 `engines.universe`，vsce 会拒绝。三个选项：

| 选项 | 说明 | 代价 |
|---|---|---|
| **A. 提供自家打包 CLI** `uvsce`（推荐） | 一个薄 CLI：读 package.json → 生成 vsixmanifest → zip。逻辑简单（VSIX 格式公开） | 需写、需维护一个小工具 |
| B. 让扩展同时声明 `engines.vscode` | 复用 vsce | 误导——扩展并非 vscode 扩展 |
| C. fork vsce | 复用其全部特性 | fork 维护成本 |

**建议 A**：`uvsce` 放 `packages/`，复用 `extension-packaging` 的 zip 逻辑反向操作（打包）。MVP 阶段甚至可以先手动 zip 验证链路（Phase A），CLI 随 Phase B 补齐。

---

**本文结论**：格式零发明——沿用 VSIX；manifest 全加法——不破坏现有扩展；落盘后目录形态与内置扩展一致——扫描器零改动。唯二需你拍板：**id 是否双轨严格**、**打包 CLI 选型**。
