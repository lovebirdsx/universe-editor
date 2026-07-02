import {
  Action2,
  IEditorGroupsService,
  IUriIdentityService,
  IWorkspaceService,
  MenuId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { reviveUri, type ITargetArg } from './fileActionsCommon.js'

function resolveUri(accessor: ServicesAccessor, args: unknown[]) {
  const arg = args[0] as ITargetArg | undefined
  const explicit = reviveUri(arg?.target ?? arg?.resource ?? null)
  if (explicit) return explicit
  const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
  return active instanceof FileEditorInput ? active.resource : null
}

export class CopyFileNameAction extends Action2 {
  static readonly ID = 'workbench.files.action.copyName'
  constructor() {
    super({
      id: CopyFileNameAction.ID,
      title: localize2('action.copyName.title', 'Copy Name'),
      category: localize2('command.category.file', 'File'),
      menu: [{ id: MenuId.EditorTabContext, group: '2_path', order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uri = resolveUri(accessor, args)
    if (!uri || uri.scheme !== 'file') return
    await navigator.clipboard.writeText(uri.path.slice(uri.path.lastIndexOf('/') + 1))
  }
}

export class CopyFilePathAction extends Action2 {
  static readonly ID = 'copyFilePath'
  constructor() {
    super({
      id: CopyFilePathAction.ID,
      title: localize2('action.copyFilePath.title', 'Copy Path'),
      category: localize2('command.category.file', 'File'),
      menu: [{ id: MenuId.EditorTabContext, group: '2_path', order: 2 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uri = resolveUri(accessor, args)
    if (!uri || uri.scheme !== 'file') return
    await navigator.clipboard.writeText(uri.fsPath)
  }
}

export class CopyFileRelativePathAction extends Action2 {
  static readonly ID = 'copyRelativeFilePath'
  constructor() {
    super({
      id: CopyFileRelativePathAction.ID,
      title: localize2('action.copyRelativeFilePath.title', 'Copy Relative Path'),
      category: localize2('command.category.file', 'File'),
      menu: [{ id: MenuId.EditorTabContext, group: '2_path', order: 3 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const uri = resolveUri(accessor, args)
    if (!uri || uri.scheme !== 'file') return
    const root = accessor.get(IWorkspaceService).current?.folder
    let value = uri.fsPath
    if (root) {
      const relativePath = accessor
        .get(IUriIdentityService)
        .relativePathUnder(root.fsPath, uri.fsPath)
      value = relativePath ?? value
    }
    await navigator.clipboard.writeText(value)
  }
}
