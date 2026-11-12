/**
 * Local providers throw `FileSystemError`, but the IPC and remote transports
 * revive errors as plain `Error` objects that only keep `name`/`code`.
 * Classify by the `code` shape so a remote ENOENT is not reported as internal.
 */
function readFsErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The requested path itself is unusable, so the caller's request is at fault. */
export function isUnavailablePathError(err: unknown): boolean {
  const code = readFsErrorCode(err)
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' || code === 'EISDIR'
}

/** Log-safe description — an error message may contain an absolute path. */
export function describeFsError(err: unknown): string {
  const code = readFsErrorCode(err)
  if (code !== undefined) return `code=${code}`
  return err instanceof Error ? `name=${err.name}` : 'unknown error'
}
