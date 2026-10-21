import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  GroupDirection,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  ILayoutService,
  IUriIdentityService,
  IViewDescriptorService,
  IViewsService,
  IWorkspaceService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  URI,
  UriIdentityService,
  observableValue,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import type { AcpToolCall, TimelineItem } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import {
  FocusNextAcpTimelineItemAction,
  FocusNextSubagentCardAction,
  FocusPreviousSubagentCardAction,
  FocusSessionChangesAction,
  OpenAcpToolCallFileAction,
  OpenAcpToolCallFileToSideAction,
  OpenAcpToolCallPreviewAction,
  OpenAcpToolCallPreviewToSideAction,
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

// The card's read affordances: the plain pair opens over the active group, the
// `toSide` pair beside it. Both pairs share one body, so these lock in that the
// beside variant is the only one that grows the layout.
describe('OpenAcpToolCall*Action', () => {
  const ARG = { sessionId: 's1', slotKey: 't:tc1' }
  const MD_CALL: AcpToolCall = {
    id: 'tc1',
    title: 'Write a.md',
    kind: 'edit',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [{ path: '/repo/docs/a.md', oldText: '', newText: '# hi\n' }],
  }
  const TS_CALL: AcpToolCall = {
    ...MD_CALL,
    title: 'Write a.ts',
    diffs: [{ path: '/repo/src/a.ts', oldText: '', newText: 'export const a = 1\n' }],
  }

  beforeEach(() => {
    disposables.push(registerAction2(OpenAcpToolCallPreviewAction))
    disposables.push(registerAction2(OpenAcpToolCallFileAction))
    disposables.push(registerAction2(OpenAcpToolCallPreviewToSideAction))
    disposables.push(registerAction2(OpenAcpToolCallFileToSideAction))
  })

  function makeHarness(call: AcpToolCall) {
    const groups = new EditorGroupsService()
    const resolvedOpens: { resource: unknown; options: unknown }[] = []
    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups as never)
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      getById: (id: string) =>
        id === 's1'
          ? {
              timeline: observableValue<readonly TimelineItem[]>('t', [
                { kind: 'toolCall', id: call.id, call },
              ]),
            }
          : undefined,
    } as never)
    services.set(IEditorResolverService, {
      _serviceBrand: undefined,
      openEditor: vi.fn((resource: unknown, options: unknown) => {
        resolvedOpens.push({ resource, options })
        return Promise.resolve(undefined)
      }),
    } as never)
    services.set(IWorkspaceService, { _serviceBrand: undefined, current: undefined } as never)
    const inst = new InstantiationService(services)
    return {
      groups,
      resolvedOpens,
      invoke: (id: string) =>
        inst.invokeFunction((accessor) => CommandsRegistry.getCommand(id)!.handler(accessor, ARG)),
    }
  }

  it('opens the preview in a new side group', async () => {
    const { groups, invoke } = makeHarness(MD_CALL)

    await invoke(OpenAcpToolCallPreviewToSideAction.ID)

    expect(groups.count).toBe(2)
    expect(groups.getGroups()[1]!.editors).toHaveLength(1)
  })

  it('keeps the plain preview command in the active group', async () => {
    const { groups, invoke } = makeHarness(MD_CALL)

    await invoke(OpenAcpToolCallPreviewAction.ID)

    expect(groups.count).toBe(1)
    expect(groups.activeGroup.editors).toHaveLength(1)
  })

  it('activates the side group before the resolver opens a non-previewable file', async () => {
    const { groups, resolvedOpens, invoke } = makeHarness(TS_CALL)

    await invoke(OpenAcpToolCallFileToSideAction.ID)

    expect(groups.count).toBe(2)
    expect(groups.activeGroup).not.toBe(groups.getGroups()[0])
    expect(resolvedOpens).toEqual([
      { resource: URI.file('/repo/src/a.ts'), options: { pinned: true } },
    ])
  })

  it('keeps the plain file command in the active group', async () => {
    const { groups, resolvedOpens, invoke } = makeHarness(TS_CALL)

    await invoke(OpenAcpToolCallFileAction.ID)

    expect(groups.count).toBe(1)
    expect(resolvedOpens).toHaveLength(1)
  })

  it('lists each beside row on the card group, gated on its own preview flavour', () => {
    const items = MenuRegistry.getMenuItems(MenuId.AcpChatContext)
    // The registry stores a parsed expression, so the key comes back out of
    // `serialize()` — a `when` the registry never parsed would be a raw string.
    const whenFor = (id: string): string | undefined => {
      const when = items.find((i) => 'command' in i && i.command === id)?.when
      return typeof when === 'string' ? when : when?.serialize()
    }

    expect(whenFor(OpenAcpToolCallPreviewToSideAction.ID)).toBe('acpChatContextCreatedPreview')
    expect(whenFor(OpenAcpToolCallFileToSideAction.ID)).toBe('acpChatContextCreatedFile')
    // The plain twins stay in the same menu group — the beside rows extend the
    // existing pair rather than opening a new section.
    expect(whenFor(OpenAcpToolCallPreviewAction.ID)).toBe('acpChatContextCreatedPreview')
    expect(whenFor(OpenAcpToolCallFileAction.ID)).toBe('acpChatContextCreatedFile')
  })
})

