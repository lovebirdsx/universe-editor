import {
  Action2,
  IEditorGroupsService,
  IUriIdentityService,
  IWorkspaceService,
  MenuId,
  localize2,
  type ServicesAccessor,
  type URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { sameUri } from '../services/explorer/explorerTreeUtils.js'
import { reviveUri, type ITargetArg } from './fileActionsCommon.js'
import { resolveTargetEditor } from './editorActionHelpers.js'

/**
 * Resolve every file the Copy Name/Path command should act on. From the Explorer
 * this honors multi-select (all selected rows when the invoked row is part of the
 * selection); from an editor tab or the command palette it falls back to the
 * explicit target then the active editor. Filters to on-disk (`file`) resources.
 */
function resolveUris(accessor: ServicesAccessor, args: unknown[]): URI[] {
  const arg = args[0] as ITargetArg | undefined
  const explicit = reviveUri(arg?.target ?? arg?.resource ?? null)
  const explorer = accessor.get(IExplorerTreeService)
  if (explicit) {
    const selection = explorer.selection
    if (selection.length > 1 && selection.some((uri) => sameUri(uri, explicit))) {
      return selection.filter((uri) => uri.scheme === 'file' && !explorer.isRoot(uri))
    }
    return explicit.scheme === 'file' ? [explicit] : []
  }
  const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
  const resource = active instanceof FileEditorInput ? active.resource : null
  return resource && resource.scheme === 'file' ? [resource] : []
}

export class CopyFileNameAction extends Action2 {
  static readonly ID = 'workbench.files.action.copyName'
  constructor() {
    super({
      id: CopyFileNameAction.ID,
      title: localize2('action.copyName.title', 'Copy Name'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uris = resolveUris(accessor, args)
    if (uris.length === 0) return
    const text = uris.map((uri) => uri.path.slice(uri.path.lastIndexOf('/') + 1)).join('\n')
    await navigator.clipboard.writeText(text)
  }
}

/**
 * Copy the *display name* of the clicked editor tab — for a file that is the
 * basename, but this works for every tab type (diff / settings / agent session /
 * welcome / image …) by copying the input's `getName()`, so the tab menu offers
 * "Copy Name" universally rather than only for on-disk `file:` tabs.
 */
export class CopyEditorNameAction extends Action2 {
  static readonly ID = 'workbench.action.copyEditorName'
  constructor() {
    super({
      id: CopyEditorNameAction.ID,
      title: localize2('action.copyName.title', 'Copy Name'),
      category: localize2('command.category.file', 'File'),
      menu: [{ id: MenuId.EditorTabContext, group: '2_path', order: 1 }],
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const target = resolveTargetEditor(accessor, args[0])
    const name = target?.editor.getName()
    if (!name) return
    await navigator.clipboard.writeText(name)
  }
}

export class CopyFilePathAction extends Action2 {
  static readonly ID = 'copyFilePath'
  constructor() {
    super({
      id: CopyFilePathAction.ID,
      title: localize2('action.copyFilePath.title', 'Copy Path'),
      category: localize2('command.category.file', 'File'),
      menu: [
        { id: MenuId.EditorTabContext, group: '2_path', order: 2, when: 'resourceScheme == file' },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uris = resolveUris(accessor, args)
    if (uris.length === 0) return
    await navigator.clipboard.writeText(uris.map((uri) => uri.fsPath).join('\n'))
  }
}

export class CopyFileRelativePathAction extends Action2 {
  static readonly ID = 'copyRelativeFilePath'
  constructor() {
    super({
      id: CopyFileRelativePathAction.ID,
      title: localize2('action.copyRelativeFilePath.title', 'Copy Relative Path'),
      category: localize2('command.category.file', 'File'),
      menu: [
        { id: MenuId.EditorTabContext, group: '2_path', order: 3, when: 'resourceScheme == file' },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uris = resolveUris(accessor, args)
    if (uris.length === 0) return
    const root = accessor.get(IWorkspaceService).current?.folder
    const uriId = accessor.get(IUriIdentityService)
    const text = uris
      .map((uri) => {
        if (!root) return uri.fsPath
        return uriId.relativePathUnder(root.fsPath, uri.fsPath) ?? uri.fsPath
      })
      .join('\n')
    await navigator.clipboard.writeText(text)
  }
}
