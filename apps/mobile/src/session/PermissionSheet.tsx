import type { MobilePendingPermission } from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'

export type PermissionCommandClient = Pick<
  MobileClient,
  | 'resolvePermission'
  | 'cancelPermission'
  | 'pauseAutoResolve'
  | 'resumeAutoResolve'
  | 'refreshSession'
  | 'serverNow'
>

export interface PermissionSheetProps {
  readonly client: PermissionCommandClient
  readonly permission: MobilePendingPermission
  readonly online: boolean
  readonly onNotice: (text: string) => void
}

/** How long to wait for `permission_cleared` before falling back to the snapshot. */
export const CLEARED_FALLBACK_MS = 3_000
const COUNTDOWN_TICK_MS = 500
const CODEX_IMPLEMENT_PLAN_OPTION_ID = 'implement_plan'

export function PermissionSheet({ client, permission, online, onNotice }: PermissionSheetProps) {
  const [busyOption, setBusyOption] = useState<string | undefined>(undefined)
  const [busyAuto, setBusyAuto] = useState<'pause' | 'resume' | undefined>(undefined)
  const [hidden, setHidden] = useState(false)
  const [feedback, setFeedback] = useState('')
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const requestId = permission.requestId

  useEffect(() => {
    setBusyOption(undefined)
    setBusyAuto(undefined)
    setHidden(false)
    setFeedback('')
    return () => {
      if (fallbackTimer.current !== undefined) {
        clearTimeout(fallbackTimer.current)
        fallbackTimer.current = undefined
      }
    }
  }, [requestId])

  const options = permission.options.filter((option) => option.allowedOnMobile !== false)
  const hiddenCount = permission.options.length - options.length

  const isPlanReview = permission.kind === 'switch_mode'
  const supportsFeedback =
    isPlanReview &&
    !permission.options.some((option) => option.optionId === CODEX_IMPLEMENT_PLAN_OPTION_ID)
  const rejectOption = permission.options.find((option) => option.kind?.startsWith('reject'))

  const submit = async (action: () => Promise<void>, optionId: string): Promise<void> => {
    if (busyOption !== undefined) return
    setBusyOption(optionId)
    try {
      await action()
      armFallback()
    } catch (error) {
      setBusyOption(undefined)
      onNotice(commandErrorText(errorCode(error)))
    }
  }

  const armFallback = (): void => {
    if (fallbackTimer.current !== undefined) clearTimeout(fallbackTimer.current)
    fallbackTimer.current = setTimeout(() => {
      fallbackTimer.current = undefined
      setBusyOption(undefined)
      setHidden(true)
      client.refreshSession()
    }, CLEARED_FALLBACK_MS)
  }

  const submitFeedback = async (): Promise<void> => {
    const text = feedback.trim()
    if (text === '' || rejectOption === undefined) return
    await submit(
      () => client.resolvePermission(requestId, rejectOption.optionId, text),
      `feedback:${rejectOption.optionId}`,
    )
  }

  const toggleAuto = async (): Promise<void> => {
    const auto = permission.autoResolve
    if (auto === undefined || busyAuto !== undefined) return
    const action = auto.paused ? 'resume' : 'pause'
    setBusyAuto(action)
    try {
      await (action === 'resume'
        ? client.resumeAutoResolve(requestId)
        : client.pauseAutoResolve(requestId))
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setBusyAuto(undefined)
    }
  }

  if (hidden) return null

  const disabled = !online || busyOption !== undefined

  return (
    <BottomSheet
      title={strings.pendingPermissionSheetTitle}
      icon={permissionIcon(permission.kind)}
      testId="permission-sheet"
      expandKey={requestId}
      footer={
        hiddenCount > 0 ? <p className="sheet__hint">{strings.pendingHiddenOptions}</p> : undefined
      }
    >
      <p className="sheet__request" data-testid="permission-title">
        {permission.title}
      </p>
      {permission.autoResolve !== undefined && (
        <AutoResolveRow
          client={client}
          deadlineAt={permission.autoResolve.deadlineAt}
          paused={permission.autoResolve.paused}
          busy={busyAuto !== undefined}
          disabled={!online || busyAuto !== undefined}
          onToggle={() => void toggleAuto()}
        />
      )}
      <div className="sheet-options" role="group" aria-label={strings.pendingOptionsLabel}>
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={`sheet-option ${optionClass(option.kind)}`}
            data-testid="permission-option"
            data-option-id={option.optionId}
            disabled={disabled}
            onClick={() =>
              void submit(
                () => client.resolvePermission(requestId, option.optionId),
                option.optionId,
              )
            }
          >
            {busyOption === option.optionId ? strings.pendingSubmitting : option.name}
          </button>
        ))}
        <button
          type="button"
          className="sheet-option sheet-option--cancel"
          data-testid="permission-cancel"
          disabled={disabled}
          onClick={() => void submit(() => client.cancelPermission(requestId), 'cancel')}
        >
          {busyOption === 'cancel' ? strings.pendingSubmitting : strings.pendingCancel}
        </button>
      </div>
      {supportsFeedback && rejectOption !== undefined && (
        <div className="sheet-feedback">
          <label className="sheet__field-label" htmlFor="permission-feedback">
            {strings.pendingFeedbackLabel}
          </label>
          <textarea
            id="permission-feedback"
            className="sheet__textarea"
            data-testid="permission-feedback"
            rows={2}
            value={feedback}
            disabled={disabled}
            placeholder={strings.pendingFeedbackPlaceholder}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button
            type="button"
            className="button button--primary"
            data-testid="permission-feedback-submit"
            disabled={disabled || feedback.trim() === ''}
            onClick={() => void submitFeedback()}
          >
            {strings.pendingFeedbackSubmit}
          </button>
        </div>
      )}
      {!online && <p className="sheet__hint sheet__hint--danger">{strings.pendingOffline}</p>}
    </BottomSheet>
  )
}

