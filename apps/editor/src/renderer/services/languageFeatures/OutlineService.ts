/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineService — the workbench-facing outline facade. It owns one
 *  EditorOutlineTracker per editor group, so every group tracks its OWN active
 *  editor; a split view's breadcrumbs therefore show their group's navigation
 *  path instead of the focused editor's. The service's own observables mirror the
 *  ACTIVE group — that is what the Outline view and the @ / @: symbol quick access
 *  consume, and what the e2e probes read.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  derived,
  Disposable,
  DisposableStore,
  IEditorGroupsService,
  ILoggerService,
  observableValue,
  type EditorInput,
  type IEditorGroup,
  type ILogger,
  type IObservable,
  type IReader,
} from '@universe-editor/platform'
import { EditorOutlineTracker, OutlineSymbolCache } from './editorOutlineTracker.js'
import type {
  IOutlineScope,
  OutlineModel,
  OutlineSourceKind,
  OutlineViewState,
} from './editorOutlineTracker.js'
import { ILanguageFeaturesService } from './LanguageFeaturesService.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export type {
  CachedSymbols,
  IOutlineScope,
  OutlineModel,
  OutlineSourceKind,
  OutlineViewState,
} from './editorOutlineTracker.js'

export interface IOutlineService extends IOutlineScope {
  readonly _serviceBrand: undefined
  /**
   * The outline of one editor group's active editor. The breadcrumbs use it to
   * read (and reveal into) THEIR group, which is what keeps a background group
   * from mirroring the focused editor. `undefined` yields the service itself,
   * i.e. the active group; an unknown group yields an empty scope.
   */
  forGroup(groupId: number | undefined): IOutlineScope
}

export const IOutlineService = createDecorator<IOutlineService>('outlineService')

/**
 * What `forGroup` hands out for a group that has no tracker — a group removed
 * between the service's notification and the next React render. It reports
 * nothing on purpose: falling back to the active group would show the focused
 * editor's path in a background group, i.e. exactly the bug being fixed.
 */
const EMPTY_SCOPE: IOutlineScope = {
  outline: observableValue<OutlineModel | undefined>('OutlineService.empty.outline', undefined),
  activeSymbol: observableValue<monaco.languages.DocumentSymbol | undefined>(
    'OutlineService.empty.activeSymbol',
    undefined,
  ),
  sourceKind: observableValue<OutlineSourceKind | undefined>(
    'OutlineService.empty.sourceKind',
    undefined,
  ),
  revealSymbol: () => {},
  captureViewState: () => undefined,
  previewSymbol: () => {},
  restoreViewState: () => {},
}

