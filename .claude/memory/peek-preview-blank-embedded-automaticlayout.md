---
name: peek-preview-blank-embedded-automaticlayout
description: "Peek References 预览面板 blank 根因=.preview.inline 容器与继承的 automaticLayout ResizeObserver 反馈死锁,CSS 让容器填满 slot 断环"
metadata: 
  node_type: memory
  type: project
  originSessionId: af35df42-2ca9-41bc-9e33-82fe1b468365
---

Peek References 弹窗左侧预览 blank（点 CodeLens "N references" 复现，稳定按符号区分：首个引用在别的文件的符号必坏，在当前文件的好；"Peek References" 命令不复现）。

**根因（三轮 DevTools 探针钉死）= 双向反馈死锁**：
- monaco 把预览放进 `<div class="preview inline">`，`referencesWidget.css` 里是 `display:inline-block`（收缩到内容）。SplitView 左格 layout 回调只调 `_preview.layout({width})`，**从不设 `.preview` 容器自身 style**（右格 tree 显式设了 style.width/height，故 tree 永远正常）。于是容器宽高全靠内部 monaco 撑开。
- 我们 host FileEditor `automaticLayout:true`，`EmbeddedCodeEditorWidget` 经 `{...parentEditor.getRawOptions()}` 继承它 → 预览编辑器带 ResizeObserver **观察 `.preview` 容器** → 容器小→observer 测小→压小 monaco→容器更小，锁死 5×5。
- 探针证据：slot(.split-view-view) 恒 552（SplitView 绝对定位显式设，可靠），但 `.preview` 容器红 5px 绿 552px；强制容器 width=552 monaco 立刻恢复。
- 稳定区分：首个引用在别文件需异步 `readFileText`（FileTextModelService），预览挂载晚，稳定输掉与 observer 的竞争。VSCode 不复现因 host `automaticLayout:false`（grid 布局），嵌入预览无 observer。

**失败的修复方向（勿重蹈）**：`onDidCreateEditor` 里 `updateOptions({automaticLayout:false})` 无效——monaco `editorConfiguration.js` 只在构造函数读一次 automaticLayout 并 startObserving，updateOptions 从不 stopObserving，且事件在构造后才 fire。

**正解（已实施，CSS 一刀断环）**：`workbench.css` 加
`.monaco-editor .reference-zone-widget .split-view-view > .preview.inline { width:100%!important; height:100%!important }`
让容器填满恒定可靠的 slot，切断"容器尺寸依赖内容"这条反馈边，observer 保留但恒测 552×满高。回归 spec `smoke.peekPreview.spec.ts`（首个引用跨文件，断言 preview 宽高双维都不塌）。

教训：host 编辑器加 automaticLayout 会经 getRawOptions 渗到所有嵌入编辑器（peek/hover/diff），与 inline-block 容器互相观察成环。
