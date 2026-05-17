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
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable } from '../base/lifecycle.js'
import { autorun, derived, IObservable } from '../base/observable/index.js'
import type { ILayoutService, PartId } from './layoutService.js'

/**
 * Minimal structural type for the Part's underlying container element.
 * Declared locally so `@universe-editor/platform` does not depend on lib.dom
 * (HTMLElement is a structural supertype: every HTMLElement satisfies this).
 */
export interface IPartContainerElement {
  focus(): void
  contains?(node: unknown): boolean
}

export interface IPart extends IDisposable {
  readonly id: PartId
  /** Semantic role of the underlying container element (e.g. 'navigation', 'main'). */
  readonly role: string
  /** Visibility observable; mirrors `ILayoutService.visible[id]`. */
  readonly visible: IObservable<boolean>
  /** Lifetime-managed event mirror of `visible` changes. */
  readonly onDidVisibilityChange: Event<boolean>
  /** Underlying container element once mounted by the view layer; undefined before mount. */
  getContainer(): IPartContainerElement | undefined
  /** Focus the part's main interactive region. No-op if not mounted. */
  focus(): void
  /** Returns true if the part's container currently contains the active focus target. */
  isFocused(): boolean
  /** Optional layout callback for future dimension-driven parts. */
  layout?(dimension: { width: number; height: number }): void
}

export abstract class Part extends Disposable implements IPart {
  protected _container: IPartContainerElement | undefined
  protected _focusTarget: IPartContainerElement | undefined

  readonly visible: IObservable<boolean>
  private readonly _onDidVisibilityChange = this._register(new Emitter<boolean>())
  readonly onDidVisibilityChange: Event<boolean> = this._onDidVisibilityChange.event

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

  getContainer(): IPartContainerElement | undefined {
    return this._container
  }

  focus(): void {
    const target = this._focusTarget ?? this._container
    target?.focus()
  }

  isFocused(): boolean {
    const container = this._container
    if (!container) return false
    const g = globalThis as unknown as { document?: { activeElement: unknown } }
    const active = g.document?.activeElement ?? null
    return typeof container.contains === 'function' && container.contains(active)
  }

  /** @internal Called by the view layer when the container mounts / unmounts. */
  _attachContainer(el: IPartContainerElement | null): void {
    if (el === null) {
      this._container = undefined
      return
    }
    if (this._container === el) return
    this._container = el
  }

  /** @internal Called by the view layer to designate the focusable element. */
  _setFocusTarget(el: IPartContainerElement | null): void {
    this._focusTarget = el ?? undefined
  }

  override dispose(): void {
    this._container = undefined
    this._focusTarget = undefined
    super.dispose()
  }
}
