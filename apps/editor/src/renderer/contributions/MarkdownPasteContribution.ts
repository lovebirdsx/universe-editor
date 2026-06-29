/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Paste-to-link enhancement for markdown (VSCode's "Insert Markdown Link" paste
 *  behaviour). Registers a `documentPasteEditProvider` on monaco's internal
 *  ILanguageFeaturesService — there is no public `monaco.languages.*` drop/paste
 *  API. Two cases:
 *    - paste a file (uri-list, e.g. dragged from Explorer/OS) → `![](relPath)`
 *      for images, `[](relPath)` otherwise, relative to the workspace folder.
 *    - paste an http(s) URL while text is selected → `[selectedText](url)`.
 *  The drag-into-editor path stays disabled project-wide (the editor body owns
 *  file drags); only the paste path is enhanced here. The markdown shaping itself
 *  lives in the pure ./markdownPasteLinks helpers.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IHostService,
  IWorkspaceService,
  type IDisposable,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { markdownLinkFromUrl, markdownLinksFromUriList } from './markdownPasteLinks.js'

const URI_LIST_MIME = 'text/uri-list'
const TEXT_MIME = 'text/plain'
const TITLE = 'Insert Markdown Link'

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

interface IVSDataTransferItem {
  asString(): Promise<string>
}
interface IVSDataTransfer {
  get(mime: string): IVSDataTransferItem | undefined
}

export class MarkdownPasteContribution extends Disposable implements IWorkbenchContribution {
  private _registration: IDisposable | undefined

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IHostService private readonly _host: IHostService,
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
      pasteMimeTypes: [URI_LIST_MIME, TEXT_MIME],
      providedPasteEditKinds: [],
      copyMimeTypes: [],
      provideDocumentPasteEdits: async (model, ranges, dataTransfer, _context, token) => {
        const fileEntry = dataTransfer.get(URI_LIST_MIME)
        if (fileEntry) {
          const raw = await fileEntry.asString()
          if (token.isCancellationRequested) return undefined
          const links = markdownLinksFromUriList(
            raw,
            this._workspace.current?.folder.fsPath,
            this._host.platform,
          )
          if (links) {
            return edit(links, URI_LIST_MIME)
          }
        }

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
  return { edits: [{ insertText, title: TITLE, handledMimeType }], dispose() {} }
}
