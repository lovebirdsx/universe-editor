import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ILayoutService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  FocusSessionChangesAction,
  SESSION_CHANGES_CONTAINER_ID,
  SESSION_CHANGES_VIEW_ID,
  ShowAcpSessionChangesAction,
} from '../agentTimelineActions.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function makeLayoutService(visible: boolean, focused: boolean) {
  const part = { focus: vi.fn(), isFocused: vi.fn().mockReturnValue(focused) }
  const setVisible = vi.fn()
  const focusView = vi.fn().mockResolvedValue(true)
  const mock = {
    _serviceBrand: undefined,
    getVisible: vi.fn().mockReturnValue(visible),
    setVisible,
    getPart: vi.fn().mockReturnValue(part),
    focusView,
  } as never
  return { mock, setVisible, focusView }
}

function makeViewsService(activeId: string | undefined) {
  const openViewContainer = vi.fn()
  const mock = {
    _serviceBrand: undefined,
    openViewContainer,
    getActiveViewContainerId: vi.fn().mockReturnValue(activeId),
  } as never
  return { mock, openViewContainer }
}

function makeViewDescriptorService() {
  const setViewCollapsed = vi.fn()
  const mock = { _serviceBrand: undefined, setViewCollapsed } as never
  return { mock, setViewCollapsed }
}

function runCommand(
  id: string,
  layout: ReturnType<typeof makeLayoutService>,
  views: ReturnType<typeof makeViewsService>,
) {
  const descriptors = makeViewDescriptorService()
  const services = new ServiceCollection()
  services.set(ILayoutService, layout.mock)
  services.set(IViewsService, views.mock)
  services.set(IViewDescriptorService, descriptors.mock)
  const inst = new InstantiationService(services)
  return {
    descriptors,
    invoke: () =>
      inst.invokeFunction((accessor) => CommandsRegistry.getCommand(id)!.handler(accessor)),
  }
}

function expectShowPath(
  layout: ReturnType<typeof makeLayoutService>,
  views: ReturnType<typeof makeViewsService>,
  descriptors: ReturnType<typeof makeViewDescriptorService>,
) {
  expect(views.openViewContainer).toHaveBeenCalledWith(SESSION_CHANGES_CONTAINER_ID)
  expect(descriptors.setViewCollapsed).toHaveBeenCalledWith(SESSION_CHANGES_VIEW_ID, false)
  expect(layout.focusView).toHaveBeenCalledWith(SESSION_CHANGES_VIEW_ID, { source: 'command' })
  expect(layout.setVisible).not.toHaveBeenCalled()
}

describe('ShowAcpSessionChangesAction', () => {
  it('registerAction2 wires command + F1 menu', () => {
    disposables.push(registerAction2(ShowAcpSessionChangesAction))
    expect(CommandsRegistry.getCommand(ShowAcpSessionChangesAction.ID)).toBeDefined()
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === ShowAcpSessionChangesAction.ID,
      ),
    ).toBe(true)
  })

  it('run() shows and focuses the view when SideBar is hidden', async () => {
    const layout = makeLayoutService(false, false)
    const views = makeViewsService(undefined)
    disposables.push(registerAction2(ShowAcpSessionChangesAction))
    const { descriptors, invoke } = runCommand(ShowAcpSessionChangesAction.ID, layout, views)

    await invoke()

    expectShowPath(layout, views, descriptors)
  })

  it('run() shows and focuses the view when a different container is active', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService('workbench.view.explorer')
    disposables.push(registerAction2(ShowAcpSessionChangesAction))
    const { descriptors, invoke } = runCommand(ShowAcpSessionChangesAction.ID, layout, views)

    await invoke()

    expectShowPath(layout, views, descriptors)
  })

  it('run() focuses the view when its container is active but not focused', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService(SESSION_CHANGES_CONTAINER_ID)
    disposables.push(registerAction2(ShowAcpSessionChangesAction))
    const { descriptors, invoke } = runCommand(ShowAcpSessionChangesAction.ID, layout, views)

    await invoke()

    expectShowPath(layout, views, descriptors)
  })

  it('run() hides the SideBar when the container is active and focused', async () => {
    const layout = makeLayoutService(true, true)
    const views = makeViewsService(SESSION_CHANGES_CONTAINER_ID)
    disposables.push(registerAction2(ShowAcpSessionChangesAction))
    const { descriptors, invoke } = runCommand(ShowAcpSessionChangesAction.ID, layout, views)

    await invoke()

    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SideBar, false)
    expect(layout.focusView).not.toHaveBeenCalled()
    expect(descriptors.setViewCollapsed).not.toHaveBeenCalled()
  })
})

describe('FocusSessionChangesAction', () => {
  it('run() reveals, expands and focuses the view', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService(undefined)
    disposables.push(registerAction2(FocusSessionChangesAction))
    const { descriptors, invoke } = runCommand(FocusSessionChangesAction.ID, layout, views)

    await invoke()

    expectShowPath(layout, views, descriptors)
  })
})
