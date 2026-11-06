/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  "Find File References" for TypeScript/JavaScript: list every file that
 *  imports the target file, shown in Monaco's references peek.
 *
 *  The locations come from the TypeScript plugin (tsserver's `fileReferences`
 *  through TSLS); the peek is hosted here in the renderer, mirroring the
 *  markdown sibling. We resolve the target (explorer/tab context arg, or the
 *  active editor), open it so a code editor exists to anchor the peek, then
 *  invoke Monaco's `showReferences`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorResolverService,
  IProgressService,
  MenuId,
  ProgressLocation,
  REMOTE_SCHEME,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type { Location } from 'vscode-languageserver-types'
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import { openTargetServicesFrom, openUriEditor } from '../services/editor/openWithTarget.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { locationToMonaco } from '../services/languageFeatures/typescript/lspMonacoConvert.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  activeEditorFileResource,
  RESOURCE_FILE_OR_REMOTE_WHEN,
  resolvePrimaryTarget,
} from './fileActionsCommon.js'

const TYPESCRIPT_FILE_REFERENCES_COMMAND = 'typescript.getFileReferences'
const CATEGORY = localize2('command.category.typescript', 'TypeScript')

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const TS_JS_LANGUAGES = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']

const TS_JS_EXT_WHEN = TS_JS_EXTENSIONS.map((ext) => `resourceExtname == ${ext}`).join(' || ')
const langWhen = (key: string): string =>
  TS_JS_LANGUAGES.map((lang) => `${key} == ${lang}`).join(' || ')

function isTypeScriptLike(uri: URI): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(uri.path)
}

/** Raw string command args skip the remote `$mid` codec; translate the
 *  renderer's REMOTE_SCHEME into the extension host's `file:` space. */
function toHostFileUriString(target: URI): string {
  if (target.scheme !== REMOTE_SCHEME) return target.toString()
  return URI.from({
    scheme: 'file',
    path: target.path,
    query: target.query,
    fragment: target.fragment,
  }).toString()
}

export class FindTypeScriptFileReferencesAction extends Action2 {
  static readonly ID = 'typescript.findAllFileReferences'
  constructor() {
    super({
      id: FindTypeScriptFileReferencesAction.ID,
      icon: 'go-to-file',
      title: localize2('action.typescript.findFileReferences', 'Find File References'),
      category: CATEGORY,
      // Ctrl+K Ctrl+F is Monaco's Format Selection; R stands for References.
      keybinding: { primary: ['ctrl+k', 'ctrl+r'] },
      menu: [
        { id: MenuId.CommandPalette, when: langWhen('editorLangId') },
        {
          id: MenuId.EditorTabContext,
          group: '4_search',
          when: `(${langWhen('activeEditorLanguageId')}) && ${RESOURCE_FILE_OR_REMOTE_WHEN}`,
        },
        {
          id: MenuId.ExplorerContext,
          group: '4_search',
          when: `!explorerResourceIsFolder && (${TS_JS_EXT_WHEN}) && ${RESOURCE_FILE_OR_REMOTE_WHEN}`,
        },
      ],
      // Language gating belongs to the explicit CommandPalette entry above:
      // registerAction2 merges `precondition` into every menu's when.
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const target = resolvePrimaryTarget(args) ?? activeEditorFileResource(accessor)
    if (!target || !isTypeScriptLike(target)) return

    // The accessor dies at the first await; snapshot every service up front.
    const client = accessor.get(IExtensionHostClientService)
    const resolver = accessor.get(IEditorResolverService)
    const progress = accessor.get(IProgressService)
    const openTarget = invocationOpenTarget()
    const targetServices =
      openTarget === 'default' ? undefined : { ...openTargetServicesFrom(accessor), resolver }

    const locations = await progress.withProgress(
      {
        location: ProgressLocation.Window,
        title: localize('lsp.findFileReferences', 'Finding file references…'),
      },
      async () => {
        try {
          await client.activateByEvent('onCommand:typescript.getFileReferences')
          const result = await client.executeContributedCommand(
            TYPESCRIPT_FILE_REFERENCES_COMMAND,
            [toHostFileUriString(target)],
          )
          return Array.isArray(result) ? (result as Location[]) : []
        } catch (err) {
          console.warn('[typescript] find file references failed', err)
          return []
        }
      },
    )
    if (locations.length === 0) return

    // Open the target so a code editor anchors the peek (VSCode opens it too).
    const openDefault = (): Promise<unknown> => resolver.openEditor(target, { pinned: true })
    let openedViaTarget = false
    if (targetServices) {
      openedViaTarget = await openUriEditor(targetServices, openTarget, target, openDefault, {
        pinned: true,
      })
    } else {
      await openDefault()
    }
    // The auxiliary window is a different renderer/Monaco; the peek cannot
    // follow the editor there. Side opens stay in this window and still show it.
    if (openTarget === 'newWindow' && openedViaTarget) return

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
