import { useEffect } from 'react'
import {
  ILayoutService,
  ICommandService,
  IQuickInputService,
  KeybindingsRegistry,
  CommandsRegistry,
  PartId,
  LifecyclePhase,
} from '@universe-editor/platform'
import type { LayoutState, LifecycleService, InstantiationService } from '@universe-editor/platform'
import { ServicesContext, useService, useSnapshot } from './useService.js'
import { shallow } from './shallow.js'
import { WorkbenchLayout } from './layout/WorkbenchLayout.js'
import { ActivityBar } from './activitybar/ActivityBar.js'
import { SideBar } from './sidebar/SideBar.js'
import { EditorArea } from './editor/EditorArea.js'
import { Panel } from './panel/Panel.js'
import { StatusBar } from './statusbar/StatusBar.js'
import { QuickInputPortal } from './quickinput/QuickInput.js'

interface WorkbenchProps {
  instantiation: InstantiationService
  lifecycle: LifecycleService
}

const layoutVisibilitySelector = (s: LayoutState) => ({
  sidebarVisible: s.visible[PartId.SideBar] ?? true,
  panelVisible: s.visible[PartId.Panel] ?? true,
})

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

function WorkbenchShell() {
  const layoutService = useService(ILayoutService)
  const { sidebarVisible, panelVisible } = useSnapshot(
    layoutService,
    layoutVisibilitySelector,
    shallow,
  )

  return (
    <>
      <WorkbenchLayout
        sidebarVisible={sidebarVisible}
        panelVisible={panelVisible}
        activitybar={<ActivityBar />}
        sidebar={<SideBar />}
        editor={<EditorArea />}
        panel={<Panel />}
        statusbar={<StatusBar />}
      />
      <QuickInputPortal />
    </>
  )
}

export function Workbench({ instantiation, lifecycle }: WorkbenchProps) {
  // Advance lifecycle after mount
  useEffect(() => {
    lifecycle.setPhase(LifecyclePhase.Restored)
    const id = requestIdleCallback(() => lifecycle.setPhase(LifecyclePhase.Eventually))
    return () => cancelIdleCallback(id)
  }, [lifecycle])

  // Global keyboard handler: resolve keybinding → execute command
  useEffect(() => {
    const commandService = instantiation.invokeFunction((a) => a.get(ICommandService))

    const handler = (e: KeyboardEvent) => {
      const key = buildKeyString(e)
      const commandId = KeybindingsRegistry.resolveKeybinding(key)
      if (commandId) {
        e.preventDefault()
        void commandService.executeCommand(commandId)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [instantiation])

  // Register built-in command: show command palette
  useEffect(() => {
    const quickInputService = instantiation.invokeFunction((a) => a.get(IQuickInputService))

    const d = CommandsRegistry.registerCommand(
      'workbench.action.showCommands',
      async () => {
        const commands = [...CommandsRegistry.getCommands().values()].map((cmd) => ({
          id: cmd.id,
          label: cmd.metadata?.description ?? cmd.id,
          ...(cmd.metadata?.category !== undefined ? { description: cmd.metadata.category } : {}),
        }))
        const selected = await quickInputService.pick(commands, {
          placeholder: 'Type a command name…',
        })
        if (selected) {
          void instantiation
            .invokeFunction((a) => a.get(ICommandService))
            .executeCommand(selected.id)
        }
      },
      { description: 'Show All Commands', category: 'View' },
    )
    return () => d.dispose()
  }, [instantiation])

  return (
    <ServicesContext.Provider value={instantiation}>
      <WorkbenchShell />
    </ServicesContext.Provider>
  )
}
