import { afterEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  formatPathForTerminal,
  readDroppedResources,
  toMentionName,
} from '../resourceDropTransfer.js'

function dropEvent(opts: { files?: readonly File[]; uriList?: string; internalUriList?: string }): {
  dataTransfer: DataTransfer
} {
  const files = opts.files ?? []
  const dataTransfer = {
    files: files as unknown as FileList,
    getData: (type: string) =>
      type === 'text/uri-list'
        ? (opts.uriList ?? '')
        : type === 'application/vnd.universe-editor.uri-list'
          ? (opts.internalUriList ?? '')
          : '',
  } as unknown as DataTransfer
  return { dataTransfer }
}

describe('resourceDropTransfer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('readDroppedResources', () => {
    it('maps OS-external files via window.ipc.getPathForFile', () => {
      const a = { name: 'a.ts' } as File
      const b = { name: 'b.ts' } as File
      const paths = new Map<File, string>([
        [a, '/abs/a.ts'],
        [b, '/abs/b.ts'],
      ])
      vi.stubGlobal('window', { ipc: { getPathForFile: (f: File) => paths.get(f) ?? '' } })

      const out = readDroppedResources(dropEvent({ files: [a, b] }))
      expect(out.map((u) => u.fsPath.replace(/\\/g, '/'))).toEqual(['/abs/a.ts', '/abs/b.ts'])
    })

    it('falls back to text/uri-list when no files are present', () => {
      vi.stubGlobal('window', { ipc: { getPathForFile: () => '' } })
      const out = readDroppedResources(
        dropEvent({ uriList: 'file:///x/a.ts\r\n# comment\r\nfile:///x/b.ts' }),
      )
      expect(out.map((u) => u.toString())).toEqual(['file:///x/a.ts', 'file:///x/b.ts'])
    })

    it('dedupes repeated resources', () => {
      vi.stubGlobal('window', { ipc: { getPathForFile: () => '' } })
      const out = readDroppedResources(dropEvent({ uriList: 'file:///x/a.ts\r\nfile:///x/a.ts' }))
      expect(out).toHaveLength(1)
    })

    // Repro: dragging several OS files lands a CR-separated uri-list. Before the
    // fix this collapsed to a single (garbage) URI, so the editor opened one
    // file and the prompt input inserted one mangled @mention.
    it('splits a CR-separated uri-list into every resource', () => {
      vi.stubGlobal('window', { ipc: { getPathForFile: () => '' } })
      const out = readDroppedResources(
        dropEvent({ uriList: 'file:///x/a.ts\rfile:///x/b.ts\rfile:///x/c.ts' }),
      )
      expect(out.map((u) => u.toString())).toEqual([
        'file:///x/a.ts',
        'file:///x/b.ts',
        'file:///x/c.ts',
      ])
    })

    it('returns empty when there is no dataTransfer', () => {
      expect(readDroppedResources({ dataTransfer: null })).toEqual([])
    })

    // In-app drags publish a private mirror that survives the OS round-trip;
    // when the standard text/uri-list arrives glued into one line, the mirror
    // still yields every resource.
    it('reads the private mirror when text/uri-list is glued into one entry', () => {
      vi.stubGlobal('window', { ipc: { getPathForFile: () => '' } })
      const out = readDroppedResources(
        dropEvent({
          uriList: 'file:///x/a.tsfile:///x/b.ts',
          internalUriList: 'file:///x/a.ts\nfile:///x/b.ts',
        }),
      )
      expect(out.map((u) => u.toString())).toEqual(['file:///x/a.ts', 'file:///x/b.ts'])
    })
  })

  describe('formatPathForTerminal', () => {
    it('leaves space-free paths untouched', () => {
      expect(formatPathForTerminal('/a/b.ts')).toBe('/a/b.ts')
      expect(formatPathForTerminal('C:\\a\\b.ts')).toBe('C:\\a\\b.ts')
    })

    it('quotes paths containing whitespace', () => {
      expect(formatPathForTerminal('/a b/c.ts')).toBe('"/a b/c.ts"')
    })
  })

  describe('toMentionName', () => {
    it('uses the workspace-relative forward-slash path inside the root', () => {
      const root = URI.file('/ws')
      const file = URI.file('/ws/src/a.ts')
      expect(toMentionName(file, root)).toEqual({ uri: file.toString(), name: 'src/a.ts' })
    })

    it('falls back to the absolute path outside the workspace', () => {
      const root = URI.file('/ws')
      const file = URI.file('/other/a.ts')
      expect(toMentionName(file, root)).toEqual({ uri: file.toString(), name: file.fsPath })
    })

    it('uses the absolute path when no workspace root is given', () => {
      const file = URI.file('/x/y/a.ts')
      expect(toMentionName(file)).toEqual({ uri: file.toString(), name: file.fsPath })
    })
  })
})
