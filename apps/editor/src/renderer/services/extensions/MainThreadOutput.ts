import {
  Disposable,
  DisposableMap,
  formatLogTimestamp,
  type ILayoutService,
  type IOutputChannel,
  type IOutputService,
  type IViewsService,
} from '@universe-editor/platform'
import type { IMainThreadOutput } from '@universe-editor/extensions-common'
import { revealOutputPanel } from '../output/revealOutputPanel.js'
import { timestampLines } from './timestampLines.js'

export class MainThreadOutput extends Disposable implements IMainThreadOutput {
  private readonly _channels = this._register(new DisposableMap<number, IOutputChannel>())
  private readonly _atLineStart = new Map<number, boolean>()

  constructor(
    private readonly _outputService: IOutputService,
    private readonly _layoutService: ILayoutService,
    private readonly _viewsService: IViewsService,
  ) {
    super()
  }

  async $registerOutputChannel(handle: number, name: string): Promise<void> {
    const channel = this._outputService.createChannel(name)
    this._channels.set(handle, channel)
  }

  async $append(handle: number, text: string): Promise<void> {
    const channel = this._channels.get(handle)
    if (!channel) return
    const stamped = timestampLines(
      text,
      this._atLineStart.get(handle) ?? true,
      () => `[${formatLogTimestamp(new Date(), 'HH:mm:ss.SSS')}] `,
    )
    this._atLineStart.set(handle, stamped.atLineStart)
    channel.append(stamped.text)
  }

  async $clearOutputChannel(handle: number): Promise<void> {
    this._atLineStart.set(handle, true)
    this._channels.get(handle)?.clear()
  }

  async $showOutputChannel(handle: number): Promise<void> {
    const ch = this._channels.get(handle)
    if (!ch) return
    this._outputService.setActiveChannel(ch.name)
    revealOutputPanel(this._layoutService, this._viewsService)
  }

  async $disposeOutputChannel(handle: number): Promise<void> {
    this._channels.deleteAndDispose(handle)
    this._atLineStart.delete(handle)
  }
}
