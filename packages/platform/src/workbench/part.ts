/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's Part class (workbench/browser/part.ts).
 *
 *  A Part is a first-class workbench region (ActivityBar / SideBar / Editor / Panel / ...).
 *  Each Part owns: id, role, visibility observable, focus target, container element.
 *
 *  In universe-editor the actual DOM rendering is delegated to React. The container
 *  element is supplied by the React adapter (`usePartContainer`) via the internal
 *  `_attachContainer` method.
 *
 *  Mount state machine: React reconciler decides when the container appears, so
 *  `focus()` may run before the DOM is ready. We track `mountState` and queue a
 *  pending focus that flushes on mount; callers can await `whenMounted()` to
 *  observe the transition. Pending tokens expire after FOCUS_TIMEOUT_MS so a
 *  request to a permanently hidden Part doesn't fire weeks later.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable } from '../base/lifecycle.js'
import { autorun, derived, IObservable } from '../base/observable/index.js'
import type { ILayoutService, PartId } from './layoutService.js'

export interface IPartContainerElement {
  focus(): void
  contains?(node: unknown): boolean
}

export type PartMountState = 'unmounted' | 'mounted'

const FOCUS_TIMEOUT_MS = 2000

export interface IPart extends IDisposable {
  readonly id: PartId
  readonly role: string
  readonly visible: IObservable<boolean>
  readonly onDidVisibilityChange: Event<boolean>

  readonly mountState: PartMountState
  readonly onDidMount: Event<void>
  readonly onDidUnmount: Event<void>
  readonly onDidFocus: Event<void>
  readonly onDidBlur: Event<void>

  getContainer(): IPartContainerElement | undefined
  focus(): void
  isFocused(): boolean
  hasPendingFocus(): boolean

  /**
   * Resolves when the Part's container is mounted. Resolves immediately if
   * already mounted. Rejects on timeout (default 2000ms) — useful when the
   * Part is hidden and unlikely to mount in the foreseeable future.
   */
  whenMounted(timeoutMs?: number): Promise<void>

  layout?(dimension: { width: number; height: number }): void
}

export abstract class Part extends Disposable implements IPart {
  protected _container: IPartContainerElement | undefined
  protected _focusTarget: IPartContainerElement | undefined

  private _mountState: PartMountState = 'unmounted'
  private _pendingFocus: { token: number; expiresAt: number } | undefined
  private static _focusToken = 0

  readonly visible: IObservable<boolean>
  private readonly _onDidVisibilityChange = this._register(new Emitter<boolean>())
  readonly onDidVisibilityChange: Event<boolean> = this._onDidVisibilityChange.event

  private readonly _onDidMount = this._register(new Emitter<void>())
  readonly onDidMount: Event<void> = this._onDidMount.event
  private readonly _onDidUnmount = this._register(new Emitter<void>())
  readonly onDidUnmount: Event<void> = this._onDidUnmount.event
  private readonly _onDidFocus = this._register(new Emitter<void>())
  readonly onDidFocus: Event<void> = this._onDidFocus.event
  private readonly _onDidBlur = this._register(new Emitter<void>())
  readonly onDidBlur: Event<void> = this._onDidBlur.event

  constructor(
    readonly id: PartId,
    readonly role: string,
    protected readonly _layoutService: ILayoutService,
  ) {
    super()

    this.visible = derived(this, (reader) => this._layoutService.visible.read(reader)[id])

    let firstRun = true
    let last = this.visible.get()
    this._register(
      autorun((reader) => {
        const next = this.visible.read(reader)
        if (!firstRun && next !== last) {
          this._onDidVisibilityChange.fire(next)
        }
        firstRun = false
        last = next
      }),
    )

    this._register(this._layoutService.registerPart(this))
  }

  get mountState(): PartMountState {
    return this._mountState
  }

  getContainer(): IPartContainerElement | undefined {
    return this._container
  }

  focus(): void {
    const target = this._focusTarget ?? this._container
    if (this._mountState === 'mounted' && target) {
      target.focus()
      this._onDidFocus.fire()
      return
    }
    this._pendingFocus = {
      token: ++Part._focusToken,
      expiresAt: Date.now() + FOCUS_TIMEOUT_MS,
    }
  }

  hasPendingFocus(): boolean {
    const pending = this._pendingFocus
    if (!pending) return false
    if (Date.now() >= pending.expiresAt) {
      this._pendingFocus = undefined
      return false
    }
    return true
  }

  isFocused(): boolean {
    const container = this._container
    if (!container) return false
    const g = globalThis as unknown as { document?: { activeElement: unknown } }
    const active = g.document?.activeElement ?? null
    return typeof container.contains === 'function' && container.contains(active)
  }

  whenMounted(timeoutMs: number = FOCUS_TIMEOUT_MS): Promise<void> {
    if (this._mountState === 'mounted') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const sub = this.onDidMount(() => {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      })
      const timer = setTimeout(() => {
        sub.dispose()
        reject(new Error(`[Part] '${this.id}' did not mount within ${timeoutMs}ms`))
      }, timeoutMs)
    })
  }

  /** @internal Called by the view layer when the container mounts / unmounts. */
  _attachContainer(el: IPartContainerElement | null): void {
    if (el === null) {
      if (this._mountState === 'mounted') {
        this._mountState = 'unmounted'
        this._container = undefined
        this._pendingFocus = undefined
        this._onDidUnmount.fire()
      }
      return
    }
    if (this._container === el && this._mountState === 'mounted') return
    this._container = el
    if (this._mountState !== 'mounted') {
      this._mountState = 'mounted'
      this._onDidMount.fire()
    }
    const pending = this._pendingFocus
    this._pendingFocus = undefined
    if (pending && Date.now() < pending.expiresAt) {
      // Defer to let any child component register its focus target first.
      queueMicrotask(() => {
        if (this._mountState === 'mounted') this.focus()
      })
    }
  }

  /** @internal Called by the view layer to designate the focusable element. */
  _setFocusTarget(el: IPartContainerElement | null): void {
    this._focusTarget = el ?? undefined
  }

  /** @internal Bridge from real focusin/focusout events (used by FocusTracker). */
  _notifyFocusChange(focused: boolean): void {
    if (focused) this._onDidFocus.fire()
    else this._onDidBlur.fire()
  }

  override dispose(): void {
    this._container = undefined
    this._focusTarget = undefined
    this._pendingFocus = undefined
    if (this._mountState === 'mounted') {
      this._mountState = 'unmounted'
      this._onDidUnmount.fire()
    }
    super.dispose()
  }
}
