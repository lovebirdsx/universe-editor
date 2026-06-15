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
  IQuickInputButton,
  IPickOptions,
  IInputOptions,
  QuickPickFilterMode,
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
    const onDidChangeActive = new Emitter<T | undefined>()
    const onDidTriggerButton = new Emitter<IQuickInputButton>()
    const onDidTriggerOk = new Emitter<void>()
    let _items: readonly QuickPickInput<T>[] = []
    let _placeholder: string | undefined
    let _value = ''
    let _prefix = ''
    let _mruIds: readonly string[] = []
    let _busy = false
    let _filterExternally = false
    let _filterMode: QuickPickFilterMode = 'fuzzy'
    let _matchOnDescription = false
    let _matchOnDetail = false
    let _presentation: QuickPickPresentation = 'default'
    let _valueSelection: [number, number] | undefined
    let _activeItems: readonly T[] = []
    let _title: string | undefined
    let _buttons: readonly IQuickInputButton[] = []
    let _okLabel: string | undefined
    let _keepOpenOnAccept = false
    let _autoFocusFirstItem = true
    let _visible = false

    const pushState = (): void => {
      if (!_visible) return
      this._setState({
        type: 'pick',
        items: _items,
        value: _value,
        prefix: _prefix,
        mruIds: _mruIds,
        placeholder: _placeholder,
        busy: _busy,
        filterExternally: _filterExternally,
        filterMode: _filterMode,
        matchOnDescription: _matchOnDescription,
        matchOnDetail: _matchOnDetail,
        presentation: _presentation,
        valueSelection: _valueSelection,
        activeItems: _activeItems,
        title: _title,
        buttons: _buttons,
        okLabel: _okLabel,
        keepOpenOnAccept: _keepOpenOnAccept,
        autoFocusFirstItem: _autoFocusFirstItem,
        onAccept: (selected) => onDidAccept.fire(selected as T[]),
        onValueChange: (value) => {
          _value = value
          onDidChangeValue.fire(value)
        },
        onActiveChange: (item) => onDidChangeActive.fire(item as T | undefined),
        onTriggerButton: (button) => onDidTriggerButton.fire(button),
        onOk: () => onDidTriggerOk.fire(),
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
      get prefix() {
        return _prefix
      },
      set prefix(v) {
        _prefix = v
        pushState()
      },
      get mruIds() {
        return _mruIds
      },
      set mruIds(v) {
        _mruIds = v
        pushState()
      },
      get filterExternally() {
        return _filterExternally
      },
      set filterExternally(v) {
        _filterExternally = v
        pushState()
      },
      get filterMode() {
        return _filterMode
      },
      set filterMode(v) {
        _filterMode = v
        pushState()
      },
      get matchOnDescription() {
        return _matchOnDescription
      },
      set matchOnDescription(v) {
        _matchOnDescription = v
        pushState()
      },
      get matchOnDetail() {
        return _matchOnDetail
      },
      set matchOnDetail(v) {
        _matchOnDetail = v
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
      get valueSelection() {
        return _valueSelection
      },
      set valueSelection(v) {
        _valueSelection = v
        pushState()
      },
      get activeItems() {
        return _activeItems
      },
      set activeItems(v) {
        _activeItems = v
        pushState()
      },
      get title() {
        return _title
      },
      set title(v) {
        _title = v
        pushState()
      },
      get buttons() {
        return _buttons
      },
      set buttons(v) {
        _buttons = v
        pushState()
      },
      get okLabel() {
        return _okLabel
      },
      set okLabel(v) {
        _okLabel = v
        pushState()
      },
      get keepOpenOnAccept() {
        return _keepOpenOnAccept
      },
      set keepOpenOnAccept(v) {
        _keepOpenOnAccept = v
        pushState()
      },
      get autoFocusFirstItem() {
        return _autoFocusFirstItem
      },
      set autoFocusFirstItem(v) {
        _autoFocusFirstItem = v ?? true
        pushState()
      },
      onDidAccept: onDidAccept.event,
      onDidHide: onDidHide.event,
      onDidChangeValue: onDidChangeValue.event,
      onDidChangeActive: onDidChangeActive.event,
      onDidTriggerButton: onDidTriggerButton.event,
      onDidTriggerOk: onDidTriggerOk.event,
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
        onDidChangeActive.dispose()
        onDidTriggerButton.dispose()
        onDidTriggerOk.dispose()
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
        buttons: options?.buttons,
        onTriggerButton: options?.onDidTriggerButton
          ? (button) => {
              this._currentOnHide = undefined
              this._setState(null)
              resolve(undefined)
              options.onDidTriggerButton?.(button)
            }
          : undefined,
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
