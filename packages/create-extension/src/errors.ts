/** An error the scaffolding CLI reports with follow-up actions (hints). */
export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly hints: readonly string[] = [],
  ) {
    super(message)
    this.name = 'ScaffoldError'
  }
}
