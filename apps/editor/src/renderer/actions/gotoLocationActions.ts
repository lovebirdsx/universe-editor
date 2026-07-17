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
  IProgressService,
  ProgressLocation,
  localize,
  localize2,
  type IAction2Keybinding,
  type IAction2Options,
  type ILocalizedString,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'

interface NavCommandDef {
  /** Monaco/VSCode command id, reused verbatim as our Action2 id. */
  readonly id: string
  readonly title: ILocalizedString
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
    title: localize2('action.revealDefinition.title', 'Go to Definition'),
    keybinding: 'f12',
  },
  {
    id: 'editor.action.revealDefinitionAside',
    title: localize2('action.revealDefinitionAside.title', 'Open Definition to the Side'),
    keybinding: ['ctrl+k', 'f12'],
  },
  {
    id: 'editor.action.peekDefinition',
    title: localize2('action.peekDefinition.title', 'Peek Definition'),
    keybinding: 'alt+f12',
  },
  {
    id: 'editor.action.revealDeclaration',
    title: localize2('action.revealDeclaration.title', 'Go to Declaration'),
  },
  {
    id: 'editor.action.peekDeclaration',
    title: localize2('action.peekDeclaration.title', 'Peek Declaration'),
  },
  {
    id: 'editor.action.goToTypeDefinition',
    title: localize2('action.goToTypeDefinition.title', 'Go to Type Definition'),
  },
  {
    id: 'editor.action.peekTypeDefinition',
    title: localize2('action.peekTypeDefinition.title', 'Peek Type Definition'),
  },
  {
    id: 'editor.action.goToImplementation',
    title: localize2('action.goToImplementation.title', 'Go to Implementations'),
    keybinding: 'ctrl+f12',
  },
  {
    id: 'editor.action.peekImplementation',
    title: localize2('action.peekImplementation.title', 'Peek Implementations'),
    keybinding: 'ctrl+shift+f12',
  },
  {
    id: 'editor.action.goToReferences',
    title: localize2('action.goToReferences.title', 'Go to References'),
    keybinding: 'shift+f12',
  },
  {
    id: 'editor.action.referenceSearch.trigger',
    title: localize2('action.peekReferences.title', 'Peek References'),
  },
]

function runMonacoNavAction(accessor: ServicesAccessor, actionId: string): void {
  const groups = accessor.get(IEditorGroupsService)
  const active = groups.activeGroup.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active)
  if (!editor) return

  // Snapshot the remaining services synchronously — the async progress task below
  // outlives the accessor (Action2 async-accessor rule), so it can't call get().
  const languageFeatures = accessor.get(ILanguageFeaturesService)
  const progress = accessor.get(IProgressService)

  editor.focus()
  // Dispatch the navigation now: the Monaco action awaits its providers, which in
  // turn block on the language server's `initialize` handshake and resolve once
  // ready — so the jump fires automatically after startup, no user retry needed.
  editor.trigger('universe', actionId, {})

  // If a language server is still starting, the dispatch above is silently
  // blocked. Surface a status-bar spinner (delayed, so a warm server stays
  // invisible) that clears once every server settles.
  if (!languageFeatures.hasStartingLanguageServer()) return

  void progress.withProgress(
    {
      location: ProgressLocation.Window,
      title: localize('lsp.starting', 'Starting language service…'),
      delay: 500,
    },
    () => languageFeatures.whenLanguageServersSettled(),
  )
}

function createNavAction(def: NavCommandDef): new () => Action2 {
  const options: IAction2Options = {
    id: def.id,
    title: def.title,
    category: localize2('command.category.go', 'Go'),
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
