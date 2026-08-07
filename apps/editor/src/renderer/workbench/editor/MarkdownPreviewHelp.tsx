/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewHelp — the `?` keyboard-shortcut cheat sheet for the preview.
 *  A centred overlay listing the vimium-style navigation keys; dismissed by `?`
 *  again (handled by the nav hook) or by clicking the backdrop / Escape here.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react'
import { localize } from '@universe-editor/platform'
import styles from './MarkdownPreviewEditor.module.css'

interface Shortcut {
  readonly keys: string
  readonly desc: string
}

function shortcuts(): readonly Shortcut[] {
  return [
    {
      keys: 'f',
      desc: localize('markdownPreview.help.linkHintsCurrent', 'Link hints (open here)'),
    },
    {
      keys: 'F',
      desc: localize('markdownPreview.help.linkHintsSide', 'Link hints (open to the side)'),
    },
    { keys: 'j / k', desc: localize('markdownPreview.help.scrollLine', 'Scroll down / up a line') },
    {
      keys: 'h / l',
      desc: localize('markdownPreview.help.scrollHorizontal', 'Scroll left / right'),
    },
    {
      keys: 'd / u',
      desc: localize('markdownPreview.help.scrollHalfPage', 'Scroll down / up half a page'),
    },
    {
      keys: 'Space / ⇧Space',
      desc: localize('markdownPreview.help.scrollPage', 'Scroll down / up a page'),
    },
    {
      keys: 'gg / G',
      desc: localize('markdownPreview.help.scrollTopBottom', 'Scroll to top / bottom'),
    },
    { keys: 'H / L', desc: localize('markdownPreview.help.backForward', 'Back / forward') },
    { keys: 'Ctrl+F', desc: localize('markdownPreview.help.find', 'Find in preview') },
    {
      keys: '3j',
      desc: localize(
        'markdownPreview.help.countPrefix',
        'Numeric prefix repeats (e.g. 3 lines down)',
      ),
    },
    { keys: '?', desc: localize('markdownPreview.help.toggle', 'Show / hide this help') },
  ]
}

export function MarkdownPreviewHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <div
      className={styles['helpBackdrop']}
      data-find-widget
      data-testid="md-preview-help"
      onClick={onClose}
    >
      <div className={styles['helpPanel']} onClick={(e) => e.stopPropagation()}>
        <div className={styles['helpTitle']}>
          {localize('markdownPreview.help.title', 'Keyboard Shortcuts')}
        </div>
        <table className={styles['helpTable']}>
          <tbody>
            {shortcuts().map((s) => (
              <tr key={s.keys}>
                <td className={styles['helpKeys']}>
                  <kbd>{s.keys}</kbd>
                </td>
                <td className={styles['helpDesc']}>{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
