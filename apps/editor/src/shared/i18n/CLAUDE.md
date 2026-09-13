# apps/editor/src/shared/i18n/CLAUDE.md

`localize()` 的消息表与 locale 解析。**展示给用户的文本一律走 `localize()`**（`@universe-editor/platform`），默认值是代码里的英文串——它不是"兜底"，而是**最低优先级**。

## 解析序（改文案前必读）

`localize(key, default)` → `messages[key] ?? fallbackMessages[key] ?? default`（`platform/src/nls/nls.ts`）。`bootstrap.ts` 把当前 locale 表作 `messages`、`DEFAULT_LOCALE='en-US'` 的表作 `fallbackMessages`：

**`<当前 locale 表>` → `en-US.ts` → 代码默认值**

后果：**只改代码里的默认值，界面上多半毫无变化**——key 只要落在任一张表里就被表值覆盖。改文案/key 时 `zh-CN.ts` 与 `en-US.ts` 一起看，增删/改名两边一起动。

## 文件

| 文件 | 作用 |
|---|---|
| `availableLocales.ts` | `DEFAULT_LOCALE` / `SUPPORTED_LOCALES` / `workbench.language` 解析；`getLocaleMessages()` 汇总 zh-CN 表（`EDITOR_OPTIONS_ZH_CN_MESSAGES` 打底，`ZH_CN_MESSAGES` 覆盖） |
| `bootstrap.ts` | `configureEditorNls(locale)`（两端共用，含 fallback 接线）+ main/renderer 各自的启动入口 `initializeMainNls` / `initializeRendererNls` |
| `messages/en-US.ts` | en-US 覆盖表（`MessageMap`）。**只放需要覆盖默认值的条目**，多数 key 不在表里 |
| `messages/zh-CN.ts` | zh-CN 主表，按 key 大致字母序排列 |
| `messages/editorOptions.zh-CN.generated.ts` | **生成物，勿手改**：Monaco editor option 描述的中文翻译，源是 `scripts/gen-editor-schema.mjs` 抽出的 `editorOptions.nls.generated.json` |

locale 取值：`workbench.language` 设 `auto` 时按系统 locale（`zh*`→`zh-CN`、`en*`→`en-US`），认不出就 `en-US`。

## 测试

- `__tests__/zhCnCoverage.test.ts` —— 扫 `SCAN_ROOTS`（apps/editor、packages 的 node-services/platform/workbench-ui）下**每个字面量** `localize` key：① 新增会 localize 的包必须补进 `SCAN_ROOTS`；② 每个 key 有 zh-CN 条目；③ 译文不引入调用点没提供的 `{placeholder}`；④ `color.<id>` 与 agent 书签等动态族逐条覆盖。**改 key 名只动一边立刻红**。
- `__tests__/bugRecordingMessages.test.ts` —— bug 录制文案的 zh-CN 断言。
- **扩展不在范围内**：`extensions/*` 走自己的 `package.nls.<locale>.json` / `src/nls.ts`，不进这张表。

## 加 / 改一条文案

1. 代码里 `localize('<key>', '<english default>')`。
2. 需要中文就加进 `zh-CN.ts`；默认英文串要覆盖就加进 `en-US.ts`。
3. 菜单/命令标题用 `localize2`（命令面板要能同时匹配英文标题，见 `nls.ts`）。
