/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IQuickInputService implementation using React portals.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
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
  placeholder?: string | undefined
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

  pick<T extends IQuickPickItem>(
    items: readonly T[],
    options?: IPickOptions,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      this._showFn?.({
        type: 'pick',
        items,
        placeholder: options?.placeholder,
        onAccept: (selected) => {
          this._showFn?.(null)
          resolve(selected[0] as T | undefined)
        },
        onHide: () => resolve(undefined),
      })
    })
  }

  input(options?: IInputOptions): Promise<string | undefined> {
    return new Promise((resolve) => {
      this._showFn?.({
        type: 'input',
        placeholder: options?.placeholder,
        inputPrompt: options?.prompt,
        inputValue: options?.value ?? '',
        validateInput: options?.validateInput,
        onInput: (value) => {
          this._showFn?.(null)
          resolve(value)
        },
        onHide: () => resolve(undefined),
      })
    })
  }
}
