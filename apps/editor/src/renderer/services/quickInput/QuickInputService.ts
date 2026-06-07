/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IQuickInputService implementation using React portals.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  IContextKeyService,
  IQuickInputService,
  IStorageService,
  InstantiationType,
  registerSingleton,
  type Event,
  type IContextKey,
} from '@universe-editor/platform'
import type {
  IQuickPick,
  IQuickPickItem,
  IPickOptions,
  IInputOptions,
  QuickPickInput,
  QuickPickPresentation,
} from '@universe-editor/platform'
import type { QuickPickState } from '@universe-editor/workbench-ui'

export type { QuickPickState }

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
    const onDidChangeValue = new Emitter<string>()
    let _items: readonly QuickPickInput<T>[] = []
    let _placeholder: string | undefined
    let _value = ''
    let _busy = false
    let _filterExternally = false
    let _presentation: QuickPickPresentation = 'default'
    let _visible = false

    const pushState = (): void => {
      if (!_visible) return
      this._setState({
        type: 'pick',
        items: _items,
        value: _value,
        placeholder: _placeholder,
        busy: _busy,
        filterExternally: _filterExternally,
        presentation: _presentation,
        onAccept: (selected) => onDidAccept.fire(selected as T[]),
        onValueChange: (value) => {
          _value = value
          onDidChangeValue.fire(value)
        },
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
      get value() {
        return _value
      },
      set value(v) {
        _value = v
        pushState()
      },
      get filterExternally() {
        return _filterExternally
      },
      set filterExternally(v) {
        _filterExternally = v
        pushState()
      },
      get presentation() {
        return _presentation
      },
      set presentation(v) {
        _presentation = v
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
      onDidChangeValue: onDidChangeValue.event,
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
        onDidChangeValue.dispose()
      },
    }
    return qp
  }

  async pick<T extends IQuickPickItem>(
    items: readonly QuickPickInput<T>[],
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
        presentation: options?.presentation,
        quickNavigate: options?.quickNavigate,
        busy: options?.busy,
        onItemRemove: options?.onItemRemove,
        onAccept: (selected, mods) => {
          this._currentOnHide = undefined
          this._setState(null)
          if (options?.keyMods && mods) {
            options.keyMods.ctrl = mods.ctrl
            options.keyMods.alt = mods.alt
          }
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

registerSingleton(IQuickInputService, QuickInputService, InstantiationType.Delayed)
