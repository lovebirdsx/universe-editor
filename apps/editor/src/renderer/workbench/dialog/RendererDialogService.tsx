/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererDialogService — IDialogService implementation backed by a small
 *  React portal. Mount <DialogHost /> once at the workbench root; the service
 *  drives it by appending an item to a mutable queue and the host re-renders.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Disposable,
  Emitter,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService,
  type IPromptOptions,
} from '@universe-editor/platform'
import styles from './RendererDialogService.module.css'

type Resolver<T> = (value: T) => void

interface ConfirmEntry {
  readonly kind: 'confirm'
  readonly opts: IConfirmOptions
  readonly resolve: Resolver<IConfirmResult>
}
interface PromptEntry {
  readonly kind: 'prompt'
  readonly opts: IPromptOptions
  readonly resolve: Resolver<string | undefined>
}
type Entry = ConfirmEntry | PromptEntry

export class RendererDialogService extends Disposable implements IDialogService {
  declare readonly _serviceBrand: undefined

  private readonly _queue: Entry[] = []
  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  /** Snapshot of the current queue for the host component. */
  get queue(): readonly Entry[] {
    return this._queue
  }

  confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    return new Promise<IConfirmResult>((resolve) => {
      this._queue.push({ kind: 'confirm', opts, resolve })
      this._onDidChange.fire()
    })
  }

  prompt(opts: IPromptOptions): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this._queue.push({ kind: 'prompt', opts, resolve })
      this._onDidChange.fire()
    })
  }

  /** Internal — invoked by the host when the user resolves the head entry. */
  _resolveHead<T>(value: T): void {
    const head = this._queue.shift()
    if (!head) return
    ;(head.resolve as Resolver<T>)(value)
    this._onDidChange.fire()
  }
}

// ---------------------------------------------------------------------------
// DialogHost component
// ---------------------------------------------------------------------------

export function DialogHost({ service }: { service: RendererDialogService }) {
  const head = useSyncExternalStore(
    (onChange) => {
      const d = service.onDidChange(onChange)
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
  const primary = opts.primaryButton ?? 'OK'
  const cancel = opts.cancelButton ?? 'Cancel'
  const secondary = opts.secondaryButton
  return (
    <div
      className={styles['backdrop']}
      role="dialog"
      aria-modal="true"
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
        />
        <div className={styles['buttons']}>
          <button
            type="button"
            className={styles['btnPrimary']}
            onClick={() => onResolve(inputEl?.value ?? '')}
          >
            OK
          </button>
          <button type="button" className={styles['btn']} onClick={() => onResolve(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
