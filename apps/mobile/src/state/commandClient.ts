import {
  isMobileErrorCode,
  type CommandFrame,
  type CommandResultFrame,
  type MobileCommandKind,
  type MobileErrorCode,
} from '@universe-editor/mobile-protocol'

/**
 * Per-kind deadline mirroring the gateway's own caps (`mobileGatewayHub.ts`).
 * Keep this table in step with the server: a client that waits longer than the
 * server is fine, one that gives up earlier would surface false timeouts.
 */
export const COMMAND_TIMEOUT_MS: Readonly<Record<MobileCommandKind, number>> = {
  getToolCallDetail: 10_000,
  searchPromptRefs: 12_000,
  sendPrompt: 15_000,
  cancelTurn: 5_000,
  resolvePermission: 10_000,
  cancelPermission: 10_000,
  resolveElicitation: 10_000,
  setConfigOption: 10_000,
  pauseAutoResolve: 10_000,
  resumeAutoResolve: 10_000,
  newSession: 30_000,
  renameSession: 10_000,
  closeSession: 10_000,
  deleteSession: 30_000,
  deleteHistorySession: 30_000,
  forkSession: 120_000,
  previewRewind: 30_000,
  rewindSession: 120_000,
  createSideTask: 120_000,
  listSideTasks: 10_000,
  openSideTask: 120_000,
  deleteSideTask: 120_000,
  listWorkspaces: 10_000,
  listDirectory: 25_000,
  listAgents: 10_000,
  listSessionHistory: 20_000,
  openSession: 120_000,
  previewDelivery: 120_000,
  startDelivery: 120_000,
  getDelivery: 10_000,
  confirmDeliveryPush: 120_000,
  retryDelivery: 120_000,
  undoDelivery: 120_000,
  openDeliveryMainWorktree: 10_000,
  previewPushBranch: 120_000,
  pushBranch: 120_000,
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The gateway owns the per-command deadline. Mutating commands wait slightly
 * longer so a long fork / side task never gets abandoned (and retried under a
 * new idempotency key) right as the gateway is about to answer. Read-only
 * commands keep the exact deadline: giving up early cannot duplicate work.
 */
export const COMMAND_TIMEOUT_GRACE_MS = 5_000

/** Commands that change state: they carry an idempotency key and may be resent. */
export const MUTATING_COMMAND_KINDS: ReadonlySet<MobileCommandKind> = new Set([
  'sendPrompt',
  'cancelTurn',
  'resolvePermission',
  'cancelPermission',
  'resolveElicitation',
  'setConfigOption',
  'pauseAutoResolve',
  'resumeAutoResolve',
  'newSession',
  'renameSession',
  'closeSession',
  'deleteSession',
  'deleteHistorySession',
  'forkSession',
  'rewindSession',
  'createSideTask',
  'openSideTask',
  'deleteSideTask',
  'openSession',
  'startDelivery',
  'confirmDeliveryPush',
  'retryDelivery',
  'undoDelivery',
  'openDeliveryMainWorktree',
  'pushBranch',
])

export type CommandErrorCode =
  | MobileErrorCode
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'cancelled'

export class CommandError extends Error {
  readonly code: CommandErrorCode

  constructor(code: CommandErrorCode, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

export interface CommandTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CommandRequestOptions {
  /** Reuse a key from a previous attempt of the same logical operation. */
  readonly idempotencyKey?: string | undefined
  /**
   * `stale_request` means the request was already handled elsewhere; callers
   * that render an approval card treat it as success instead of an error.
   */
  readonly treatStaleAsSuccess?: boolean | undefined
  readonly timeoutMs?: number | undefined
  readonly validateResult?: ((value: unknown) => boolean) | undefined
}

export interface CommandClientOptions {
  readonly send: (frame: CommandFrame) => void
  readonly timers?: CommandTimers | undefined
  readonly createRequestId?: (() => string) | undefined
  readonly createIdempotencyKey?: (() => string) | undefined
  readonly defaultTimeoutMs?: number | undefined
}

interface PendingCommand {
  readonly requestId: string
  readonly kind: MobileCommandKind
  readonly frame: CommandFrame
  readonly resolve: (value: unknown) => void
  readonly reject: (error: CommandError) => void
  readonly options: CommandRequestOptions
  timer: unknown
}

const defaultTimers: CommandTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** UUID v4 via the platform CSPRNG, with a deterministic fallback for tests. */
export function createCommandId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * One request/response pipeline for every phone command. Mutating commands get
 * an idempotency key automatically; `resendPending()` retries the *same*
 * request with the *same* key after a reconnect, so a lost response can never
 * turn into a duplicated prompt or session.
 */
export class CommandClient {
  private readonly _send: (frame: CommandFrame) => void
  private readonly _timers: CommandTimers
  private readonly _createRequestId: () => string
  private readonly _createIdempotencyKey: () => string
  private readonly _defaultTimeoutMs: number
  private readonly _pending = new Map<string, PendingCommand>()

  constructor(options: CommandClientOptions) {
    this._send = options.send
    this._timers = options.timers ?? defaultTimers
    this._createRequestId = options.createRequestId ?? createCommandId
    this._createIdempotencyKey = options.createIdempotencyKey ?? createCommandId
    this._defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  request<T>(
    kind: MobileCommandKind,
    payload: unknown,
    options: CommandRequestOptions = {},
  ): Promise<T> {
    const requestId = this._createRequestId()
    const mutating = MUTATING_COMMAND_KINDS.has(kind)
    const idempotencyKey =
      options.idempotencyKey ?? (mutating ? this._createIdempotencyKey() : undefined)
    const frame: CommandFrame = {
      type: 'command',
      requestId,
      kind,
      payload,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingCommand = {
        requestId,
        kind,
        frame,
        resolve: (value) => resolve(value as T),
        reject,
        options,
        timer: undefined,
      }
      this._armTimeout(pending)
      this._pending.set(requestId, pending)
      try {
        this._send(frame)
      } catch (error) {
        this._remove(pending)
        reject(
          new CommandError(
            'network',
            error instanceof Error ? error.message : 'failed to send command',
          ),
        )
      }
    })
  }

  /** True when the frame belonged to a pending command. */
  handleResult(frame: CommandResultFrame): boolean {
    const pending = this._pending.get(frame.requestId)
    if (pending === undefined) return false
    this._remove(pending)

    if (frame.ok) {
      const validator = pending.options.validateResult
      if (validator !== undefined && !validator(frame.result)) {
        pending.reject(new CommandError('invalid_response', 'command result is malformed'))
        return true
      }
      pending.resolve(frame.result)
      return true
    }

    const code = isMobileErrorCode(frame.error) ? frame.error : 'internal'
    if (code === 'stale_request' && pending.options.treatStaleAsSuccess === true) {
      pending.resolve(undefined)
      return true
    }
    pending.reject(new CommandError(code, `command failed: ${code}`))
    return true
  }

  /**
   * Resend every in-flight command verbatim. Used after a WebSocket reconnect:
   * the gateway answers mutating duplicates from its idempotency cache.
   */
  resendPending(): void {
    for (const pending of [...this._pending.values()]) {
      this._timers.clearTimeout(pending.timer)
      this._armTimeout(pending)
      try {
        this._send(pending.frame)
      } catch (error) {
        this._remove(pending)
        pending.reject(
          new CommandError(
            'network',
            error instanceof Error ? error.message : 'failed to send command',
          ),
        )
      }
    }
  }

  /** Reject every pending command (session closed / socket stopped). */
  clear(reason: 'cancelled' | 'network' = 'cancelled'): void {
    for (const pending of [...this._pending.values()]) {
      this._remove(pending)
      pending.reject(
        new CommandError(reason, reason === 'network' ? 'connection closed' : 'command cancelled'),
      )
    }
  }

  get pendingCount(): number {
    return this._pending.size
  }

  private _armTimeout(pending: PendingCommand): void {
    const grace = MUTATING_COMMAND_KINDS.has(pending.kind) ? COMMAND_TIMEOUT_GRACE_MS : 0
    const delay =
      pending.options.timeoutMs ??
      (COMMAND_TIMEOUT_MS[pending.kind] ?? this._defaultTimeoutMs) + grace
    pending.timer = this._timers.setTimeout(() => {
      this._remove(pending)
      pending.reject(new CommandError('timeout', `command timed out: ${pending.kind}`))
    }, delay)
  }

  private _remove(pending: PendingCommand): void {
    this._timers.clearTimeout(pending.timer)
    this._pending.delete(pending.requestId)
  }
}
