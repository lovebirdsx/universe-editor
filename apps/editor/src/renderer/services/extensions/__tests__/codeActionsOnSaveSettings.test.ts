/**
 * `editor.codeActionsOnSave` setting resolution: which kinds run for which save
 * reason, kind-subsumption dedup, and fixAll-first ordering. Pure counterpart of
 * VSCode's CodeActionOnSaveParticipant filtering/sorting.
 */
import { describe, expect, it } from 'vitest'
import { kindContains, resolveCodeActionsOnSave } from '../codeActionsOnSaveSettings.js'

describe('kindContains', () => {
  it('matches equal kinds and dot-separated descendants', () => {
    expect(kindContains('source', 'source')).toBe(true)
    expect(kindContains('source', 'source.organizeImports')).toBe(true)
    expect(kindContains('source.fixAll', 'source.fixAll.eslint')).toBe(true)
    expect(kindContains('', 'source')).toBe(true)
  })

  it('rejects unrelated kinds and mere string prefixes', () => {
    expect(kindContains('source.organizeImports', 'source')).toBe(false)
    expect(kindContains('quickfix', 'source.fixAll')).toBe(false)
    // 'source2' starts with 'source' but is not a dot-descendant
    expect(kindContains('source', 'source2')).toBe(false)
  })
})

describe('resolveCodeActionsOnSave', () => {
  it('returns empty for no setting', () => {
    expect(resolveCodeActionsOnSave(undefined, 1)).toEqual({ include: [], excludes: [] })
    expect(resolveCodeActionsOnSave({}, 1)).toEqual({ include: [], excludes: [] })
  })

  it('runs "always" on every reason', () => {
    const setting = { 'source.organizeImports': 'always' }
    expect(resolveCodeActionsOnSave(setting, 1).include).toEqual(['source.organizeImports'])
    expect(resolveCodeActionsOnSave(setting, 2).include).toEqual(['source.organizeImports'])
    expect(resolveCodeActionsOnSave(setting, 3).include).toEqual(['source.organizeImports'])
  })

  it('runs "explicit" and true only on explicit saves', () => {
    const setting = { 'source.fixAll': 'explicit', 'source.organizeImports': true }
    expect(resolveCodeActionsOnSave(setting, 1).include).toContain('source.fixAll')
    expect(resolveCodeActionsOnSave(setting, 1).include).toContain('source.organizeImports')
    expect(resolveCodeActionsOnSave(setting, 2).include).toEqual([])
    expect(resolveCodeActionsOnSave(setting, 3).include).toEqual([])
  })

  it('collects "never" and false into excludes, never includes them', () => {
    const setting = {
      source: 'always',
      'source.fixAll': 'never',
      'source.organizeImports': false,
    }
    const r = resolveCodeActionsOnSave(setting, 1)
    expect(r.include).toEqual(['source'])
    expect(r.excludes).toEqual(expect.arrayContaining(['source.fixAll', 'source.organizeImports']))
  })

  it('drops kinds subsumed by another configured kind', () => {
    const setting = { source: 'always', 'source.organizeImports': 'always' }
    expect(resolveCodeActionsOnSave(setting, 1).include).toEqual(['source'])
  })

  it('orders fixAll kinds before other source actions', () => {
    const setting = {
      'source.organizeImports': 'always',
      'source.fixAll': 'always',
      'source.removeUnusedImports': 'always',
    }
    expect(resolveCodeActionsOnSave(setting, 1).include).toEqual([
      'source.fixAll',
      'source.organizeImports',
      'source.removeUnusedImports',
    ])
  })

  it('treats a non-fixAll parent of fixAll as fixAll group', () => {
    // kindContains('source.fixAll', 'source') is false, so 'source' alone is not
    // in the fixAll group — only genuine fixAll descendants sort first.
    const setting = { 'source.fixAll.eslint': 'always', 'source.organizeImports': 'always' }
    expect(resolveCodeActionsOnSave(setting, 1).include).toEqual([
      'source.fixAll.eslint',
      'source.organizeImports',
    ])
  })
})
