/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger report menu entries: the chat context menu (gated on
 *  the trigger automation of the session it was raised on) and the session tab
 *  context menu (gated on the tab's automation).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileSystemError,
  ICommandService,
  IDialogService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  REMOTE_SCHEME,
  URI,
  Severity,
  registerAction2,
  type IConfirmOptions,
  type IConfirmResult,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  ITriggerMainService,
  type TriggerPollPreview,
  type TriggerPollPreviewItem,
} from '../../../shared/ipc/triggerService.js'
import { ILogFilesService } from '../../../shared/ipc/services.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  OpenTriggersConfigAction,
  ViewTriggerReportAction,
  confirmTriggerActivation,
  runTriggerAction,
  runTriggerNow,
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
      // The snapshot also carries the services used by the activation preview.
      [IFileService, { _serviceBrand: undefined }],
      [IEditorService, { _serviceBrand: undefined }],
      [IEditorGroupsService, { _serviceBrand: undefined }],
      [IUriIdentityService, { _serviceBrand: undefined }],
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
    const openEditor = vi.fn((input: unknown) => input)
    const openConfig = vi.fn(async () => undefined)
    const files = {
      stat: vi.fn(async (): Promise<{ mtime: number }> => {
        throw new FileSystemError('not found', 'ENOENT')
      }),
      readFileText: vi.fn(async (): Promise<string> => ''),
    }
    const services = {
      triggers: { confirmActivation, setPaused },
      dialogs: { confirm },
      notifications: { notify },
      logger: { warn: vi.fn() },
      agents: { defaultAgentId: () => defaultAgentId },
      files,
      editorService: { openEditor },
      editors: { openEditor: openConfig, createEditorInput: vi.fn((uri: URI) => ({ uri })) },
      groups: { groups: [] },
      uriIdentity: { isEqual: (a: URI, b: URI) => a.toString() === b.toString() },
    } as unknown as TriggerActionServices
    return {
      services,
      confirm,
      confirmActivation,
      setPaused,
      notify,
      files,
      openEditor,
      openConfig,
    }
  }

  it('offers Confirm and Resume when this is the last gate and the trigger is paused', async () => {
    const { services, confirm, confirmActivation, setPaused } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })

    await confirmTriggerActivation(services, summary())

    const options = confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions
    expect(options.buttons).toHaveLength(3)
    expect(options.buttons?.[0]).toBe('Confirm and Resume')
    expect(options.buttons?.[1]).toBe('Confirm Only')
    expect(options.buttons?.[2]).toBe('View Full Definition')
    expect(options.primaryButton).toBeUndefined()
    expect(confirmActivation).toHaveBeenCalledWith('ws\u0000alpha', 'fp-alpha')
    expect(setPaused).toHaveBeenCalledWith('ws\u0000alpha', false)
  })

  it('passes the fingerprint shown in the dialog so a changed definition is refused', async () => {
    const { services, confirmActivation } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })

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

    expect((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).buttons).toHaveLength(3)
    expect(confirmActivation).toHaveBeenCalledTimes(1)
    expect(setPaused).not.toHaveBeenCalled()
  })

  it('keeps two buttons when the trigger is not paused', async () => {
    const { services, confirm, confirmActivation, setPaused } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })

    await confirmTriggerActivation(
      services,
      summary({ paused: false, status: 'needs-confirmation' }),
    )

    const options = confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions
    expect(options.buttons).toEqual(['Enable Trigger', 'View Full Definition'])
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

  it('previews the prompt, budget, concurrency and showSession from the full definition', async () => {
    const { services, confirm, files } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })
    const definition = {
      version: 1,
      triggers: [
        {
          id: 'alpha',
          name: 'Alpha',
          source: { type: 'manual' },
          session: {
            prompt: 'Summarize the day\nand mention every failure',
            budget: { maxCostUsd: 2.5, timeoutMin: 45, approvalTimeoutMin: 1440 },
          },
          concurrency: 2,
          overflow: 'drop',
          showSession: true,
        },
      ],
    }
    files.stat.mockResolvedValue({ mtime: 1 })
    files.readFileText.mockResolvedValue(JSON.stringify(definition))

    await confirmTriggerActivation(
      services,
      summary({ paused: false, status: 'needs-confirmation' }),
    )

    const detail = String((confirm.mock.calls[0]?.[0] as unknown as IConfirmOptions).detail)
    expect(detail).toContain('Prompt: Summarize the day and mention every failure')
    expect(detail).toContain('$2.50')
    expect(detail).toContain('run timeout 45 min')
    expect(detail).toContain('approval timeout 1440 min')
    expect(detail).toContain('Concurrency: 2 · when busy: Drop')
    expect(detail).toContain('Reveal the session while it runs: yes')
  })

  it('reveals the definition and asks again when View Full Definition is picked', async () => {
    const { services, confirm, confirmActivation, openConfig } = makeServices({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 0,
    })
    confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary',
      choiceIndex: 1,
    })

    await confirmTriggerActivation(
      services,
      summary({ paused: false, status: 'needs-confirmation' }),
    )

    expect(openConfig).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirmActivation).toHaveBeenCalledTimes(1)
  })
})

