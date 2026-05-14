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
  readonly onDidAppend: Event<string>
}

export interface IOutputService {
  readonly _serviceBrand: undefined

  createChannel(name: string): IOutputChannel
  getChannel(name: string): IOutputChannel | undefined
  getChannels(): readonly IOutputChannel[]

  readonly activeChannel: IOutputChannel | undefined
  setActiveChannel(name: string): void

  readonly onDidChangeActiveChannel: Event<IOutputChannel | undefined>
}

export const IOutputService = createDecorator<IOutputService>('outputService')
