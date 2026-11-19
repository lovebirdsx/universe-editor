/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Focus surface commands: hidden parts are revealed before focus moves, and an
 *  empty panel / secondary side bar gets its default container.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ILayoutService,
  IEditorGroupsService,
  InstantiationService,
  IViewsService,
  PartId,
  ServiceCollection,
  ViewContainerLocation,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  FocusActivityBarAction,
  FocusEditorTabsAction,
  FocusPanelAction,
  FocusSecondarySideBarAction,
  FocusSideBarAction,
  FocusViewContainerTabsAction,
} from '../focusSurfaceActions.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

interface Harness {
  readonly layout: {
    getVisible: ReturnType<typeof vi.fn>
    setVisible: ReturnType<typeof vi.fn>
    focusPart: ReturnType<typeof vi.fn>
  }
  readonly views: {
    getActiveViewContainerId: ReturnType<typeof vi.fn>
    openViewContainer: ReturnType<typeof vi.fn>
  }
  run(action: { ID: string }): Promise<void>
}

function harness(
  options: {
    visible?: boolean
    activeContainer?: string | undefined
  } = {},
): Harness {
  const layout = {
    getVisible: vi.fn().mockReturnValue(options.visible ?? true),
    setVisible: vi.fn(),
    focusPart: vi.fn().mockResolvedValue(true),
  }
  const views = {
    getActiveViewContainerId: vi.fn().mockReturnValue(options.activeContainer),
    openViewContainer: vi.fn(),
  }
  const services = new ServiceCollection()
  services.set(ILayoutService, { _serviceBrand: undefined, ...layout } as never)
  services.set(IViewsService, { _serviceBrand: undefined, ...views } as never)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { id: 0, preserveFocusOnActivation: vi.fn() },
  } as never)
  const instantiation = new InstantiationService(services)
  return {
    layout,
    views,
    async run(action) {
      const registration = registerAction2(action as never)
      try {
        await instantiation.invokeFunction((accessor) => {
          const command = CommandsRegistry.getCommand(action.ID)
          expect(command).toBeDefined()
          return command!.handler(accessor)
        })
      } finally {
        registration.dispose()
      }
    },
  }
}

describe('focus surface commands', () => {
  it('focuses a visible side bar without touching visibility', async () => {
    const { layout, run } = harness({ visible: true })
    await run(FocusSideBarAction)
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(layout.focusPart).toHaveBeenCalledWith(PartId.SideBar, { source: 'command' })
  })

  it('reveals a hidden side bar before focusing it', async () => {
    const { layout, run } = harness({ visible: false })
    await run(FocusSideBarAction)
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SideBar, true)
    expect(layout.focusPart).toHaveBeenCalledWith(PartId.SideBar, { source: 'command' })
  })

  it('opens the Output container when a hidden panel has none', async () => {
    const { layout, views, run } = harness({ visible: false, activeContainer: undefined })
    await run(FocusPanelAction)
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    expect(views.getActiveViewContainerId).toHaveBeenCalledWith(ViewContainerLocation.Panel)
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.output')
    expect(layout.focusPart).toHaveBeenCalledWith(PartId.Panel, { source: 'command' })
  })

  it('keeps an existing panel container', async () => {
    const { views, run } = harness({ visible: false, activeContainer: 'workbench.view.terminal' })
    await run(FocusPanelAction)
    expect(views.openViewContainer).not.toHaveBeenCalled()
  })

  it('focuses the activity bar', async () => {
    const { layout, run } = harness({ visible: true })
    await run(FocusActivityBarAction)
    expect(layout.focusPart).toHaveBeenCalledWith(PartId.ActivityBar, { source: 'command' })
  })

  it('opens Outline when the secondary side bar is hidden and empty', async () => {
    const { layout, views, run } = harness({ visible: false, activeContainer: undefined })
    await run(FocusSecondarySideBarAction)
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SecondarySideBar, true)
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.outline')
    expect(layout.focusPart).toHaveBeenCalledWith(PartId.SecondarySideBar, {
      source: 'command',
    })
  })

  it('leaves the tab strip focus commands to the tab-surface work package', async () => {
    const { layout, run } = harness()
    await run(FocusEditorTabsAction)
    await run(FocusViewContainerTabsAction)
    expect(layout.focusPart).not.toHaveBeenCalled()
  })
})
