/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SavedIndicator — the whole feedback surface of the "save immediately" model.
 *  Every card field writes through on commit, so the only thing the user needs
 *  back is a short confirmation next to the field they just touched. It renders
 *  for one field at a time (matched by name) and fades after a couple seconds.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

const VISIBLE_MS = 2000

export function SavedIndicator({
  saved,
  field,
}: {
  readonly saved: SavedStamp | undefined
  readonly field: string
}) {
  const at = saved?.field === field ? saved.at : undefined
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (at === undefined) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [at])

  if (!visible) return null
  return (
    <span className={styles['savedIndicator']} data-testid="ai-provider-saved">
      <Check size={12} strokeWidth={2.25} />
      {localize('aiModels.saved', 'Saved')}
    </span>
  )
}
