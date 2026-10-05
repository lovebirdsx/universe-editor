# 嵌入 Monaco：布局、焦点与输入管线

宿主编辑器（`apps/editor/src/renderer/workbench/editor/FileEditor.tsx:167` 的 `automaticLayout: true`）会经 `{...parentEditor.getRawOptions()}` 渗进所有**嵌入编辑器**（peek / hover / diff）。本文记录这类嵌入布局的陷阱、Peek References 预览 blank 的完整复盘，以及 0.55 升级（`editContext` / NLS）与嵌入实例的焦点桥接、键位作用域、输入事件边界。

## 症状（稳定区分）

Peek References 弹窗**左侧预览 blank**（点 CodeLens "N references" 路径复现；"Peek References" 命令路径不复现）：首个引用在**别的文件**（需异步 `readFileText`，预览挂载晚）的符号必坏，在当前文件的好。探针证据：slot（`.split-view-view`）恒 552px，而 `.preview` 容器塌到 5px；强制容器宽 552 立刻恢复。

## 根因：双向反馈死锁

- monaco 把预览放进 `<div class="preview inline">`，`referencesWidget.css` 里是 `display: inline-block`（收缩到内容）。SplitView 左格 layout 回调只调 `_preview.layout({width})`，**从不设 `.preview` 容器自身 style**（右格 tree 显式设了 style.width/height，故 tree 永远正常）。于是容器宽高全靠内部 monaco 撑开。
- 预览编辑器带 ResizeObserver **观察 `.preview` 容器**（`automaticLayout` 经 `getRawOptions` 渗进来的）→ 容器小 → observer 测小 → 压小 monaco → 容器更小，锁死 5×5。首个引用在别文件时需异步读盘（FileTextModelService），预览挂载晚，稳定输掉与 observer 的竞争。VSCode 不复现：它的 host `automaticLayout:false`（grid 布局），嵌入预览无 observer。

## 失败方向（勿重蹈）

`onDidCreateEditor` 里 `updateOptions({ automaticLayout: false })` **无效**——monaco 的 `editorConfiguration.js` 只在构造函数读一次 `automaticLayout` 并 `startObserving`，`updateOptions` 从不 `stopObserving`，且该事件在构造后才 fire。

## 正解（CSS 一刀断环）

`apps/editor/src/renderer/workbench.css:255-264`：

```css
.monaco-editor .reference-zone-widget .split-view-view > .preview.inline {
  width: 100% !important;
  height: 100% !important;
}
```

让容器填满恒定可靠的 slot，切断「容器尺寸依赖内容」这条反馈边；observer 保留但恒测 552 × 满高。护栏：`apps/editor/e2e/specs/smoke.peekPreview.spec.ts`（首个引用跨文件，断言 preview 宽高**双维都不塌**）。

## 通用教训

host 编辑器加 `automaticLayout` 会经 `getRawOptions` 渗到所有嵌入编辑器（peek / hover / diff），与 `inline-block` 容器互相观察成环。给 host 加 `automaticLayout` 前，先确认每条嵌入路径的容器都有确定尺寸（或显式给容器定尺寸），否则会出现「容器尺寸依赖内容」的环。

## `editContext` 与输入事件边界（0.55 起默认 true）

- 升级由来：0.52 的输入走旧 textarea-overlay 双层渲染（textarea + view-line），中文 IME 组合文字被两层同时画 → 当前行加粗/变色。EditContext API（monaco ≥0.53、VSCode 同源）走 OS 层组合，无第二层叠加。三处 create 显式写 `editContext: true`（`apps/editor/src/renderer/workbench/editor/FileEditor.tsx:168` / `DiffEditor.tsx:109` / `panel/output/LogOutputView.tsx:122`，嵌入的 `agents/PromptMonacoEditor.tsx:329` 同）；`MergeEditor` 未显式写，但 0.55 默认 true 同样命中。版本落在 `pnpm-workspace.yaml` catalog `^0.55.0`（lock 0.55.1）。
- 【规范】**`editContext: true` 下编辑器子树内不再向普通 `addEventListener` 派发 paste 等输入事件**：Chromium 的 EditContext 接管输入管线，`native-edit-context` 及其 Monaco 祖先都不派发。键盘/剪贴板/输入类监听必须挂在 **Monaco DOM 之外的宿主元素**、且用 **capture 阶段**；挂 `ed.getContainerDomNode()` 在真实环境永不触发（回退逻辑本身正确，只是挂错元素）。落点范例见 `apps/editor/src/renderer/services/acp/cases-prompt-images.md`（paste 从 containerDomNode 挪到 PromptInput 的 drop-host div）。
- 单测在 stub textarea 上合成 `fireEvent.paste` 覆盖不到这个差异（假绿）——此类行为**必须 e2e 真事件验证**。

## 嵌入实例的焦点桥接：用专用 context key，绝不冒充 `editorTextFocus`

