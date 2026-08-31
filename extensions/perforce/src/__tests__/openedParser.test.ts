import { describe, expect, it } from 'vitest'
import type { OpenedFile } from '../changelist.js'
import {
  filterOpenedByOthers,
  parseOpened,
  parseOpenedRecord,
  parsePending,
} from '../openedParser.js'

describe('parseOpenedRecord', () => {
  it('maps a default-changelist edit', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      change: 'default',
      action: 'edit',
      rev: '3',
    })
    expect(file).toEqual({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      changelist: 'default',
      action: 'edit',
      rev: '3',
      unresolved: false,
    })
  })

  it('maps a numbered changelist and preserves the id as a string', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/b.txt',
      clientFile: 'D:/work/b.txt',
      change: '12345',
      action: 'add',
    })
    expect(file?.changelist).toBe('12345')
    expect(file?.action).toBe('add')
    expect(file?.rev).toBeUndefined()
  })

  it('flags unresolved when the field is present', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/c.txt',
      clientFile: 'D:/work/c.txt',
      change: 'default',
      action: 'integrate',
      unresolved: '1',
    })
    expect(file?.unresolved).toBe(true)
  })

  it('normalizes an unknown action to edit and defaults missing change to default', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/d.txt',
      clientFile: 'D:/work/d.txt',
      action: 'weird',
    })
    expect(file?.action).toBe('edit')
    expect(file?.changelist).toBe('default')
  })

  it('returns undefined for a record without a depot path', () => {
    expect(parseOpenedRecord({ change: 'default' })).toBeUndefined()
  })

  it('preserves move actions verbatim', () => {
    const add = parseOpenedRecord({
      depotFile: '//depot/e.txt',
      clientFile: 'D:/work/e.txt',
      action: 'move/add',
    })
    expect(add?.action).toBe('move/add')
  })

  // Repro for "edited file shows as delete + `//` URI error": real `p4 opened`
  // reports `clientFile` in client syntax (`//clientName/rel`), not a local path.
  // With a clientRoot it must be translated to the on-disk path.
  it('translates a client-syntax clientFile onto the client root', () => {
    const file = parseOpenedRecord(
      {
        depotFile: '//depot/Src/Component/ElementalComponent.ts',
        clientFile: '//ws/Src/Component/ElementalComponent.ts',
        change: 'default',
        action: 'edit',
        rev: '5',
      },
      'G:/p4ws/main',
    )
    expect(file?.clientFile).toBe('G:/p4ws/main/Src/Component/ElementalComponent.ts')
  })

  it('keeps clientFile verbatim when no clientRoot is given', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/a.txt',
      clientFile: '//ws/a.txt',
      action: 'edit',
    })
    expect(file?.clientFile).toBe('//ws/a.txt')
  })

  it('maps the owning user/client reported by `opened -a`', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/branch_x/Assets/foo.bin',
      clientFile: '//branch_x_commit/Assets/foo.bin',
      change: 'default',
      action: 'add',
      rev: '4',
      user: 'otheruser',
      client: 'branch_x_commit',
    })
    expect(file?.openedByUser).toBe('otheruser')
    expect(file?.openedByClient).toBe('branch_x_commit')
  })

  it('leaves the owner fields undefined for a plain `opened` record', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/branch_x/Assets/bar.bin',
      clientFile: 'D:/work/bar.bin',
      change: 'default',
      action: 'edit',
      rev: '4',
    })
    expect(file?.openedByUser).toBeUndefined()
    expect(file?.openedByClient).toBeUndefined()
  })
})

describe('parseOpened / parsePending', () => {
  it('filters out non-file records', () => {
    const files = parseOpened([
      { depotFile: '//depot/a.txt', clientFile: 'D:/work/a.txt', action: 'edit' },
      { info: 'banner' },
    ])
    expect(files).toHaveLength(1)
  })

  it('parses pending changelist metadata', () => {
    const pending = parsePending([
      { change: '100', desc: 'first line\nsecond' },
      { change: '101' },
      { notAChange: true },
    ])
    expect(pending).toEqual([
      { id: '100', description: 'first line\nsecond', shelved: false },
      { id: '101', description: '', shelved: false },
    ])
  })

  // `p4 changes` reports a *bare* `shelved` key (empty value after -ztag parsing)
  // for changelists holding a shelf and omits it otherwise — verified against P4D
  // 2024.2. Presence, not value, is the signal; the refresh uses it to skip
  // `describe -S -s` for every changelist without a shelf.
  it('flags a pending changelist that reports a bare shelved key', () => {
    const pending = parsePending([
      { change: '100', desc: 'has a shelf', shelved: '' },
      { change: '101', desc: 'no shelf' },
    ])
    expect(pending.map((c) => [c.id, c.shelved])).toEqual([
      ['100', true],
      ['101', false],
    ])
  })
})

describe('filterOpenedByOthers', () => {
  function opened(depotFile: string, openedByClient?: string): OpenedFile {
    return {
      depotFile,
      clientFile: 'X:/p4ws/main/' + depotFile,
      changelist: 'default',
      action: 'edit',
      rev: '3',
      unresolved: false,
      ...(openedByClient !== undefined ? { openedByClient } : {}),
    }
  }

  it('keeps only the files someone else has open', () => {
    const files = [
      opened('//depot/branch_x/a.bin', 'testclient'),
      opened('//depot/branch_x/b.bin', 'branch_x_commit'),
      opened('//depot/branch_x/c.bin', 'otherclient'),
    ]
    expect(filterOpenedByOthers(files, 'testclient').map((f) => f.depotFile)).toEqual([
      '//depot/branch_x/b.bin',
      '//depot/branch_x/c.bin',
    ])
  })

  it('treats client names case-insensitively', () => {
    const files = [opened('//depot/branch_x/a.bin', 'TestClient')]
    expect(filterOpenedByOthers(files, 'testclient')).toEqual([])
  })

  it('returns nothing when my own client name is empty', () => {
    const files = [opened('//depot/branch_x/a.bin', 'otherclient')]
    expect(filterOpenedByOthers(files, '')).toEqual([])
  })

  it('drops records with no openedByClient', () => {
    const files = [
      opened('//depot/branch_x/a.bin'),
      opened('//depot/branch_x/b.bin', 'otherclient'),
    ]
    expect(filterOpenedByOthers(files, 'testclient').map((f) => f.depotFile)).toEqual([
      '//depot/branch_x/b.bin',
    ])
  })
})
