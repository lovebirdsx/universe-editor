/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Explorer file comparison actions (VSCode parity):
 *   - Select for Compare: remember a file as the left-hand side.
 *   - Compare with Selected: diff the right-clicked file against the remembered one.
 *   - Compare Selected: diff exactly two selected files directly.
 *  All are context-menu only (no command palette entry).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  localize,
  localize2,
  type ServicesAccessor,
  type URI,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { ICompareService } from '../services/explorer/CompareService.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { WebviewDiffInput } from '../services/editor/WebviewDiffInput.js'
import { confirmLargeFile } from '../services/editor/largeFileGuard.js'
import { sameUri } from '../services/explorer/explorerTreeUtils.js'
import { implicitPrimaryTarget, resolvePrimaryTarget } from './fileActionsCommon.js'

/** Last path segment of a URI, for diff tab labels. */
function basenameOf(uri: URI): string {
  const p = uri.path
  const slash = p.lastIndexOf('/')
  return slash >= 0 ? p.slice(slash + 1) : p
}

/**
 * Read both files (after a large-file guard on each) and open a cross-file diff
 * with `left` on the original side and `right` on the modified side. Snapshots
 * every service up front so the accessor is not used after the first await.
 *
 * When the right-hand resource resolves to a custom editor that declares
 * `supportsDiff` (e.g. the Excel viewer for `.xlsx`), the comparison is handed to
 * that editor as a WebviewDiffInput over the two sides' raw bytes; otherwise it
 * falls back to the built-in Monaco text diff.
 */
async function openFileDiff(accessor: ServicesAccessor, left: URI, right: URI): Promise<void> {
  const fileService = accessor.get(IFileService)
  const dialog = accessor.get(IDialogService)
  const editorService = accessor.get(IEditorService)
  const editorResolver = accessor.get(IEditorResolverService)
  if (sameUri(left, right)) return
  if (!(await confirmLargeFile(left, fileService, dialog))) return
  if (!(await confirmLargeFile(right, fileService, dialog))) return

  const custom = editorResolver.resolveEditors(right)[0]
  try {
    if (custom?.info.supportsDiff && custom.info.viewType) {
      const [leftBytes, rightBytes] = await Promise.all([
        fileService.readFile(left),
        fileService.readFile(right),
      ])
      editorService.openEditor(
        new WebviewDiffInput(
          custom.info.viewType,
          left,
          right,
          leftBytes,
          rightBytes,
          `${basenameOf(left)} ↔ ${basenameOf(right)}`,
        ),
        { pinned: true },
      )
      return
    }
    const [leftText, rightText] = await Promise.all([
      fileService.readFileText(left),
      fileService.readFileText(right),
    ])
    editorService.openEditor(new DiffEditorInput(left, leftText, rightText, right), {
      pinned: true,
    })
  } catch (err) {
    await dialog.confirm({
      message: localize('dialog.file.compare.error', 'Failed to compare'),
      detail: err instanceof Error ? err.message : String(err),
      type: 'error',
    })
  }
}

export class SelectForCompareAction extends Action2 {
  static readonly ID = 'selectForCompare'
  constructor() {
    super({
      id: SelectForCompareAction.ID,
      title: localize2('action.selectForCompare.title', 'Select for Compare'),
      category: localize2('command.category.file', 'File'),
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor, ...args: unknown[]): void {
    const tree = accessor.get(IExplorerTreeService)
    const target = resolvePrimaryTarget(args) ?? implicitPrimaryTarget(accessor)
    if (!target || tree.isRoot(target)) return
    accessor.get(ICompareService).selectForCompare(target)
  }
}

export class CompareWithSelectedAction extends Action2 {
  static readonly ID = 'compareSelected'
  constructor() {
    super({
      id: CompareWithSelectedAction.ID,
      title: localize2('action.compareWithSelected.title', 'Compare with Selected'),
      category: localize2('command.category.file', 'File'),
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const target = resolvePrimaryTarget(args) ?? implicitPrimaryTarget(accessor)
    const selected = accessor.get(ICompareService).selectedResource
    if (!target || !selected || tree.isRoot(target)) return
    await openFileDiff(accessor, selected, target)
  }
}

export class CompareSelectedAction extends Action2 {
  static readonly ID = 'workbench.files.action.compareFiles'
  constructor() {
    super({
      id: CompareSelectedAction.ID,
      title: localize2('action.compareFiles.title', 'Compare Selected'),
      category: localize2('command.category.file', 'File'),
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const tree = accessor.get(IExplorerTreeService)
    const files = tree.selection.filter((uri) => !tree.isDirectory(uri) && !tree.isRoot(uri))
    if (files.length !== 2) return
    await openFileDiff(accessor, files[0]!, files[1]!)
  }
}
