/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reversible Explorer file operations. Modeled on VSCode's bulkFileEdits.ts but
 *  driven directly by IFileService (no working-copy layer). Each operation runs
 *  on disk and returns its inverse; the batch is pushed onto IUndoRedoService as
 *  a single Workspace element under a shared Explorer UndoRedoSource, so Ctrl+Z /
 *  Ctrl+Y in the Explorer walk the file-operation history.
 *
 *  Delete is special: the OS trash cannot be programmatically restored, so file
 *  contents are backed up to memory before deletion and rewritten on undo.
 *  Entries larger than MAX_UNDO_FILE_SIZE are not backed up and therefore not
 *  restorable (the whole entry still goes to trash / is deleted).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  IFileService,
  type ILogger,
  ILoggerService,
  IUndoRedoService,
  type IWorkspaceUndoRedoElement,
  UndoRedoElementType,
  UndoRedoGroup,
  UndoRedoSource,
  URI,
} from '@universe-editor/platform'
import {
  ExplorerTreeService,
  IExplorerTreeService,
  type IExplorerResourceOperation,
  type IFileRenameOperation,
} from './ExplorerTreeService.js'
import { basenameOf, incrementFileName, targetInDirectory } from './explorerFileOperations.js'
import { isDescendant, parentOf, sameUri } from './explorerTreeUtils.js'

/** Files larger than this (bytes) are not backed up for undo on delete. */
const MAX_UNDO_FILE_SIZE = 10 * 1024 * 1024

/** Shared source so the Explorer's undo/redo commands target only file operations. */
export const EXPLORER_UNDO_SOURCE = new UndoRedoSource()

export const IExplorerFileOperationService = createDecorator<ExplorerFileOperationService>(
  'explorerFileOperationService',
)

/** In-memory snapshot of a deleted subtree, used to recreate it on undo. */
interface IDeletedBackup {
  /** Directories to recreate (deepest-last order not required; createDirectory is recursive). */
  readonly directories: URI[]
  /** Files to recreate with their byte contents. */
  readonly files: { resource: URI; contents: Uint8Array }[]
  /** True when some entry exceeded the size limit and was not backed up. */
  readonly truncated: boolean
}

interface IReversibleOperation {
  /** Run the operation and return its inverse (for undo/redo alternation). */
  perform(): Promise<IReversibleOperation>
  /** Resources touched, for the undo-redo element's resource set. */
  readonly uris: URI[]
}

