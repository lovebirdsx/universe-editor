/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IOutputService (workbench/contrib/output/common/output.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { IObservable } from '../base/observable/index.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

/**
 * One batched mutation of a channel's retained text. Consumers mirroring the
 * content (e.g. a Monaco model) apply, in order: insert `appendedText` at the
 * tail, then delete `trimmedChars` characters from the head.
 */
export interface IOutputChannelFlushEvent {
  /** Text appended to the tail since the previous flush. Never empty. */
  readonly appendedText: string
  /** Characters dropped from the head by the retention trim (0 when none). */
  readonly trimmedChars: number
}

export interface IOutputChannel extends IDisposable {
  readonly name: string
  readonly kind?: string
  append(text: string): void
  appendLine(text: string): void
  clear(): void
  /**
   * Batched tail-append/head-trim signal, fired on a microtask after one or
   * more append() calls. Live UI must mirror this instead of re-reading the
   * full text.
   */
  readonly onDidFlush: Event<IOutputChannelFlushEvent>
  /** Fires synchronously on clear(). */
  readonly onDidClear: Event<void>
  /** True while the channel retains any text; updates synchronously on append/clear. */
  readonly hasContent: IObservable<boolean>
  /**
   * Full retained text, including not-yet-flushed appends. O(retained length)
   * — joins the chunk buffer. For probes/tests/one-off snapshots (e.g. seeding
   * a Monaco model); live UI must mirror onDidFlush instead.
   */
  getText(): string
}

export interface IOutputService {
  readonly _serviceBrand: undefined

  createChannel(name: string, kind?: string): IOutputChannel
  getChannel(name: string): IOutputChannel | undefined
  getChannels(): readonly IOutputChannel[]

  readonly activeChannel: IOutputChannel | undefined
  setActiveChannel(name: string): void

  /**
   * True while a persisted active-channel restore is still waiting for its
   * target channel to be created. Callers that auto-switch the active channel
   * (e.g. error auto-reveal) should defer to the restore while this holds.
   */
  readonly hasPendingRestoredChannel: boolean

  readonly channelNames: IObservable<readonly string[]>
  readonly activeChannelName: IObservable<string | undefined>
  /** Derived: true while the active channel retains any text. */
  readonly activeChannelHasContent: IObservable<boolean>
  /** Fires after a channel is disposed and removed from the registry. */
  readonly onDidRemoveChannel: Event<string>
}

export const IOutputService = createDecorator<IOutputService>('outputService')
