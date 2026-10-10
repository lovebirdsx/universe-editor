/*---------------------------------------------------------------------------------------------
 *  The row-level Update affordance.
 *
 *  An update is a *state* (the entry carries `updateVersion`), not an event
 *  (nobody hands the row a list of updates) — so what this asserts is that the
 *  button appears exactly for the rows that carry it, and that pressing it goes
 *  through the facade's single-extension `update`, not a hand-rolled install.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { ExtensionsView } from '../ExtensionsView.js'
import {
  EnablementState,
  IExtensionsWorkbenchService,
  type IExtensionEntry,
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

function setup(installed: readonly IExtensionEntry[]) {
  const workbench = {
    _serviceBrand: undefined,
    onDidChange: new Emitter<void>().event,
    isMarketplaceEnabled: vi.fn(async () => false),
    getInstalled: vi.fn(() => installed),
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
    getExtensionsNotification: vi.fn(() => undefined),
    dismissExtensionsNotification: vi.fn(),
  }
  const services = new ServiceCollection()
  const editor = {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorServiceType
  services.set(IExtensionsWorkbenchService, workbench as unknown as IExtensionsWorkbenchService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationServiceType)
  services.set(IEditorService, editor)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { workbench, editor }
}

afterEach(() => cleanup())

describe('ExtensionsView row update affordance', () => {
  it('offers an update button only on rows that are behind', () => {
    setup([entry('acme.old', { outdated: true, updateVersion: '2.0.0' }), entry('acme.current')])

    const buttons = screen.getAllByTestId('extension-update')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('Update to v2.0.0')
  })

  it('updates that one extension when pressed, without opening the detail page', () => {
    const { workbench, editor } = setup([
      entry('acme.old', { outdated: true, updateVersion: '2.0.0' }),
    ])

    fireEvent.click(screen.getByTestId('extension-update'))
    expect(workbench.update).toHaveBeenCalledWith('acme.old')
    // The button sits inside the clickable row; the row's open-editor handler must
    // not also fire, or every update would leave a detail tab behind.
    expect(editor.openEditor).not.toHaveBeenCalled()
  })

  it('keeps the manage menu reachable next to the update button', () => {
    setup([entry('acme.old', { outdated: true, updateVersion: '2.0.0' })])
    expect(screen.getByTestId('extension-manage')).toBeTruthy()
  })

  it('shows no update button for a local-side row of a remote workspace', async () => {
    // Such a row is not running here, so a check never produces a pending update
    // for it — it offers Install in Remote instead.
    setup([entry('acme.local', { installableInRemote: true })])
    expect(screen.queryByTestId('extension-update')).toBeNull()
    // The button only enables once availability resolves, so wait for it.
    expect(await screen.findByRole('button', { name: 'Install in Remote' })).toBeTruthy()
  })

  it('replaces the button with a spinner while the install is running', () => {
    setup([entry('acme.old', { outdated: true, updateVersion: '2.0.0', installing: true })])
    expect(screen.queryByTestId('extension-update')).toBeNull()
  })
})
