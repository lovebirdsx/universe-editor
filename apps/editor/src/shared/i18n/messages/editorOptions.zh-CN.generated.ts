/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  GENERATED FILE — DO NOT EDIT BY HAND.
 *  Simplified-Chinese translations for the generated Monaco editor option
 *  descriptions (see contributions/generated/editorOptionsSchema.generated.ts).
 *  Regenerate the english source with:
 *    node scripts/gen-editor-schema.mjs [path-to-vscode/src/vs]
 *  then re-run the translation pass. Missing keys fall back to english.
 *--------------------------------------------------------------------------------------------*/

import type { MessageMap } from '@universe-editor/platform'

export const EDITOR_OPTIONS_ZH_CN_MESSAGES: MessageMap = {
  'editorOption.editor.acceptSuggestionOnCommitCharacter':
    '控制是否应在输入提交字符时接受建议。例如在 JavaScript 中，分号（`;`）可作为提交字符，在接受建议的同时输入该字符。',
  'editorOption.editor.acceptSuggestionOnEnter':
    '控制除 `Tab` 外是否还应在按 `Enter` 时接受建议。有助于避免插入新行与接受建议之间的歧义。',
  'editorOption.editor.acceptSuggestionOnEnter.enum.1':
    '仅当按 `Enter` 会产生文本更改时才接受建议。',
  'editorOption.editor.allowVariableFonts': '控制是否允许在编辑器中使用可变字体。',
  'editorOption.editor.allowVariableLineHeights': '控制是否允许在编辑器中使用可变行高。',
  'editorOption.editor.autoClosingBrackets': '控制在用户添加左括号后，编辑器是否应自动闭合括号。',
  'editorOption.editor.autoClosingBrackets.enum.1': '使用语言配置来确定何时自动闭合括号。',
  'editorOption.editor.autoClosingBrackets.enum.2': '仅当光标位于空白字符左侧时才自动闭合括号。',
  'editorOption.editor.autoClosingComments':
    '控制在用户添加注释起始符后，编辑器是否应自动闭合注释。',
  'editorOption.editor.autoClosingComments.enum.1': '使用语言配置来确定何时自动闭合注释。',
  'editorOption.editor.autoClosingComments.enum.2': '仅当光标位于空白字符左侧时才自动闭合注释。',
  'editorOption.editor.autoClosingDelete': '控制编辑器在删除时是否应移除相邻的闭合引号或括号。',
  'editorOption.editor.autoClosingDelete.enum.1':
    '仅当相邻的闭合引号或括号是自动插入的，才将其移除。',
  'editorOption.editor.autoClosingOvertype': '控制编辑器是否应在闭合引号或括号上覆盖输入。',
  'editorOption.editor.autoClosingOvertype.enum.1':
    '仅当闭合引号或括号是自动插入的，才进行覆盖输入。',
  'editorOption.editor.autoClosingQuotes': '控制在用户添加起始引号后，编辑器是否应自动闭合引号。',
  'editorOption.editor.autoClosingQuotes.enum.1': '使用语言配置来确定何时自动闭合引号。',
  'editorOption.editor.autoClosingQuotes.enum.2': '仅当光标位于空白字符左侧时才自动闭合引号。',
  'editorOption.editor.autoIndent':
    '控制当用户输入、粘贴、移动或缩进行时，编辑器是否应自动调整缩进。',
  'editorOption.editor.autoIndent.enum.0': '编辑器不会自动插入缩进。',
  'editorOption.editor.autoIndent.enum.1': '编辑器将保持当前行的缩进。',
  'editorOption.editor.autoIndent.enum.2': '编辑器将保持当前行的缩进，并遵循语言定义的括号规则。',
  'editorOption.editor.autoIndent.enum.3':
    '编辑器将保持当前行的缩进，遵循语言定义的括号规则，并调用语言定义的特殊 onEnterRules。',
  'editorOption.editor.autoIndent.enum.4':
    '编辑器将保持当前行的缩进，遵循语言定义的括号规则，调用语言定义的特殊 onEnterRules，并遵循语言定义的 indentationRules。',
  'editorOption.editor.autoIndentOnPaste': '控制编辑器是否应自动对粘贴的内容进行缩进。',
  'editorOption.editor.autoIndentOnPasteWithinString':
    '控制当内容粘贴到字符串内部时，编辑器是否应自动对粘贴的内容进行缩进。此项在 autoIndentOnPaste 为 true 时生效。',
  'editorOption.editor.autoSurround': '控制在输入引号或括号时，编辑器是否应自动环绕选中内容。',
  'editorOption.editor.autoSurround.enum.0': '使用语言配置来确定何时自动环绕选中内容。',
  'editorOption.editor.autoSurround.enum.1': '用引号环绕，但不用括号环绕。',
  'editorOption.editor.autoSurround.enum.2': '用括号环绕，但不用引号环绕。',
  'editorOption.editor.bracketPairColorization.enabled':
    '控制是否启用括号对着色。可用于覆盖括号高亮颜色。',
  'editorOption.editor.bracketPairColorization.independentColorPoolPerBracketType':
    '控制每种括号类型是否拥有各自独立的颜色池。',
  'editorOption.editor.codeLens': '控制编辑器是否显示 CodeLens。',
  'editorOption.editor.codeLensFontFamily': '控制 CodeLens 的字体系列。',
  'editorOption.editor.codeLensFontSize':
    '控制 CodeLens 的字号（以像素为单位）。设为 0 时使用 `editor.fontSize` 的 90%。',
  'editorOption.editor.colorDecorators': '控制编辑器是否应渲染内联颜色装饰器和拾色器。',
  'editorOption.editor.colorDecoratorsActivatedOn': '控制从颜色装饰器调出拾色器的触发条件。',
  'editorOption.editor.colorDecoratorsActivatedOn.enum.0': '在点击和悬停颜色装饰器时都显示拾色器',
  'editorOption.editor.colorDecoratorsActivatedOn.enum.1': '在悬停颜色装饰器时显示拾色器',
  'editorOption.editor.colorDecoratorsActivatedOn.enum.2': '在点击颜色装饰器时显示拾色器',
  'editorOption.editor.colorDecoratorsLimit': '控制编辑器中一次最多可渲染的颜色装饰器数量。',
  'editorOption.editor.columnSelection': '启用后，使用鼠标和按键进行的选择将执行列选择。',
  'editorOption.editor.comments.ignoreEmptyLines':
    '控制在对行注释进行切换、添加或移除操作时是否应忽略空行。',
  'editorOption.editor.comments.insertSpace': '控制添加注释时是否插入空格字符。',
  'editorOption.editor.copyWithSyntaxHighlighting': '控制是否应将语法高亮一并复制到剪贴板。',
  'editorOption.editor.cursorBlinking': '控制光标动画样式。',
  'editorOption.editor.cursorHeight':
    '控制当 `editor.cursorStyle` 设为 `line` 时光标的高度。光标的最大高度取决于行高。',
  'editorOption.editor.cursorSmoothCaretAnimation': '控制是否应启用平滑插入符动画。',
  'editorOption.editor.cursorSmoothCaretAnimation.enum.0': '禁用平滑插入符动画。',
  'editorOption.editor.cursorSmoothCaretAnimation.enum.1':
    '仅当用户通过明确的手势移动光标时才启用平滑插入符动画。',
  'editorOption.editor.cursorSmoothCaretAnimation.enum.2': '始终启用平滑插入符动画。',
  'editorOption.editor.cursorStyle': '控制插入输入模式下的光标样式。',
  'editorOption.editor.cursorSurroundingLines':
    "控制光标周围可见的前导行（最少 0 行）和尾随行（最少 1 行）的最小数量。在其他一些编辑器中称为 'scrollOff' 或 'scrollOffset'。",
  'editorOption.editor.cursorSurroundingLinesStyle':
    '控制何时强制执行 `editor.cursorSurroundingLines`。',
  'editorOption.editor.cursorSurroundingLinesStyle.enum.0':
    '仅当通过键盘或 API 触发时才强制执行 `cursorSurroundingLines`。',
  'editorOption.editor.cursorSurroundingLinesStyle.enum.1':
    '始终强制执行 `cursorSurroundingLines`。',
  'editorOption.editor.cursorWidth': '控制当 `editor.cursorStyle` 设为 `line` 时光标的宽度。',
  'editorOption.editor.defaultColorDecorators':
    '控制是否应使用默认文档颜色提供程序显示内联颜色装饰。',
  'editorOption.editor.defaultColorDecorators.enum.0':
    '仅当没有扩展提供颜色装饰器时才显示默认颜色装饰器。',
  'editorOption.editor.defaultColorDecorators.enum.1': '始终显示默认颜色装饰器。',
  'editorOption.editor.defaultColorDecorators.enum.2': '从不显示默认颜色装饰器。',
  'editorOption.editor.definitionLinkOpensInPeek': '控制“转到定义”鼠标手势是否始终打开速览窗口。',
  'editorOption.editor.dragAndDrop': '控制编辑器是否允许通过拖放来移动选中内容。',
  'editorOption.editor.dropIntoEditor.enabled':
    '控制是否可以按住 `Shift` 键将文件拖放到文本编辑器中（而不是在编辑器中打开该文件）。',
  'editorOption.editor.dropIntoEditor.showDropSelector':
    '控制在将文件拖放到编辑器时是否显示小部件。该小部件可让你控制文件的拖放方式。',
  'editorOption.editor.dropIntoEditor.showDropSelector.enum.0':
    '在文件拖放到编辑器后显示拖放选择器小部件。',
  'editorOption.editor.dropIntoEditor.showDropSelector.enum.1':
    '从不显示拖放选择器小部件，而是始终使用默认的拖放提供程序。',
  'editorOption.editor.emptySelectionClipboard': '控制在无选中内容时复制是否复制当前行。',
  'editorOption.editor.fastScrollSensitivity': '按住 `Alt` 时的滚动速度倍数。',
  'editorOption.editor.find.addExtraSpaceOnTop':
    '控制查找小部件是否应在编辑器顶部添加额外的行。设为 true 时，可在查找小部件可见时滚动到第一行之上。',
  'editorOption.editor.find.autoFindInSelection': '控制自动开启“在选定内容中查找”的条件。',
  'editorOption.editor.find.autoFindInSelection.enum.0': '从不自动开启“在选定内容中查找”（默认）。',
  'editorOption.editor.find.autoFindInSelection.enum.1': '始终自动开启“在选定内容中查找”。',
  'editorOption.editor.find.autoFindInSelection.enum.2':
    '当选中多行内容时自动开启“在选定内容中查找”。',
  'editorOption.editor.find.closeOnResult':
    '控制在显式的查找导航命令定位到某个结果后，查找小部件是否关闭。',
  'editorOption.editor.find.cursorMoveOnType': '控制输入时光标是否应跳转到查找匹配项。',
  'editorOption.editor.find.findOnType': '控制查找小部件是否应在输入时即时搜索。',
  'editorOption.editor.find.globalFindClipboard':
    '控制查找小部件是否应在 macOS 上读取或修改共享的查找剪贴板。',
  'editorOption.editor.find.history': '控制查找小部件历史记录的存储方式',
  'editorOption.editor.find.history.enum.0': '不存储查找小部件的搜索历史记录。',
  'editorOption.editor.find.history.enum.1': '跨活动工作区存储搜索历史记录',
  'editorOption.editor.find.loop': '控制当找不到更多匹配项时，搜索是否自动从头（或末尾）重新开始。',
  'editorOption.editor.find.replaceHistory': '控制替换小部件历史记录的存储方式',
  'editorOption.editor.find.replaceHistory.enum.0': '不存储替换小部件的历史记录。',
  'editorOption.editor.find.replaceHistory.enum.1': '跨活动工作区存储替换历史记录',
  'editorOption.editor.find.seedSearchStringFromSelection':
    '控制查找小部件中的搜索字符串是否从编辑器选中内容填充。',
  'editorOption.editor.find.seedSearchStringFromSelection.enum.0':
    '从不从编辑器选中内容填充搜索字符串。',
  'editorOption.editor.find.seedSearchStringFromSelection.enum.1':
    '始终从编辑器选中内容填充搜索字符串，包括光标处的单词。',
  'editorOption.editor.find.seedSearchStringFromSelection.enum.2':
    '仅从编辑器选中内容填充搜索字符串。',
  'editorOption.editor.folding': '控制编辑器是否启用代码折叠。',
  'editorOption.editor.foldingHighlight': '控制编辑器是否应高亮已折叠的范围。',
  'editorOption.editor.foldingImportsByDefault': '控制编辑器是否自动折叠 import 范围。',
  'editorOption.editor.foldingMaximumRegions':
    '可折叠区域的最大数量。增大此值可能会在当前源文件包含大量可折叠区域时导致编辑器响应变慢。',
  'editorOption.editor.foldingStrategy': '控制计算折叠范围的策略。',
  'editorOption.editor.foldingStrategy.enum.0':
    '如可用则使用特定语言的折叠策略，否则使用基于缩进的策略。',
  'editorOption.editor.foldingStrategy.enum.1': '使用基于缩进的折叠策略。',
  'editorOption.editor.fontLigatures':
    "配置字体连字或字体特性。可以是布尔值以启用/禁用连字，也可以是字符串作为 CSS 'font-feature-settings' 属性的值。",
  'editorOption.editor.fontLigatures.anyOf.0':
    "启用/禁用字体连字（'calt' 和 'liga' 字体特性）。将其改为字符串可对 'font-feature-settings' CSS 属性进行精细控制。",
  'editorOption.editor.fontLigatures.anyOf.1':
    "显式的 'font-feature-settings' CSS 属性。如果只需开启/关闭连字，也可以传入一个布尔值。",
  'editorOption.editor.fontVariations':
    "配置字体变体。可以是用于启用/禁用从 font-weight 到 font-variation-settings 转换的布尔值，也可以是用作 CSS 'font-variation-settings' 属性值的字符串。",
  'editorOption.editor.fontVariations.anyOf.0':
    "启用/禁用从 font-weight 到 font-variation-settings 的转换。将其改为字符串可对 'font-variation-settings' CSS 属性进行精细控制。",
  'editorOption.editor.fontVariations.anyOf.1':
    "显式的 'font-variation-settings' CSS 属性。如果只需将 font-weight 转换为 font-variation-settings，也可以传入一个布尔值。",
  'editorOption.editor.formatOnPaste':
    '控制编辑器是否应自动格式化粘贴的内容。必须有可用的格式化程序，并且该格式化程序能够格式化文档中的一个区域。',
  'editorOption.editor.formatOnType': '控制编辑器是否应在键入后自动格式化该行。',
  'editorOption.editor.glyphMargin': '控制编辑器是否应渲染垂直的字形边距。字形边距大多用于调试。',
  'editorOption.editor.gotoLocation.alternativeDeclarationCommand':
    '当“转到声明”的结果就是当前位置时所执行的备用命令 id。',
  'editorOption.editor.gotoLocation.alternativeDefinitionCommand':
    '当“转到定义”的结果就是当前位置时所执行的备用命令 id。',
  'editorOption.editor.gotoLocation.alternativeImplementationCommand':
    '当“转到实现”的结果就是当前位置时所执行的备用命令 id。',
  'editorOption.editor.gotoLocation.alternativeReferenceCommand':
    '当“转到引用”的结果就是当前位置时所执行的备用命令 id。',
  'editorOption.editor.gotoLocation.alternativeTypeDefinitionCommand':
    '当“转到类型定义”的结果就是当前位置时所执行的备用命令 id。',
  'editorOption.editor.gotoLocation.multipleDeclarations':
    '控制存在多个目标位置时“转到声明”命令的行为。',
  'editorOption.editor.gotoLocation.multipleDeclarations.enum.0': '显示结果的 Peek 视图（默认）',
  'editorOption.editor.gotoLocation.multipleDeclarations.enum.1': '转到主要结果并显示 Peek 视图',
  'editorOption.editor.gotoLocation.multipleDeclarations.enum.2':
    '转到主要结果，并启用无需 Peek 视图即可浏览其他结果的导航',
  'editorOption.editor.gotoLocation.multipleDefinitions':
    '控制存在多个目标位置时“转到定义”命令的行为。',
  'editorOption.editor.gotoLocation.multipleDefinitions.enum.0': '显示结果的 Peek 视图（默认）',
  'editorOption.editor.gotoLocation.multipleDefinitions.enum.1': '转到主要结果并显示 Peek 视图',
  'editorOption.editor.gotoLocation.multipleDefinitions.enum.2':
    '转到主要结果，并启用无需 Peek 视图即可浏览其他结果的导航',
  'editorOption.editor.gotoLocation.multipleImplementations':
    '控制存在多个目标位置时“转到实现”命令的行为。',
  'editorOption.editor.gotoLocation.multipleImplementations.enum.0': '显示结果的 Peek 视图（默认）',
  'editorOption.editor.gotoLocation.multipleImplementations.enum.1': '转到主要结果并显示 Peek 视图',
  'editorOption.editor.gotoLocation.multipleImplementations.enum.2':
    '转到主要结果，并启用无需 Peek 视图即可浏览其他结果的导航',
  'editorOption.editor.gotoLocation.multipleReferences':
    '控制存在多个目标位置时“转到引用”命令的行为。',
  'editorOption.editor.gotoLocation.multipleReferences.enum.0': '显示结果的 Peek 视图（默认）',
  'editorOption.editor.gotoLocation.multipleReferences.enum.1': '转到主要结果并显示 Peek 视图',
  'editorOption.editor.gotoLocation.multipleReferences.enum.2':
    '转到主要结果，并启用无需 Peek 视图即可浏览其他结果的导航',
  'editorOption.editor.gotoLocation.multipleTypeDefinitions':
    '控制存在多个目标位置时“转到类型定义”命令的行为。',
  'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.0': '显示结果的 Peek 视图（默认）',
  'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.1': '转到主要结果并显示 Peek 视图',
  'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.2':
    '转到主要结果，并启用无需 Peek 视图即可浏览其他结果的导航',
  'editorOption.editor.guides.bracketPairs': '控制是否启用括号对参考线。',
  'editorOption.editor.guides.bracketPairs.enum.0': '启用括号对参考线。',
  'editorOption.editor.guides.bracketPairs.enum.1': '仅为活动括号对启用括号对参考线。',
  'editorOption.editor.guides.bracketPairs.enum.2': '禁用括号对参考线。',
  'editorOption.editor.guides.bracketPairsHorizontal': '控制是否启用水平括号对参考线。',
  'editorOption.editor.guides.bracketPairsHorizontal.enum.0':
    '在垂直括号对参考线的基础上额外启用水平参考线。',
  'editorOption.editor.guides.bracketPairsHorizontal.enum.1': '仅为活动括号对启用水平参考线。',
  'editorOption.editor.guides.bracketPairsHorizontal.enum.2': '禁用水平括号对参考线。',
  'editorOption.editor.guides.highlightActiveBracketPair': '控制编辑器是否应高亮活动括号对。',
  'editorOption.editor.guides.highlightActiveIndentation': '控制编辑器是否应高亮活动的缩进参考线。',
  'editorOption.editor.guides.highlightActiveIndentation.enum.0': '高亮活动的缩进参考线。',
  'editorOption.editor.guides.highlightActiveIndentation.enum.1':
    '即使括号参考线已高亮，也高亮活动的缩进参考线。',
  'editorOption.editor.guides.highlightActiveIndentation.enum.2': '不高亮活动的缩进参考线。',
  'editorOption.editor.guides.indentation': '控制编辑器是否应渲染缩进参考线。',
  'editorOption.editor.hideCursorInOverviewRuler': '控制是否应在概览标尺中隐藏光标。',
  'editorOption.editor.hover.above': '如果有空间，则优先在行的上方显示悬停提示。',
  'editorOption.editor.hover.delay': '控制悬停提示显示前的延迟时间（毫秒）。',
  'editorOption.editor.hover.enabled': '控制是否显示悬停提示。',
  'editorOption.editor.hover.enabled.enum.0': '启用悬停提示。',
  'editorOption.editor.hover.enabled.enum.1': '禁用悬停提示。',
  'editorOption.editor.hover.enabled.enum.2':
    '按住 `` 或 `Alt`（`editor.multiCursorModifier` 的相反修饰键）时显示悬停提示',
  'editorOption.editor.hover.hidingDelay':
    '控制悬停提示隐藏前的延迟时间（毫秒）。需要启用 `editor.hover.sticky`。',
  'editorOption.editor.hover.showLongLineWarning':
    '控制是否显示长行警告悬停提示，例如在跳过标记化或暂停渲染时。',
  'editorOption.editor.hover.sticky': '控制当鼠标移动到悬停提示上方时，悬停提示是否应保持可见。',
  'editorOption.editor.inertialScroll': '使滚动具有惯性效果——大多在 Linux 上使用触控板时有用。',
  'editorOption.editor.inlayHints.enabled': '在编辑器中启用内嵌提示。',
  'editorOption.editor.inlayHints.enabled.enum.0': '启用内嵌提示',
  'editorOption.editor.inlayHints.enabled.enum.1': '默认显示内嵌提示，按住时隐藏',
  'editorOption.editor.inlayHints.enabled.enum.2': '默认隐藏内嵌提示，按住时显示',
  'editorOption.editor.inlayHints.enabled.enum.3': '禁用内嵌提示',
  'editorOption.editor.inlayHints.fontFamily':
    '控制编辑器中内嵌提示的字体系列。设置为空时，使用编辑器字体系列。',
  'editorOption.editor.inlayHints.fontSize':
    '控制编辑器中内嵌提示的字体大小。当配置的值小于 5 或大于编辑器字体大小时，默认使用编辑器字体大小。',
  'editorOption.editor.inlayHints.maximumLength':
    '内嵌提示在单行中被编辑器截断前的最大总长度。设置为 `0` 表示永不截断',
  'editorOption.editor.inlayHints.padding': '在编辑器中启用内嵌提示周围的内边距。',
  'editorOption.editor.inlineSuggest.edits.allowCodeShifting':
    '控制显示建议时是否会移动代码以便为内联建议腾出空间。',
  'editorOption.editor.inlineSuggest.edits.renderSideBySide': '控制是否可以并排显示较大的建议。',
  'editorOption.editor.inlineSuggest.edits.renderSideBySide.enum.0':
    '如果空间足够，较大的建议将并排显示，否则将显示在下方。',
  'editorOption.editor.inlineSuggest.edits.renderSideBySide.enum.1':
    '较大的建议永不并排显示，始终显示在下方。',
  'editorOption.editor.inlineSuggest.edits.showCollapsed':
    '控制建议在跳转到它之前是否以折叠形式显示。',
  'editorOption.editor.inlineSuggest.edits.showLongDistanceHint': '控制是否显示远距离的内联建议。',
  'editorOption.editor.inlineSuggest.enabled': '控制是否在编辑器中自动显示内联建议。',
  'editorOption.editor.inlineSuggest.fontFamily': '控制内联建议的字体系列。',
  'editorOption.editor.inlineSuggest.minShowDelay':
    '控制键入后内联建议显示前的最小延迟时间（毫秒）。',
  'editorOption.editor.inlineSuggest.showToolbar': '控制何时显示内联建议工具栏。',
  'editorOption.editor.inlineSuggest.showToolbar.enum.0':
    '只要显示内联建议，就显示内联建议工具栏。',
  'editorOption.editor.inlineSuggest.showToolbar.enum.1':
    '悬停在内联建议上方时显示内联建议工具栏。',
  'editorOption.editor.inlineSuggest.showToolbar.enum.2': '永不显示内联建议工具栏。',
  'editorOption.editor.inlineSuggest.suppressInSnippetMode':
    '控制在代码片段模式下是否抑制内联建议。',
  'editorOption.editor.inlineSuggest.suppressSuggestions':
    '控制内联建议与建议小部件的交互方式。如果启用，则在有内联建议可用时不会自动显示建议小部件。',
  'editorOption.editor.inlineSuggest.syntaxHighlightingEnabled':
    '控制是否在编辑器中为内联建议显示语法高亮。',
  'editorOption.editor.inlineSuggest.triggerCommandOnProviderChange':
    '控制当内联建议提供程序发生变化时是否触发命令。',
  'editorOption.editor.lightbulb.enabled': '在编辑器中启用代码操作灯泡。',
  'editorOption.editor.lightbulb.enabled.enum.0': '禁用代码操作菜单。',
  'editorOption.editor.lightbulb.enabled.enum.1': '当光标位于包含代码的行上时显示代码操作菜单。',
  'editorOption.editor.lightbulb.enabled.enum.2':
    '当光标位于包含代码的行或空行上时显示代码操作菜单。',
  'editorOption.editor.lineNumbers': '控制行号的显示。',
  'editorOption.editor.lineNumbers.enum.0': '不渲染行号。',
  'editorOption.editor.lineNumbers.enum.1': '行号渲染为绝对数值。',
  'editorOption.editor.lineNumbers.enum.2': '行号渲染为相对于光标位置的行距。',
  'editorOption.editor.lineNumbers.enum.3': '每 10 行渲染一次行号。',
  'editorOption.editor.linkedEditing':
    '控制编辑器是否启用联动编辑。根据语言的不同，相关符号（如 HTML 标签）会在编辑时同步更新。',
  'editorOption.editor.links': '控制编辑器是否应检测链接并使其可点击。',
  'editorOption.editor.matchBrackets': '高亮匹配的括号。',
  'editorOption.editor.minimap.autohide': '控制是否自动隐藏小地图。',
  'editorOption.editor.minimap.autohide.enum.0': '始终显示小地图。',
  'editorOption.editor.minimap.autohide.enum.1':
    '当鼠标不在小地图上方时隐藏小地图，鼠标位于小地图上方时显示小地图。',
  'editorOption.editor.minimap.autohide.enum.2': '仅在编辑器滚动时显示小地图。',
  'editorOption.editor.minimap.markSectionHeaderRegex':
    '定义用于在注释中查找节标题的正则表达式。该正则必须包含一个名为 `label` 的命名匹配组（写作 `(?<label>.+)`）来捕获节标题，否则将不生效。你还可以选择性地包含另一个名为 `separator` 的匹配组。在模式中使用 \\n 可匹配多行标题。',
  'editorOption.editor.minimap.maxColumn': '限制小地图的宽度，最多渲染指定数量的列。',
  'editorOption.editor.minimap.renderCharacters': '渲染行上的实际字符，而非色块。',
  'editorOption.editor.minimap.scale': '小地图中绘制内容的缩放比例：1、2 或 3。',
  'editorOption.editor.minimap.sectionHeaderFontSize': '控制小地图中节标题的字体大小。',
  'editorOption.editor.minimap.sectionHeaderLetterSpacing':
    '控制节标题字符之间的间距（以像素为单位）。这有助于在小字号下提升标题的可读性。',
  'editorOption.editor.minimap.showMarkSectionHeaders':
    '控制是否在小地图中将 MARK: 注释显示为节标题。',
  'editorOption.editor.minimap.showRegionSectionHeaders':
    '控制是否在小地图中将命名区域显示为节标题。',
  'editorOption.editor.minimap.showSlider': '控制何时显示小地图滑块。',
  'editorOption.editor.minimap.side': '控制小地图渲染在哪一侧。',
  'editorOption.editor.minimap.size': '控制小地图的大小。',
  'editorOption.editor.minimap.size.enum.0': '小地图与编辑器内容大小相同（可能会滚动）。',
  'editorOption.editor.minimap.size.enum.1':
    '小地图会根据需要拉伸或收缩以填满编辑器的高度（不滚动）。',
  'editorOption.editor.minimap.size.enum.2':
    '小地图会根据需要收缩，使其永远不超过编辑器的大小（不滚动）。',
  'editorOption.editor.mouseMiddleClickAction': '控制在编辑器中点击鼠标中键时的行为。',
  'editorOption.editor.mouseWheelScrollSensitivity':
    '用于鼠标滚轮滚动事件 `deltaX` 和 `deltaY` 的乘数因子。',
  'editorOption.editor.mouseWheelZoom': '在使用鼠标滚轮并按住 `Ctrl` 时缩放编辑器字体。',
  'editorOption.editor.multiCursorLimit': '控制活动编辑器中同时可存在的光标的最大数量。',
  'editorOption.editor.multiCursorMergeOverlapping': '当多个光标重叠时将其合并。',
  'editorOption.editor.multiCursorModifier':
    '用于通过鼠标添加多个光标的修饰键。转到定义和打开链接的鼠标手势将相应调整，以避免与[多光标修饰键](https://code.visualstudio.com/docs/editor/codebasics#_multicursor-modifier)冲突。',
  'editorOption.editor.multiCursorModifier.enum.0':
    '在 Windows 和 Linux 上映射为 `Control`，在 macOS 上映射为 `Command`。',
  'editorOption.editor.multiCursorModifier.enum.1':
    '在 Windows 和 Linux 上映射为 `Alt`，在 macOS 上映射为 `Option`。',
  'editorOption.editor.multiCursorPaste': '控制当粘贴文本的行数与光标数量匹配时的粘贴行为。',
  'editorOption.editor.multiCursorPaste.enum.0': '每个光标粘贴文本的一行。',
  'editorOption.editor.multiCursorPaste.enum.1': '每个光标粘贴完整文本。',
  'editorOption.editor.occurrencesHighlightDelay': '控制高亮显示匹配项前的延迟（以毫秒为单位）。',
  'editorOption.editor.overtypeCursorStyle': '控制改写输入模式下的光标样式。',
  'editorOption.editor.overtypeOnPaste': '控制粘贴是否应改写已有内容。',
  'editorOption.editor.overviewRulerBorder': '控制是否在概览标尺周围绘制边框。',
  'editorOption.editor.padding.bottom': '控制编辑器底部边缘与最后一行之间的间距。',
  'editorOption.editor.padding.top': '控制编辑器顶部边缘与第一行之间的间距。',
  'editorOption.editor.parameterHints.cycle': '控制参数提示菜单在到达列表末尾时是循环还是关闭。',
  'editorOption.editor.parameterHints.enabled':
    '启用一个在你输入时显示参数文档和类型信息的弹出窗口。',
  'editorOption.editor.pasteAs.enabled': '控制是否可以用不同的方式粘贴内容。',
  'editorOption.editor.pasteAs.showPasteSelector':
    '控制在向编辑器粘贴内容时是否显示一个小部件。该小部件可让你控制文件的粘贴方式。',
  'editorOption.editor.pasteAs.showPasteSelector.enum.0':
    '在内容粘贴到编辑器后显示粘贴选择器小部件。',
  'editorOption.editor.pasteAs.showPasteSelector.enum.1':
    '从不显示粘贴选择器小部件，始终使用默认的粘贴行为。',
  'editorOption.editor.peekWidgetDefaultFocus': '控制在速览小部件中聚焦内联编辑器还是树视图。',
  'editorOption.editor.peekWidgetDefaultFocus.enum.0': '打开速览时聚焦树视图。',
  'editorOption.editor.peekWidgetDefaultFocus.enum.1': '打开速览时聚焦编辑器。',
  'editorOption.editor.quickSuggestions':
    '控制是否在输入时自动显示建议。可分别针对在注释、字符串以及其他代码中输入进行控制。快速建议可配置为显示为幽灵文本或使用建议小部件。另请注意 - 设置，它控制建议是否由特殊字符触发。',
  'editorOption.editor.quickSuggestions.anyOf.1.enum.0': '对所有标记类型启用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.1.enum.1':
    '对所有标记类型以幽灵文本形式显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.1.enum.2': '对所有标记类型禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.1.enum.3':
    '当显示内联补全时，对所有标记类型禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.comments': '在注释内启用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.0':
    '在建议小部件中显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.1':
    '以幽灵文本形式显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.2': '禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.3':
    '当显示内联补全时禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.other': '在字符串和注释之外启用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.0':
    '在建议小部件中显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.1':
    '以幽灵文本形式显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.2': '禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.3':
    '当显示内联补全时禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.strings': '在字符串内启用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.0':
    '在建议小部件中显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.1':
    '以幽灵文本形式显示快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.2': '禁用快速建议。',
  'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.3':
    '当显示内联补全时禁用快速建议。',
  'editorOption.editor.quickSuggestionsDelay': '控制快速建议显示前的延迟（以毫秒为单位）。',
  'editorOption.editor.renameOnType': '控制编辑器是否在输入时自动重命名。',
  'editorOption.editor.renderControlCharacters': '控制编辑器是否应渲染控制字符。',
  'editorOption.editor.renderFinalNewline': '当文件以换行符结尾时渲染最后一个行号。',
  'editorOption.editor.renderLineHighlightOnlyWhenFocus':
    '控制编辑器是否仅在获得焦点时才渲染当前行高亮。',
  'editorOption.editor.renderRichScreenReaderContent':
    '当启用 `editor.editContext` 设置时，是否渲染丰富的屏幕阅读器内容。',
  'editorOption.editor.renderWhitespace': '控制编辑器应如何渲染空白字符。',
  'editorOption.editor.renderWhitespace.enum.1': '渲染空白字符，但单词之间的单个空格除外。',
  'editorOption.editor.renderWhitespace.enum.2': '仅在选中文本上渲染空白字符。',
  'editorOption.editor.renderWhitespace.enum.3': '仅渲染行尾的空白字符。',
  'editorOption.editor.roundedSelection': '控制选区是否应具有圆角。',
  'editorOption.editor.rulers':
    '在指定数量的等宽字符之后渲染垂直标尺。使用多个值可显示多条标尺。若数组为空则不绘制标尺。',
  'editorOption.editor.rulers.items.anyOf.0': '此编辑器标尺将渲染于的等宽字符数。',
  'editorOption.editor.rulers.items.anyOf.1.color': '此编辑器标尺的颜色。',
  'editorOption.editor.rulers.items.anyOf.1.column': '此编辑器标尺将渲染于的等宽字符数。',
  'editorOption.editor.scrollBeyondLastColumn': '控制编辑器水平滚动时超出最后一列的额外字符数。',
  'editorOption.editor.scrollBeyondLastLine': '控制编辑器是否可滚动超过最后一行。',
  'editorOption.editor.scrollOnMiddleClick': '控制按下鼠标中键时编辑器是否滚动。',
  'editorOption.editor.scrollPredominantAxis':
    '在同时垂直和水平滚动时，仅沿主导轴滚动。可防止在触控板上垂直滚动时发生水平偏移。',
  'editorOption.editor.scrollbar.horizontal': '控制水平滚动条的可见性。',
  'editorOption.editor.scrollbar.horizontal.enum.0': '仅在必要时显示水平滚动条。',
  'editorOption.editor.scrollbar.horizontal.enum.1': '始终显示水平滚动条。',
  'editorOption.editor.scrollbar.horizontal.enum.2': '始终隐藏水平滚动条。',
  'editorOption.editor.scrollbar.horizontalScrollbarSize': '水平滚动条的高度。',
  'editorOption.editor.scrollbar.ignoreHorizontalScrollbarInContentHeight':
    '设置后，水平滚动条将不会增加编辑器内容的尺寸。',
  'editorOption.editor.scrollbar.scrollByPage': '控制点击时是按页滚动还是跳转到点击位置。',
  'editorOption.editor.scrollbar.vertical': '控制垂直滚动条的可见性。',
  'editorOption.editor.scrollbar.vertical.enum.0': '仅在必要时显示垂直滚动条。',
  'editorOption.editor.scrollbar.vertical.enum.1': '始终显示垂直滚动条。',
  'editorOption.editor.scrollbar.vertical.enum.2': '始终隐藏垂直滚动条。',
  'editorOption.editor.scrollbar.verticalScrollbarSize': '垂直滚动条的宽度。',
  'editorOption.editor.selectionClipboard': '控制是否应支持 Linux 主剪贴板。',
  'editorOption.editor.selectionHighlight': '控制编辑器是否应高亮显示与选区相似的匹配项。',
  'editorOption.editor.selectionHighlightMaxLength':
    '控制选区中字符数达到多少后将不再高亮显示相似匹配项。设为零表示不限制。',
  'editorOption.editor.selectionHighlightMultiline': '控制编辑器是否应高亮显示跨多行的选区匹配项。',
  'editorOption.editor.showDeprecated': '控制是否对已弃用的变量添加删除线。',
  'editorOption.editor.showFoldingControls': '控制何时显示装订线上的折叠控件。',
  'editorOption.editor.showFoldingControls.enum.0': '始终显示折叠控件。',
  'editorOption.editor.showFoldingControls.enum.1': '从不显示折叠控件，并缩小行号槽的尺寸。',
  'editorOption.editor.showFoldingControls.enum.2': '仅当鼠标悬停在行号槽上时显示折叠控件。',
  'editorOption.editor.showUnused': '控制未使用代码的淡出效果。',
  'editorOption.editor.smartSelect.selectLeadingAndTrailingWhitespace':
    '是否始终选中前导和尾随空白。',
  'editorOption.editor.smartSelect.selectSubwords':
    "是否选中子词（如 'fooBar' 中的 'foo' 或 'foo_bar' 中的 'foo'）。",
  'editorOption.editor.smoothScrolling': '控制编辑器是否使用动画进行滚动。',
  'editorOption.editor.snippetSuggestions':
    '控制代码片段是否与其他建议一同显示，以及它们的排序方式。',
  'editorOption.editor.snippetSuggestions.enum.0': '在其他建议之上显示代码片段建议。',
  'editorOption.editor.snippetSuggestions.enum.1': '在其他建议之下显示代码片段建议。',
  'editorOption.editor.snippetSuggestions.enum.2': '将代码片段建议与其他建议一同显示。',
  'editorOption.editor.snippetSuggestions.enum.3': '不显示代码片段建议。',
  'editorOption.editor.stickyScroll.defaultModel':
    '定义用于确定哪些行应固定显示的模型。如果大纲模型不存在，则回退到折叠提供程序模型，再回退到缩进模型。这三种情况均遵循该顺序。',
  'editorOption.editor.stickyScroll.enabled': '在滚动时于编辑器顶部显示当前嵌套的作用域。',
  'editorOption.editor.stickyScroll.maxLineCount': '定义固定行的最大显示数量。',
  'editorOption.editor.stickyScroll.scrollWithEditor': '启用粘性滚动随编辑器水平滚动条一同滚动。',
  'editorOption.editor.stickyTabStops':
    '在使用空格缩进时模拟制表符的选择行为。选择将吸附到制表位。',
  'editorOption.editor.suggest.filterGraceful': '控制筛选和排序建议时是否考虑细微的拼写错误。',
  'editorOption.editor.suggest.insertMode':
    '控制接受补全时是否覆盖原有单词。请注意，这取决于扩展是否选择启用此功能。',
  'editorOption.editor.suggest.insertMode.enum.0': '插入建议，且不覆盖光标右侧的文本。',
  'editorOption.editor.suggest.insertMode.enum.1': '插入建议，并覆盖光标右侧的文本。',
  'editorOption.editor.suggest.localityBonus': '控制排序时是否优先显示靠近光标的单词。',
  'editorOption.editor.suggest.matchOnWordStartOnly':
    '启用时，IntelliSense 筛选要求首个字符匹配单词的起始位置。例如 `c` 可匹配 `Console` 或 `WebContext`，但 _不会_ 匹配 `description`。禁用时，IntelliSense 将显示更多结果，但仍按匹配质量排序。',
  'editorOption.editor.suggest.preview': '控制是否在编辑器中预览建议的结果。',
  'editorOption.editor.suggest.selectionMode':
    '控制建议控件显示时是否选中某条建议。请注意，这仅适用于自动触发的建议（和），而显式调用建议时（例如通过 `Ctrl+Space`）始终会选中某条建议。',
  'editorOption.editor.suggest.selectionMode.enum.0': '自动触发 IntelliSense 时始终选中一条建议。',
  'editorOption.editor.suggest.selectionMode.enum.1': '自动触发 IntelliSense 时从不选中建议。',
  'editorOption.editor.suggest.selectionMode.enum.2':
    '仅当从触发字符触发 IntelliSense 时才选中一条建议。',
  'editorOption.editor.suggest.selectionMode.enum.3':
    '仅当随键入触发 IntelliSense 时才选中一条建议。',
  'editorOption.editor.suggest.shareSuggestSelections':
    '控制记住的建议选择是否在多个工作区和窗口之间共享（需要 `editor.suggestSelection`）。',
  'editorOption.editor.suggest.showClasses': '启用时，IntelliSense 显示 `class` 类建议。',
  'editorOption.editor.suggest.showColors': '启用时，IntelliSense 显示 `color` 类建议。',
  'editorOption.editor.suggest.showConstants': '启用时，IntelliSense 显示 `constant` 类建议。',
  'editorOption.editor.suggest.showConstructors':
    '启用时，IntelliSense 显示 `constructor` 类建议。',
  'editorOption.editor.suggest.showCustomcolors':
    '启用时，IntelliSense 显示 `customcolor` 类建议。',
  'editorOption.editor.suggest.showDeprecated': '启用时，IntelliSense 显示 `deprecated` 类建议。',
  'editorOption.editor.suggest.showEnumMembers': '启用时，IntelliSense 显示 `enumMember` 类建议。',
  'editorOption.editor.suggest.showEnums': '启用时，IntelliSense 显示 `enum` 类建议。',
  'editorOption.editor.suggest.showEvents': '启用时，IntelliSense 显示 `event` 类建议。',
  'editorOption.editor.suggest.showFields': '启用时，IntelliSense 显示 `field` 类建议。',
  'editorOption.editor.suggest.showFiles': '启用时，IntelliSense 显示 `file` 类建议。',
  'editorOption.editor.suggest.showFolders': '启用时，IntelliSense 显示 `folder` 类建议。',
  'editorOption.editor.suggest.showFunctions': '启用时，IntelliSense 显示 `function` 类建议。',
  'editorOption.editor.suggest.showIcons': '控制是否在建议中显示或隐藏图标。',
  'editorOption.editor.suggest.showInlineDetails':
    '控制建议详情是与标签内联显示，还是仅在详情控件中显示。',
  'editorOption.editor.suggest.showInterfaces': '启用时，IntelliSense 显示 `interface` 类建议。',
  'editorOption.editor.suggest.showIssues': '启用时，IntelliSense 显示 `issues` 类建议。',
  'editorOption.editor.suggest.showKeywords': '启用时，IntelliSense 显示 `keyword` 类建议。',
  'editorOption.editor.suggest.showMethods': '启用时，IntelliSense 显示 `method` 类建议。',
  'editorOption.editor.suggest.showModules': '启用时，IntelliSense 显示 `module` 类建议。',
  'editorOption.editor.suggest.showOperators': '启用时，IntelliSense 显示 `operator` 类建议。',
  'editorOption.editor.suggest.showProperties': '启用时，IntelliSense 显示 `property` 类建议。',
  'editorOption.editor.suggest.showReferences': '启用时，IntelliSense 显示 `reference` 类建议。',
  'editorOption.editor.suggest.showSnippets': '启用时，IntelliSense 显示 `snippet` 类建议。',
  'editorOption.editor.suggest.showStatusBar': '控制建议控件底部状态栏的可见性。',
  'editorOption.editor.suggest.showStructs': '启用时，IntelliSense 显示 `struct` 类建议。',
  'editorOption.editor.suggest.showTypeParameters':
    '启用时，IntelliSense 显示 `typeParameter` 类建议。',
  'editorOption.editor.suggest.showUnits': '启用时，IntelliSense 显示 `unit` 类建议。',
  'editorOption.editor.suggest.showUsers': '启用时，IntelliSense 显示 `user` 类建议。',
  'editorOption.editor.suggest.showValues': '启用时，IntelliSense 显示 `value` 类建议。',
  'editorOption.editor.suggest.showVariables': '启用时，IntelliSense 显示 `variable` 类建议。',
  'editorOption.editor.suggest.showWords': '启用时，IntelliSense 显示 `text` 类建议。',
  'editorOption.editor.suggest.snippetsPreventQuickSuggestions':
    '控制处于激活状态的代码片段是否阻止快速建议。',
  'editorOption.editor.suggestFontSize': '建议控件的字体大小。当设置为时，将使用的值。',
  'editorOption.editor.suggestLineHeight': '建议控件的行高。当设置为时，将使用的值。最小值为 8。',
  'editorOption.editor.suggestOnTriggerCharacters': '控制键入触发字符时是否自动显示建议。',
  'editorOption.editor.suggestSelection': '控制显示建议列表时如何预选建议。',
  'editorOption.editor.suggestSelection.enum.0': '始终选中第一条建议。',
  'editorOption.editor.suggestSelection.enum.1':
    '选中最近使用的建议，除非继续键入选中了其他建议，例如 `console.| -> console.log`，因为 `log` 是最近补全过的。',
  'editorOption.editor.suggestSelection.enum.2':
    '根据之前补全过这些建议的前缀来选中建议，例如 `co -> console` 和 `con -> const`。',
  'editorOption.editor.tabCompletion': '启用 Tab 补全。',
  'editorOption.editor.tabCompletion.enum.0': '按 Tab 键时，Tab 补全将插入最匹配的建议。',
  'editorOption.editor.tabCompletion.enum.1': '禁用 Tab 补全。',
  'editorOption.editor.tabCompletion.enum.2':
    "当代码片段前缀匹配时，使用 Tab 补全代码片段。在未启用 'quickSuggestions' 时效果最佳。",
  'editorOption.editor.tabFocusMode': '控制编辑器是接收 Tab 键，还是将其交给工作台用于导航。',
  'editorOption.editor.trimWhitespaceOnDelete':
    '控制删除换行符时，编辑器是否同时删除下一行的缩进空白。',
  'editorOption.editor.unfoldOnClickAfterEndOfLine':
    '控制点击折叠行末尾后方的空白内容时是否展开该行。',
  'editorOption.editor.unusualLineTerminators': '移除可能导致问题的异常行终止符。',
  'editorOption.editor.unusualLineTerminators.enum.0': '自动移除异常行终止符。',
  'editorOption.editor.unusualLineTerminators.enum.1': '忽略异常行终止符。',
  'editorOption.editor.unusualLineTerminators.enum.2': '提示是否移除异常行终止符。',
  'editorOption.editor.useTabStops': '插入和删除空格与制表符时与制表位对齐。',
  'editorOption.editor.wordBreak': '控制用于中文/日文/韩文（CJK）文本的断词规则。',
  'editorOption.editor.wordBreak.enum.0': '使用默认的换行规则。',
  'editorOption.editor.wordBreak.enum.1':
    '中文/日文/韩文（CJK）文本不应使用断词。非 CJK 文本的行为与 normal 相同。',
  'editorOption.editor.wordSegmenterLocales':
    '进行与单词相关的导航或操作时用于分词的区域设置。请指定你希望识别的单词的 BCP 47 语言标签（例如 ja、zh-CN、zh-Hant-TW 等）。',
  'editorOption.editor.wordSeparators': '进行与单词相关的导航或操作时用作单词分隔符的字符。',
  'editorOption.editor.wordWrapColumn':
    '当 `editor.wordWrap` 为 `wordWrapColumn` 或 `bounded` 时，控制编辑器的换行列。',
  'editorOption.editor.wrapOnEscapedLineFeeds':
    '控制当 `editor.wordWrap` 启用时，字面量 `\\n` 是否触发自动换行。例如：\n```c\nchar* str="hello\\nworld"\n```\n将显示为\n```c\nchar* str="hello\\n world"\n```',
  'editorOption.editor.wrappingIndent': '控制换行行的缩进。',
  'editorOption.editor.wrappingIndent.enum.0': '无缩进。换行行从第 1 列开始。',
  'editorOption.editor.wrappingIndent.enum.1': '换行行获得与父行相同的缩进。',
  'editorOption.editor.wrappingIndent.enum.2': '换行行相对父行获得 +1 的缩进。',
  'editorOption.editor.wrappingIndent.enum.3': '换行行相对父行获得 +2 的缩进。',
  'editorOption.editor.wrappingStrategy':
    '控制计算换行点的算法。请注意，在辅助功能模式下将使用 advanced 以获得最佳体验。',
  'editorOption.editor.wrappingStrategy.enum.0':
    '假定所有字符宽度相同。这是一种快速算法，对等宽字体以及某些字形等宽的书写系统（如拉丁字符）能正确工作。',
  'editorOption.editor.wrappingStrategy.enum.1':
    '将换行点的计算委托给浏览器。这是一种较慢的算法，对大文件可能导致卡顿，但在所有情况下都能正确工作。',
}
