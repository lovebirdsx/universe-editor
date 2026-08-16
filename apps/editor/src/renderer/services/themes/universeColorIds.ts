/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Universe Editor 颜色注册表 —— workbench 全部可主题化颜色的单一事实源。
 *
 * 对齐 VSCode 的 colorRegistry 用法：有 VSCode 对应物的 id 一律沿用（第三方
 * VSCode 主题 JSON 可直接着色我们的部件），无对应物的用 dotted camelCase 自定义
 * id（`workbench.*` / `agent.*` / `fileIcon.*` 等命名空间）。
 *
 * 默认值来自迁移前 workbench.css 的 `:root`（dark）与 `:root[data-theme='light']`
 * 两块；`legacy` 字段记录迁移前的 CSS 变量名（不带 `--` 前缀），供 codemod 与审计
 * 对照。新代码只写 `var(--vscode-<id 点转横线>)`。
 */

import {
  registerColor,
  type ColorIdentifier,
  type ColorValue,
  getColorRegistry,
  localize,
} from '@universe-editor/platform'

export interface UniverseColorDefinition {
  readonly id: ColorIdentifier
  readonly dark: ColorValue | null
  readonly light: ColorValue | null
  readonly description: string
  /** 迁移前的 CSS 变量名（不带 `--` 前缀）；无则该 id 是新增注册。 */
  readonly legacy?: string
  /** 归并到同一 id 的其它旧变量名（语义相同、fallback 值近似的幽灵变量）。 */
  readonly legacyAliases?: readonly string[]
  readonly needsTransparency?: boolean
}

function d(
  id: string,
  dark: ColorValue | null,
  light: ColorValue | null,
  description: string,
  ...legacy: string[]
): UniverseColorDefinition {
  const def: UniverseColorDefinition = {
    id,
    dark,
    light,
    description: localize(`color.${id}`, description),
  }
  if (legacy.length === 0) {
    return def
  }
  const [first, ...aliases] = legacy
  return aliases.length > 0
    ? { ...def, legacy: first!, legacyAliases: aliases }
    : { ...def, legacy: first! }
}