export class OutlineService extends Disposable implements IOutlineService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  /** Symbol trees + in-flight pulls, shared by every group's tracker: split views
   *  showing the same file must not each cross the wire for it. */
  private readonly _cache = new OutlineSymbolCache()
  /** One tracker per group, created when the group is (or becomes) known. */
  private readonly _trackers = new Map<number, EditorOutlineTracker>()
  private readonly _groupStores = new Map<number, DisposableStore>()
  private readonly _activeGroupId = observableValue<number | undefined>(
    'OutlineService.activeGroupId',
    undefined,
  )
  /** Bumped when a tracker is created or dropped. The deriveds read it so they
   *  re-evaluate even when the active group id itself did not change (a group
   *  removed while active, e.g. during a workspace switch). */
  private readonly _trackersEpoch = observableValue('OutlineService.trackersEpoch', 0)

  private readonly _outline: IObservable<OutlineModel | undefined>
  private readonly _activeSymbol: IObservable<monaco.languages.DocumentSymbol | undefined>
  private readonly _sourceKind: IObservable<OutlineSourceKind | undefined>
  readonly outline: IObservable<OutlineModel | undefined>
  readonly activeSymbol: IObservable<monaco.languages.DocumentSymbol | undefined>
  readonly sourceKind: IObservable<OutlineSourceKind | undefined>

  constructor(
    @IEditorGroupsService groupsService: IEditorGroupsService,
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()

    this._logger = createNamedLogger(loggerService, { id: 'outline', name: 'Outline' })

    for (const group of groupsService.groups) this._ensureGroupTracker(group)
    this._activeGroupId.set(groupsService.activeGroup.id, undefined)

    this._register(groupsService.onDidAddGroup((group) => this._ensureGroupTracker(group)))
    this._register(groupsService.onDidRemoveGroup((group) => this._disposeGroupTracker(group.id)))
    // Keep an invariant the derived observables rely on: an active group always
    // has a tracker, so switching to it never yields a transiently empty outline.
    this._register(
      groupsService.onDidActiveGroupChange((group) => {
        this._ensureGroupTracker(group)
        this._activeGroupId.set(group.id, undefined)
      }),
    )

    const active = (r: IReader): EditorOutlineTracker | undefined => {
      this._trackersEpoch.read(r)
      return this._activeTracker(r)
    }
    this._outline = derived(this, (r) => active(r)?.outline.read(r))
    this._activeSymbol = derived(this, (r) => active(r)?.activeSymbol.read(r))
    this._sourceKind = derived(this, (r) => active(r)?.sourceKind.read(r))
    this.outline = this._outline
    this.activeSymbol = this._activeSymbol
    this.sourceKind = this._sourceKind
  }

  forGroup(groupId: number | undefined): IOutlineScope {
    if (groupId === undefined) return this
    return this._trackers.get(groupId) ?? EMPTY_SCOPE
  }

  revealSymbol(symbol: monaco.languages.DocumentSymbol): void {
    this._activeTrackerNow()?.revealSymbol(symbol)
  }

  captureViewState(): OutlineViewState | undefined {
    return this._activeTrackerNow()?.captureViewState()
  }

  previewSymbol(symbol: monaco.languages.DocumentSymbol): void {
    this._activeTrackerNow()?.previewSymbol(symbol)
  }

  restoreViewState(state: OutlineViewState): void {
    this._activeTrackerNow()?.restoreViewState(state)
  }

  private _activeTracker(r: IReader): EditorOutlineTracker | undefined {
    const id = this._activeGroupId.read(r)
    return id === undefined ? undefined : this._trackers.get(id)
  }

  private _activeTrackerNow(): EditorOutlineTracker | undefined {
    const id = this._activeGroupId.get()
    return id === undefined ? undefined : this._trackers.get(id)
  }

  private _ensureGroupTracker(group: IEditorGroup): EditorOutlineTracker {
    const existing = this._trackers.get(group.id)
    if (existing) return existing

    const store = new DisposableStore()
    // IEditorGroup exposes its active editor through an event only. Bridge it into
    // an observable with an explicit listener — NOT observableFromEvent, whose
    // internal subscription is an unparented tracked disposable the leak gate flags.
    const activeEditor = observableValue<EditorInput | undefined>(
      `OutlineService.groupActiveEditor.${group.id}`,
      group.activeEditor,
    )
    store.add(group.onDidActiveEditorChange(() => activeEditor.set(group.activeEditor, undefined)))
    const tracker = new EditorOutlineTracker({
      groupId: group.id,
      activeEditor,
      languageFeatures: this._languageFeatures,
      logger: this._logger,
      cache: this._cache,
    })
    store.add(tracker)

    this._groupStores.set(group.id, store)
    this._trackers.set(group.id, tracker)
    this._trackersEpoch.set(this._trackersEpoch.get() + 1, undefined)
    this._register(store)
    this._logger.debug(`outline tracker attached to group ${group.id}`)
    return tracker
  }

  private _disposeGroupTracker(groupId: number): void {
    // The owning service fires onDidActiveGroupChange before removing an active
    // group, so `_activeGroupId` is already pointing at a live group by now.
    this._groupStores.get(groupId)?.dispose()
    this._groupStores.delete(groupId)
    this._trackers.delete(groupId)
    this._trackersEpoch.set(this._trackersEpoch.get() + 1, undefined)
  }
}
