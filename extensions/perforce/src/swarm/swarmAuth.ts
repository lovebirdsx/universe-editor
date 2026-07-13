/**
 * Swarm credential resolution. Swarm's REST API uses HTTP Basic auth where the
 * password may be a p4 login *ticket* (recommended — reuses the existing p4
 * session) or a password. This module resolves a `Basic <base64(user:secret)>`
 * header from the active p4 connection by reading the *existing* on-disk ticket.
 *
 * RED LINE: the ticket / password appears only in memory and in the Authorization
 * header. It is NEVER written to settings, the wire DTOs, or the log.
 *
 * We read the already-issued ticket with `p4 tickets` (which just prints the
 * P4TICKETS file — it NEVER re-authenticates and NEVER prompts for a password).
 * `p4 login -p` was wrong here: despite the name it *re-runs login*, so on a
 * server that requires a password it either blocks on stdin or fails outright —
 * exactly the "already logged in but asked to log in again" symptom. We gate on
 * `p4 login -s` (session status only, never prompts) so an expired session falls
 * back to the interactive `perforce.login` flow instead.
 */
import type { P4Service } from '../p4Service.js'

export interface SwarmCredential {
  readonly user: string
  /** The `Basic ...` value for the Authorization header. */
  readonly basic: string
}

/** Build a Basic auth header value from a user + secret (ticket/password). Pure
 *  so it can be unit-tested without a p4 round-trip. */
export function buildBasicAuth(user: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')
}

/**
 * Whether the active p4 connection already has a live login session. Runs
 * `p4 login -s`, which only *reports* the session status — it never prompts for a
 * password and never blocks on stdin (unlike `p4 login -p`). Exit 0 = logged in;
 * non-zero = not logged in / session expired.
 */
export async function isLoggedIn(p4: P4Service): Promise<boolean> {
  const res = await p4.exec(['login', '-s'])
  return res.exitCode === 0
}

/**
 * Pick the ticket for `user` out of `p4 tickets` output. Each line looks like:
 *   `serverAddress (user) TICKETVALUE`
 * p4 usernames are case-insensitive, so we match case-insensitively. When no user
 * is given (shouldn't happen — callers pass one) or several match, the last one
 * wins (most recently issued). Pure so it can be unit-tested. Returns undefined
 * when nothing matches.
 */
export function pickTicketForUser(stdout: string, user: string): string | undefined {
  let found: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\S+\s+\(([^)]+)\)\s+(\S+)\s*$/.exec(line.trim())
    if (!m) continue
    const lineUser = m[1]
    const ticket = m[2]
    if (lineUser && ticket && lineUser.toLowerCase() === user.toLowerCase()) {
      found = ticket
    }
  }
  return found
}

/**
 * Resolve the current p4 login ticket by reading the existing P4TICKETS entry
 * (`p4 tickets`), reusing the session already established on this machine. Never
 * re-authenticates and never prompts for a password.
 *
 * Gated on `p4 login -s`: if there's no live session we return undefined so the
 * caller can trigger the interactive `perforce.login` flow. Returns undefined
 * when no matching ticket is on disk (e.g. logged in via password without a
 * cached ticket) — same fallback.
 */
export async function resolveTicket(p4: P4Service, user: string): Promise<string | undefined> {
  if (!(await isLoggedIn(p4))) return undefined
  const res = await p4.exec(['tickets'])
  if (res.exitCode !== 0) return undefined
  return pickTicketForUser(res.stdout, user)
}

/**
 * Resolve a Swarm credential from the active p4 connection using the p4 ticket
 * (the default, zero-new-infrastructure path). `user` comes from the connection;
 * the secret is the on-disk login ticket. Returns undefined when no user is known
 * or no ticket can be resolved (not logged in / no cached ticket).
 *
 * The independent-token path (Swarm SSO / API token via SecretStorage) is a P5
 * extension point and would branch here on `authMode === 'token'`.
 */
export async function resolveSwarmCredential(
  p4: P4Service,
  user: string | undefined,
): Promise<SwarmCredential | undefined> {
  if (!user) return undefined
  const ticket = await resolveTicket(p4, user)
  if (!ticket) return undefined
  return { user, basic: buildBasicAuth(user, ticket) }
}
