/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererFocusTrackerService — document-level focusin/focusout observer.
 *
 *  Implementation details:
 *  - One delegated `focusin` + `focusout` listener on the document. Per-Part
 *    or per-element trackers are layered on top via `trackElement`.
 *  - A `setTimeout(0)` debounce merges adjacent focusout/focusin pairs (the
 *    "transient body focus" gap) so subscribers only see settled transitions.
 *  - On focus leaving the window entirely, fires with `current: null` after the
 *    debounce, but does NOT clear element trackers — they re-fire `true` when
 *    the user clicks back into a tracked subtree.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  markAsSingleton,
  toDisposable,
  type Event,
  type IDisposable,
  type IFocusChangeEvent,
  type IFocusTrackerService,
  type IFocusableElement,
} from '@universe-editor/platform'
import { isHTMLElementLike } from '@universe-editor/workbench-ui'
import {
  getActiveWorkbenchDocument,
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'

interface ElementTracker {
  readonly element: IFocusableElement
  readonly listener: (focused: boolean) => void
  lastState: boolean
}

function readActive(doc: Document): IFocusableElement | null {
  const active = doc.activeElement
  if (!isHTMLElementLike(active) || active === doc.body) return null
  return active as unknown as IFocusableElement
}

function readActiveUnlessRemoved(doc: Document, removed: Document): IFocusableElement | null {
  if (doc === removed) return null
  return readActive(doc)
}

export class RendererFocusTrackerService extends Disposable implements IFocusTrackerService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidFocusChange = this._register(new Emitter<IFocusChangeEvent>())
  readonly onDidFocusChange: Event<IFocusChangeEvent> = this._onDidFocusChange.event

  private _current: IFocusableElement | null = null
  private _pendingTarget: IFocusableElement | null = null
  private _settleTimer: ReturnType<typeof setTimeout> | undefined
  private _trackers = new Set<ElementTracker>()

  constructor(private readonly _doc: Document) {
    super()
    this._current = readActive(_doc)
    this._pendingTarget = this._current
    const attached = new Set<Document>()
    const onFocusIn = (e: FocusEvent): void => {
      const target = isHTMLElementLike(e.target) ? (e.target as unknown as IFocusableElement) : null
      this._scheduleSettle(target)
    }
    const onFocusOut = (): void => {
      // focusout fires before the next focusin lands. Schedule a settle pass
      // with the current candidate; the corresponding focusin overwrites
      // `_pendingTarget` if focus is moving within the window.
      this._scheduleSettle(this._pendingTarget)
    }
    // 辅助窗口是独立 document，焦点事件不会到达主文档；每个注册的文档各挂一对
    // 监听，并像其他焦点移动一样参与历史。
    const attach = (doc: Document): void => {
      if (attached.has(doc)) return
      attached.add(doc)
      doc.addEventListener('focusin', onFocusIn, true)
      doc.addEventListener('focusout', onFocusOut, true)
    }
    const detach = (doc: Document): void => {
      if (!attached.delete(doc)) return
      doc.removeEventListener('focusin', onFocusIn, true)
      doc.removeEventListener('focusout', onFocusOut, true)
    }
    attach(_doc)
    for (const doc of getWorkbenchDocuments()) attach(doc)
    const addSub = this._register(markAsSingleton(onDidAddWorkbenchDocument(attach)))
    const removeSub = this._register(
      markAsSingleton(
        onDidRemoveWorkbenchDocument((doc) => {
          detach(doc)
          this._reconcileAfterRemoval(doc)
        }),
      ),
    )
    this._register(
      toDisposable(() => {
        addSub.dispose()
        removeSub.dispose()
        for (const doc of attached) detach(doc)
        if (this._settleTimer !== undefined) clearTimeout(this._settleTimer)
      }),
    )
  }

  get current(): IFocusableElement | null {
    return this._current
  }

  trackElement(element: IFocusableElement, listener: (focused: boolean) => void): IDisposable {
    const entry: ElementTracker = {
      element,
      listener,
      lastState: this._elementContainsCurrent(element),
    }
    this._trackers.add(entry)
    return toDisposable(() => {
      this._trackers.delete(entry)
    })
  }

  private _scheduleSettle(target: IFocusableElement | null): void {
    this._pendingTarget = target
    if (this._settleTimer !== undefined) return
    this._settleTimer = setTimeout(() => {
      this._settleTimer = undefined
      this._settle()
    }, 0)
  }

  /**
   * 文档注销时不能把 current / pending 留在已销毁的 DOM 上：同步改指向仍有
   * 效的活动文档焦点（或 null）并通知订阅方，不引入额外延时。
   */
  private _reconcileAfterRemoval(removed: Document): void {
    const currentRemoved = this._inDocument(this._current, removed)
    const pendingRemoved = this._inDocument(this._pendingTarget, removed)
    if (!currentRemoved && !pendingRemoved) return

    const next =
      this._pendingTarget !== null && !pendingRemoved
        ? this._pendingTarget
        : !currentRemoved
          ? this._current
          : this._focusAfterRemoval(removed)

    this._pendingTarget = next
    if (this._settleTimer !== undefined) {
      clearTimeout(this._settleTimer)
      this._settleTimer = undefined
    }
    this._settle()
  }

  private _focusAfterRemoval(removed: Document): IFocusableElement | null {
    const activeDoc = getActiveWorkbenchDocument()
    if (activeDoc !== removed && getWorkbenchDocuments().includes(activeDoc)) {
      const active = readActive(activeDoc)
      if (active !== null) return active
    }
    return readActiveUnlessRemoved(this._doc, removed)
  }

  private _inDocument(element: IFocusableElement | null, doc: Document): boolean {
    if (element === null) return false
    const owner = (element as { ownerDocument?: Document | null }).ownerDocument
    return owner === doc || doc.contains(element as unknown as Node)
  }

  private _settle(): void {
    const next = this._pendingTarget
    const prev = this._current
    if (prev === next) {
      // Same element resolved (transient out/in) — but still poll element trackers
      // to catch initial state or movements within tracked subtrees.
      this._notifyTrackers()
      return
    }
    this._current = next
    this._onDidFocusChange.fire({ current: next, previous: prev })
    this._notifyTrackers()
  }

  private _notifyTrackers(): void {
    for (const t of this._trackers) {
      const now = this._elementContainsCurrent(t.element)
      if (now !== t.lastState) {
        t.lastState = now
        try {
          t.listener(now)
        } catch {
          // Listeners must not throw the tracker into a bad state.
        }
      }
    }
  }

  private _elementContainsCurrent(element: IFocusableElement): boolean {
    if (this._current === null) return false
    if (this._current === element) return true
    return typeof element.contains === 'function' ? element.contains(this._current) === true : false
  }
}
