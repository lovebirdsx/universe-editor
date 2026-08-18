/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditorInput — a transient EditorInput that drives the Monaco diff editor.
 *  Holds original and modified text for a single file. When the modified side is
 *  the live working tree (same file, `liveModified`), the right pane is editable:
 *  it shares the file's Monaco model and `save()` writes it back to disk.
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  EditorInput,
  Emitter,
  IFileService,
  IInstantiationService,
  URI,
  type Event,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { SaveParticipant } from '../extensions/SaveParticipant.js'
import { DidSaveNotification } from '../extensions/DidSaveNotification.js'
import { noteSelfWrite } from './selfWriteRegistry.js'
import { splitLeadingBom, UTF8_BOM } from './leadingBom.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

/** Structural + content snapshot for reopen / session restore. A diff's two sides
 *  are frequently passed by value with no on-disk backing (a Git HEAD blob, a
 *  Perforce shelved/have revision, an agent session baseline), so the text itself
 *  must be persisted — re-fetching from disk/SCM only works for a working-tree
 *  diff and would collapse every other diff into two identical (empty) panes. */
interface ISerializedDiffEditor {
  readonly originalUri: UriComponents
  readonly originalContent: string
  readonly modifiedContent: string
  readonly modifiedUri?: UriComponents
  readonly openableResource?: UriComponents
  readonly liveModified?: boolean
  /** Set when the entry was persisted without its content (size budget): the
   *  tab is not restorable — deserialize returns null for these. */
  readonly contentDropped?: boolean
}

/** Workspace-state persistence writes on every editor change (debounced);
 *  stringifying a multi-MB diff snapshot there would tax the main thread each
 *  time. Diffs whose two sides exceed this budget persist structure only and
 *  are simply not restored on the next launch. */
export const DIFF_PERSIST_BUDGET_BYTES = 256 * 1024

export class DiffEditorInput extends EditorInput {
  static readonly TYPE_ID: string = 'diff'

  private readonly _onDidChangeContent = this._register(new Emitter<void>())
  /** Fires when original/modified content is refreshed in place (e.g. after a discard). */
  readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event

  private _hasLeadingBom = false
  /** Last-known on-disk content of the modified side; undefined until read. */
  private _cleanModifiedContent: string | undefined
  /** VSCode-style clean model version; avoids false dirty from Monaco EOL normalization. */
  private _savedAlternativeVersionId: number | undefined
  /** Dirty-tracking subscriptions for the currently-bound shared model. */
  private readonly _modifiedModelStore = this._register(new DisposableStore())
  private _boundModifiedModel: monaco.editor.ITextModel | undefined

  constructor(
    private readonly _originalUri: URI,
    private _originalContent: string,
    private _modifiedContent: string,
    private readonly _modifiedUri: URI | undefined,
    private readonly _openableResource: URI | undefined,
    private _liveModified: boolean,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super()
    this._register(
      MonacoModelRegistry.onDidMarkModelClean((model) => {
        // Only our own modified model. `modifiedEditable` + identity check guards
        // against snapshot diffs reacting to a FileEditor saving the same file —
        // and lets a background editable diff clear its dirty when the same file
        // is saved through a FileEditor elsewhere.
        if (this.modifiedEditable && MonacoModelRegistry.peek(this.modifiedUri) === model) {
          this._acceptModelClean(model)
        }
      }),
    )
  }

  override get typeId(): string {
    return DiffEditorInput.TYPE_ID
  }

  /** True when the two sides are different files (Explorer "Compare With…"). */
  private get _isCrossFile(): boolean {
    return (
      this._modifiedUri !== undefined &&
      this._modifiedUri.toString() !== this._originalUri.toString()
    )
  }

  /**
   * True for a cross-file comparison (Explorer "Compare"), where the two sides are
   * distinct files. Live-content sync contributions key off `originalUri` and would
   * otherwise clobber the modified side with the original file's content — they must
   * skip these.
   */
  get isCrossFile(): boolean {
    return this._isCrossFile
  }

