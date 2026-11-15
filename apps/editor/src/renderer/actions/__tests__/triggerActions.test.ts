/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger report menu entries: the chat context menu (gated on
 *  the trigger automation of the session it was raised on) and the session tab
 *  context menu (gated on the tab's automation).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IDialogService,
  IEditorResolverService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IViewsService,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  REMOTE_SCHEME,
  URI,
  registerAction2,
  type IConfirmOptions,
  type IConfirmResult,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { ILogFilesService } from '../../../shared/ipc/services.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  OpenTriggersConfigAction,
  ViewTriggerReportAction,
  confirmTriggerActivation,
  type TriggerActionServices,
} from '../triggerActions.js'

let registration: IDisposable | undefined

afterEach(() => {
  registration?.dispose()
  registration = undefined
})

function menuItem(menuId: MenuId) {
  return MenuRegistry.getMenuItems(menuId).find(
    (entry) => 'command' in entry && entry.command === ViewTriggerReportAction.ID,
  )
}

function whenOf(menuId: MenuId): string | undefined {
  const when = menuItem(menuId)?.when
  return typeof when === 'string' ? when : when?.serialize()
}

describe('ViewTriggerReportAction menu entries', () => {
  it('offers View Report on trigger-started chats and session tabs', () => {
    registration = registerAction2(ViewTriggerReportAction)

    expect(menuItem(MenuId.AcpChatContext)).toMatchObject({ group: '3_session', order: 6 })
    expect(whenOf(MenuId.AcpChatContext)).toBe('acpChatSessionAutomation')

    expect(menuItem(MenuId.EditorTabContext)).toMatchObject({ group: '1_session', order: 3 })
    const tabWhen = whenOf(MenuId.EditorTabContext) ?? ''
    expect(tabWhen).toContain("activeEditorType == 'acp.session'")
    expect(tabWhen).toContain('acpSessionHasAutomation')
  })
})

