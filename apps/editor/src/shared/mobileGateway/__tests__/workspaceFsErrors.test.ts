import { FileSystemError } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { describeFsError, isUnavailablePathError } from '../workspaceFsErrors.js'

describe('isUnavailablePathError', () => {
  it('recognizes local FileSystemError instances', () => {
    expect(isUnavailablePathError(new FileSystemError('missing', 'ENOENT'))).toBe(true)
    expect(isUnavailablePathError(new FileSystemError('denied', 'EACCES'))).toBe(true)
    expect(isUnavailablePathError(new FileSystemError('broken', 'UNKNOWN'))).toBe(false)
  })

  it('recognizes revived IPC errors by their code', () => {
    expect(
      isUnavailablePathError(
        Object.assign(new Error('ENOENT: /home/dev/work'), { code: 'ENOENT' }),
      ),
    ).toBe(true)
    expect(
      isUnavailablePathError(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })),
    ).toBe(true)
  })

  it('treats connection failures and unknown shapes as internal', () => {
    expect(isUnavailablePathError(new Error('remote connection closed'))).toBe(false)
    expect(isUnavailablePathError({ code: 42 })).toBe(false)
    expect(isUnavailablePathError(undefined)).toBe(false)
  })
})

describe('describeFsError', () => {
  it('never includes the error message, which may carry an absolute path', () => {
    const revived = Object.assign(new Error('ENOENT: /home/dev/secret'), { code: 'ENOENT' })
    expect(describeFsError(revived)).toBe('code=ENOENT')
    expect(describeFsError(new Error('/home/dev/secret exploded'))).toBe('name=Error')
    expect(describeFsError('not an error')).toBe('unknown error')
  })
})
