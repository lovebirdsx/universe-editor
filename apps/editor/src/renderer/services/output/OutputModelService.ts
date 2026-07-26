/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputModelService — owns one Monaco text model per viewed output channel
 *  and mirrors the channel's batched flush events into it incrementally.
 *
 *  Models are created lazily (first time a channel is shown) and kept alive
 *  until the channel is disposed, so switching channels preserves scroll
 *  position and never re-tokenizes. The Output view reads models from here
 *  instead of rebuilding content from the full channel text.
 *
 *  Also owns the level/text filter state and turns it into hidden line ranges
 *  (VSCode's editor.setHiddenAreas, reached via a runtime capability check).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableMap,
  DisposableStore,
  IOutputService,
  IStorageService,
  LogLevel,
  StorageScope,
  ThrottledDelayer,
  createDecorator,
  observableValue,
  type IDisposable,
  type IObservable,
  type IOutputChannel,
  type IOutputChannelFlushEvent,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { computeHiddenRanges, type LogEntryRange } from './logEntryIndex.js'

const FILTER_DELAY_MS = 150
const OUTPUT_FILTER_KEY = 'output.filter'

interface PersistedOutputFilter {
  filterText: string
  hiddenLevels: LogLevel[]
}

interface HiddenAreasEditor {
  setHiddenAreas(ranges: monaco.IRange[]): void
}

export interface IOutputModelService {
  readonly _serviceBrand: undefined
  /**
   * Acquire (creating on first use) the Monaco model mirroring `channel`.
   * Requires MonacoLoader.ensureInitialized() to have resolved.
   */
  acquireModel(channel: IOutputChannel): monaco.editor.ITextModel
  /** Look up an existing model without creating it. */
  peekModel(channelName: string): monaco.editor.ITextModel | undefined
  saveViewState(channelName: string, state: monaco.editor.ICodeEditorViewState | null): void
  getViewState(channelName: string): monaco.editor.ICodeEditorViewState | undefined
  /** Shared auto-scroll (follow tail) flag for the Output view. */
  readonly autoScroll: IObservable<boolean>
  setAutoScroll(value: boolean): void
  /** Free-form text filter (VSCode syntax: `foo, !bar, "a,b"`). */
  readonly filterText: IObservable<string>
  setFilterText(value: string): void
  /** Levels currently filtered out of the view. */
  readonly hiddenLevels: IObservable<ReadonlySet<LogLevel>>
  setLevelHidden(level: LogLevel, hidden: boolean): void
  /**
   * Hidden line ranges for a channel under the current filters, and the
   * editor `setHiddenAreas` hook that applies them (undefined when the editor
   * lacks the capability — filters then degrade to a no-op for that view).
   */
  getHiddenRanges(channelName: string): readonly LogEntryRange[]
  /**
   * Wire an editor's hidden-areas capability to a channel: applies the current
   * ranges now and re-applies (throttled) whenever content or filters change.
   * Returns undefined when the editor does not support setHiddenAreas.
   */
  attachHiddenAreas(
    channelName: string,
    editor: monaco.editor.IStandaloneCodeEditor,
  ): IDisposable | undefined
}

/** Applies hidden ranges to an editor; no-arg, bound at attach time. */
type HiddenRangesApplier = () => void

export const IOutputModelService = createDecorator<IOutputModelService>('outputModelService')

export class OutputModelService extends Disposable implements IOutputModelService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, monaco.editor.ITextModel>()
  private readonly _subscriptions = this._register(new DisposableMap<string>())
  private readonly _viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()
  private readonly _filterDelayer = this._register(new ThrottledDelayer<void>(FILTER_DELAY_MS))
  private _contentRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _hiddenRangesAppliers = new Map<string, HiddenRangesApplier>()

  readonly autoScroll = observableValue<boolean>('OutputModelService.autoScroll', true)
  readonly filterText = observableValue<string>('OutputModelService.filterText', '')
  readonly hiddenLevels = observableValue<ReadonlySet<LogLevel>>(
    'OutputModelService.hiddenLevels',
    new Set<LogLevel>(),
  )

  /** Set once the user edits filters after construction — hydration must not clobber it. */
  private _filterDirty = false

  constructor(
    @IOutputService private readonly _output: IOutputService,
    @IStorageService private readonly _storage: IStorageService,
  ) {
    super()
    this._register(this._output.onDidRemoveChannel((name) => this._dropModel(name)))
    void this._loadFilter()
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        this._filterDirty = false
        void this._loadFilter()
      }),
    )
  }

  private async _loadFilter(): Promise<void> {
    const persisted = await this._storage.get<PersistedOutputFilter>(
      OUTPUT_FILTER_KEY,
      StorageScope.WORKSPACE,
    )
    // Nothing stored → keep the current (default) state. User edits made while
    // the async read was in flight win over whatever was persisted.
    if (persisted === undefined || this._filterDirty) return
    const filterText = typeof persisted?.filterText === 'string' ? persisted.filterText : ''
    const hiddenLevels = new Set<LogLevel>(
      Array.isArray(persisted?.hiddenLevels) ? persisted.hiddenLevels : [],
    )
    this.filterText.set(filterText, undefined)
    this.hiddenLevels.set(hiddenLevels, undefined)
    this._scheduleFilterRefresh()
  }

  private _persistFilter(): void {
    const persisted: PersistedOutputFilter = {
      filterText: this.filterText.get(),
      hiddenLevels: [...this.hiddenLevels.get()],
    }
    void this._storage.set(OUTPUT_FILTER_KEY, persisted, StorageScope.WORKSPACE)
  }

  acquireModel(channel: IOutputChannel): monaco.editor.ITextModel {
    const existing = this._entries.get(channel.name)
    if (existing && !existing.isDisposed()) return existing

    const m = MonacoLoader.get()
    // Subscribe before seeding so no flush between the two is missed (both are
    // synchronous in the same task, but keep the order obviously correct).
    const subscription = new DisposableStore()
    subscription.add(channel.onDidFlush((e) => this._applyFlush(channel.name, e)))
    subscription.add(channel.onDidClear(() => this._applyClear(channel.name)))
    // Drain buffered appends now: getText() below already contains them, and no
    // model is registered yet, so the drained event lands on nothing. Leaving
    // them queued would append the same delta a second time.
    channel.flushNow()
    const uri = m.Uri.parse(`output://channel/${encodeURIComponent(channel.name)}`)
    const found = m.editor.getModel(uri)
    let model: monaco.editor.ITextModel
    if (found && !found.isDisposed()) {
      // A model may linger outside this registry (e.g. from an earlier mount).
      // Adopt it rather than throwing on a duplicate createModel.
      found.setValue(channel.getText())
      model = found
    } else {
      model = m.editor.createModel(channel.getText(), 'log', uri)
    }
    this._entries.set(channel.name, model)
    this._subscriptions.set(channel.name, subscription)
    return model
  }

  peekModel(channelName: string): monaco.editor.ITextModel | undefined {
    return this._entries.get(channelName)
  }

  saveViewState(channelName: string, state: monaco.editor.ICodeEditorViewState | null): void {
    if (state) this._viewStates.set(channelName, state)
    else this._viewStates.delete(channelName)
  }

  getViewState(channelName: string): monaco.editor.ICodeEditorViewState | undefined {
    return this._viewStates.get(channelName)
  }

  setAutoScroll(value: boolean): void {
    this.autoScroll.set(value, undefined)
  }

  setFilterText(value: string): void {
    if (value === this.filterText.get()) return
    this._filterDirty = true
    this.filterText.set(value, undefined)
    this._scheduleFilterRefresh()
    this._persistFilter()
  }

  setLevelHidden(level: LogLevel, hidden: boolean): void {
    const current = this.hiddenLevels.get()
    const next = new Set(current)
    if (hidden) next.add(level)
    else next.delete(level)
    if (next.size === current.size && [...next].every((l) => current.has(l))) return
    this._filterDirty = true
    this.hiddenLevels.set(next, undefined)
    this._scheduleFilterRefresh()
    this._persistFilter()
  }

  getHiddenRanges(channelName: string): readonly LogEntryRange[] {
    const model = this._entries.get(channelName)
    if (!model || model.isDisposed()) return []
    const hiddenLevels = this.hiddenLevels.get()
    const filterText = this.filterText.get()
    if (hiddenLevels.size === 0 && filterText.trim() === '') return []
    return computeHiddenRanges(model.getLinesContent(), hiddenLevels, filterText)
  }

  /**
   * Wire an editor's hidden-areas capability to a channel: applies the current
   * ranges now and re-applies (throttled) whenever content or filters change.
   * Returns undefined when the editor does not support setHiddenAreas.
   */
  attachHiddenAreas(
    channelName: string,
    editor: monaco.editor.IStandaloneCodeEditor,
  ): IDisposable | undefined {
    if (typeof (editor as unknown as Partial<HiddenAreasEditor>).setHiddenAreas !== 'function') {
      return undefined
    }
    const target = editor as unknown as HiddenAreasEditor
    const apply = () => {
      const Range = MonacoLoader.get().Range
      target.setHiddenAreas(
        this.getHiddenRanges(channelName).map(
          (r) => new Range(r.startLine, 1, r.endLineExclusive - 1, 1),
        ),
      )
    }
    this._hiddenRangesAppliers.set(channelName, apply)
    apply()
    const appliers = this._hiddenRangesAppliers
    return {
      dispose() {
        if (appliers.get(channelName) === apply) {
          appliers.delete(channelName)
        }
      },
    }
  }

  private _applyHiddenRanges(): void {
    for (const apply of this._hiddenRangesAppliers.values()) apply()
  }

  /** Filter edits debounce: mid-typing terms would otherwise churn the view. */
  private _scheduleFilterRefresh(): void {
    void this._filterDelayer.trigger(async () => {
      this._applyHiddenRanges()
    })
  }

  /**
   * Content refreshes throttle rather than debounce: a streaming channel flushes
   * far faster than FILTER_DELAY_MS, and a debounce would keep pushing the
   * refresh back for as long as the stream lasts — filtered-out lines stay
   * visible until the log goes quiet. The first flush opens one refresh window
   * that later flushes coalesce into without postponing it.
   */
  private _scheduleContentRefresh(): void {
    if (this._contentRefreshTimer !== undefined) return
    this._contentRefreshTimer = setTimeout(() => {
      this._contentRefreshTimer = undefined
      this._applyHiddenRanges()
    }, FILTER_DELAY_MS)
  }

  private _applyFlush(channelName: string, e: IOutputChannelFlushEvent): void {
    const model = this._entries.get(channelName)
    if (!model || model.isDisposed()) return
    const m = MonacoLoader.get()
    // Mirror order (matches the channel's coordinate space: old text + delta):
    // insert at the tail first, then delete the trimmed head.
    if (e.appendedText) {
      const lc = model.getLineCount()
      const ll = model.getLineContent(lc).length
      model.applyEdits([
        {
          range: new m.Range(lc, ll + 1, lc, ll + 1),
          text: e.appendedText,
          forceMoveMarkers: true,
        },
      ])
    }
    if (e.trimmedChars > 0) {
      const end = model.getPositionAt(e.trimmedChars)
      model.applyEdits([{ range: new m.Range(1, 1, end.lineNumber, end.column), text: '' }])
    }
    if (this.filterText.get().trim() !== '' || this.hiddenLevels.get().size > 0) {
      this._scheduleContentRefresh()
    }
  }

  private _applyClear(channelName: string): void {
    const model = this._entries.get(channelName)
    if (!model || model.isDisposed()) return
    model.setValue('')
    this._hiddenRangesAppliers.get(channelName)?.()
  }

  private _dropModel(channelName: string): void {
    const model = this._entries.get(channelName)
    if (!model) return
    this._entries.delete(channelName)
    this._subscriptions.deleteAndDispose(channelName)
    if (!model.isDisposed()) model.dispose()
    this._viewStates.delete(channelName)
    this._hiddenRangesAppliers.delete(channelName)
  }

  override dispose(): void {
    if (this._contentRefreshTimer !== undefined) {
      clearTimeout(this._contentRefreshTimer)
      this._contentRefreshTimer = undefined
    }
    this._hiddenRangesAppliers.clear()
    for (const name of [...this._entries.keys()]) this._dropModel(name)
    super.dispose()
  }
}
