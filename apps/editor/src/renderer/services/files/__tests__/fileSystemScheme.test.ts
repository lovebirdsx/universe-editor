import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import { isFileSystemScheme, isFileSystemUri } from '../fileSystemScheme.js'

describe('isFileSystemScheme', () => {
  it('accepts file and the remote scheme', () => {
    expect(isFileSystemScheme('file')).toBe(true)
    expect(isFileSystemScheme(REMOTE_SCHEME)).toBe(true)
    expect(isFileSystemUri(URI.parse('remote-ssh://wsl+Ubuntu/home/user/notes.md'))).toBe(true)
  })

  it('rejects virtual editor schemes', () => {
    expect(isFileSystemScheme('universe')).toBe(false)
    expect(isFileSystemScheme('markdown-preview')).toBe(false)
    expect(isFileSystemScheme('http')).toBe(false)
    expect(isFileSystemUri(URI.parse('universe:/acp/session/3f2a-guid'))).toBe(false)
  })
})
