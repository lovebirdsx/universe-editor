/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IOutputService (workbench/contrib/output/common/output.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export interface IOutputChannel extends IDisposable {
  readonly name: string
  append(text: string): void
  appendLine(text: string): void
  clear(): void
  /** Current accumulated content. */
  getContent(): string
  readonly onDidAppend: Event<string>
}

/** Immutable snapshot of output service state. */
export interface OutputState {
  readonly channelNames: readonly string[]
  readonly activeChannelName: string | undefined
}

export interface IOutputService {
  readonly _serviceBrand: undefined

  createChannel(name: string): IOutputChannel
  getChannel(name: string): IOutputChannel | undefined
  getChannels(): readonly IOutputChannel[]

  readonly activeChannel: IOutputChannel | undefined
  setActiveChannel(name: string): void

  getSnapshot(): OutputState
  subscribe(listener: () => void): IDisposable

  /** @deprecated Legacy event. Prefer subscribe + getSnapshot. */
  readonly onDidChangeActiveChannel: Event<IOutputChannel | undefined>
}

export const IOutputService = createDecorator<IOutputService>('outputService')
