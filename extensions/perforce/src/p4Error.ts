/**
 * Turns a failed `p4` result into a user-facing notification, and classifies the
 * two connection failures the extension must react to: an unreachable server
 * (offline) and an expired/absent session (needs login). Mirrors git's
 * gitError.ts. The real p4 stderr is surfaced in the toast; a button opens the
 * full Perforce output for the long tail.
 */
import { window } from '@universe-editor/extension-api'
import type { P4ExecResult } from './p4Service.js'
import { localize } from './nls.js'

export type P4FailureKind = 'offline' | 'session-expired' | 'not-logged-in' | 'no-cli' | 'other'

/** The raw reason a p4 command failed: stderr first, stdout fallback, exit code
 *  as last resort so the toast never ends in a bare "failed:". */
export function p4ErrorText(res: P4ExecResult): string {
  return res.stderr.trim() || res.stdout.trim() || `p4 exited with code ${res.exitCode}`
}

/** Classify a p4 failure from its combined stderr+stdout. */
export function classifyP4Error(res: P4ExecResult): P4FailureKind {
  const msg = `${res.stderr}\n${res.stdout}`.toLowerCase()
  if (
    msg.includes('your session has expired') ||
    msg.includes('session expired') ||
    msg.includes('ticket has expired')
  ) {
    return 'session-expired'
  }
  if (
    msg.includes('perforce password (p4passwd) invalid or unset') ||
    msg.includes('please login') ||
    msg.includes('user is not logged in')
  ) {
    return 'not-logged-in'
  }
  if (
    msg.includes('connect to server failed') ||
    msg.includes('tcp connect to') ||
    msg.includes('connection refused') ||
    msg.includes('unable to connect')
  ) {
    return 'offline'
  }
  return 'other'
}

/** True when the spawn itself failed because the p4 binary is missing. */
export function isMissingCli(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ENOENT'
}

/** Opens the Perforce output channel; wired up by `activate`. */
let showOutput: (() => void) | undefined

export function setP4OutputShower(fn: () => void): void {
  showOutput = fn
}

const OPEN_OUTPUT = localize('perforce.btn.openOutput', 'Open Perforce Output')

/**
 * Surface a failed p4 command: `Perforce <label> failed: <reason>`, with an
 * "Open Perforce Output" button for the full log. `label` is the human verb for
 * the operation, e.g. 'refresh', 'login'.
 */
export async function notifyP4Failure(label: string, res: P4ExecResult): Promise<void> {
  const message = `Perforce ${label} failed: ${p4ErrorText(res)}`
  const items = showOutput ? [OPEN_OUTPUT] : []
  const picked = await window.showErrorMessage(message, ...items)
  if (picked === OPEN_OUTPUT) showOutput?.()
}
