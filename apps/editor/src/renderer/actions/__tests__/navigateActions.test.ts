/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  workbench.action.navigate*: editor groups first, then the part on that side.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IFocusStackService,
  ILayoutService,
  InstantiationService,
  PartId,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { NavigateLeftAction, NavigateRightAction } from '../focusActions.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

type Rect = { left: number; top: number; right: number; bottom: number }

const RECTS: Partial<Record<PartId, Rect>> = {
  [PartId.SideBar]: { left: 0, top: 0, right: 200, bottom: 800 },
  [PartId.EditorArea]: { left: 201, top: 0, right: 900, bottom: 500 },
  [PartId.Panel]: { left: 201, top: 501, right: 900, bottom: 800 },
}

function harness(options: { focused: PartId; groupInDirection?: object | undefined }) {
  const part = (id: PartId) => {
    const rect = RECTS[id]
    if (rect === undefined) return undefined
    return {
      isFocused: () => id === options.focused,
      getContainer: () => ({
        getBoundingClientRect: () => ({
          ...rect,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
        }),
      }),
    }
  }
  const layout = {
    getVisible: (id: PartId) => RECTS[id] !== undefined,
    getPart: part,
    focusPart: vi.fn().mockResolvedValue(true),
  }
  const findGroup = vi.fn().mockReturnValue(options.groupInDirection)
  const groups = { activateGroup: vi.fn(), findGroup }
  const executeCommand = vi.fn(async () => undefined)
  const services = new ServiceCollection()
  services.set(ILayoutService, layout as never)
  services.set(IEditorGroupsService, groups as never)
  services.set(ICommandService, { executeCommand } as never)
  services.set(IContextKeyService, {} as never)
  services.set(IWindowFocusService, { focusGroup: vi.fn() } as never)
  services.set(IFocusStackService, { push: vi.fn() } as never)
  const instantiation = new InstantiationService(services)
  return {
    layout,
    groups,
    executeCommand,
    run(action: { ID: string }) {
      disposables.push(registerAction2(action as never))
      instantiation.invokeFunction((accessor) =>
        CommandsRegistry.getCommand(action.ID)!.handler(accessor),
      )
    },
  }
}

describe('navigate actions', () => {
  it('moves from the Explorer back to the editor', () => {
    const h = harness({ focused: PartId.SideBar })
    h.run(NavigateRightAction)
    expect(h.executeCommand).toHaveBeenCalledWith('workbench.action.focusActiveEditorGroup')
    expect(h.groups.findGroup).not.toHaveBeenCalled()
  })

  it('leaves the leftmost editor group for the side bar', () => {
    const h = harness({ focused: PartId.EditorArea })
    h.run(NavigateLeftAction)
    expect(h.groups.findGroup).toHaveBeenCalledWith({ direction: GroupDirection.Left })
    expect(h.layout.focusPart).toHaveBeenCalledWith(PartId.SideBar, { source: 'command' })
  })

  it('prefers a neighbouring editor group over the parts', () => {
    const group = { id: 2, activeEditor: undefined }
    const h = harness({ focused: PartId.EditorArea, groupInDirection: group })
    h.run(NavigateLeftAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(group)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
  })

  it('does nothing at the workbench edge', () => {
    const h = harness({ focused: PartId.SideBar })
    h.run(NavigateLeftAction)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
    expect(h.executeCommand).not.toHaveBeenCalled()
  })
})
