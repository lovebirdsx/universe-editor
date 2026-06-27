/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Presentational confirm / prompt dialogs. Pure views: they receive options
 *  and an onResolve callback. The host (editor's DialogHost) owns the queue and
 *  portal.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import {
  localize,
  type IConfirmOptions,
  type IConfirmResult,
  type IPromptOptions,
} from '@universe-editor/platform'
import styles from './Dialogs.module.css'

export function ConfirmDialog({
  opts,
  onResolve,
}: {
  opts: IConfirmOptions
  onResolve: (r: IConfirmResult) => void
}) {
  const primary = opts.primaryButton ?? localize('dialog.default.ok', 'OK')
  const cancel = opts.cancelButton ?? localize('dialog.default.cancel', 'Cancel')
  const secondary = opts.secondaryButton
  const [neverAskAgain, setNeverAskAgain] = useState(false)
  return (
    <div
      className={styles['backdrop']}
      role="dialog"
      aria-modal="true"
      data-renderer-dialog
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onResolve({ confirmed: false, choice: 'cancel', neverAskAgain: false })
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          onResolve({ confirmed: true, choice: 'primary', neverAskAgain })
        }
      }}
    >
      <div className={styles['dialog']}>
        <p className={styles['message']}>{opts.message}</p>
        {opts.detail ? <p className={styles['detail']}>{opts.detail}</p> : null}
        {opts.neverAskAgainLabel ? (
          <label className={styles['checkboxRow']}>
            <input
              type="checkbox"
              checked={neverAskAgain}
              onChange={(e) => setNeverAskAgain(e.target.checked)}
            />
            {opts.neverAskAgainLabel}
          </label>
        ) : null}
        <div className={styles['buttons']}>
          <button
            type="button"
            className={styles['btnPrimary']}
            autoFocus
            onClick={() => onResolve({ confirmed: true, choice: 'primary', neverAskAgain })}
          >
            {primary}
          </button>
          {opts.copyButton ? (
            <button
              type="button"
              className={styles['btn']}
              onClick={() => void navigator.clipboard.writeText(opts.detail ?? '')}
            >
              {opts.copyButton}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              className={styles['btn']}
              onClick={() =>
                onResolve({ confirmed: false, choice: 'secondary', neverAskAgain: false })
              }
            >
              {secondary}
            </button>
          ) : null}
          <button
            type="button"
            className={styles['btn']}
            onClick={() => onResolve({ confirmed: false, choice: 'cancel', neverAskAgain: false })}
          >
            {cancel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PromptDialog({
  opts,
  onResolve,
}: {
  opts: IPromptOptions
  onResolve: (v: string | undefined) => void
}) {
  let inputEl: HTMLInputElement | null = null
  return (
    <div
      className={styles['backdrop']}
      role="dialog"
      aria-modal="true"
      data-renderer-dialog
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onResolve(undefined)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onResolve(inputEl?.value ?? '')
        }
      }}
    >
      <div className={styles['dialog']}>
        <p className={styles['message']}>{opts.title}</p>
        <input
          ref={(el) => {
            inputEl = el
            if (el) {
              el.value = opts.initialValue ?? ''
              el.focus()
              el.select()
            }
          }}
          className={styles['input']}
          placeholder={opts.placeholder}
          aria-label={opts.title}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onResolve(undefined)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              onResolve(inputEl?.value ?? '')
            }
          }}
        />
        <div className={styles['buttons']}>
          <button
            type="button"
            className={styles['btnPrimary']}
            onClick={() => onResolve(inputEl?.value ?? '')}
          >
            {localize('dialog.default.ok', 'OK')}
          </button>
          <button type="button" className={styles['btn']} onClick={() => onResolve(undefined)}>
            {localize('dialog.default.cancel', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
