/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererDialogService — IDialogService implementation that drives a
 *  React-portal host (see workbench/dialog/DialogHost.tsx). The service owns
 *  the queue + notification emitter; the host is the view that subscribes.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService,
  type IPromptOptions,
} from '@universe-editor/platform'
import { getActiveWorkbenchDocument } from '../windows/workbenchDocuments.js'

type Resolver<T> = (value: T) => void

export interface ConfirmEntry {
  readonly kind: 'confirm'
  readonly opts: IConfirmOptions
  readonly resolve: Resolver<IConfirmResult>
  readonly document: Document
}
export interface PromptEntry {
  readonly kind: 'prompt'
  readonly opts: IPromptOptions
  readonly resolve: Resolver<string | undefined>
  readonly document: Document
}
export type DialogEntry = ConfirmEntry | PromptEntry

export class RendererDialogService extends Disposable implements IDialogService {
  declare readonly _serviceBrand: undefined

  private readonly _queue: DialogEntry[] = []
  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  /** Snapshot of the current queue for the host component. */
  get queue(): readonly DialogEntry[] {
    return this._queue
  }

  confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    return new Promise<IConfirmResult>((resolve) => {
      this._queue.push({
        kind: 'confirm',
        opts,
        resolve,
        document: getActiveWorkbenchDocument(),
      })
      this._onDidChange.fire()
    })
  }

  prompt(opts: IPromptOptions): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this._queue.push({
        kind: 'prompt',
        opts,
        resolve,
        document: getActiveWorkbenchDocument(),
      })
      this._onDidChange.fire()
    })
  }

  /** Internal — invoked by DialogHost when the user resolves the head entry. */
  _resolveHead<T>(value: T): void {
    const head = this._queue.shift()
    if (!head) return
    ;(head.resolve as Resolver<T>)(value)
    this._onDidChange.fire()
  }
}
