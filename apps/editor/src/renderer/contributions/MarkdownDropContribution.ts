/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Drop-to-link enhancement for markdown (VSCode's "drop file into editor"
 *  behaviour), the drag counterpart of MarkdownPasteContribution. Registers a
 *  `documentDropEditProvider` on monaco's internal ILanguageFeaturesService —
 *  there is no public `monaco.languages.*` drop API. Two cases:
 *    - drop a file (uri-list, e.g. dragged from Explorer/OS) → `![](relPath)`
 *      for images, `[](relPath)` otherwise, relative to the workspace folder.
 *    - drop a binary image (screenshot / web image with no disk path) → written
 *      to an `assets/` folder beside the markdown file, then embedded.
 *  Monaco's own `dropIntoEditor` is enabled per-model only for markdown (see
 *  FileEditor); dropping onto the tab bar still opens the file (EditorGroupView).
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
import {
  computeMarkdownLinkInsert,
  LINK_TITLE,
  URI_LIST_MIME,
  type IVSDataTransfer,
} from './markdownLinkProviderShared.js'

const IMAGE_MIME = 'image/*'
const FILES_MIME = 'files'

interface DropEdit {
  readonly insertText: string | { readonly snippet: string }
  readonly title: string
  readonly kind?: unknown
}

interface DropProvider {
  readonly id: string
  readonly dropMimeTypes: readonly string[]
  provideDocumentDropEdits(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    dataTransfer: IVSDataTransfer,
    token: monaco.CancellationToken,
  ): Promise<{ edits: DropEdit[]; dispose(): void } | undefined>
}

export class MarkdownDropContribution extends Disposable implements IWorkbenchContribution {
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
    this._registration = features.documentDropEditProvider.register(
      { language: 'markdown' },
      this._createProvider(),
    )
    this._register({ dispose: () => this._registration?.dispose() })
  }

  private _createProvider(): DropProvider {
    return {
      id: 'universe.markdown.dropLink',
      dropMimeTypes: [URI_LIST_MIME, IMAGE_MIME, FILES_MIME],
      provideDocumentDropEdits: async (model, _position, dataTransfer, token) => {
        const snippet = await computeMarkdownLinkInsert(
          dataTransfer,
          model.uri.toString(),
          {
            workspaceFolderFsPath: this._workspace.current?.folder.fsPath,
            platform: this._uriIdentity.platform,
            fileService: this._fileService,
          },
          () => token.isCancellationRequested,
        )
        if (!snippet) return undefined
        return { edits: [{ insertText: { snippet }, title: LINK_TITLE }], dispose() {} }
      },
    }
  }
}
