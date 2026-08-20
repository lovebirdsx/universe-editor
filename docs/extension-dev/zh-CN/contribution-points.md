# 贡献点参考

> `contributes` 是扩展在 `package.json` 里声明的静态能力清单——命令、菜单、快捷键、设置、自定义编辑器等。宿主在扩展激活**之前**就把这些声明翻译成核心注册表里的条目：你的命令因此能出现在命令面板里、被点击时才触发懒激活。本文逐个列出宿主当前（API 0.13.0）真实支持的贡献点，每个一节：字段、行为、示例。

## 总览

| 贡献点 | 用途 |
|---|---|
| `commands` | 注册命令，默认进命令面板 |
| `menus` | 把命令/子菜单挂到宿主各处的菜单 |
| `submenus` | 声明可复用的嵌套子菜单 |
| `keybindings` | 给命令绑定默认快捷键 |
| `configuration` | 往设置系统注册配置项 |
| `jsonValidation` | 给 JSON 文件关联 schema（校验/补全） |
| `customEditors` | 为匹配的文件注册 webview 自定义编辑器 |
| `viewsContainers` | 声明扩展自有的 ViewContainer（活动栏） |
| `views` | 往 ViewContainer 里声明 Tree View |
| `themes` | 颜色主题 |
| `iconThemes` | 文件图标主题 |
| `productIconThemes` | 产品图标主题 |
| `colors` | 声明自定义主题色（供 `ThemeColor` 装饰引用） |
| `grammars` | TextMate 语法（词法高亮） |
| `languages` | 声明语言（id / 文件关联 / language-configuration） |
| `mcpServers` | 声明式注入 MCP server（stdio），供 AI agent 会话使用 |

**前向兼容**：`contributes` 对象本身是透传（passthrough）校验的——写了宿主不认识的贡献点不会报错，会被静默忽略。这是为了旧宿主能加载新扩展，不是给你试验幻想贡献点的许可证：**只写本文列出的分支**。

## commands

注册一个命令。命令 id 同时是激活事件锚点：`onCommand:<command>`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | 命令 id，如 `my-extension.helloWorld` |
| `title` | string | 是 | 命令面板/菜单里显示的标题 |
| `category` | string | 否 | 命令面板里的分类前缀（显示为 `Category: Title`） |
| `icon` | string | 否 | 图标标识，由宿主解析为具体图标 |

```jsonc
{
  "contributes": {
    "commands": [
      { "command": "eslint.restart", "title": "Restart ESLint Server", "category": "ESLint" }
    ]
  }
}
```

行为：

- 声明的命令**默认出现在命令面板**里。首次调用走 bootstrap proxy：宿主先派发 `onCommand:<command>` 激活事件，等扩展激活并注册真正的 handler，再把调用路由过去。
- 想**不进命令面板**（命令只从菜单/快捷键触发）：在 `menus.commandPalette` 里为该命令显式声明一条（通常配 `when` 条件），声明即覆盖默认条目。
- 命令 id 与宿主内置命令冲突时，扩展的声明被忽略（内置优先）。

