/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard Shortcuts editor (VSCode parity): header with debounced search +
 *  toolbar (Record Keys / Sort by Precedence / Clear), virtualized keybinding
 *  table, define-keybinding overlay, inline when-expression editing, context
 *  menu, context keys, and the runtime handle that T8's Action2s drive.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import { CommandsRegistry, IContextKeyService, localize } from '@universe-editor/platform'
import { Badge, IconButton, Input } from '@universe-editor/workbench-ui'
import { ArrowDownWideNarrow, CircleDot, X } from 'lucide-react'
import { useService } from '../useService.js'
import { KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT } from '../preferences/preferencesFocus.js'
import {
  IUserKeybindingsService,
  type IKeybindingRowTarget,
} from '../../services/keybindings/UserKeybindingsService.js'
import {
  collectKeybindingModelDeps,
  normalizeKeybindingKey,
  resolveKeybindingEntries,
  type IKeybindingRow,
} from '../../services/keybindings/keybindingsEditorModel.js'
import {
  countKeybindingConflicts,
  fetchKeybindings,
  parseKeybindingsQuery,
} from '../../services/keybindings/keybindingsSearchModel.js'
import {
  registerKeybindingsEditor,
  type IKeybindingsEditorHandle,
} from '../../services/keybindings/keybindingsEditorRuntime.js'
import { buildKeyString, isModifierOnly } from './keyEventUtils.js'
import { DefineKeybindingOverlay } from './DefineKeybindingOverlay.js'
import { KeybindingsTable } from './KeybindingsTable.js'
import { KeybindingsContextMenu } from './KeybindingsContextMenu.js'
import styles from './KeybindingsEditor.module.css'

const SEARCH_DEBOUNCE_MS = 300

interface IMenuState {
  readonly x: number
  readonly y: number
  readonly row: IKeybindingRow
}

interface IDefineState {
  readonly row: IKeybindingRow
  readonly add: boolean
}

function rowTargetOf(row: IKeybindingRow): IKeybindingRowTarget {
  return {
    command: row.command,
    key: row.keybinding,
    when: row.when,
    isDefault: row.isDefault,
  }
}

