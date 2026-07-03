import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  IInstantiationService,
  ILayoutService,
  IViewsService,
  ServiceCollection,
  observableValue,
  registerAction2,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { SendCommitToAgentChatAction } from '../agentContextActions.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { IAcpChatWidgetService } from '../../services/acp/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { AcpPromptTextInbox } from '../../services/acp/acpPromptTextInbox.js'

describe('SendCommitToAgentChatAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    AcpPromptTextInbox._resetForTests()
  })

  const session = { id: 'sess-1', agentId: 'claude' } as unknown as IAcpSession

  function noopGroups() {
    return {
      _serviceBrand: undefined,
      groups: [],
      activeGroup: {},
      activeGroupForOpen: { openEditor: vi.fn() },
      activateGroup: vi.fn(),
    } as unknown as IEditorGroupsService
  }

  // run() captures every service synchronously (before its first await), so a
  // plain ServiceCollection-backed accessor suffices; nothing dereferences the
  // accessor past the await.
  async function runAction(
    arg: unknown,
    activeSession: IAcpSession | undefined,
    overrides?: {
      location?: 'editor' | 'sidebar'
      groups?: IEditorGroupsService
      sessionsById?: (id: string) => IAcpSession | undefined
    },
  ): Promise<void> {
    const focusSessionInput = vi.fn()
    const createSession = vi.fn()
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('t.active', activeSession),
      createSession,
      getById: overrides?.sessionsById ?? (() => undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId: () => 'claude',
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpChatLocationService, {
      _serviceBrand: undefined,
      location: observableValue<'editor' | 'sidebar'>('t.loc', overrides?.location ?? 'sidebar'),
    } as unknown as IAcpChatLocationService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      focusSessionInput,
    } as unknown as IAcpChatWidgetService)
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      getVisible: () => true,
      toggleVisible: vi.fn(),
    } as unknown as ILayoutService)
    services.set(IViewsService, {
      _serviceBrand: undefined,
      openViewContainer: vi.fn().mockResolvedValue(undefined),
    } as unknown as IViewsService)
    services.set(IEditorGroupsService, overrides?.groups ?? noopGroups())
    services.set(IInstantiationService, {
      _serviceBrand: undefined,
      createInstance: vi.fn(),
    } as unknown as IInstantiationService)
    const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
    await new SendCommitToAgentChatAction().run(accessor, arg as never)
  }

  it('registers the command', () => {
    disposables.push(registerAction2(SendCommitToAgentChatAction))
    expect(CommandsRegistry.getCommand(SendCommitToAgentChatAction.ID)).toBeDefined()
  })

  it('deposits the commit hash + subject as text for the active session', async () => {
    await runAction({ hash: 'abc1234def', message: 'fix: the thing' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def: fix: the thing'])
  })

  it('falls back to hash-only when the subject is blank', async () => {
    await runAction({ hash: 'abc1234def', message: '   ' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def'])
  })

  it('is a no-op without a hash', async () => {
    await runAction({ hash: '', message: 'x' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual([])
  })

  it('activates an existing session editor in another group instead of opening a duplicate', async () => {
    // Fake AcpSessionEditorInput: only `instanceof` + `sessionId` matter here.
    const existing = Object.create(AcpSessionEditorInput.prototype) as AcpSessionEditorInput
    Object.defineProperty(existing, 'sessionId', { value: 'sess-1' })
    const setActive = vi.fn()
    const otherGroup = { editors: [existing], setActive }
    const activeGroup = { editors: [] }
    const activateGroup = vi.fn()
    const openEditor = vi.fn()
    const groups = {
      _serviceBrand: undefined,
      groups: [activeGroup, otherGroup],
      activeGroup,
      activeGroupForOpen: { openEditor },
      activateGroup,
    } as unknown as IEditorGroupsService

    await runAction({ hash: 'abc1234def', message: 'fix' }, session, {
      location: 'editor',
      groups,
    })

    expect(activateGroup).toHaveBeenCalledWith(otherGroup)
    expect(setActive).toHaveBeenCalledWith(existing)
    expect(openEditor).not.toHaveBeenCalled()
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def: fix'])
  })

  it('opens a new session editor when none is open in any group', async () => {
    const openEditor = vi.fn()
    const activeGroup = { editors: [] }
    const activeGroupForOpen = { openEditor }
    const groups = {
      _serviceBrand: undefined,
      groups: [activeGroup],
      activeGroup,
      activeGroupForOpen,
      activateGroup: vi.fn(),
    } as unknown as IEditorGroupsService

    await runAction({ hash: 'abc1234def', message: 'fix' }, session, {
      location: 'editor',
      groups,
      sessionsById: (id) => (id === 'sess-1' ? session : undefined),
    })

    expect(openEditor).toHaveBeenCalledTimes(1)
  })
})