  /**
   * True when the modified side is editable: the right pane is the live
   * working-tree buffer (same file, `liveModified`), not a frozen snapshot or a
   * distinct file. Edits mark the input dirty and `save()` writes back to disk.
   */
  get modifiedEditable(): boolean {
    return this._liveModified && !this._isCrossFile
  }

  override get resource(): URI {
    if (this._isCrossFile) {
      return URI.from({
        scheme: 'diff',
        path: `${this._originalUri.path}↔${this._modifiedUri!.path}`,
      })
    }
    return URI.from({ scheme: 'diff', path: this._originalUri.path })
  }

  override get id(): string {
    if (this._isCrossFile) {
      return `diff:${this._originalUri.toString()}↔${this._modifiedUri!.toString()}`
    }
    return `diff:${this._originalUri.toString()}`
  }

  override getName(): string {
    if (this._isCrossFile) {
      return `${basenameOfResource(this._originalUri)} ↔ ${basenameOfResource(this._modifiedUri!)}`
    }
    return `${basenameOfResource(this._originalUri)} (Diff)`
  }

  get originalUri(): URI {
    return this._originalUri
  }

  /** The right-hand side's file URI. Falls back to the original for same-file diffs. */
  get modifiedUri(): URI {
    return this._modifiedUri ?? this._originalUri
  }

  /**
   * The real, on-disk file this diff should open when the user clicks "Open File"
   * in the diff editor title bar. Undefined when there is no such file — e.g. an
   * Explorer cross-file compare (no single "source"), or a diff whose sides are
   * depot/revision blobs with no local counterpart — in which case the title-bar
   * button is hidden rather than opening a bogus path.
   */
  get openableResource(): URI | undefined {
    return this._openableResource
  }

  /**
   * True when the modified side represents the live working tree: the file's
   * shared Monaco model (and external disk changes) are mirrored into it by the
   * live-content sync contributions. False for snapshot diffs — a git-commit,
   * depot-revision, or merge-conflict comparison — whose right side is a frozen
   * blob that must never be clobbered with the working-tree text just because
   * the file happens to be open elsewhere.
   */
  get liveModified(): boolean {
    return this._liveModified
  }

  get originalContent(): string {
    return this._originalContent
  }

  get modifiedContent(): string {
    return this._modifiedContent
  }

  /**
   * Acquire the shared Monaco model backing the editable modified side. The
   * caller (the DiffEditor component) owns the returned reference and must pair
   * every call with {@link releaseModifiedModel} — the input itself holds no
   * registry ref, so the model is only disposed once the widget has detached
   * from it (a DiffEditorWidget asserts if its model dies first). Re-acquiring
   * an existing entry (e.g. a FileEditor sharing the file) just bumps its
   * refcount. On first acquire it kicks an async disk read so dirty compares
   * against the real baseline.
   */
  acquireModifiedModel(): monaco.editor.ITextModel {
    const model = MonacoModelRegistry.acquire(this.modifiedUri, this._modifiedContent)
    this._bindModifiedModel(model)
    void this._refreshCleanBaseline()
    return model
  }

  /** The shared model currently backing the editable modified side, without
   *  changing its refcount or reading disk. Undefined when the diff is not
   *  editable or no live model exists right now (e.g. a background tab whose
   *  file model was disposed after its component released it). */
  peekModifiedModel(): monaco.editor.ITextModel | undefined {
    if (!this.modifiedEditable) return undefined
    const model = MonacoModelRegistry.peek(this.modifiedUri)
    return model && !model.isDisposed() ? model : undefined
  }

