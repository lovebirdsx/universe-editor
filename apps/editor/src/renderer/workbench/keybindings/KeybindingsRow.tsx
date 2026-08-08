/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KeybindingsRow — one grid row of the Keyboard Shortcuts table. Pure view:
 *  receives the row match (row + highlight ranges) and callbacks. Memoized so
 *  only rows whose match/selection actually change re-render on keystrokes.
 *--------------------------------------------------------------------------------------------*/

import { memo, type CSSProperties, type MouseEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { cx, HighlightedLabel, IconButton, KeybindingLabel } from '@universe-editor/workbench-ui'
import { Pencil, Plus } from 'lucide-react'
import type {
  IKeybindingMatches,
  IKeybindingRowMatch,
} from '../../services/keybindings/keybindingsSearchModel.js'
import { WhenInputCell } from './WhenInputCell.js'
import styles from './KeybindingsEditor.module.css'

export interface KeybindingsRowProps {
  readonly match: IKeybindingRowMatch
  /** Index within the current filtered rows; drives the zebra stripe parity. */
  readonly index: number
  readonly selected: boolean
  /** Virtualizer positioning + fixed height; owned by VirtualList. */
  readonly style: CSSProperties
  /** True while this row's When cell is in inline-edit mode. */
  readonly whenEditing: boolean
  readonly onSelect: () => void
  readonly onEdit: () => void
  readonly onDefine: () => void
  readonly onContextMenu: (e: MouseEvent<HTMLDivElement>) => void
  readonly onWhenCommit: (when: string) => void
  readonly onWhenCancel: (viaKeyboard: boolean) => void
  readonly onWhenFocusChange: (focused: boolean) => void
}

function keybindingHighlights(
  matches: IKeybindingMatches | undefined,
  chords: readonly (readonly string[])[],
): readonly (readonly boolean[])[] | undefined {
  if (!matches) return undefined
  const parts = [matches.firstPart, matches.chordPart]
  return chords.map((chord, chordIndex) =>
    chord.map((label) => {
      const part = parts[chordIndex]
      if (!part) return false
      switch (label.toLowerCase()) {
        case 'ctrl':
          return part.ctrlKey === true
        case 'alt':
          return part.altKey === true
        case 'shift':
          return part.shiftKey === true
        case 'cmd':
        case 'meta':
        case 'win':
          return part.metaKey === true
        default:
          return part.keyCode === true
      }
    }),
  )
}

export const KeybindingsRow = memo(function KeybindingsRow({
  match,
  index,
  selected,
  style,
  whenEditing,
  onSelect,
  onEdit,
  onDefine,
  onContextMenu,
  onWhenCommit,
  onWhenCancel,
  onWhenFocusChange,
}: KeybindingsRowProps) {
  const { row, matches } = match
  const hasBinding = row.keybinding !== undefined

  return (
    <div
      role="row"
      aria-selected={selected}
      data-parity={index % 2 === 1 ? 'odd' : 'even'}
      data-selected={selected || undefined}
      className={cx(styles['row'], selected && styles['selected'])}
      style={style}
      onClick={onSelect}
      onDoubleClick={onDefine}
      onContextMenu={onContextMenu}
    >
      <span role="gridcell" className={cx(styles['cell'], styles['actionsCell'])}>
        <IconButton
          label={
            hasBinding
              ? localize('keybindings.changeKeybinding', 'Change Keybinding')
              : localize('keybindings.addKeybinding', 'Add Keybinding')
          }
          size={18}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          {hasBinding ? <Pencil size={13} /> : <Plus size={13} />}
        </IconButton>
      </span>

      <span
        role="gridcell"
        className={cx(styles['cell'], styles['commandCell'])}
        title={`${row.commandLabel} (${row.command})`}
      >
        <HighlightedLabel
          text={row.commandLabel}
          matches={matches.commandLabel}
          className={styles['commandLabel']}
        />
        {matches.commandDefaultLabel !== undefined && row.commandDefaultLabel !== undefined && (
          <HighlightedLabel
            text={row.commandDefaultLabel}
            matches={matches.commandDefaultLabel}
            className={styles['commandDefaultLabel']}
          />
        )}
        {matches.commandId !== undefined && (
          <HighlightedLabel
            text={row.command}
            matches={matches.commandId}
            className={styles['commandId']}
          />
        )}
      </span>

      <span role="gridcell" className={cx(styles['cell'], styles['keybindingCell'])}>
        {hasBinding && (
          <KeybindingLabel
            chords={row.chords}
            highlights={keybindingHighlights(matches.keybinding, row.chords)}
          />
        )}
      </span>

      <span role="gridcell" className={cx(styles['cell'], styles['whenCell'])}>
        {whenEditing ? (
          <WhenInputCell
            initialValue={row.when ?? ''}
            onCommit={onWhenCommit}
            onCancel={onWhenCancel}
            onFocusChange={onWhenFocusChange}
          />
        ) : row.when !== undefined ? (
          <HighlightedLabel text={row.when} matches={matches.when} className={styles['whenCode']} />
        ) : (
          <span className={styles['empty']}>–</span>
        )}
      </span>

      <span role="gridcell" className={cx(styles['cell'], styles['sourceCell'])}>
        {row.source.kind === 'user' ? (
          localize('keybindingsEditor.sourceUser', 'User')
        ) : row.source.kind === 'system' ? (
          localize('keybindingsEditor.sourceSystem', 'System')
        ) : (
          <HighlightedLabel
            text={row.source.extensionLabel}
            matches={matches.extensionLabel}
            className={styles['extensionLabel']}
          />
        )}
      </span>
    </div>
  )
})
