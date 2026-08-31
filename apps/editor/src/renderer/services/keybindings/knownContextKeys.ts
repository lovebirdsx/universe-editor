/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  knownContextKeys — the candidate set for the Keyboard Shortcuts editor's
 *  inline when-expression autocomplete. VSCode sources this from
 *  RawContextKey.all(); we have no central key registry, so the candidates are
 *  the union of three observable sources:
 *    1. every when-clause key referenced by registered keybindings
 *    2. every when-clause key referenced by registered menu items/submenus
 *    3. the context keys statically seeded by the workbench contributions
 *--------------------------------------------------------------------------------------------*/

import {
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  isSubmenuEntry,
  type ContextKeyExpression,
} from '@universe-editor/platform'

export interface IKnownContextKey {
  readonly key: string
  readonly description?: string
}

// MenuId is a const enum (no runtime object to iterate), so enumerate the
// members explicitly. Keep in sync with platform's menuRegistry.ts.
const ALL_MENU_IDS: readonly MenuId[] = [
  MenuId.CommandPalette,
  MenuId.EditorTitle,
  MenuId.EditorContext,
  MenuId.EditorTabContext,
  MenuId.ExplorerContext,
  MenuId.AcpChatContext,
  MenuId.AcpPromptContext,
  MenuId.TitleBar,
  MenuId.StatusBar,
  MenuId.SideBarTitle,
  MenuId.ScmTitle,
  MenuId.ScmResourceStateContext,
  MenuId.ScmResourceGroupContext,
  MenuId.ScmResourceFolderContext,
  MenuId.ScmInputBox,
  MenuId.TimelineItemContext,
  MenuId.ViewTitle,
  MenuId.MenubarFileMenu,
  MenuId.MenubarEditMenu,
  MenuId.MenubarViewMenu,
  MenuId.MenubarHelpMenu,
  MenuId.LayoutControlMenu,
  MenuId.MenubarFileOpenRecentMenu,
]

// Context keys seeded at workbench startup by ContextKeyContribution,
// FocusContextKeyContribution, and the Keyboard Shortcuts editor itself.
// Mirror list — update together with the contributions.
const SEEDED_CONTEXT_KEYS: readonly string[] = [
  // ContextKeyContribution
  'isWindows',
  'isMac',
  'isLinux',
  'isRemoteWorkspace',
  'remoteRevealInOsSupported',
  'activityBarVisible',
  'sideBarVisible',
  'secondarySideBarVisible',
  'panelVisible',
  'activeEditorId',
  'hasActiveEditor',
  'activeEditorLanguageId',
  'activeEditorTypeId',
  'isInDiffEditor',
  'isInMergeEditor',
  'inKeybindings',
  'textCompareEditorVisible',
  'editorLangId',
  'editorReadonly',
  'editorHasDefinitionProvider',
  'editorHasImplementationProvider',
  'editorHasReferenceProvider',
  'editorHasCodeActionsProvider',
  'isInEmbeddedEditor',
  'inReferenceSearchEditor',
  'editorFocus',
  'editorTextFocus',
  'editorColumnSelection',
  'suggestWidgetVisible',
  'findWidgetVisible',
  'inlineSuggestionVisible',
  'inlineEditIsVisible',
  'cursorAtInlineEdit',
  'tabShouldJumpToInlineEdit',
  'tabShouldAcceptInlineEdit',
  'terminalFocus',
  'editorPartMultipleEditorGroups',
  'editorIsOpen',
  'groupEditorsCount',
  'activeEditorGroupIndex',
  'activeEditorGroupEmpty',
  'activeEditorIsFirstInGroup',
  'activeEditorIsLastInGroup',
  'activeEditorIsDirty',
  'activeEditorGroupLocked',
  'workbenchReady',
  'workbenchRestored',
  // Editor group-scoped keys (useEditorGroupScopedContextKey) — per editor group,
  // unlike the root `activeEditorTypeId` which reflects only the active group.
  'activeEditorType',
  // FocusContextKeyContribution
  'focusedPart',
  'focusedView',
  'activityBarFocus',
  'sideBarFocus',
  'secondarySideBarFocus',
  'editorAreaFocus',
  'panelFocus',
  'statusBarFocus',
  // KeybindingsEditor local keys
  'inKeybindingsSearch',
  'keybindingsSearchHasValue',
  'keybindingFocus',
  'whenFocus',
]

function collectExpressionKeys(into: Set<string>, when: ContextKeyExpression | undefined): void {
  if (when === undefined) return
  for (const key of when.keys()) into.add(key)
}

export function collectKnownContextKeys(): readonly IKnownContextKey[] {
  const keys = new Set<string>(SEEDED_CONTEXT_KEYS)

  for (const item of KeybindingsRegistry.getAllKeybindings()) {
    collectExpressionKeys(
      keys,
      typeof item.when === 'string' ? undefined : (item.when as ContextKeyExpression | undefined),
    )
  }

  for (const menuId of ALL_MENU_IDS) {
    for (const entry of MenuRegistry.getMenuItems(menuId)) {
      const when = isSubmenuEntry(entry) ? entry.when : entry.when
      collectExpressionKeys(
        keys,
        typeof when === 'string' ? undefined : (when as ContextKeyExpression | undefined),
      )
    }
  }

  return [...keys].sort((a, b) => a.localeCompare(b)).map((key) => ({ key }))
}
