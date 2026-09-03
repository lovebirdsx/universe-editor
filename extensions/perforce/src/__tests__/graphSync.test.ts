import { describe, expect, it } from 'vitest'
import { clSpecOf, graphSyncNeedsConfirm, resolveCommonClient } from '../graphSync.js'

describe('clSpecOf', () => {
  it('builds an @-spec from a bare changelist number', () => {
    expect(clSpecOf('4521')).toBe('@4521')
  })

  it('tolerates a leading @ and surrounding whitespace', () => {
    expect(clSpecOf('@4521')).toBe('@4521')
    expect(clSpecOf(' 4521 ')).toBe('@4521')
  })

  it('rejects anything that is not a changelist number', () => {
    expect(clSpecOf('')).toBeUndefined()
    expect(clSpecOf('abc')).toBeUndefined()
    expect(clSpecOf('12a')).toBeUndefined()
    expect(clSpecOf('#5')).toBeUndefined()
    expect(clSpecOf('@2026/01/01')).toBeUndefined()
  })
})

describe('graphSyncNeedsConfirm', () => {
  const file = { path: 'X:/ws/a.txt', isDirectory: false }
  const dir = { path: 'X:/ws/src', isDirectory: true }

  it('never confirms a single-file scope', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [file] })).toBe(false)
    expect(graphSyncNeedsConfirm({ scopePaths: [file], isLatest: false })).toBe(false)
  })

  it('confirms a directory scope', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir] })).toBe(true)
  })

  it('confirms a multi-path scope even when all are files', () => {
    expect(
      graphSyncNeedsConfirm({ scopePaths: [file, { path: 'X:/ws/b.txt', isDirectory: false }] }),
    ).toBe(true)
  })

  it('confirms when no explicit scope is given (the whole displayed range)', () => {
    expect(graphSyncNeedsConfirm({})).toBe(true)
    expect(graphSyncNeedsConfirm({ scopePaths: [] })).toBe(true)
  })

  it('skips the confirmation for the latest row (a get-latest equivalent)', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir], isLatest: true })).toBe(false)
    expect(graphSyncNeedsConfirm({ isLatest: true })).toBe(false)
  })

  it('skips the confirmation when the dialog already confirmed', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir, dir], confirmed: true })).toBe(false)
  })
})

describe('resolveCommonClient', () => {
  const clientA = { root: 'X:/ws/a' }
  const clientB = { root: 'X:/ws/b' }
  // Longest-prefix style resolver: paths under clientA's or clientB's root
  // resolve to that client, anything else to nothing.
  const resolve = (p: string) =>
    p.startsWith('X:/ws/a') ? clientA : p.startsWith('X:/ws/b') ? clientB : undefined

  it('returns undefined for an empty path list', () => {
    expect(resolveCommonClient([], resolve)).toBeUndefined()
  })

  it('returns undefined when the first path resolves to nothing', () => {
    expect(resolveCommonClient(['Y:/else/f.txt', 'X:/ws/a/f.txt'], resolve)).toBeUndefined()
  })

  it('returns the owner when every path resolves to the same client', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'X:/ws/a/src'], resolve)).toBe(clientA)
  })

  it('returns undefined when a later path resolves to a different client', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'X:/ws/b/f.txt'], resolve)).toBeUndefined()
  })

  it('returns undefined when a later path resolves to nothing', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'Y:/else/f.txt'], resolve)).toBeUndefined()
  })
})
