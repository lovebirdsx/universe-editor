---
name: prompt-input-no-global-editortextfocus
description: 嵌入式 Monaco（ACP prompt 输入框）不得冒充全局 editorTextFocus；VSCode 导入键位层 User=1000 压过一切 scoped weight
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-13T11:45:42.448Z
---

ACP prompt 输入框（PromptMonacoEditor）曾把全局 `editorTextFocus` 置 true（为让全局按键守卫保留 Delete/Backspace），结果所有 `editorTextFocus` 门控的绑定在输入框里抢键却无法工作——尤其 VSCode keybindings.json 导入层以 `KeybindingWeight.User`(1000) 注册，压过任何 scoped weight（如 ACP_SCOPED_KEY_WEIGHT=250），用户导入的 `alt+up → findWordAtCursor` 吞掉了 timeline 导航键。

**Why**：`editorTextFocus` 在本应用的全局语义 = "活动文件编辑器可被操作"（消费方都经 getActiveTextEditor 取文件编辑器）；嵌入式 Monaco 冒充它会让这类命令命中 when 却拿不到目标，静默吞键。且 User 权重无法用 weight 对抗——用户层按设计必须最高。

**How to apply**：嵌入式 Monaco 表面用专用 contextKey（prompt 用 `acpPromptInputFocused`，ContextKeyContribution seed），useGlobalKeybindingHandler 的 inTextSurface 守卫并入该 key。排查同类 bug 时：若某键"输入框失效、别处正常"，先查 `%APPDATA%/Code/User/keybindings.json` 导入层是否有同键 `editorTextFocus` 门控绑定，再查注册表冲突。相关：[[keybinding-when-not-priority-weight-wins]]、[[editor-text-focus-stuck-swallows-keys]]。
