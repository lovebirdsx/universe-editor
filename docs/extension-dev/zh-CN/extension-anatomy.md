# 扩展的结构

> 一个 Universe Editor 扩展就是一个带 `package.json` 的 npm 目录：manifest 逐字段说明、激活事件的完整清单、扩展从扫描到 deactivate 的生命周期，以及 `activate` 收到的 `ExtensionContext`。以 API 0.12.0 为准。

## 最小形态

一个可加载的扩展只需要三样东西：

```
my-extension/
  package.json        # manifest（本文主角）
  dist/extension.js   # main 指向的入口模块，导出 activate / 可选 deactivate
  icon.png            # 可选，市场图标
```

宿主扫描扩展目录时先读 `package.json` 做 schema 校验——**manifest 非法的扩展会被整体跳过并记日志，不影响其他扩展**。校验规则即下表；manifest 里出现 schema 之外的顶层字段不会被拒（向前兼容），但不要依赖这一点存放私货。

## manifest 逐字段

### 必填

| 字段 | 说明 |
|---|---|
| `name` | 扩展 id 的下半部分（npm 小写名规则，如 `my-extension`）。 |
| `version` | 扩展自身版本。发布时必须是纯 `x.y.z`——宿主的版本协商不认识 prerelease 标签，`uex package` 对带标签的版本直接报错。 |
| `engines` | **整个对象必填**，且必须含 `engines.universe`。它声明的是**扩展 API 版本**区间，不是编辑器版本；推荐 `">=0.12.0 <1.0.0"`，**不要用 `^0.x`**。语义与理由见 [API 版本与 `engines.universe`](./versioning.md)，此处不重复。 |

### 可选（身份与入口）

| 字段 | 说明 |
|---|---|
| `publisher` | 发布者名。扩展 id = `<publisher>.<name>`；无 `publisher` 时 id 为裸 `name`。本地开发可以不写，但 `uex package` / `uex publish` 会拒绝缺 `publisher` 的包。 |
| `displayName` | 市场与扩展视图里展示的名字；缺省等于 `name`。 |
| `description` | 简介，显示在市场详情页。 |
| `main` | 入口模块，相对扩展根（如 `./dist/extension.js`），须指向打包后的 ESM 产物。没有 `main` 的扩展是纯声明式扩展（如纯主题）：只有 `contributes`，不执行代码，也谈不上激活。 |
| `activationEvents` | 激活事件清单，见下文「激活事件」。 |
| `contributes` | 静态贡献点（commands / menus / keybindings / configuration / jsonValidation / customEditors / themes / iconThemes / productIconThemes / grammars / mcpServers）。逐项语法见 [贡献点参考](./contribution-points.md)。 |
| `capabilities` | 能力声明，目前只有 `untrustedWorkspaces`，见下文专节。 |

### 市场展示元数据（纯附加）

以下字段全部可选，只影响市场页面呈现，不影响加载与激活：`categories`（分类 id，须在宿主的合法分类表内）、`keywords`、`icon`（相对扩展根的路径，建议 128×128 png，且**必须同时列入 `files`** 否则不会进包）、`repository`（url 字符串或 `{ type, url }` 对象）、`homepage`、`license`（SPDX 标识）、`preview`（为 `true` 时市场显示 preview 徽标）。

### `files`：打包白名单（不在 schema 里）

`files` 是 npm 惯例的打包白名单，**不在宿主 manifest schema 里、宿主不校验**，但它是 `uex package` 的硬规则：

- 缺 `files`（或为空数组）会被 `uex package` 直接**拒包**（error，不是 warning）。白名单制保证 `node_modules`、`.env` 之类永远不可能被意外打进 `.vsix`。
- 声明了 `main` 又没写 `files` 时，打包默认只带 `package.json` + `dist/`；`package.json` 本身永远进包。
- 条目是字面相对路径（文件或目录），`./` 前缀与 `/**` 后缀会被归一化；**不允许 glob**（`*.png` 报错），不允许逃逸扩展根（`../`、绝对路径报错）。
- 典型写法：`"files": ["dist", "icon.png"]`。manifest 里用相对路径引用的资源（`icon`、`contributes.themes[].path`、`jsonValidation[].url` 等）都必须能在 `files` 覆盖范围内找到。

## 激活事件

扩展是懒加载的：声明 `activationEvents` 之后，宿主在对应事件首次发生时激活你。当前支持的事件（与 `COMPATIBILITY.md` 的清单一致）：

