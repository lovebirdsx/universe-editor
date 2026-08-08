import { cx } from '../atoms/cx.js'
import styles from './KeybindingLabel.module.css'

export interface KeybindingLabelProps {
  /** Chord sequence: each chord is the list of key labels pressed together (e.g. [['Ctrl', 'K'], ['Ctrl', 'S']]). */
  chords: readonly (readonly string[])[]
  /** Parallel to `chords`; true marks the key block with the highlight style. */
  highlights?: readonly (readonly boolean[])[] | undefined
  className?: string | undefined
}

export function KeybindingLabel({ chords, highlights, className }: KeybindingLabelProps) {
  return (
    <span className={cx(styles['label'], className)}>
      {chords.map((chord, chordIndex) => (
        <span key={chordIndex}>
          {chordIndex > 0 && ' '}
          {chord.map((keyLabel, keyIndex) => (
            <span
              key={keyIndex}
              className={cx(
                styles['key'],
                highlights?.[chordIndex]?.[keyIndex] === true && styles['highlight'],
              )}
            >
              {keyLabel}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}
