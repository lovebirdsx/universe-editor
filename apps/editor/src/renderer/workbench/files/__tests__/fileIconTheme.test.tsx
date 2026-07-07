import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { resolveFileIcon } from '../fileIconTheme.js'

describe('resolveFileIcon', () => {
  it('prefers exact file names over generic extensions', () => {
    const resolved = resolveFileIcon(URI.file('/ws/package.json'), { isDirectory: false })
    expect(resolved.id).toBe('mi-nodejs')
  })

  it('matches directory names and open state', () => {
    const closed = resolveFileIcon(URI.file('/ws/src'), { isDirectory: true })
    const open = resolveFileIcon(URI.file('/ws/src'), { isDirectory: true, expanded: true })
    expect(closed.id).toBe('mi-folder-src')
    expect(open.id).toBe('mi-folder-src-open')
  })

  it('falls back to language when the file name has no extension mapping', () => {
    const resolved = resolveFileIcon(URI.file('/ws/weird'), {
      isDirectory: false,
      languageId: 'json',
    })
    expect(resolved.id).toBe('mi-json')
  })

  it('falls back to a plaintext document icon for unknown text files', () => {
    const resolved = resolveFileIcon(URI.file('/ws/data.unknownext'), { isDirectory: false })
    expect(resolved.id).toBe('mi-document')
  })

  it('uses the default file icon when nothing matches', () => {
    const resolved = resolveFileIcon(URI.file('/ws/data.unknownext'), {
      isDirectory: false,
      languageId: 'no-such-language',
    })
    expect(resolved.id).toBe('mi-file')
  })
})