| 事件 | 触发时机 |
|---|---|
| `*` | 扩展系统启动即激活（eager，慎用，拖慢启动） |
| `onStartupFinished` | 工作台完成初次恢复后 |
| `onCommand:<commandId>` | 你贡献的命令首次被调用 |
| `onLanguage:<languageId>` | 该语言的文档首次打开 |
| `onView:<viewId>` | 你贡献的视图首次显示 |
| `onCustomEditor:<viewType>` | 该 viewType 的自定义编辑器首次打开 |

两条硬规则：

- **未知事件直接拒载**。宿主扫描时用 `isValidActivationEvent` 校验，拼错（比如 `onComand:`）或冒号后为空（`onCommand:`）都会让整个 manifest 校验失败，扩展被跳过——而不是静默不激活。这是特意设计的护栏。
- **宿主不会从 `contributes` 自动推导激活事件**——贡献了命令却没声明对应 `onCommand:`，扩展永远不会被唤醒。反向的错配（声明了 `onCommand:` 却在 `contributes.commands` 里找不到同名命令）会被 `uex package` 打 warning。

写代码时优先用构造器而不是手写字符串：`@universe-editor/extension-manifest` 导出 `ActivationEvents.onCommand(id)` / `onLanguage(lang)` / `onView(viewId)` / `onCustomEditor(viewType)` 及常量 `startup` / `startupFinished`，避免手滑。

## capabilities.untrustedWorkspaces

声明扩展在**不受信任工作区**里的行为（Workspace Trust 的完整模型见 [安全与信任](./security-and-trust.md)）。三种形态：

```jsonc
// 形态一：完全支持——不受信任的工作区里也照常激活
{ "capabilities": { "untrustedWorkspaces": true } }

// 形态二：不支持——不受信任的工作区里不激活（VSCode 的 DisabledByTrustRequirement）
{ "capabilities": { "untrustedWorkspaces": {
  "supported": false,
  "description": "本扩展要运行工作区内的构建脚本，需要信任的工作区。"
} } }

// 形态三：受限支持——激活但自行降级
{ "capabilities": { "untrustedWorkspaces": {
  "supported": "limited",
  "description": "不受信任时仅提供只读预览，不写配置、不执行代码。",
  "restrictedConfigurations": ["myExt.allowArbitraryCode"] // 可选
} } }
```

要点：

- **默认值规则**：有 `main` 且未声明 → 按 `supported: false` 处理（需要信任）；无 `main` 的纯 UI 扩展（如纯主题）→ 按 `true` 处理。
- 两种对象形态的 `description` 都是**必填**——写清楚为什么需要信任、或受限模式下哪些功能不可用。
- `limited` 的扩展照常激活，**由扩展自己**在运行时读 `workspace.isTrusted` 关掉危险功能；`restrictedConfigurations` 声明受限模式下允许写入的配置键，宿主限制你写这个清单之外的配置。
- 判断标准一句话：**你的扩展会按工作区内容执行代码、跑构建、发网络请求吗？** 会，就保持默认（需要信任）。

## 激活生命周期

```
扫描（校验 manifest、协商 engines.universe）
   → 事件首次发生（命令被调用 / 文档打开 / …）
   → 信任门控检查
   → import(main) 并调用 activate(context)   ← 恰好一次
   → …运行中…
   → 宿主关闭/扩展宿主重启：deactivate?.() → dispose subscriptions
```

- **懒激活**：只有事件匹配时才 `import(main)`。`*` 与 `onStartupFinished` 在扩展系统启动阶段统一派发；`*` 会匹配此后的一切事件（通配）。
- **`activate` 恰好调一次**：重复事件、多个事件命中同一个扩展，都命中激活缓存；并发触发同一扩展共享同一个 in-flight promise，不会并行激活两次。`activate` 返回的 thenable 会被 `await`——可以在里面放心做异步初始化。
- **激活失败不拖垮宿主**：`activate` 抛错（或模块加载失败）只记日志并上报给界面（扩展视图能看到失败原因），宿主与其他扩展不受影响；该扩展此后视为未激活，下次事件仍会重试。
- **Workspace Trust 门控**：工作区未受信任且扩展 `supported: false`（含「有 `main` 未声明」的默认情形）→ **不激活**；事件照常记录。用户授予信任后，宿主**重放**此前已 fire 过的全部激活事件，被门控的扩展随即激活——不需要用户重开文档。`limited` 扩展不受影响、照常激活。**内置扩展与经 `--extension-development-path` 加载的开发中扩展恒豁免**门控。撤销信任则重启扩展宿主，从头计算门控。
- **关闭与重启**：宿主关闭（或「重启扩展宿主」）时，对每个已激活扩展先调 `deactivate?.()`，再逐个 `dispose` `context.subscriptions`。`deactivate` 是**同步 best-effort**：抛错被吞掉不阻塞其他扩展，返回的 promise **不会被 await**——宿主即将退出，要紧的是 subscriptions 里同步的资源回收（比如 kill 你 spawn 的子进程）。所以请把子进程、文件句柄这类 OS 资源包成 Disposable 推进 `subscriptions`，不要在 `deactivate` 里做异步收尾。

