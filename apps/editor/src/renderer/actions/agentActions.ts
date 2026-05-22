/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent-related Action2 definitions: new session, cancel turn, open in editor,
 *  select agent. All four show up in the command palette (`f1: true`).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IQuickInputService,
  IViewsService,
  ILayoutService,
  PartId,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'

const CATEGORY = localize('command.category.agents', 'Agents')

export class NewAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.newSession'
  constructor() {
    super({
      id: NewAgentSessionAction.ID,
      title: localize('action.agent.newSession', 'New Agent Session'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const sessions = accessor.get(IAcpSessionService)
    const registry = accessor.get(IAcpAgentRegistry)
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    await sessions.createSession(registry.defaultAgentId())
    // Make sure the Agents view is visible so the new session is reachable.
    if (!layout.getVisible(PartId.SecondarySideBar)) {
      layout.toggleVisible(PartId.SecondarySideBar)
    }
    views.openViewContainer('workbench.view.agents')
  }
}

export class CancelAgentTurnAction extends Action2 {
  static readonly ID = 'workbench.action.agent.cancelTurn'
  constructor() {
    super({
      id: CancelAgentTurnAction.ID,
      title: localize('action.agent.cancelTurn', 'Cancel Agent Turn'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+shift+escape' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const session = accessor.get(IAcpSessionService).activeSession.get()
    if (session) await session.cancelTurn()
  }
}

export class OpenAgentInEditorAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openInEditor'
  constructor() {
    super({
      id: OpenAgentInEditorAction.ID,
      title: localize('action.agent.openInEditor', 'Open Agent Session in Editor'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const session = accessor.get(IAcpSessionService).activeSession.get()
    if (!session) return
    accessor.get(IEditorService).openEditor(new AcpSessionEditorInput(session.id))
  }
}

export class SelectAgentAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectAgent'
  constructor() {
    super({
      id: SelectAgentAction.ID,
      title: localize('action.agent.selectAgent', 'Select Default Agent…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const registry = accessor.get(IAcpAgentRegistry)
    const quickInput = accessor.get(IQuickInputService)
    const items: IQuickPickItem[] = registry.list().map((d) => ({
      id: d.id,
      label: d.name,
      description: d.command,
    }))
    const picked = await quickInput.pick(items, {
      placeholder: localize('agent.selectAgent.placeholder', 'Select default ACP agent'),
    })
    if (!picked) return
    // Update the default agent at runtime (Memory layer). User can persist via Settings UI.
    const sessions = accessor.get(IAcpSessionService)
    await sessions.createSession(picked.id)
  }
}
