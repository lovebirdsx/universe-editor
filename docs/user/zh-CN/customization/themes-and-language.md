# 主题与语言

这一页教你两件最简单的定制：换一套配色主题，以及切换编辑器的界面语言。两件事都只要几步。

## 目录

- [切换颜色主题](#切换颜色主题)
- [跟随系统外观](#跟随系统外观)
- [切换文件图标主题](#切换文件图标主题)
- [切换产品图标主题](#切换产品图标主题)
- [切换界面语言](#切换界面语言)
- [下一步](#下一步)
- [相关阅读](#相关阅读)
- [本页涉及的命令](#本页涉及的命令)

## 切换颜色主题

编辑器目前提供深色和浅色两套配色，随光线和喜好切换：

1. 按 `Ctrl+K Ctrl+T`（或按 `Ctrl+Shift+P` 打开[命令面板](../reference/glossary.md#命令面板)，输入「颜色主题」）。
2. 在弹出的「选择颜色主题」列表里，用上下键预览、回车确认；按 `Esc` 取消并回到原来的主题。
3. 当前正在使用的主题旁会标「（当前）」。

可选项是「Universe Dark」和「Universe Light」。**主题立即生效，无需重启。** 你选的结果会保存在用户设置里（对应键名 `workbench.colorTheme`），下次打开自动沿用。

主题由内置的「Universe Themes」扩展提供，与 VSCode 的主题格式兼容——第三方 VSCode 主题扩展装上后也会出现在这个列表里。

<!-- 截图：颜色主题快速选择列表，深色选中状态 -->

> 提示：想微调个别颜色（比如侧边栏背景），可以在设置里用 `workbench.colorCustomizations` 覆盖，改动即时生效；把某个颜色设为 `"default"` 可以恢复该颜色的默认值。

## 跟随系统外观

想让编辑器跟着操作系统的深色 / 浅色模式自动换主题，在设置（JSON）里打开 `window.autoDetectColorScheme`：

```json
{
  "window.autoDetectColorScheme": true,
  "workbench.preferredDarkColorTheme": "Universe Dark",
  "workbench.preferredLightColorTheme": "Universe Light"
}
```

开启后：

- 系统处于**深色**模式时，使用 `workbench.preferredDarkColorTheme` 指定的主题；**浅色**模式时用 `workbench.preferredLightColorTheme`。
- 系统外观切换时**立即自动切换**，无需重启。
- 此时用「颜色主题」命令（`Ctrl+K Ctrl+T`）选的主题，会写进**当前系统外观对应**的那个 preferred 设置（而不是 `workbench.colorTheme`）——也就是说你可以分别为深色、浅色各挑一套。

> 提示：两个 preferred 设置若填了与当前系统外观不符的主题（比如在深色 preferred 里填了一套浅色主题），编辑器会忽略它并回退到对应的内置默认主题，避免外观错乱。

## 切换文件图标主题

文件图标主题决定资源管理器、编辑器标签页等位置显示的文件/文件夹图标样式：

1. 按 `Ctrl+Shift+P` 打开命令面板，输入「文件图标主题」。
2. 在列表里用上下键预览、回车确认；按 `Esc` 取消并回到原来的主题。
3. 选择 **None** 则不使用图标主题，回退到编辑器内置的彩色 Material 图标。

默认使用内置的「universe-material」主题（Material 风格彩色图标）。与 VSCode 的文件图标主题格式兼容——第三方 VSCode 文件图标主题扩展装上后也会出现在这个列表里。选择结果保存在用户设置里（对应键名 `workbench.iconTheme`，设为 `null` 等同选择 None）。

## 切换产品图标主题

产品图标主题决定界面本身的图标（活动栏、工具栏、状态栏等的轮廓图标）：

1. 按 `Ctrl+Shift+P` 打开命令面板，输入「产品图标主题」。
2. 在列表里用上下键预览、回车确认；按 `Esc` 取消。

默认是 **Default**（内置 codicon 图标）。与 VSCode 的产品图标主题格式兼容，第三方主题扩展装上后会出现在列表里。选择结果保存在用户设置里（对应键名 `workbench.productIconTheme`）。

## 切换界面语言

编辑器界面支持简体中文和英文，也可以跟随系统语言：

1. 按 `Ctrl+Shift+P` 打开命令面板，输入「配置显示语言」。
2. 在列表里选择一项：
   - **跟随系统语言**：跟随你操作系统的语言设置。
   - **English**：英文界面。
   - **简体中文**：中文界面。
3. 选择后会弹出确认对话框，提示「显示语言已更新，重启应用后生效」。

**和主题不同，切换界面语言需要重启应用才会看到效果。** 你选的结果保存在用户设置里（对应键名 `workbench.language`）。

<!-- 截图：配置显示语言快速选择列表 -->

> 提示：切换语言后，如果发现界面里个别文字还没翻译，属于翻译尚未完全覆盖的正常情况，不影响功能使用。

## 下一步

- [内置扩展](./extensions.md)：了解编辑器自带了哪些能力。

## 相关阅读

- [设置](./settings.md)
- [键盘快捷方式](./keybindings.md)

## 本页涉及的命令

| 命令名（中文） | 命令 ID | 快捷键 |
| --- | --- | --- |
| 颜色主题 | `workbench.action.selectTheme` | `Ctrl+K Ctrl+T` |
| 文件图标主题 | `workbench.action.selectIconTheme` | 无 |
| 产品图标主题 | `workbench.action.selectProductIconTheme` | 无 |
| 配置显示语言 | `workbench.action.configureDisplayLanguage` | 无 |
