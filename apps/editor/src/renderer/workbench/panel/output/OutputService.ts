/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, derived, transaction } from '@universe-editor/platform'
import type { IOutputService, IOutputChannel } from '@universe-editor/platform'

export class OutputChannel implements IOutputChannel {
  readonly content = observableValue<string>('OutputChannel.content', '')

  constructor(readonly name: string) {}

  append(text: string): void {
    this.content.set(this.content.get() + text, undefined)
  }

  appendLine(text: string): void {
    this.append(text + '\n')
  }

  clear(): void {
    this.content.set('', undefined)
  }

  dispose(): void {}
}

export class OutputService implements IOutputService {
  declare readonly _serviceBrand: undefined

  private readonly _channels = new Map<string, OutputChannel>()

  readonly channelNames = observableValue<readonly string[]>('OutputService.channelNames', [])
  readonly activeChannelName = observableValue<string | undefined>(
    'OutputService.activeChannelName',
    undefined,
  )
  readonly activeChannelContent = derived(this, (r) => {
    const name = this.activeChannelName.read(r)
    if (!name) return ''
    const channel = this._channels.get(name)
    return channel ? channel.content.read(r) : ''
  })

  createChannel(name: string): IOutputChannel {
    const existing = this._channels.get(name)
    if (existing) return existing

    const channel = new OutputChannel(name)
    this._channels.set(name, channel)
    transaction((tx) => {
      this.channelNames.set([...this.channelNames.get(), name], tx)
      if (this.activeChannelName.get() === undefined) {
        this.activeChannelName.set(name, tx)
      }
    })

    return channel
  }

  getChannel(name: string): IOutputChannel | undefined {
    return this._channels.get(name)
  }

  getChannels(): readonly IOutputChannel[] {
    return [...this._channels.values()]
  }

  get activeChannel(): IOutputChannel | undefined {
    const name = this.activeChannelName.get()
    return name === undefined ? undefined : this._channels.get(name)
  }

  setActiveChannel(name: string): void {
    if (!this._channels.has(name)) return
    if (this.activeChannelName.get() === name) return
    this.activeChannelName.set(name, undefined)
  }
}