> `title` / `category` 等用户可见字符串支持 `%key%` 本地化，见 [语言特性 · 本地化](./language-guide.md#本地化)。

## menus

把命令或子菜单挂到宿主的菜单位置。结构是 `{ "<位置>": [ <菜单项>... ] }`。

| 菜单项字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 二选一 | 点击执行的命令 id |
| `submenu` | string | 二选一 | 嵌套子菜单的 id（须在 `submenus` 里声明） |
| `when` | string | 否 | ContextKey 表达式，决定条目何时可见（可用 key 见 [Context Key 清单](./context-keys.md)） |
| `group` | string | 否 | 分组与排序，支持 `group@order` 形式（如 `navigation@1`） |
| `icon` | string | 否 | 图标标识 |

每个菜单项必须有 `command` 或 `submenu` 之一——都没有则 manifest 校验失败，整个扩展被拒载。

宿主当前支持的菜单位置（12 个 + 任何已声明的 submenu id）：

| 位置 key | 出现的地方 |
|---|---|
| `commandPalette` | 命令面板（用途见 commands 节的 opt-out） |
| `editor/title` | 编辑器标签页标题栏右侧 |
| `editor/context` | 编辑器内右键菜单 |
| `explorer/context` | 资源管理器右键菜单 |
| `view/title` | 侧栏视图标题栏 |
| `scm/title` | 源代码管理视图标题栏 |
| `scm/resourceState/context` | SCM 单文件条目右键 |
| `scm/resourceGroup/context` | SCM 分组条目右键 |
| `scm/resourceFolder/context` | SCM 文件夹条目右键 |
| `scm/inputBox` | SCM 提交输入框区域 |
| `timeline/item/context` | Timeline 条目右键 |
| `view/item/context` | Tree View 条目右键（`when` 可用 `view` = 视图 id、`viewItem` = 条目 `contextValue`） |

### 命令 handler 收到的参数

菜单命令的 handler 参数由**宿主 UI 契约**决定（不写进 API 的 d.ts，那里是 API 面）。以下以宿主 0.13.0 的真实实现为准，URI 与类实例经跨进程 IPC 后都是 JSON 序列化副本：

| 位置 | 第一个参数 | 第二个参数 |
|---|---|---|
| `commandPalette` / `scm/title` / `scm/inputBox` | 无 | — |
| `editor/title` | `{ groupId: number }` 编辑器组 id | — |
| `editor/context` | 右键的文档 URI（`UriComponents`，需 `URI.revive()` 恢复） | — |
| `explorer/context` | `{ target, resource, parent, isDirectory: boolean }` | — |
| `view/title` | 视图 id（字符串） | — |
| `scm/resourceState/context` | `{ resourceUri: string, contextValue?: string, scmResourceGroupId: string }` | 多选行的同形数组 |
| `scm/resourceGroup/context` | `{ rootUri, sourceControlId, scmResourceGroupId }` | — |
| `scm/resourceFolder/context` | `{ resourceUri: string, isDirectory: true, scmResourceGroupId: string }` | 子树下全部文件行的同形数组（同 resourceState 形） |
| `timeline/item/context` | timeline item 对象（序列化副本，原型丢失） | — |
| `view/item/context` | provider `getChildren` 返回的**原始 tree element 本体**（host 进程内直接传递，非序列化副本） | — |

两点注意：

- **`explorer/context` 的 `resource`/`target`/`parent` 是 `UriComponents` 而非 `URI` 实例**——经 IPC JSON 序列化后 `fsPath` getter 丢失，从 `scheme + path` 拼路径或 `URI.revive()` 恢复（内置 perforce 扩展的 `resolveTargetPath` 是实证写法）。`parent` 恒存在（目录自身或其父目录，最坏回退工作区根）。
- **`editor/context` 的第一个参数是右键那一刻编辑器持有的文档 URI**——同样经 IPC 后是 `UriComponents`，用 `URI.revive()` 恢复。`when` 可用 `editorHasSelection` / `editorReadonly` / `editorLangId` / `resourceScheme` / `resourceExtname` 等编辑器上下文 key。
- **SCM 三个位置的 `resourceUri` 是本地文件路径字符串**（由你的 `SourceControlResource.resourceUri` 提供，`string` 类型），不是 URI。


```jsonc
{
  "contributes": {
    "menus": {
      "editor/context": [
        { "command": "my-extension.doThing", "when": "editorTextFocus", "group": "navigation@2" }
      ],
      "scm/title": [
        { "command": "my-extension.refreshScm", "group": "navigation" }
      ],
      "commandPalette": [
        { "command": "my-extension.internalHelper", "when": "neverTrue" }
      ]
    }
  }
}
```

行为：

- `group` 里的 `@order` 后缀（VSCode 约定）拆成分组名 + 数字排序值，同组内按 order 升序。
- 写了**未知的菜单位置**不会报错：宿主 `console.warn` 一条日志后忽略该项（前向兼容，新版宿主可能支持更多位置）。
- 引用未声明的 submenu id 同样 warn + 忽略。

## submenus

声明一个可复用的嵌套子菜单，之后它的 id 可以当菜单位置用（在 `menus` 里挂子项），也可以被其他菜单项通过 `submenu` 字段引用。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 子菜单 id（建议带扩展前缀，如 `my-extension.exportSubmenu`） |
| `label` | string | 是 | 显示文本 |
| `icon` | string | 否 | 图标标识 |

```jsonc
{
  "contributes": {
    "submenus": [
      { "id": "my-extension.export", "label": "Export As" }
    ],
    "menus": {
      "editor/title": [
        { "submenu": "my-extension.export", "group": "navigation" }
      ],
      "my-extension.export": [
        { "command": "my-extension.exportPng", "group": "1_formats" },
        { "command": "my-extension.exportSvg", "group": "1_formats" }
      ]
    }
  }
}
```

## keybindings

给命令绑定默认快捷键。用户后续可以在快捷键设置里改绑。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | 目标命令 id |
| `key` | string | 是 | 平台中立的按键组合，如 `ctrl+shift+g`；**支持两键 chord**，空格分隔：`ctrl+k ctrl+s` |
| `when` | string | 否 | ContextKey 表达式，决定绑定何时生效（可用 key 见 [Context Key 清单](./context-keys.md)） |
| `mac` | string | 否 | macOS 专属按键。**schema 接受该字段，但当前版本未生效**——写与不写行为一致，所有平台都用 `key` |

```jsonc
{
  "contributes": {
    "keybindings": [
      { "command": "my-extension.doThing", "key": "ctrl+alt+t", "when": "editorTextFocus" },
      { "command": "my-extension.togglePanel", "key": "ctrl+k ctrl+j" }
    ]
  }
}
```

行为：

- 快捷键的**权重由宿主固定为 ExternalExtension 档**，作者不可控——内置快捷键、用户自定义绑定与扩展默认绑定之间的冲突仲裁由宿主按档位处理。
- chord 写法是 `key` 里恰好两段、空格分隔；宿主把它解析成两段式按键序列。

## configuration

往设置系统注册配置项，用户在设置 UI / settings.json 里可见可改。扩展运行时通过 `workspace.getConfiguration()` 读取。

可以是单个节点，也可以是节点数组（多个分组）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | 否 | 设置 UI 里的分组标题 |
| `properties` | object | 是 | 配置项表：`{ "<配置键>": <属性schema> }` |

每个属性（JSON Schema 子集）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'string' \| 'number' \| 'boolean' \| 'object' \| 'array' \| 'null'` | 值类型（必填） |
| `default` | any | 默认值 |
| `description` | string | 设置 UI 里的说明文字 |
| `enum` | array | 可选值枚举（配合 `type`） |
| `minimum` / `maximum` | number | 数值上下界 |

```jsonc
{
  "contributes": {
    "configuration": {
      "title": "ESLint",
      "properties": {
        "eslint.enable": { "type": "boolean", "default": true, "description": "Enable ESLint." },
        "eslint.run": {
          "type": "string",
          "enum": ["onType", "onSave"],
          "default": "onType",
          "description": "Run the linter on type or on save."
        }
      }
    }
  }
}
```

实战参考：内置的 ESLint 扩展通过单节点声明了 `eslint.enable` / `eslint.run` / `eslint.validate` / `eslint.format.enable` / `eslint.codeActionsOnSave.enable` / `eslint.options` 六个配置项。

> `title` 与属性的 `description` 同样支持 `%key%` 本地化，见 [语言特性 · 本地化](./language-guide.md#本地化)。

## jsonValidation

给匹配 `fileMatch` 的 JSON 文件关联一个 JSON schema，宿主据此提供校验、补全与 hover。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fileMatch` | string \| string[] | 是 | 文件名/glob，如 `.eslintrc`、`*.schema.json` |
| `url` | string | 是 | schema 来源：扩展包内相对路径（如 `./schemas/entity.json`），或 http(s) url |

```jsonc
{
  "contributes": {
    "jsonValidation": [
      { "fileMatch": [".eslintrc", ".eslintrc.json"], "url": "https://json.schemastore.org/eslintrc.json" },
      { "fileMatch": "*.entity.json", "url": "./schemas/entity.json" }
    ]
  }
}
```

行为：

- **扩展包内路径**：宿主在扫描阶段读取并解析成 inline schema 注册（Monaco 的 JSON worker 不能自己取文件）。
- **http(s) url**：由宿主在 renderer 侧下载后注册；下载失败记一条 warn，该条目不生效，不影响扩展其余部分。

## customEditors

为匹配的文件注册一个 webview 支撑的自定义编辑器。声明只是**绑定**：打开匹配文件时宿主知道该用哪个 viewType、并先激活扩展；编辑器的实际内容由你在激活后通过 `window.registerCustomEditorProvider` 提供。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `viewType` | string | 是 | 编辑器类型 id；manifest 绑定与运行时 provider 注册用同一个 key |
| `displayName` | string | 是 | 「打开方式」列表里的显示名 |
| `selector` | array | 是 | 至少一项；每项 `{ "filenamePattern": "<glob>" }`，如 `*.pdf` |
| `priority` | `'default' \| 'option'` | 否 | `default` = 双击自动用它打开；`option` = 只出现在「Reopen With…」里 |
| `supportsDiff` | boolean | 否 | 为 true 时参与 Explorer 的比较菜单（两内容对比渲染）；默认 false |

```jsonc
{
  "activationEvents": ["onCustomEditor:pdf.view"],
  "contributes": {
    "customEditors": [
      {
        "viewType": "pdf.view",
        "displayName": "PDF View",
        "selector": [{ "filenamePattern": "*.pdf" }],
        "priority": "default"
      }
    ]
  }
}
```

配套激活事件是 `onCustomEditor:<viewType>`——打开匹配文件时宿主先派发它激活你的扩展，再向你索要编辑器内容。provider 注册、webview 加载、CSP 等完整细节见 [自定义编辑器与 Webview](./webview-guide.md)。

## viewsContainers

> 0.12.0 新增。使用该贡献点的扩展，`engines.universe` 下界需 `>=0.12.0`。

声明扩展自有的 ViewContainer——活动栏上的一个标签页容器（对等 VSCode 的 `contributes.viewsContainers`）。当前仅支持 `activitybar` 一个位置，VSCode 的 `panel` 位置未支持。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 容器 id（建议带扩展前缀，如 `my-extension.explorer`）；`contributes.views` 的 key 引用它 |
| `title` | string | 是 | 活动栏 hover 与侧栏标题栏显示的名称 |
| `icon` | string | 是 | codicon 名——`$(files)` 写法自动剥壳，也可直接写 `files`；未知名回退默认字形。文件路径图标未支持 |

```jsonc
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "my-extension.explorer", "title": "My Explorer", "icon": "$(files)" }
      ]
    }
  }
}
```

行为：

- 扩展容器在活动栏排在全部内置容器之后。
- 容器只是壳——里面有哪些视图由 `contributes.views` 声明。

## views

> 0.12.0 新增。使用该贡献点的扩展，`engines.universe` 下界需 `>=0.12.0`。

往 ViewContainer 里声明 Tree View（对等 VSCode 的 `contributes.views`）。结构是 `{ "<容器 key>": [ <视图>... ] }`，容器 key 三选一：

- 本扩展在 `viewsContainers` 里自声明的容器 id；
- 内置别名：`explorer` / `search` / `scm` / `outline`；
- 内置容器全 id（如 `workbench.view.explorer`）。

写了不认识的 key 不会报错：宿主 `console.warn` 一条日志后忽略该组声明（与未知菜单位置同款前向兼容）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 视图 id——激活事件锚点 `onView:<id>` 与 API 注册的 `viewId` 都用它 |
| `name` | string | 是 | 视图标题栏显示的名称 |
| `when` | string | 否 | ContextKey 表达式。求值为 **false** 时视图从容器中消失（若容器因此无任何可见视图，活动栏图标一并隐藏），引用的 context key 变化时实时重算；未填写恒为可见 |

```jsonc
{
  "activationEvents": ["onView:my-extension.nodeDeps"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "my-extension.explorer", "title": "My Explorer", "icon": "$(files)" }
      ]
    },
    "views": {
      "my-extension.explorer": [
        { "id": "my-extension.nodeDeps", "name": "Node Dependencies" }
      ],
      "explorer": [
        { "id": "my-extension.extra", "name": "Extra" }
      ]
    }
  }
}
```

行为：

- 声明只是注册空壳视图；内容在扩展激活后由 `window.registerTreeDataProvider(viewId, provider)` 或 `window.createTreeView(viewId, { treeDataProvider })` 提供，写法见 [API 概览 · treeView](./api/README.md#treeview--树视图)。
- 配套激活事件 `onView:<viewId>`：视图首次显示时派发（须显式声明在 `activationEvents`，宿主不做自动推导）。
- 树为懒拉取渲染（只在用户展开节点时拉其子节点）；行点击执行 `TreeItem.command`；条目右键菜单走 `view/item/context` 菜单位置。
- 首版裁剪（与 VSCode 的逐条差异见 [`packages/extension-api/COMPATIBILITY.md`](../../../packages/extension-api/COMPATIBILITY.md) 的 0.12.0 条目）：无 `reveal`/拖拽/checkbox/badge、`TreeItem.iconPath` 仅 codicon 名。刷新语义已对齐 VSCode：句柄跨刷新稳定（展开态保留）、`onDidChangeTreeData(element)` 只失效该子树。

## themes

贡献颜色主题。`path` 指向扩展包内的主题 JSON（VSCode 颜色主题格式），`uiTheme` 指明它派生自哪个基础主题。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 否 | 稳定 id；缺省取 `label` |
| `label` | string | 否 | 主题选择列表里的显示名 |
| `description` | string | 否 | 描述 |
| `uiTheme` | `'vs' \| 'vs-dark' \| 'hc-black' \| 'hc-light'` | 是 | 基础主题（亮/暗/高对比） |
| `path` | string | 是 | 主题文件，扩展根相对路径 |

```jsonc
{
  "contributes": {
    "themes": [
      { "label": "Midnight", "uiTheme": "vs-dark", "path": "./themes/midnight.json" }
    ]
  }
}
```

## iconThemes

贡献文件图标主题（资源管理器、标签页等处的文件图标）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 主题 id |
| `label` | string | 否 | 显示名 |
| `path` | string | 是 | 图标主题定义文件，扩展根相对路径 |

```jsonc
{
  "contributes": {
    "iconThemes": [
      { "id": "my-icons", "label": "My Icons", "path": "./icons/my-icon-theme.json" }
    ]
  }
}
```

## productIconThemes

贡献产品图标主题（替换 workbench 界面的内置图标）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 主题 id |
| `label` | string | 否 | 显示名 |
| `path` | string | 是 | 图标主题定义文件，扩展根相对路径 |

```jsonc
{
  "contributes": {
    "productIconThemes": [
      { "id": "my-product-icons", "label": "My Product Icons", "path": "./icons/product-icons.json" }
    ]
  }
}
```

## colors

声明自定义主题色：一个带 light/dark（及可选高对比度）默认值的颜色 id。扩展随后用 `new ThemeColor(id)` 把它引用进装饰的颜色字段（`backgroundColor` / `borderColor` / `overviewRulerColor`），颜色随当前主题自动切换。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 颜色 id，如 `my-extension.tint`；`new ThemeColor(id)` 与主题 JSON 的 `colors` 键都用它 |
| `description` | string | 是 | 颜色用途说明 |
| `defaults.light` | string | 是 | 亮色主题默认值：hex（`#RRGGBB` / `#RRGGBBAA`）或引用另一个颜色 id（如 `editor.background`） |
| `defaults.dark` | string | 是 | 暗色主题默认值，同上 |
| `defaults.highContrastLight` | string | 否 | 高对比亮色默认值；缺省回退 `defaults.light` |
| `defaults.highContrastDark` | string | 否 | 高对比暗色默认值；缺省回退 `defaults.dark` |

```jsonc
{
  "contributes": {
    "colors": [
      {
        "id": "my-extension.tint",
        "description": "The accent color for my decorations",
        "defaults": {
          "light": "#e0a0a0",
          "dark": "#a06060",
          "highContrastDark": "#ff8080"
        }
      }
    ]
  }
}
```

行为：

- **注册进颜色注册表**：宿主为每个 id 生成 `--vscode-<id>`（`.` 转 `-`）CSS 变量，随主题切换自动刷新；主题 JSON 与 `workbench.colorCustomizations` 都能覆盖它。
- **装饰引用**：`window.createTextEditorDecorationType({ backgroundColor: new ThemeColor('my-extension.tint') })` 让装饰颜色跟随主题——`backgroundColor` / `borderColor` 走 CSS 变量实时追新；`overviewRulerColor` 在创建装饰时解析为当前主题色，切换主题后需重新 `setDecorations` 才会追新（Monaco 概览标尺不能画 `var()`）。
- **id 冲突**：与已注册 id 重复时，后注册者覆盖先注册者（宿主记一条 warning）；扩展卸载/禁用时其贡献的颜色一并撤销。

## grammars

贡献 TextMate 语法，给语言提供词法高亮。`path` 指向 `.tmLanguage`（或 JSON 形式）语法文件。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `language` | string | 否 | 该语法服务的语言 id；缺省表示只供注入/被 include |
| `scopeName` | string | 是 | 语法作用域名，如 `source.mylang` |
| `path` | string | 是 | 语法文件，扩展根相对路径 |
| `embeddedLanguages` | object | 否 | scope → 语言 id 的映射（嵌入语言） |
| `tokenTypes` | object | 否 | scope → `'comment' \| 'string' \| 'regex' \| 'other'` |
| `injectTo` | string[] | 否 | 注入到哪些 scopeName |
| `balancedBracketScopes` / `unbalancedBracketScopes` | string[] | 否 | 括号配对提示用的 scope 列表 |

```jsonc
{
  "contributes": {
    "grammars": [
      {
        "language": "mylang",
        "scopeName": "source.mylang",
        "path": "./syntaxes/mylang.tmLanguage.json"
      }
    ]
  }
}
```

## languages

贡献一门语言：声明语言 id、文件关联（后缀 / 文件名 / glob）与 language-configuration.json（注释、括号、自动闭合/环绕对、词边界正则）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 语言 id（VSCode 语言 id；宿主按 grammar 同款映射并入 monaco id 空间，如 `jsonc` → `json`） |
| `aliases` | string[] | 否 | 语言别名（「更改语言模式」列表的显示名来源） |
| `extensions` | string[] | 否 | 关联的后缀，如 `.csv`；大小写不敏感，缺前导点自动补 |
| `filenames` | string[] | 否 | 关联的精确文件名，如 `Makefile`；大小写不敏感 |
| `filenamePatterns` | string[] | 否 | 关联的 glob，如 `*.sql`、`**/*.sql`（无斜杠形式匹配任意深度的 basename） |
| `mimetypes` | string[] | 否 | 关联的 MIME 类型（当前仅透传给 Monaco 语言探测；检测主路径是 extensions/filenames/patterns） |
| `configuration` | string | 否 | language-configuration.json（JSONC，允许注释）扩展根相对路径 |

```jsonc
{
  "contributes": {
    "languages": [
      {
        "id": "csv",
        "aliases": ["CSV", "csv"],
        "extensions": [".csv"],
        "filenamePatterns": ["**/*.csv"],
        "configuration": "./language-configuration.json"
      }
    ]
  }
}
```

行为：

- **文件 → 语言检测**（打开文件时的语言推断，顺序）：精确文件名（内置表 + 扩展 `filenames`）→ basename/glob（内置 pattern + 扩展 `filenamePatterns`）→ 扩展名（内置表 + 扩展 `extensions`）→ `plaintext`。同一层级里**扩展声明优先于内置表**（VSCode 语义：后注册者胜），所以扩展既能覆盖内置关联，也能为 `.csv` 这类内置表没有的后缀补上语言。
- **语言 id 注册进 Monaco**：语言声明在 Monaco 加载后统一注册，`id` 经 grammar 同款映射（`jsonc`→`json` 等）并入 monaco id 空间；新语言因此出现在「更改语言模式」列表里（列表来源 `monaco.languages.getLanguages()`）。
- **language configuration**：`configuration` 指向的 JSONC 被解析后经 `monaco.languages.setLanguageConfiguration` 应用，生效字段为 `comments` / `brackets` / `autoClosingPairs` / `surroundingPairs` / `wordPattern`（`wordPattern` 写字符串形式，编译失败则忽略该项）。其余 VSCode 字段（`indentationRules` / `onEnterRules` / `folding` 等）当前不生效。
- **纯声明式**：不需要 `main` / `activationEvents`——纯声明语言即可让匹配文件获得括号配对与注释切换。要真正着色通常还配一条 `grammars` 指向同 id 的 TextMate 语法（见 [grammars](#grammars)）。

## mcpServers

> 0.8.0 新增。使用该贡献点的扩展，`engines.universe` 下界需 `>=0.8.0`。

以声明方式往 AI agent 会话注入 MCP server——不需要写任何代码，纯 manifest 声明即可生效（纯声明式扩展同样适用）。结构是 `{ "<server 名>": <定义> }`，server 名即会话里看到的 MCP server id。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | stdio server 的可执行命令；缺失的条目会被跳过并记 warning |
| `args` | string[] | 否 | 命令行参数 |
| `env` | object | 否 | 环境变量（`{ "<名>": "<值>" }`） |
| `whenConfiguration` | string | 否 | 配置门控：引用的设置项解析为 `false` 时不注入该 server（未定义/真值则注入）。纯编辑器侧注解，不会随 server 定义发给 agent |

`command` / `args` / `env` 的字符串值支持两个变量：

- `${execPath}` —— 编辑器自带的 Electron/Node 可执行文件路径。用它跑扩展包内的 JS server（`ELECTRON_RUN_AS_NODE` 语义），用户机器上不需要装 Node。
- `${extensionPath}` —— 扩展根目录的绝对路径（正斜杠形式），用来指向包内的 server 脚本。

未知 `${...}` 变量会原样保留并记 warning（可见地降级，而不是静默产出空路径段）。

```jsonc
{
  "contributes": {
    "mcpServers": {
      "my-tools": {
        "command": "${execPath}",
        "args": ["${extensionPath}/dist/mcp-server.js"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" },
        "whenConfiguration": "myExtension.mcp.enable"
      }
    }
  }
}
```

行为：

- **运行时来源，不落盘**：解析结果作为**最低优先级**的一层并入 `acp.mcpServers` 设置的合并管线——用户在 settings.json 里写的同名 server 会覆盖扩展的贡献；贡献本身**永远不会写进 settings.json**，扩展卸载或禁用后立即消失。
- **v1 仅支持 stdio**：条目里带 `type` 字段（http/sse 等传输形态）会被跳过并记 warning。
- **容错**：非法条目（缺 `command`、空 server 名等）跳过并记 warning，不影响会话创建与扩展其余部分。多个扩展贡献同名 server 时后扫描到的覆盖先到的，并记 warning。
- **Workspace Trust 门控**：不受信任的工作区里，`untrustedWorkspaces` 解析为 `false` 的非内置扩展不注入任何 server（`limited` 仍注入，与激活门控一致）。门控状态或 `whenConfiguration` 引用的设置变化时实时重算，无需重启。

## 相关阅读

- [扩展的结构](./extension-anatomy.md) — manifest 其余字段（id、engines、activationEvents、files 等）
- [API 概览](./api/README.md) — 激活后宿主提供的运行时 API
- [自定义编辑器与 Webview](./webview-guide.md) — customEditors 的运行时半边
