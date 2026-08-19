# Context Key 清单

> 写 `menus` / `keybindings` 的 `when` 子句时,可以引用宿主提供的 context key。本页以宿主 API 0.12.0 为准。

## when 表达式语法

`when` 是字符串形式的小型表达式,宿主解析后按当前 context 求值。支持:

| 语法 | 含义 |
|---|---|
| `key` | key 的布尔值为真(裸 key 即真值判断) |
| `true` / `false` | 字面量 |
| `!expr` | 取反 |
| `expr && expr` / `expr \|\| expr` | 与 / 或 |
| `(expr)` | 括号分组 |
| `key == value` / `key != value` | 相等 / 不等(`== true` / `== false` 等价于裸 key / 取反) |
| `key =~ /regex/flags` | 正则匹配(JS 正则字面量,支持 flags;`g`/`y` 会被忽略) |
| `key < value` / `key <= value` / `key > value` / `key >= value` | 数值比较 |
| `key in otherKey` / `key not in otherKey` | 集合成员判断——`otherKey` 是**另一个 context key**,其值为数组或对象 |

注意:没有 `!~` 运算符,正则否定写 `!(key =~ /regex/)`;`in` 的右操作数必须是 context key 名而不是字面量列表。

内置 perforce 扩展的实证示例:

```jsonc
{ "command": "perforce.edit", "when": "resourceScmProvider =~ /\\|perforce\\|/ && !explorerResourceIsFolder" }
```

## 清单说明

宿主**没有中心注册表**——context key 散落在各视图的 scoped context 里。本清单是人工维护的「扩展作者可用且有语义」子集:**未列出的 key 是宿主内部实现细节,不承诺稳定**。每个 key 的取值见「值」列,作用域见所在分组。

## 通用种子键(全局可用)

### 平台与工作区