function AutoResolveRow({
  client,
  deadlineAt,
  paused,
  busy,
  disabled,
  onToggle,
}: {
  readonly client: PermissionCommandClient
  readonly deadlineAt: number | undefined
  readonly paused: boolean
  readonly busy: boolean
  readonly disabled: boolean
  readonly onToggle: () => void
}) {
  const totalRef = useRef<number | undefined>(undefined)
  const [remainingMs, setRemainingMs] = useState(() => remaining(deadlineAt, client))

  useEffect(() => {
    totalRef.current = undefined
  }, [deadlineAt, paused])

  useEffect(() => {
    const update = (): void => setRemainingMs(remaining(deadlineAt, client))
    update()
    if (paused || deadlineAt === undefined) return
    const ticker = setInterval(update, COUNTDOWN_TICK_MS)
    return () => clearInterval(ticker)
  }, [client, deadlineAt, paused])

  if (deadlineAt !== undefined) {
    const candidate = Math.max(0, deadlineAt - client.serverNow())
    if (totalRef.current === undefined || candidate > totalRef.current) totalRef.current = candidate
  }
  const total = totalRef.current ?? Math.max(remainingMs, 1)
  const progress = Math.min(1, Math.max(0, remainingMs / total))
  const seconds = Math.ceil(remainingMs / 1000)

  return (
    <div className="sheet-auto" data-testid="auto-resolve">
      <span
        className={`sheet-auto__ring${paused ? ' sheet-auto__ring--paused' : ''}`}
        style={{ ['--ring-progress' as string]: `${Math.round(progress * 100)}%` }}
        aria-hidden="true"
      >
        <span className="sheet-auto__seconds">{paused ? 'Ⅱ' : seconds}</span>
      </span>
      <div className="sheet-auto__body">
        <p className="sheet-auto__label">
          {paused ? strings.pendingAutoPaused : strings.pendingAutoExecuting(seconds)}
        </p>
        <button
          type="button"
          className="text-button"
          data-testid="auto-resolve-toggle"
          disabled={disabled}
          onClick={onToggle}
        >
          {busy
            ? strings.pendingSubmitting
            : paused
              ? strings.pendingAutoResume
              : strings.pendingAutoPause}
        </button>
      </div>
    </div>
  )
}

function remaining(
  deadlineAt: number | undefined,
  client: Pick<MobileClient, 'serverNow'>,
): number {
  if (deadlineAt === undefined) return 0
  return Math.max(0, deadlineAt - client.serverNow())
}

function optionClass(kind: string | undefined): string {
  if (kind?.startsWith('allow') === true) return 'sheet-option--allow'
  if (kind?.startsWith('reject') === true) return 'sheet-option--reject'
  return 'sheet-option--neutral'
}

function permissionIcon(kind: string | undefined): string {
  switch (kind) {
    case 'execute':
      return '▶'
    case 'edit':
      return '✎'
    case 'read':
      return '⌕'
    case 'switch_mode':
      return '◇'
    case 'fetch':
      return '↧'
    default:
      return '⚑'
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
