/**
 * An error the CLI reports to the extension author with follow-up actions.
 * `hints` are rendered as `→ <hint>` lines under the message — every UexError
 * should carry at least one so the author is never left guessing (03 §6).
 */
export class UexError extends Error {
  constructor(
    message: string,
    readonly hints: readonly string[] = [],
    readonly exitCode: number = 1,
  ) {
    super(message)
    this.name = 'UexError'
  }
}