export const UNIVERSE_COLOR_DEFINITIONS: readonly UniverseColorDefinition[] = [
  // ---------------------------------------------------------------- Base
  d(
    'workbench.background',
    '#1a1a1c',
    '#f4f4f5',
    'Overall workbench background color.',
    'color-background',
    'color-bg',
  ),
  d(
    'foreground',
    '#c8c8c8',
    '#24262b',
    'Overall foreground color.',
    'color-foreground',
    'color-fg',
  ),
  d(
    'workbench.foregroundBright',
    '#ffffff',
    '#111318',
    'Bright foreground color for emphasized text.',
    'color-foreground-bright',
  ),
  d(
    'descriptionForeground',
    '#8a8a92',
    '#666b76',
    'Foreground color for description text providing additional information, for example for a label.',
    'color-foreground-muted',
    'color-description-fg',
    'color-description',
    'color-sidebar-fg-dim',
    'color-fg-muted',
  ),
  d(
    'workbench.border',
    '#0f0f11',
    '#d6d8de',
    'Border color separating the main workbench areas.',
    'color-border',
  ),
  d(
    'focusBorder',
    '#0070e0',
    '#0067c0',
    'Overall border color for focused elements.',
    'color-focus-border',
  ),
  d(
    'workbench.accent',
    '#0070e0',
    '#0067c0',
    'Accent color for primary actions and active indicators.',
    'color-accent',
  ),
  d(
    'workbench.accentHover',
    '#0a84ff',
    '#0a84ff',
    'Accent color when hovering over primary actions.',
    'color-accent-hover',
  ),
  d(
    'list.highlightForeground',
    '#2aaaff',
    '#0066bf',
    'Foreground color of the matched text when searching.',
    'color-match-highlight-fg',
  ),
  d(
    'workbench.surface',
    '#242427',
    '#ffffff',
    'Background color for raised surfaces such as cards and popovers.',
    'color-surface',
  ),
  d(
    'agent.claudeAccent',
    '#d97757',
    '#d97757',
    'Accent color for Claude agent branding elements.',
    'color-agent-claude',
  ),

  // ---------------------------------------------------------------- Title bar
  d(
    'titleBar.activeBackground',
    '#0f0f11',
    '#eceef2',
    'Title bar background when the window is active.',
    'color-titlebar',
  ),

  // ---------------------------------------------------------------- Activity bar
  d(
    'activityBar.background',
    '#0f0f11',
    '#e3e6eb',
    'Activity bar background color.',
    'color-activitybar-bg',
  ),
  d(
    'activityBar.inactiveForeground',
    '#8a8a92',
    '#5e6572',
    'Activity bar item foreground color when it is inactive.',
    'color-activitybar-fg',
  ),
  d(
    'activityBar.hoverForeground',
    '#c8c8c8',
    '#20242b',
    'Activity bar item foreground color when hovering.',
    'color-activitybar-fg-hover',
  ),
  d(
    'activityBar.foreground',
    '#ffffff',
    '#111318',
    'Activity bar item foreground color when it is active.',
    'color-activitybar-fg-active',
  ),
  d(
    'activityBar.hoverBackground',
    'rgba(255, 255, 255, 0.06)',
    'rgba(0, 0, 0, 0.06)',
    'Activity bar item background color when hovering.',
    'color-activitybar-item-hover',
  ),
  d(
    'activityBar.activeBorder',
    '#0070e0',
    '#0067c0',
    'Activity bar border color for the active item.',
    'color-activitybar-active-border',
  ),
  d(
    'activityBarBadge.background',
    '#0070e0',
    '#0067c0',
    'Activity notification badge background color.',
  ),
  d(
    'activityBarBadge.foreground',
    '#ffffff',
    '#ffffff',
    'Activity notification badge foreground color.',
  ),

  // ---------------------------------------------------------------- Side bar
  d('sideBar.background', '#242427', '#ffffff', 'Side bar background color.', 'color-sidebar-bg'),
  d('sideBar.foreground', '#c8c8c8', '#24262b', 'Side bar foreground color.', 'color-sidebar-fg'),
  d(
    'sideBarSectionHeader.background',
    '#1a1a1c',
    '#eef0f3',
    'Side bar section header background color.',
    'color-sidebar-section-header-bg',
  ),
  d(
    'sideBarSectionHeader.foreground',
    '#b5b5b8',
    '#424753',
    'Side bar section header foreground color.',
    'color-sidebar-section-header-fg',
  ),
  d(
    'sideBarSectionHeader.hoverBackground',
    '#2f2f35',
    '#e2e5ea',
    'Side bar section header background color when hovering.',
    'color-sidebar-section-header-hover',
  ),
  d(
    'sideBar.border',
    'rgba(255, 255, 255, 0.08)',
    'rgba(0, 0, 0, 0.1)',
    'Side bar border color on the side separating the editor.',
    'color-sidebar-border',
  ),

  // ---------------------------------------------------------------- File icons
  d(
    'fileIcon.defaultForeground',
    '#8a8a92',
    '#5e6572',
    'Default file icon color.',
    'color-file-icon-default',
  ),
  d(
    'fileIcon.folderForeground',
    '#c8c8c8',
    '#4a5568',
    'Folder icon color.',
    'color-file-icon-folder',
  ),
  d(
    'fileIcon.specialFolderForeground',
    '#90adc9',
    '#4876a8',
    'Special folder icon color.',
    'color-file-icon-folder-special',
  ),
  d(
    'fileIcon.codeForeground',
    '#7eaed9',
    '#2f78b7',
    'Code file icon color.',
    'color-file-icon-code',
  ),
  d(
    'fileIcon.configForeground',
    '#c3ae79',
    '#8b6f1f',
    'Configuration file icon color.',
    'color-file-icon-config',
  ),
  d(
    'fileIcon.markdownForeground',
    '#7fb395',
    '#28724f',
    'Markdown file icon color.',
    'color-file-icon-markdown',
  ),
  d(
    'fileIcon.specialForeground',
    '#9ab4cf',
    '#416f9f',
    'Special file icon color.',
    'color-file-icon-special',
  ),

  // ---------------------------------------------------------------- Editor
  d('editor.background', '#1a1a1c', '#ffffff', 'Editor background color.', 'color-editor-bg'),
  d(
    'editor.foreground',
    '#c8c8c8',
    '#20242b',
    'Editor default foreground color.',
    'color-editor-fg',
  ),
  d(
    'editor.mutedForeground',
    '#7a7a80',
    '#6a707b',
    'Muted foreground color in the editor area.',
    'color-editor-fg-muted',
  ),
  d(
    'editor.blameForeground',
    'editor.mutedForeground',
    'editor.mutedForeground',
    'Foreground color of the inline git blame annotation.',
    'git-blame-decoration-fg',
  ),
  d(
    'editorGroup.border',
    'rgba(255, 255, 255, 0.1)',
    'rgba(0, 0, 0, 0.1)',
    'Border color of editor areas and editor-internal widgets.',
    'color-editor-border',
  ),
  d(
    'editorWidget.background',
    '#252526',
    '#f3f3f3',
    'Background color of editor widgets such as inline threads.',
    'color-editor-widget-bg',
  ),
  d(
    'editor.findMatchBackground',
    'rgba(234, 179, 8, 0.85)',
    'rgba(234, 179, 8, 0.85)',
    'Background color of the current search match.',
    'color-find-match-current-bg',
  ),
  d(
    'editor.findMatchForeground',
    '#1e1e1e',
    '#1e1e1e',
    'Foreground color of the current search match.',
    'color-find-match-current-fg',
  ),
  d(
    'breadcrumb.foreground',
    '#a0a0a0',
    '#666b76',
    'Foreground color of breadcrumb items.',
    'color-breadcrumb-fg',
  ),
  d('editor.lineHighlightBackground', null, null, 'Background color of the editor line highlight.'),
  d('editor.lineHighlightBorder', null, null, 'Border color of the editor line highlight.'),
  d(
    'editor.findMatchHighlightBackground',
    'rgba(229, 192, 123, 0.35)',
    'rgba(234, 134, 0, 0.28)',
    'Background color of search matches in files and views.',
    'color-search-match-bg',
    'color-find-match-bg',
  ),
  d(
    'editorCodeLens.foreground',
    'rgba(140, 140, 140, 0.5)',
    'rgba(140, 140, 140, 0.5)',
    'Foreground color of editor CodeLens and inline action separators.',
  ),
  d(
    'textLink.foreground',
    '#4daafc',
    '#006ab1',
    'Foreground color for links in text.',
    'color-text-link-foreground',
    'color-textlink',
    'color-fg-accent',
  ),

  // ---------------------------------------------------------------- Tabs
  d(
    'editorGroupHeader.tabsBackground',
    '#0f0f11',
    '#eceef2',
    'Background color of the editor group title header.',
    'color-tab-bar-bg',
  ),
  d(
    'tab.activeBackground',
    '#1a1a1c',
    '#ffffff',
    'Active editor tab background color.',
    'color-tab-active-bg',
  ),
  d(
    'tab.activeForeground',
    '#ffffff',
    '#111318',
    'Active editor tab foreground color.',
    'color-tab-active-fg',
  ),
  d(
    'tab.activeBorderTop',
    '#0070e0',
    '#0067c0',
    'Border on top of the active editor tab.',
    'color-tab-active-border',
  ),
  d(
    'tab.inactiveBackground',
    '#0f0f11',
    '#eceef2',
    'Inactive editor tab background color.',
    'color-tab-inactive-bg',
  ),
  d(
    'tab.inactiveForeground',
    '#8a8a92',
    '#5e6572',
    'Inactive editor tab foreground color.',
    'color-tab-inactive-fg',
  ),
  d(
    'tab.hoverForeground',
    '#c8c8c8',
    '#20242b',
    'Editor tab foreground color when hovering.',
    'color-tab-inactive-fg-hover',
  ),
  d(
    'tab.hoverBackground',
    '#1f1f22',
    '#e1e4ea',
    'Editor tab background color when hovering.',
    'color-tab-hover-bg',
  ),
  d(
    'tab.modifiedBorder',
    '#e0f443',
    '#9a7200',
    'Border color marking dirty (modified) editor tabs.',
    'color-editor-modified-border',
  ),
  d(
    'tab.unfocusedActiveForeground',
    '#999999',
    '#999999',
    'Active tab foreground color in an unfocused editor group.',
    'color-tab-unfocused-active-fg',
  ),
  d(
    'tab.unfocusedActiveBorderTop',
    '#555555',
    '#555555',
    'Border on top of the active tab in an unfocused editor group.',
    'color-tab-unfocused-active-border',
  ),

  // ---------------------------------------------------------------- Status bar
  d(
    'statusBar.background',
    '#0f0f11',
    '#0067c0',
    'Status bar background color.',
    'color-statusbar-bg',
  ),
  d(
    'statusBar.foreground',
    '#c8c8c8',
    '#ffffff',
    'Status bar foreground color.',
    'color-statusbar-fg',
  ),
  d(
    'statusBarItem.prominentForeground',
    '#5fa8ff',
    '#ffe79a',
    'Status bar prominent items foreground color.',
    'color-statusbar-prominent-fg',
  ),
  d(
    'statusBarItem.remoteBackground',
    '#007acc',
    '#007acc',
    'Background color for the remote indicator on the status bar.',
  ),
  d(
    'statusBarItem.remoteForeground',
    '#ffffff',
    '#ffffff',
    'Foreground color for the remote indicator on the status bar.',
  ),
  d(
    'statusBarItem.errorBackground',
    '#b01011',
    '#b01011',
    'Status bar item background color when the item has an error.',
  ),
  d(
    'statusBarItem.errorForeground',
    '#ffffff',
    '#ffffff',
    'Status bar item foreground color when the item has an error.',
  ),

  // ---------------------------------------------------------------- Panel
  d('panel.background', '#1a1a1c', '#ffffff', 'Panel background color.', 'color-panel-bg'),
  d(
    'panel.border',
    '#80808059',
    '#80808059',
    'Panel border color separating the panel from the editor.',
  ),
  d(
    'panel.tabBarBackground',
    '#0f0f11',
    '#eceef2',
    'Panel tab bar background color.',
    'color-panel-tab-bar-bg',
  ),
  d(
    'panel.toolbarBackground',
    '#242427',
    '#ffffff',
    'Panel toolbar background color.',
    'color-panel-toolbar-bg',
  ),

  // ---------------------------------------------------------------- Quick input / list / input
  d(
    'quickInput.background',
    '#242427',
    '#ffffff',
    'Quick input background color.',
    'color-quick-input-bg',
  ),
  d(
    'quickInput.border',
    '#2f2f35',
    '#c7cbd3',
    'Quick input border color.',
    'color-quick-input-border',
  ),
  d(
    'list.hoverBackground',
    '#2f2f35',
    '#e8f2ff',
    'List background color when hovering over items.',
    'color-list-hover-bg',
  ),
  d(
    'list.focusOutline',
    '#0070e0',
    '#0067c0',
    'List outline color of the focused item.',
    'color-list-focus-outline',
  ),
  d(
    'list.focusBackground',
    'rgba(0, 127, 212, 0.28)',
    'rgba(0, 127, 212, 0.28)',
    'List background color of the focused item.',
    'color-list-focus-bg',
  ),
  d(
    'list.activeSelectionBackground',
    '#094771',
    '#cfe6ff',
    'List background color of the selected item when the list is active.',
    'color-list-active-bg',
    'color-list-active-selection-bg',
  ),
  d(
    'list.activeSelectionBar',
    '#007acc',
    '#007acc',
    'Indicator bar color of the selected item when the list is active.',
    'color-list-active-bar',
  ),
  d(
    'list.activeSelectionForeground',
    '#ffffff',
    '#20242b',
    'List foreground color of the selected item when the list is active.',
    'color-list-active-fg',
  ),
  d(
    'list.inactiveSelectionBackground',
    'rgba(58, 61, 65, 0.6)',
    'rgba(0, 0, 0, 0.06)',
    'List background color of the selected item when the list is inactive.',
    'color-list-inactive-bg',
    'color-list-inactive-selection-bg',
  ),
  d(
    'list.dropBackground',
    'rgba(0, 112, 224, 0.24)',
    'rgba(0, 112, 224, 0.24)',
    'List background color when dragging items over a drop target.',
    'color-list-drop-bg',
  ),
  d('input.background', '#3c3c3c', '#ffffff', 'Input box background color.', 'color-input-bg'),
  d('input.foreground', '#d4d4d4', '#20242b', 'Input box foreground color.', 'color-input-fg'),
  d('input.border', '#555555', '#c7cbd3', 'Input box border color.', 'color-input-border'),
  d(
    'input.placeholderForeground',
    '#5a5a5e',
    '#7b818c',
    'Input box placeholder foreground color.',
    'color-input-placeholder-fg',
  ),
  d(
    'inputOption.activeBackground',
    'rgba(14, 99, 156, 0.5)',
    'rgba(14, 99, 156, 0.5)',
    'Background color of activated input option toggles (e.g. match case).',
    'color-toggle-active-bg',
  ),
  d(
    'inputValidation.errorBorder',
    '#be1100',
    '#be1100',
    'Input validation border color for error severity.',
    'color-error-border',
  ),

  // ---------------------------------------------------------------- Symbol icons
  d(
    'symbolIcon.defaultForeground',
    '#8a8a92',
    '#5e6572',
    'Default foreground color of symbol icons in the outline and breadcrumbs.',
    'color-symbol-default',
  ),
  d(
    'symbolIcon.functionForeground',
    '#b180d7',
    '#652d90',
    'Foreground color of callable symbol icons (functions and methods).',
    'color-symbol-callable',
  ),
  d(
    'symbolIcon.variableForeground',
    '#75beff',
    '#0070c1',
    'Foreground color of data symbol icons (variables and fields).',
    'color-symbol-variable',
  ),
  d(
    'symbolIcon.classForeground',
    '#ee9d28',
    '#a5760b',
    'Foreground color of type symbol icons (classes and interfaces).',
    'color-symbol-type',
  ),

  // ---------------------------------------------------------------- Tooltip / sash / dropdown / badge / toolbar
  d('tooltip.background', '#2f2f35', '#ffffff', 'Tooltip background color.', 'color-tooltip-bg'),
  d('tooltip.foreground', '#c8c8c8', '#24262b', 'Tooltip foreground color.', 'color-tooltip-fg'),
  d(
    'sash.hoverBorder',
    '#0070e0',
    '#0067c0',
    'Border color of sashes when hovering.',
    'color-sash-active',
  ),
  d('dropdown.background', '#2f2f35', '#ffffff', 'Dropdown background color.', 'color-dropdown-bg'),
  d('dropdown.border', '#0f0f11', '#c7cbd3', 'Dropdown border color.', 'color-dropdown-border'),
  d('badge.background', '#2f2f35', '#dceeff', 'Badge background color.', 'color-badge-bg'),
  d('badge.foreground', '#c8c8c8', '#15395b', 'Badge foreground color.', 'color-badge-fg'),
  d(
    'badge.progressBackground',
    '#4fa6e2',
    '#0067c0',
    'Background color of progress badges.',
    'color-badge-progress',
  ),
  d(
    'badge.successBackground',
    '#2c7d32',
    '#1a7f37',
    'Background color of success badges.',
    'color-badge-success',
  ),
  d(
    'badge.warningBackground',
    '#d7ba7d',
    '#9a6700',
    'Background color of warning badges.',
    'color-badge-warning',
  ),
  d(
    'badge.errorBackground',
    '#f14c4c',
    '#d1242f',
    'Background color of error badges.',
    'color-badge-error',
  ),
  d(
    'toolbar.hoverBackground',
    'rgba(255, 255, 255, 0.06)',
    'rgba(0, 0, 0, 0.06)',
    'Toolbar action background color when hovering.',
    'color-toolbar-hover-bg',
    'color-toolbar-btn-hover-bg',
  ),

  // ---------------------------------------------------------------- Buttons
  d('button.background', '#0e639c', '#0067c0', 'Button background color.', 'color-button-bg'),
  d(
    'button.foreground',
    '#ffffff',
    '#ffffff',
    'Button foreground color.',
    'color-button-fg',
    'color-accent-fg',
  ),
  d(
    'button.hoverBackground',
    '#1177bb',
    '#0e5aa6',
    'Button background color when hovering.',
    'color-button-hover-bg',
  ),
  d(
    'button.secondaryBackground',
    '#3a3d41',
    '#e8e9ec',
    'Secondary button background color.',
    'color-button-secondary-bg',
  ),
  d(
    'button.secondaryForeground',
    '#cccccc',
    '#24262b',
    'Secondary button foreground color.',
    'color-button-secondary-fg',
  ),
  d(
    'button.secondaryBorder',
    '#3a3d41',
    '#c7cbd3',
    'Secondary button border color.',
    'color-button-secondary-border',
  ),
  d(
    'button.secondaryHoverBackground',
    '#45494e',
    '#dde0e5',
    'Secondary button background color when hovering.',
    'color-button-secondary-hover-bg',
  ),

  // ---------------------------------------------------------------- Menu
  d(
    'menu.background',
    '#252526',
    '#ffffff',
    'Context menu background color.',
    'workbench-menu-bg',
    'color-menu-bg',
  ),
  d(
    'menu.border',
    '#454545',
    '#c7cbd3',
    'Context menu border color.',
    'workbench-menu-border',
    'color-menu-border',
  ),
  d(
    'menu.foreground',
    '#cccccc',
    '#24262b',
    'Context menu item foreground color.',
    'workbench-menu-fg',
    'color-menu-fg',
  ),
  d(
    'menu.selectionBackground',
    '#094771',
    '#e8f2ff',
    'Context menu selected item background color.',
    'workbench-menu-hover-bg',
    'color-menu-selection-bg',
  ),
  d(
    'menu.selectionForeground',
    '#ffffff',
    '#24262b',
    'Context menu selected item foreground color.',
    'color-menu-selection-fg',
  ),
  d(
    'menu.disabledForeground',
    '#656565',
    '#656565',
    'Context menu disabled item foreground color.',
    'workbench-menu-disabled-fg',
  ),
  d(
    'menu.separatorBackground',
    '#3c3c3c',
    '#d6d8de',
    'Context menu separator color.',
    'workbench-menu-separator',
  ),

  // ---------------------------------------------------------------- Settings editor
  d(
    'settings.modifiedItemIndicator',
    '#0c7d9d',
    '#0c7d9d',
    'Left-edge indicator of a setting whose value differs from the default.',
  ),

  // ---------------------------------------------------------------- Agent session (chat)
  d(
    'agent.messageBackground',
    '#2a2a2a',
    '#ffffff',
    'Chat message background color.',
    'color-message-bg',
  ),
  d(
    'agent.messageForeground',
    '#dddddd',
    '#20242b',
    'Chat message foreground color.',
    'color-message-fg',
  ),
  d(
    'agent.messageRoleForeground',
    '#999999',
    '#6a707b',
    'Chat message role label foreground color.',
    'color-message-role-fg',
  ),
  d(
    'agent.userMessageBackground',
    '#2a3550',
    '#dceeff',
    'User chat message background color.',
    'color-message-user-bg',
  ),
  d(
    'agent.thoughtBackground',
    '#2a2a35',
    '#eef0f7',
    'Agent thought block background color.',
    'color-message-thought-bg',
  ),
  d(
    'agent.thoughtAccent',
    '#7a7aa3',
    '#7a6fb0',
    'Agent thought block accent color.',
    'color-message-thought-accent',
  ),
  d(
    'textCodeBlock.background',
    '#1a1a1a',
    '#f3f3f3',
    'Background color of code blocks in text.',
    'color-code-block-bg',
  ),
  d(
    'textInlineCode.background',
    '#2a2a2e',
    '#f0ede8',
    'Background color of inline code in text.',
    'color-inline-code-bg',
  ),
  d(
    'textInlineCode.foreground',
    '#e0a878',
    '#b35a1f',
    'Foreground color of inline code in text.',
    'color-inline-code-fg',
  ),
  d(
    'agent.resourceLinkBackground',
    '#2d2d2d',
    '#eceef2',
    'Background color of resource reference pills in the prompt input.',
    'color-resource-link-bg',
  ),
  d(
    'agent.commandBadgeBackground',
    '#232333',
    '#eef0f7',
    'Background color of command badges in the prompt input.',
    'color-command-badge-bg',
  ),
  d(
    'agent.questionInputBackground',
    '#1e1e1e',
    '#ffffff',
    'Background color of the question input field.',
    'color-question-input-bg',
  ),
  d(
    'agent.sendHoverForeground',
    '#6fbaf5',
    '#0e5aa6',
    'Send button foreground color when hovering.',
    'color-send-hover-color',
  ),
  d(
    'agent.sendTrackBackground',
    'rgba(79, 166, 226, 0.36)',
    'rgba(0, 103, 192, 0.3)',
    'Send button track background color.',
    'color-send-track-color',
  ),
  d(
    'agent.sendHoverBackground',
    'rgba(79, 166, 226, 0.12)',
    'rgba(0, 103, 192, 0.1)',
    'Send button background color when hovering.',
    'color-send-hover-bg',
  ),
  d(
    'agent.sendIconRing',
    'rgba(255, 255, 255, 0.08)',
    'rgba(0, 0, 0, 0.1)',
    'Send button icon ring color.',
    'color-send-icon-ring',
  ),

  // ---------------------------------------------------------------- Feedback
  d(
    'errorForeground',
    '#f48771',
    '#d1242f',
    'Overall foreground color for error messages.',
    'color-error-fg',
    'color-fg-error',
  ),
  d(
    'error.background',
    'rgba(240, 80, 80, 0.18)',
    'rgba(240, 80, 80, 0.18)',
    'Background color for error blocks.',
    'color-error-bg',
  ),
  d(
    'success.foreground',
    '#89d185',
    '#1a7f37',
    'Foreground color for success messages.',
    'color-success-fg',
  ),
  d(
    'danger.background',
    '#a1260d',
    '#c4351a',
    'Background color for dangerous actions.',
    'color-danger-bg',
  ),
  d(
    'warning.foreground',
    '#d7ba7d',
    '#9a6700',
    'Foreground color for warning messages.',
    'color-warning-fg',
  ),
  d(
    'warning.background',
    'rgba(229, 192, 123, 0.12)',
    'rgba(154, 103, 0, 0.12)',
    'Background color for warning blocks.',
    'color-warning-bg',
  ),
  d(
    'warning.border',
    'rgba(229, 192, 123, 0.3)',
    'rgba(154, 103, 0, 0.35)',
    'Border color for warning blocks.',
    'color-warning-border',
  ),
  d(
    'notifications.infoBackground',
    'rgba(56, 128, 214, 0.15)',
    'rgba(56, 128, 214, 0.15)',
    'Background color of informational notification blocks.',
    'color-notification-info-bg',
  ),
  d(
    'notificationsErrorIcon.foreground',
    '#f44747',
    '#e51400',
    'Foreground color of the error notification icon.',
  ),
  d(
    'notificationsWarningIcon.foreground',
    '#cca700',
    '#cca700',
    'Foreground color of the warning notification icon.',
    'color-notifications-warning-icon',
  ),
  d(
    'notificationsInfoIcon.foreground',
    '#3794ff',
    '#1a85ff',
    'Foreground color of the info notification icon.',
  ),
  d(
    'progressBar.background',
    '#0e70c0',
    '#0e70c0',
    'Foreground color of progress bars.',
    'color-progress-bar',
  ),
  d(
    'progressBar.trackBackground',
    'rgba(255, 255, 255, 0.12)',
    'rgba(0, 0, 0, 0.12)',
    'Track (background) color of progress bars.',
    'color-progress-track',
  ),

  // ---------------------------------------------------------------- Diff
  d(
    'diffEditor.insertedTextBackground',
    'rgba(46, 160, 67, 0.18)',
    'rgba(26, 127, 55, 0.14)',
    'Background color of inserted text in diffs.',
    'color-diff-add-bg',
  ),
  d(
    'diffEditor.removedTextBackground',
    'rgba(248, 81, 73, 0.18)',
    'rgba(209, 36, 47, 0.12)',
    'Background color of removed text in diffs.',
    'color-diff-del-bg',
  ),
  d(
    'diffEditor.insertedLineBackground',
    'rgba(70, 149, 74, 0.4)',
    'rgba(70, 149, 74, 0.4)',
    'Background color of inserted lines in diff views.',
    'color-diff-inserted-bg',
  ),
  d(
    'diffEditor.removedLineBackground',
    'rgba(229, 83, 75, 0.28)',
    'rgba(229, 83, 75, 0.28)',
    'Background color of removed lines in diff views.',
    'color-diff-removed-bg',
  ),
  d(
    'diff.insertedForeground',
    '#b5e0bd',
    '#1a7f37',
    'Foreground color marking inserted content in diff views.',
    'color-diff-add-fg',
  ),
  d(
    'diff.removedForeground',
    '#f1b0ab',
    '#b3232b',
    'Foreground color marking removed content in diff views.',
    'color-diff-del-fg',
  ),
  d(
    'editorGutter.addedBackground',
    '#2ea043',
    '#2ea043',
    'Editor gutter background color for added lines.',
  ),
  d(
    'editorGutter.modifiedBackground',
    '#0c7d9d',
    '#0c7d9d',
    'Editor gutter background color for modified lines.',
  ),
  d(
    'editorGutter.deletedBackground',
    '#c74e39',
    '#c74e39',
    'Editor gutter background color for deleted lines.',
  ),
  d(
    'gitDecoration.addedResourceForeground',
    '#73c991',
    '#587c0c',
    'Foreground color for added git resources.',
    'color-scm-added',
  ),
  d(
    'gitDecoration.modifiedResourceForeground',
    '#e2c08d',
    '#895503',
    'Foreground color for modified git resources.',
    'color-scm-modified',
  ),
  d(
    'gitDecoration.conflictingResourceForeground',
    '#e2c08d',
    '#ad0707',
    'Foreground color for conflicting git resources.',
    'color-scm-conflict',
  ),
  d(
    'gitDecoration.deletedResourceForeground',
    '#c74e39',
    '#ad0707',
    'Foreground color for deleted git resources.',
  ),
  d(
    'gitDecoration.renamedResourceForeground',
    '#73c991',
    '#007100',
    'Foreground color for renamed or copied git resources.',
  ),

  // ---------------------------------------------------------------- Merge conflicts
  d(
    'merge.currentContentBackground',
    'rgba(64, 200, 64, 0.16)',
    'rgba(64, 200, 64, 0.16)',
    'Current (ours) content background color in merge conflicts.',
  ),
  d(
    'merge.incomingContentBackground',
    'rgba(64, 140, 255, 0.16)',
    'rgba(64, 140, 255, 0.16)',
    'Incoming (theirs) content background color in merge conflicts.',
  ),
  d(
    'merge.commonContentBackground',
    'rgba(140, 140, 140, 0.16)',
    'rgba(140, 140, 140, 0.16)',
    'Common base content background color in merge conflicts.',
  ),
  d(
    'merge.headerBackground',
    'rgba(128, 128, 128, 0.28)',
    'rgba(128, 128, 128, 0.28)',
    'Marker line background color in merge conflicts.',
  ),

  // ---------------------------------------------------------------- Dialog / shadow / scrollbar
  d('dialog.background', '#252526', '#ffffff', 'Dialog background color.', 'color-dialog-bg'),
  d('dialog.foreground', '#cccccc', '#24262b', 'Dialog foreground color.', 'color-dialog-fg'),
  d('dialog.border', '#454545', '#c7cbd3', 'Dialog border color.', 'color-dialog-border'),
  d(
    'dialog.detailForeground',
    '#aaaaaa',
    '#666b76',
    'Dialog detail text foreground color.',
    'color-dialog-detail-fg',
  ),
  d(
    'widget.shadow',
    'rgba(0, 0, 0, 0.5)',
    'rgba(0, 0, 0, 0.18)',
    'Shadow color of widgets such as popovers.',
    'color-shadow-popover',
  ),
  d(
    'card.shadow',
    'rgba(0, 0, 0, 0.25)',
    'rgba(0, 0, 0, 0.1)',
    'Shadow color of cards.',
    'color-shadow-card',
  ),
  d(
    'workbench.scrollbarThumbBackground',
    'rgba(255, 255, 255, 0.16)',
    'rgba(0, 0, 0, 0.2)',
    'Scrollbar thumb background color.',
  ),
  d(
    'workbench.scrollbarThumbHoverBackground',
    'rgba(255, 255, 255, 0.28)',
    'rgba(0, 0, 0, 0.35)',
    'Scrollbar thumb background color when hovering.',
  ),
  d(
    'workbench.hoverBackground',
    'rgba(255, 255, 255, 0.08)',
    'rgba(0, 0, 0, 0.06)',
    'Generic hover background color.',
    'color-hover',
  ),
  d(
    'workbench.borderSubtle',
    'rgba(255, 255, 255, 0.06)',
    'rgba(0, 0, 0, 0.06)',
    'Subtle border color.',
    'color-border-subtle',
  ),
  d(
    'workbench.accentSoftBackground',
    'rgba(0, 127, 212, 0.25)',
    'rgba(0, 103, 192, 0.14)',
    'Soft accent background color.',
    'color-accent-soft-bg',
  ),

  // ---------------------------------------------------------------- Terminal
  d('terminal.background', '#1f1f1f', '#f3f3f3', 'Terminal background color.', 'color-terminal-bg'),
  d('terminal.foreground', '#cccccc', '#333333', 'Terminal foreground color.'),
  d('terminalCursor.foreground', '#cccccc', '#333333', 'Terminal cursor foreground color.'),
  d(
    'terminalCursor.background',
    null,
    null,
    'Terminal cursor background color (opaque block behind the cursor).',
  ),
  d(
    'terminal.selectionBackground',
    'rgba(255, 255, 255, 0.18)',
    '#add6ff',
    'Terminal selection background color.',
  ),
  d('terminal.ansiBlack', '#3b3b3b', '#1e1e1e', 'ANSI black in the terminal.'),
  d('terminal.ansiRed', '#cd3131', '#cd3131', 'ANSI red in the terminal.'),
  d('terminal.ansiGreen', '#0dbc79', '#14792f', 'ANSI green in the terminal.'),
  d('terminal.ansiYellow', '#e5e510', '#b08500', 'ANSI yellow in the terminal.'),
  d('terminal.ansiBlue', '#2472c8', '#0451a5', 'ANSI blue in the terminal.'),
  d('terminal.ansiMagenta', '#bc3fbc', '#bc05bc', 'ANSI magenta in the terminal.'),
  d('terminal.ansiCyan', '#11a8cd', '#0598bc', 'ANSI cyan in the terminal.'),
  d('terminal.ansiWhite', '#e5e5e5', '#555555', 'ANSI white in the terminal.'),
  d('terminal.ansiBrightBlack', '#666666', '#767676', 'ANSI bright black in the terminal.'),
  d('terminal.ansiBrightRed', '#f14c4c', '#cd3131', 'ANSI bright red in the terminal.'),
  d('terminal.ansiBrightGreen', '#23d18b', '#14792f', 'ANSI bright green in the terminal.'),
  d('terminal.ansiBrightYellow', '#f5f543', '#b08500', 'ANSI bright yellow in the terminal.'),
  d('terminal.ansiBrightBlue', '#3b8eea', '#0451a5', 'ANSI bright blue in the terminal.'),
  d('terminal.ansiBrightMagenta', '#d670d6', '#bc05bc', 'ANSI bright magenta in the terminal.'),
  d('terminal.ansiBrightCyan', '#29b8db', '#0598bc', 'ANSI bright cyan in the terminal.'),
  d('terminal.ansiBrightWhite', '#ffffff', '#1e1e1e', 'ANSI bright white in the terminal.'),
]

/** 迁移前的 CSS 变量名（不带 `--` 前缀）→ 颜色 id。 */
export const LEGACY_CSS_VARIABLE_IDS: ReadonlyMap<string, ColorIdentifier> = new Map(
  UNIVERSE_COLOR_DEFINITIONS.flatMap((def) =>
    [def.legacy, ...(def.legacyAliases ?? [])]
      .filter((name): name is string => name !== undefined)
      .map((name) => [name, def.id] as const),
  ),
)

let didRegister = false

/** 把全部 Universe 颜色注册进全局 colorRegistry（幂等）。 */
export function registerUniverseColorIds(): void {
  if (didRegister) {
    return
  }
  didRegister = true
  for (const def of UNIVERSE_COLOR_DEFINITIONS) {
    registerColor(
      def.id,
      { dark: def.dark, light: def.light, hcDark: def.dark, hcLight: def.light },
      def.description,
      def.needsTransparency ?? false,
    )
  }
}

/** 测试辅助：判断一个颜色 id 是否已注册。 */
export function isRegisteredColorId(id: string): boolean {
  return getColorRegistry()
    .getColors()
    .some((c) => c.id === id)
}
