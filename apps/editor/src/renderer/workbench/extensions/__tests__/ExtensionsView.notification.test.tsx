/*---------------------------------------------------------------------------------------------
 *  The in-view notification strip.
 *
 *  Two things are worth guarding here. First, the strip is driven by the facade's
 *  `getExtensionsNotification()` — dismissing it must go back through the facade
 *  rather than being swallowed locally. Second, and less obvious: the strip is a
 *  *sibling* of the flat row list, not a row in it. If it ever became a row, every
 *  index below it would shift and the arrow keys would land on the wrong
 *  extension, which the last case here fails on.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  Severity,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { ExtensionsView } from '../ExtensionsView.js'
import {
  EnablementState,
  IExtensionsWorkbenchService,
  type IExtensionEntry,
  type IExtensionsNotification,
} from '../../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ServicesContext } from '../../useService.js'

function entry(id: string, over: Partial<IExtensionEntry> = {}): IExtensionEntry {
  return {
    id,
    displayName: id,
    publisher: 'acme',
    description: `${id} description`,
    version: '1.0.0',
    installed: true,
    outdated: false,
    installing: false,
    isBuiltin: false,
    isUnderDevelopment: false,
    enabled: true,
    enablementState: EnablementState.EnabledGlobally,
    isVersionIncompatible: false,
    installIncompatible: false,
    ...over,
  } as IExtensionEntry
}

function setup(input: {
  installed?: readonly IExtensionEntry[]
  notification?: IExtensionsNotification
}) {
  const workbench = {
    _serviceBrand: undefined,
    onDidChange: new Emitter<void>().event,
    isMarketplaceEnabled: vi.fn(async () => false),
    getInstalled: vi.fn(() => input.installed ?? []),
    getSearchResults: vi.fn(() => []),
    searchText: '',
    searching: false,
    search: vi.fn(async () => undefined),
    loadFeatured: vi.fn(async () => undefined),
    refreshInstalled: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    installVSIX: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    setEnablement: vi.fn(async () => undefined),
    installInRemote: vi.fn(async () => undefined),
    canInstallInRemote: vi.fn(async () => true),
    hasWorkspace: vi.fn(() => false),
    getReadme: vi.fn(async () => ''),
    getIcon: vi.fn(async () => ''),
    find: vi.fn(() => undefined),
    update: vi.fn(async () => true),
    getExtensionsNotification: vi.fn(() => input.notification),
    dismissExtensionsNotification: vi.fn(),
  }
  const services = new ServiceCollection()
  services.set(IExtensionsWorkbenchService, workbench as unknown as IExtensionsWorkbenchService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorServiceType)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { workbench }
}

const list = () => screen.getByRole('listbox')
const focusedLabels = () =>
  [...document.querySelectorAll<HTMLElement>('[data-row-key][aria-selected="true"]')].map(
    (el) => el.textContent ?? '',
  )

afterEach(() => cleanup())

describe('ExtensionsView notification strip', () => {
  it('renders nothing when the facade has no notification', () => {
    setup({ installed: [entry('acme.one')] })
    expect(screen.queryByTestId('extensions-notification')).toBeNull()
  })

  it('shows the pending-update message with its action', () => {
    const updateAll = vi.fn()
    setup({
      installed: [entry('acme.old', { outdated: true, updateVersion: '2.0.0' })],
      notification: {
        kind: 'updates',
        severity: Severity.Info,
        message: '1 extension update(s) are available.',
        actions: [{ label: 'Update All', run: updateAll }],
      },
    })

    const strip = screen.getByTestId('extensions-notification')
    expect(strip.getAttribute('data-kind')).toBe('updates')
    expect(strip.textContent).toContain('1 extension update(s) are available.')
    fireEvent.click(screen.getByRole('button', { name: 'Update All' }))
    expect(updateAll).toHaveBeenCalledTimes(1)
  })

  it('dismisses through the facade, not locally', () => {
    const { workbench } = setup({
      notification: {
        kind: 'failed',
        severity: Severity.Warning,
        message: 'Could not check for updates: network unreachable',
        actions: [],
      },
    })

    fireEvent.click(screen.getByTestId('extensions-notification-dismiss'))
    expect(workbench.dismissExtensionsNotification).toHaveBeenCalledTimes(1)
  })

  it('leaves the arrow-key index space untouched', () => {
    setup({
      installed: [entry('acme.one'), entry('acme.two')],
      notification: {
        kind: 'updates',
        severity: Severity.Info,
        message: '1 extension update(s) are available.',
        actions: [{ label: 'Update All', run: vi.fn() }],
      },
    })

    // Header -> first entry -> second entry, exactly as without the strip.
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.one')
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.two')
    fireEvent.keyDown(list(), { key: 'End' })
    expect(focusedLabels()[0]).toContain('acme.two')
  })
})
