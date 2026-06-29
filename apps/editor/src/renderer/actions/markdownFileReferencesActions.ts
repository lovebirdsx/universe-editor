/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  "Find File References" for markdown: list every link across the workspace that
 *  points at a given .md file, shown in Monaco's references peek.
 *
 *  The locations come from the markdown plugin (its language service has the
 *  cross-file link index); the peek is hosted here in the renderer. We resolve
 *  the target file (explorer right-click arg, or the active editor), open it so a
 *  code editor exists to anchor the peek, then invoke Monaco's `showReferences`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorResolverService,
  MenuId,
  URI,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type { Location } from 'vscode-languageserver-types'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { locationToMonaco } from '../services/languageFeatures/typescript/lspMonacoConvert.js'

const MARKDOWN_FILE_REFERENCES_COMMAND = 'markdown.getFileReferences'
const CATEGORY = localize2('command.category.markdown', 'Markdown')

/** The explorer context menu passes `{ resource, target, … }` as the first arg. */
interface ExplorerMenuArg {
  readonly resource?: URI
}

function resolveTarget(arg: unknown): URI | undefined {
  const fromMenu = (arg as ExplorerMenuArg | undefined)?.resource
  if (!fromMenu) return undefined
  return URI.isUri(fromMenu) ? fromMenu : (URI.revive(fromMenu) ?? undefined)
}

function isMarkdown(uri: URI): boolean {
  return /\.(md|markdown)$/i.test(uri.path)
}

export class FindMarkdownFileReferencesAction extends Action2 {
  static readonly ID = 'markdown.findFileReferences'
  constructor() {
    super({
      id: FindMarkdownFileReferencesAction.ID,
      title: localize2('action.markdown.findFileReferences', 'Find File References'),
      category: CATEGORY,
      menu: [
        {
          id: MenuId.ExplorerContext,
          group: '4_search',
          when: 'resourceExtname == .md || resourceExtname == .markdown',
        },
      ],
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTarget(arg)
    if (!target || !isMarkdown(target)) return

    const client = accessor.get(IExtensionHostClientService)
    await client.activateByEvent('onLanguage:markdown')
    const locations = (await client.executeContributedCommand(MARKDOWN_FILE_REFERENCES_COMMAND, [
      target.toString(),
    ])) as Location[] | undefined
    if (!locations || locations.length === 0) return

    // Open the target so a code editor anchors the peek (VSCode opens it too).
    await accessor.get(IEditorResolverService).openEditor(target, { pinned: true })

    const monacoNs = MonacoLoader.get()
    const commandService = await MonacoLoader.getCommandService()
    await commandService.executeCommand(
      'editor.action.showReferences',
      monacoNs.Uri.parse(target.toString()),
      { lineNumber: 1, column: 1 },
      locations.map((l) => locationToMonaco(l, monacoNs)),
    )
  }
}