describe('OpenTriggersConfigAction', () => {
  const REMOTE_FOLDER = URI.from({
    scheme: REMOTE_SCHEME,
    authority: 'dev',
    path: '/home/testuser/proj',
  })
  const CONFIG_URI = `${REMOTE_FOLDER.toString()}/.universe-editor/triggers.json`

  function makeAccessor(folder: URI | undefined) {
    const ensureConfigFile = vi.fn(async () => CONFIG_URI)
    const openEditor = vi.fn(async () => undefined)
    const notify = vi.fn()
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }
    const services = new Map<unknown, unknown>([
      [
        ITriggerMainService,
        { _serviceBrand: undefined, ensureConfigFile, onDidChangeTriggers: undefined },
      ],
      [IQuickInputService, { _serviceBrand: undefined }],
      [INotificationService, { _serviceBrand: undefined, notify }],
      [IDialogService, { _serviceBrand: undefined }],
      [IEditorResolverService, { _serviceBrand: undefined, openEditor }],
      [ILogFilesService, { _serviceBrand: undefined }],
      [IOutputService, { _serviceBrand: undefined }],
      [ILayoutService, { _serviceBrand: undefined }],
      [IViewsService, { _serviceBrand: undefined }],
      [
        IWorkspaceService,
        {
          _serviceBrand: undefined,
          current: folder === undefined ? null : { folder },
        },
      ],
      [ILoggerService, { _serviceBrand: undefined, createLogger: () => logger }],
      // The trigger action snapshot includes the command service (the action
      // menu's "Open trigger manager" entry routes through the command).
      [ICommandService, { _serviceBrand: undefined, executeCommand: vi.fn() }],
      [IAcpAgentRegistry, { _serviceBrand: undefined, defaultAgentId: () => 'claude-code' }],
    ])
    const accessor = {
      get: (id: unknown) => {
        const service = services.get(id)
        if (service === undefined) throw new Error('unexpected service lookup')
        return service
      },
    } as unknown as ServicesAccessor
    return { accessor, ensureConfigFile, openEditor, notify }
  }

  it('creates and opens the config for a remote workspace', async () => {
    const { accessor, ensureConfigFile, openEditor, notify } = makeAccessor(REMOTE_FOLDER)

    await new OpenTriggersConfigAction().run(accessor)

    expect(ensureConfigFile).toHaveBeenCalledWith(REMOTE_FOLDER.toString())
    expect(openEditor).toHaveBeenCalledTimes(1)
    const [uri, options] = openEditor.mock.calls[0] as unknown as [URI, { pinned: boolean }]
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.toString()).toBe(CONFIG_URI)
    expect(options).toEqual({ pinned: true })
    expect(notify).not.toHaveBeenCalled()
  })

  it('warns instead of calling main when the window has no workspace', async () => {
    const { accessor, ensureConfigFile, openEditor, notify } = makeAccessor(undefined)

    await new OpenTriggersConfigAction().run(accessor)

    expect(ensureConfigFile).not.toHaveBeenCalled()
    expect(openEditor).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('trigger confirmation dialogs', () => {
  function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
    return {
      key: 'ws\u0000alpha',
      id: 'alpha',
      name: 'Alpha',
      fingerprint: 'fp-alpha',
      workspace: 'file:///X:/workspace',
      workspaceName: 'workspace',
      sourceType: 'manual',
      source: { type: 'manual' },
      status: 'paused',
      enabled: true,
      paused: true,
      pausedAll: false,
      autoPaused: false,
      activationConfirmed: false,
      elevatedMode: false,
      running: 0,
      queued: 0,
      consecutiveFailures: 0,
      ...overrides,
    }
  }

  function makeServices(result: IConfirmResult, defaultAgentId = 'claude-code') {
    const confirmActivation = vi.fn(async () => undefined)
    const setPaused = vi.fn(async () => undefined)
    const confirm = vi.fn(async (_options: IConfirmOptions) => result)
    const notify = vi.fn()
    const services = {
      triggers: { confirmActivation, setPaused },
      dialogs: { confirm },
      notifications: { notify },
      logger: { warn: vi.fn() },
      agents: { defaultAgentId: () => defaultAgentId },
    } as unknown as TriggerActionServices
    return { services, confirm, confirmActivation, setPaused, notify }
  }

  it('offers Confirm and Resume when this is the last gate and the trigger is paused', async () => {
    const { services, confirm, confirmActivation, setPaused } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })

    await confirmTriggerActivation(services, summary())

    const options = confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions
    expect(options.buttons).toHaveLength(2)
    expect(options.primaryButton).toBeUndefined()
    expect(confirmActivation).toHaveBeenCalledWith('ws\u0000alpha', 'fp-alpha')
    expect(setPaused).toHaveBeenCalledWith('ws\u0000alpha', false)
  })

  it('passes the fingerprint shown in the dialog so a changed definition is refused', async () => {
    const { services, confirmActivation } = makeServices({ confirmed: true, choice: 'primary' })

    await confirmTriggerActivation(
      services,
      summary({
        paused: false,
        status: 'needs-confirmation',
        fingerprint: 'fp-shown-in-dialog',
      }),
    )

    expect(confirmActivation).toHaveBeenCalledWith('ws\u0000alpha', 'fp-shown-in-dialog')
  })

  it('keeps the trigger paused when only confirmation is picked', async () => {
    const { services, confirm, confirmActivation, setPaused } = makeServices({
      confirmed: false,
      choice: 'secondary',
      choiceIndex: 1,
    })

    await confirmTriggerActivation(services, summary())

    expect((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).buttons).toHaveLength(2)
    expect(confirmActivation).toHaveBeenCalledTimes(1)
    expect(setPaused).not.toHaveBeenCalled()
  })

  it('stays a single-button dialog when the trigger is not paused', async () => {
    const { services, confirm, confirmActivation, setPaused } = makeServices({
      confirmed: true,
      choice: 'primary',
    })

    await confirmTriggerActivation(
      services,
      summary({ paused: false, status: 'needs-confirmation' }),
    )

    const options = confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions
    expect(options.buttons).toBeUndefined()
    expect(confirmActivation).toHaveBeenCalledTimes(1)
    expect(setPaused).not.toHaveBeenCalled()
  })

  it('lists the whole definition and adds the elevated / event warnings', async () => {
    const { services, confirm } = makeServices({ confirmed: true, choice: 'primary' })

    await confirmTriggerActivation(
      services,
      summary({
        paused: false,
        status: 'needs-confirmation',
        sourceType: 'poll',
        source: {
          type: 'poll',
          intervalSec: 600,
          fetch: { type: 'command', command: 'node scripts/fetch.js', timeoutSec: 60 },
          keyField: 'id',
        },
        elevatedMode: true,
        session: {
          agent: 'codex',
          mode: 'agent-full-access',
          skill: 'triage',
          mcpServers: ['swarm', 'git'],
        },
      }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Agent: codex')
    expect(detail).toContain('Mode: agent-full-access')
    expect(detail).toContain('Skill: triage')
    expect(detail).toContain('Poll command: node scripts/fetch.js')
    expect(detail).toContain('MCP servers: swarm, git')
    expect(detail).toContain('High-privilege mode')
    expect(detail).toContain('does not cover the content of referenced skill or script files')
  })

  it('adds the external-system warning for an elevated event trigger', async () => {
    const { services, confirm } = makeServices({ confirmed: true, choice: 'primary' })

    await confirmTriggerActivation(
      services,
      summary({
        paused: false,
        sourceType: 'event',
        source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        elevatedMode: true,
        session: { agent: 'claude-code', mode: 'bypassPermissions' },
      }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('High-privilege mode')
    expect(detail).toContain('external system')
  })

  it('shows the conservative default mode when the session does not pin one', async () => {
    const { services, confirm } = makeServices({ confirmed: true, choice: 'primary' })

    await confirmTriggerActivation(
      services,
      summary({ paused: false, session: { agent: 'claude-code', skill: 'triage' } }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Mode: Default (default)')
    expect(detail).toContain('MCP servers: Not set')
    expect(detail).not.toContain('High-privilege mode')
    expect(detail).not.toContain('external system')
  })

  it('uses the registry default agent and its conservative mode when none is pinned', async () => {
    const { services, confirm } = makeServices({ confirmed: true, choice: 'primary' }, 'codex')

    await confirmTriggerActivation(
      services,
      summary({ paused: false, session: { skill: 'triage' } }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Agent: codex')
    expect(detail).toContain('Mode: Default (read-only)')
  })

  it('asks for an explicit mode when the agent has no conservative default', async () => {
    const { services, confirm } = makeServices(
      { confirmed: true, choice: 'primary' },
      'custom-agent',
    )

    await confirmTriggerActivation(services, summary({ paused: false, session: {} }))

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Agent: custom-agent')
    expect(detail).toContain('Must be configured explicitly')
  })

  it('says no high-privilege warning for a non-elevated event trigger', async () => {
    const { services, confirm } = makeServices({ confirmed: true, choice: 'primary' })

    await confirmTriggerActivation(
      services,
      summary({
        paused: false,
        sourceType: 'event',
        source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        session: { agent: 'claude-code', mode: 'default' },
      }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Trigger source:')
    expect(detail).not.toContain('High-privilege mode')
  })
})
