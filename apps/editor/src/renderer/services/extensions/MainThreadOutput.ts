import {
  Disposable,
  DisposableMap,
  type IOutputChannel,
  type IOutputService,
} from '@universe-editor/platform'
import type { IMainThreadOutput } from '@universe-editor/extensions-common'

export class MainThreadOutput extends Disposable implements IMainThreadOutput {
  private readonly _channels = this._register(new DisposableMap<number, IOutputChannel>())

  constructor(private readonly _outputService: IOutputService) {
    super()
  }

  async $registerOutputChannel(handle: number, name: string): Promise<void> {
    const channel = this._outputService.createChannel(name)
    this._channels.set(handle, channel)
  }

  async $append(handle: number, text: string): Promise<void> {
    this._channels.get(handle)?.append(text)
  }

  async $clearOutputChannel(handle: number): Promise<void> {
    this._channels.get(handle)?.clear()
  }

  async $showOutputChannel(handle: number): Promise<void> {
    const ch = this._channels.get(handle)
    if (ch) this._outputService.setActiveChannel(ch.name)
  }

  async $disposeOutputChannel(handle: number): Promise<void> {
    this._channels.deleteAndDispose(handle)
  }
}
