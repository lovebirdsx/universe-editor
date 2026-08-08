/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DefineKeybindingOverlay — modal key-recording widget mirroring VSCode's
 *  DefineKeybindingWidget: a 400x110 centered overlay that captures every
 *  keystroke (window capture phase, so nothing leaks to the global dispatcher),
 *  records up to a 2-stroke chord, live-renders the keys, shows a clickable
 *  conflict count, and resolves on Enter / two-stage Escape / blur.
 *
 *  Pure presentation: the parent owns the service writes; this component only
 *  reports confirm/cancel/conflict-click through callbacks.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type JSX } from 'react'
import { localize } from '@universe-editor/platform'
import { KeybindingLabel } from '@universe-editor/workbench-ui'
import { formatKey } from '../titlebar/keybindingFormat.js'
import { buildKeyString, isModifierOnly } from './keyEventUtils.js'
import styles from './KeybindingsEditor.module.css'

export interface DefineKeybindingOverlayProps {
  /** Enter pressed with at least one recorded stroke; key is in registry key space. */
  readonly onConfirm: (key: string) => void
  /** Escape with nothing recorded, Enter with nothing recorded, or focus lost. */
  readonly onCancel: () => void
  /** Count of existing rows bound to the given key (registry key space). */
  readonly countConflicts: (key: string) => number
  /** Conflict line clicked — parent typically switches the search to "key". */
  readonly onShowConflicts: (key: string) => void
}

function strokeLabels(stroke: string): string[] {
  return stroke.split('+').map(formatKey)
}

export function DefineKeybindingOverlay({
  onConfirm,
  onCancel,
  countConflicts,
  onShowConflicts,
}: DefineKeybindingOverlayProps): JSX.Element {
  const [strokes, setStrokes] = useState<readonly string[]>([])
  const widgetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    widgetRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        // Two-stage: first Escape clears the recorded strokes, second cancels.
        if (strokes.length > 0) setStrokes([])
        else onCancel()
        return
      }
      if (e.key === 'Enter') {
        if (strokes.length > 0) onConfirm(strokes.join(' '))
        else onCancel()
        return
      }
      if (isModifierOnly(e.key)) return
      const key = buildKeyString(e)
      setStrokes((prev) => (prev.length >= 2 ? [key] : [...prev, key]))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [strokes, onConfirm, onCancel])

  const keyString = strokes.join(' ')
  const conflicts = keyString !== '' ? countConflicts(keyString) : 0

  return (
    <div className={styles['defineBackdrop']}>
      <div
        ref={widgetRef}
        role="dialog"
        aria-label={localize('keybindings.define.ariaLabel', 'Define Keybinding')}
        tabIndex={-1}
        className={styles['defineWidget']}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCancel()
        }}
      >
        <div className={styles['defineMessage']}>
          {localize(
            'keybindings.define.message',
            'Press desired key combination and then press ENTER.',
          )}
        </div>
        <div className={styles['defineOutput']}>
          {strokes.map((stroke, index) => (
            <span key={index} className={styles['defineStroke']}>
              {index > 0 && (
                <span className={styles['defineChordTo']}>
                  {localize('keybindings.define.chordTo', 'chord to')}
                </span>
              )}
              <KeybindingLabel chords={[strokeLabels(stroke)]} />
            </span>
          ))}
        </div>
        {conflicts > 0 && (
          <button
            type="button"
            className={styles['defineExisting']}
            onClick={() => onShowConflicts(keyString)}
          >
            {localize(
              'keybindings.define.existing',
              '{count} existing commands have this keybinding',
              { count: conflicts },
            )}
          </button>
        )}
      </div>
    </div>
  )
}
