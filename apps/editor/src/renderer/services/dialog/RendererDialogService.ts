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
import {
  getActiveWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'

type Resolver<T> = (value: T) => void

/** Result of a confirm dialog whose origin window closed before the user answered. */
function cancelForClosedDocument(opts: IConfirmOptions): IConfirmResult {
  return {
    confirmed: false,
    choice: 'cancel',
    neverAskAgain: false,
    // `checkboxChecked` is echoed on every exit path; the dialog's local state
    // died with its window, so the initial states are the only ones we have.
    ...(opts.checkboxes?.length
      ? { checkboxChecked: opts.checkboxes.map((checkbox) => checkbox.initiallyChecked ?? false) }
      : {}),
  }
}

export interface ConfirmEntry {
  /** 入队时分配，服务实例内单调递增；DialogHost 用它作为 React key。 */
  readonly id: number
  readonly kind: 'confirm'
  readonly opts: IConfirmOptions
  readonly resolve: Resolver<IConfirmResult>
  readonly document: Document
  /** 首次 resolve 后置位，忽略同一对话框的重复回报。 */
  settled?: boolean
}
export interface PromptEntry {
  readonly id: number
  readonly kind: 'prompt'
  readonly opts: IPromptOptions
  readonly resolve: Resolver<string | undefined>
  readonly document: Document
  settled?: boolean
}
export type DialogEntry = ConfirmEntry | PromptEntry

export class RendererDialogService extends Disposable implements IDialogService {
  declare readonly _serviceBrand: undefined

  private readonly _queue: DialogEntry[] = []
  /** 每次入队分配一个身份；宿主按它做 key，不能按队列位置派生。 */
  private _nextId = 0
  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  /** Snapshot of the current queue for the host component. */
  get queue(): readonly DialogEntry[] {
    return this._queue
  }

  constructor() {
    super()
    // The dialog is portalled into the document captured when it was enqueued.
    // If that window closes first the dialog is unreachable: settle every entry
    // it owns (the callers' promises would otherwise hang) and drop them from
    // the queue, which is head-ordered — one dead head would block every later
    // dialog forever.
    this._register(onDidRemoveWorkbenchDocument((doc) => this._forgetDocument(doc)))
  }

  private _forgetDocument(doc: Document): void {
    for (const entry of [...this._queue]) {
      if (entry.document !== doc || entry.settled === true) continue
      if (entry.kind === 'confirm') {
        this._resolveEntry(entry, cancelForClosedDocument(entry.opts))
      } else {
        this._resolveEntry(entry, undefined)
      }
    }
  }

  confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    return new Promise<IConfirmResult>((resolve) => {
      this._queue.push({
        id: this._nextId++,
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
        id: this._nextId++,
        kind: 'prompt',
        opts,
        resolve,
        document: getActiveWorkbenchDocument(),
      })
      this._onDidChange.fire()
    })
  }

  /**
   * 内部：DialogHost 在用户处理该对话框时调用。
   * 按 entry 身份而不是“当前队头”决议——对话框可能回报两次（按钮 Enter +
   * 背景 Enter、双击），盲移队头会把本次的值错答给下一个对话框。
   */
  _resolveEntry<T>(entry: DialogEntry, value: T): void {
    if (entry.settled === true) return
    const index = this._queue.indexOf(entry)
    if (index === -1) return
    entry.settled = true
    this._queue.splice(index, 1)
    ;(entry.resolve as Resolver<T>)(value)
    this._onDidChange.fire()
  }

  /** 内部：决议当前队头对话框。 */
  _resolveHead<T>(value: T): void {
    const head = this._queue[0]
    if (head) this._resolveEntry(head, value)
  }
}
