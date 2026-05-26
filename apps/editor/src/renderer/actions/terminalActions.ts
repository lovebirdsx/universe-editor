/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenInTerminalAction — opens the OS external terminal at the workspace root
 *  (falls back to the active file's parent directory when no folder is open).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IEditorGroupsService,
  IHostService,
  IWorkspaceService,
  localize,
  type ExternalTerminalKind,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'

const TERMINAL_KIND_SETTING = 'terminal.external.windowsExec'
const VALID_KINDS: ReadonlySet<ExternalTerminalKind> = new Set(['wt', 'cmd', 'powershell', 'pwsh'])

function parentDirOf(fsPath: string): string | null {
  const lastSlash = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'))
  if (lastSlash <= 0) return null
  return fsPath.slice(0, lastSlash)
}

export class OpenInTerminalAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.openNativeConsole'
  constructor() {
    super({
      id: OpenInTerminalAction.ID,
      title: localize('action.openInTerminal.title', 'Open in External Terminal'),
      category: localize('command.category.terminal', 'Terminal'),
      keybinding: { primary: 'ctrl+shift+c' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const workspace = accessor.get(IWorkspaceService)
    const host = accessor.get(IHostService)
    const config = accessor.get(IConfigurationService)

    let cwd: string | null = workspace.current?.folder.fsPath ?? null
    if (!cwd) {
      const groups = accessor.get(IEditorGroupsService)
      const active = groups.activeGroup.activeEditor
      if (active instanceof FileEditorInput && active.resource.scheme === 'file') {
        cwd = parentDirOf(active.resource.fsPath)
      }
    }
    if (!cwd) return

    const raw = config.get<string>(TERMINAL_KIND_SETTING)
    const kind: ExternalTerminalKind = VALID_KINDS.has(raw as ExternalTerminalKind)
      ? (raw as ExternalTerminalKind)
      : 'pwsh'

    await host.openTerminal(cwd, kind)
  }
}
