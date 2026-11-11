import { describe, expect, it } from 'vitest'
import type { AcpPromptDraft } from '../../acp/session/acpPromptDraftCache.js'
import { mergeBridgeDraft, toBridgeDraft } from '../mobileDraftSync.js'

const IMAGE = {
  id: 'img-1',
  mimeType: 'image/png',
  dataBase64: 'AAAA',
  byteSize: 3,
  name: 'shot.png',
}
const FILE = {
  id: 'file-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  byteSize: 7,
  uri: 'file:///tmp/notes.txt',
}

describe('toBridgeDraft', () => {
  it('returns undefined for a completely empty draft', () => {
    expect(toBridgeDraft({ text: '', images: [], files: [] })).toBeUndefined()
  })

  it('drops attachment bytes and projects refs/contexts as summaries', () => {
    const draft: AcpPromptDraft = {
      text: 'look @a.ts',
      caret: 4,
      images: [IMAGE],
      files: [FILE],
      refs: [
        { ref: { id: 'r1', kind: 'file', label: 'a.ts', uri: 'file:///a.ts' }, start: 5, end: 9 },
      ],
      contexts: [
        {
          uri: 'file:///a.ts',
          relPath: 'a.ts',
          text: 'code',
          startLine: 1,
          endLine: 2,
          languageId: 'ts',
        },
      ],
    }

    const projected = toBridgeDraft(draft)

    expect(projected).toEqual({
      text: 'look @a.ts',
      images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3, name: 'shot.png' }],
      files: [{ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', byteSize: 7 }],
      refs: [{ id: 'r1', kind: 'file', label: 'a.ts', start: 5, end: 9 }],
      contexts: [{ relPath: 'a.ts', startLine: 1, endLine: 2, languageId: 'ts' }],
    })
    expect(JSON.stringify(projected)).not.toContain('AAAA')
  })
})

describe('mergeBridgeDraft', () => {
  it('clears the cache for an empty incoming draft without prior content', () => {
    expect(mergeBridgeDraft(undefined, { text: '', images: [] })).toBeUndefined()
  })

  it('keeps the local caret and refs when the remote text is unchanged', () => {
    const current: AcpPromptDraft = {
      text: 'x @a.ts',
      caret: 7,
      refs: [
        { ref: { id: 'r1', kind: 'file', label: 'a.ts', uri: 'file:///a.ts' }, start: 2, end: 6 },
      ],
      contexts: [{ uri: 'file:///a.ts', relPath: 'a.ts', text: 'code', startLine: 1, endLine: 2 }],
    }

    const merged = mergeBridgeDraft(current, { text: 'x @a.ts', images: [] })

    expect(merged?.caret).toBe(7)
    expect(merged?.refs).toHaveLength(1)
    expect(merged?.contexts).toHaveLength(1)
  })

  it('drops refs but keeps contexts and the local caret when the phone edits the text', () => {
    const current: AcpPromptDraft = {
      text: 'x @a.ts',
      caret: 7,
      refs: [
        { ref: { id: 'r1', kind: 'file', label: 'a.ts', uri: 'file:///a.ts' }, start: 2, end: 6 },
      ],
      contexts: [{ uri: 'file:///a.ts', relPath: 'a.ts', text: 'code', startLine: 1, endLine: 2 }],
    }

    const merged = mergeBridgeDraft(current, { text: 'x @a.ts and more', images: [] })

    expect(merged?.caret).toBe(7)
    expect(merged?.refs).toBeUndefined()
    expect(merged?.contexts).toHaveLength(1)
  })

  it('treats an omitted picture as a deletion', () => {
    const current: AcpPromptDraft = { text: '', images: [IMAGE] }
    const merged = mergeBridgeDraft(current, { text: '', images: [] })

    expect(merged).toBeUndefined()
  })

  it('only keeps attachments the renderer already holds bytes for', () => {
    const current: AcpPromptDraft = { text: '', images: [IMAGE], files: [FILE] }
    const merged = mergeBridgeDraft(current, {
      text: '',
      images: [
        { id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3 },
        { id: 'img-2', source: 'mobile', mimeType: 'image/png', byteSize: 9 },
      ],
      files: [
        { id: 'file-1', name: 'notes.txt', byteSize: 7 },
        { id: 'file-2', name: 'other.txt', byteSize: 9 },
      ],
    })

    expect(merged?.images).toEqual([IMAGE])
    expect(merged?.files).toEqual([FILE])
  })

  it('starts at the end when there is no local caret', () => {
    expect(mergeBridgeDraft(undefined, { text: 'abc', images: [] })?.caret).toBe(3)
  })
})
