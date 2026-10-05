/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BinaryVersionToggle — the "allow manual version selection" checkbox, shared by
 *  the two Binary panels. Enabling it is the direction that gives up the
 *  build-verified guarantee, so it confirms first; disabling it (back to the
 *  pinned version) is the caller's business, which switches the binary right away
 *  instead of waiting for the next idle alignment.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { IDialogService, localize } from '@universe-editor/platform'
import { Checkbox } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import styles from './AgentSettingsEditor.module.css'

export function BinaryVersionToggle(props: {
  /** Current value of `acp.allowManualBinaryVersion`. */
  manual: boolean
  /** Agent name for the confirmation text, e.g. "Claude". */
  name: string
  onChange(manual: boolean): void
}) {
  const dialog = useService(IDialogService)
  const { manual, name, onChange } = props

  const handleChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onChange(false)
        return
      }
      void dialog
        .confirm({
          type: 'warning',
          message: localize(
            'binaryVersion.manual.confirm',
            'Allow manually selecting the {name} binary version?',
            { name },
          ),
          detail: localize(
            'binaryVersion.manual.confirm.detail',
            'Only the pinned version is verified against this editor build. Other versions may fail to start or behave unexpectedly.',
          ),
          primaryButton: localize('binaryVersion.manual.confirm.primary', 'Allow manual selection'),
        })
        .then((result) => {
          if (result.confirmed) onChange(true)
        })
    },
    [dialog, name, onChange],
  )

  return (
    <div className={styles['field']}>
      <Checkbox
        checked={manual}
        onChange={handleChange}
        label={localize('binaryVersion.manual.label', 'Allow manual version selection')}
        data-testid="binary-version-manual-toggle"
      />
      <span className={styles['desc']}>
        {manual
          ? localize(
              'binaryVersion.manual.desc.on',
              'The pinned and the latest version can be switched freely. Versions other than the pinned one are not verified against this build.',
            )
          : localize(
              'binaryVersion.manual.desc.off',
              'The binary always follows the version this editor build is pinned to, so it stays on the version that was tested with it.',
            )}
      </span>
    </div>
  )
}
