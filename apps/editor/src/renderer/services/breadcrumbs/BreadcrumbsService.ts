/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BreadcrumbsService — one controller per editor group plus the root context
 *  keys the breadcrumb commands are gated on. The bar itself registers here;
 *  commands resolve the ACTIVE group's controller, so a split view's background
 *  bar never reacts to a key pressed for the focused group.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IContextKeyService,
  IEditorGroupsService,
  type IContextKey,
  type IDisposable,
} from '@universe-editor/platform'

export interface IBreadcrumbsController {
  readonly groupId: number
  focusLast(): void
  focusAndSelectLast(): void
  focusNext(): void
  focusPrevious(): void
  selectFocused(): void
  revealFocused(): void
  selectEditor(): void
  dismissPicker(): void
}

export interface IBreadcrumbsService {
  readonly _serviceBrand: undefined
  /** The controller whose bar/picker currently owns focus, if any. */
  readonly activeController: IBreadcrumbsController | undefined
  register(groupId: number, controller: IBreadcrumbsController): IDisposable
  get(groupId: number | undefined): IBreadcrumbsController | undefined
  /** Mark the bar/picker as the keyboard owner (sets `breadcrumbsActive`). */
  activate(controller: IBreadcrumbsController): void
  deactivate(controller: IBreadcrumbsController): void
}

export const IBreadcrumbsService = createDecorator<IBreadcrumbsService>('breadcrumbsService')

export class BreadcrumbsService extends Disposable implements IBreadcrumbsService {
  declare readonly _serviceBrand: undefined

  private readonly _controllers = new Map<number, IBreadcrumbsController>()
  private _active: IBreadcrumbsController | undefined
  private readonly _possibleKey: IContextKey<boolean>
  private readonly _visibleKey: IContextKey<boolean>
  private readonly _activeKey: IContextKey<boolean>

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super()
    this._possibleKey = contextKeyService.createKey('breadcrumbsPossible', false)
    this._visibleKey = contextKeyService.createKey('breadcrumbsVisible', false)
    this._activeKey = contextKeyService.createKey('breadcrumbsActive', false)

    this._register(
      this._groups.onDidActiveGroupChange(() => {
        this._active?.dismissPicker()
        this._refresh()
      }),
    )
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        const controller = this._controllers.get(group.id)
        if (!controller) return
        this._controllers.delete(group.id)
        if (this._active === controller) this._clearActive()
        this._refresh()
      }),
    )
    this._refresh()
  }

  get activeController(): IBreadcrumbsController | undefined {
    return this._active
  }

  register(groupId: number, controller: IBreadcrumbsController): IDisposable {
    this._controllers.set(groupId, controller)
    this._refresh()
    return {
      dispose: () => {
        if (this._controllers.get(groupId) !== controller) return
        this._controllers.delete(groupId)
        if (this._active === controller) this._clearActive()
        this._refresh()
      },
    }
  }

  get(groupId: number | undefined): IBreadcrumbsController | undefined {
    if (groupId === undefined) return undefined
    return this._controllers.get(groupId)
  }

  activate(controller: IBreadcrumbsController): void {
    this._active = controller
    this._activeKey.set(true)
  }

  deactivate(controller: IBreadcrumbsController): void {
    if (this._active !== controller) return
    this._clearActive()
  }

  private _clearActive(): void {
    this._active = undefined
    this._activeKey.set(false)
  }

  private _refresh(): void {
    const has = this._controllers.has(this._groups.activeGroup.id)
    this._possibleKey.set(has)
    this._visibleKey.set(has)
  }
}
