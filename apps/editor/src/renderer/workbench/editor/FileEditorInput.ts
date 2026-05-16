/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorInput — an EditorInput backed by a real `file:` URI plus a Monaco
 *  TextModel acquired via MonacoModelRegistry.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  IFileService,
  IInstantiationService,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { MonacoModelRegistry, languageForResource } from './monaco/MonacoModelRegistry.js'

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

interface ISerializedFileEditor {
  readonly resource: UriComponents
}

export class FileEditorInput extends EditorInput {
  static readonly TYPE_ID = 'file'

  /** Last-known on-disk text. Updated by `resolve()` and `save()`. */
  private _backupContent = ''
  private _resolved = false
  private _language: string

  constructor(
    private readonly _resource: URI,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super()
    this._language = languageForResource(this._resource)
  }

  override get typeId(): string {
    return FileEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return basename(this._resource.fsPath)
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
    return text
  }

  /** True once `resolve()` has succeeded at least once. */
  get isResolved(): boolean {
    return this._resolved
  }

  override async save(): Promise<boolean> {
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model) return true
    const text = model.getValue()
    await this._fileService.writeFile(this._resource, text)
    this._backupContent = text
    this.setDirty(false)
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

  override serialize(): ISerializedFileEditor {
    return { resource: this._resource.toJSON() }
  }

  static deserialize(data: unknown, accessor?: ServicesAccessor): FileEditorInput | null {
    const d = data as ISerializedFileEditor | null
    if (!d || !d.resource) return null
    if (!accessor) return null
    const resource = URI.revive(d.resource) as URI
    const inst = accessor.get(IInstantiationService)
    return inst.createInstance(FileEditorInput, resource)
  }
}
