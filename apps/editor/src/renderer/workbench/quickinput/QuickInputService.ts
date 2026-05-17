/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IQuickInputService implementation using React portals.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, IStorageService } from '@universe-editor/platform'
import type {
  IQuickInputService,
  IQuickPick,
  IQuickPickItem,
  IPickOptions,
  IInputOptions,
} from '@universe-editor/platform'

type ShowQuickPickFn = (state: QuickPickState | null) => void

export interface QuickPickState {
  type: 'pick' | 'input'
  items?: readonly IQuickPickItem[]
  mruIds?: readonly string[]
  placeholder?: string | undefined
  prefix?: string | undefined
  onAccept?: (items: IQuickPickItem[]) => void
  onInput?: (value: string) => void
  onHide?: () => void
  validateInput?: ((value: string) => string | undefined) | undefined
  inputValue?: string | undefined
  inputPrompt?: string | undefined
}

export class QuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined

  private _showFn: ShowQuickPickFn | null = null

  constructor(@IStorageService private readonly _storage: IStorageService) {}

  /** Called by <QuickInputPortal> to register the React state setter. */
  registerShowFn(fn: ShowQuickPickFn): void {
    this._showFn = fn
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
        this._showFn?.({
          type: 'pick',
          items: _items,
          placeholder: _placeholder,
          onAccept: (selected) => onDidAccept.fire(selected as T[]),
          onHide: () => onDidHide.fire(),
        })
      },
      hide: () => {
        this._showFn?.(null)
        onDidHide.fire()
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
      this._showFn?.({
        type: 'pick',
        items,
        mruIds,
        placeholder: options?.placeholder,
        prefix: options?.prefix,
        onAccept: (selected) => {
          this._showFn?.(null)
          const item = selected[0] as T | undefined
          if (id && item?.id) {
            const newMru = [item.id, ...mruIds.filter((x) => x !== item.id)].slice(0, 20)
            void this._storage.set(`quickinput.mru.${id}`, newMru)
          }
          resolve(item)
        },
        onHide: () => resolve(undefined),
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
      this._showFn?.({
        type: 'input',
        placeholder: options?.placeholder,
        inputPrompt: options?.prompt,
        inputValue: options?.value ?? storedValue ?? '',
        validateInput: options?.validateInput,
        onInput: (value) => {
          this._showFn?.(null)
          if (id) void this._storage.set(`quickinput.lastValue.${id}`, value)
          resolve(value)
        },
        onHide: () => resolve(undefined),
      })
    })
  }
}
