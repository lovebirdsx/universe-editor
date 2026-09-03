import { describe, expect, it } from 'vitest'
import type { P4GraphChangeDetailsDto } from '@universe-editor/extensions-common'
import { buildChangePayload } from '../commitChangesPayload.js'

function makeDetails(overrides: Partial<P4GraphChangeDetailsDto> = {}): P4GraphChangeDetailsDto {
  return {
    id: '42',
    author: 'bob',
    client: 'ws',
    date: 1700000000,
    body: 'fix the thing\n\nlong body',
    files: [
      {
        status: 'M',
        path: 'depot/main/a.txt',
        oldPath: null,
        depotFile: '//depot/main/a.txt',
        rev: '3',
        localPath: 'C:/ws/main/a.txt',
      },
    ],
    ...overrides,
  }
}

describe('buildChangePayload', () => {
  it('builds the changelist payload', () => {
    const payload = buildChangePayload(makeDetails())
    expect(payload.providerId).toBe('perforce')
    expect(payload.title).toBe('Changelist 42 — fix the thing')
    expect(payload.subtitle).toBe(`bob · ${new Date(1700000000 * 1000).toLocaleString()}`)
    expect(payload.commitRef).toBe('42')
    expect(payload.openExternalCommand).toBe('perforce-graph.openFileDiff')
    expect(payload.metadata).toEqual({
      author: 'bob',
      authorDate: 1700000000,
      message: 'fix the thing\n\nlong body',
    })
    expect(payload.files).toEqual([
      {
        path: 'depot/main/a.txt',
        oldPath: null,
        status: 'M',
        resourcePath: 'C:/ws/main/a.txt',
        args: {
          depotFile: '//depot/main/a.txt',
          status: 'M',
          rev: '3',
          localPath: 'C:/ws/main/a.txt',
        },
      },
    ])
  })

  it('omits the subject when the description is empty', () => {
    expect(buildChangePayload(makeDetails({ body: '' })).title).toBe('Changelist 42')
  })

  it('nulls resourcePath and omits localPath from args when the file is outside the client view', () => {
    const payload = buildChangePayload(
      makeDetails({
        files: [
          {
            status: 'D',
            path: 'depot/main/gone.txt',
            oldPath: null,
            depotFile: '//depot/main/gone.txt',
            rev: '5',
            localPath: null,
          },
        ],
      }),
    )
    expect(payload.files[0]?.resourcePath).toBeNull()
    expect(payload.files[0]?.args).toEqual({
      depotFile: '//depot/main/gone.txt',
      status: 'D',
      rev: '5',
    })
  })

  it('carries clientRoot into every row diff request, and omits the key when absent', () => {
    const withRoot = buildChangePayload(makeDetails(), { clientRoot: 'C:/ws/main' })
    expect(withRoot.files[0]?.args).toMatchObject({ clientRoot: 'C:/ws/main' })
    expect(Object.keys(buildChangePayload(makeDetails()).files[0]?.args as object)).not.toContain(
      'clientRoot',
    )
  })
})

describe('buildChangePayload with a merged-history scope', () => {
  function file(path: string, localPath: string | null) {
    return { status: 'M', path, oldPath: null, depotFile: `//${path}`, rev: '3', localPath }
  }

  const DETAILS = makeDetails({
    files: [
      file('depot/main/a.txt', 'C:/ws/main/a.txt'),
      file('depot/main/lib/x.ts', 'C:/ws/main/lib/x.ts'),
      file('depot/main/unrelated.txt', 'C:/ws/main/unrelated.txt'),
      file('depot/main/gone.txt', null),
    ],
  })

  it('keeps the selected file and everything under a selected directory', () => {
    const payload = buildChangePayload(DETAILS, {
      scopePaths: [
        { path: 'C:/ws/main/a.txt', isDirectory: false },
        { path: 'C:/ws/main/lib', isDirectory: true },
      ],
    })
    expect(payload.files.map((f) => f.path)).toEqual(['depot/main/a.txt', 'depot/main/lib/x.ts'])
  })

  it('reports how many of the changelist files it hid', () => {
    const payload = buildChangePayload(DETAILS, {
      scopePaths: [{ path: 'C:/ws/main/a.txt', isDirectory: false }],
    })
    expect(payload.files).toHaveLength(1)
    expect(payload.subtitle).toContain('3 more file(s)')
  })

  it('a directory scope never matches a sibling sharing its prefix', () => {
    const payload = buildChangePayload(
      makeDetails({ files: [file('depot/main/libraries/y.ts', 'C:/ws/main/libraries/y.ts')] }),
      { scopePaths: [{ path: 'C:/ws/main/lib', isDirectory: true }] },
    )
    expect(payload.files).toEqual([])
  })

  it('shows an EMPTY list on zero hits rather than falling back to the whole change', () => {
    const payload = buildChangePayload(DETAILS, {
      scopePaths: [{ path: 'C:/ws/main/nothing-here.txt', isDirectory: false }],
    })
    expect(payload.files).toEqual([])
    expect(payload.subtitle).toContain('4 more file(s)')
  })

  it('drops files with no local path when filtering (they cannot be matched)', () => {
    const payload = buildChangePayload(
      makeDetails({ files: [file('depot/main/gone.txt', null)] }),
      {
        scopePaths: [{ path: 'C:/ws/main', isDirectory: true }],
      },
    )
    expect(payload.files).toEqual([])
  })
})
