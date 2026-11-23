/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Which-key overlay: lists the keys that can follow a pending Vim prefix. Purely
 *  visual — pointer-events none, no focus, no key handling; the dispatcher keeps
 *  owning the keyboard and closes it by clearing the service state.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IVimModeService, type IVimWhichKeyState } from '../../services/vim/vimModeService.js'
import { getActiveWorkbenchDocument } from '../../services/windows/workbenchDocuments.js'
import { useService } from '../useService.js'
import styles from './VimWhichKey.module.css'

export function VimWhichKey() {
  const vim = useService(IVimModeService)
  const [state, setState] = useState<IVimWhichKeyState | undefined>(vim.whichKey)

  useEffect(() => {
    setState(vim.whichKey)
    const subscription = vim.onDidChangeWhichKey(setState)
    return () => subscription.dispose()
  }, [vim])

  if (state === undefined) return null

  return createPortal(
    <div className={styles['panel']} data-testid="vim-which-key" role="presentation">
      <div className={styles['prefix']} data-testid="vim-which-key-prefix">
        {state.prefix}
      </div>
      <div className={styles['list']}>
        {state.items.map((item) => (
          <div key={item.key} className={styles['item']} data-testid="vim-which-key-item">
            <span className={styles['key']}>{item.key}</span>
            <span className={`${styles['title']} ${item.isGroup ? styles['group'] : ''}`}>
              {item.title}
            </span>
          </div>
        ))}
      </div>
    </div>,
    getActiveWorkbenchDocument().body,
  )
}