export class ExplorerFileOperationService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IExplorerTreeService private readonly _tree: ExplorerTreeService,
    @IFileService private readonly _fileService: IFileService,
    @IUndoRedoService private readonly _undoRedo: IUndoRedoService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, {
      id: 'explorerFileOps',
      name: 'Explorer File Ops',
    })
  }

  // ---- public API mirroring the tree CRUD the commands used to call directly ----

  async createFile(parent: URI, name: string): Promise<URI> {
    const target = URI.joinPath(parent, name)
    if (await this._fileService.exists(target)) {
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    await this._fileService.writeFile(target, '')
    await this._tree.refresh(parent)
    this._pushCreate([{ resource: target, isDirectory: false }])
    this._logger.info(`createFile ${target.toString()}`)
    return target
  }

  async createFolder(parent: URI, name: string): Promise<URI> {
    const target = URI.joinPath(parent, name)
    if (await this._fileService.exists(target)) {
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    await this._fileService.createDirectory(target)
    await this._tree.refresh(parent)
    this._pushCreate([{ resource: target, isDirectory: true }])
    this._logger.info(`createFolder ${target.toString()}`)
    return target
  }

  async rename(source: URI, newName: string): Promise<URI> {
    const parent = parentOf(source)
    if (!parent) throw new Error('Cannot rename the workspace root.')
    const target = URI.joinPath(parent, newName)
    const isDirectory = this._tree.isDirectory(source)
    await this._fileService.rename(source, target, { overwrite: false })
    this._tree.forgetSubtree(source)
    await this._tree.refresh(parent)
    this._tree.notifyDidRunFileOperation([{ oldUri: source, newUri: target, isDirectory }])
    this._pushRename([{ oldUri: source, newUri: target, isDirectory }])
    this._logger.info(`rename ${source.toString()} -> ${target.toString()}`)
    return target
  }

  async delete(targets: readonly IExplorerResourceOperation[], useTrash: boolean): Promise<void> {
    const performed: IFileRenameOperation[] = []
    const backups: IDeletedBackup[] = []
    for (const target of targets) {
      const backup = await this._backup(target.resource, target.isDirectory)
      await this._fileService.delete(target.resource, {
        recursive: target.isDirectory,
        useTrash,
      })
      this._tree.forgetSubtree(target.resource)
      backups.push(backup)
      performed.push({
        oldUri: target.resource,
        newUri: target.resource,
        isDirectory: target.isDirectory,
      })
    }
    await this._tree.refreshParents(targets.map((t) => t.resource))
    this._pushDelete(backups)
    this._logger.info(`delete count=${targets.length} useTrash=${useTrash}`)
  }

  async duplicate(source: IExplorerResourceOperation, newName: string): Promise<URI> {
    const parent = parentOf(source.resource)
    if (!parent) throw new Error('Cannot duplicate a resource without a parent.')
    const target = URI.joinPath(parent, newName)
    if (await this._fileService.exists(target)) {
      throw new Error(`A file or folder named "${newName}" already exists.`)
    }
    await this._fileService.copy(source.resource, target, { overwrite: false })
    await this._tree.refresh(parent)
    this._pushCreate([{ resource: target, isDirectory: source.isDirectory }])
    this._logger.info(`duplicate ${source.resource.toString()} -> ${target.toString()}`)
    return target
  }

  async copyResources(
    resources: readonly IExplorerResourceOperation[],
    destinationDir: URI,
  ): Promise<URI[]> {
    const created: IExplorerResourceOperation[] = []
    for (const source of resources) {
      this._assertCanPlace(source, destinationDir)
      const target = await this._findAvailableCopyTarget(source, destinationDir)
      await this._fileService.copy(source.resource, target, { overwrite: false })
      created.push({ resource: target, isDirectory: source.isDirectory })
    }
    await this._tree.refreshParents([
      ...resources.map((r) => r.resource),
      ...created.map((c) => c.resource),
    ])
    this._tree.selectOperationTargets(created.map((c) => c.resource))
    this._pushCreate(created)
    this._logger.info(`copy count=${created.length} destination=${destinationDir.toString()}`)
    return created.map((c) => c.resource)
  }

  async moveResources(
    resources: readonly IExplorerResourceOperation[],
    destinationDir: URI,
    opts?: { overwrite?: boolean },
  ): Promise<URI[]> {
    const overwrite = opts?.overwrite === true
    const renames: IFileRenameOperation[] = []
    for (const source of resources) {
      this._assertCanPlace(source, destinationDir)
      const target = targetInDirectory(destinationDir, source.resource)
      if (sameUri(source.resource, target)) continue
      if (!overwrite && (await this._fileService.exists(target))) {
        throw new Error(`A file or folder named "${basenameOf(target)}" already exists.`)
      }
      await this._fileService.rename(source.resource, target, { overwrite })
      this._tree.forgetSubtree(source.resource)
      renames.push({ oldUri: source.resource, newUri: target, isDirectory: source.isDirectory })
    }
    await this._tree.refreshParents([
      ...resources.map((r) => r.resource),
      ...renames.map((r) => r.newUri),
    ])
    this._tree.selectOperationTargets(renames.map((r) => r.newUri))
    if (renames.length > 0) {
      this._tree.notifyDidRunFileOperation(renames)
      this._pushRename(renames)
    }
    this._logger.info(`move count=${renames.length} destination=${destinationDir.toString()}`)
    return renames.map((r) => r.newUri)
  }

  // ---- undo/redo element construction ----

  private _pushCreate(created: readonly IExplorerResourceOperation[]): void {
    const op = new CreateOperation(
      this,
      created.map((c) => ({ ...c })),
    )
    this._pushElement(
      op,
      created.map((c) => c.resource),
      'file.create',
      'Create',
    )
  }

  private _pushDelete(backups: readonly IDeletedBackup[]): void {
    const uris = backups.flatMap((b) => [...b.directories, ...b.files.map((f) => f.resource)])
    const op = new DeleteOperation(this, backups)
    this._pushElement(op, uris, 'file.delete', 'Delete')
  }

  private _pushRename(renames: readonly IFileRenameOperation[]): void {
    const op = new RenameOperation(
      this,
      renames.map((r) => ({ ...r })),
    )
    const uris = renames.flatMap((r) => [r.oldUri, r.newUri])
    this._pushElement(op, uris, 'file.rename', 'Rename')
  }

  private _pushElement(
    initial: IReversibleOperation,
    uris: readonly URI[],
    code: string,
    label: string,
  ): void {
    const element = new FileOperationUndoRedoElement(label, code, initial, uris)
    this._undoRedo.pushElement(element, new UndoRedoGroup(), EXPLORER_UNDO_SOURCE)
  }

  // ---- low-level primitives used by the reversible operations ----

  /** @internal Recreate a previously-deleted subtree from its in-memory backup. Returns fresh backup for redo. */
  async recreateFromBackup(backups: readonly IDeletedBackup[]): Promise<void> {
    for (const backup of backups) {
      for (const dir of backup.directories) {
        await this._fileService.createDirectory(dir)
      }
      for (const file of backup.files) {
        const parent = parentOf(file.resource)
        if (parent) await this._fileService.createDirectory(parent)
        await this._fileService.writeFile(file.resource, file.contents)
      }
    }
    await this._tree.refreshParents(
      backups.flatMap((b) => [...b.directories, ...b.files.map((f) => f.resource)]),
    )
  }

  /** @internal Delete resources (permanent — undo of a create). */
  async deletePermanent(targets: readonly IExplorerResourceOperation[]): Promise<void> {
    for (const target of targets) {
      if (await this._fileService.exists(target.resource)) {
        await this._fileService.delete(target.resource, { recursive: true })
      }
      this._tree.forgetSubtree(target.resource)
    }
    await this._tree.refreshParents(targets.map((t) => t.resource))
  }

  /** @internal Move source->target (undo/redo of a rename). */
  async applyRename(renames: readonly IFileRenameOperation[]): Promise<void> {
    for (const rename of renames) {
      await this._fileService.rename(rename.oldUri, rename.newUri, { overwrite: false })
      this._tree.forgetSubtree(rename.oldUri)
    }
    await this._tree.refreshParents(renames.flatMap((r) => [r.oldUri, r.newUri]))
    this._tree.notifyDidRunFileOperation(renames)
  }

  /** @internal Re-create files as backups (redo of a delete): read from disk into a new backup. */
  async backupAll(targets: readonly IExplorerResourceOperation[]): Promise<IDeletedBackup[]> {
    const out: IDeletedBackup[] = []
    for (const target of targets) {
      out.push(await this._backup(target.resource, target.isDirectory))
    }
    return out
  }

  private async _backup(resource: URI, isDirectory: boolean): Promise<IDeletedBackup> {
    const directories: URI[] = []
    const files: { resource: URI; contents: Uint8Array }[] = []
    let truncated = false

    const walkFile = async (fileUri: URI): Promise<void> => {
      try {
        const stat = await this._fileService.stat(fileUri)
        if (stat.size > MAX_UNDO_FILE_SIZE) {
          truncated = true
          return
        }
        files.push({ resource: fileUri, contents: await this._fileService.readFile(fileUri) })
      } catch {
        truncated = true
      }
    }

    const walkDir = async (dirUri: URI): Promise<void> => {
      directories.push(dirUri)
      let entries
      try {
        entries = await this._fileService.list(dirUri)
      } catch {
        truncated = true
        return
      }
      for (const entry of entries) {
        const child = URI.joinPath(dirUri, entry.name)
        if (entry.isDirectory) {
          await walkDir(child)
        } else {
          await walkFile(child)
        }
      }
    }

    if (isDirectory) {
      await walkDir(resource)
    } else {
      await walkFile(resource)
    }
    return { directories, files, truncated }
  }

  private _assertCanPlace(source: IExplorerResourceOperation, destinationDir: URI): void {
    if (this._tree.isRoot(source.resource)) {
      throw new Error('Cannot move or copy the workspace root.')
    }
    if (source.isDirectory && isDescendant(source.resource, destinationDir)) {
      throw new Error('Cannot place a folder inside itself or one of its descendants.')
    }
  }

  private async _findAvailableCopyTarget(
    source: IExplorerResourceOperation,
    destinationDir: URI,
  ): Promise<URI> {
    let name = basenameOf(source.resource)
    for (let i = 0; i < 200; i++) {
      const candidate = URI.joinPath(destinationDir, name)
      if (!(await this._fileService.exists(candidate))) return candidate
      name = incrementFileName(name, source.isDirectory)
    }
    throw new Error('Unable to find an available copy target.')
  }
}

// ---- reversible operations (each perform() returns its inverse) ----

class CreateOperation implements IReversibleOperation {
  constructor(
    private readonly _service: ExplorerFileOperationService,
    private readonly _created: IExplorerResourceOperation[],
  ) {}

  get uris(): URI[] {
    return this._created.map((c) => c.resource)
  }

  async perform(): Promise<IReversibleOperation> {
    // redo of a create: re-backup current disk state so a following undo restores it.
    const backups = await this._service.backupAll(this._created)
    await this._service.deletePermanent(this._created)
    return new DeleteOperation(this._service, backups)
  }
}

class DeleteOperation implements IReversibleOperation {
  constructor(
    private readonly _service: ExplorerFileOperationService,
    private readonly _backups: readonly IDeletedBackup[],
  ) {}

  get uris(): URI[] {
    return this._backups.flatMap((b) => [...b.directories, ...b.files.map((f) => f.resource)])
  }

  async perform(): Promise<IReversibleOperation> {
    // undo of a delete: recreate everything from backup.
    await this._service.recreateFromBackup(this._backups)
    const created: IExplorerResourceOperation[] = [
      ...this._backups.flatMap((b) =>
        b.directories.map((d) => ({ resource: d, isDirectory: true })),
      ),
      ...this._backups.flatMap((b) =>
        b.files.map((f) => ({ resource: f.resource, isDirectory: false })),
      ),
    ]
    return new CreateOperation(this._service, dedupeTopLevel(created))
  }
}

class RenameOperation implements IReversibleOperation {
  constructor(
    private readonly _service: ExplorerFileOperationService,
    private readonly _renames: IFileRenameOperation[],
  ) {}

  get uris(): URI[] {
    return this._renames.flatMap((r) => [r.oldUri, r.newUri])
  }

  async perform(): Promise<IReversibleOperation> {
    const reverse = this._renames.map((r) => ({
      oldUri: r.newUri,
      newUri: r.oldUri,
      isDirectory: r.isDirectory,
    }))
    await this._service.applyRename(reverse)
    return new RenameOperation(this._service, reverse)
  }
}

/**
 * For CreateOperation.perform we only need the top-level created entries to
 * delete (delete is recursive), so drop entries nested under another entry.
 */
function dedupeTopLevel(ops: IExplorerResourceOperation[]): IExplorerResourceOperation[] {
  const sorted = [...ops].sort((a, b) => a.resource.path.length - b.resource.path.length)
  const kept: IExplorerResourceOperation[] = []
  for (const op of sorted) {
    const nested = kept.some(
      (k) =>
        k.isDirectory &&
        (op.resource.path === k.resource.path ||
          op.resource.path.startsWith(k.resource.path + '/')),
    )
    if (!nested) kept.push(op)
  }
  return kept
}

class FileOperationUndoRedoElement implements IWorkspaceUndoRedoElement {
  readonly type = UndoRedoElementType.Workspace
  private _operation: IReversibleOperation

  constructor(
    readonly label: string,
    readonly code: string,
    operation: IReversibleOperation,
    readonly resources: readonly URI[],
  ) {
    this._operation = operation
  }

  async undo(): Promise<void> {
    this._operation = await this._operation.perform()
  }

  async redo(): Promise<void> {
    this._operation = await this._operation.perform()
  }
}