describe('runTriggerNow', () => {
  const ITEM: TriggerPollPreviewItem = {
    key: 'poll:item-1',
    value: 'item-1',
    title: 'Fix flaky',
    payload: { id: 'item-1', title: 'Fix flaky' },
    processed: false,
  }
  const PROCESSED: TriggerPollPreviewItem = {
    key: 'poll:item-2',
    value: 'item-2',
    payload: { id: 'item-2' },
    processed: true,
  }

  function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
    return {
      key: 'ws\u0000poller',
      id: 'poller',
      name: 'Poller',
      fingerprint: 'fp-poller',
      workspace: 'file:///X:/workspace',
      workspaceName: 'workspace',
      sourceType: 'poll',
      source: {
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'command', command: 'node poll.js', timeoutSec: 10 },
        keyField: 'id',
      },
      status: 'idle',
      enabled: true,
      paused: false,
      pausedAll: false,
      autoPaused: false,
      activationConfirmed: true,
      elevatedMode: false,
      running: 0,
      queued: 0,
      consecutiveFailures: 0,
      ...overrides,
    }
  }

  function makeServices(
    preview: TriggerPollPreview,
    picked: { readonly id: string } | null = { id: ITEM.key },
  ) {
    const runNow = vi.fn(async () => undefined)
    const previewPollEvents = vi.fn(async (_triggerKey: string) => preview)
    const pick = vi.fn(async (_items: readonly unknown[]) => picked ?? undefined)
    const notify = vi.fn((_opts: unknown) => ({ id: 'notification-1' }))
    const dismiss = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }
    const services = {
      triggers: { runNow, previewPollEvents },
      quickInput: { pick },
      notifications: { notify, dismiss },
      logger,
    } as unknown as TriggerActionServices
    return { services, runNow, previewPollEvents, pick, notify, dismiss }
  }

  function notificationAt(
    notify: ReturnType<typeof makeServices>['notify'],
    index: number,
  ): { severity: Severity; message: string; sticky?: boolean } {
    return notify.mock.calls[index]?.[0] as {
      severity: Severity
      message: string
      sticky?: boolean
    }
  }

  it('runs non-poll sources directly without previewing', async () => {
    const { services, runNow, previewPollEvents, notify } = makeServices({
      kind: 'ok',
      items: [],
    })

    await runTriggerNow(services, summary({ sourceType: 'manual', source: { type: 'manual' } }))

    expect(previewPollEvents).not.toHaveBeenCalled()
    expect(runNow).toHaveBeenCalledWith('ws\u0000poller')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notificationAt(notify, 0).severity).toBe(Severity.Info)
    expect(notificationAt(notify, 0).message).toContain('queued to run')
  })

  it('previews, picks an item, and runs with its payload and source key', async () => {
    const { services, runNow, previewPollEvents, pick, notify, dismiss } = makeServices({
      kind: 'ok',
      items: [ITEM, PROCESSED],
    })

    await runTriggerNow(services, summary())

    expect(previewPollEvents).toHaveBeenCalledWith('ws\u0000poller')
    expect(notificationAt(notify, 0)).toMatchObject({
      severity: Severity.Info,
      sticky: true,
    })
    expect(dismiss).toHaveBeenCalledWith('notification-1')
    const [items, options] = pick.mock.calls[0] as unknown as [
      readonly { id: string; label: string; description?: string }[],
      { id: string; matchOnDescription: boolean },
    ]
    expect(items[0]).toEqual({
      id: 'poll:item-1',
      label: 'item-1',
      description: 'Fix flaky',
    })
    expect(String(items[1]?.label)).toContain('already processed')
    expect(options).toMatchObject({
      id: 'workbench.triggers.pollEvent',
      matchOnDescription: true,
    })
    expect(runNow).toHaveBeenCalledWith('ws\u0000poller', {
      payload: ITEM.payload,
      sourceKey: ITEM.key,
    })
    expect(notificationAt(notify, 1).message).toContain('queued to run')
  })

  it('stops silently when the item picker is cancelled', async () => {
    const { services, runNow, pick, notify, dismiss } = makeServices(
      { kind: 'ok', items: [ITEM] },
      null,
    )

    await runTriggerNow(services, summary())

    expect(pick).toHaveBeenCalledTimes(1)
    expect(runNow).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledWith('notification-1')
  })

  it('warns for unavailable previews without opening the picker', async () => {
    const paused = makeServices({ kind: 'unavailable', reason: 'all-paused' })
    await runTriggerNow(paused.services, summary())
    expect(paused.pick).not.toHaveBeenCalled()
    expect(paused.runNow).not.toHaveBeenCalled()
    expect(notificationAt(paused.notify, 1)).toMatchObject({
      severity: Severity.Warning,
      message: 'All triggers are paused',
    })

    const failed = makeServices({
      kind: 'unavailable',
      reason: 'poll-failed',
      detail: 'boom',
    })
    await runTriggerNow(failed.services, summary())
    expect(failed.pick).not.toHaveBeenCalled()
    expect(failed.runNow).not.toHaveBeenCalled()
    expect(notificationAt(failed.notify, 1).severity).toBe(Severity.Warning)
    expect(notificationAt(failed.notify, 1).message).toContain('boom')
  })

  it('tells the user when the poll returned no events', async () => {
    const { services, runNow, pick, notify } = makeServices({ kind: 'ok', items: [] })

    await runTriggerNow(services, summary())

    expect(pick).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
    expect(notificationAt(notify, 1).severity).toBe(Severity.Info)
    expect(notificationAt(notify, 1).message).toContain('no events')
  })

  it('falls back to a plain run when the summary claims poll but main says unsupported', async () => {
    const { services, runNow, notify } = makeServices({ kind: 'unsupported' })

    await runTriggerNow(services, summary())

    expect(runNow).toHaveBeenCalledWith('ws\u0000poller')
    expect(notificationAt(notify, 1).message).toContain('queued to run')
  })

  it('reports a rejected preview through the shared command error path', async () => {
    const { services, previewPollEvents, notify, dismiss } = makeServices({
      kind: 'ok',
      items: [],
    })
    previewPollEvents.mockRejectedValueOnce(new Error('rpc down'))

    await runTriggerAction(services, () => runTriggerNow(services, summary()))

    expect(dismiss).toHaveBeenCalledWith('notification-1')
    const errorCall = notify.mock.calls
      .map(([opts]) => opts as { severity: Severity; message: string })
      .find((opts) => opts.severity === Severity.Error)
    expect(errorCall?.message).toContain('rpc down')
  })
})
