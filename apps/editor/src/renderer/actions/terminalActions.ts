/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenInTerminalAction — opens the OS external terminal at the workspace root
 *  (falls back to the active file's parent directory when no folder is open).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IEditorGroupsService,
  IEditorService,
  IHostService,
  IInstantiationService,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  PartId,
  ViewContainerLocation,
  localize,
  type ExternalTerminalKind,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { TerminalEditorInput } from '../services/editor/TerminalEditorInput.js'
import { ITerminalManagerService } from '../services/terminal/TerminalManagerService.js'

const TERMINAL_CONTAINER_ID = 'workbench.view.terminal'

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

/**
 * Toggle the integrated terminal panel:
 *   - hidden, or showing another panel container → show panel + switch to Terminal
 *   - already showing Terminal → hide the panel
 */
export class ToggleTerminalAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.toggleTerminal'
  constructor() {
    super({
      id: ToggleTerminalAction.ID,
      title: localize('action.toggleTerminal.title', 'Toggle Terminal'),
      category: localize('command.category.terminal', 'Terminal'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    const visible = layout.getVisible(PartId.Panel)
    const activeId = views.getActiveViewContainerId(ViewContainerLocation.Panel)
    if (visible && activeId === TERMINAL_CONTAINER_ID) {
      layout.toggleVisible(PartId.Panel)
      return
    }
    if (!visible) layout.toggleVisible(PartId.Panel)
    views.openViewContainer(TERMINAL_CONTAINER_ID)
  }
}

/** Open the terminal panel and spawn a fresh panel terminal. */
export class NewTerminalAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.new'
  constructor() {
    super({
      id: NewTerminalAction.ID,
      title: localize('action.newTerminal.title', 'New Terminal'),
      category: localize('command.category.terminal', 'Terminal'),
      keybinding: [{ primary: 'ctrl+shift+`' }],
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    const manager = accessor.get(ITerminalManagerService)
    if (!layout.getVisible(PartId.Panel)) layout.toggleVisible(PartId.Panel)
    views.openViewContainer(TERMINAL_CONTAINER_ID)
    await manager.newTerminal({ target: 'panel' })
  }
}

/** Focus the terminal panel (show + switch container + focus xterm). */
export class FocusTerminalPanelAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.focus'
  constructor() {
    super({
      id: FocusTerminalPanelAction.ID,
      title: localize('action.terminal.focusPanel.title', 'Focus Terminal'),
      category: localize('command.category.terminal', 'Terminal'),
      keybinding: { primary: 'alt+`', when: '!terminalFocus' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    const manager = accessor.get(ITerminalManagerService)
    if (!layout.getVisible(PartId.Panel)) layout.setVisible(PartId.Panel, true)
    views.openViewContainer(TERMINAL_CONTAINER_ID)
    if (manager.panelTerminals.get().length === 0) {
      await manager.newTerminal({ target: 'panel' })
    }
    manager.focus()
  }
}

/** Open a new terminal in an editor tab. */
export class OpenTerminalInEditorAction extends Action2 {
  static readonly ID = 'workbench.action.createTerminalEditor'
  constructor() {
    super({
      id: OpenTerminalInEditorAction.ID,
      title: localize('action.terminalInEditor.title', 'Open Terminal in Editor'),
      category: localize('command.category.terminal', 'Terminal'),
      keybinding: { primary: 'ctrl+`' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const manager = accessor.get(ITerminalManagerService)
    const editorService = accessor.get(IEditorService)
    const inst = accessor.get(IInstantiationService)
    const id = await manager.newTerminal({ target: 'editor' })
    if (!id) return
    const info = manager.terminals.get().find((t) => t.id === id)
    if (!info) return
    const input = inst.createInstance(TerminalEditorInput, id, info.name)
    editorService.openEditor(input, { pinned: true })
  }
}
