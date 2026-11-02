/*---------------------------------------------------------------------------------------------
 *  End-to-end wiring between the Extensions view body and its title-bar `…`
 *  menu: filter clicks rewrite the shared query and the list follows; hand-typed
 *  tokens flow back into the menu; menu toggles keep the marketplace debounce.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type ICommandService as ICommandServiceType,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { ExtensionsView } from '../ExtensionsView.js'
import { ExtensionsViewToolbar } from '../ExtensionsViewToolbar.js'
import {
  EnablementState,
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { EXTENSIONS_HAS_UPDATES_KEY } from '../../../services/extensionsWorkbench/extensionsViewIds.js'
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

function setup(input: { installed?: readonly IExtensionEntry[]; marketplace?: boolean } = {}) {
  const onDidChange = new Emitter<void>()
  const workbench = {
    _serviceBrand: undefined,
    onDidChange: onDidChange.event,
    isMarketplaceEnabled: vi.fn(async () => input.marketplace === true),
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
    hasWorkspace: vi.fn(() => false),
    getReadme: vi.fn(async () => ''),
    getIcon: vi.fn(async () => ''),
    find: vi.fn(() => undefined),
    getExtensionsNotification: vi.fn(() => undefined),
    dismissExtensionsNotification: vi.fn(),
    update: vi.fn(async () => true),
  }
  const executeCommand = vi.fn(async () => undefined)
  const contextKeyService = new ContextKeyService()
  contextKeyService.createKey<boolean>(EXTENSIONS_HAS_UPDATES_KEY, false)
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
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as unknown as ICommandServiceType)
  services.set(IContextKeyService, contextKeyService)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ExtensionsViewToolbar />
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { workbench, executeCommand }
}

const searchBox = () => screen.getByLabelText<HTMLInputElement>('Search Extensions')
const rows = () => screen.queryAllByTestId('extension-row')
const openMenu = () => fireEvent.click(screen.getByTestId('extensions-more-actions'))
const builtinFilter = () => screen.getByTestId('extensions-filter-builtin')
const updatesFilter = () => screen.getByTestId('extensions-filter-updates')

afterEach(() => cleanup())

describe('ExtensionsView + title-bar filter menu', () => {
  it('filters to built-ins and restores the installed list', () => {
    setup({
      installed: [entry('acme.user'), entry('@universe-editor/git', { isBuiltin: true })],
    })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('acme.user')

    openMenu()
    fireEvent.click(builtinFilter())

    expect(searchBox().value).toBe('@builtin')
    expect(screen.getByTestId('extension-section-header').textContent).toContain('Built-in')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('@universe-editor/git')

    fireEvent.click(builtinFilter())
    expect(searchBox().value).toBe('')
    expect(rows()[0]!.textContent).toContain('acme.user')
  })

  it('filters to installed extensions with updates', () => {
    setup({
      installed: [entry('acme.old', { outdated: true, updateVersion: '2.0.0' }), entry('acme.new')],
    })

    openMenu()
    fireEvent.click(updatesFilter())

    expect(searchBox().value).toBe('@updates')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('acme.old')
  })

  it('syncs the menu checkmark with a hand-typed token', () => {
    setup({ installed: [entry('acme.user')] })

    fireEvent.change(searchBox(), { target: { value: '@OUTDATED' } })
    openMenu()

    expect(updatesFilter().getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the 300ms marketplace debounce for typed text and local tokens', async () => {
    const { workbench } = setup({ installed: [] })

    fireEvent.change(searchBox(), { target: { value: 'eslint' } })
    await waitFor(() => expect(workbench.search).toHaveBeenCalledWith('eslint'), { timeout: 1500 })

    fireEvent.change(searchBox(), { target: { value: '@builtin' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(workbench.search).not.toHaveBeenCalledWith('@builtin')

    fireEvent.change(searchBox(), { target: { value: '' } })
    await waitFor(() => expect(workbench.loadFeatured).toHaveBeenCalled(), { timeout: 1500 })
  })

  it('searches the marketplace when a menu toggle leaves a text query', async () => {
    const { workbench } = setup({ installed: [] })

    fireEvent.change(searchBox(), { target: { value: '@builtin monokai' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(workbench.search).not.toHaveBeenCalled()

    openMenu()
    fireEvent.click(builtinFilter())

    expect(searchBox().value).toBe('monokai')
    await waitFor(() => expect(workbench.search).toHaveBeenCalledWith('monokai'), { timeout: 1500 })
  })
})
