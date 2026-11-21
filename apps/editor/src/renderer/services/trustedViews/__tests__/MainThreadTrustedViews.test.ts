import { describe, expect, it, vi } from 'vitest'
import { URI, type IEditorService } from '@universe-editor/platform'
import type { ITrustedEditorOpenDto } from '@universe-editor/extensions-common'
import { MainThreadTrustedViews } from '../MainThreadTrustedViews.js'
import type { ITrustedViewRegistration, ITrustedViewService } from '../TrustedViewService.js'
import { TrustedViewEditorInput } from '../../editor/TrustedViewEditorInput.js'

const VIEW: ITrustedViewRegistration = {
  viewId: 'acme.status',
  extensionId: 'acme.ext',
  extensionLocation: URI.file('/ext'),
  contribution: {
    id: 'acme.status',
    name: 'Acme Status',
    location: 'editor',
    entry: './dist/renderer/status.js',
  },
}

function setup(registration: ITrustedViewRegistration | null = VIEW) {
  const trustedViews = {
    getView: vi.fn().mockReturnValue(registration),
    markProviderRegistered: vi.fn(),
    markProviderPending: vi.fn(),
    markProviderUnregistered: vi.fn(),
    postEvent: vi.fn(),
  } as unknown as ITrustedViewService
  const opened: TrustedViewEditorInput[] = []
  const editorService = {
    openEditor: vi.fn((input: TrustedViewEditorInput) => {
      opened.push(input)
      return input
    }),
  } as unknown as IEditorService
  return {
    mainThread: new MainThreadTrustedViews(trustedViews, editorService),
    trustedViews,
    editorService,
    opened,
  }
}

const OPTIONS: ITrustedEditorOpenDto = {
  title: null,
  state: null,
  key: null,
  preserveFocus: false,
}

describe('MainThreadTrustedViews', () => {
  it('accepts a provider only from the extension that owns the view', async () => {
    const { mainThread, trustedViews } = setup()
    await expect(mainThread.$registerProvider('acme.ext', 'acme.status')).resolves.toBeUndefined()
    expect(trustedViews.markProviderRegistered).toHaveBeenCalledWith('acme.status')

    await expect(mainThread.$registerProvider('evil.ext', 'acme.status')).rejects.toThrow(
      /cannot provide trusted view/,
    )
  })

  it('defers providers for views that are not translated yet (untrusted startup activation)', async () => {
    const { mainThread, trustedViews } = setup(null)
    await expect(mainThread.$registerProvider('acme.ext', 'acme.status')).resolves.toBeUndefined()
    expect(trustedViews.markProviderPending).toHaveBeenCalledWith('acme.ext', 'acme.status')
    expect(trustedViews.markProviderRegistered).not.toHaveBeenCalled()
  })

  it('opens an editor tab and dedupes by view + key', async () => {
    const { mainThread, opened, editorService } = setup()
    await mainThread.$openEditor('acme.ext', 'acme.status', { ...OPTIONS, key: 'main' })
    await mainThread.$openEditor('acme.ext', 'acme.status', { ...OPTIONS, key: 'main' })
    expect(opened).toHaveLength(2)
    expect(opened[0]!.id).toBe(opened[1]!.id)
    expect(editorService.openEditor).toHaveBeenLastCalledWith(expect.any(TrustedViewEditorInput), {
      activate: true,
      preserveFocus: false,
      pinned: true,
    })
  })

  it('opens a fresh tab when no key is given', async () => {
    const { mainThread, opened } = setup()
    await mainThread.$openEditor('acme.ext', 'acme.status', OPTIONS)
    await mainThread.$openEditor('acme.ext', 'acme.status', OPTIONS)
    expect(opened[0]!.id).not.toBe(opened[1]!.id)
  })

  it('rejects an extension that does not own the view, or a sidebar view', async () => {
    const { mainThread } = setup()
    await expect(mainThread.$openEditor('evil.ext', 'acme.status', OPTIONS)).rejects.toThrow(
      /does not own/,
    )
    await expect(
      mainThread.$openEditor('acme.ext', 'acme.status', { ...OPTIONS, preserveFocus: true }),
    ).resolves.toBeUndefined()

    const sidebar = setup({
      ...VIEW,
      contribution: { ...VIEW.contribution, location: 'view', container: 'explorer' },
    })
    await expect(
      sidebar.mainThread.$openEditor('acme.ext', 'acme.status', OPTIONS),
    ).rejects.toThrow(/sidebar view/)
  })

  it('forwards session events and provider unregistration', async () => {
    const { mainThread, trustedViews } = setup()
    await mainThread.$postEvent('session-1', 'update', { n: 1 })
    expect(trustedViews.postEvent).toHaveBeenCalledWith('session-1', 'update', { n: 1 })
    await mainThread.$unregisterProvider('acme.status')
    expect(trustedViews.markProviderUnregistered).toHaveBeenCalledWith('acme.status')
  })

  it('rejects when the editor service fails to open the tab', async () => {
    const { mainThread, editorService } = setup()
    vi.mocked(editorService.openEditor).mockImplementationOnce(() => {
      throw new Error('open failed')
    })
    await expect(mainThread.$openEditor('acme.ext', 'acme.status', OPTIONS)).rejects.toThrow(
      /open failed/,
    )
  })
})
