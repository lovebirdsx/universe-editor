import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { resolveFileIcon } from '../fileIconTheme.js'

describe('resolveFileIcon', () => {
  it('prefers exact file names over generic extensions', () => {
    const resolved = resolveFileIcon(URI.file('/ws/package.json'), { isDirectory: false })
    expect(resolved.id).toBe('file-package')
  })

  it('matches directory names and open state', () => {
    const closed = resolveFileIcon(URI.file('/ws/src'), { isDirectory: true })
    const open = resolveFileIcon(URI.file('/ws/src'), { isDirectory: true, expanded: true })
    expect(closed.id).toBe('folder-src')
    expect(open.id).toBe('folder-src-open')
  })

  it('falls back to language when the file name has no extension mapping', () => {
    const resolved = resolveFileIcon(URI.file('/ws/Dockerfile'), {
      isDirectory: false,
      languageId: 'json',
    })
    expect(resolved.id).toBe('file-json')
  })

  it('uses the default file icon for unknown resources', () => {
    const resolved = resolveFileIcon(URI.file('/ws/data.custom'), { isDirectory: false })
    expect(resolved.id).toBe('file-default')
  })
})
