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
import { applyMinimalTextEdit } from './minimalModelEdit.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

interface ISerializedFileEditor {
  readonly resource: UriComponents
  readonly dirtyContent?: string
  readonly isReadonly?: boolean
}

const UTF8_BOM = '\uFEFF'

function splitLeadingBom(text: string): { text: string; hadBom: boolean } {
  return text.startsWith(UTF8_BOM)
    ? { text: text.slice(UTF8_BOM.length), hadBom: true }
    : { text, hadBom: false }
}

export class FileEditorInput extends EditorInput {
  static readonly TYPE_ID = 'file'

  /** Last-known clean editor text. Updated by `resolve()` and `save()`. */
  private _backupContent = ''
  private _resolved = false
  /** Last-known on-disk mtime in epoch ms. Used to detect external changes. */
  private _lastKnownMtime = 0
  private _language: string
  /** Dirty content pending application on next resolve() (hot exit restore). */
  private _pendingDirtyContent: string | undefined
  private _isReadonly = false
  private _hasLeadingBom = false
  private _modelRefAcquired = false
  /** VSCode-style clean model version; avoids false dirty from Monaco EOL normalization. */
  private _savedAlternativeVersionId: number | undefined

  constructor(
    private readonly _resource: URI,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super()
    this._language = languageForResource(this._resource)
    this._register(
      MonacoModelRegistry.onDidMarkModelClean((model) => {
        if (MonacoModelRegistry.peek(this._resource) === model) {
          this._acceptModelClean(model)
        }
      }),
    )
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
   * Read the file from disk, capture the clean backup content, and return it. The
   * FileEditor component invokes this on mount before acquiring the Monaco
   * model so the model's initial buffer matches disk.
   */
  async resolve(): Promise<string> {
    const diskText = await this._fileService.readFileText(this._resource)
    const content = splitLeadingBom(diskText)
    this._hasLeadingBom = content.hadBom
    this._backupContent = content.text
    this._savedAlternativeVersionId = undefined
    this._resolved = true
    await this._refreshMtime()
    if (this._pendingDirtyContent !== undefined) {
      const dirty = this._pendingDirtyContent
      this._pendingDirtyContent = undefined
      return dirty
    }
    return content.text
  }

  async resolveModel(): Promise<monaco.editor.ITextModel> {
    if (this._modelRefAcquired) {
      const existing = MonacoModelRegistry.peek(this._resource)
      if (existing) return existing
      this._modelRefAcquired = false
    }
    const hadPendingDirtyContent = this._pendingDirtyContent !== undefined
    const text = await this.resolve().catch(() => '')
    const model = MonacoModelRegistry.acquire(this._resource, text)
    this._modelRefAcquired = true
    if (!hadPendingDirtyContent) {
      this._acceptModelClean(model)
    }
    return model
  }

  /**
   * The already-acquired model for this input, if any — no disk read, no refcount
   * change. Lets the editor swap synchronously (before paint) when switching back
   * to a file that is still open, avoiding a one-frame flash of the previous file.
   * Returns undefined on first open, where `resolveModel` must read disk first.
   */
  peekModel(): monaco.editor.ITextModel | undefined {
    if (!this._modelRefAcquired) return undefined
    return MonacoModelRegistry.peek(this._resource)
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
    await this._fileService.writeFile(this._resource, this._hasLeadingBom ? UTF8_BOM + text : text)
    this.markModelClean(model)
    await this._refreshMtime()
    return true
  }

  override async revert(): Promise<void> {
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model) {
      this.setDirty(false)
      return
    }
    applyMinimalTextEdit(model, this._backupContent)
    this.markModelClean(model)
  }

  markModelClean(model: monaco.editor.ITextModel): void {
    MonacoModelRegistry.markModelClean(model)
  }

  private _acceptModelClean(model: monaco.editor.ITextModel): void {
    this._backupContent = model.getValue()
    this._pendingDirtyContent = undefined
    this._savedAlternativeVersionId = model.getAlternativeVersionId()
    this.setDirty(false)
  }

  updateDirtyFromModel(model: monaco.editor.ITextModel): void {
    if (this._savedAlternativeVersionId !== undefined) {
      this.setDirty(model.getAlternativeVersionId() !== this._savedAlternativeVersionId)
      return
    }
    this.setDirty(model.getValue() !== this._backupContent)
  }

  /**
   * Compare the on-disk mtime to the last-known one. If the file changed and
   * the buffer is clean, silently reload it; if dirty, prompt the user to
   * discard local changes. Returns the action taken.
   *
   * `force` skips the mtime short-circuit and reconciles against disk content
   * directly — used for atomic self-writes (e.g. settings written by the app)
   * where mtime granularity could otherwise falsely report 'unchanged'.
   */
  async checkExternalChange(
    dialog: IDialogService,
    force = false,
  ): Promise<'unchanged' | 'reloaded' | 'kept' | 'gone'> {
    let stat
    try {
      stat = await this._fileService.stat(this._resource)
    } catch {
      return 'gone'
    }
    if (!force && stat.mtime === this._lastKnownMtime) return 'unchanged'

    const diskText = await this._fileService.readFileText(this._resource)
    const content = splitLeadingBom(diskText)
    const model = MonacoModelRegistry.peek(this._resource)

    if (force && !this.isDirty && model && model.getValue() === content.text) {
      this._lastKnownMtime = stat.mtime
      return 'unchanged'
    }

    if (!this.isDirty) {
      this._hasLeadingBom = content.hadBom
      this._backupContent = content.text
      this._savedAlternativeVersionId = undefined
      this._lastKnownMtime = stat.mtime
      if (model) {
        // Reconcile with a minimal edit, not setValue: a flush would drop the
        // viewer's folding/decorations on lines that did not even change.
        applyMinimalTextEdit(model, content.text)
        this.markModelClean(model)
      } else {
        this.setDirty(false)
      }
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
      this._hasLeadingBom = content.hadBom
      this._backupContent = content.text
      this._savedAlternativeVersionId = undefined
      this._lastKnownMtime = stat.mtime
      if (model) {
        applyMinimalTextEdit(model, content.text)
        this.markModelClean(model)
      } else {
        this.setDirty(false)
      }
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

  override dispose(): void {
    if (this._modelRefAcquired) {
      MonacoModelRegistry.release(this._resource)
      this._modelRefAcquired = false
    }
    super.dispose()
  }
}
