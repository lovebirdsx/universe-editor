/**
 * `MainThreadEditor` backs the extension `workspace.openTextDocument` overloads.
 * The options overload creates an untitled model (`$openUntitledDocument`): the
 * buffer gets a fresh `Untitled-N` identity, carries the requested content and
 * language, and is attached to the mirror pipeline so the host sees it as a
 * TextDocument. `$openTextDocument` with an `untitled:` URI synthesizes the empty
 * model the host asked for. These need the real Monaco stub (model creation,
 * setModelLanguage) so they run in the renderer-dom project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  URI,
  type IEditorGroupsService,
  type IEditorService,
  type IFileService,
  type IInstantiationService,
  type ILogger,
  type IUriIdentityService,
  type UriComponents,
} from '@universe-editor/platform'
import { MainThreadEditor } from '../MainThreadEditor.js'
import { DocumentMirrorTracking } from '../DocumentMirrorTracking.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

const logger = { warn: vi.fn(), info: vi.fn() } as unknown as ILogger

describe('MainThreadEditor untitled documents', () => {
  const tracked: string[] = []
  const tracker = {
    trackModel: (resource: { toString(): string }) => {
      tracked.push(resource.toString())
      return true
    },
    isTracked: () => false,
    whenOpened: () => Promise.resolve(true),
  }

  beforeEach(() => {
    tracked.length = 0
    DocumentMirrorTracking.register(tracker)
  })

  afterEach(async () => {
    DocumentMirrorTracking.unregister(tracker)
    MonacoModelRegistry._resetForTests()
    vi.mocked(logger.warn).mockClear()
  })

  function makeEditor(): MainThreadEditor {
    const instantiation = {
      // The constructor eagerly builds FileBulkEditService; a no-op stands in.
      createInstance: () => ({ apply: vi.fn() }),
    } as unknown as IInstantiationService
    return new MainThreadEditor(
      {} as IEditorService,
      {} as IUriIdentityService,
      undefined,
      {} as IFileService,
      {} as IEditorGroupsService,
      instantiation,
      logger,
    )
  }

  it('$openUntitledDocument creates a mirrored model with content and language', async () => {
    const mt = makeEditor()
    await mt.$openUntitledDocument({ language: 'markdown', content: '# hi' })
    expect(tracked).toHaveLength(1)
    expect(tracked[0]).toContain('untitled:')
    expect(tracked[0]).toMatch(/Untitled-\d+/)
    const model = MonacoModelRegistry.peek(URI.parse(tracked[0]!))
    expect(model?.getValue()).toBe('# hi')
    expect(model?.getLanguageId()).toBe('markdown')
  })

  it('$openUntitledDocument defaults to an empty plaintext buffer', async () => {
    const mt = makeEditor()
    await mt.$openUntitledDocument({})
    const model = MonacoModelRegistry.peek(URI.parse(tracked[0]!))
    expect(model?.getValue()).toBe('')
    expect(model?.getLanguageId()).toBe('plaintext')
  })

  it('$openTextDocument with an untitled URI synthesizes an empty model and tracks it', async () => {
    const mt = makeEditor()
    const uri: UriComponents = { scheme: 'untitled', path: '/Untitled-7' } as UriComponents
    await mt.$openTextDocument(uri)
    expect(tracked).toEqual(['untitled:/Untitled-7'])
    const model = MonacoModelRegistry.peek(URI.parse('untitled:/Untitled-7'))
    expect(model?.getValue()).toBe('')
  })

  it('warns when the mirror pipeline is unavailable', async () => {
    DocumentMirrorTracking.unregister(tracker)
    const mt = makeEditor()
    await mt.$openUntitledDocument({})
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mirror pipeline unavailable'))
  })
})
