/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  workbench.action.navigate*: editor groups first, then the part on that side,
 *  then a workbench window in that direction.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  GroupDirection,
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

interface FakeGroup {
  readonly id: number
  readonly activeEditor?: object
}

interface FakePart {
  readonly id: number
  readonly activeGroup: FakeGroup
  readonly groups: readonly FakeGroup[]
}

interface FakeWindowOptions {
  readonly id: number
  readonly isMain: boolean
  readonly part?: FakePart
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly visibilityState?: 'visible' | 'hidden'
  readonly closed?: boolean
}

function fakeGroup(id: number): FakeGroup {
  return { id }
}

function fakePart(id: number, activeGroup: FakeGroup = fakeGroup(id)): FakePart {
  return { id, activeGroup, groups: [activeGroup] }
}

function fakeWindow(options: FakeWindowOptions): IWorkbenchWindow {
  return {
    id: options.id,
    isMain: options.isMain,
    part: options.part ?? fakePart(options.id),
    document: { visibilityState: options.visibilityState ?? 'visible' },
    window: {
      screenX: options.x,
      screenY: options.y,
      outerWidth: options.width,
      outerHeight: options.height,
      closed: options.closed ?? false,
    },
    token: options.isMain ? undefined : `token-${options.id}`,
  } as unknown as IWorkbenchWindow
}

interface HarnessOptions {
  readonly focused: PartId
  readonly groupInDirection?: FakeGroup | undefined
  readonly activeWindow?: IWorkbenchWindow | undefined
  readonly windows?: readonly IWorkbenchWindow[] | undefined
  readonly secondarySideBarRect?: Rect | undefined
}

