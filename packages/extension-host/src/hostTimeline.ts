/**
 * Host-side registry backing `workspace.registerTimelineProvider`. Providers are
 * addressed by host-allocated handles; registrations and change events push to
 * the renderer's built-in timeline view over `IMainThreadTimeline`, and page
 * requests come back through `ExtHostTimelineRegistry.provideTimeline`.
 *
 * The registry owns the `onDidChange` subscription per provider: it must not be
 * pushed onto an extension's subscriptions (the public Disposable returned by
 * registerTimelineProvider is what the extension pushes), so dispose here also
 * covers host shutdown.
 */
import type { Disposable, TimelineProvider } from '@universe-editor/extension-api'
import type {
  ICommandDto,
  IMainThreadTimeline,
  ITimelineDto,
  ITimelineItemDto,
  ITimelineOptionsDto,
} from '@universe-editor/extensions-common'

interface IRegisteredProvider {
  readonly provider: TimelineProvider
  readonly changeListener: Disposable | undefined
}

/** The extension API's CancellationToken is structural; provider requests from
 *  the view don't cancel mid-flight, so a never-cancelled token suffices. */
const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
}

function toCommandDto(cmd: {
  command: string
  title: string
  tooltip?: string
  arguments?: unknown[]
}): ICommandDto {
  return {
    command: cmd.command,
    title: cmd.title,
    ...(cmd.tooltip !== undefined ? { tooltip: cmd.tooltip } : {}),
    ...(cmd.arguments !== undefined ? { arguments: cmd.arguments } : {}),
  }
}

function toItemDto(
  source: string,
  item: {
    id?: string
    label: string
    description?: string
    tooltip?: string
    timestamp: number
    themeIcon?: string
    command?: { command: string; title: string; tooltip?: string; arguments?: unknown[] }
    contextValue?: string
  },
): ITimelineItemDto {
  return {
    handle: `${source}|${item.id ?? item.timestamp}`,
    source,
    ...(item.id !== undefined ? { id: item.id } : {}),
    label: item.label,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.tooltip !== undefined ? { tooltip: item.tooltip } : {}),
    timestamp: item.timestamp,
    ...(item.themeIcon !== undefined ? { themeIcon: item.themeIcon } : {}),
    ...(item.command !== undefined ? { command: toCommandDto(item.command) } : {}),
    ...(item.contextValue !== undefined ? { contextValue: item.contextValue } : {}),
  }
}

export class ExtHostTimelineRegistry {
  private readonly _providers = new Map<number, IRegisteredProvider>()
  private readonly _schemeByHandle = new Map<number, string[]>()
  private _handle = 0

  constructor(private readonly _mainThread: IMainThreadTimeline) {}

  registerTimelineProvider(scheme: string[], provider: TimelineProvider): Disposable {
    const handle = this._handle++
    const changeListener = provider.onDidChange?.((e) => {
      this._mainThread.$emitTimelineChangeEvent(handle, e.uri, e.reset)
    })
    this._providers.set(handle, { provider, changeListener })
    this._schemeByHandle.set(handle, scheme)
    void this._mainThread.$registerTimelineProvider(handle, provider.id, provider.label, scheme)
    return {
      dispose: () => {
        if (!this._providers.delete(handle)) return
        this._schemeByHandle.delete(handle)
        changeListener?.dispose()
        void this._mainThread.$unregisterTimelineProvider(handle)
      },
    }
  }

  async provideTimeline(
    handle: number,
    uri: string,
    options: ITimelineOptionsDto,
  ): Promise<ITimelineDto | undefined> {
    const entry = this._providers.get(handle)
    if (!entry) return undefined
    const timeline = await entry.provider.provideTimeline(uri, options, NEVER_CANCELLED)
    if (!timeline) return undefined
    return {
      source: entry.provider.id,
      items: timeline.items.map((item) => toItemDto(entry.provider.id, item)),
      ...(timeline.cursor !== undefined ? { cursor: timeline.cursor } : {}),
    }
  }

  dispose(): void {
    for (const handle of [...this._providers.keys()]) {
      const entry = this._providers.get(handle)
      entry?.changeListener?.dispose()
      void this._mainThread.$unregisterTimelineProvider(handle)
    }
    this._providers.clear()
    this._schemeByHandle.clear()
  }
}
