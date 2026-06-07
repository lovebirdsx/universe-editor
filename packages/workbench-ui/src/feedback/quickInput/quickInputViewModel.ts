/*---------------------------------------------------------------------------------------------
 *  QuickPickState — the view model the QuickInput panel renders. Pure data + the
 *  callbacks the host wires to its QuickInput service. Lives in workbench-ui so the
 *  panel is presentational; the host re-exports this type from its service module.
 *--------------------------------------------------------------------------------------------*/

import type {
  IKeyMods,
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
  onAccept?: (items: IQuickPickItem[], mods?: IKeyMods) => void
  onItemRemove?: ((item: IQuickPickItem) => void) | undefined
  onValueChange?: (value: string) => void
  /** Fires when the focused (active) item changes; `undefined` when none. */
  onActiveChange?: (item: IQuickPickItem | undefined) => void
  onInput?: (value: string) => void
  onHide?: () => void
  validateInput?: ((value: string) => string | undefined) | undefined
  inputValue?: string | undefined
  inputPrompt?: string | undefined
}
