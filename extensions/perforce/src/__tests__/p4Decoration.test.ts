import { describe, expect, it } from 'vitest'
import { toShelvedResourceState } from '../p4Decoration.js'

/*
 * A shelved row carries a depot path (`//depot/…`): the file exists only on the
 * server, so the host must not offer its own host-file actions for that row.
 * The gate used to live in the manifest (`scmResourceState != S` on
 * `perforce.openFile`); the host owns those actions now, and this flag is what
 * tells it the path names no local file.
 */
describe('perforce shelved resource state', () => {
  it('marks the row as naming no file on the host', () => {
    const state = toShelvedResourceState(
      { depotFile: '//depot/branch_x/a.txt', rev: '3', action: 'edit' },
      '12',
    )

    expect(state.noHostFile).toBe(true)
    expect(state.resourceUri).toBe('//depot/branch_x/a.txt')
  })
})
