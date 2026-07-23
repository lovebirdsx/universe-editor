/*---------------------------------------------------------------------------------------------
 *  ExtHostDocuments incremental mirror: open pushes full text once, changes are
 *  LSP-shaped deltas applied in array order onto a mutable document (identity is
 *  stable across edits so extensions can hold live references).
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { TextDocumentChangeEvent } from '@universe-editor/extension-api'
import { ExtHostDocuments } from '../hostDocuments.js'

const uri = URI.file('/ws/a.ts')

describe('ExtHostDocuments incremental sync', () => {
  it('applies a ranged delta onto the opened text', () => {
    const docs = new ExtHostDocuments()
    docs.acceptOpen(uri, 'typescript', 1, 'const a = 1\nconst b = 2\n')
    docs.acceptChange(uri, 2, [
      { range: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } }, text: 'bee' },
    ])
    const doc = docs.getOrSynthesize(uri)
    expect(doc.getText()).toBe('const a = 1\nconst bee = 2\n')
    expect(doc.version).toBe(2)
  })

  it('applies multiple deltas of one batch sequentially (end-of-document-first)', () => {
    const docs = new ExtHostDocuments()
    docs.acceptOpen(uri, 'typescript', 1, 'abcdef')
    // Same-base multi-cursor batch sorted descending: insert at 4, then at 1.
    docs.acceptChange(uri, 2, [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, text: 'Y' },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: 'X' },
    ])
    expect(docs.getOrSynthesize(uri).getText()).toBe('aXbcdYef')
  })

  it('treats a rangeless change as a full-document replacement (model flush)', () => {
    const docs = new ExtHostDocuments()
    docs.acceptOpen(uri, 'typescript', 1, 'old text')
    docs.acceptChange(uri, 5, [{ text: 'entirely new' }])
    const doc = docs.getOrSynthesize(uri)
    expect(doc.getText()).toBe('entirely new')
    expect(doc.version).toBe(5)
  })

  it('keeps the document identity stable across edits and fires contentChanges', () => {
    const docs = new ExtHostDocuments()
    docs.acceptOpen(uri, 'typescript', 1, 'a')
    const before = docs.getOrSynthesize(uri)
    const events: TextDocumentChangeEvent[] = []
    docs.onDidChange((e) => events.push(e))
    docs.acceptChange(uri, 2, [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: 'b' },
    ])
    expect(docs.getOrSynthesize(uri)).toBe(before)
    expect(events).toHaveLength(1)
    expect(events[0]?.document).toBe(before)
    expect(events[0]?.contentChanges).toEqual([
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: 'b' },
    ])
    expect(before.getText()).toBe('ab')
  })

  it('drops a delta for a document that was never opened', () => {
    const docs = new ExtHostDocuments()
    let fired = 0
    docs.onDidChange(() => fired++)
    docs.acceptChange(uri, 2, [{ text: 'orphan' }])
    expect(fired).toBe(0)
    expect(docs.all()).toHaveLength(0)
  })
})

describe('ExtHostDocuments.whenOpen', () => {
  it('resolves immediately when the document is already mirrored', async () => {
    const docs = new ExtHostDocuments()
    docs.acceptOpen(uri, 'typescript', 1, 'text')
    await expect(docs.whenOpen(uri, 50)).resolves.toBe(docs.get(uri))
  })

  it('resolves once a late didOpen for the same uri lands', async () => {
    const docs = new ExtHostDocuments()
    const pending = docs.whenOpen(uri, 5_000)
    docs.acceptOpen(URI.file('/ws/other.ts'), 'typescript', 1, 'not it')
    docs.acceptOpen(uri, 'typescript', 1, 'the one')
    const doc = await pending
    expect(doc?.getText()).toBe('the one')
  })

  it('resolves undefined when nothing opens within the timeout', async () => {
    const docs = new ExtHostDocuments()
    await expect(docs.whenOpen(uri, 10)).resolves.toBeUndefined()
  })
})
