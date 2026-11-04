import { describe, expect, it } from 'vitest'
import { DocumentStore } from '../documentStore.js'

const URI_A = 'file:///ws/a.md'

describe('DocumentStore', () => {
  it('fires create and change on a first open', () => {
    const store = new DocumentStore()
    const events: string[] = []
    store.onDidCreate((doc) => events.push(`create:${doc.getText()}`))
    store.onDidChange((doc) => events.push(`change:${doc.getText()}`))

    store.open(URI_A, 1, '# A')

    expect(events).toEqual(['create:# A', 'change:# A'])
  })

  it('fires only change when an already-tracked document is opened again', () => {
    const store = new DocumentStore()
    store.open(URI_A, 1, '# A')
    const events: string[] = []
    store.onDidCreate(() => events.push('create'))
    store.onDidChange((doc) => events.push(`change:${doc.getText()}`))

    store.open(URI_A, 2, '# B')

    expect(events).toEqual(['change:# B'])
    expect(store.get(URI_A)?.getText()).toBe('# B')
  })

  it('drops the overlay without reporting the existing file as deleted', () => {
    const store = new DocumentStore()
    let deleted = false
    store.onDidDelete(() => (deleted = true))
    store.open(URI_A, 1, '# A')
    store.close(URI_A)
    expect(store.has(URI_A)).toBe(false)
    expect(store.get(URI_A)).toBeUndefined()
    expect(deleted).toBe(false)
  })
})
