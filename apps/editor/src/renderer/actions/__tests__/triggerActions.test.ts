/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger report menu entries: the chat context menu (gated on
 *  the trigger automation of the session it was raised on) and the session tab
 *  context menu (gated on the tab's automation).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { ILogFilesService } from '../../../shared/ipc/services.js'
import { OpenTriggersConfigAction, ViewTriggerReportAction } from '../triggerActions.js'

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
