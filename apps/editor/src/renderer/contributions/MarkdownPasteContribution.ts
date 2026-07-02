/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Paste-to-link enhancement for markdown (VSCode's "Insert Markdown Link" paste
 *  behaviour). Registers a `documentPasteEditProvider` on monaco's internal
 *  ILanguageFeaturesService — there is no public `monaco.languages.*` drop/paste
 *  API. Cases:
 *    - paste a file (uri-list, e.g. dragged from Explorer/OS) → `![](relPath)`
 *      for images, `[](relPath)` otherwise, relative to the workspace folder.
 *    - paste a binary image (screenshot / clipboard image with no disk path) →
 *      written to an `assets/` folder beside the markdown file, then embedded.
 *    - paste an http(s) URL while text is selected → `[selectedText](url)`.
 *  The drag counterpart lives in MarkdownDropContribution; the markdown shaping
 *  is shared via ./markdownLinkProviderShared + the pure ./markdownPasteLinks.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IFileService,
  IUriIdentityService,
  IWorkspaceService,
  type IDisposable,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { markdownLinkFromUrl } from './markdownPasteLinks.js'
import {
  computeMarkdownLinkInsert,
  LINK_TITLE,
  TEXT_MIME,
  URI_LIST_MIME,
  type IVSDataTransfer,
} from './markdownLinkProviderShared.js'

const IMAGE_MIME = 'image/*'
const FILES_MIME = 'files'

interface PasteEdit {
  readonly insertText: string | { readonly snippet: string }
  readonly title: string
  readonly handledMimeType: string
}

interface PasteProvider {
  readonly pasteMimeTypes: readonly string[]
  readonly providedPasteEditKinds: readonly unknown[]
  readonly copyMimeTypes: readonly string[]
  provideDocumentPasteEdits(
    model: monaco.editor.ITextModel,
    ranges: readonly monaco.IRange[],
    dataTransfer: IVSDataTransfer,
    context: unknown,
    token: monaco.CancellationToken,
  ): Promise<{ edits: PasteEdit[]; dispose(): void } | undefined>
}

export class MarkdownPasteContribution extends Disposable implements IWorkbenchContribution {
  private _registration: IDisposable | undefined

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super()
    void this._registerProvider()
  }

  private async _registerProvider(): Promise<void> {
    const features = await MonacoLoader.getLanguageFeaturesService()
    if (this._store.isDisposed) return
    this._registration = features.documentPasteEditProvider.register(
      { language: 'markdown' },
      this._createProvider(),
    )
    this._register({ dispose: () => this._registration?.dispose() })
  }

  private _createProvider(): PasteProvider {
    return {
      pasteMimeTypes: [URI_LIST_MIME, IMAGE_MIME, FILES_MIME, TEXT_MIME],
      providedPasteEditKinds: [],
      copyMimeTypes: [],
      provideDocumentPasteEdits: async (model, ranges, dataTransfer, _context, token) => {
        // File uri-list or a binary image (→ written to assets/ and embedded).
        // Returned as a snippet whose link text is a selected placeholder.
        const linkSnippet = await computeMarkdownLinkInsert(
          dataTransfer,
          model.uri.toString(),
          {
            workspaceFolderFsPath: this._workspace.current?.folder.fsPath,
            platform: this._uriIdentity.platform,
            fileService: this._fileService,
          },
          () => token.isCancellationRequested,
        )
        if (linkSnippet) {
          return edit({ snippet: linkSnippet }, URI_LIST_MIME)
        }

        // A bare URL pasted over a non-empty selection → `[selection](url)`.
        const textEntry = dataTransfer.get(TEXT_MIME)
        if (textEntry) {
          const text = (await textEntry.asString()).trim()
          if (token.isCancellationRequested) return undefined
          const range = ranges[0]
          const link = range && markdownLinkFromUrl(model.getValueInRange(range), text)
          if (link) {
            return edit(link, TEXT_MIME)
          }
        }
        return undefined
      },
    }
  }
}

function edit(
  insertText: string | { snippet: string },
  handledMimeType: string,
): { edits: PasteEdit[]; dispose(): void } {
  return { edits: [{ insertText, title: LINK_TITLE, handledMimeType }], dispose() {} }
}
