/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IQuickInputService implementation using React portals.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  IContextKeyService,
  IStorageService,
  type Event,
  type IContextKey,
} from '@universe-editor/platform'
import type {
  IQuickInputService,
  IQuickPick,
  IQuickPickItem,
  IPickOptions,
  IInputOptions,
  QuickPickFilterMode,
} from '@universe-editor/platform'

export interface QuickPickState {
  type: 'pick' | 'input'
  items?: readonly IQuickPickItem[]
  mruIds?: readonly string[]
  placeholder?: string | undefined
  prefix?: string | undefined
  matchOnDescription?: boolean | undefined
  matchOnDetail?: boolean | undefined
  filterMode?: QuickPickFilterMode | undefined
  onAccept?: (items: IQuickPickItem[]) => void
  onInput?: (value: string) => void
  onHide?: () => void
  validateInput?: ((value: string) => string | undefined) | undefined
  inputValue?: string | undefined
  inputPrompt?: string | undefined
}

export class QuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeState = new Emitter<QuickPickState | null>()
  readonly onDidChangeState: Event<QuickPickState | null> = this._onDidChangeState.event

  private _currentState: QuickPickState | null = null
  private _currentOnHide: (() => void) | undefined
  private readonly _visibleKey: IContextKey<boolean>
  private _restoreFocusTarget: HTMLElement | null = null

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    this._visibleKey = contextKeyService.createKey<boolean>('quickInputVisible', false)
  }

  get currentState(): QuickPickState | null {
    return this._currentState
  }

  private _setState(state: QuickPickState | null): void {
    const wasVisible = this._currentState !== null
    const willBeVisible = state !== null
    if (!wasVisible && willBeVisible) this._captureFocusTarget()
    this._currentState = state
    this._visibleKey.set(state !== null)
    this._onDidChangeState.fire(state)
    if (wasVisible && !willBeVisible) this._restoreFocus()
  }

  private _captureFocusTarget(): void {
    if (typeof document === 'undefined') {
      this._restoreFocusTarget = null
      return
    }
    const active = document.activeElement
    this._restoreFocusTarget =
      active instanceof HTMLElement && active !== document.body && active.isConnected
        ? active
        : null
  }

  private _restoreFocus(): void {
    const target = this._restoreFocusTarget
    this._restoreFocusTarget = null
    if (!target) return

    const focus = () => {
      if (!target.isConnected) return
      // A command executed from the palette may have already moved DOM focus to a
      // Monaco editor. Don't steal it back — that would undo the command's intent.
      if (document.activeElement?.closest('.monaco-editor') !== null) return
      target.focus()
    }

    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(focus, 0)
      return
    }
    focus()
  }

  hide(): void {
    if (!this._currentState) return
    const onHide = this._currentOnHide
    this._currentOnHide = undefined
    this._setState(null)
    onHide?.()
  }

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    const onDidAccept = new Emitter<T[]>()
    const onDidHide = new Emitter<void>()
    let _items: readonly T[] = []
    let _placeholder: string | undefined

    const qp: IQuickPick<T> = {
      get placeholder() {
        return _placeholder
      },
      set placeholder(v) {
        _placeholder = v
      },
      get items() {
        return _items
      },
      set items(v) {
        _items = v
      },
      onDidAccept: onDidAccept.event,
      onDidHide: onDidHide.event,
      show: () => {
        this._currentOnHide = () => onDidHide.fire()
        this._setState({
          type: 'pick',
          items: _items,
          placeholder: _placeholder,
          onAccept: (selected) => onDidAccept.fire(selected as T[]),
          onHide: () => onDidHide.fire(),
        })
      },
      hide: () => {
        this.hide()
      },
      dispose: () => {
        onDidAccept.dispose()
        onDidHide.dispose()
      },
    }
    return qp
  }

  async pick<T extends IQuickPickItem>(
    items: readonly T[],
    options?: IPickOptions,
  ): Promise<T | undefined> {
    const id = options?.id
    let mruIds: string[] = []
    if (id) {
      mruIds = (await this._storage.get<string[]>(`quickinput.mru.${id}`)) ?? []
    }

    return new Promise((resolve) => {
      this._currentOnHide = () => resolve(undefined)
      this._setState({
        type: 'pick',
        items,
        mruIds,
        placeholder: options?.placeholder,
        prefix: options?.prefix,
        matchOnDescription: options?.matchOnDescription,
        matchOnDetail: options?.matchOnDetail,
        filterMode: options?.filterMode,
        onAccept: (selected) => {
          this._currentOnHide = undefined
          this._setState(null)
          const item = selected[0] as T | undefined
          if (id && item?.id) {
            const newMru = [item.id, ...mruIds.filter((x) => x !== item.id)].slice(0, 20)
            void this._storage.set(`quickinput.mru.${id}`, newMru)
          }
          resolve(item)
        },
      })
    })
  }

  async input(options?: IInputOptions): Promise<string | undefined> {
    const id = options?.id
    let storedValue: string | undefined
    if (id) {
      storedValue = await this._storage.get<string>(`quickinput.lastValue.${id}`)
    }

    return new Promise((resolve) => {
      this._currentOnHide = () => resolve(undefined)
      this._setState({
        type: 'input',
        placeholder: options?.placeholder,
        inputPrompt: options?.prompt,
        inputValue: options?.value ?? storedValue ?? '',
        validateInput: options?.validateInput,
        onInput: (value) => {
          this._currentOnHide = undefined
          this._setState(null)
          if (id) void this._storage.set(`quickinput.lastValue.${id}`, value)
          resolve(value)
        },
      })
    })
  }
}
