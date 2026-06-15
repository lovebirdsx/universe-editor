/*---------------------------------------------------------------------------------------------
 *  QuickPickState — the view model the QuickInput panel renders. Pure data + the
 *  callbacks the host wires to its QuickInput service. Lives in workbench-ui so the
 *  panel is presentational; the host re-exports this type from its service module.
 *--------------------------------------------------------------------------------------------*/

import type {
  IKeyMods,
  IQuickInputButton,
  IQuickPickItem,
  QuickPickFilterMode,
  QuickPickInput,
  QuickPickPresentation,
} from '@universe-editor/platform'

export interface QuickPickState {
  type: 'pick' | 'input'
  items?: readonly QuickPickInput<IQuickPickItem>[]
  value?: string | undefined
  mruIds?: readonly string[]
  placeholder?: string | undefined
  prefix?: string | undefined
  matchOnDescription?: boolean | undefined
  matchOnDetail?: boolean | undefined
  filterMode?: QuickPickFilterMode | undefined
  presentation?: QuickPickPresentation | undefined
  filterExternally?: boolean | undefined
  quickNavigate?: { modifier: 'ctrl'; initialSelectionIndex?: number } | undefined
  /** Show an indeterminate progress bar at the top of the panel. */
  busy?: boolean | undefined
  /** Controlled cursor / selection in the input box as `[start, end]` offsets. */
  valueSelection?: [number, number] | undefined
  /** Programmatically highlight item(s); the panel focuses the first match. */
  activeItems?: readonly IQuickPickItem[] | undefined
  /** Title bar text shown above the input. */
  title?: string | undefined
  /** Toolbar buttons rendered in the input row. */
  buttons?: readonly IQuickInputButton[] | undefined
  /** When set, a confirm button with this label accepts the focused item. */
  okLabel?: string | undefined
  /**
   * When true, accepting an item fires `onAccept` but the panel stays open — the
   * host owns closing (used by the simple file dialog's directory navigation).
   */
  keepOpenOnAccept?: boolean | undefined
  /**
   * When false, the list does not auto-highlight the first item as items change;
   * focus is driven solely by `activeItems` and user arrow/mouse. Defaults to true.
   */
  autoFocusFirstItem?: boolean | undefined
  onAccept?: (items: IQuickPickItem[], mods?: IKeyMods) => void
  onItemRemove?: ((item: IQuickPickItem) => void) | undefined
  onValueChange?: (value: string) => void
  /** Fires when the focused (active) item changes; `undefined` when none. */
  onActiveChange?: (item: IQuickPickItem | undefined) => void
  /** Fires when a toolbar button is triggered. */
  onTriggerButton?: ((button: IQuickInputButton) => void) | undefined
  /** Fires when the confirm (OK) button is clicked. */
  onOk?: (() => void) | undefined
  onInput?: (value: string) => void
  onHide?: () => void
  validateInput?: ((value: string) => string | undefined) | undefined
  inputValue?: string | undefined
  inputPrompt?: string | undefined
}
