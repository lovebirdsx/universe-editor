/*---------------------------------------------------------------------------------------------
 *  Dropping a `.vsix` onto the Extensions view installs it; dropping anything else
 *  surfaces an error notification and installs nothing. The path→URI mapping goes
 *  through `window.ipc.getPathForFile` (as in the real preload), so the test stubs
 *  that bridge.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { IExtensionsWorkbenchService } from '../../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ServicesContext } from '../../useService.js'

function makeWorkbench() {
  const onDidChange = new Emitter<void>()
  return {
    _serviceBrand: undefined,
    onDidChange: onDidChange.event,
    isMarketplaceEnabled: vi.fn(async () => false),
    getInstalled: vi.fn(() => []),
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
    hasWorkspace: vi.fn(() => false),
    getReadme: vi.fn(async () => ''),
    getIcon: vi.fn(async () => ''),
    find: vi.fn(() => undefined),
  }
}

function setup() {
  const workbench = makeWorkbench()
  const notify = vi.fn()
  const services = new ServiceCollection()
  services.set(IExtensionsWorkbenchService, workbench as unknown as IExtensionsWorkbenchService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify,
  } as unknown as INotificationServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { workbench, notify }
}

/** Build a drop event whose dataTransfer carries the given File-like entries. */
function dropEventInit(names: string[]): { dataTransfer: DataTransfer } {
  const files = names.map((name) => ({ name }) as File)
  const dataTransfer = {
    files,
    items: files.map((f) => ({ kind: 'file', type: '', getAsFile: () => f })),
    types: ['Files'],
    getData: () => '',
  } as unknown as DataTransfer
  return { dataTransfer }
}

describe('ExtensionsView drag-and-drop install', () => {
  beforeEach(() => {
    // Preload bridge: map the dropped File back to an absolute path by its name.
    vi.stubGlobal('window', {
      ...globalThis.window,
      ipc: { getPathForFile: (f: File) => `/dropped/${f.name}` },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('installs a dropped .vsix', () => {
    const { workbench, notify } = setup()
    const view = screen.getByTestId('extensions-view')
    fireEvent.drop(view, dropEventInit(['acme.ext.vsix']))
    expect(workbench.installVSIX).toHaveBeenCalledWith('/dropped/acme.ext.vsix')
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects a drop containing a non-.vsix file and installs nothing', () => {
    const { workbench, notify } = setup()
    const view = screen.getByTestId('extensions-view')
    fireEvent.drop(view, dropEventInit(['acme.ext.vsix', 'readme.txt']))
    expect(workbench.installVSIX).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Error }))
  })
})
