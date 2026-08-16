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
})
