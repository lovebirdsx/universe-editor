/*---------------------------------------------------------------------------------------------
 *  Renderer-side owner of the Timeline model (VSCode `ITimelineService`
 *  counterpart). Handles the host → renderer `mainThreadTimeline` channel
 *  (provider registrations + change events) and exposes the provider set as an
 *  observable the built-in TimelineView renders. Page requests flow back to
 *  the host through the `extHostTimeline` proxy set on connect.
 *
 *  The view's "follow the active editor" state (current uri + pin) also lives
 *  here so the `files.openTimeline` command can pin a resource from the
 *  Explorer without reaching into view internals.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  Emitter,
  IContextKeyService,
  observableValue,
  type Event,
  type IObservable,
  type ISettableObservable,
  URI,
} from '@universe-editor/platform'
import type {
  IExtHostTimeline,
  IMainThreadTimeline,
  ITimelineDto,
  ITimelineOptionsDto,
} from '@universe-editor/extensions-common'

export interface ITimelineProviderModel {
  readonly handle: number
  readonly id: string
  readonly label: string
  readonly schemes: readonly string[]
}

/** A timeline change pushed by a provider (via the host). */
export interface ITimelineChange {
  /** The provider whose data changed. */
  readonly source: string
  /** The single affected resource, or undefined for a provider-wide change. */
  readonly uri: URI | undefined
  /** True → drop every cached page for the provider. */
  readonly reset: boolean
}

export interface ITimelineService {
  readonly _serviceBrand: undefined
  /** Registered providers, in registration order. */
  readonly providers: IObservable<readonly ITimelineProviderModel[]>
  /** Provider data changes; the view reloads accordingly. */
  readonly onDidChangeTimeline: Event<ITimelineChange>
  /** The resource the timeline view is showing (follows the active editor unless pinned). */
  readonly uri: IObservable<URI | undefined>
  /** When set, the view ignores active-editor changes and stays on this resource. */
  readonly pinnedUri: IObservable<URI | undefined>
  /** Wire the host proxy once the extension host connection is up. */
  setExtHost(extHost: IExtHostTimeline): void
  /** Providers whose scheme list covers `uri`. */
  getProvidersForUri(uri: URI): readonly ITimelineProviderModel[]
  hasProviderForUri(uri: URI): boolean
  /** Pull one page from a provider (renderer → host RPC). */
  getTimeline(
    handle: number,
    uri: URI,
    options: ITimelineOptionsDto,
  ): Promise<ITimelineDto | undefined>
  /** Follow + reveal `uri` in the timeline view, pinning it (`files.openTimeline`). */
  pinUri(uri: URI): void
  /** Point the view back at the active editor (toolbar unpin). */
  unpin(): void
  /** Follow-target updates from the view (active editor changed). Pinned wins. */
  followUri(uri: URI | undefined): void
  /** Drop all providers + the current uri (extension host torn down). */
  reset(): void
}

export const ITimelineService = createDecorator<ITimelineService>('timelineService')

export class TimelineService extends Disposable implements ITimelineService, IMainThreadTimeline {
  declare readonly _serviceBrand: undefined

  private readonly _providers = new Map<number, ITimelineProviderModel>()
  private readonly _providersObservable: ISettableObservable<readonly ITimelineProviderModel[]>
  readonly providers: IObservable<readonly ITimelineProviderModel[]>

  private readonly _onDidChangeTimeline = this._register(new Emitter<ITimelineChange>())
  readonly onDidChangeTimeline: Event<ITimelineChange> = this._onDidChangeTimeline.event

  private readonly _uri: ISettableObservable<URI | undefined>
  readonly uri: IObservable<URI | undefined>
  private readonly _pinnedUri: ISettableObservable<URI | undefined>
  readonly pinnedUri: IObservable<URI | undefined>

  private _extHost: IExtHostTimeline | undefined

  constructor(@IContextKeyService contextKeyService: IContextKeyService) {
    super()
    this._providersObservable = observableValue('timelineProviders', [])
    this.providers = this._providersObservable
    this._uri = observableValue('timelineUri', undefined)
    this.uri = this._uri
    this._pinnedUri = observableValue('timelinePinnedUri', undefined)
    this.pinnedUri = this._pinnedUri

    const hasProvider = contextKeyService.createKey<boolean>('timelineHasProvider', false)
    this._register(
      autorun((reader) => {
        hasProvider.set(this._providersObservable.read(reader).length > 0)
      }),
    )
  }

  setExtHost(extHost: IExtHostTimeline): void {
    this._extHost = extHost
  }

  getProvidersForUri(uri: URI): readonly ITimelineProviderModel[] {
    return this.providers.get().filter((p) => p.schemes.includes(uri.scheme))
  }

  hasProviderForUri(uri: URI): boolean {
    return this.getProvidersForUri(uri).length > 0
  }

  getTimeline(
    handle: number,
    uri: URI,
    options: ITimelineOptionsDto,
  ): Promise<ITimelineDto | undefined> {
    if (!this._extHost) return Promise.resolve(undefined)
    return this._extHost.$provideTimeline(handle, uri.toString(), options)
  }

  pinUri(uri: URI): void {
    this._pinnedUri.set(uri, undefined)
    this._uri.set(uri, undefined)
  }

  unpin(): void {
    this._pinnedUri.set(undefined, undefined)
  }

  reset(): void {
    this._providers.clear()
    this._providersObservable.set([], undefined)
    this._extHost = undefined
    this._uri.set(undefined, undefined)
    this._pinnedUri.set(undefined, undefined)
  }

  /** Follow-target updates from the view (active editor changed). Pinned wins. */
  followUri(uri: URI | undefined): void {
    if (this._pinnedUri.get() !== undefined) return
    this._uri.set(uri, undefined)
  }

  // --- IMainThreadTimeline (host → renderer) ---

  $registerTimelineProvider(
    handle: number,
    id: string,
    label: string,
    scheme: string[],
  ): Promise<void> {
    this._providers.set(handle, { handle, id, label, schemes: scheme })
    this._providersObservable.set([...this._providers.values()], undefined)
    return Promise.resolve()
  }

  $unregisterTimelineProvider(handle: number): Promise<void> {
    if (this._providers.delete(handle)) {
      this._providersObservable.set([...this._providers.values()], undefined)
    }
    return Promise.resolve()
  }

  $emitTimelineChangeEvent(handle: number, uri: string | undefined, reset: boolean): void {
    const provider = this._providers.get(handle)
    if (!provider) return
    this._onDidChangeTimeline.fire({
      source: provider.id,
      uri: uri !== undefined ? URI.parse(uri) : undefined,
      reset,
    })
  }
}