  /**
   * Release the caller's reference to the shared modified model. Only drops our
   * dirty-tracking subscription when the model actually died (refcount hit zero);
   * a still-live model keeps the listener bound so a background tab keeps
   * following the file's dirty state. Tolerates being called after the input was
   * already disposed (tab close disposes the input before the component unmounts,
   * so the component's cleanup release lands on a disposed input).
   */
  releaseModifiedModel(): void {
    MonacoModelRegistry.release(this.modifiedUri)
    const model = MonacoModelRegistry.peek(this.modifiedUri)
    if (!model || model.isDisposed()) {
      this._modifiedModelStore.clear()
      this._boundModifiedModel = undefined
    }
  }

  private _bindModifiedModel(model: monaco.editor.ITextModel): void {
    if (this._boundModifiedModel === model) return
    this._boundModifiedModel = model
    this._modifiedModelStore.clear()
    this._modifiedModelStore.add(model.onDidChangeContent(() => this._recomputeDirty(model)))
  }

  private _recomputeDirty(model: monaco.editor.ITextModel): void {
    if (this._savedAlternativeVersionId !== undefined) {
      this.setDirty(model.getAlternativeVersionId() !== this._savedAlternativeVersionId)
      return
    }
    // Baseline not yet read → treat as clean until the disk read lands.
    this.setDirty(
      this._cleanModifiedContent !== undefined && model.getValue() !== this._cleanModifiedContent,
    )
  }

  private _acceptModelClean(model: monaco.editor.ITextModel): void {
    this._cleanModifiedContent = model.getValue()
    this._savedAlternativeVersionId = model.getAlternativeVersionId()
    this.setDirty(false)
  }

  private async _refreshCleanBaseline(): Promise<void> {
    let diskText: string
    try {
      diskText = await this._fileService.readFileText(this.modifiedUri)
    } catch {
      // File not on disk (e.g. a session-added file): the current buffer is the
      // baseline, so stay clean.
      const model = this.peekModifiedModel()
      this._cleanModifiedContent = model?.getValue()
      if (model) this._savedAlternativeVersionId = model.getAlternativeVersionId()
      this.setDirty(false)
      return
    }
    const content = splitLeadingBom(diskText)
    this._hasLeadingBom = content.hadBom
    this._cleanModifiedContent = content.text
    this._savedAlternativeVersionId = undefined
    const model = this.peekModifiedModel()
    if (model) this._recomputeDirty(model)
  }

  /** Refresh both sides in place and notify the mounted DiffEditor to re-render. */
  update(originalContent: string, modifiedContent: string, liveModified?: boolean): void {
    const nextLive = liveModified ?? this._liveModified
    if (
      this._originalContent === originalContent &&
      this._modifiedContent === modifiedContent &&
      this._liveModified === nextLive
    ) {
      return
    }
    const wasEditable = this.modifiedEditable
    this._originalContent = originalContent
    this._modifiedContent = modifiedContent
    this._liveModified = nextLive
    if (wasEditable && !this.modifiedEditable) {
      // Editable → frozen: drop dirty tracking + baseline. The shared-model ref
      // is owned by the component, whose set-model effect cleanup releases it
      // when the flip re-runs that effect (its old editable closure). Any
      // unsaved edits are discarded — the snapshot semantics now own the right side.
      this._modifiedModelStore.clear()
      this._boundModifiedModel = undefined
      this._cleanModifiedContent = undefined
      this._savedAlternativeVersionId = undefined
      this._hasLeadingBom = false
      this.setDirty(false)
    }
    this._onDidChangeContent.fire()
  }

  /** Absorb newer content when the workbench reuses this tab for a re-opened
   *  diff of the same file (the file changed again while the tab was open). */
  override updateFrom(other: EditorInput): void {
    if (other instanceof DiffEditorInput) {
      this.update(other._originalContent, other._modifiedContent, other._liveModified)
    }
  }

  /**
   * Persist the structural identity (the URIs) AND both sides' text. The two
   * sides are commonly passed by value with no reproducible on-disk source (a
   * depot/HEAD blob, a shelved revision, an agent session baseline), so the
   * content is captured here rather than re-fetched on restore.
   */
  override serialize(): ISerializedDiffEditor {
    return {
      originalUri: this._originalUri.toJSON(),
      originalContent: this._originalContent,
      modifiedContent: this._modifiedContent,
      ...(this._isCrossFile && { modifiedUri: this._modifiedUri!.toJSON() }),
      ...(this._openableResource && { openableResource: this._openableResource.toJSON() }),
      ...(this._liveModified && { liveModified: true }),
    }
  }

