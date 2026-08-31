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
import { FocusScopeOverlay } from '../../overlay/FocusScopeOverlay.js'
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
  // An empty array carries no more information than "no buttons given", so it
  // falls back to the legacy shape rather than rendering a dismiss-only dialog.
  const buttons = opts.buttons?.length ? opts.buttons : undefined
  const [neverAskAgain, setNeverAskAgain] = useState(false)
  const [checkboxChecked, setCheckboxChecked] = useState<boolean[]>(
    opts.checkboxes?.map((c) => c.initiallyChecked ?? false) ?? [],
  )
  const echoCheckboxes = opts.checkboxes?.length ? { checkboxChecked } : {}
  const cancelResult: IConfirmResult = {
    confirmed: false,
    choice: 'cancel',
    neverAskAgain: false,
    ...echoCheckboxes,
  }
  // The `buttons` shape reports which entry was picked by index; `choice` is
  // still derived so a caller reading only the legacy field gets a sane value.
  const pickResult = (index: number): IConfirmResult => ({
    confirmed: index === 0,
    choice: index === 0 ? 'primary' : index === 1 ? 'secondary' : 'cancel',
    choiceIndex: index,
    neverAskAgain: index === 0 ? neverAskAgain : false,
    ...echoCheckboxes,
  })
  return (
    <FocusScopeOverlay visible onEscape={() => onResolve(cancelResult)}>
      <div
        className={styles['backdrop']}
        role="dialog"
        aria-modal="true"
        data-renderer-dialog
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault()
            onResolve(
              buttons
                ? pickResult(0)
                : {
                    confirmed: true,
                    choice: 'primary',
                    neverAskAgain,
                    ...echoCheckboxes,
                  },
            )
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
          {opts.checkboxes?.map((cb, i) => (
            <label key={cb.label} className={styles['checkboxRow']}>
              <input
                type="checkbox"
                checked={checkboxChecked[i] ?? false}
                onChange={(e) =>
                  setCheckboxChecked((prev) => {
                    const next = [...prev]
                    next[i] = e.target.checked
                    return next
                  })
                }
              />
              {cb.label}
            </label>
          ))}
          <div className={styles['buttons']}>
            {buttons ? (
              buttons.map((label, i) => (
                <button
                  key={`${i}-${label}`}
                  type="button"
                  className={i === 0 ? styles['btnPrimary'] : styles['btn']}
                  autoFocus={i === 0}
                  onClick={() => onResolve(pickResult(i))}
                >
                  {label}
                </button>
              ))
            ) : (
              <button
                type="button"
                className={styles['btnPrimary']}
                autoFocus
                onClick={() =>
                  onResolve({
                    confirmed: true,
                    choice: 'primary',
                    neverAskAgain,
                    ...echoCheckboxes,
                  })
                }
              >
                {primary}
              </button>
            )}
            {opts.copyButton && !buttons ? (
              <button
                type="button"
                className={styles['btn']}
                onClick={() => void navigator.clipboard.writeText(opts.detail ?? '')}
              >
                {opts.copyButton}
              </button>
            ) : null}
            {secondary && !buttons ? (
              <button
                type="button"
                className={styles['btn']}
                onClick={() =>
                  onResolve({
                    confirmed: false,
                    choice: 'secondary',
                    neverAskAgain: false,
                    ...echoCheckboxes,
                  })
                }
              >
                {secondary}
              </button>
            ) : null}
            {/* The dismiss button is always present: with `buttons`, every entry
                is an action, so closing needs its own exit. */}
            <button type="button" className={styles['btn']} onClick={() => onResolve(cancelResult)}>
              {buttons ? localize('dialog.default.cancel', 'Cancel') : cancel}
            </button>
          </div>
        </div>
      </div>
    </FocusScopeOverlay>
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
            // Enter during an IME composition confirms a candidate, not submit.
            if (e.nativeEvent.isComposing) return
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
