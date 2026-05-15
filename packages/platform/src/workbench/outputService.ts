/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IOutputService (workbench/contrib/output/common/output.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export interface IOutputChannel extends IDisposable {
  readonly name: string
  append(text: string): void
  appendLine(text: string): void
  clear(): void
  /** Reactive content: use useObservable(channel.content) in React components. */
  readonly content: IObservable<string>
}

export interface IOutputService {
  readonly _serviceBrand: undefined

  createChannel(name: string): IOutputChannel
  getChannel(name: string): IOutputChannel | undefined
  getChannels(): readonly IOutputChannel[]

  readonly activeChannel: IOutputChannel | undefined
  setActiveChannel(name: string): void

  readonly channelNames: IObservable<readonly string[]>
  readonly activeChannelName: IObservable<string | undefined>
  /** Derived: content of the active channel (empty string when no channel active). */
  readonly activeChannelContent: IObservable<string>
}

export const IOutputService = createDecorator<IOutputService>('outputService')
