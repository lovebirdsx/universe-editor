import { describe, expect, it, vi } from 'vitest'
import {
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
  URI,
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

describe('FindMarkdownFileReferencesAction', () => {
  it('opens the target after the extension-host awaits (accessor read up front)', async () => {
    const target = URI.file('/repo/README.md')
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

    // invokeFunction returns once the sync part ends; the accessor is dead by
    // the time the awaited command resolves, so a late accessor.get would reject.
    await inst.invokeFunction((accessor) =>
      new FindMarkdownFileReferencesAction().run(accessor, { resource: target }),
    )

    expect(openEditor).toHaveBeenCalledWith(target, { pinned: true })
    expect(showReferences).toHaveBeenCalledOnce()
  })
})