| key | 值 |
|---|---|
| `isWindows` / `isMac` / `isLinux` | 布尔,当前平台 |
| `isRemoteWorkspace` | 布尔,工作区是否为远程(remote:// 等非 file scheme) |
| `remoteRevealInOsSupported` | 布尔,远程工作区是否支持「在系统资源管理器中显示」(仅 Windows + WSL authority 为真) |

### 布局与焦点

| key | 值 |
|---|---|
| `activityBarVisible` / `sideBarVisible` / `secondarySideBarVisible` / `panelVisible` | 布尔,各 Part 可见性 |
| `activityBarFocus` / `sideBarFocus` / `secondarySideBarFocus` / `editorAreaFocus` / `panelFocus` / `statusBarFocus` | 布尔,焦点是否在该 Part 内 |
| `focusedPart` | 字符串,当前含焦点的 Part id,无焦点为空串 |
| `focusedView` | 字符串,当前含焦点的 View id,无焦点为空串 |
| `editorFocus` | 布尔,Monaco 任意 widget 持有焦点 |
| `editorTextFocus` | 布尔,编辑器文本输入区持有焦点(与 `editorFocus` 的区别:后者覆盖任何 Monaco widget) |
| `terminalFocus` | 布尔,终端持有焦点 |

### 活动编辑器

| key | 值 |
|---|---|
| `hasActiveEditor` | 布尔,是否有活动编辑器 |
| `activeEditorId` | 字符串,活动编辑器 id |
| `activeEditorLanguageId` | 字符串,活动编辑器语言 id(非文件编辑器为空串) |
| `activeEditorTypeId` | 字符串,活动编辑器类型 id |
| `isInDiffEditor` / `isInMergeEditor` | 布尔,活动编辑器是否为 diff / merge |
| `textCompareEditorVisible` | 布尔,文本对比编辑器可见 |
| `inKeybindings` | 布尔,快捷键编辑器是活动编辑器 |
| `editorLangId` | 字符串,活动编辑器语言(Monaco parity) |
| `editorReadonly` | 布尔,活动编辑器只读 |
| `editorColumnSelection` | 布尔,编辑器列选择模式 |
| `editorHasDefinitionProvider` / `editorHasImplementationProvider` / `editorHasReferenceProvider` | 布尔,该语言是否注册了对应 provider |

### 编辑器组

| key | 值 |
|---|---|
| `editorPartMultipleEditorGroups` | 布尔,编辑器区域是否多于一个组 |
| `editorIsOpen` | 布尔,是否有打开的编辑器 |
| `groupEditorsCount` | 数字,活动组内编辑器数量 |
| `activeEditorGroupIndex` | 数字,活动组序号 |
| `activeEditorGroupEmpty` | 布尔,活动组为空 |
| `activeEditorIsFirstInGroup` / `activeEditorIsLastInGroup` | 布尔,活动编辑器在组内是否第一个 / 最后一个 |
| `activeEditorIsDirty` | 布尔,活动编辑器有未保存修改 |
| `activeEditorGroupLocked` | 布尔,活动组已锁定 |

### 生命周期

| key | 值 |
|---|---|
| `workbenchReady` / `workbenchRestored` | 布尔,工作台就绪 / 完成恢复 |

## 资源管理器右键(explorer/context 作用域)

仅在该菜单弹出期间存在,值为右键目标资源的相关信息:

| key | 值 |
|---|---|
| `explorerResourceIsFolder` | 布尔,目标是目录 |
| `explorerResourceIsRoot` | 布尔,目标是工作区根 |
| `resourceScheme` | 字符串,目标资源的 scheme(如 `file`) |
| `resourceExtname` | 字符串,目标文件扩展名(含前导点、小写,如 `.xlsx`;无扩展名为空串) |
| `resourceScmProvider` | 字符串,拥有该资源的 SCM provider 编码(形如 `\|perforce\|`,用 `=~` 匹配成员) |
| `fileCopied` | 布尔,剪贴板中有已复制的文件 |
| `explorerResourceCut` | 布尔,剪贴板中有已剪切的文件 |

## 编辑器组作用域(editor/title 等)

菜单挂在编辑器组标题栏时,以下 key 在组作用域内**覆盖**全局同名键,反映该组自己的活动编辑器:

`activeEditorId`、`activeEditorType`、`activeEditorLanguageId`、`hasActiveEditor`、`isInDiffEditor`、`activeEditorGroupLocked`、`resourceScheme`、`resourceScmProvider`、`scmActiveResourceHasChanges`(布尔,活动编辑器资源有脏 diff 或 SCM 变更)、`diffEditorHasOpenableFile`、`activeEditorHasJsonSchema`(布尔,活动 JSON 编辑器匹配了 schema)。

## 各视图作用域

| key | 作用域 | 值 |
|---|---|---|
| `view` | 侧栏视图 / 视图标题栏 | 视图 id,供 `view/title` 与 `view/item/context` 的 `when` 区分视图 |
| `viewItem` | Tree View 条目右键 | 条目 `TreeItem.contextValue`,供 `view/item/context` 按条目类型筛选 |
| `timelineItem` | Timeline 条目右键 | 条目 `contextValue`,供 `timeline/item/context` 筛选 |
| `scmProvider` | SCM 视图 | SCM provider id,供 `scm/title` / `scm/inputBox` 区分 provider |
| `scmResourceGroup` | SCM 分组条目右键 | 分组 id,供 `scm/resourceGroup/context` 筛选 |
| `scmResourceState` | SCM 文件条目右键 | 文件条目 `contextValue`,供 `scm/resourceState/context` 筛选 |

## 不承诺稳定的键

以下键存在但属宿主内部 UI 状态(Monaco 小部件镜像、内联编辑仲裁、ACP 输入框等),不保证语义稳定,扩展的 `when` 不要依赖:`suggestWidgetVisible`、`findWidgetVisible`、`inlineSuggestionVisible`、`inlineEditIsVisible`、`cursorAtInlineEdit`、`tabShouldJumpToInlineEdit`、`tabShouldAcceptInlineEdit`、`acpPromptInputFocused`、`editorHasCodeActionsProvider`(恒 false)、`isInEmbeddedEditor`(恒 false)、`inReferenceSearchEditor`(恒 false)。

> 菜单命令的 handler 收到什么参数,见 [contribution-points.md 的 menus 节](./contribution-points.md#命令-handler-收到的参数)。
