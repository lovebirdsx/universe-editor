/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type {
  IOutputService,
  IOutputChannel,
  OutputState,
  IDisposable,
} from '@universe-editor/platform'

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

const EMPTY_STATE: OutputState = Object.freeze({
  channelNames: Object.freeze([]) as readonly string[],
  activeChannelName: undefined,
})

export class OutputService implements IOutputService {
  declare readonly _serviceBrand: undefined

  private readonly _channels = new Map<string, OutputChannel>()
  private _state: OutputState = EMPTY_STATE

  private readonly _onChange = new Emitter<void>()
  private readonly _onDidChangeActiveChannel = new Emitter<IOutputChannel | undefined>()
  readonly onDidChangeActiveChannel = this._onDidChangeActiveChannel.event

  getSnapshot(): OutputState {
    return this._state
  }

  subscribe(listener: () => void): IDisposable {
    return this._onChange.event(listener)
  }

  createChannel(name: string): IOutputChannel {
    const existing = this._channels.get(name)
    if (existing) return existing

    const channel = new OutputChannel(name)
    this._channels.set(name, channel)

    const channelNames = Object.freeze([...this._state.channelNames, name]) as readonly string[]
    const activeChannelName = this._state.activeChannelName ?? name
    const activeChanged = activeChannelName !== this._state.activeChannelName

    this._commit(Object.freeze({ channelNames, activeChannelName }))
    if (activeChanged) this._onDidChangeActiveChannel.fire(channel)

    return channel
  }

  getChannel(name: string): IOutputChannel | undefined {
    return this._channels.get(name)
  }

  getChannels(): readonly IOutputChannel[] {
    return [...this._channels.values()]
  }

  get activeChannel(): IOutputChannel | undefined {
    return this._state.activeChannelName === undefined
      ? undefined
      : this._channels.get(this._state.activeChannelName)
  }

  setActiveChannel(name: string): void {
    if (!this._channels.has(name)) return
    if (this._state.activeChannelName === name) return

    this._commit(
      Object.freeze({
        channelNames: this._state.channelNames,
        activeChannelName: name,
      }),
    )
    this._onDidChangeActiveChannel.fire(this._channels.get(name))
  }

  private _commit(next: OutputState): void {
    if (next === this._state) return
    this._state = next
    this._onChange.fire()
  }
}
