# services/themes/CLAUDE.md

VSCode 范式的颜色/图标主题子系统：`contributes.themes`/`iconThemes`/`productIconThemes` 扩展点 → 主题注册表 → `WorkbenchThemeService` → CSS 变量注入 + Monaco/TextMate 桥接。处理颜色主题、图标主题、token 着色、`workbench.colorCustomizations` 相关任务前通读。

## 数据流（一套主题从扩展到屏幕）

```
扩展 package.json contributes.themes
  │
  │ host DTO（path 转绝对）→ ExtensionPointTranslator
  ▼
colorThemeRegistry (themeRegistry.ts)  注册 ThemeData
  │
  ▼ setColorTheme(settingsId)（Promise 链 + 单调 token 防陈旧）
ColorThemeData (colorThemeData.ts)
  │  ensureLoaded：include 递归 + JSONC 容错 + 环检测（loadThemeDocument/mergeThemeDocuments）
  │  三级解析（colorResolver.ts）：customColorMap → 主题 colorMap → registry defaults
  ▼
WorkbenchThemeService (workbenchThemeService.ts)  权威应用
  ├─→ generateColorThemeCss.ts        生成 `--vscode-<id>` CSS，注入 <style.contributedColorTheme>
  ├─→ monacoThemeBridge.ts            ColorThemeData → IStandaloneThemeData，defineTheme/setTheme
  │     （encodedTokensColors=tokenColorMap → monaco TokenTheme colorMap 与 TextMate 表索引对齐，
  │      `.mtkN` CSS + TokenizationRegistry.setColorMap 唯一事实源 = monaco StandaloneThemeService）
  ├─→ textMateThemeBridge (textmate/) tokenColors → IRawTheme（色值归一 6 位大写 hex）喂 grammar registry
  ├─→ dataset.theme + localStorage 快照（防启动闪烁，themeBootstrap 同步恢复）
  ▼
事件扇出（终端 / Mermaid / webview）→ themeFileWatcher.ts 热更新
```

## 模块速查

| 文件 | 职责 |
|---|---|
| `workbenchThemeService.ts` | `IThemeService` 实现。`restoreSnapshot`（BlockRestore 同步注入快照）/ `initialize` / `setColorTheme` / `setFileIconTheme` / `setProductIconTheme` / `getColor`；Promise 链 Sequencer + 单调 token；系统暗色联动触发链 |
| `colorThemeData.ts` | 主题纯数据（id/label/settingsId/location/colorMap/tokenColors/semanticTokenColors）；`fromExtensionTheme`；`ensureLoaded`；快照序列化；`getSemanticTokenStyle`（VSCode 打分模型） |
| `themeRegistry.ts` | `ExtensionThemeRegistry<T>` 泛型 × 3（color/fileIcon/productIcon）：register/find/byId/bySettingsId/onDidChange |
| `themeConfiguration.ts` | 配置键封装；legacy 迁移 `'dark'→'Universe Dark'`；`colorCustomizations` 全局+per-theme 合并；系统跟随（`getColorThemeSettingId`/`getPreferredColorScheme`/preferred sanitize） |
| `colorResolver.ts` | 三级颜色解析纯函数 + ColorTransform（darken/lighten/transparent/oneOf/lessProminent/ifDefinedThenElse）+ `'default'` 还原 |
| `generateColorThemeCss.ts` | colorMap → `--vscode-*` CSS 文本（`:root` scope） |
| `universeColorIds.ts` | ~150 个 `registerColor` 单一事实源。有 VSCode 对应物一律用其 id；defaults 的 dark/light 槽 = 内置主题数据源 |
| `monacoThemeAdapter.ts` | ColorThemeData → monaco `IStandaloneThemeData`（tokenColors→rules、colors 覆盖） |
| `monacoThemeBridge.ts` | 全局 Monaco 主题唯一事实源；MonacoLoader ready 后 defineTheme/setTheme |
| `monacoSemanticThemeBridge.ts` | 注入 `UniverseSemanticColorTheme extends StandaloneTheme` 到 `_knownThemes`，`getTokenStyleMetadata` 委托 ColorThemeData 打分；`semanticHighlighting` 三态解析 |
| `semanticSelector.ts` | VSCode tokenClassificationRegistry 纯函数内核：选择器 `[type\|*](.modifier)*(:language)?` 解析与打分、superType 层级、scopesToProbe 回退 |
| `themeFileWatcher.ts` | watch 主题文件 + include 链，磁盘变更 → `reloadCurrentTheme` 热更新 |
| `fileIconThemeData.ts` / `generateFileIconThemeCss.ts` | 文件图标主题：Programmatic（内置 material SVG）+ JSON（VSCode fileIconTheme JSON→CSS，iconPath 转 universe-app 资源 URL） |
| `productIconThemeData.ts` / `generateProductIconThemeCss.ts` | 产品图标主题：Default(codicon) + JSON（fonts @font-face + codicon 覆盖 CSS） |

token 着色引擎在隔壁 [`../textmate/`](../textmate/)（grammarRegistry / textMateService / tokenizationSupport / themeBridge）。

## 关键设计决策