describe('sub-agent card navigation actions', () => {
  function invoke(action: { readonly ID: string }): ReturnType<typeof vi.fn> {
    const moveSubagent = vi.fn()
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: { moveSubagent },
    } as never)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: { get: () => undefined },
    } as never)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => CommandsRegistry.getCommand(action.ID)!.handler(accessor))
    return moveSubagent
  }

  it('routes next to the last-focused widget', () => {
    disposables.push(registerAction2(FocusNextSubagentCardAction))
    expect(invoke(FocusNextSubagentCardAction)).toHaveBeenCalledWith('next')
  })

  it('routes prev to the last-focused widget', () => {
    disposables.push(registerAction2(FocusPreviousSubagentCardAction))
    expect(invoke(FocusPreviousSubagentCardAction)).toHaveBeenCalledWith('prev')
  })
})

// The timeline navigation buttons in a session editor's title bar carry
// `{ groupId }`. They must drive that group's session — not whichever chat last
// held focus, which may belong to a different split.
describe('ACP timeline title actions follow the { groupId } of a non-active group', () => {
  it('moves the named group session, not the last-focused widget', () => {
    const groups = new EditorGroupsService()
    const s1Widget = { moveTimeline: vi.fn() }
    const s2Widget = { moveTimeline: vi.fn() }
    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      widgetForSession: (id: string) =>
        id === 's1' ? s1Widget : id === 's2' ? s2Widget : undefined,
      lastFocusedWidget: s2Widget,
    } as never)
    services.set(IAcpSessionHistoryService, {
      entries: observableValue('history', []),
      get: () => undefined,
    } as never)
    services.set(IAcpSessionService, { getById: () => undefined } as never)
    services.set(IWorkspaceService, {
      current: undefined,
      onDidChangeWorkspace: new Emitter<void>().event,
    } as never)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    services.set(IEditorService, {
      activeEditor: { get: () => groups.activeGroup.activeEditor },
    } as never)
    const inst = new InstantiationService(services)

    const g1 = groups.activeGroup
    g1.openEditor(inst.createInstance(AcpSessionEditorInput, 's1', undefined, undefined), {
      activate: true,
      pinned: true,
    })
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    g2.openEditor(inst.createInstance(AcpSessionEditorInput, 's2', undefined, undefined), {
      activate: true,
      pinned: true,
    })
    groups.activateGroup(g2)

    disposables.push(registerAction2(FocusNextAcpTimelineItemAction))
    inst.invokeFunction((accessor) =>
      CommandsRegistry.getCommand(FocusNextAcpTimelineItemAction.ID)!.handler(accessor, {
        groupId: g1.id,
      }),
    )

    expect(s1Widget.moveTimeline).toHaveBeenCalledWith('next')
    expect(s2Widget.moveTimeline).not.toHaveBeenCalled()
  })
})
