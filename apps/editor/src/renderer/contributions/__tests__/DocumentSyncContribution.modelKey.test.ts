/**
 * Regression for the Windows-only wait-miss: the did-save pipeline calls
 * whenOpened() for a Save-As target BEFORE the replacement file model exists,
 * predicting the mirror key from the resource. That prediction must equal the
 * key the mounted model itself produces — Monaco serializes the drive-letter
 * colon as `%3A` (`file:///c%3A/…`), so a platform-style prediction
 * (`file:///c:/…`) never matches and the waiter burned the full
 * MIRROR_OPEN_TIMEOUT_MS (did-save landed 5s late, or was pushed for a URI the
 * host had never seen open and got dropped).
 *
 * Runs against the monaco test stub, whose Uri.toString replicates the real
 * encoding — the pre-fix stub echoed its input identically and masked this.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Event,
  URI,
  constObservable,
  type IEditorService,
  type ILoggerService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { DocumentSyncContribution } from '../DocumentSyncContribution.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'

const stubEditorService = {
  activeEditor: constObservable(undefined),
} as unknown as IEditorService
const stubWorkspace = {
  onDidChangeWorkspace: Event.None,
} as unknown as IWorkspaceService
const stubLoggerService = {
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
} as unknown as ILoggerService

describe('DocumentSyncContribution predicted mirror key', () => {
  let contribution: DocumentSyncContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
    MonacoModelRegistry._resetForTests()
  })

  function setup() {
    const documents = {
      $acceptDocumentOpen: vi.fn().mockResolvedValue(undefined),
      $acceptDocumentChange: vi.fn().mockResolvedValue(undefined),
      $acceptDocumentClose: vi.fn().mockResolvedValue(undefined),
    }
    const client = {
      getDocuments: () => documents,
      activateByEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionHostClientService
    contribution = new DocumentSyncContribution(
      stubEditorService,
      stubWorkspace,
      client,
      stubLoggerService,
    )
    return { documents }
  }

  it('whenOpened resolves through the predicted key once the model mounts (Windows drive path)', async () => {
    const { documents } = setup()
    const resource = URI.parse('file:///C:/ws/saved.txt')
    let settled: boolean | undefined
    const pending = contribution!.whenOpened(resource, 200).then((v) => {
      settled = v
    })
    const model = MonacoModelRegistry.acquire(resource, 'body')
    contribution!.trackModel(resource, model)
    await pending
    expect(settled).toBe(true)
    expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
  })

  it('whenOpened resolves for paths carrying characters monaco percent-encodes', async () => {
    setup()
    const resource = URI.parse('file:///D:/ws/report (final), v2.txt')
    const model = MonacoModelRegistry.acquire(resource, 'body')
    const settled = contribution!.whenOpened(resource, 200)
    contribution!.trackModel(resource, model)
    await expect(settled).resolves.toBe(true)
  })
})
