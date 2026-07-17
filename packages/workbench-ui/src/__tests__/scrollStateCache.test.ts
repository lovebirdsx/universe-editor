import { describe, expect, it, beforeEach } from 'vitest'
import { ScrollStateCache } from '../list/scrollStateCache.js'

describe('ScrollStateCache', () => {
  beforeEach(() => ScrollStateCache._resetForTests())

  it('load returns undefined for an unknown key', () => {
    expect(ScrollStateCache.load('nope')).toBeUndefined()
  })

  it('saves and loads a scrollTop by key', () => {
    ScrollStateCache.save('explorer', 120)
    expect(ScrollStateCache.load('explorer')).toBe(120)
  })

  it('keeps keys independent', () => {
    ScrollStateCache.save('explorer', 10)
    ScrollStateCache.save('scm:git', 50)
    expect(ScrollStateCache.load('explorer')).toBe(10)
    expect(ScrollStateCache.load('scm:git')).toBe(50)
  })

  it('overwrites an existing key', () => {
    ScrollStateCache.save('outline', 5)
    ScrollStateCache.save('outline', 200)
    expect(ScrollStateCache.load('outline')).toBe(200)
  })

  it('clear removes the entry', () => {
    ScrollStateCache.save('search', 33)
    ScrollStateCache.clear('search')
    expect(ScrollStateCache.load('search')).toBeUndefined()
  })
})
