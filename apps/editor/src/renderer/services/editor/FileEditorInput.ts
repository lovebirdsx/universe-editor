/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorInput — an EditorInput backed by a real `file:` URI plus a Monaco
 *  TextModel acquired via MonacoModelRegistry.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  IDialogService,
  IFileService,
  IInstantiationService,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import { languageForResource } from '../../workbench/files/resourceLanguage.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

interface ISerializedFileEditor {
  readonly resource: UriComponents
  readonly dirtyContent?: string
  readonly isReadonly?: boolean
}

export class FileEditorInput extends EditorInput {
  static readonly TYPE_ID = 'file'

  /** Last-known on-disk text. Updated by `resolve()` and `save()`. */
  private _backupContent = ''
  private _resolved = false
  /** Last-known on-disk mtime in epoch ms. Used to detect external changes. */
  private _lastKnownMtime = 0
  private _language: string
  /** Dirty content pending application on next resolve() (hot exit restore). */
  private _pendingDirtyContent: string | undefined
  private _isReadonly = false

  constructor(
    private readonly _resource: URI,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super()
    this._language = languageForResource(this._resource)
  }

  get isReadonly(): boolean {
    return this._isReadonly
  }

  markReadonly(): this {
    this._isReadonly = true
    return this
  }

  override get typeId(): string {
    return FileEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return basenameOfResource(this._resource)
  }

  get backupContent(): string {
    return this._backupContent
  }

  get language(): string {
    return this._language
  }

  /**
   * Read the file from disk, capture the backup content, and return it. The
   * FileEditor component invokes this on mount before acquiring the Monaco
   * model so the model's initial buffer matches disk.
   */
  async resolve(): Promise<string> {
    const text = await this._fileService.readFileText(this._resource)
    this._backupContent = text
    this._resolved = true
    await this._refreshMtime()
    if (this._pendingDirtyContent !== undefined) {
      const dirty = this._pendingDirtyContent
      this._pendingDirtyContent = undefined
      return dirty
    }
    return text
  }

  /** True once `resolve()` has succeeded at least once. */
  get isResolved(): boolean {
    return this._resolved
  }

  get lastKnownMtime(): number {
    return this._lastKnownMtime
  }

  override async save(): Promise<boolean> {
    if (this._isReadonly) return true
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model) return true
    const text = model.getValue()
    await this._fileService.writeFile(this._resource, text)
    this._backupContent = text
    this.setDirty(false)
    await this._refreshMtime()
    return true
  }

  override async revert(): Promise<void> {
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model) {
      this.setDirty(false)
      return
    }
    model.setValue(this._backupContent)
    this.setDirty(false)
  }

  /**
   * Compare the on-disk mtime to the last-known one. If the file changed and
   * the buffer is clean, silently reload it; if dirty, prompt the user to
   * discard local changes. Returns the action taken.
   */
  async checkExternalChange(
    dialog: IDialogService,
  ): Promise<'unchanged' | 'reloaded' | 'kept' | 'gone'> {
    let stat
    try {
      stat = await this._fileService.stat(this._resource)
    } catch {
      return 'gone'
    }
    if (stat.mtime === this._lastKnownMtime) return 'unchanged'

    const text = await this._fileService.readFileText(this._resource)
    const model = MonacoModelRegistry.peek(this._resource)

    if (!this.isDirty) {
      this._backupContent = text
      this._lastKnownMtime = stat.mtime
      if (model && model.getValue() !== text) model.setValue(text)
      return 'reloaded'
    }

    const result = await dialog.confirm({
      message: `文件 "${basenameOfResource(this._resource)}" 在外部已修改。`,
      detail: '是否放弃当前更改并从磁盘重新加载?',
      primaryButton: '重新加载',
      cancelButton: '保留当前更改',
      type: 'warning',
    })
    if (result.confirmed) {
      this._backupContent = text
      this._lastKnownMtime = stat.mtime
      if (model) model.setValue(text)
      this.setDirty(false)
      return 'reloaded'
    }
    return 'kept'
  }

  private async _refreshMtime(): Promise<void> {
    try {
      const s = await this._fileService.stat(this._resource)
      this._lastKnownMtime = s.mtime
    } catch {
      this._lastKnownMtime = 0
    }
  }

  override serialize(): ISerializedFileEditor {
    let dirtyContent: string | undefined
    if (this.isDirty) {
      dirtyContent =
        MonacoModelRegistry.peek(this._resource)?.getValue() ?? this._pendingDirtyContent
    } else if (this._pendingDirtyContent !== undefined) {
      dirtyContent = this._pendingDirtyContent
    }
    return {
      resource: this._resource.toJSON(),
      ...(dirtyContent !== undefined && { dirtyContent }),
      ...(this._isReadonly && { isReadonly: true }),
    }
  }

  static deserialize(data: unknown, accessor?: ServicesAccessor): FileEditorInput | null {
    const d = data as ISerializedFileEditor | null
    if (!d || !d.resource) return null
    if (!accessor) return null
    const resource = URI.revive(d.resource) as URI
    const inst = accessor.get(IInstantiationService)
    const input = inst.createInstance(FileEditorInput, resource)
    if (d.isReadonly === true) input.markReadonly()
    if (d.dirtyContent !== undefined) {
      input._pendingDirtyContent = d.dirtyContent
    }
    return input
  }
}
