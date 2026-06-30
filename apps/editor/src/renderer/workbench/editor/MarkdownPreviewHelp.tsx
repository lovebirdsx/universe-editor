/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewHelp — the `?` keyboard-shortcut cheat sheet for the preview.
 *  A centred overlay listing the vimium-style navigation keys; dismissed by `?`
 *  again (handled by the nav hook) or by clicking the backdrop / Escape here.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react'
import styles from './MarkdownPreviewEditor.module.css'

interface Shortcut {
  readonly keys: string
  readonly desc: string
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'f', desc: '链接提示（当前打开）' },
  { keys: 'F', desc: '链接提示（侧边打开）' },
  { keys: 'j / k', desc: '下 / 上 滚动一行' },
  { keys: 'h / l', desc: '左 / 右 滚动' },
  { keys: 'd / u', desc: '下 / 上 半屏' },
  { keys: 'Space / ⇧Space', desc: '下 / 上 整屏' },
  { keys: 'gg / G', desc: '滚到顶部 / 底部' },
  { keys: 'H / L', desc: '后退 / 前进' },
  { keys: 'Ctrl+F', desc: '在预览中查找' },
  { keys: '3j', desc: '数字前缀重复（如向下 3 行）' },
  { keys: '?', desc: '显示 / 隐藏本帮助' },
]

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
        <div className={styles['helpTitle']}>键盘快捷键</div>
        <table className={styles['helpTable']}>
          <tbody>
            {SHORTCUTS.map((s) => (
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
