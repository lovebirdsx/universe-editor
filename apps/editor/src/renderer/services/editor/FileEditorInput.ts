/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorInput — an EditorInput backed by a real `file:` URI plus a Monaco
 *  TextModel acquired via MonacoModelRegistry.
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  EditorInput,
  Emitter,
  IDialogService,
  IFileService,
  IInstantiationService,
  localize,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import { languageForResource } from '../../workbench/files/resourceLanguage.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { SaveParticipant } from '../extensions/SaveParticipant.js'
import { DidSaveNotification } from '../extensions/DidSaveNotification.js'
import { applyMinimalTextEdit, normalizeToModelEol } from './minimalModelEdit.js'
import { isTooLargeForExternalReload, readFileTextForReload } from '../files/externalReload.js'
import { noteSelfWrite } from './selfWriteRegistry.js'
import { splitLeadingBom, UTF8_BOM } from './leadingBom.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

interface ISerializedFileEditor {
  readonly resource: UriComponents
  readonly dirtyContent?: string
  readonly isReadonly?: boolean
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
  private readonly _onDidChangeLanguage = this._register(new Emitter<string>())
  readonly onDidChangeLanguage = this._onDidChangeLanguage.event
  /** The model whose onDidChangeLanguage we currently mirror into `_language`. */
  private _boundLanguageModel: monaco.editor.ITextModel | undefined
  private readonly _languageBindingStore = this._register(new DisposableStore())

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
      if (existing) {
        this._bindModelLanguage(existing)
        return existing
      }
      this._modelRefAcquired = false
    }
    const hadPendingDirtyContent = this._pendingDirtyContent !== undefined
    const text = await this.resolve().catch(() => '')
    const model = MonacoModelRegistry.acquire(this._resource, text)
    this._modelRefAcquired = true
    this._bindModelLanguage(model)
    if (!hadPendingDirtyContent) {
      this._acceptModelClean(model)
    }
    return model
  }

  /**
   * Mirror the model's language into `_language`. Re-binds when the registry
   * hands us a different model instance (release + re-acquire), and syncs once
   * up front because another input sharing the model may have switched the
   * language while we were not bound.
   */
  private _bindModelLanguage(model: monaco.editor.ITextModel): void {
    if (this._boundLanguageModel === model) return
    this._boundLanguageModel = model
    this._languageBindingStore.clear()
    this._syncLanguage(model.getLanguageId())
    this._languageBindingStore.add(
      model.onDidChangeLanguage((e) => this._syncLanguage(e.newLanguage)),
    )
  }

  private _syncLanguage(language: string): void {
    if (this._language === language) return
    this._language = language
    this._onDidChangeLanguage.fire(language)
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
    // Let save participants (e.g. ESLint fix-all-on-save via
    // workspace.onWillSaveTextDocument) mutate the model before we read it.
    await SaveParticipant.participate(model, 1)
    if (model.isDisposed()) return true
    const text = model.getValue()
    noteSelfWrite(this._resource)
    await this._fileService.writeFile(this._resource, this._hasLeadingBom ? UTF8_BOM + text : text)
    this.markModelClean(model)
    await this._refreshMtime()
    DidSaveNotification.notify(this._resource)
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
   *
   * A file over `MAX_EXTERNAL_RELOAD_BYTES` is not read on this path's own
   * initiative and comes back as 'too-large' — see the gate in the body.
   *
   * 每个 await 之后都要重新核对当初据以决策的那个缓冲区——同一个模型实例、未 dispose、内容版本
   * 未变：读盘与丢弃确认框都是用户可以输入、关闭标签页或让模型被换掉的窗口。缓冲区已经动过的就
   * 不写，并且**什么都不记**：`_lastKnownMtime` 只在内容真的对上之后才写，所以被跳过的重载会在
   * 下一条事件上重试，而不是被悄悄消掉。
   */
  async checkExternalChange(
    dialog: IDialogService,
    force = false,
  ): Promise<'unchanged' | 'reloaded' | 'kept' | 'gone' | 'too-large'> {
    let stat
    try {
      stat = await this._fileService.stat(this._resource)
    } catch {
      return 'gone'
    }
    if (!force && stat.mtime === this._lastKnownMtime) return 'unchanged'

    // Over the ceiling the content is not read on this path's own initiative: the
    // read repeats for as long as the file keeps changing, and each one costs a
    // multiple of the file (wire frame, decode, minimal-edit scan), which is how a
    // renderer ends up dead. A clean buffer is left stale on purpose — the caller
    // tells the user. A dirty one is still asked: that prompt needs no content, and
    // swallowing someone else's write without a word is worse than a stale buffer.
    // `force` is the app reconciling its own user-data files, small by construction.
    const tooLarge = !force && isTooLargeForExternalReload(stat.size)
    let discardConfirmed = false
    if (tooLarge) {
      if (!this.isDirty) {
        // Known mtime, or every later batch re-enters this branch and the file never
        // goes quiet. A shrink or any new write opens the gate again.
        this._lastKnownMtime = stat.mtime
        return 'too-large'
      }
      discardConfirmed = (await this._confirmDiscard(dialog)).confirmed
      if (!discardConfirmed) {
        // Known mtime here too: the disk state has not moved on, so re-asking on each
        // later batch of the same write is noise, not diligence.
        this._lastKnownMtime = stat.mtime
        return 'kept'
      }
    }

    let stamp = this._snapshotBuffer()
    const diskText = await readFileTextForReload(this._fileService, this._resource)
    const content = splitLeadingBom(diskText)
    let buffer = this._unchangedBuffer(stamp)

    if (
      force &&
      !this.isDirty &&
      buffer &&
      buffer.getValue() === normalizeToModelEol(content.text, buffer)
    ) {
      this._lastKnownMtime = stat.mtime
      return 'unchanged'
    }

    if (!this.isDirty) {
      if (buffer) {
        // Reconcile with a minimal edit, not setValue: a flush would drop the
        // viewer's folding/decorations on lines that did not even change.
        applyMinimalTextEdit(buffer, content.text)
        // 顺带把缓冲区当前（已按模型行尾归一）的文本记为干净基线并清脏。
        this.markModelClean(buffer)
      } else if (!this._hasBufferToProtect()) {
        this.setDirty(false)
      } else {
        return 'kept'
      }
      this._hasLeadingBom = content.hadBom
      this._lastKnownMtime = stat.mtime
      return 'reloaded'
    }

    if (!discardConfirmed) {
      // 快照取在提问之前而不是读盘之前：提问描述的是此刻的缓冲区，只有提问期间敲进去的才算「
      // 答复之后才出现的东西」。
      stamp = this._snapshotBuffer()
      if (!(await this._confirmDiscard(dialog)).confirmed) {
        this._lastKnownMtime = stat.mtime
        return 'kept'
      }
      buffer = this._unchangedBuffer(stamp)
    }

    if (buffer) {
      applyMinimalTextEdit(buffer, content.text)
      this.markModelClean(buffer)
    } else if (!this._hasBufferToProtect()) {
      this._backupContent = content.text
      this._savedAlternativeVersionId = undefined
      this.setDirty(false)
    } else {
      // 提问期间用户敲进去的内容（或缓冲区被换掉）优先于「在它出现之前作出的丢弃答复」。
      return 'kept'
    }
    this._hasLeadingBom = content.hadBom
    this._lastKnownMtime = stat.mtime
    return 'reloaded'
  }

  /** 决策所依据的那个缓冲区：身份 + 内容版本，供后面的 await 判断它是否还是同一个。 */
  private _snapshotBuffer():
    | { readonly model: monaco.editor.ITextModel; readonly version: number }
    | undefined {
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model || model.isDisposed()) return undefined
    return { model, version: model.getVersionId() }
  }

  /** 活着的模型，但仅当它仍是 `stamp` 当初取到的那一个（同实例、未 dispose、其后没被编辑过）。
   *  `undefined` 表示「不要往缓冲区里写」：要么没有缓冲区，要么现在这个不是当初据以决策的那个。 */
  private _unchangedBuffer(
    stamp: { readonly model: monaco.editor.ITextModel; readonly version: number } | undefined,
  ): monaco.editor.ITextModel | undefined {
    if (!stamp) return undefined
    const model = MonacoModelRegistry.peek(this._resource)
    if (!model || model.isDisposed()) return undefined
    if (model !== stamp.model || model.getVersionId() !== stamp.version) return undefined
    return model
  }

  /** 有没有一个不能被覆盖的活缓冲区？区分「这个 input 压根没有模型」（无可失去）与「另一个模型
   *  顶替了这个 URI」（那是别人的缓冲区）。 */
  private _hasBufferToProtect(): boolean {
    const model = MonacoModelRegistry.peek(this._resource)
    return model !== undefined && !model.isDisposed()
  }

  private _confirmDiscard(dialog: IDialogService): Promise<{ confirmed: boolean }> {
    return dialog.confirm({
      message: localize(
        'editor.externallyModified.message',
        'The file "{name}" has been modified externally.',
        { name: basenameOfResource(this._resource) },
      ),
      detail: localize(
        'editor.externallyModified.detail',
        'Discard your current changes and reload from disk?',
      ),
      primaryButton: localize('editor.externallyModified.reload', 'Reload'),
      cancelButton: localize('editor.externallyModified.keepChanges', 'Keep Current Changes'),
      type: 'warning',
    })
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