## ExtensionContext

`activate(context)` 收到的对象（以 API 0.12.0 的类型定义为准）：

```ts
export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    // 你注册的每个 Disposable（命令、事件监听、provider…）都推进来，
    // 扩展停用时宿主统一 dispose
  )
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `subscriptions` | `Disposable[]` | 扩展持有的全部可释放资源。宿主在停用时逐个 `dispose`（同步、错误隔离）。**只 push 不删**。 |
| `extensionPath` | `string` | 扩展根目录的绝对路径。读随包资源（schema、语法文件、图片）时基于它拼路径。 |
| `globalStoragePath` | `string` | 扩展私有的全局存储目录（`<globalStorageHome>/<extId>`），跨工作区、跨会话持久，适合缓存大文件。父目录存在，该子目录由你在首次写入时自建。**未配置存储后端时为空串**——把空串当「无持久存储可用」处理，别拿它拼路径。 |
| `globalState` | `Memento` | 全局键值存储（跨工作区）。`get` 同步读；`update(key, value)` 写（`value` 传 `undefined` 即删除该键），持久化是 fire-and-forget——返回的 promise 立即 resolve，落盘在后台进行。 |
| `workspaceState` | `Memento` | 同 `globalState`，但作用域是当前工作区。 |

**当前版本没有的东西**（从 VSCode 移植时最容易踩的空）：

- 无 `secrets`（密钥存储表面尚未提供）；
- 无 `storagePath`（VSCode 的工作区级存储路径）；
- 无 `extensionUri`（只有 `extensionPath`）；
- 无 `environmentVariableCollection`。

用到这些的 VSCode 扩展请先看 [从 VSCode 移植](./migration-from-vscode.md) 的缺失对照表。

## 完整 package.json 示例

```jsonc
{
  // ---- 必填三件套 ----
  "name": "my-extension",              // id 下半部分（npm 小写名规则）
  "version": "0.1.0",                  // 纯 x.y.z，不支持 prerelease
  "engines": {
    "universe": ">=0.12.0 <1.0.0"      // 扩展 API 版本区间（非编辑器版本）；勿用 ^0.x
  },

  // ---- 身份与入口 ----
  "publisher": "acme",                 // 完整 id = acme.my-extension；发布必填
  "displayName": "My Extension",
  "description": "一句话说清这个扩展干什么",
  "license": "Apache-2.0",             // SPDX 标识
  "type": "module",                    // 入口产物为 ESM
  "main": "./dist/extension.js",       // 入口模块（相对扩展根）；无 main = 纯声明式扩展

  // ---- 懒激活：命令首次被调用时唤醒（宿主不做自动推导，必须与 contributes 对应）----
  "activationEvents": ["onCommand:my-extension.helloWorld"],

  // ---- 静态贡献点（详见 ./contribution-points.md）----
  "contributes": {
    "commands": [
      { "command": "my-extension.helloWorld", "title": "My Extension: Hello World" }
    ]
  },

  // ---- Workspace Trust：有 main 未声明 = 默认需要信任，最安全，按需再改 ----
  // "capabilities": { "untrustedWorkspaces": true },

  // ---- 市场展示元数据（全部可选，纯附加）----
  "categories": ["Other"],
  "keywords": ["hello", "demo"],
  "icon": "icon.png",                  // 相对扩展根；记得同时列入 files
  "repository": { "type": "git", "url": "https://github.com/acme/my-extension" },
  "homepage": "https://github.com/acme/my-extension#readme",
  // "preview": true,                  // 市场显示 preview 徽标

  // ---- 打包白名单：不在宿主 schema 里，但 uex package 缺它直接拒包 ----
  "files": ["dist", "icon.png"],       // 字面路径，无 glob；main 存在时缺省只打 dist

  // ---- 以下为 npm 层惯例字段，宿主不读 ----
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "universe:prepublish": "npm run build"
  },
  "devDependencies": {
    "@universe-editor/extension-api": "^0.12.0"
  }
}
```

## 相关阅读

- [API 版本与 `engines.universe`](./versioning.md) — `engines.universe` 的协商语义与 0.x 版本政策
- [贡献点参考](./contribution-points.md) — `contributes` 每个分支的逐字段语法
- [API 概览](./api/README.md) — 宿主提供的运行时能力清单
- [安全与信任](./security-and-trust.md) — 扩展的权限边界与 Workspace Trust 模型
