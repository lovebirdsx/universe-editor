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
  quickNavigate?: { modifier: 'ctrl'; initialSelectionIndex?: number } | undefined
  /** Show an indeterminate progress bar at the top of the panel. */
  busy?: boolean | undefined
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
    this._currentState = state
    this._visibleKey.set(state !== null)
    this._onDidChangeState.fire(state)
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
    let _busy = false
    let _visible = false

    const pushState = (): void => {
      if (!_visible) return
      this._setState({
        type: 'pick',
        items: _items,
        placeholder: _placeholder,
        busy: _busy,
        onAccept: (selected) => onDidAccept.fire(selected as T[]),
        onHide: () => onDidHide.fire(),
      })
    }

    const qp: IQuickPick<T> = {
      get placeholder() {
        return _placeholder
      },
      set placeholder(v) {
        _placeholder = v
        pushState()
      },
      get items() {
        return _items
      },
      set items(v) {
        _items = v
        pushState()
      },
      get busy() {
        return _busy
      },
      set busy(v) {
        _busy = v
        pushState()
      },
      onDidAccept: onDidAccept.event,
      onDidHide: onDidHide.event,
      show: () => {
        _visible = true
        this._currentOnHide = () => onDidHide.fire()
        pushState()
      },
      hide: () => {
        _visible = false
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
        quickNavigate: options?.quickNavigate,
        busy: options?.busy,
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
