/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  viewContainerToggleCommand — maps a view container id to the command that
 *  opens/toggles it, so surfaces like the activity bar tooltip can resolve the
 *  container's effective keybinding. Most built-in containers follow the VSCode
 *  convention "container id == command id" (explorer/scm/extensions); the rest
 *  are listed explicitly. Unknown containers fall back to their own id — when no
 *  such command exists the lookup simply resolves to no keybinding.
 *--------------------------------------------------------------------------------------------*/

const TOGGLE_COMMAND_BY_CONTAINER: Readonly<Record<string, string>> = {
  'workbench.view.search': 'workbench.action.findInFiles',
  'workbench.view.outline': 'outline.focus',
  'workbench.view.terminal': 'workbench.action.terminal.toggleTerminal',
  'workbench.view.output': 'workbench.action.toggleOutput',
  'workbench.view.agents': 'workbench.action.agent.openView',
  'workbench.view.sessionChanges': 'workbench.action.agent.showSessionChanges',
  'workbench.view.swarm': 'swarm.openReviews',
}

export function viewContainerToggleCommand(containerId: string): string {
  return TOGGLE_COMMAND_BY_CONTAINER[containerId] ?? containerId
}