  /** Like {@link serialize}, but for workspace-state persistence: oversized
   *  snapshots degrade to a structure-only marker that restore skips. */
  serializeForPersistence(maxBytes = DIFF_PERSIST_BUDGET_BYTES): ISerializedDiffEditor {
    if (this._originalContent.length + this._modifiedContent.length <= maxBytes) {
      return this.serialize()
    }
    return {
      originalUri: this._originalUri.toJSON(),
      originalContent: '',
      modifiedContent: '',
      ...(this._isCrossFile && { modifiedUri: this._modifiedUri!.toJSON() }),
      contentDropped: true,
    }
  }

  override async save(): Promise<boolean> {
    if (!this.modifiedEditable) return true
    const model = this.peekModifiedModel()
    if (!model) {
      // Background tab hit by Save All: no live model (its component released it
      // and the refcount dropped to zero). If still dirty, persist the mirrored
      // buffer — DiffLiveContentSyncContribution keeps `_modifiedContent` tracking
      // the live file while the diff is open.
      if (!this.isDirty) return true
      const text = this._modifiedContent
      noteSelfWrite(this.modifiedUri)
      await this._fileService.writeFile(
        this.modifiedUri,
        this._hasLeadingBom ? UTF8_BOM + text : text,
      )
      this._cleanModifiedContent = text
      this._savedAlternativeVersionId = undefined
      this.setDirty(false)
      DidSaveNotification.notify(this.modifiedUri)
      return true
    }
    // Let save participants (e.g. ESLint fix-all-on-save via
    // workspace.onWillSaveTextDocument) mutate the model before we read it.
    await SaveParticipant.participate(model, 1)
    if (model.isDisposed()) return true
    const text = model.getValue()
    noteSelfWrite(this.modifiedUri)
    await this._fileService.writeFile(
      this.modifiedUri,
      this._hasLeadingBom ? UTF8_BOM + text : text,
    )
    // Fires onDidMarkModelClean, clearing this input AND a same-file FileEditor.
    MonacoModelRegistry.markModelClean(model)
    DidSaveNotification.notify(this.modifiedUri)
    return true
  }

  /**
   * Rebuild a diff input from its persisted structure + content (Ctrl+Shift+T /
   * window restore). Both sides are restored verbatim; live SCM/session
   * contributions refresh them in place once the tab is mounted if the
   * underlying file has changed since.
   */
  static deserialize(data: unknown, accessor?: ServicesAccessor): DiffEditorInput | null {
    const d = data as ISerializedDiffEditor | null
    if (!d || !d.originalUri) return null
    if (d.contentDropped) return null
    if (!accessor) return null
    const originalUri = URI.revive(d.originalUri) as URI
    const modifiedUri = d.modifiedUri ? (URI.revive(d.modifiedUri) as URI) : undefined
    const openableResource = d.openableResource
      ? (URI.revive(d.openableResource) as URI)
      : undefined
    const inst = accessor.get(IInstantiationService)
    return inst.createInstance(
      DiffEditorInput,
      originalUri,
      d.originalContent ?? '',
      d.modifiedContent ?? '',
      modifiedUri,
      openableResource,
      d.liveModified === true,
    )
  }

  override dispose(): void {
    // The shared model ref is owned by the mounted component, which releases it
    // in its set-model effect cleanup after detaching the widget. Disposing the
    // input first (tab close) must NOT release here — a DiffEditorWidget asserts
    // if its model is disposed before the widget resets. `_modifiedModelStore`
    // (the dirty-tracking listener) is cleaned up by `super.dispose()`.
    super.dispose()
  }
}