function harness(options: HarnessOptions) {
  const rects: Partial<Record<PartId, Rect>> =
    options.secondarySideBarRect === undefined
      ? RECTS
      : { ...RECTS, [PartId.SecondarySideBar]: options.secondarySideBarRect }
  const mainGroup = fakeGroup(1)
  const mainPart = fakePart(1, mainGroup)
  const mainWindow = fakeWindow({
    id: 0,
    isMain: true,
    part: mainPart,
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
  })
  const activeWindow = options.activeWindow ?? mainWindow
  const windows = options.windows ?? [mainWindow]

  const part = (id: PartId) => {
    const rect = rects[id]
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
    getVisible: (id: PartId) => rects[id] !== undefined,
    getPart: part,
    focusPart: vi.fn().mockResolvedValue(true),
  }
  const findGroup = vi.fn().mockReturnValue(options.groupInDirection)
  const groups = { activateGroup: vi.fn(), findGroup }
  const windowFocus = new FakeWindowFocusService()
  const focusStack = { push: vi.fn() }
  const services = new ServiceCollection()
  services.set(ILayoutService, layout as never)
  services.set(IEditorGroupsService, groups as never)
  services.set(IContextKeyService, {} as never)
  services.set(IWindowFocusService, windowFocus)
  services.set(IFocusStackService, focusStack as never)
  services.set(IWorkbenchWindowService, {
    mainWindow,
    activeWindow,
    windows,
  } as never)
  const instantiation = new InstantiationService(services)
  return {
    layout,
    groups,
    windowFocus,
    focusStack,
    mainGroup,
    mainWindow,
    activeWindow,
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
    expect(h.groups.activateGroup).toHaveBeenCalledWith(h.mainGroup)
    expect(h.windowFocus.focusedGroups).toEqual([h.mainGroup])
    expect(h.groups.findGroup).not.toHaveBeenCalled()
    expect(h.layout.focusPart).not.toHaveBeenCalled()
  })

  it('leaves the leftmost editor group for the side bar', () => {
    const h = harness({ focused: PartId.EditorArea })
    h.run(NavigateLeftAction)
    expect(h.groups.findGroup).toHaveBeenCalledWith({ direction: GroupDirection.Left }, h.mainGroup)
    expect(h.layout.focusPart).toHaveBeenCalledWith(PartId.SideBar, { source: 'command' })
  })

  it('prefers a neighbouring editor group over the parts', () => {
    const group = fakeGroup(2)
    const h = harness({ focused: PartId.EditorArea, groupInDirection: group })
    h.run(NavigateLeftAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(group)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
  })

  it('does nothing at the workbench edge', () => {
    const h = harness({ focused: PartId.SideBar })
    h.run(NavigateLeftAction)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
    expect(h.groups.activateGroup).not.toHaveBeenCalled()
    expect(h.windowFocus.focusedGroups).toEqual([])
  })

  it('prefers an adjacent group over a window in that direction', () => {
    const group = fakeGroup(2)
    const auxPart = fakePart(20)
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: auxPart,
      x: 950,
      y: 0,
      width: 600,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      groupInDirection: group,
      windows: [fakeWindow({ id: 0, isMain: true, x: 0, y: 0, width: 1200, height: 900 }), aux],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(group)
    expect(h.windowFocus.focusedGroups).toEqual([group])
  })

  it('prefers a part in the same window over a window in that direction', () => {
    const aux = fakeWindow({ id: 20, isMain: false, x: 950, y: 0, width: 600, height: 800 })
    const h = harness({
      focused: PartId.SideBar,
      windows: [fakeWindow({ id: 0, isMain: true, x: 0, y: 0, width: 1200, height: 900 }), aux],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(h.mainGroup)
    expect(h.windowFocus.focusedGroups).toEqual([h.mainGroup])
  })

  it('navigates between groups inside the active auxiliary window first', () => {
    const auxGroup = fakeGroup(30)
    const auxNext = fakeGroup(31)
    const auxPart = fakePart(20, auxGroup)
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: auxPart,
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      groupInDirection: auxNext,
      activeWindow: aux,
      windows: [fakeWindow({ id: 0, isMain: true, x: -1200, y: 0, width: 1000, height: 900 }), aux],
    })
    h.run(NavigateRightAction)
    expect(h.groups.findGroup).toHaveBeenCalledWith({ direction: GroupDirection.Right }, auxGroup)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(auxNext)
  })

  it('moves from an auxiliary window to the window on its right', () => {
    const aux1Group = fakeGroup(30)
    const aux2Group = fakeGroup(40)
    const aux1 = fakeWindow({
      id: 20,
      isMain: false,
      part: fakePart(20, aux1Group),
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    })
    const aux2 = fakeWindow({
      id: 21,
      isMain: false,
      part: fakePart(21, aux2Group),
      x: 600,
      y: 0,
      width: 500,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux1,
      windows: [
        fakeWindow({ id: 0, isMain: true, x: -1200, y: 0, width: 1000, height: 900 }),
        aux1,
        aux2,
      ],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(aux2Group)
    expect(h.windowFocus.focusedGroups).toEqual([aux2Group])
    expect(h.focusStack.push).toHaveBeenCalledWith({ partId: PartId.EditorArea, groupId: 40 })
  })

  it('moves from an auxiliary window back to the main window', () => {
    const auxGroup = fakeGroup(30)
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: fakePart(20, auxGroup),
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    })
    const main = fakeWindow({
      id: 0,
      isMain: true,
      part: fakePart(1, fakeGroup(1)),
      x: -1200,
      y: 0,
      width: 1000,
      height: 900,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux,
      windows: [main, aux],
    })
    h.run(NavigateLeftAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith((main.part as FakePart).activeGroup)
    expect(h.groups.activateGroup).not.toHaveBeenCalledWith(auxGroup)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
  })

  it('moves from an auxiliary window back to the right-hand view of the main window', () => {
    const auxGroup = fakeGroup(30)
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: fakePart(20, auxGroup),
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    })
    const main = fakeWindow({
      id: 0,
      isMain: true,
      part: fakePart(1, fakeGroup(1)),
      x: -1200,
      y: 0,
      width: 1000,
      height: 900,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux,
      windows: [main, aux],
      secondarySideBarRect: { left: 901, top: 0, right: 1100, bottom: 800 },
    })
    h.run(NavigateLeftAction)
    // Entering the main window picks its rightmost part (the Outline's
    // SecondarySideBar), not the editor area.
    expect(h.layout.focusPart).toHaveBeenCalledWith(PartId.SecondarySideBar, {
      source: 'command',
    })
    expect(h.groups.activateGroup).not.toHaveBeenCalled()
  })

  it('picks the nearest window in the direction', () => {
    const nearGroup = fakeGroup(40)
    const farGroup = fakeGroup(50)
    const aux1 = fakeWindow({ id: 20, isMain: false, x: 0, y: 0, width: 500, height: 800 })
    const near = fakeWindow({
      id: 21,
      isMain: false,
      part: fakePart(21, nearGroup),
      x: 600,
      y: 0,
      width: 500,
      height: 800,
    })
    const far = fakeWindow({
      id: 22,
      isMain: false,
      part: fakePart(22, farGroup),
      x: 1200,
      y: 0,
      width: 500,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux1,
      windows: [aux1, near, far],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(nearGroup)
    expect(h.groups.activateGroup).not.toHaveBeenCalledWith(farGroup)
  })

  it('skips hidden windows and falls back to the visible one', () => {
    const hiddenGroup = fakeGroup(40)
    const visibleGroup = fakeGroup(50)
    const aux1 = fakeWindow({ id: 20, isMain: false, x: 0, y: 0, width: 500, height: 800 })
    const hidden = fakeWindow({
      id: 21,
      isMain: false,
      part: fakePart(21, hiddenGroup),
      x: 600,
      y: 0,
      width: 500,
      height: 800,
      visibilityState: 'hidden',
    })
    const visible = fakeWindow({
      id: 22,
      isMain: false,
      part: fakePart(22, visibleGroup),
      x: 1200,
      y: 0,
      width: 500,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux1,
      windows: [aux1, hidden, visible],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).toHaveBeenCalledWith(visibleGroup)
    expect(h.groups.activateGroup).not.toHaveBeenCalledWith(hiddenGroup)
  })

  it('does nothing when only hidden windows lie in the direction', () => {
    const aux1 = fakeWindow({ id: 20, isMain: false, x: 0, y: 0, width: 500, height: 800 })
    const hidden = fakeWindow({
      id: 21,
      isMain: false,
      x: 600,
      y: 0,
      width: 500,
      height: 800,
      visibilityState: 'hidden',
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux1,
      windows: [aux1, hidden],
    })
    h.run(NavigateRightAction)
    expect(h.groups.activateGroup).not.toHaveBeenCalled()
    expect(h.windowFocus.focusedGroups).toEqual([])
  })

  it('does not use main-window parts as candidates while an auxiliary window is active', () => {
    const auxGroup = fakeGroup(30)
    const aux = fakeWindow({
      id: 20,
      isMain: false,
      part: fakePart(20, auxGroup),
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    })
    const h = harness({
      focused: PartId.EditorArea,
      activeWindow: aux,
      windows: [fakeWindow({ id: 0, isMain: true, x: -1200, y: 0, width: 1000, height: 900 }), aux],
    })
    h.run(NavigateRightAction)
    expect(h.layout.focusPart).not.toHaveBeenCalled()
  })
})
