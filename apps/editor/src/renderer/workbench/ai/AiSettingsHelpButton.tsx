/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiSettingsHelpButton — the "?" affordance in each category header. Clicking
 *  toggles a markdown popover (focus-trapped, Esc / click-outside to close).
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { FocusScopeOverlay, IconButton } from '@universe-editor/workbench-ui'
import { MarkdownView } from '../markdown/MarkdownView.js'
import styles from './AiSettingsEditor.module.css'

export function AiSettingsHelpButton({ markdown }: { readonly markdown: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles['helpAnchor']}>
      <IconButton
        label={localize('aiSettings.help.label', 'Help')}
        active={open}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle size={16} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <>
          <div className={styles['helpBackdrop']} onClick={() => setOpen(false)} />
          <FocusScopeOverlay visible onEscape={() => setOpen(false)}>
            <div className={styles['helpPopover']} role="dialog">
              <MarkdownView text={markdown} className={styles['helpMarkdown'] ?? ''} />
            </div>
          </FocusScopeOverlay>
        </>
      )}
    </div>
  )
}