export function KeybindingsEditor(): JSX.Element {
  const userKeybindingsService = useService(IUserKeybindingsService)
  const contextKeyService = useService(IContextKeyService)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sortByPrecedence, setSortByPrecedence] = useState(false)
  const [selectedRowId, setSelectedRowId] = useState<string | undefined>(undefined)
  const [revealRowId, setRevealRowId] = useState<string | undefined>(undefined)
  const [menuState, setMenuState] = useState<IMenuState | undefined>(undefined)
  const [tableFocused, setTableFocused] = useState(false)
  const [defineState, setDefineState] = useState<IDefineState | undefined>(undefined)
  const [recordingKeys, setRecordingKeys] = useState(false)
  const [whenEditingRowId, setWhenEditingRowId] = useState<string | undefined>(undefined)
  const [modelVersion, bumpModel] = useReducer((n: number) => n + 1, 0)

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const tableContainerRef = useRef<HTMLDivElement | null>(null)

  // Immediate echo in the input; the expensive re-filter trails by 300ms.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // The model is a pure function of the registries + user layer; resolution is
  // sub-millisecond, so any change just rebuilds it wholesale.
  useEffect(() => {
    const d1 = userKeybindingsService.onDidChange(() => bumpModel())
    const d2 = CommandsRegistry.onDidChangeCommands(() => bumpModel())
    return () => {
      d1.dispose()
      d2.dispose()
    }
  }, [userKeybindingsService])

  const model = useMemo(() => {
    void modelVersion
    return resolveKeybindingEntries(collectKeybindingModelDeps(userKeybindingsService))
  }, [userKeybindingsService, modelVersion])
  const parsedQuery = useMemo(() => parseKeybindingsQuery(debouncedQuery), [debouncedQuery])
  const rows = useMemo(
    () => fetchKeybindings(model, parsedQuery, sortByPrecedence),
    [model, parsedQuery, sortByPrecedence],
  )

  // -- context keys ---------------------------------------------------------
  // createKey without a default: a default would set the key during render and
  // fire onDidChangeContext into other components' render. Seed on mount,
  // reset on unmount.
  const inSearchKey = useMemo(
    () => contextKeyService.createKey<boolean>('inKeybindingsSearch', undefined),
    [contextKeyService],
  )
  const searchHasValueKey = useMemo(
    () => contextKeyService.createKey<boolean>('keybindingsSearchHasValue', undefined),
    [contextKeyService],
  )
  const keybindingFocusKey = useMemo(
    () => contextKeyService.createKey<boolean>('keybindingFocus', undefined),
    [contextKeyService],
  )
  const whenFocusKey = useMemo(
    () => contextKeyService.createKey<boolean>('whenFocus', undefined),
    [contextKeyService],
  )
  useEffect(() => {
    inSearchKey.set(false)
    searchHasValueKey.set(false)
    keybindingFocusKey.set(false)
    whenFocusKey.set(false)
    return () => {
      inSearchKey.reset()
      searchHasValueKey.reset()
      keybindingFocusKey.reset()
      whenFocusKey.reset()
    }
  }, [inSearchKey, searchHasValueKey, keybindingFocusKey, whenFocusKey])
  useEffect(() => {
    searchHasValueKey.set(query.trim() !== '')
  }, [query, searchHasValueKey])

  // whenFocus is owned by the inline when editor (WhenInputCell): true for the
  // whole editing session so Enter/Escape bindings can yield to the cell.
  const setWhenFocus = useCallback((v: boolean) => whenFocusKey.set(v), [whenFocusKey])

  const selectedIndex =
    selectedRowId === undefined ? -1 : rows.findIndex((m) => m.row.id === selectedRowId)
  const hasSelection = selectedIndex >= 0
  useEffect(() => {
    keybindingFocusKey.set(tableFocused && hasSelection)
  }, [tableFocused, hasSelection, keybindingFocusKey])

  // -- focus plumbing ---------------------------------------------------------
  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [])
  useEffect(() => {
    focusSearch()
    document.addEventListener(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
    return () => document.removeEventListener(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
  }, [focusSearch])

  // -- record keys mode ---------------------------------------------------------
  // While active, every keystroke (capture phase, stopPropagation — nothing
  // reaches the global dispatcher or the input) is appended to a max-2-stroke
  // chord and mirrored into the search box as a quoted complete-match query.
  const recordedStrokesRef = useRef<readonly string[]>([])
  useEffect(() => {
    if (!recordingKeys) return
    recordedStrokesRef.current = []
    focusSearch()
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecordingKeys(false)
        return
      }
      if (isModifierOnly(e.key)) return
      const key = buildKeyString(e)
      const prev = recordedStrokesRef.current
      const next = prev.length >= 2 ? [key] : [...prev, key]
      recordedStrokesRef.current = next
      setQuery(`"${next.join(' ')}"`)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recordingKeys, focusSearch])

  // -- define keybinding overlay -------------------------------------------------
  const closeDefine = useCallback(() => {
    setDefineState(undefined)
    tableContainerRef.current?.focus()
  }, [])

  const confirmDefine = useCallback(
    (key: string) => {
      const state = defineState
      setDefineState(undefined)
      tableContainerRef.current?.focus()
      if (!state) return
      const { row, add } = state
      const normalized = normalizeKeybindingKey(key)
      if (normalized === '') return
      if (!add && row.keybinding !== undefined) {
        if (normalized === row.keybinding) return
        userKeybindingsService.editKeybinding(rowTargetOf(row), normalized, row.when)
        return
      }
      // Add mode (explicit, or implicit because the row had no binding).
      if (normalized === row.keybinding) return
      // Only the synthetic "@command:x +when:y" virtual row carries its when
      // into an add; a plain add never copies the row's when.
      const when = row.keybinding === undefined ? row.when : undefined
      userKeybindingsService.addKeybinding(row.command, normalized, when)
      if (row.keybinding === undefined) {
        // The fresh row is a user-layer row; reveal + select it once the model
        // rebuild lands (VSCode's unAssignedKeybindingItemToRevealAndFocus).
        setRevealRowId(`${row.command}|${normalized}|${when ?? ''}|user`)
      }
    },
    [defineState, userKeybindingsService],
  )

  const countConflictsFor = useCallback(
    (key: string) => countKeybindingConflicts(model, key),
    [model],
  )

  const showConflicts = useCallback(
    (key: string) => {
      setDefineState(undefined)
      setQuery(`"${key}"`)
      focusSearch()
    },
    [focusSearch],
  )

  // -- inline when editing ---------------------------------------------------------
  // Exiting hands focus back to the table (VSCode's selectKeybinding →
  // domFocus) so arrow-key navigation keeps working — but only for explicit
  // keyboard exits; a blur means the user clicked elsewhere on purpose.
  const commitWhen = useCallback(
    (row: IKeybindingRow, when: string) => {
      setWhenEditingRowId(undefined)
      tableContainerRef.current?.focus()
      if (row.keybinding === undefined) return
      const next = when === '' ? undefined : when
      if (next === row.when) return
      userKeybindingsService.editKeybinding(rowTargetOf(row), row.keybinding, next)
      // The rebuild gives the row a new identity (id embeds when + source, and
      // the edit lands in the user layer); reveal + re-select the fresh row.
      setRevealRowId(`${row.command}|${row.keybinding}|${next ?? ''}|user`)
    },
    [userKeybindingsService],
  )
  const cancelWhen = useCallback((viaKeyboard: boolean) => {
    setWhenEditingRowId(undefined)
    if (viaKeyboard) tableContainerRef.current?.focus()
  }, [])

  // -- runtime handle (T8 Action2 entry point) --------------------------------
  const stateRef = useRef({ rows, selectedRowId })
  stateRef.current = { rows, selectedRowId }

  const handle = useMemo<IKeybindingsEditorHandle>(() => {
    const selectedRow = (): IKeybindingRow | undefined => {
      const { rows: currentRows, selectedRowId: currentId } = stateRef.current
      return currentRows.find((m) => m.row.id === currentId)?.row
    }
    return {
      getSelectedRow: selectedRow,
      defineKeybinding: (add: boolean) => {
        const row = selectedRow()
        if (!row) return
        setDefineState({ row, add })
      },
      defineWhenExpression: () => {
        const row = selectedRow()
        if (!row || row.keybinding === undefined) return
        setWhenEditingRowId(row.id)
      },
      toggleRecordKeys: () => setRecordingKeys((v) => !v),
      removeSelectedKeybinding: () => {
        const row = selectedRow()
        if (row?.keybinding === undefined) return
        userKeybindingsService.removeKeybinding(rowTargetOf(row))
      },
      resetSelectedKeybinding: () => {
        const row = selectedRow()
        if (!row || row.isDefault) return
        userKeybindingsService.resetKeybinding(row.command)
      },
      copyEntry: (kind) => {
        const row = selectedRow()
        if (!row) return
        const text =
          kind === 'commandId'
            ? row.command
            : kind === 'commandTitle'
              ? row.commandLabel
              : JSON.stringify(
                  {
                    ...(row.keybinding !== undefined ? { key: row.keybinding } : {}),
                    command: row.command,
                    ...(row.when !== undefined ? { when: row.when } : {}),
                  },
                  null,
                  2,
                )
        void navigator.clipboard.writeText(text)
      },
      showSameKeybindings: () => {
        const row = selectedRow()
        if (row?.keybinding === undefined) return
        setQuery(`"${row.keybinding}"`)
      },
      toggleSortByPrecedence: () => setSortByPrecedence((v) => !v),
      clearSearch: () => {
        setQuery('')
        focusSearch()
      },
      focusSearch,
      focusTable: () => {
        tableContainerRef.current?.focus()
        const { rows: currentRows, selectedRowId: currentId } = stateRef.current
        if (currentId === undefined && currentRows.length > 0) {
          setSelectedRowId(currentRows[0]!.row.id)
        }
      },
      setQuery,
    }
  }, [userKeybindingsService, focusSearch])

  useEffect(() => {
    const d = registerKeybindingsEditor(handle)
    return () => d.dispose()
  }, [handle])

  // -- row interactions ---------------------------------------------------------
  const onSelect = useCallback((rowId: string | undefined) => setSelectedRowId(rowId), [])
  const onRevealed = useCallback(() => setRevealRowId(undefined), [])
  const onDefineKeybinding = useCallback((row: IKeybindingRow) => {
    setSelectedRowId(row.id)
    setDefineState({ row, add: false })
  }, [])
  const onRowContextMenu = useCallback((row: IKeybindingRow, x: number, y: number) => {
    setMenuState({ row, x, y })
  }, [])

  const hasQuery = query.trim() !== ''

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <div className={styles['searchContainer']}>
          <Input
            ref={searchInputRef}
            className={styles['search']}
            type="search"
            placeholder={
              recordingKeys
                ? localize(
                    'keybindings.recording.placeholder',
                    'Recording Keys. Press Escape to exit.',
                  )
                : localize('keybindings.search.placeholder', 'Type to search in keybindings')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => inSearchKey.set(true)}
            onBlur={() => inSearchKey.set(false)}
          />
          {recordingKeys && (
            <Badge className={styles['recordingBadge']}>
              {localize('keybindings.recording.badge', 'Recording Keys')}
            </Badge>
          )}
        </div>
        <div className={styles['headerActions']}>
          <IconButton
            label={localize('keybindings.recordKeys', 'Record Keys')}
            active={recordingKeys}
            aria-pressed={recordingKeys}
            onClick={() => setRecordingKeys((v) => !v)}
          >
            <CircleDot size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={localize('keybindings.sortByPrecedence', 'Sort by Precedence (Highest First)')}
            active={sortByPrecedence}
            aria-pressed={sortByPrecedence}
            onClick={() => setSortByPrecedence((v) => !v)}
          >
            <ArrowDownWideNarrow size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={localize('keybindings.clearSearch', 'Clear Keybindings Search Input')}
            disabled={!hasQuery}
            onClick={() => {
              setQuery('')
              focusSearch()
            }}
          >
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>

      <div className={styles['body']}>
        {rows.length === 0 ? (
          <div className={styles['emptyResult']}>
            {localize('keybindings.empty', 'No matching keybindings.')}
          </div>
        ) : (
          <KeybindingsTable
            rows={rows}
            selectedRowId={selectedRowId}
            revealRowId={revealRowId}
            whenEditingRowId={whenEditingRowId}
            containerRef={tableContainerRef}
            onSelect={onSelect}
            onRevealed={onRevealed}
            onDefineKeybinding={onDefineKeybinding}
            onContextMenu={onRowContextMenu}
            onFocusChange={setTableFocused}
            onWhenCommit={commitWhen}
            onWhenCancel={cancelWhen}
            onWhenFocusChange={setWhenFocus}
          />
        )}
      </div>

      <div aria-live="polite" className={styles['visuallyHidden']}>
        {localize('keybindings.aria.resultCount', '{count} keybindings', { count: rows.length })}
      </div>

      {menuState !== undefined && (
        <KeybindingsContextMenu
          x={menuState.x}
          y={menuState.y}
          row={menuState.row}
          handle={handle}
          onClose={() => setMenuState(undefined)}
        />
      )}

      {defineState !== undefined && (
        <DefineKeybindingOverlay
          onConfirm={confirmDefine}
          onCancel={closeDefine}
          countConflicts={countConflictsFor}
          onShowConflicts={showConflicts}
        />
      )}
    </div>
  )
}
