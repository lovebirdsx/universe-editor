import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
  URI,
  runWithInvocationModifiers,
} from '@universe-editor/platform'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import { FindMarkdownFileReferencesAction } from '../markdownFileReferencesActions.js'

const showReferences = vi.fn(async () => undefined)
vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({ Uri: { parse: (s: string) => s } }),
    getCommandService: async () => ({ executeCommand: showReferences }),
  },
}))
vi.mock('../../services/languageFeatures/typescript/lspMonacoConvert.js', () => ({
  locationToMonaco: (l: unknown) => l,
}))

const openWithTargetMocks = vi.hoisted(() => ({
  openUriEditor: vi.fn(
    async (
      _services: unknown,
      _target: unknown,
      _resource: unknown,
      _openDefault: unknown,
      _options: unknown,
    ) => true,
  ),
  openTargetServicesFrom: vi.fn(() => ({ marker: 'services' })),
}))
vi.mock('../../services/editor/openWithTarget.js', () => openWithTargetMocks)

async function runAction(
  target: URI,
  mods?: { ctrlKey?: boolean; altKey?: boolean },
): Promise<{ openEditor: ReturnType<typeof vi.fn> }> {
  const openEditor = vi.fn(async () => undefined)
  const services = new ServiceCollection(
    [
      IExtensionHostClientService,
      {
        activateByEvent: async () => undefined,
        executeContributedCommand: async () => [
          { uri: 'file:///repo/a.md', range: { start: {}, end: {} } },
        ],
      } as never,
    ],
    [IEditorResolverService, { openEditor } as never],
  )
  const inst = new InstantiationService(services)
  const invoke = (): Promise<void> =>
    inst.invokeFunction((accessor) =>
      new FindMarkdownFileReferencesAction().run(accessor, { resource: target }),
    )
  // The modifier is read in the synchronous part of run(), before the host awaits.
  await (mods ? runWithInvocationModifiers(mods, invoke) : invoke())
  return { openEditor }
}

beforeEach(() => {
  showReferences.mockClear()
  openWithTargetMocks.openUriEditor.mockClear()
  openWithTargetMocks.openTargetServicesFrom.mockClear()
  openWithTargetMocks.openUriEditor.mockResolvedValue(true)
})

describe('FindMarkdownFileReferencesAction', () => {
  it('opens the target after the extension-host awaits (accessor read up front)', async () => {
    const target = URI.file('/repo/README.md')

    // invokeFunction returns once the sync part ends; the accessor is dead by
    // the time the awaited command resolves, so a late accessor.get would reject.
    const { openEditor } = await runAction(target)

    expect(openEditor).toHaveBeenCalledWith(target, { pinned: true })
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('opens the target to the side under Ctrl and still shows the peek', async () => {
    const target = URI.file('/repo/README.md')

    const { openEditor } = await runAction(target, { ctrlKey: true })

    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openTargetServicesFrom).toHaveBeenCalledOnce()
    const [services, openTarget, resource, , options] =
      openWithTargetMocks.openUriEditor.mock.calls[0]!
    expect(services).toEqual({ marker: 'services', resolver: expect.anything() })
    expect(openTarget).toBe('side')
    expect((resource as URI).toString()).toBe(target.toString())
    expect(options).toEqual({ pinned: true })
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('keeps the peek when the targeted open falls back to the default', async () => {
    const target = URI.file('/repo/README.md')
    openWithTargetMocks.openUriEditor.mockResolvedValueOnce(false)

    const { openEditor } = await runAction(target, { ctrlKey: true })

    // openUriEditor already ran openDefault internally; the action only skips
    // the peek when a *successful* new-window open would land elsewhere.
    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openUriEditor).toHaveBeenCalledOnce()
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('skips the peek when the target opens into a new window', async () => {
    const target = URI.file('/repo/README.md')

    const { openEditor } = await runAction(target, { altKey: true })

    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openUriEditor).toHaveBeenCalledOnce()
    expect(showReferences).not.toHaveBeenCalled()
  })
})
