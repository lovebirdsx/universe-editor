---
name: new-extension
description: 为 Universe Editor 从零创建扩展(插件)。当用户想新建/开发编辑器插件,或想给编辑器加命令、webview 面板、自定义编辑器、语言支持等能力时使用。覆盖需求确认→脚手架→实现→e2e 测试→发布全流程。若用户要移植现有 VSCode 插件,改用 port-vscode-extension。
---

# 创建 Universe Editor 扩展

你负责帮用户从零创建一个 Universe Editor 扩展(插件),从需求确认一直到 e2e 测试通过、用户验收,必要时协助发布到扩展市场。整个过程在**用户自己的目录**里进行,产出一个独立的扩展项目。

## 全局规则(红线)

1. **三道确认门**(需求 → 计划 → 验收)未获用户明确同意,不得越过进入下一阶段。
2. **`uex publish` 永远不自动执行**——发布是对外动作,必须用户单独明确同意。
3. **不硬造 API**:Universe Editor 的扩展 API(`@universe-editor/extension-api`)只有文档声明的能力面。遇到做不到的需求,如实告知并给替代方案,绝不编造 API 或 hack 宿主。
4. 任何 token/密钥不写进代码、不写进 settings.json,不回显到对话。
5. 交流语言跟随用户;代码、命令、标识符保持原样。

## 权威资料在哪

完整的扩展开发文档随编辑器安装分发,**优先读文档而不是凭记忆写代码**:

- 本 SKILL.md 位于编辑器安装目录的 `resources/agent-skills/` 下;开发文档在同级的 `resources/docs/extension-dev/zh-CN/`(Windows 默认安装目录 `%LOCALAPPDATA%\Programs\Universe Editor`)。
- 若当前在 universe-editor 仓库的开发模式下,文档位于仓库根 `docs/extension-dev/zh-CN/`。
- 文档地图:`getting-started.md`(上手)、`extension-anatomy.md`(结构)、`contribution-points.md`(贡献点参考)、`api/`(API 面)、`webview-guide.md`、`language-guide.md`、`debugging.md`、`versioning.md`(engines.universe 语义)、`publishing.md`(发布)、`security-and-trust.md`。

## 第 0 步:环境检测

