# 06 · 定制（Customization）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：帮助游戏内容创作者把编辑器调整成最顺手的工作状态——设置偏好、绑定快捷键、换主题/语言、了解内置插件能力、配置 AI 供应商。
> 依赖：[00-foundation.md](./00-foundation.md)（目录规范、加载机制、写作约定均须先行落地）
> 里程碑：M3

---

## 目录

- [1. 目标](#1-目标)
- [2. 读者与前置](#2-读者与前置)
- [3. 信息架构](#3-信息架构)
- [4. 逐页要点](#4-逐页要点)
- [5. 链接与交叉引用](#5-链接与交叉引用)
- [6. 本册注意事项](#6-本册注意事项)
- [7. 执行步骤](#7-执行步骤)
- [8. 验收标准](#8-验收标准)

---

## 1. 目标

让用户能够独立完成下列任务，无需查阅外部资料：

- 在图形界面或 JSON 文件中修改用户/工作区设置，理解两者优先级关系
- 为常用操作绑定自定义快捷键，或从 VSCode 导入已有绑定
- 切换颜色主题（深色/浅色）与界面语言（中文/英文）
- 了解六个内置扩展各自提供哪些能力，知道当前版本以内置扩展为主
- 添加、验证、管理 AI 供应商分组及其 API 密钥，并清楚密钥的安全存储机制

---

## 2. 读者与前置

**目标读者**：已完成基本工作流的游戏内容创作者，想把编辑器调整得更顺手，但不一定熟悉 JSON 配置或命令行。

**知识前置**：
- 已阅读过快速上手（01 册），知道如何打开命令面板（`Ctrl+Shift+P`）
- 对文件/文件夹的基本操作有了解
- AI 供应商配置页可选择性阅读，仅对需要接入外部 AI 服务的用户有意义

**无需前置**：不要求了解编程、Git、命令行或 JSON 语法（页内给出最小必要解释）。

---

## 3. 信息架构

| 文件路径 | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `docs/user/zh-CN/customization/settings.md` | 设置 | 图形界面设置、settings.json、用户 vs 工作区两级、VSCode 设置兼容、配置目录管理 | `preferencesActions.ts`、`configLocationActions.ts`、`zh-CN.ts`（`settings.*`、`configLocation.*`） |
| `docs/user/zh-CN/customization/keybindings.md` | 键盘快捷方式 | 快捷键编辑器、keybindings.json、VSCode 快捷键兼容、查找与自定义 | `preferencesActions.ts`（`OpenKeybindingsEditorAction`、`OpenKeybindingsJsonAction`、`OpenVSCodeKeybindingsJsonAction`）、`zh-CN.ts`（`keybindings.*`） |
| `docs/user/zh-CN/customization/themes-and-language.md` | 主题与语言 | 颜色主题切换（深色/浅色）、界面语言切换（中文/英文/跟随系统）、重启生效说明 | `preferencesActions.ts`（`SelectColorThemeAction`、`ConfigureDisplayLanguageAction`）、`availableLocales.ts`（`DISPLAY_LANGUAGE_SETTING_KEY='workbench.language'`、`SUPPORTED_LOCALES`）、`zh-CN.ts`（`colorTheme.*`） |
| `docs/user/zh-CN/customization/extensions.md` | 内置扩展 | 六个内置扩展逐一介绍能力，说明当前以内置扩展为主 | `extensions/*/package.json`（`displayName`、`description`） |
| `docs/user/zh-CN/customization/ai-providers.md` | AI 供应商配置 | 添加/管理提供方分组、设置/清除 API 密钥、OpenAI 兼容端点与 Ollama、安全红线 | `aiActions.ts`（`ManageModelsAction`、`SetApiKeyAction`、`ClearApiKeyAction`、`OpenAiSettingsJsonAction`）、`zh-CN.ts`（`aiModels.*`） |

---

## 4. 逐页要点

### 4.1 `settings.md` — 设置

**页面定位**：设置是最常用的定制入口，需让用户理解图形界面与 JSON 两种方式的关系，以及用户设置与工作区设置的优先级。

**要点清单**：

- **打开方式**（以代码为准）
  - 命令面板搜索"打开设置"（命令 `Open Settings`，快捷键 `Ctrl+,`）
  - 命令面板搜索"打开设置 (JSON)"（命令 `Open Settings (JSON)`，无默认快捷键）
  - 文件菜单 → 首选项 → 对应条目（菜单组 `5_preferences`，代码 `MenuId.MenubarFileMenu`）

- **图形界面设置编辑器**
  - 顶部有搜索栏，可按关键词过滤（i18n: `settings.search.placeholder` = "搜索设置（{count}）"）
  - 分类导航列于左侧（i18n: `settings.nav` = "设置分类"）
  - 已修改项有来源标记，区分默认/用户/工作区/VSCode 用户/VSCode 工作区（i18n: `settings.origin.*`）

- **用户设置 vs 工作区设置**
  - **用户设置**：对所有项目生效，存于用户配置目录的 `settings.json`（i18n 标签 `settings.tab.user` = "用户"）
  - **工作区设置**：仅对当前打开的文件夹生效，优先级更高；命令"打开工作区设置"（`Open Workspace Settings`）/（`Open Workspace Settings (JSON)`）；需先打开文件夹才可使用（i18n: `settings.noWorkspace` = "打开文件夹后才能编辑工作区设置。"）

- **直接编辑 JSON**
  - "打开设置 (JSON)"打开 `settings.json`，首次打开自动写入模板注释（见 `preferencesActions.ts` 的 `SETTINGS_JSON_TEMPLATE`）
  - 保存即生效，无需重启

- **VSCode 设置兼容**
  - 命令"打开 VS Code 设置 (JSON)"（`Open VS Code Settings (JSON)`）：读取 VSCode 的 `settings.json`，若文件不存在显示提示（i18n: `action.openVSCodeSettingsJson.notFound`）
  - 来源标记中会出现"VSCode 用户"/"VSCode 工作区"（i18n: `settings.origin.vscodeUser`/`settings.origin.vscodeWorkspace`）

- **配置目录管理**
  - "设置配置目录…"（`Set Config Directory…`）：选择一个文件夹作为存放 `settings.json`/`keybindings.json` 的目录，切换时可选择是否复制当前设置
  - "打开配置目录"（`Open Config Directory`）：在系统文件管理器中打开当前配置目录
  - "将配置目录重置为默认值"（`Reset Config Directory to Default`）：还原到默认位置
  - 若配置目录被命令行/环境变量锁定，三个命令均会提示无法更改（i18n: `configLocation.locked`）

- **截图占位**
  - `<!-- 截图：设置图形界面，展示搜索栏+分类导航+用户/工作区标签页 -->`
  - `<!-- 截图：用户设置 vs 工作区设置切换标签 -->`

- **相关命令汇总表**（页末）

  | 命令名（中文） | 命令 ID | 快捷键 |
  |---|---|---|
  | 打开设置 | `workbench.action.openSettings` | `Ctrl+,` |
  | 打开设置 (JSON) | `workbench.action.openSettingsJson` | 无 |
  | 打开工作区设置 | `workbench.action.openWorkspaceSettings` | 无 |
  | 打开工作区设置 (JSON) | `workbench.action.openWorkspaceSettingsJson` | 无 |
  | 打开 VS Code 设置 (JSON) | `workbench.action.openVSCodeSettingsJson` | 无 |
  | 设置配置目录… | `workbench.action.setConfigLocation` | 无 |
  | 打开配置目录 | `workbench.action.openConfigLocationFolder` | 无 |
  | 将配置目录重置为默认值 | `workbench.action.resetConfigLocation` | 无 |

---

### 4.2 `keybindings.md` — 键盘快捷方式

**页面定位**：帮助用户发现已有快捷键、为常用操作绑定个人习惯的按键，以及复用 VSCode 已有配置。

**要点清单**：

- **打开快捷键编辑器**
  - 命令"打开键盘快捷方式"（`Open Keyboard Shortcuts`），快捷键 `Ctrl+K Ctrl+S`（代码为弦和键序列 `['ctrl+k', 'ctrl+s']`）
  - 文件菜单 → 首选项 → 打开键盘快捷方式

- **编辑器界面说明**
  - 三列：命令（`keybindings.column.command`）、键盘快捷方式（`keybindings.column.keybinding`）、来源（`keybindings.column.source`）
  - 来源分"默认"（`keybindings.source.default`）和"用户"（`keybindings.source.user`）
  - 顶部搜索栏（i18n: `keybindings.search.placeholder` = "搜索键盘快捷方式（{count}）"）
  - 点击铅笔图标录制新按键（i18n: `keybindings.edit` = "编辑键盘快捷方式"）
  - 录制中显示"按下按键…"（`keybindings.record.placeholder`）及取消提示（`keybindings.record.cancelHint` = "按 Esc 取消"）
  - 还原单条绑定（`keybindings.reset` = "重置为默认值"）

- **直接编辑 JSON**
  - 命令"打开键盘快捷方式 (JSON)"（`Open Keyboard Shortcuts (JSON)`），快捷键 `Ctrl+K Ctrl+K`（代码 `['ctrl+k', 'ctrl+k']`）
  - 格式说明：`[{ "key": "...", "command": "...", "when": "..." }]`
  - `command` 加 `-` 前缀表示移除默认绑定（i18n: `keybindings.schema.removeBinding.desc`）
  - `when` 为上下文键表达式，控制生效场景（`keybindings.schema.when.description`）

- **VSCode 快捷键兼容**
  - 命令"打开 VS Code 键盘快捷方式 (JSON)"（`Open VS Code Keyboard Shortcuts (JSON)`）
  - 若 VSCode 未安装或文件不存在，显示警告（`action.openVSCodeKeybindingsJson.notFound`）

- **弦和键（Chord）说明**
  - 两段式快捷键如 `Ctrl+K Ctrl+S`，需依次按两次
  - JSON 中写法：`"key": "ctrl+k ctrl+s"`

- **截图占位**
  - `<!-- 截图：快捷键编辑器界面，展示三列+搜索栏+铅笔编辑图标 -->`
  - `<!-- 截图：录制新按键的输入状态 -->`

- **相关命令汇总表**（页末）

  | 命令名（中文） | 命令 ID | 快捷键 |
  |---|---|---|
  | 打开键盘快捷方式 | `workbench.action.openGlobalKeybindings` | `Ctrl+K Ctrl+S` |
  | 打开键盘快捷方式 (JSON) | `workbench.action.openKeybindingsJson` | `Ctrl+K Ctrl+K` |
  | 打开 VS Code 键盘快捷方式 (JSON) | `workbench.action.openVSCodeKeybindingsJson` | 无 |

- **互链**：页末指向 07 参考册的快捷键速查表（`../reference/keyboard-shortcuts.md`）

---

### 4.3 `themes-and-language.md` — 主题与语言

**页面定位**：最低门槛的高频定制操作，一句话、两步就能完成，篇幅宜短，步骤清晰。

**要点清单**：

- **切换颜色主题**
  - 命令"颜色主题"（`Color Theme`），命令 ID `workbench.action.selectTheme`，无固定快捷键（可在快捷键编辑器自定义）
  - 弹出快速选择列表（i18n: `quickInput.colorTheme.placeholder` = "选择颜色主题"）
  - 当前选项：深色（i18n: `colorTheme.dark`）与浅色（i18n: `colorTheme.light`），当前主题旁有"（当前）"标记（i18n: `colorTheme.current`）
  - 配置键 `workbench.colorTheme`（代码 `COLOR_THEME_SETTING_KEY`），存于用户设置，立即生效无需重启
  - 截图建议使用深色主题（按 00 规范）

- **切换界面语言**
  - 命令"配置显示语言"（`Configure Display Language`），命令 ID `workbench.action.configureDisplayLanguage`
  - 可选项（代码 `getDisplayLanguageOptions()`）：
    - `跟随系统语言`（i18n: `settings.enum.auto`，值 `auto`）
    - `English`（值 `en-US`）
    - `简体中文`（值 `zh-CN`）
  - 选择后弹出确认对话框，提示"显示语言已更新，重启应用后生效"（i18n: `dialog.displayLanguage.message`/`dialog.displayLanguage.detail`）
  - 配置键 `workbench.language`（`DISPLAY_LANGUAGE_SETTING_KEY`），存于用户设置
  - **重启生效**：与主题不同，语言切换需重启应用才能看到效果，要在文档中明确说明

- **提示**：若界面语言切换后出现部分未翻译，属于文档/扩展翻译尚未完全覆盖的正常情况

- **截图占位**
  - `<!-- 截图：颜色主题快速选择列表，深色选中状态 -->`
  - `<!-- 截图：配置显示语言快速选择列表 -->`

- **相关命令汇总表**（页末）

  | 命令名（中文） | 命令 ID | 快捷键 |
  |---|---|---|
  | 颜色主题 | `workbench.action.selectTheme` | 无（可自定义） |
  | 配置显示语言 | `workbench.action.configureDisplayLanguage` | 无 |

---

### 4.4 `extensions.md` — 内置扩展

**页面定位**：帮助用户了解编辑器"自带了什么"，每个扩展提供哪些额外能力，以及为什么有些功能需要打开特定类型的文件才生效。

**要点清单**：

- **概念说明**
  - 扩展（Extension）是向编辑器注册额外能力的模块，Universe Editor 目前以内置扩展为主
  - 内置扩展随编辑器一起安装，无需手动启用或下载

- **六个内置扩展逐一介绍**（信息源：各扩展 `package.json` 的 `displayName`/`description`）

  | 扩展名称 | displayName | 能力简述 |
  |---|---|---|
  | AI Assist | AI Assist | AI 辅助编辑功能，包含 AI 生成 Git 提交信息（在 SCM 输入框旁提供图标按钮） |
  | Claude Helper | Claude Helper | 为 Claude Code 的配置文件（`.claude/settings.json`、`.claude/settings.local.json`）提供 JSON schema 补全与验证 |
  | Git | Git | Git 源代码控制集成，提供提交、暂存、分支、推送、查看历史等 50+ 条 Git 命令 |
  | Markdown Language Features | Markdown Language Features | Markdown 语言特性：文档符号、定义跳转、引用查找、工作区符号、死链诊断 |
  | Numbered Bookmarks | Numbered Bookmarks | Delphi 风格数字书签（0–9）：切换书签、快速跳转、编辑时自动移位、行号槽图标 |
  | TypeScript Language Features | TypeScript Language Features | TS/JS 语言特性：定义跳转、引用查找、悬浮信息、补全、签名帮助、文档符号、重命名、诊断 |

- **扩展激活时机**说明（用简单语言解释 activationEvents）
  - Git、Numbered Bookmarks：启动完成后自动激活（`onStartupFinished`）
  - TypeScript Language Features：打开 `.ts`、`.js`、`.tsx`、`.jsx` 文件时激活
  - Markdown Language Features：打开 `.md` 文件时激活
  - AI Assist：运行"生成提交信息"命令时激活
  - Claude Helper：打开 `.claude/settings.json` 等文件时通过 JSON schema 生效（无需显式激活）

- **"当前以内置扩展为主"说明**
  - 目前编辑器不支持安装第三方扩展，所有扩展均由内置提供
  - 如有功能需求可通过反馈渠道提出

- **截图占位**
  - `<!-- 截图：SCM 输入框旁的 AI 生成提交信息图标 -->`
  - `<!-- 截图：TypeScript/Markdown 文件中的语言特性效果（如悬浮信息或文档符号） -->`

---

### 4.5 `ai-providers.md` — AI 供应商配置

**页面定位**：帮助需要接入外部 AI 服务的用户完成配置，并清楚 API 密钥的安全存储机制。本页是 06 册中安全敏感度最高的页面。

**要点清单**：

- **入口**
  - 命令"打开 AI & Agent 设置"（`Open AI & Agent Settings`），命令 ID `ai.manageModels`——打开图形化 AI 设置编辑器（`AiSettingsEditorInput`）
  - 命令"打开 AI 设置 (JSON)"（`Open AI Settings (JSON)`），命令 ID `ai.openSettingsJson`——直接编辑 `aiSettings.json`

- **添加提供方分组**（图形化界面，对应 i18n `aiModels.addProvider.*`）
  - 点击"添加提供方分组"按钮（i18n: `aiModels.addProvider.title` = "添加提供方分组"）
  - 填写字段：名称（`aiModels.addProvider.name`）、供应商（`aiModels.addProvider.vendor`）、Base URL（`aiModels.addProvider.baseUrl`，留空用提供方默认）、API 密钥（`aiModels.addProvider.apiKey`，可选）
  - "验证"按钮（`aiModels.addProvider.verify`）：连接并列出可用模型数量，失败时显示错误
  - 每个分组显示徽标：已配密钥（`aiModels.badge.keyed`）、模型数量（`aiModels.badge.modelCount`）

- **管理模型**
  - 每个分组下可看到自动枚举的模型列表（`aiModels.models`）
  - 可手动添加模型（`aiModels.addModel`）：填写端点所需模型 id（`aiModels.addModel.id`）
  - 可配置单个模型参数（`aiModels.configure` = "配置模型"）
  - 可移除分组（`aiModels.removeGroup`）或移除单个模型（`aiModels.removeModel`）

- **OpenAI 兼容端点说明**
  - 供应商选 `openai`，Base URL 填入兼容端点地址（如 LM Studio、vLLM、DeepSeek 等）
  - 无需 API 密钥时可留空（连接时省略认证头，不报错）

- **Ollama 本地部署说明**
  - 供应商选 `ollama`，Base URL 默认 `http://localhost:11434`，通常无需填写
  - 无需 API 密钥（本地服务）

- **设置 / 清除 API 密钥（命令面板方式）**
  - 命令"设置 AI 供应商 API 密钥"（`Set AI Provider API Key`），命令 ID `ai.setApiKey`：弹出提供方分组选择，再输入密钥
  - 命令"清除 AI 供应商 API 密钥"（`Clear AI Provider API Key`），命令 ID `ai.clearApiKey`：选择分组后确认清除
  - 图形界面在分组详情页也有"设置 API 密钥"（`aiModels.apiKey.setBtn`）和"清除 API 密钥"（`aiModels.apiKey.clearBtn`）按钮
  - 密钥状态显示：已存储（`aiModels.apiKey.set`）/ 未设置（`aiModels.apiKey.unset`）

- **安全红线（重点突出）**
  - API 密钥**加密存储**在操作系统安全存储（safeStorage），键名格式 `ai.secret.<vendor>.<group>.apiKey`
  - 密钥**绝不写入** `aiSettings.json`、`settings.json` 或任何明文配置文件——输入框提示文本明确说明这一点（i18n: `aiModels.setApiKey.prompt` = "输入 {group} 的 API 密钥（加密存储，绝不写入 aiSettings.json）。"）
  - 密钥不经过 renderer 进程和 IPC 协议明文传输，仅在 main 进程加密持久化
  - `aiSettings.json` 只包含分组结构、Base URL、模型列表，不含任何密钥信息——直接在文档中告知用户"把 `aiSettings.json` 分享给他人是安全的"（以消除顾虑）
  - safeStorage 不可用时操作会失败并报错，不会静默以明文存储

- **`aiSettings.json` 结构简介**（给高级用户）
  - 顶层字段：`groups`（提供方分组数组）、`activeModels`（对话/内联补全各自激活的模型 id）
  - 缺失/空文件时自动合成默认分组（`ollama/default` + `openai/default`）
  - 此文件无密钥，可随工作区提交到 Git（告知用户）

- **与 02 AI 册的分工**
  - 本页讲"如何接入供应商、如何管理密钥"
  - 02 AI 册（`../ai-agent/models-and-cost.md`）讲"如何为对话/内联补全选择激活模型、理解成本"
  - 两页互链

- **截图占位**
  - `<!-- 截图：AI & Agent 设置编辑器，展示提供方分组列表和"添加提供方分组"入口 -->`
  - `<!-- 截图：添加提供方分组的表单，展示名称/供应商/Base URL/API 密钥字段 -->`
  - `<!-- 截图：密钥已存储状态的分组徽标 -->`

- **相关命令汇总表**（页末）

  | 命令名（中文） | 命令 ID | 快捷键 |
  |---|---|---|
  | 打开 AI & Agent 设置 | `ai.manageModels` | 无 |
  | 打开 AI 设置 (JSON) | `ai.openSettingsJson` | 无 |
  | 设置 AI 供应商 API 密钥 | `ai.setApiKey` | 无 |
  | 清除 AI 供应商 API 密钥 | `ai.clearApiKey` | 无 |
  | 选择 AI 模型 | `ai.pickModel` | 无 |

---

## 5. 链接与交叉引用

### 册内互链

- `settings.md` → `keybindings.md`：提到快捷键时链过去（"也可以为设置命令自定义快捷键"）
- `keybindings.md` → 07 参考册 `../reference/keyboard-shortcuts.md`：页末"下一步"明确指向速查表
- `ai-providers.md` ↔ `themes-and-language.md`：通过语言配置键 `workbench.language` 说明语言也是一个设置值，反向引导用户知道设置的通用性

### 跨册互链

| 本册页面 | 目标册页面 | 说明 |
|---|---|---|
| `ai-providers.md` | `../ai-agent/models-and-cost.md`（02 册） | 分工说明：接入供应商在此，选用模型在 02 册 |
| `keybindings.md` | `../reference/keyboard-shortcuts.md`（07 册） | 速查表，含全量快捷键 |
| `settings.md` | `../reference/glossary.md#工作区`（07 册） | "工作区"术语首现链到术语表 |
| `extensions.md` | `../git/overview.md`（05 册） | Git 扩展能力的详细用法在 05 册 |
| `extensions.md` | `../editing/bookmarks.md`（03 册） | 数字书签详细用法在 03 册 |
| `extensions.md` | `../editing/markdown.md`（03 册） | Markdown 语言特性详细用法在 03 册 |

### 应用内深链（来自 Welcome 页 / Help 菜单）

- `universe:/doc/customization/settings` — 设置页
- `universe:/doc/customization/ai-providers` — AI 供应商配置（AI 模型选择 UI 旁可放"?"图标深链）
- 以上 scheme 由 00 册落地后的 `DocEditorInput` 机制支持

---

## 6. 本册注意事项

### 6.1 已核实的代码事实

- `OpenSettingsAction` 快捷键：`ctrl+,`（单键，不是弦和键）
- `OpenKeybindingsEditorAction` 快捷键：`['ctrl+k', 'ctrl+s']`（弦和键，两段）
- `OpenKeybindingsJsonAction` 快捷键：`['ctrl+k', 'ctrl+k']`（弦和键，两段，相同键按两次）
- `SelectColorThemeAction` 无默认快捷键（代码中未声明 `keybinding`）
- `ConfigureDisplayLanguageAction` 无默认快捷键
- 支持的语言（`SUPPORTED_LOCALES`）：`['en-US', 'zh-CN']`，另有 `'auto'`（跟随系统）
- `DISPLAY_LANGUAGE_SETTING_KEY = 'workbench.language'`
- `ManageModelsAction.title` = "Open AI & Agent Settings"，中文显示依赖运行时 i18n 翻译（i18n key `action.ai.openSettings`），文档中文标题应写"打开 AI & Agent 设置"
- `OpenAiSettingsJsonAction` 的 i18n key `action.ai.openSettingsJson`，无中文映射需查 zh-CN.ts 确认（经 Grep 未发现该 key 对应的中文条目，文档撰写时需实际启动应用确认中文显示）

### 6.2 待确认项

- `OpenAiSettingsJsonAction`（命令 ID `ai.openSettingsJson`）的中文命令名未在 `zh-CN.ts` 中找到对应翻译（只看到 `aiModels.*` 前缀的 UI 字符串，未见 `action.ai.openSettingsJson` 的中文值）——**撰写时需实际在应用内确认命令面板显示的中文名称**，目前暂记为"打开 AI 设置 (JSON)"（与 `localize2` 的英文参数对应）
- `ai-providers.md` 中"AI & Agent"在用户界面的实际中文显示需核实（i18n key `action.ai.openSettings` 在 zh-CN.ts 中的翻译值）

### 6.3 安全红线执行要求

`ai-providers.md` 的安全红线描述不可淡化：
- 必须主动告知用户密钥是加密存储的（建立信任）
- 必须主动告知用户 `aiSettings.json` 不含密钥（消除顾虑、避免误操作）
- 不要提示用户"可以把密钥存在配置文件里"——本编辑器的设计严格禁止

### 6.4 扩展页写作要求

`extensions.md` 写扩展能力时：
- 用一句话描述，面向非技术用户（"帮助你…"而非"provides DocumentSymbolProvider"）
- TypeScript 扩展能力（定义跳转、引用查找等）应说明"打开 `.ts` 或 `.js` 文件后自动生效"
- 避免出现"language server"、"LSP"等开发者术语

---

## 7. 执行步骤

1. **确认前置**：检查 00 册的文档目录骨架（`docs/user/zh-CN/customization/`）和加载机制已就绪
2. **核实待确认项**：在应用内打开命令面板，确认 `ai.openSettingsJson` 等命令的中文显示名称，填入文档
3. **按顺序撰写**：建议顺序 `settings.md` → `keybindings.md` → `themes-and-language.md` → `extensions.md` → `ai-providers.md`（由浅入深，后两篇相对独立）
4. **补充截图占位**：每页按"截图占位"清单留 `<!-- 截图：... -->` 注释，在册末汇总"待补图清单"
5. **补充 TOC**：每篇 H2 超过 3 个时在 H1 下添加目录，锚点用标题原文
6. **添加"下一步/相关阅读"**：每篇末尾必须有学习路径收尾区块
7. **检查链接**：验证全部跨册相对链接的目标路径存在（在 07 册骨架建好前可暂用占位）
8. **运行 `pnpm check`**（截取错误），涉及 UI 交互的改动再跑 `pnpm e2e`

---

## 8. 验收标准

- [ ] 5 个页面文件均已创建于 `docs/user/zh-CN/customization/` 目录，文件名与信息架构表一致
- [ ] 每篇有唯一 H1（用于 tab 名）、TOC（适用时）、"下一步/相关阅读"收尾区块
- [ ] 所有命令名称与快捷键均与代码核实一致（参照 `preferencesActions.ts`、`configLocationActions.ts`、`aiActions.ts`）
- [ ] 界面中文用词（设置分类名、标签页名、按钮名等）与 `zh-CN.ts` i18n 保持一致
- [ ] `ai-providers.md` 中安全红线部分完整呈现三点：密钥加密存储、不入明文配置、不经 renderer 明文传输
- [ ] `extensions.md` 六个扩展均有介绍，描述面向非技术用户，无开发者术语
- [ ] 待确认项（`ai.openSettingsJson` 中文命令名）已通过应用内验证填入实际值
- [ ] 跨册链接目标路径格式正确（相对路径，`.md` 后缀）
- [ ] `keybindings.md` 末尾明确链接到 07 册快捷键速查表
- [ ] 每页截图占位注释齐全，册末有"待补图清单"汇总
- [ ] 应用内经 `DocEditorInput` 能正常打开所有 5 个页面并正确渲染（M0 打通后验证）
- [ ] 语言、术语、语气符合 [00-foundation.md §6 写作规范](./00-foundation.md#6-写作规范)（"你"称读者、祈使句步骤、无技术前设）