### 颜色三级解析 + `--vscode-*` 单一来源
所有可主题化颜色先 `registerColor`（universeColorIds.ts，含 VSCode id 沿用与 dark/light 默认槽），`generateColorThemeCss` 把当前主题解析结果注入为 `--vscode-<id 点转横线>` CSS 变量。workbench CSS/组件**只消费 `var(--vscode-*)`**，不写死 hex——Phase 1 已把全部 `--color-*` codemod 走。新增可主题化颜色 = 在 universeColorIds 注册 + 消费处用对应变量。

### 防启动闪烁
`themeBootstrap.ts`（独立 module，CSP 禁 inline）在 `main.tsx` 前同步注入 localStorage 快照 CSS；`restoreSnapshot`（BlockRestore）幂等恢复。`WorkbenchThemeService.initialize`（AfterRestore，等扩展翻译完成）做权威 setColorTheme。

### 系统暗色联动（VSCode `IHostColorSchemeService` 对等）
- `IHostService.onDidChangeColorScheme` / `isDarkColorScheme`（platform，main 桥 Electron `nativeTheme`，process-global 每窗口镜像）。
- `ThemeConfiguration` 注入 `IHostColorScheme` 最小契约（可变 `dark` 缓存 + `onDidChange`），detect 开时 `getColorThemeSettingId` 切到 `workbench.preferredDarkColorTheme`/`preferredLightColorTheme`。
- preferred 键 sanitize：填了异 scheme 主题 → 回退内置默认（VSCode 同款防污染）。
- `WorkbenchThemeService.initialize` 挂两条触发链：配置四键（COLOR_THEME/PREFERRED_*/DETECT）+ 系统配色事件（仅跟随开启时）→ restoreColorTheme。`setColorTheme` 写配置走当前活动键。
- 裁剪：无高对比度维度。

### token 着色优先级与单一色表
TextMate（后注册者胜，无 grammar 回退 Monarch）→ LSP semantic tokens 独立叠加。`editor.semanticHighlighting.enabled`（true/false/'configuredByTheme'，对齐 VSCode 默认 configuredByTheme）经 monacoSemanticThemeBridge 注入的 flag 生效，FileEditor 不再硬编码。

**三种 token（TextMate/Monarch/semantic）的 colorId 必须查同一张 `.mtkN` 色表**：tokenColorMap 表项归一为 6 位大写 hex（`normalizeTokenColor`，monaco ColorMap 只认 6/8 位 hex 且丢 alpha 折叠），monacoThemeBridge defineTheme 时经 `encodedTokensColors` 让 monaco TokenTheme colorMap 以它为前缀（索引 1:1），Monarch/builtin 规则色追加在 N 之后。CSS 与 `TokenizationRegistry.setColorMap` 由 monaco StandaloneThemeService 独家产出——**任何第二个 `.mtkN` 样式表都会按 DOM 顺序与之竞态**（曾致 JSON 等 TextMate 语言随加载时序错色：dev 必现、发布版随工作区摇摆）。

## 常见任务

**加一个新的可主题化颜色**：universeColorIds.ts `registerColor`（含 dark/light 默认）→ 消费处 `var(--vscode-<id>)` → 内置主题 JSON 填值。`__tests__/cssVarCoverage.test.ts` 会拦未注册的 `var(--vscode-X)`。

**换内置主题**：改 `extensions/theme-defaults/`（Universe Dark/Light 的 JSON，include 链抄 VSCode theme-defaults）。VSCode 移植主题：`theme-defaults` 另含 8 个经典主题（Dark+/Dark Modern/2026/VS/HC 等，JSON 与上游逐字节一致），9 个风格主题各自独立成 `extensions/theme-*/`（abyss/monokai/solarized 等，照抄上游结构，带 LICENSE attribution + package.nls zh-cn）。

**改语义染色**：`semanticSelector.ts`（打分）+ `colorThemeData.getSemanticTokenStyle`（装配）+ `monacoSemanticThemeBridge.ts`（注入）。测试看 `__tests__/semanticSelector.test.ts` 打分矩阵。

**主题切换不生效/闪烁**：先查 `dataset.theme` 与 `<style.contributedColorTheme>` 是否注入；启动闪烁查 themeBootstrap 快照；扩展主题不出现查 ExtensionPointTranslator 分发与 registry。

## 测试

`__tests__/`：colorThemeData / themeRegistry / themeConfiguration / colorResolver / semanticSelector / workbenchThemeService / cssVarCoverage。环境 renderer-node（纯逻辑，cssVarCoverage 用 node fs 扫全 css，扫描根含 `packages/workbench-ui/src`——该包 css 与 renderer 同一 document，同受变量契约约束）。e2e：`e2e/specs/smoke.themes.spec.ts`。

## 相关

- 扩展点分发：`services/extensions/ExtensionPointTranslator.ts`
- 内置主题扩展：`extensions/theme-defaults/`
- TextMate 引擎：`services/textmate/`
- 用户文档：`docs/user/zh-CN/customization/themes-and-language.md`
- VSCode 蓝本：`src/vs/workbench/services/themes/`
