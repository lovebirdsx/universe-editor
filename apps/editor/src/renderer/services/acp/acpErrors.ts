/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Consolidated ACP error types. Centralised here so consumers can catch/judge
 *  the whole family from one import instead of reaching into the service /
 *  session / connection modules that happen to raise them.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local error type signalling "the in-flight prompt was cancelled locally
 * (via cancelTurn)". Distinct from RequestError so callers can map it to a
 * neutral status instead of an error UI.
 */
export class AcpAbortError extends Error {
  constructor(message = 'Aborted') {
    super(message)
    this.name = 'AcpAbortError'
  }
}

/**
 * Error a queued prompt is rejected with when the connection fails before it
 * could be dispatched. Distinct from AcpAbortError (local cancel) so callers can
 * tell "the agent never started" apart from "the user cancelled".
 */
export class AcpConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpConnectionError'
  }
}

/**
 * Thrown when resume is attempted for a session whose `cwd` does not match the
 * currently open workspace folder. Resuming would spawn the agent against the
 * session's own cwd (a sibling worktree) while the UI's file tree / SCM / search
 * stay on the current folder — a split-brain where edits land in the wrong repo.
 * The UI catches this and routes the user through the cross-worktree activation
 * flow (open the owning worktree in a new window, or switch the current one)
 * instead of silently spawning.
 */
export class AcpForeignWorktreeError extends Error {
  constructor(
    readonly sessionId: string,
    readonly sessionCwd: string,
    readonly currentCwd: string | undefined,
  ) {
    super(
      `Session ${sessionId} belongs to ${sessionCwd}, which is not the open workspace` +
        `${currentCwd ? ` (${currentCwd})` : ''}`,
    )
    this.name = 'AcpForeignWorktreeError'
  }
}
