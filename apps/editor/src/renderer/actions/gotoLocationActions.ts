/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Project Action2 wrappers for Monaco's symbol-navigation commands (Go to /
 *  Peek Definition, Type Definition, Implementations, References).
 *
 *  Monaco registers these via `registerAction2` into its *internal* platform
 *  registries (not the EditorExtensionsRegistry that `editor.getAction()` reads
 *  from), so they never surface in our command palette or Keyboard Shortcuts
 *  editor on their own. We mirror them as real project commands here — same
 *  pattern as the Find wrappers in searchActions.ts.
 *
 *  Dispatch goes through `editor.trigger()` (the unified entry that falls back
 *  to Monaco's commandService for action2 ids; `editor.getAction()` returns
 *  null for them). We `focus()` first because the underlying action2 resolves
 *  its target via `getFocusedCodeEditor() || getActiveCodeEditor()`, and the
 *  command palette has taken focus away from the editor by run time.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  localize,
  type IAction2Keybinding,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

interface NavCommandDef {
  /** Monaco/VSCode command id, reused verbatim as our Action2 id. */
  readonly id: string
  readonly title: string
  /**
   * Project default keybinding, mirroring Monaco's. A 2-element tuple expresses a
   * chord (e.g. Ctrl+K F12). Omitted when Monaco has no default key.
   */
  readonly keybinding?: string | readonly [string, string]
}

// Command ids / default keys mirror VSCode's goToCommands.js verbatim. Definition,
// Declaration, Type Definition, Implementation and References each get a Go-to +
// Peek pair; Definition additionally has "Open to the Side" (Ctrl+K F12).
const NAVIGATION_COMMANDS: readonly NavCommandDef[] = [
  {
    id: 'editor.action.revealDefinition',
    title: localize('action.revealDefinition.title', 'Go to Definition'),
    keybinding: 'f12',
  },
  {
    id: 'editor.action.revealDefinitionAside',
    title: localize('action.revealDefinitionAside.title', 'Open Definition to the Side'),
    keybinding: ['ctrl+k', 'f12'],
  },
  {
    id: 'editor.action.peekDefinition',
    title: localize('action.peekDefinition.title', 'Peek Definition'),
    keybinding: 'alt+f12',
  },
  {
    id: 'editor.action.revealDeclaration',
    title: localize('action.revealDeclaration.title', 'Go to Declaration'),
  },
  {
    id: 'editor.action.peekDeclaration',
    title: localize('action.peekDeclaration.title', 'Peek Declaration'),
  },
  {
    id: 'editor.action.goToTypeDefinition',
    title: localize('action.goToTypeDefinition.title', 'Go to Type Definition'),
  },
  {
    id: 'editor.action.peekTypeDefinition',
    title: localize('action.peekTypeDefinition.title', 'Peek Type Definition'),
  },
  {
    id: 'editor.action.goToImplementation',
    title: localize('action.goToImplementation.title', 'Go to Implementations'),
    keybinding: 'ctrl+f12',
  },
  {
    id: 'editor.action.peekImplementation',
    title: localize('action.peekImplementation.title', 'Peek Implementations'),
    keybinding: 'ctrl+shift+f12',
  },
  {
    id: 'editor.action.goToReferences',
    title: localize('action.goToReferences.title', 'Go to References'),
    keybinding: 'shift+f12',
  },
  {
    id: 'editor.action.referenceSearch.trigger',
    title: localize('action.peekReferences.title', 'Peek References'),
  },
]

function runMonacoNavAction(accessor: ServicesAccessor, actionId: string): void {
  const groups = accessor.get(IEditorGroupsService)
  const active = groups.activeGroup.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active)
  if (!editor) return
  editor.focus()
  editor.trigger('universe', actionId, {})
}

function createNavAction(def: NavCommandDef): new () => Action2 {
  const options: IAction2Options = {
    id: def.id,
    title: def.title,
    category: localize('command.category.go', 'Go'),
    precondition: 'hasActiveEditor',
    f1: true,
    ...(def.keybinding !== undefined
      ? { keybinding: { primary: def.keybinding } as IAction2Keybinding }
      : {}),
  }
  return class extends Action2 {
    constructor() {
      super(options)
    }
    override run(accessor: ServicesAccessor): void {
      runMonacoNavAction(accessor, def.id)
    }
  }
}

/** Action2 ctors for every navigation command, ready for `registerAction2`. */
export const gotoLocationActions: readonly (new () => Action2)[] =
  NAVIGATION_COMMANDS.map(createNavAction)
