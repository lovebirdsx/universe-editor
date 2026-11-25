/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Cross-window direction navigation into an empty auxiliary window must still
 *  park keyboard focus on that window's group body.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
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
import { FakeWindowFocusService } from '../../services/windows/testing/fakeWindowFocusService.js'
import {
  IWorkbenchWindowService,
  type IWorkbenchWindow,
} from '../../services/windows/workbenchWindowService.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { NavigateRightAction } from '../focusActions.js'

const disposables: IDisposable[] = []
const GROUP_ID = 42

type Rect = { left: number; top: number; right: number; bottom: number }

const RECTS: Partial<Record<PartId, Rect>> = {
  [PartId.SideBar]: { left: 0, top: 0, right: 200, bottom: 800 },
  [PartId.EditorArea]: { left: 201, top: 0, right: 900, bottom: 500 },
  [PartId.Panel]: { left: 201, top: 501, right: 900, bottom: 800 },
}

interface FakeGroup {
  readonly id: number
  readonly activeEditor?: object
}

interface FakePart {
  readonly id: number
  readonly activeGroup: FakeGroup
  readonly groups: readonly FakeGroup[]
}

function fakeWindow(options: {
  id: number
  isMain: boolean
  part?: FakePart
  x: number
  y: number
  width: number
  height: number
}): IWorkbenchWindow {
  return {
    id: options.id,
    isMain: options.isMain,
    part: options.part ?? { id: options.id, activeGroup: { id: options.id }, groups: [] },
    document: { visibilityState: 'visible' },
    window: {
      screenX: options.x,
      screenY: options.y,
      outerWidth: options.width,
      outerHeight: options.height,
      closed: false,
    },
    token: options.isMain ? undefined : `token-${options.id}`,
  } as unknown as IWorkbenchWindow
}

describe('navigate actions — empty auxiliary window', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('focuses the target window group body when it has no editor', () => {
    const group: FakeGroup = { id: GROUP_ID }
    const auxPart: FakePart = { id: 20, activeGroup: group, groups: [group] }
    const mainGroup: FakeGroup = { id: 1 }
    const mainPart: FakePart = { id: 1, activeGroup: mainGroup, groups: [mainGroup] }
    const mainWindow = fakeWindow({
      id: 0,
      isMain: true,
      part: mainPart,
      x: 0,
      y: 0,
      width: 1200,
      height: 900,
    })
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: auxPart,
      x: 950,
      y: 0,
      width: 600,
      height: 800,
    })

    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-group-id', String(GROUP_ID))
    const body = document.createElement('div')
    body.setAttribute('data-testid', 'editor-group-body')
    body.tabIndex = -1
    wrapper.appendChild(body)
    document.body.appendChild(wrapper)

    const part = (id: PartId) => {
      const rect = RECTS[id]
      if (rect === undefined) return undefined
      return {
        isFocused: () => id === PartId.EditorArea,
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
    const groups = { activateGroup: vi.fn(), findGroup: vi.fn().mockReturnValue(undefined) }
    const windowFocus = new FakeWindowFocusService()
    const contextKeyService = new ContextKeyService()
    const services = new ServiceCollection()
    services.set(ILayoutService, layout as never)
    services.set(IEditorGroupsService, groups as never)
    services.set(IContextKeyService, contextKeyService)
    services.set(IWindowFocusService, windowFocus)
    services.set(IFocusStackService, { push: vi.fn() } as never)
    services.set(IWorkbenchWindowService, {
      mainWindow,
      activeWindow: mainWindow,
      windows: [mainWindow, aux],
    } as never)
    const instantiation = new InstantiationService(services)

    disposables.push(registerAction2(NavigateRightAction as never))
    instantiation.invokeFunction((accessor) =>
      CommandsRegistry.getCommand(NavigateRightAction.ID)!.handler(accessor),
    )

    expect(groups.activateGroup).toHaveBeenCalledWith(group)
    expect(windowFocus.focusedGroups).toEqual([group])
    expect(document.activeElement).toBe(body)
  })
})
