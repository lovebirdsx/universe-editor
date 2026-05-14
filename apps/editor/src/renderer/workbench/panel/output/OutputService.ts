/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { IOutputService, IOutputChannel } from '@universe-editor/platform'

export class OutputChannel implements IOutputChannel {
  private _content = ''

  private readonly _onDidAppend = new Emitter<string>()
  readonly onDidAppend = this._onDidAppend.event

  constructor(readonly name: string) {}

  append(text: string): void {
    this._content += text
    this._onDidAppend.fire(text)
  }

  appendLine(text: string): void {
    this.append(text + '\n')
  }

  clear(): void {
    this._content = ''
    this._onDidAppend.fire('')
  }

  getContent(): string {
    return this._content
  }

  dispose(): void {
    this._onDidAppend.dispose()
  }
}

export class OutputService implements IOutputService {
  declare readonly _serviceBrand: undefined

  private readonly _channels = new Map<string, OutputChannel>()
  private _activeChannel: OutputChannel | undefined

  private readonly _onDidChangeActiveChannel = new Emitter<IOutputChannel | undefined>()
  readonly onDidChangeActiveChannel = this._onDidChangeActiveChannel.event

  createChannel(name: string): IOutputChannel {
    const existing = this._channels.get(name)
    if (existing) return existing

    const channel = new OutputChannel(name)
    this._channels.set(name, channel)

    if (!this._activeChannel) {
      this._activeChannel = channel
      this._onDidChangeActiveChannel.fire(channel)
    }

    return channel
  }

  getChannel(name: string): IOutputChannel | undefined {
    return this._channels.get(name)
  }

  getChannels(): readonly IOutputChannel[] {
    return [...this._channels.values()]
  }

  get activeChannel(): IOutputChannel | undefined {
    return this._activeChannel
  }

  setActiveChannel(name: string): void {
    const channel = this._channels.get(name)
    if (channel && channel !== this._activeChannel) {
      this._activeChannel = channel
      this._onDidChangeActiveChannel.fire(channel)
    }
  }
}
