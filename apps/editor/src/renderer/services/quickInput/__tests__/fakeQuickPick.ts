/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FakeQuickPick / FakeQuickInputService — a recording stand-in for
 *  IQuickInputService in unit tests. It stores whatever the consumer writes and
 *  exposes the panel-side gestures (toggle a row, trigger a toolbar button,
 *  confirm, dismiss) so a test can drive the picker's lifecycle without
 *  rendering the real QuickInputPanel.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  type IInputOptions,
  type IKeyMods,
  type IQuickInputButton,
  type IQuickInputService,
  type IQuickPick,
  type IQuickPickItem,
  type IQuickPickItemButtonEvent,
  type IPickOptions,
  type QuickPickFilterMode,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'

function isItem<T extends IQuickPickItem>(input: QuickPickInput<T>): input is T {
  return !('type' in input)
}

export class FakeQuickPick<T extends IQuickPickItem> implements IQuickPick<T> {
  private readonly _onDidAccept = new Emitter<T[]>()
  private readonly _onDidHide = new Emitter<void>()
  private readonly _onDidChangeValue = new Emitter<string>()
  private readonly _onDidChangeSelection = new Emitter<T[]>()
  private readonly _onDidChangeActive = new Emitter<T | undefined>()
  private readonly _onDidTriggerButton = new Emitter<IQuickInputButton>()
  private readonly _onDidTriggerItemButton = new Emitter<IQuickPickItemButtonEvent<T>>()
  private readonly _onDidTriggerOk = new Emitter<IKeyMods>()

  readonly onDidAccept = this._onDidAccept.event
  readonly onDidHide = this._onDidHide.event
  readonly onDidChangeValue = this._onDidChangeValue.event
  readonly onDidChangeSelection = this._onDidChangeSelection.event
  readonly onDidChangeActive = this._onDidChangeActive.event
  readonly onDidTriggerButton = this._onDidTriggerButton.event
  readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event
  readonly onDidTriggerOk = this._onDidTriggerOk.event

  valueSelection: [number, number] | undefined
  activeItems: readonly T[] = []
  selectedItems: readonly T[] = []
  canSelectMany = false
  title: string | undefined
  buttons: readonly IQuickInputButton[] = []
  okLabel: string | undefined
  keepOpenOnAccept = false
  keyMods = { ctrl: false, alt: false }
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  value = ''
  prefix = ''
  mruIds: readonly string[] = []
  filterExternally = false
  filterMode: QuickPickFilterMode = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  shown = false
  disposed = false

  /** The checkbox rows, separators stripped. */
  get rows(): T[] {
    return this.items.filter(isItem)
  }

  item(id: string): T {
    const found = this.rows.find((row) => row.id === id)
    if (!found) throw new Error(`no quick pick item with id ${id}`)
    return found
  }

  show(): void {
    this.shown = true
  }

  hide(): void {
    if (!this.shown) return
    this.shown = false
    this._onDidHide.fire()
  }

  accept(item: T): void {
    this._onDidAccept.fire([item])
  }

  /**
   * Toggle a row's checkbox the way the panel does: it reports the proposed set
   * and leaves writing it back to `selectedItems` to the consumer, so a test
   * exercises the consumer's own onDidChangeSelection handler.
   */
  toggle(id: string): void {
    const next = this.selectedItems.some((row) => row.id === id)
      ? this.selectedItems.filter((row) => row.id !== id)
      : [...this.selectedItems, this.item(id)]
    this._onDidChangeSelection.fire(next)
  }

  triggerButton(button?: IQuickInputButton): void {
    const target = button ?? this.buttons[0]
    if (!target) throw new Error('the picker has no toolbar button to trigger')
    this._onDidTriggerButton.fire(target)
  }

  /** Confirm, i.e. the OK button / Enter on a multi-select picker. */
  triggerOk(): void {
    this._onDidTriggerOk.fire({ ctrl: false, alt: false })
  }

  dispose(): void {
    this.disposed = true
    this._onDidAccept.dispose()
    this._onDidHide.dispose()
    this._onDidChangeValue.dispose()
    this._onDidChangeSelection.dispose()
    this._onDidChangeActive.dispose()
    this._onDidTriggerButton.dispose()
    this._onDidTriggerItemButton.dispose()
    this._onDidTriggerOk.dispose()
  }
}

export class FakeQuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined
  picker: FakeQuickPick<IQuickPickItem> | undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    const picker = new FakeQuickPick<T>()
    this.picker = picker as unknown as FakeQuickPick<IQuickPickItem>
    return picker
  }

  async pick<T extends IQuickPickItem>(
    _items: readonly QuickPickInput<T>[],
    _options?: IPickOptions,
  ): Promise<T | undefined> {
    return undefined
  }

  async input(_options?: IInputOptions): Promise<string | undefined> {
    return undefined
  }

  hide(): void {
    this.picker?.hide()
  }
}
