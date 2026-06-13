/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  GENERATED FILE — DO NOT EDIT BY HAND.
 *  Regenerate with: node scripts/gen-editor-schema.mjs [path-to-vscode/src/vs]
 *
 *  Full Monaco editor option schema extracted from the VSCode source tree,
 *  adapted to IConfigurationPropertySchema. Hand-written editor.* settings win
 *  over these (they are excluded here). Descriptions are wrapped in localize()
 *  so zh-CN translations in messages/editorOptions.zh-CN.ts apply at runtime.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationPropertySchema } from '@universe-editor/platform'
import { localize } from '@universe-editor/platform'

export const GENERATED_EDITOR_OPTIONS: Record<string, IConfigurationPropertySchema> = {
  'editor.acceptSuggestionOnCommitCharacter': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.acceptSuggestionOnCommitCharacter',
      'Controls whether suggestions should be accepted on commit characters. For example, in JavaScript, the semi-colon (`;`) can be a commit character that accepts a suggestion and types that character.',
    ),
  },
  'editor.acceptSuggestionOnEnter': {
    type: 'string',
    default: 'on',
    enum: ['on', 'smart', 'off'],
    description: localize(
      'editorOption.editor.acceptSuggestionOnEnter',
      'Controls whether suggestions should be accepted on `Enter`, in addition to `Tab`. Helps to avoid ambiguity between inserting new lines or accepting suggestions.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.acceptSuggestionOnEnter.enum.1',
        'Only accept a suggestion with `Enter` when it makes a textual change.',
      ),
      '',
    ],
  },
  'editor.allowVariableFonts': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.allowVariableFonts',
      'Controls whether to allow using variable fonts in the editor.',
    ),
  },
  'editor.allowVariableLineHeights': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.allowVariableLineHeights',
      'Controls whether to allow using variable line heights in the editor.',
    ),
  },
  'editor.autoClosingBrackets': {
    type: 'string',
    default: 'languageDefined',
    enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
    description: localize(
      'editorOption.editor.autoClosingBrackets',
      'Controls whether the editor should automatically close brackets after the user adds an opening bracket.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.autoClosingBrackets.enum.1',
        'Use language configurations to determine when to autoclose brackets.',
      ),
      localize(
        'editorOption.editor.autoClosingBrackets.enum.2',
        'Autoclose brackets only when the cursor is to the left of whitespace.',
      ),
      '',
    ],
  },
  'editor.autoClosingComments': {
    type: 'string',
    default: 'languageDefined',
    enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
    description: localize(
      'editorOption.editor.autoClosingComments',
      'Controls whether the editor should automatically close comments after the user adds an opening comment.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.autoClosingComments.enum.1',
        'Use language configurations to determine when to autoclose comments.',
      ),
      localize(
        'editorOption.editor.autoClosingComments.enum.2',
        'Autoclose comments only when the cursor is to the left of whitespace.',
      ),
      '',
    ],
  },
  'editor.autoClosingDelete': {
    type: 'string',
    default: 'auto',
    enum: ['always', 'auto', 'never'],
    description: localize(
      'editorOption.editor.autoClosingDelete',
      'Controls whether the editor should remove adjacent closing quotes or brackets when deleting.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.autoClosingDelete.enum.1',
        'Remove adjacent closing quotes or brackets only if they were automatically inserted.',
      ),
      '',
    ],
  },
  'editor.autoClosingOvertype': {
    type: 'string',
    default: 'auto',
    enum: ['always', 'auto', 'never'],
    description: localize(
      'editorOption.editor.autoClosingOvertype',
      'Controls whether the editor should type over closing quotes or brackets.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.autoClosingOvertype.enum.1',
        'Type over closing quotes or brackets only if they were automatically inserted.',
      ),
      '',
    ],
  },
  'editor.autoClosingQuotes': {
    type: 'string',
    default: 'languageDefined',
    enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
    description: localize(
      'editorOption.editor.autoClosingQuotes',
      'Controls whether the editor should automatically close quotes after the user adds an opening quote.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.autoClosingQuotes.enum.1',
        'Use language configurations to determine when to autoclose quotes.',
      ),
      localize(
        'editorOption.editor.autoClosingQuotes.enum.2',
        'Autoclose quotes only when the cursor is to the left of whitespace.',
      ),
      '',
    ],
  },
  'editor.autoIndent': {
    type: 'string',
    default: 'full',
    enum: ['none', 'keep', 'brackets', 'advanced', 'full'],
    description: localize(
      'editorOption.editor.autoIndent',
      'Controls whether the editor should automatically adjust the indentation when users type, paste, move or indent lines.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.autoIndent.enum.0',
        'The editor will not insert indentation automatically.',
      ),
      localize(
        'editorOption.editor.autoIndent.enum.1',
        "The editor will keep the current line's indentation.",
      ),
      localize(
        'editorOption.editor.autoIndent.enum.2',
        "The editor will keep the current line's indentation and honor language defined brackets.",
      ),
      localize(
        'editorOption.editor.autoIndent.enum.3',
        "The editor will keep the current line's indentation, honor language defined brackets and invoke special onEnterRules defined by languages.",
      ),
      localize(
        'editorOption.editor.autoIndent.enum.4',
        "The editor will keep the current line's indentation, honor language defined brackets, invoke special onEnterRules defined by languages, and honor indentationRules defined by languages.",
      ),
    ],
  },
  'editor.autoIndentOnPaste': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.autoIndentOnPaste',
      'Controls whether the editor should automatically auto-indent the pasted content.',
    ),
  },
  'editor.autoIndentOnPasteWithinString': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.autoIndentOnPasteWithinString',
      'Controls whether the editor should automatically auto-indent the pasted content when pasted within a string. This takes effect when autoIndentOnPaste is true.',
    ),
  },
  'editor.autoSurround': {
    type: 'string',
    default: 'languageDefined',
    enum: ['languageDefined', 'quotes', 'brackets', 'never'],
    description: localize(
      'editorOption.editor.autoSurround',
      'Controls whether the editor should automatically surround selections when typing quotes or brackets.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.autoSurround.enum.0',
        'Use language configurations to determine when to automatically surround selections.',
      ),
      localize('editorOption.editor.autoSurround.enum.1', 'Surround with quotes but not brackets.'),
      localize('editorOption.editor.autoSurround.enum.2', 'Surround with brackets but not quotes.'),
      '',
    ],
  },
  'editor.bracketPairColorization.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.bracketPairColorization.enabled',
      'Controls whether bracket pair colorization is enabled or not. Use to override the bracket highlight colors.',
    ),
  },
  'editor.bracketPairColorization.independentColorPoolPerBracketType': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.bracketPairColorization.independentColorPoolPerBracketType',
      'Controls whether each bracket type has its own independent color pool.',
    ),
  },
  'editor.codeLens': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.codeLens',
      'Controls whether the editor shows CodeLens.',
    ),
  },
  'editor.codeLensFontFamily': {
    type: 'string',
    default: '',
    description: localize(
      'editorOption.editor.codeLensFontFamily',
      'Controls the font family for CodeLens.',
    ),
  },
  'editor.codeLensFontSize': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 100,
    description: localize(
      'editorOption.editor.codeLensFontSize',
      'Controls the font size in pixels for CodeLens. When set to 0, 90% of `editor.fontSize` is used.',
    ),
  },
  'editor.colorDecorators': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.colorDecorators',
      'Controls whether the editor should render the inline color decorators and color picker.',
    ),
  },
  'editor.colorDecoratorsActivatedOn': {
    type: 'string',
    default: 'clickAndHover',
    enum: ['clickAndHover', 'hover', 'click'],
    description: localize(
      'editorOption.editor.colorDecoratorsActivatedOn',
      'Controls the condition to make a color picker appear from a color decorator.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.colorDecoratorsActivatedOn.enum.0',
        'Make the color picker appear both on click and hover of the color decorator',
      ),
      localize(
        'editorOption.editor.colorDecoratorsActivatedOn.enum.1',
        'Make the color picker appear on hover of the color decorator',
      ),
      localize(
        'editorOption.editor.colorDecoratorsActivatedOn.enum.2',
        'Make the color picker appear on click of the color decorator',
      ),
    ],
  },
  'editor.colorDecoratorsLimit': {
    type: 'integer',
    default: 500,
    minimum: 1,
    maximum: 1000000,
    description: localize(
      'editorOption.editor.colorDecoratorsLimit',
      'Controls the max number of color decorators that can be rendered in an editor at once.',
    ),
  },
  'editor.columnSelection': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.columnSelection',
      'Enable that the selection with the mouse and keys is doing column selection.',
    ),
  },
  'editor.comments.ignoreEmptyLines': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.comments.ignoreEmptyLines',
      'Controls if empty lines should be ignored with toggle, add or remove actions for line comments.',
    ),
  },
  'editor.comments.insertSpace': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.comments.insertSpace',
      'Controls whether a space character is inserted when commenting.',
    ),
  },
  'editor.copyWithSyntaxHighlighting': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.copyWithSyntaxHighlighting',
      'Controls whether syntax highlighting should be copied into the clipboard.',
    ),
  },
  'editor.cursorBlinking': {
    type: 'string',
    default: 'blink',
    enum: ['blink', 'smooth', 'phase', 'expand', 'solid'],
    description: localize(
      'editorOption.editor.cursorBlinking',
      'Control the cursor animation style.',
    ),
  },
  'editor.cursorHeight': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.cursorHeight',
      "Controls the height of the cursor when `editor.cursorStyle` is set to `line`. Cursor's max height depends on line height.",
    ),
  },
  'editor.cursorSmoothCaretAnimation': {
    type: 'string',
    default: 'off',
    enum: ['off', 'explicit', 'on'],
    description: localize(
      'editorOption.editor.cursorSmoothCaretAnimation',
      'Controls whether the smooth caret animation should be enabled.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.cursorSmoothCaretAnimation.enum.0',
        'Smooth caret animation is disabled.',
      ),
      localize(
        'editorOption.editor.cursorSmoothCaretAnimation.enum.1',
        'Smooth caret animation is enabled only when the user moves the cursor with an explicit gesture.',
      ),
      localize(
        'editorOption.editor.cursorSmoothCaretAnimation.enum.2',
        'Smooth caret animation is always enabled.',
      ),
    ],
  },
  'editor.cursorStyle': {
    type: 'string',
    default: 'line',
    enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
    description: localize(
      'editorOption.editor.cursorStyle',
      'Controls the cursor style in insert input mode.',
    ),
  },
  'editor.cursorSurroundingLines': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.cursorSurroundingLines',
      "Controls the minimal number of visible leading lines (minimum 0) and trailing lines (minimum 1) surrounding the cursor. Known as 'scrollOff' or 'scrollOffset' in some other editors.",
    ),
  },
  'editor.cursorSurroundingLinesStyle': {
    type: 'string',
    default: 'default',
    enum: ['default', 'all'],
    description: localize(
      'editorOption.editor.cursorSurroundingLinesStyle',
      'Controls when `editor.cursorSurroundingLines` should be enforced.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.cursorSurroundingLinesStyle.enum.0',
        '`cursorSurroundingLines` is enforced only when triggered via the keyboard or API.',
      ),
      localize(
        'editorOption.editor.cursorSurroundingLinesStyle.enum.1',
        '`cursorSurroundingLines` is enforced always.',
      ),
    ],
  },
  'editor.cursorWidth': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.cursorWidth',
      'Controls the width of the cursor when `editor.cursorStyle` is set to `line`.',
    ),
  },
  'editor.defaultColorDecorators': {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'always', 'never'],
    description: localize(
      'editorOption.editor.defaultColorDecorators',
      'Controls whether inline color decorations should be shown using the default document color provider.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.defaultColorDecorators.enum.0',
        'Show default color decorators only when no extension provides colors decorators.',
      ),
      localize(
        'editorOption.editor.defaultColorDecorators.enum.1',
        'Always show default color decorators.',
      ),
      localize(
        'editorOption.editor.defaultColorDecorators.enum.2',
        'Never show default color decorators.',
      ),
    ],
  },
  'editor.definitionLinkOpensInPeek': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.definitionLinkOpensInPeek',
      'Controls whether the Go to Definition mouse gesture always opens the peek widget.',
    ),
  },
  'editor.dragAndDrop': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.dragAndDrop',
      'Controls whether the editor should allow moving selections via drag and drop.',
    ),
  },
  'editor.dropIntoEditor.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.dropIntoEditor.enabled',
      'Controls whether you can drag and drop a file into a text editor by holding down the `Shift` key (instead of opening the file in an editor).',
    ),
  },
  'editor.dropIntoEditor.showDropSelector': {
    type: 'string',
    default: 'afterDrop',
    enum: ['afterDrop', 'never'],
    description: localize(
      'editorOption.editor.dropIntoEditor.showDropSelector',
      'Controls if a widget is shown when dropping files into the editor. This widget lets you control how the file is dropped.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.dropIntoEditor.showDropSelector.enum.0',
        'Show the drop selector widget after a file is dropped into the editor.',
      ),
      localize(
        'editorOption.editor.dropIntoEditor.showDropSelector.enum.1',
        'Never show the drop selector widget. Instead the default drop provider is always used.',
      ),
    ],
  },
  'editor.emptySelectionClipboard': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.emptySelectionClipboard',
      'Controls whether copying without a selection copies the current line.',
    ),
  },
  'editor.fastScrollSensitivity': {
    type: 'number',
    default: 5,
    description: localize(
      'editorOption.editor.fastScrollSensitivity',
      'Scrolling speed multiplier when pressing `Alt`.',
    ),
  },
  'editor.find.addExtraSpaceOnTop': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.find.addExtraSpaceOnTop',
      'Controls whether the Find Widget should add extra lines on top of the editor. When true, you can scroll beyond the first line when the Find Widget is visible.',
    ),
  },
  'editor.find.autoFindInSelection': {
    type: 'string',
    default: 'never',
    enum: ['never', 'always', 'multiline'],
    description: localize(
      'editorOption.editor.find.autoFindInSelection',
      'Controls the condition for turning on Find in Selection automatically.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.find.autoFindInSelection.enum.0',
        'Never turn on Find in Selection automatically (default).',
      ),
      localize(
        'editorOption.editor.find.autoFindInSelection.enum.1',
        'Always turn on Find in Selection automatically.',
      ),
      localize(
        'editorOption.editor.find.autoFindInSelection.enum.2',
        'Turn on Find in Selection automatically when multiple lines of content are selected.',
      ),
    ],
  },
  'editor.find.closeOnResult': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.find.closeOnResult',
      'Controls whether the Find Widget closes after an explicit find navigation command lands on a result.',
    ),
  },
  'editor.find.cursorMoveOnType': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.find.cursorMoveOnType',
      'Controls whether the cursor should jump to find matches while typing.',
    ),
  },
  'editor.find.findOnType': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.find.findOnType',
      'Controls whether the Find Widget should search as you type.',
    ),
  },
  'editor.find.globalFindClipboard': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.find.globalFindClipboard',
      'Controls whether the Find Widget should read or modify the shared find clipboard on macOS.',
    ),
  },
  'editor.find.history': {
    type: 'string',
    default: 'workspace',
    enum: ['never', 'workspace'],
    description: localize(
      'editorOption.editor.find.history',
      'Controls how the find widget history should be stored',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.find.history.enum.0',
        'Do not store search history from the find widget.',
      ),
      localize(
        'editorOption.editor.find.history.enum.1',
        'Store search history across the active workspace',
      ),
    ],
  },
  'editor.find.loop': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.find.loop',
      'Controls whether the search automatically restarts from the beginning (or the end) when no further matches can be found.',
    ),
  },
  'editor.find.replaceHistory': {
    type: 'string',
    default: 'workspace',
    enum: ['never', 'workspace'],
    description: localize(
      'editorOption.editor.find.replaceHistory',
      'Controls how the replace widget history should be stored',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.find.replaceHistory.enum.0',
        'Do not store history from the replace widget.',
      ),
      localize(
        'editorOption.editor.find.replaceHistory.enum.1',
        'Store replace history across the active workspace',
      ),
    ],
  },
  'editor.find.seedSearchStringFromSelection': {
    type: 'string',
    default: 'always',
    enum: ['never', 'always', 'selection'],
    description: localize(
      'editorOption.editor.find.seedSearchStringFromSelection',
      'Controls whether the search string in the Find Widget is seeded from the editor selection.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.find.seedSearchStringFromSelection.enum.0',
        'Never seed search string from the editor selection.',
      ),
      localize(
        'editorOption.editor.find.seedSearchStringFromSelection.enum.1',
        'Always seed search string from the editor selection, including word at cursor position.',
      ),
      localize(
        'editorOption.editor.find.seedSearchStringFromSelection.enum.2',
        'Only seed search string from the editor selection.',
      ),
    ],
  },
  'editor.folding': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.folding',
      'Controls whether the editor has code folding enabled.',
    ),
  },
  'editor.foldingHighlight': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.foldingHighlight',
      'Controls whether the editor should highlight folded ranges.',
    ),
  },
  'editor.foldingImportsByDefault': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.foldingImportsByDefault',
      'Controls whether the editor automatically collapses import ranges.',
    ),
  },
  'editor.foldingMaximumRegions': {
    type: 'integer',
    default: 5000,
    minimum: 10,
    maximum: 65000,
    description: localize(
      'editorOption.editor.foldingMaximumRegions',
      'The maximum number of foldable regions. Increasing this value may result in the editor becoming less responsive when the current source has a large number of foldable regions.',
    ),
  },
  'editor.foldingStrategy': {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'indentation'],
    description: localize(
      'editorOption.editor.foldingStrategy',
      'Controls the strategy for computing folding ranges.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.foldingStrategy.enum.0',
        'Use a language-specific folding strategy if available, else the indentation-based one.',
      ),
      localize(
        'editorOption.editor.foldingStrategy.enum.1',
        'Use the indentation-based folding strategy.',
      ),
    ],
  },
  'editor.fontLigatures': {
    default: false,
    description: localize(
      'editorOption.editor.fontLigatures',
      "Configures font ligatures or font features. Can be either a boolean to enable/disable ligatures or a string for the value of the CSS 'font-feature-settings' property.",
    ),
    anyOf: [
      {
        type: 'boolean',
        description: localize(
          'editorOption.editor.fontLigatures.anyOf.0',
          "Enables/Disables font ligatures ('calt' and 'liga' font features). Change this to a string for fine-grained control of the 'font-feature-settings' CSS property.",
        ),
      },
      {
        type: 'string',
        description: localize(
          'editorOption.editor.fontLigatures.anyOf.1',
          "Explicit 'font-feature-settings' CSS property. A boolean can be passed instead if one only needs to turn on/off ligatures.",
        ),
      },
    ],
  },
  'editor.fontVariations': {
    default: false,
    description: localize(
      'editorOption.editor.fontVariations',
      "Configures font variations. Can be either a boolean to enable/disable the translation from font-weight to font-variation-settings or a string for the value of the CSS 'font-variation-settings' property.",
    ),
    anyOf: [
      {
        type: 'boolean',
        description: localize(
          'editorOption.editor.fontVariations.anyOf.0',
          "Enables/Disables the translation from font-weight to font-variation-settings. Change this to a string for fine-grained control of the 'font-variation-settings' CSS property.",
        ),
      },
      {
        type: 'string',
        description: localize(
          'editorOption.editor.fontVariations.anyOf.1',
          "Explicit 'font-variation-settings' CSS property. A boolean can be passed instead if one only needs to translate font-weight to font-variation-settings.",
        ),
      },
    ],
  },
  'editor.formatOnPaste': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.formatOnPaste',
      'Controls whether the editor should automatically format the pasted content. A formatter must be available and the formatter should be able to format a range in a document.',
    ),
  },
  'editor.formatOnType': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.formatOnType',
      'Controls whether the editor should automatically format the line after typing.',
    ),
  },
  'editor.glyphMargin': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.glyphMargin',
      'Controls whether the editor should render the vertical glyph margin. Glyph margin is mostly used for debugging.',
    ),
  },
  'editor.gotoLocation.alternativeDeclarationCommand': {
    type: 'string',
    default: 'editor.action.goToReferences',
    enum: [
      '',
      'editor.action.referenceSearch.trigger',
      'editor.action.goToReferences',
      'editor.action.peekImplementation',
      'editor.action.goToImplementation',
      'editor.action.peekTypeDefinition',
      'editor.action.goToTypeDefinition',
      'editor.action.peekDeclaration',
      'editor.action.revealDeclaration',
      'editor.action.peekDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.revealDefinition',
    ],
    description: localize(
      'editorOption.editor.gotoLocation.alternativeDeclarationCommand',
      "Alternative command id that is being executed when the result of 'Go to Declaration' is the current location.",
    ),
  },
  'editor.gotoLocation.alternativeDefinitionCommand': {
    type: 'string',
    default: 'editor.action.goToReferences',
    enum: [
      '',
      'editor.action.referenceSearch.trigger',
      'editor.action.goToReferences',
      'editor.action.peekImplementation',
      'editor.action.goToImplementation',
      'editor.action.peekTypeDefinition',
      'editor.action.goToTypeDefinition',
      'editor.action.peekDeclaration',
      'editor.action.revealDeclaration',
      'editor.action.peekDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.revealDefinition',
    ],
    description: localize(
      'editorOption.editor.gotoLocation.alternativeDefinitionCommand',
      "Alternative command id that is being executed when the result of 'Go to Definition' is the current location.",
    ),
  },
  'editor.gotoLocation.alternativeImplementationCommand': {
    type: 'string',
    default: '',
    enum: [
      '',
      'editor.action.referenceSearch.trigger',
      'editor.action.goToReferences',
      'editor.action.peekImplementation',
      'editor.action.goToImplementation',
      'editor.action.peekTypeDefinition',
      'editor.action.goToTypeDefinition',
      'editor.action.peekDeclaration',
      'editor.action.revealDeclaration',
      'editor.action.peekDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.revealDefinition',
    ],
    description: localize(
      'editorOption.editor.gotoLocation.alternativeImplementationCommand',
      "Alternative command id that is being executed when the result of 'Go to Implementation' is the current location.",
    ),
  },
  'editor.gotoLocation.alternativeReferenceCommand': {
    type: 'string',
    default: '',
    enum: [
      '',
      'editor.action.referenceSearch.trigger',
      'editor.action.goToReferences',
      'editor.action.peekImplementation',
      'editor.action.goToImplementation',
      'editor.action.peekTypeDefinition',
      'editor.action.goToTypeDefinition',
      'editor.action.peekDeclaration',
      'editor.action.revealDeclaration',
      'editor.action.peekDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.revealDefinition',
    ],
    description: localize(
      'editorOption.editor.gotoLocation.alternativeReferenceCommand',
      "Alternative command id that is being executed when the result of 'Go to Reference' is the current location.",
    ),
  },
  'editor.gotoLocation.alternativeTypeDefinitionCommand': {
    type: 'string',
    default: 'editor.action.goToReferences',
    enum: [
      '',
      'editor.action.referenceSearch.trigger',
      'editor.action.goToReferences',
      'editor.action.peekImplementation',
      'editor.action.goToImplementation',
      'editor.action.peekTypeDefinition',
      'editor.action.goToTypeDefinition',
      'editor.action.peekDeclaration',
      'editor.action.revealDeclaration',
      'editor.action.peekDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.revealDefinition',
    ],
    description: localize(
      'editorOption.editor.gotoLocation.alternativeTypeDefinitionCommand',
      "Alternative command id that is being executed when the result of 'Go to Type Definition' is the current location.",
    ),
  },
  'editor.gotoLocation.multipleDeclarations': {
    type: 'string',
    default: 'peek',
    enum: ['peek', 'gotoAndPeek', 'goto'],
    description: localize(
      'editorOption.editor.gotoLocation.multipleDeclarations',
      "Controls the behavior the 'Go to Declaration'-command when multiple target locations exist.",
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.gotoLocation.multipleDeclarations.enum.0',
        'Show Peek view of the results (default)',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleDeclarations.enum.1',
        'Go to the primary result and show a Peek view',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleDeclarations.enum.2',
        'Go to the primary result and enable Peek-less navigation to others',
      ),
    ],
  },
  'editor.gotoLocation.multipleDefinitions': {
    type: 'string',
    default: 'peek',
    enum: ['peek', 'gotoAndPeek', 'goto'],
    description: localize(
      'editorOption.editor.gotoLocation.multipleDefinitions',
      "Controls the behavior the 'Go to Definition'-command when multiple target locations exist.",
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.gotoLocation.multipleDefinitions.enum.0',
        'Show Peek view of the results (default)',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleDefinitions.enum.1',
        'Go to the primary result and show a Peek view',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleDefinitions.enum.2',
        'Go to the primary result and enable Peek-less navigation to others',
      ),
    ],
  },
  'editor.gotoLocation.multipleImplementations': {
    type: 'string',
    default: 'peek',
    enum: ['peek', 'gotoAndPeek', 'goto'],
    description: localize(
      'editorOption.editor.gotoLocation.multipleImplementations',
      "Controls the behavior the 'Go to Implementations'-command when multiple target locations exist.",
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.gotoLocation.multipleImplementations.enum.0',
        'Show Peek view of the results (default)',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleImplementations.enum.1',
        'Go to the primary result and show a Peek view',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleImplementations.enum.2',
        'Go to the primary result and enable Peek-less navigation to others',
      ),
    ],
  },
  'editor.gotoLocation.multipleReferences': {
    type: 'string',
    default: 'peek',
    enum: ['peek', 'gotoAndPeek', 'goto'],
    description: localize(
      'editorOption.editor.gotoLocation.multipleReferences',
      "Controls the behavior the 'Go to References'-command when multiple target locations exist.",
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.gotoLocation.multipleReferences.enum.0',
        'Show Peek view of the results (default)',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleReferences.enum.1',
        'Go to the primary result and show a Peek view',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleReferences.enum.2',
        'Go to the primary result and enable Peek-less navigation to others',
      ),
    ],
  },
  'editor.gotoLocation.multipleTypeDefinitions': {
    type: 'string',
    default: 'peek',
    enum: ['peek', 'gotoAndPeek', 'goto'],
    description: localize(
      'editorOption.editor.gotoLocation.multipleTypeDefinitions',
      "Controls the behavior the 'Go to Type Definition'-command when multiple target locations exist.",
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.0',
        'Show Peek view of the results (default)',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.1',
        'Go to the primary result and show a Peek view',
      ),
      localize(
        'editorOption.editor.gotoLocation.multipleTypeDefinitions.enum.2',
        'Go to the primary result and enable Peek-less navigation to others',
      ),
    ],
  },
  'editor.guides.bracketPairs': {
    type: ['boolean', 'string'],
    default: false,
    enum: [true, 'active', false],
    description: localize(
      'editorOption.editor.guides.bracketPairs',
      'Controls whether bracket pair guides are enabled or not.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.guides.bracketPairs.enum.0', 'Enables bracket pair guides.'),
      localize(
        'editorOption.editor.guides.bracketPairs.enum.1',
        'Enables bracket pair guides only for the active bracket pair.',
      ),
      localize('editorOption.editor.guides.bracketPairs.enum.2', 'Disables bracket pair guides.'),
    ],
  },
  'editor.guides.bracketPairsHorizontal': {
    type: ['boolean', 'string'],
    default: 'active',
    enum: [true, 'active', false],
    description: localize(
      'editorOption.editor.guides.bracketPairsHorizontal',
      'Controls whether horizontal bracket pair guides are enabled or not.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.guides.bracketPairsHorizontal.enum.0',
        'Enables horizontal guides as addition to vertical bracket pair guides.',
      ),
      localize(
        'editorOption.editor.guides.bracketPairsHorizontal.enum.1',
        'Enables horizontal guides only for the active bracket pair.',
      ),
      localize(
        'editorOption.editor.guides.bracketPairsHorizontal.enum.2',
        'Disables horizontal bracket pair guides.',
      ),
    ],
  },
  'editor.guides.highlightActiveBracketPair': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.guides.highlightActiveBracketPair',
      'Controls whether the editor should highlight the active bracket pair.',
    ),
  },
  'editor.guides.highlightActiveIndentation': {
    type: ['boolean', 'string'],
    default: true,
    enum: [true, 'always', false],
    description: localize(
      'editorOption.editor.guides.highlightActiveIndentation',
      'Controls whether the editor should highlight the active indent guide.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.guides.highlightActiveIndentation.enum.0',
        'Highlights the active indent guide.',
      ),
      localize(
        'editorOption.editor.guides.highlightActiveIndentation.enum.1',
        'Highlights the active indent guide even if bracket guides are highlighted.',
      ),
      localize(
        'editorOption.editor.guides.highlightActiveIndentation.enum.2',
        'Do not highlight the active indent guide.',
      ),
    ],
  },
  'editor.guides.indentation': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.guides.indentation',
      'Controls whether the editor should render indent guides.',
    ),
  },
  'editor.hideCursorInOverviewRuler': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.hideCursorInOverviewRuler',
      'Controls whether the cursor should be hidden in the overview ruler.',
    ),
  },
  'editor.hover.above': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.hover.above',
      "Prefer showing hovers above the line, if there's space.",
    ),
  },
  'editor.hover.delay': {
    type: 'number',
    default: 300,
    minimum: 0,
    maximum: 10000,
    description: localize(
      'editorOption.editor.hover.delay',
      'Controls the delay in milliseconds after which the hover is shown.',
    ),
  },
  'editor.hover.enabled': {
    type: 'string',
    default: 'on',
    enum: ['on', 'off', 'onKeyboardModifier'],
    description: localize(
      'editorOption.editor.hover.enabled',
      'Controls whether the hover is shown.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.hover.enabled.enum.0', 'Hover is enabled.'),
      localize('editorOption.editor.hover.enabled.enum.1', 'Hover is disabled.'),
      localize(
        'editorOption.editor.hover.enabled.enum.2',
        'Hover is shown when holding `` or `Alt` (the opposite modifier of `editor.multiCursorModifier`)',
      ),
    ],
  },
  'editor.hover.hidingDelay': {
    type: 'integer',
    default: 300,
    minimum: 0,
    description: localize(
      'editorOption.editor.hover.hidingDelay',
      'Controls the delay in milliseconds after which the hover is hidden. Requires `editor.hover.sticky` to be enabled.',
    ),
  },
  'editor.hover.showLongLineWarning': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.hover.showLongLineWarning',
      'Controls whether long line warning hovers are shown, such as when tokenization is skipped or rendering is paused.',
    ),
  },
  'editor.hover.sticky': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.hover.sticky',
      'Controls whether the hover should remain visible when mouse is moved over it.',
    ),
  },
  'editor.inertialScroll': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.inertialScroll',
      'Make scrolling inertial - mostly useful with touchpad on linux.',
    ),
  },
  'editor.inlayHints.enabled': {
    type: 'string',
    default: 'on',
    enum: ['on', 'onUnlessPressed', 'offUnlessPressed', 'off'],
    description: localize(
      'editorOption.editor.inlayHints.enabled',
      'Enables the inlay hints in the editor.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.inlayHints.enabled.enum.0', 'Inlay hints are enabled'),
      localize(
        'editorOption.editor.inlayHints.enabled.enum.1',
        'Inlay hints are showing by default and hide when holding',
      ),
      localize(
        'editorOption.editor.inlayHints.enabled.enum.2',
        'Inlay hints are hidden by default and show when holding',
      ),
      localize('editorOption.editor.inlayHints.enabled.enum.3', 'Inlay hints are disabled'),
    ],
  },
  'editor.inlayHints.fontFamily': {
    type: 'string',
    default: '',
    description: localize(
      'editorOption.editor.inlayHints.fontFamily',
      'Controls font family of inlay hints in the editor. When set to empty, the is used.',
    ),
  },
  'editor.inlayHints.fontSize': {
    type: 'number',
    default: 0,
    description: localize(
      'editorOption.editor.inlayHints.fontSize',
      'Controls font size of inlay hints in the editor. As default the is used when the configured value is less than or greater than the editor font size.',
    ),
  },
  'editor.inlayHints.maximumLength': {
    type: 'number',
    default: 43,
    description: localize(
      'editorOption.editor.inlayHints.maximumLength',
      'Maximum overall length of inlay hints, for a single line, before they get truncated by the editor. Set to `0` to never truncate',
    ),
  },
  'editor.inlayHints.padding': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.inlayHints.padding',
      'Enables the padding around the inlay hints in the editor.',
    ),
  },
  'editor.inlineSuggest.edits.allowCodeShifting': {
    type: 'string',
    default: 'always',
    enum: ['always', 'horizontal', 'never'],
    description: localize(
      'editorOption.editor.inlineSuggest.edits.allowCodeShifting',
      'Controls whether showing a suggestion will shift the code to make space for the suggestion inline.',
    ),
  },
  'editor.inlineSuggest.edits.renderSideBySide': {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'never'],
    description: localize(
      'editorOption.editor.inlineSuggest.edits.renderSideBySide',
      'Controls whether larger suggestions can be shown side by side.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.inlineSuggest.edits.renderSideBySide.enum.0',
        'Larger suggestions will show side by side if there is enough space, otherwise they will be shown below.',
      ),
      localize(
        'editorOption.editor.inlineSuggest.edits.renderSideBySide.enum.1',
        'Larger suggestions are never shown side by side and will always be shown below.',
      ),
    ],
  },
  'editor.inlineSuggest.edits.showCollapsed': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.inlineSuggest.edits.showCollapsed',
      'Controls whether the suggestion will show as collapsed until jumping to it.',
    ),
  },
  'editor.inlineSuggest.edits.showLongDistanceHint': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.inlineSuggest.edits.showLongDistanceHint',
      'Controls whether long distance inline suggestions are shown.',
    ),
  },
  'editor.inlineSuggest.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.inlineSuggest.enabled',
      'Controls whether to automatically show inline suggestions in the editor.',
    ),
  },
  'editor.inlineSuggest.fontFamily': {
    type: 'string',
    default: 'default',
    description: localize(
      'editorOption.editor.inlineSuggest.fontFamily',
      'Controls the font family of the inline suggestions.',
    ),
  },
  'editor.inlineSuggest.minShowDelay': {
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 10000,
    description: localize(
      'editorOption.editor.inlineSuggest.minShowDelay',
      'Controls the minimal delay in milliseconds after which inline suggestions are shown after typing.',
    ),
  },
  'editor.inlineSuggest.showToolbar': {
    type: 'string',
    default: 'onHover',
    enum: ['always', 'onHover', 'never'],
    description: localize(
      'editorOption.editor.inlineSuggest.showToolbar',
      'Controls when to show the inline suggestion toolbar.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.inlineSuggest.showToolbar.enum.0',
        'Show the inline suggestion toolbar whenever an inline suggestion is shown.',
      ),
      localize(
        'editorOption.editor.inlineSuggest.showToolbar.enum.1',
        'Show the inline suggestion toolbar when hovering over an inline suggestion.',
      ),
      localize(
        'editorOption.editor.inlineSuggest.showToolbar.enum.2',
        'Never show the inline suggestion toolbar.',
      ),
    ],
  },
  'editor.inlineSuggest.suppressInSnippetMode': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.inlineSuggest.suppressInSnippetMode',
      'Controls whether inline suggestions are suppressed when in snippet mode.',
    ),
  },
  'editor.inlineSuggest.suppressSuggestions': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.inlineSuggest.suppressSuggestions',
      'Controls how inline suggestions interact with the suggest widget. If enabled, the suggest widget is not shown automatically when inline suggestions are available.',
    ),
  },
  'editor.inlineSuggest.syntaxHighlightingEnabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.inlineSuggest.syntaxHighlightingEnabled',
      'Controls whether to show syntax highlighting for inline suggestions in the editor.',
    ),
  },
  'editor.inlineSuggest.triggerCommandOnProviderChange': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.inlineSuggest.triggerCommandOnProviderChange',
      'Controls whether to trigger a command when the inline suggestion provider changes.',
    ),
  },
  'editor.lightbulb.enabled': {
    type: 'string',
    default: 'onCode',
    enum: ['off', 'onCode', 'on'],
    description: localize(
      'editorOption.editor.lightbulb.enabled',
      'Enables the Code Action lightbulb in the editor.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.lightbulb.enabled.enum.0', 'Disable the code action menu.'),
      localize(
        'editorOption.editor.lightbulb.enabled.enum.1',
        'Show the code action menu when the cursor is on lines with code.',
      ),
      localize(
        'editorOption.editor.lightbulb.enabled.enum.2',
        'Show the code action menu when the cursor is on lines with code or on empty lines.',
      ),
    ],
  },
  'editor.lineNumbers': {
    type: 'string',
    default: 'on',
    enum: ['off', 'on', 'relative', 'interval'],
    description: localize(
      'editorOption.editor.lineNumbers',
      'Controls the display of line numbers.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.lineNumbers.enum.0', 'Line numbers are not rendered.'),
      localize(
        'editorOption.editor.lineNumbers.enum.1',
        'Line numbers are rendered as absolute number.',
      ),
      localize(
        'editorOption.editor.lineNumbers.enum.2',
        'Line numbers are rendered as distance in lines to cursor position.',
      ),
      localize(
        'editorOption.editor.lineNumbers.enum.3',
        'Line numbers are rendered every 10 lines.',
      ),
    ],
  },
  'editor.linkedEditing': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.linkedEditing',
      'Controls whether the editor has linked editing enabled. Depending on the language, related symbols such as HTML tags, are updated while editing.',
    ),
  },
  'editor.links': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.links',
      'Controls whether the editor should detect links and make them clickable.',
    ),
  },
  'editor.matchBrackets': {
    type: 'string',
    default: 'always',
    enum: ['always', 'near', 'never'],
    description: localize('editorOption.editor.matchBrackets', 'Highlight matching brackets.'),
  },
  'editor.minimap.autohide': {
    type: 'string',
    default: 'none',
    enum: ['none', 'mouseover', 'scroll'],
    description: localize(
      'editorOption.editor.minimap.autohide',
      'Controls whether the minimap is hidden automatically.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.minimap.autohide.enum.0', 'The minimap is always shown.'),
      localize(
        'editorOption.editor.minimap.autohide.enum.1',
        'The minimap is hidden when mouse is not over the minimap and shown when mouse is over the minimap.',
      ),
      localize(
        'editorOption.editor.minimap.autohide.enum.2',
        'The minimap is only shown when the editor is scrolled',
      ),
    ],
  },
  'editor.minimap.markSectionHeaderRegex': {
    type: 'string',
    default: '\\bMARK:\\s*(?<separator>-?)\\s*(?<label>.*)$',
    description: localize(
      'editorOption.editor.minimap.markSectionHeaderRegex',
      'Defines the regular expression used to find section headers in comments. The regex must contain a named match group `label` (written as `(?<label>.+)`) that encapsulates the section header, otherwise it will not work. Optionally you can include another match group named `separator`. Use \\n in the pattern to match multi-line headers.',
    ),
  },
  'editor.minimap.maxColumn': {
    type: 'number',
    default: 120,
    description: localize(
      'editorOption.editor.minimap.maxColumn',
      'Limit the width of the minimap to render at most a certain number of columns.',
    ),
  },
  'editor.minimap.renderCharacters': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.minimap.renderCharacters',
      'Render the actual characters on a line as opposed to color blocks.',
    ),
  },
  'editor.minimap.scale': {
    type: 'number',
    default: 1,
    enum: [1, 2, 3],
    minimum: 1,
    maximum: 3,
    description: localize(
      'editorOption.editor.minimap.scale',
      'Scale of content drawn in the minimap: 1, 2 or 3.',
    ),
  },
  'editor.minimap.sectionHeaderFontSize': {
    type: 'number',
    default: 9,
    description: localize(
      'editorOption.editor.minimap.sectionHeaderFontSize',
      'Controls the font size of section headers in the minimap.',
    ),
  },
  'editor.minimap.sectionHeaderLetterSpacing': {
    type: 'number',
    default: 1,
    description: localize(
      'editorOption.editor.minimap.sectionHeaderLetterSpacing',
      'Controls the amount of space (in pixels) between characters of section header. This helps the readability of the header in small font sizes.',
    ),
  },
  'editor.minimap.showMarkSectionHeaders': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.minimap.showMarkSectionHeaders',
      'Controls whether MARK: comments are shown as section headers in the minimap.',
    ),
  },
  'editor.minimap.showRegionSectionHeaders': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.minimap.showRegionSectionHeaders',
      'Controls whether named regions are shown as section headers in the minimap.',
    ),
  },
  'editor.minimap.showSlider': {
    type: 'string',
    default: 'mouseover',
    enum: ['always', 'mouseover'],
    description: localize(
      'editorOption.editor.minimap.showSlider',
      'Controls when the minimap slider is shown.',
    ),
  },
  'editor.minimap.side': {
    type: 'string',
    default: 'right',
    enum: ['left', 'right'],
    description: localize(
      'editorOption.editor.minimap.side',
      'Controls the side where to render the minimap.',
    ),
  },
  'editor.minimap.size': {
    type: 'string',
    default: 'proportional',
    enum: ['proportional', 'fill', 'fit'],
    description: localize('editorOption.editor.minimap.size', 'Controls the size of the minimap.'),
    enumDescriptions: [
      localize(
        'editorOption.editor.minimap.size.enum.0',
        'The minimap has the same size as the editor contents (and might scroll).',
      ),
      localize(
        'editorOption.editor.minimap.size.enum.1',
        'The minimap will stretch or shrink as necessary to fill the height of the editor (no scrolling).',
      ),
      localize(
        'editorOption.editor.minimap.size.enum.2',
        'The minimap will shrink as necessary to never be larger than the editor (no scrolling).',
      ),
    ],
  },
  'editor.mouseMiddleClickAction': {
    type: 'string',
    default: 'default',
    enum: ['default', 'openLink', 'ctrlLeftClick'],
    description: localize(
      'editorOption.editor.mouseMiddleClickAction',
      'Controls what happens when middle mouse button is clicked in the editor.',
    ),
  },
  'editor.mouseWheelScrollSensitivity': {
    type: 'number',
    default: 1,
    description: localize(
      'editorOption.editor.mouseWheelScrollSensitivity',
      'A multiplier to be used on the `deltaX` and `deltaY` of mouse wheel scroll events.',
    ),
  },
  'editor.mouseWheelZoom': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.mouseWheelZoom',
      'Zoom the font of the editor when using mouse wheel and holding `Ctrl`.',
    ),
  },
  'editor.multiCursorLimit': {
    type: 'integer',
    default: 10000,
    minimum: 1,
    maximum: 100000,
    description: localize(
      'editorOption.editor.multiCursorLimit',
      'Controls the max number of cursors that can be in an active editor at once.',
    ),
  },
  'editor.multiCursorMergeOverlapping': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.multiCursorMergeOverlapping',
      'Merge multiple cursors when they are overlapping.',
    ),
  },
  'editor.multiCursorModifier': {
    type: 'string',
    default: 'alt',
    enum: ['ctrlCmd', 'alt'],
    description: localize(
      'editorOption.editor.multiCursorModifier',
      'The modifier to be used to add multiple cursors with the mouse. The Go to Definition and Open Link mouse gestures will adapt such that they do not conflict with the [multicursor modifier](https://code.visualstudio.com/docs/editor/codebasics#_multicursor-modifier).',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.multiCursorModifier.enum.0',
        'Maps to `Control` on Windows and Linux and to `Command` on macOS.',
      ),
      localize(
        'editorOption.editor.multiCursorModifier.enum.1',
        'Maps to `Alt` on Windows and Linux and to `Option` on macOS.',
      ),
    ],
  },
  'editor.multiCursorPaste': {
    type: 'string',
    default: 'spread',
    enum: ['spread', 'full'],
    description: localize(
      'editorOption.editor.multiCursorPaste',
      'Controls pasting when the line count of the pasted text matches the cursor count.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.multiCursorPaste.enum.0',
        'Each cursor pastes a single line of the text.',
      ),
      localize('editorOption.editor.multiCursorPaste.enum.1', 'Each cursor pastes the full text.'),
    ],
  },
  'editor.occurrencesHighlightDelay': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 2000,
    description: localize(
      'editorOption.editor.occurrencesHighlightDelay',
      'Controls the delay in milliseconds after which occurrences are highlighted.',
    ),
  },
  'editor.overtypeCursorStyle': {
    type: 'string',
    default: 'block',
    enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
    description: localize(
      'editorOption.editor.overtypeCursorStyle',
      'Controls the cursor style in overtype input mode.',
    ),
  },
  'editor.overtypeOnPaste': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.overtypeOnPaste',
      'Controls whether pasting should overtype.',
    ),
  },
  'editor.overviewRulerBorder': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.overviewRulerBorder',
      'Controls whether a border should be drawn around the overview ruler.',
    ),
  },
  'editor.padding.bottom': {
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 1000,
    description: localize(
      'editorOption.editor.padding.bottom',
      'Controls the amount of space between the bottom edge of the editor and the last line.',
    ),
  },
  'editor.padding.top': {
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 1000,
    description: localize(
      'editorOption.editor.padding.top',
      'Controls the amount of space between the top edge of the editor and the first line.',
    ),
  },
  'editor.parameterHints.cycle': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.parameterHints.cycle',
      'Controls whether the parameter hints menu cycles or closes when reaching the end of the list.',
    ),
  },
  'editor.parameterHints.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.parameterHints.enabled',
      'Enables a pop-up that shows parameter documentation and type information as you type.',
    ),
  },
  'editor.pasteAs.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.pasteAs.enabled',
      'Controls whether you can paste content in different ways.',
    ),
  },
  'editor.pasteAs.showPasteSelector': {
    type: 'string',
    default: 'afterPaste',
    enum: ['afterPaste', 'never'],
    description: localize(
      'editorOption.editor.pasteAs.showPasteSelector',
      'Controls if a widget is shown when pasting content in to the editor. This widget lets you control how the file is pasted.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.pasteAs.showPasteSelector.enum.0',
        'Show the paste selector widget after content is pasted into the editor.',
      ),
      localize(
        'editorOption.editor.pasteAs.showPasteSelector.enum.1',
        'Never show the paste selector widget. Instead the default pasting behavior is always used.',
      ),
    ],
  },
  'editor.peekWidgetDefaultFocus': {
    type: 'string',
    default: 'tree',
    enum: ['tree', 'editor'],
    description: localize(
      'editorOption.editor.peekWidgetDefaultFocus',
      'Controls whether to focus the inline editor or the tree in the peek widget.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.peekWidgetDefaultFocus.enum.0',
        'Focus the tree when opening peek',
      ),
      localize(
        'editorOption.editor.peekWidgetDefaultFocus.enum.1',
        'Focus the editor when opening peek',
      ),
    ],
  },
  'editor.quickSuggestions': {
    default: { other: 'on', comments: 'off', strings: 'off' },
    description: localize(
      'editorOption.editor.quickSuggestions',
      'Controls whether suggestions should automatically show up while typing. This can be controlled for typing in comments, strings, and other code. Quick suggestion can be configured to show as ghost text or with the suggest widget. Also be aware of the -setting which controls if suggestions are triggered by special characters.',
    ),
    anyOf: [
      {
        type: 'boolean',
      },
      {
        type: 'string',
        enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'],
        enumDescriptions: [
          localize(
            'editorOption.editor.quickSuggestions.anyOf.1.enum.0',
            'Quick suggestions are enabled for all token types',
          ),
          localize(
            'editorOption.editor.quickSuggestions.anyOf.1.enum.1',
            'Quick suggestions show as ghost text for all token types',
          ),
          localize(
            'editorOption.editor.quickSuggestions.anyOf.1.enum.2',
            'Quick suggestions are disabled for all token types',
          ),
          localize(
            'editorOption.editor.quickSuggestions.anyOf.1.enum.3',
            'Quick suggestions are disabled for all token types when inline completions are showing',
          ),
        ],
      },
      {
        type: 'object',
        properties: {
          strings: {
            default: 'off',
            description: localize(
              'editorOption.editor.quickSuggestions.anyOf.2.strings',
              'Enable quick suggestions inside strings.',
            ),
            anyOf: [
              {
                type: 'boolean',
              },
              {
                type: 'string',
                enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'],
                enumDescriptions: [
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.0',
                    'Quick suggestions show inside the suggest widget',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.1',
                    'Quick suggestions show as ghost text',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.2',
                    'Quick suggestions are disabled',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.strings.anyOf.1.enum.3',
                    'Quick suggestions are disabled when inline completions are showing',
                  ),
                ],
              },
            ],
          },
          comments: {
            default: 'off',
            description: localize(
              'editorOption.editor.quickSuggestions.anyOf.2.comments',
              'Enable quick suggestions inside comments.',
            ),
            anyOf: [
              {
                type: 'boolean',
              },
              {
                type: 'string',
                enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'],
                enumDescriptions: [
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.0',
                    'Quick suggestions show inside the suggest widget',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.1',
                    'Quick suggestions show as ghost text',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.2',
                    'Quick suggestions are disabled',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.comments.anyOf.1.enum.3',
                    'Quick suggestions are disabled when inline completions are showing',
                  ),
                ],
              },
            ],
          },
          other: {
            default: 'on',
            description: localize(
              'editorOption.editor.quickSuggestions.anyOf.2.other',
              'Enable quick suggestions outside of strings and comments.',
            ),
            anyOf: [
              {
                type: 'boolean',
              },
              {
                type: 'string',
                enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'],
                enumDescriptions: [
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.0',
                    'Quick suggestions show inside the suggest widget',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.1',
                    'Quick suggestions show as ghost text',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.2',
                    'Quick suggestions are disabled',
                  ),
                  localize(
                    'editorOption.editor.quickSuggestions.anyOf.2.other.anyOf.1.enum.3',
                    'Quick suggestions are disabled when inline completions are showing',
                  ),
                ],
              },
            ],
          },
        },
        additionalProperties: false,
      },
    ],
  },
  'editor.quickSuggestionsDelay': {
    type: 'integer',
    default: 10,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.quickSuggestionsDelay',
      'Controls the delay in milliseconds after which quick suggestions will show up.',
    ),
  },
  'editor.renameOnType': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.renameOnType',
      'Controls whether the editor auto renames on type.',
    ),
  },
  'editor.renderControlCharacters': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.renderControlCharacters',
      'Controls whether the editor should render control characters.',
    ),
  },
  'editor.renderFinalNewline': {
    type: 'string',
    default: 'on',
    enum: ['off', 'on', 'dimmed'],
    description: localize(
      'editorOption.editor.renderFinalNewline',
      'Render last line number when the file ends with a newline.',
    ),
  },
  'editor.renderLineHighlightOnlyWhenFocus': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.renderLineHighlightOnlyWhenFocus',
      'Controls if the editor should render the current line highlight only when the editor is focused.',
    ),
  },
  'editor.renderRichScreenReaderContent': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.renderRichScreenReaderContent',
      'Whether to render rich screen reader content when the `editor.editContext` setting is enabled.',
    ),
  },
  'editor.renderWhitespace': {
    type: 'string',
    default: 'selection',
    enum: ['none', 'boundary', 'selection', 'trailing', 'all'],
    description: localize(
      'editorOption.editor.renderWhitespace',
      'Controls how the editor should render whitespace characters.',
    ),
    enumDescriptions: [
      '',
      localize(
        'editorOption.editor.renderWhitespace.enum.1',
        'Render whitespace characters except for single spaces between words.',
      ),
      localize(
        'editorOption.editor.renderWhitespace.enum.2',
        'Render whitespace characters only on selected text.',
      ),
      localize(
        'editorOption.editor.renderWhitespace.enum.3',
        'Render only trailing whitespace characters.',
      ),
      '',
    ],
  },
  'editor.roundedSelection': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.roundedSelection',
      'Controls whether selections should have rounded corners.',
    ),
  },
  'editor.rulers': {
    type: 'array',
    default: [],
    description: localize(
      'editorOption.editor.rulers',
      'Render vertical rulers after a certain number of monospace characters. Use multiple values for multiple rulers. No rulers are drawn if array is empty.',
    ),
    items: {
      anyOf: [
        {
          type: 'number',
          description: localize(
            'editorOption.editor.rulers.items.anyOf.0',
            'Number of monospace characters at which this editor ruler will render.',
          ),
        },
        {
          type: ['object'],
          properties: {
            column: {
              type: 'number',
              description: localize(
                'editorOption.editor.rulers.items.anyOf.1.column',
                'Number of monospace characters at which this editor ruler will render.',
              ),
            },
            color: {
              type: 'string',
              description: localize(
                'editorOption.editor.rulers.items.anyOf.1.color',
                'Color of this editor ruler.',
              ),
            },
          },
        },
      ],
    },
  },
  'editor.scrollBeyondLastColumn': {
    type: 'integer',
    default: 4,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.scrollBeyondLastColumn',
      'Controls the number of extra characters beyond which the editor will scroll horizontally.',
    ),
  },
  'editor.scrollBeyondLastLine': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.scrollBeyondLastLine',
      'Controls whether the editor will scroll beyond the last line.',
    ),
  },
  'editor.scrollOnMiddleClick': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.scrollOnMiddleClick',
      'Controls whether the editor will scroll when the middle button is pressed.',
    ),
  },
  'editor.scrollPredominantAxis': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.scrollPredominantAxis',
      'Scroll only along the predominant axis when scrolling both vertically and horizontally at the same time. Prevents horizontal drift when scrolling vertically on a trackpad.',
    ),
  },
  'editor.scrollbar.horizontal': {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'visible', 'hidden'],
    description: localize(
      'editorOption.editor.scrollbar.horizontal',
      'Controls the visibility of the horizontal scrollbar.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.scrollbar.horizontal.enum.0',
        'The horizontal scrollbar will be visible only when necessary.',
      ),
      localize(
        'editorOption.editor.scrollbar.horizontal.enum.1',
        'The horizontal scrollbar will always be visible.',
      ),
      localize(
        'editorOption.editor.scrollbar.horizontal.enum.2',
        'The horizontal scrollbar will always be hidden.',
      ),
    ],
  },
  'editor.scrollbar.horizontalScrollbarSize': {
    type: 'number',
    default: 12,
    description: localize(
      'editorOption.editor.scrollbar.horizontalScrollbarSize',
      'The height of the horizontal scrollbar.',
    ),
  },
  'editor.scrollbar.ignoreHorizontalScrollbarInContentHeight': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.scrollbar.ignoreHorizontalScrollbarInContentHeight',
      "When set, the horizontal scrollbar will not increase the size of the editor's content.",
    ),
  },
  'editor.scrollbar.scrollByPage': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.scrollbar.scrollByPage',
      'Controls whether clicks scroll by page or jump to click position.',
    ),
  },
  'editor.scrollbar.vertical': {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'visible', 'hidden'],
    description: localize(
      'editorOption.editor.scrollbar.vertical',
      'Controls the visibility of the vertical scrollbar.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.scrollbar.vertical.enum.0',
        'The vertical scrollbar will be visible only when necessary.',
      ),
      localize(
        'editorOption.editor.scrollbar.vertical.enum.1',
        'The vertical scrollbar will always be visible.',
      ),
      localize(
        'editorOption.editor.scrollbar.vertical.enum.2',
        'The vertical scrollbar will always be hidden.',
      ),
    ],
  },
  'editor.scrollbar.verticalScrollbarSize': {
    type: 'number',
    default: 14,
    description: localize(
      'editorOption.editor.scrollbar.verticalScrollbarSize',
      'The width of the vertical scrollbar.',
    ),
  },
  'editor.selectionClipboard': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.selectionClipboard',
      'Controls whether the Linux primary clipboard should be supported.',
    ),
  },
  'editor.selectionHighlight': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.selectionHighlight',
      'Controls whether the editor should highlight matches similar to the selection.',
    ),
  },
  'editor.selectionHighlightMaxLength': {
    type: 'integer',
    default: 200,
    minimum: 0,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.selectionHighlightMaxLength',
      'Controls how many characters can be in the selection before similiar matches are not highlighted. Set to zero for unlimited.',
    ),
  },
  'editor.selectionHighlightMultiline': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.selectionHighlightMultiline',
      'Controls whether the editor should highlight selection matches that span multiple lines.',
    ),
  },
  'editor.showDeprecated': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.showDeprecated',
      'Controls strikethrough deprecated variables.',
    ),
  },
  'editor.showFoldingControls': {
    type: 'string',
    default: 'mouseover',
    enum: ['always', 'never', 'mouseover'],
    description: localize(
      'editorOption.editor.showFoldingControls',
      'Controls when the folding controls on the gutter are shown.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.showFoldingControls.enum.0',
        'Always show the folding controls.',
      ),
      localize(
        'editorOption.editor.showFoldingControls.enum.1',
        'Never show the folding controls and reduce the gutter size.',
      ),
      localize(
        'editorOption.editor.showFoldingControls.enum.2',
        'Only show the folding controls when the mouse is over the gutter.',
      ),
    ],
  },
  'editor.showUnused': {
    type: 'boolean',
    default: true,
    description: localize('editorOption.editor.showUnused', 'Controls fading out of unused code.'),
  },
  'editor.smartSelect.selectLeadingAndTrailingWhitespace': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.smartSelect.selectLeadingAndTrailingWhitespace',
      'Whether leading and trailing whitespace should always be selected.',
    ),
  },
  'editor.smartSelect.selectSubwords': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.smartSelect.selectSubwords',
      "Whether subwords (like 'foo' in 'fooBar' or 'foo_bar') should be selected.",
    ),
  },
  'editor.smoothScrolling': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.smoothScrolling',
      'Controls whether the editor will scroll using an animation.',
    ),
  },
  'editor.snippetSuggestions': {
    type: 'string',
    default: 'inline',
    enum: ['top', 'bottom', 'inline', 'none'],
    description: localize(
      'editorOption.editor.snippetSuggestions',
      'Controls whether snippets are shown with other suggestions and how they are sorted.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.snippetSuggestions.enum.0',
        'Show snippet suggestions on top of other suggestions.',
      ),
      localize(
        'editorOption.editor.snippetSuggestions.enum.1',
        'Show snippet suggestions below other suggestions.',
      ),
      localize(
        'editorOption.editor.snippetSuggestions.enum.2',
        'Show snippets suggestions with other suggestions.',
      ),
      localize('editorOption.editor.snippetSuggestions.enum.3', 'Do not show snippet suggestions.'),
    ],
  },
  'editor.stickyScroll.defaultModel': {
    type: 'string',
    default: 'outlineModel',
    enum: ['outlineModel', 'foldingProviderModel', 'indentationModel'],
    description: localize(
      'editorOption.editor.stickyScroll.defaultModel',
      'Defines the model to use for determining which lines to stick. If the outline model does not exist, it will fall back on the folding provider model which falls back on the indentation model. This order is respected in all three cases.',
    ),
  },
  'editor.stickyScroll.enabled': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.stickyScroll.enabled',
      'Shows the nested current scopes during the scroll at the top of the editor.',
    ),
  },
  'editor.stickyScroll.maxLineCount': {
    type: 'number',
    default: 5,
    minimum: 1,
    maximum: 20,
    description: localize(
      'editorOption.editor.stickyScroll.maxLineCount',
      'Defines the maximum number of sticky lines to show.',
    ),
  },
  'editor.stickyScroll.scrollWithEditor': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.stickyScroll.scrollWithEditor',
      "Enable scrolling of Sticky Scroll with the editor's horizontal scrollbar.",
    ),
  },
  'editor.stickyTabStops': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.stickyTabStops',
      'Emulate selection behavior of tab characters when using spaces for indentation. Selection will stick to tab stops.',
    ),
  },
  'editor.suggest.filterGraceful': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.filterGraceful',
      'Controls whether filtering and sorting suggestions accounts for small typos.',
    ),
  },
  'editor.suggest.filteredTypes': {
    type: 'object',
  },
  'editor.suggest.insertMode': {
    type: 'string',
    default: 'insert',
    enum: ['insert', 'replace'],
    description: localize(
      'editorOption.editor.suggest.insertMode',
      'Controls whether words are overwritten when accepting completions. Note that this depends on extensions opting into this feature.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.suggest.insertMode.enum.0',
        'Insert suggestion without overwriting text right of the cursor.',
      ),
      localize(
        'editorOption.editor.suggest.insertMode.enum.1',
        'Insert suggestion and overwrite text right of the cursor.',
      ),
    ],
  },
  'editor.suggest.localityBonus': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.suggest.localityBonus',
      'Controls whether sorting favors words that appear close to the cursor.',
    ),
  },
  'editor.suggest.matchOnWordStartOnly': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.matchOnWordStartOnly',
      'When enabled IntelliSense filtering requires that the first character matches on a word start. For example, `c` on `Console` or `WebContext` but _not_ on `description`. When disabled IntelliSense will show more results but still sorts them by match quality.',
    ),
  },
  'editor.suggest.maxVisibleSuggestions': {
    type: 'number',
  },
  'editor.suggest.preview': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.suggest.preview',
      'Controls whether to preview the suggestion outcome in the editor.',
    ),
  },
  'editor.suggest.selectionMode': {
    type: 'string',
    default: 'always',
    enum: ['always', 'never', 'whenTriggerCharacter', 'whenQuickSuggestion'],
    description: localize(
      'editorOption.editor.suggest.selectionMode',
      'Controls whether a suggestion is selected when the widget shows. Note that this only applies to automatically triggered suggestions ( and ) and that a suggestion is always selected when explicitly invoked, e.g via `Ctrl+Space`.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.suggest.selectionMode.enum.0',
        'Always select a suggestion when automatically triggering IntelliSense.',
      ),
      localize(
        'editorOption.editor.suggest.selectionMode.enum.1',
        'Never select a suggestion when automatically triggering IntelliSense.',
      ),
      localize(
        'editorOption.editor.suggest.selectionMode.enum.2',
        'Select a suggestion only when triggering IntelliSense from a trigger character.',
      ),
      localize(
        'editorOption.editor.suggest.selectionMode.enum.3',
        'Select a suggestion only when triggering IntelliSense as you type.',
      ),
    ],
  },
  'editor.suggest.shareSuggestSelections': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.suggest.shareSuggestSelections',
      'Controls whether remembered suggestion selections are shared between multiple workspaces and windows (needs `editor.suggestSelection`).',
    ),
  },
  'editor.suggest.showClasses': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showClasses',
      'When enabled IntelliSense shows `class`-suggestions.',
    ),
  },
  'editor.suggest.showColors': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showColors',
      'When enabled IntelliSense shows `color`-suggestions.',
    ),
  },
  'editor.suggest.showConstants': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showConstants',
      'When enabled IntelliSense shows `constant`-suggestions.',
    ),
  },
  'editor.suggest.showConstructors': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showConstructors',
      'When enabled IntelliSense shows `constructor`-suggestions.',
    ),
  },
  'editor.suggest.showCustomcolors': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showCustomcolors',
      'When enabled IntelliSense shows `customcolor`-suggestions.',
    ),
  },
  'editor.suggest.showDeprecated': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showDeprecated',
      'When enabled IntelliSense shows `deprecated`-suggestions.',
    ),
  },
  'editor.suggest.showEnumMembers': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showEnumMembers',
      'When enabled IntelliSense shows `enumMember`-suggestions.',
    ),
  },
  'editor.suggest.showEnums': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showEnums',
      'When enabled IntelliSense shows `enum`-suggestions.',
    ),
  },
  'editor.suggest.showEvents': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showEvents',
      'When enabled IntelliSense shows `event`-suggestions.',
    ),
  },
  'editor.suggest.showFields': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showFields',
      'When enabled IntelliSense shows `field`-suggestions.',
    ),
  },
  'editor.suggest.showFiles': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showFiles',
      'When enabled IntelliSense shows `file`-suggestions.',
    ),
  },
  'editor.suggest.showFolders': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showFolders',
      'When enabled IntelliSense shows `folder`-suggestions.',
    ),
  },
  'editor.suggest.showFunctions': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showFunctions',
      'When enabled IntelliSense shows `function`-suggestions.',
    ),
  },
  'editor.suggest.showIcons': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showIcons',
      'Controls whether to show or hide icons in suggestions.',
    ),
  },
  'editor.suggest.showInlineDetails': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showInlineDetails',
      'Controls whether suggest details show inline with the label or only in the details widget.',
    ),
  },
  'editor.suggest.showInterfaces': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showInterfaces',
      'When enabled IntelliSense shows `interface`-suggestions.',
    ),
  },
  'editor.suggest.showIssues': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showIssues',
      'When enabled IntelliSense shows `issues`-suggestions.',
    ),
  },
  'editor.suggest.showKeywords': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showKeywords',
      'When enabled IntelliSense shows `keyword`-suggestions.',
    ),
  },
  'editor.suggest.showMethods': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showMethods',
      'When enabled IntelliSense shows `method`-suggestions.',
    ),
  },
  'editor.suggest.showModules': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showModules',
      'When enabled IntelliSense shows `module`-suggestions.',
    ),
  },
  'editor.suggest.showOperators': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showOperators',
      'When enabled IntelliSense shows `operator`-suggestions.',
    ),
  },
  'editor.suggest.showProperties': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showProperties',
      'When enabled IntelliSense shows `property`-suggestions.',
    ),
  },
  'editor.suggest.showReferences': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showReferences',
      'When enabled IntelliSense shows `reference`-suggestions.',
    ),
  },
  'editor.suggest.showSnippets': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showSnippets',
      'When enabled IntelliSense shows `snippet`-suggestions.',
    ),
  },
  'editor.suggest.showStatusBar': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.suggest.showStatusBar',
      'Controls the visibility of the status bar at the bottom of the suggest widget.',
    ),
  },
  'editor.suggest.showStructs': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showStructs',
      'When enabled IntelliSense shows `struct`-suggestions.',
    ),
  },
  'editor.suggest.showTypeParameters': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showTypeParameters',
      'When enabled IntelliSense shows `typeParameter`-suggestions.',
    ),
  },
  'editor.suggest.showUnits': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showUnits',
      'When enabled IntelliSense shows `unit`-suggestions.',
    ),
  },
  'editor.suggest.showUsers': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showUsers',
      'When enabled IntelliSense shows `user`-suggestions.',
    ),
  },
  'editor.suggest.showValues': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showValues',
      'When enabled IntelliSense shows `value`-suggestions.',
    ),
  },
  'editor.suggest.showVariables': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showVariables',
      'When enabled IntelliSense shows `variable`-suggestions.',
    ),
  },
  'editor.suggest.showWords': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggest.showWords',
      'When enabled IntelliSense shows `text`-suggestions.',
    ),
  },
  'editor.suggest.snippetsPreventQuickSuggestions': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.suggest.snippetsPreventQuickSuggestions',
      'Controls whether an active snippet prevents quick suggestions.',
    ),
  },
  'editor.suggestFontSize': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 1000,
    description: localize(
      'editorOption.editor.suggestFontSize',
      'Font size for the suggest widget. When set to , the value of is used.',
    ),
  },
  'editor.suggestLineHeight': {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 1000,
    description: localize(
      'editorOption.editor.suggestLineHeight',
      'Line height for the suggest widget. When set to , the value of is used. The minimum value is 8.',
    ),
  },
  'editor.suggestOnTriggerCharacters': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.suggestOnTriggerCharacters',
      'Controls whether suggestions should automatically show up when typing trigger characters.',
    ),
  },
  'editor.suggestSelection': {
    type: 'string',
    default: 'first',
    enum: ['first', 'recentlyUsed', 'recentlyUsedByPrefix'],
    description: localize(
      'editorOption.editor.suggestSelection',
      'Controls how suggestions are pre-selected when showing the suggest list.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.suggestSelection.enum.0',
        'Always select the first suggestion.',
      ),
      localize(
        'editorOption.editor.suggestSelection.enum.1',
        'Select recent suggestions unless further typing selects one, e.g. `console.| -> console.log` because `log` has been completed recently.',
      ),
      localize(
        'editorOption.editor.suggestSelection.enum.2',
        'Select suggestions based on previous prefixes that have completed those suggestions, e.g. `co -> console` and `con -> const`.',
      ),
    ],
  },
  'editor.tabCompletion': {
    type: 'string',
    default: 'off',
    enum: ['on', 'off', 'onlySnippets'],
    description: localize('editorOption.editor.tabCompletion', 'Enables tab completions.'),
    enumDescriptions: [
      localize(
        'editorOption.editor.tabCompletion.enum.0',
        'Tab complete will insert the best matching suggestion when pressing tab.',
      ),
      localize('editorOption.editor.tabCompletion.enum.1', 'Disable tab completions.'),
      localize(
        'editorOption.editor.tabCompletion.enum.2',
        "Tab complete snippets when their prefix match. Works best when 'quickSuggestions' aren't enabled.",
      ),
    ],
  },
  'editor.tabFocusMode': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.tabFocusMode',
      'Controls whether the editor receives tabs or defers them to the workbench for navigation.',
    ),
  },
  'editor.trimWhitespaceOnDelete': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.trimWhitespaceOnDelete',
      "Controls whether the editor will also delete the next line's indentation whitespace when deleting a newline.",
    ),
  },
  'editor.unfoldOnClickAfterEndOfLine': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.unfoldOnClickAfterEndOfLine',
      'Controls whether clicking on the empty content after a folded line will unfold the line.',
    ),
  },
  'editor.unusualLineTerminators': {
    type: 'string',
    default: 'prompt',
    enum: ['auto', 'off', 'prompt'],
    description: localize(
      'editorOption.editor.unusualLineTerminators',
      'Remove unusual line terminators that might cause problems.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.unusualLineTerminators.enum.0',
        'Unusual line terminators are automatically removed.',
      ),
      localize(
        'editorOption.editor.unusualLineTerminators.enum.1',
        'Unusual line terminators are ignored.',
      ),
      localize(
        'editorOption.editor.unusualLineTerminators.enum.2',
        'Unusual line terminators prompt to be removed.',
      ),
    ],
  },
  'editor.useTabStops': {
    type: 'boolean',
    default: true,
    description: localize(
      'editorOption.editor.useTabStops',
      'Spaces and tabs are inserted and deleted in alignment with tab stops.',
    ),
  },
  'editor.wordBreak': {
    type: 'string',
    default: 'normal',
    enum: ['normal', 'keepAll'],
    description: localize(
      'editorOption.editor.wordBreak',
      'Controls the word break rules used for Chinese/Japanese/Korean (CJK) text.',
    ),
    enumDescriptions: [
      localize('editorOption.editor.wordBreak.enum.0', 'Use the default line break rule.'),
      localize(
        'editorOption.editor.wordBreak.enum.1',
        'Word breaks should not be used for Chinese/Japanese/Korean (CJK) text. Non-CJK text behavior is the same as for normal.',
      ),
    ],
  },
  'editor.wordSegmenterLocales': {
    type: 'array',
    default: [],
    description: localize(
      'editorOption.editor.wordSegmenterLocales',
      'Locales to be used for word segmentation when doing word related navigations or operations. Specify the BCP 47 language tag of the word you wish to recognize (e.g., ja, zh-CN, zh-Hant-TW, etc.).',
    ),
    items: {
      type: 'string',
    },
    anyOf: [
      {
        type: 'string',
      },
      {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    ],
  },
  'editor.wordSeparators': {
    type: 'string',
    default: '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?',
    description: localize(
      'editorOption.editor.wordSeparators',
      'Characters that will be used as word separators when doing word related navigations or operations.',
    ),
  },
  'editor.wordWrapColumn': {
    type: 'integer',
    default: 80,
    minimum: 1,
    maximum: 1073741824,
    description: localize(
      'editorOption.editor.wordWrapColumn',
      'Controls the wrapping column of the editor when `editor.wordWrap` is `wordWrapColumn` or `bounded`.',
    ),
  },
  'editor.wrapOnEscapedLineFeeds': {
    type: 'boolean',
    default: false,
    description: localize(
      'editorOption.editor.wrapOnEscapedLineFeeds',
      'Controls whether literal `\\n` shall trigger a wordWrap when `editor.wordWrap` is enabled. For example:\n```c\nchar* str="hello\\nworld"\n```\nwill be displayed as\n```c\nchar* str="hello\\n world"\n```',
    ),
  },
  'editor.wrappingIndent': {
    type: 'string',
    default: 'same',
    enum: ['none', 'same', 'indent', 'deepIndent'],
    description: localize(
      'editorOption.editor.wrappingIndent',
      'Controls the indentation of wrapped lines.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.wrappingIndent.enum.0',
        'No indentation. Wrapped lines begin at column 1.',
      ),
      localize(
        'editorOption.editor.wrappingIndent.enum.1',
        'Wrapped lines get the same indentation as the parent.',
      ),
      localize(
        'editorOption.editor.wrappingIndent.enum.2',
        'Wrapped lines get +1 indentation toward the parent.',
      ),
      localize(
        'editorOption.editor.wrappingIndent.enum.3',
        'Wrapped lines get +2 indentation toward the parent.',
      ),
    ],
  },
  'editor.wrappingStrategy': {
    type: 'string',
    default: 'simple',
    enum: ['simple', 'advanced'],
    description: localize(
      'editorOption.editor.wrappingStrategy',
      'Controls the algorithm that computes wrapping points. Note that when in accessibility mode, advanced will be used for the best experience.',
    ),
    enumDescriptions: [
      localize(
        'editorOption.editor.wrappingStrategy.enum.0',
        'Assumes that all characters are of the same width. This is a fast algorithm that works correctly for monospace fonts and certain scripts (like Latin characters) where glyphs are of equal width.',
      ),
      localize(
        'editorOption.editor.wrappingStrategy.enum.1',
        'Delegates wrapping points computation to the browser. This is a slow algorithm, that might cause freezes for large files, but it works correctly in all cases.',
      ),
    ],
  },
}