先跑 `node -v`(需 ≥ 22)和 `npm -v`。缺失或版本过低时,给出安装指引(https://nodejs.org) 并停下等用户处理,不要带病继续。

## 第 1 步:需求确认(门 1)

**一次性问齐**以下问题再动手(若环境支持结构化提问工具就用它,否则在一条消息里列出全部问题):

1. 这个扩展要做什么?(一句话)
2. 有没有想参考/移植的 VSCode 插件?——**有则改走 `port-vscode-extension` 流程**(读本目录旁的 `../port-vscode-extension/SKILL.md`,先做可行性评估再动工)。
3. 只是自己用,还是要发布到扩展市场?(决定 publisher 取名:发布需要已注册并通过审批的 publisher id;自用可临时用 `local`)

## 第 2 步:计划确认(门 2)

根据需求推断扩展形态(纯声明型 / 命令型 / webview 面板 / 自定义编辑器 / 语言支持),需要时先读对应文档,然后给用户一页纸计划:

- 扩展 id(小写 npm 命名规则)、displayName、publisher
- 模板选型:`basic`(命令型起点)或 `webview`
- 贡献点清单(commands / keybindings / configuration / menus / customEditors / …)
- 实现要点与已知限制(API 不支持的点此时讲清)
- e2e 测试场景清单——**每条已确认的需求至少对应一条 e2e 用例**

等用户确认后再进入搭建。

## 第 3 步:脚手架

用全旗标非交互形式(交互式提问在 agent 环境会挂起):

```bash
npm create @universe-editor/extension@latest <目录名> -- \
  --name <扩展id> --publisher <publisher> \
  --display-name "<显示名>" --description "<一句话>" --template <basic|webview>
cd <目录名> && npm install && npm run build
```

构建通过说明骨架完好。骨架自带 `esbuild.config.mjs`、`tsconfig.json`、`src/extension.ts`,scripts 有 `build` / `watch` / `package`(= `uex package`)。

## 第 4 步:实现

先读安装目录里与形态对应的文档,再写代码。**红线自查清单**(违反任意一条,扩展会静默不加载或打包丢文件):

- `engines.universe` 必须是合法普通区间(脚手架已写好,如 `">=0.12.0 <1.0.0"`),不要改成 `||` 或连字符区间——不合法会被扫描器**静默跳过**。
- `package.json` 的 `files` 是**白名单**:dist、图标、NLS 文件(`package.nls*.json`)等运行需要的文件都必须列入,漏列 = 打包丢失。
- import 一律 `@universe-editor/extension-api`,**没有** `vscode` 模块。
- 全 ESM(`"type": "module"`),产物由 esbuild 打包。

实现过程中可随时 `npm run build` + `npx uex dev` 拉起「扩展开发宿主」窗口自测(它会自动定位本机安装的编辑器;失败时按提示设 `UNIVERSE_EDITOR_PATH`)。

## 第 5 步:e2e 测试

e2e 使用官方 harness 冷启动真实编辑器、junction 装载本扩展、经 `window.__E2E__` 探针断言,**不需要下载浏览器**。搭建:

1. 加 devDependencies(版本须满足 harness 的 peerDependency):

```bash
npm i -D @universe-editor/e2e-harness @universe-editor/e2e-contract @playwright/test
```

2. `e2e/playwright.config.ts`:

```ts
import { defineE2EConfig } from '@universe-editor/e2e-harness'

const config = defineE2EConfig({ testDir: './specs' })
export default { ...config, testMatch: '**/*.spec.ts' }
```

3. `e2e/app.mjs`(fixture,把本扩展目录 junction 进隔离的用户扩展目录):

```js
import { createColdAppTest, resolveEditorLaunchTarget, expect } from '@universe-editor/e2e-harness'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userExtensionsDir = mkdtempSync(join(tmpdir(), 'ext-e2e-'))
symlinkSync(extensionDir, join(userExtensionsDir, 'ext-under-test'), 'junction')

export const test = createColdAppTest({
  ...resolveEditorLaunchTarget(),
  extensions: [],
  env: { UNIVERSE_USER_EXTENSIONS_DIR: userExtensionsDir },
})
export { expect }
```

4. `e2e/specs/<场景>.spec.ts`(探针 API 如 `hasCommand` / `runCommand` / `getOutputChannelContent` / `getContextKey` / `openFileUri` 来自 `@universe-editor/e2e-contract`):

```ts
import { test, expect } from '../app.mjs'

test.describe('my extension', () => {
  test('registers and runs its command', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('<扩展id>.<命令>')), {
        timeout: 15000,
      })
      .toBe(true)
    // 首次执行命令会触发激活(onCommand:),留出冷启动窗口轮询断言效果
  })
})
```

5. 跑:`npm run build && npx playwright test -c e2e/playwright.config.ts`。编辑器可执行文件默认自动探测本机安装(Windows);否则设 `UNIVERSE_EDITOR_BIN` 指向编辑器 exe。e2e 使用独立的 userData,不会与用户正开着的编辑器互相干扰。

全部用例通过后才进入验收。

## 第 6 步:人肉验收(门 3)

`npx uex dev` 拉起扩展开发宿主,请用户亲手把核心流程走一遍;按反馈修复迭代,直至用户确认满意。

## 第 7 步:发布(可选,单独确认)

仅当用户在门 1 表达过发布意图且此刻明确同意:

1. 前提:publisher 已在扩展市场注册并通过管理员审批(未注册则指引用户走市场注册页)。
2. `npx uex login`(用户自己粘贴 token,你不要经手 token 内容)。
3. `npm run package` 产出 `.vsix`,列出 `uex ls` 内容请用户过目。
4. 用户明确说"发布"后才执行 `npx uex publish`。

## 常见坑速查

- 扩展装了却不出现:九成是 `engines.universe` 不合法被扫描器静默跳过,其次是 `main` 指向的 `dist/extension.js` 没构建。
- 打包后功能缺失/文案不本地化:`files` 白名单漏了资源或 `package.nls*.json`。
- 任何交互式 CLI(会等 stdin 的)在 agent 环境都会挂:一律用全旗标非交互形式。
- e2e 里断言 UI 优先走探针与 `expect.poll`,不要断言编辑器内部 DOM 结构。
