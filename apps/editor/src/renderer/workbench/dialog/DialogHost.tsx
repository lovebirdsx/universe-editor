/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DialogHost — React portal host that renders the head of
 *  RendererDialogService's queue as a modal confirm/prompt dialog.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  localize,
  markAsSingleton,
  type IConfirmOptions,
  type IConfirmResult,
  type IPromptOptions,
} from '@universe-editor/platform'
import type { RendererDialogService } from '../../services/dialog/RendererDialogService.js'
import styles from './DialogHost.module.css'

export function DialogHost({ service }: { service: RendererDialogService }) {
  const head = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(service.onDidChange(onChange))
      return () => d.dispose()
    },
    () => service.queue[0],
  )
  if (!head) return null
  const node =
    head.kind === 'confirm' ? (
      <ConfirmDialog
        key={`c-${service.queue.length}`}
        opts={head.opts}
        onResolve={(r) => service._resolveHead<IConfirmResult>(r)}
      />
    ) : (
      <PromptDialog
        key={`p-${service.queue.length}`}
        opts={head.opts}
        onResolve={(v) => service._resolveHead<string | undefined>(v)}
      />
    )
  return createPortal(node, document.body)
}

function ConfirmDialog({
  opts,
  onResolve,
}: {
  opts: IConfirmOptions
  onResolve: (r: IConfirmResult) => void
}) {
  const primary = opts.primaryButton ?? localize('dialog.default.ok', 'OK')
  const cancel = opts.cancelButton ?? localize('dialog.default.cancel', 'Cancel')
  const secondary = opts.secondaryButton
  return (
    <div
      className={styles['backdrop']}
      role="dialog"
      aria-modal="true"
      data-renderer-dialog
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onResolve({ confirmed: false, choice: 'cancel' })
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onResolve({ confirmed: true, choice: 'primary' })
        }
      }}
    >
      <div className={styles['dialog']}>
        <p className={styles['message']}>{opts.message}</p>
        {opts.detail ? <p className={styles['detail']}>{opts.detail}</p> : null}
        <div className={styles['buttons']}>
          <button
            type="button"
            className={styles['btnPrimary']}
            autoFocus
            onClick={() => onResolve({ confirmed: true, choice: 'primary' })}
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
              onClick={() => onResolve({ confirmed: false, choice: 'secondary' })}
            >
              {secondary}
            </button>
          ) : null}
          <button
            type="button"
            className={styles['btn']}
            onClick={() => onResolve({ confirmed: false, choice: 'cancel' })}
          >
            {cancel}
          </button>
        </div>
      </div>
    </div>
  )
}

function PromptDialog({
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
