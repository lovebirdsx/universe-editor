/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File breadcrumb picker model: a lazy directory tree backed by IFileService,
 *  reusing the Explorer's filtering/sorting helpers so both surfaces list a
 *  folder identically.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  type IFileService,
  type IUriIdentityService,
  type IWorkspace,
} from '@universe-editor/platform'
import type { ITreeDataSource } from '@universe-editor/workbench-ui'
import { processDirectoryEntries } from '../../../services/explorer/explorerEntries.js'
import type { IExcludeService } from '../../../services/exclude/ExcludeService.js'
import type { FileBreadcrumbSegment } from '../../../services/breadcrumbs/breadcrumbsModel.js'

export interface FilePickerEntry {
  readonly id: string
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
}

export interface FilePickerRoot {
  readonly root: URI
  readonly focusResource: URI | undefined
}

export function resolveFilePickerRoot(segment: FileBreadcrumbSegment): FilePickerRoot {
  if (segment.kind === 'root') return { root: segment.uri, focusResource: undefined }
  return { root: URI.joinPath(segment.uri, '..'), focusResource: segment.uri }
}

export class FilePickerDataSource implements ITreeDataSource<FilePickerEntry> {
  private readonly _loaded = new Map<string, FilePickerEntry[]>()
  private readonly _inflight = new Map<string, Promise<void>>()
  private readonly _byId = new Map<string, FilePickerEntry>()
  private readonly _rootId: string
  private readonly _focusRel: string | null

  constructor(
    private readonly _root: URI,
    private readonly _focusResource: URI | undefined,
    private readonly _workspace: IWorkspace | null,
    private readonly _uriIdentity: IUriIdentityService,
    private readonly _fileService: IFileService,
    private readonly _excludeService: IExcludeService | undefined,
  ) {
    this._rootId = _root.toString()
    this._focusRel =
      _workspace && _focusResource
        ? _uriIdentity.relativePath(_workspace.folder, _focusResource)
        : null
  }

  async loadRoot(): Promise<void> {
    await this._ensure(this._root, this._rootId)
  }

  findRootChild(resource: URI): FilePickerEntry | undefined {
    return this.getRoots().find((entry) => this._uriIdentity.isEqual(entry.resource, resource))
  }

  getId(element: FilePickerEntry): string {
    return element.id
  }

  hasChildren(element: FilePickerEntry): boolean {
    if (!element.isDirectory) return false
    const loaded = this._loaded.get(element.id)
    return loaded === undefined || loaded.length > 0
  }

  getChildren(element: FilePickerEntry): readonly FilePickerEntry[] | null {
    if (!element.isDirectory) return []
    return this._loaded.get(element.id) ?? null
  }

  // TreeModel destructures `loadChildren` off the data source before calling it,
  // so this must keep its `this` binding.
  readonly loadChildren = async (element: FilePickerEntry): Promise<void> => {
    if (!element.isDirectory) return
    await this._ensure(element.resource, element.id)
  }

  getRoots(): readonly FilePickerEntry[] {
    return this._loaded.get(this._rootId) ?? []
  }

  // TreeModel destructures `loadChildren`/`getParent` off the data source
  // before calling them, so both must keep their `this` binding.
  readonly getParent = (element: FilePickerEntry): FilePickerEntry | null => {
    if (this._uriIdentity.isEqual(element.resource, this._root)) return null
    const parent = URI.joinPath(element.resource, '..')
    if (this._uriIdentity.isEqual(parent, this._root)) return null
    return this._byId.get(parent.toString()) ?? null
  }

  private _ensure(directory: URI, id: string): Promise<void> {
    const existing = this._inflight.get(id)
    if (existing) return existing
    const pull = this._read(directory)
      .then((entries) => {
        this._loaded.set(id, entries)
        for (const entry of entries) this._byId.set(entry.id, entry)
      })
      .finally(() => {
        this._inflight.delete(id)
      })
    this._inflight.set(id, pull)
    return pull
  }

  private async _read(directory: URI): Promise<FilePickerEntry[]> {
    const dirRel = this._workspace
      ? this._uriIdentity.relativePath(this._workspace.folder, directory)
      : null
    // Outside the workspace the paths handed to `files.exclude` would not be
    // workspace-relative, so listing must not apply the exclude rules at all.
    const visibility = dirRel === null ? undefined : this._visibility()
    const entries = await this._fileService.list(directory)
    const processed = await processDirectoryEntries(entries, directory, dirRel ?? '', visibility)
    return processed.map((entry) => ({
      id: entry.resource.toString(),
      resource: entry.resource,
      name: entry.name,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink === true,
    }))
  }

  private _visibility(): ((relPath: string, isDirectory: boolean) => boolean) | undefined {
    const exclude = this._excludeService
    if (!this._workspace || !exclude) return undefined
    const focusRel = this._focusRel
    return (relPath, isDirectory) => {
      // Keep the file the picker was opened on even when files.exclude hides it.
      if (!isDirectory && focusRel !== null && relPath === focusRel) return true
      return !exclude.isExcluded(relPath, 'files')
    }
  }
}
