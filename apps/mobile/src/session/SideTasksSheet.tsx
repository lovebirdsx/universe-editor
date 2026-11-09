import type { MobileSessionRef, MobileSideTaskSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import { formatUpdatedAt } from '../inbox/groupSessions.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'

export interface SideTasksSheetProps {
  readonly client: Pick<MobileClient, 'listSideTasks' | 'openSideTask' | 'deleteSideTask'>
  readonly online: boolean
  readonly onClose: () => void
  readonly onOpen: (ref: MobileSessionRef) => void
  readonly onNotice: (text: string) => void
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly rows: readonly MobileSideTaskSummary[] }

export function SideTasksSheet({ client, online, onClose, onOpen, onNotice }: SideTasksSheetProps) {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined)

  const load = async (): Promise<void> => {
    try {
      const rows = await client.listSideTasks()
      setState({ status: 'ready', rows })
    } catch (error) {
      setState({ status: 'failed', message: commandErrorText(errorCode(error)) })
    }
  }

  useEffect(() => {
    let cancelled = false
    void client.listSideTasks().then(
      (rows) => {
        if (!cancelled) setState({ status: 'ready', rows })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', message: commandErrorText(errorCode(error)) })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [client])

  const open = async (row: MobileSideTaskSummary): Promise<void> => {
    if (busyId !== undefined) return
    setBusyId(row.id)
    try {
      const result = await client.openSideTask(row.id)
      onOpen(result.ref)
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (row: MobileSideTaskSummary): Promise<void> => {
    if (busyId !== undefined) return
    setBusyId(row.id)
    try {
      await client.deleteSideTask(row.id)
      setConfirmDeleteId(undefined)
      await load()
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <BottomSheet
      title={strings.sideTasksTitle}
      testId="side-tasks-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
      expandKey="side-tasks"
    >
      {state.status === 'loading' && (
        <div className="sheet-loading" data-testid="side-tasks-loading">
          <Spinner label={strings.sideTasksLoading} />
          <p className="muted">{strings.sideTasksLoading}</p>
        </div>
      )}
      {state.status === 'failed' && (
        <p className="sheet-field__error" data-testid="side-tasks-error">
          {state.message}
        </p>
      )}
      {state.status === 'ready' &&
        (state.rows.length === 0 ? (
          <p className="muted" data-testid="side-task-empty">
            {strings.sideTasksEmpty}
          </p>
        ) : (
          <ul className="side-task-list">
            {state.rows.map((row) => (
              <li key={row.id} className="side-task-row" data-testid="side-task-row">
                <button
                  type="button"
                  className="side-task-row__open"
                  data-testid="side-task-open"
                  disabled={!online || busyId !== undefined}
                  onClick={() => void open(row)}
                >
                  <span className="side-task-row__title">
                    {row.title === '' ? strings.sideTaskUntitled : row.title}
                  </span>
                  <span className="side-task-row__meta">
                    <span>{formatUpdatedAt(row.lastUsedAt)}</span>
                    {row.live && (
                      <span className="side-task-live" data-testid="side-task-live">
                        {strings.sideTasksLiveBadge}
                      </span>
                    )}
                  </span>
                </button>
                {confirmDeleteId === row.id ? (
                  <div className="side-task-row__confirm">
                    <button
                      type="button"
                      className="side-task-row__confirm-delete"
                      data-testid="side-task-delete-confirm"
                      disabled={!online || busyId !== undefined}
                      onClick={() => void remove(row)}
                    >
                      {strings.sideTasksDeleteConfirm}
                    </button>
                    <button
                      type="button"
                      className="side-task-row__confirm-cancel"
                      data-testid="side-task-delete-cancel"
                      disabled={busyId !== undefined}
                      onClick={() => setConfirmDeleteId(undefined)}
                    >
                      {strings.sideTasksDeleteCancel}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="side-task-row__delete"
                    data-testid="side-task-delete"
                    aria-label={strings.sideTasksDelete}
                    disabled={!online || busyId !== undefined}
                    onClick={() => setConfirmDeleteId(row.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        ))}
      <div className="sheet-options">
        <button type="button" className="sheet-option sheet-option--cancel" onClick={onClose}>
          {strings.pendingCancel}
        </button>
      </div>
    </BottomSheet>
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