- `editorTextFocus` 的全局语义 = 「**活动文件编辑器**可被操作」（消费方都经 `getActiveTextEditor` 取文件编辑器）。嵌入 Monaco 冒充它 → `when` 门控命中的命令拿不到目标 → 静默吞键；且 VSCode keybindings.json 导入层以 `KeybindingWeight.User`(1000) 注册，压过任何 scoped weight（如 `ACP_SCOPED_KEY_WEIGHT=250`），用户导入的 `alt+up → findWordAtCursor` 会吞掉 timeline 导航键——User 层按设计最高，不能用 weight 对抗。
- 正解：嵌入表面用**专用 key**（ACP prompt = `acpPromptInputFocused`：`ContextKeyContribution` seed + `workbench/agents/PromptMonacoEditor.tsx` 的 `onDidFocusEditorText`/blur 桥接）。`useGlobalKeybindingHandler` 的 inTextSurface 守卫并入该 key——`editContext` 下焦点宿主不是 DOM-editable（`isEditableTarget` 判不到），并入后同时兜住 Delete/Backspace/裸字符键的保留。
- 同类症状的排查套路（「键在输入框里失效、别处正常」先查导入层）见 skill `fix-keybinding-not-firing`。

## standalone Monaco 的 `addCommand` 无编辑器作用域（跨编辑器吞键）

- 【规范】`editor.addCommand(...)` 注册在**共享的 StandaloneKeybindingService** 上、**没有编辑器作用域**——在任意 Monaco 编辑器里按该键都会触发。ACP 输入框曾用它绑 Enter 提交：打开/恢复一个 session editor 后，所有编辑器的 Enter 都被吞。`.md` 免疫是假象（`markdown.editing.onEnter` weight 300 在全局分发器先认领 Enter），`.ts` 依赖 Monaco 默认 Enter 才被劫持。
- 正解：编辑器局部键一律走**作用域化的 DOM capture keydown**（`dom = ed.getContainerDomNode()` + `addEventListener('keydown', h, true)`，与既有 ArrowUp/Tab 处理同址）；处理函数返回 false 时**不 `preventDefault`**，让原生 Enter 插入换行（fall-through，不 trigger）。
- 守护：`apps/editor/e2e/specs/smoke.agentsPromptEnterLeak.spec.ts`（@p1/@regression——开 .ts 按 Enter → 开 session editor → 切回 .ts 断言 Enter 仍插换行；已验证旧代码下该 spec 正确失败）。
- 姊妹线：skill `register-monaco-command` 是反向流程（把 Monaco 命令**接进**命令面板）；「只该在本编辑器生效」的键位不要用它。

## 0.55 升级踩坑（命名空间顶层化 / NLS 索引制）

**命名空间顶层化**：0.55 把 `monaco.languages.{json,typescript,css,html}` 移到顶层 `monaco.{json,typescript,css,html}`。除 `MonacoLoader.ts` 外，两个 mock 桩必须同步——`apps/editor/test-stubs/monaco-editor.ts` 与 `overrideServicesInit.test.ts` 的 `vi.mock`；桩不跟着提，全 renderer 测试在 setup 阶段就崩（`_monaco.json` undefined）。

**NLS：string-key → 索引制，改用英文桥接**：

- 0.55 ESM 是 prebuilt：`localize('key', "EN")` 全变成 `localize(786, "EN")`，经 `lookupMessage` 查 `globalThis._VSCODE_NLS_MESSAGES[index]`。旧机制（patch nls.js 让 string-key 查 `__MONACO_NLS__[key]` + `zh-cn.json` 是 key→中文）**整套失效**，monaco 内置 UI（查找框/右键/peek）回退英文。
- 方案（零新依赖）：`__MONACO_NLS__` 改**英文→中文**表；patch `lookupMessage`（正则锚 `function lookupMessage(index, fallback)`，native 索引优先、英文表兜底），实现 `apps/editor/src/renderer/workbench/editor/monaco/monacoNlsPatch.ts`。
- 数据流：monaco 索引→英文（inline fallback）⋈ vscode 源码 key→英文 ⋈ 现有 `zh-cn.json` key→中文 ⇒ 英文→中文。build 脚本 `apps/editor/scripts/build-monaco-nls.mjs` 扫 vscode 源码树（`VSCODE_SRC_ROOT`，需源码树而非构建产物）生成 `apps/editor/src/renderer/vendor/monaco-nls/zh-cn.messages.json`（英文→中文、入库，bootstrap 读它）；源字典 `zh-cn.json`（key→中文）仅供 build 桥接。命中率 ~80.5%（1150/1428），未命中多为版本文案微调或本不该译的修饰键名。
- 本地化遗漏的通用排查（裸文本/中文 defaultMessage/zh-CN 缺 key）见 skill `fix-nls-gaps`；本条是它没覆盖的**机制侧**。

**测试桩注（疑似已不可再现，未复核）**：升级当时 `DiffEditor` 测试 stderr 有 `getModifiedEditor().getPosition is not a function`——桩缺方法的被吞清理错误，不致 fail。DiffEditor 各测试已自带 mock 且 `test-stubs/monaco-editor.ts` 已补 `getPosition`，本轮未复核是否仍可复现；遇到时按「桩缺方法」处理即可。

## 相关

- `apps/editor/src/renderer/services/acp/cases-prompt-images.md` —— 图片输入三入口、paste 监听的宿主+capture 落点。
- `apps/editor/src/renderer/services/acp/cases-prompt-input-monaco.md` —— prompt 输入框的 Monaco 集成与局部键位分发。
- `apps/editor/e2e/specs/smoke.peekPreview.spec.ts`（布局护栏）、`smoke.agentsPromptEnterLeak.spec.ts`（addCommand 全局泄漏护栏）。
