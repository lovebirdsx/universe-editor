import { describe, expect, it } from 'vitest'
import {
  groupChangelists,
  countOpened,
  descriptionFirstLine,
  fullDescription,
  numberedGroupId,
  shelvedGroupId,
  isShelvedGroupId,
  changelistIdFromGroupId,
  type OpenedFile,
  type PendingChangelist,
} from '../changelist.js'

function opened(changelist: string, name: string): OpenedFile {
  return {
    depotFile: `//depot/${name}`,
    clientFile: `D:/work/${name}`,
    changelist,
    action: 'edit',
    rev: '1',
    unresolved: false,
  }
}

const labels = {
  default: () => 'Default Changelist',
  numbered: (id: string, desc: string) => (desc ? `#${id}: ${desc}` : `#${id}`),
}

describe('descriptionFirstLine', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(descriptionFirstLine('\n  hello world \nmore')).toBe('hello world')
    expect(descriptionFirstLine('')).toBe('')
  })
})

describe('fullDescription', () => {
  it('keeps every line, folding CRLF to LF', () => {
    expect(fullDescription('my feature\r\n\r\ndetails')).toBe('my feature\n\ndetails')
  })

  it('drops the surrounding whitespace and trailing blank lines', () => {
    expect(fullDescription('  line one\nline two \n\n\n')).toBe('line one\nline two')
  })

  it('is undefined when nothing is left to show', () => {
    expect(fullDescription('')).toBeUndefined()
    expect(fullDescription('\n \n')).toBeUndefined()
  })
})

describe('groupChangelists', () => {
  it('always emits the default group first, even when empty', () => {
    const groups = groupChangelists([], [], labels)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      id: 'default',
      isDefault: true,
      label: 'Default Changelist',
      tooltip: undefined,
    })
    expect(groups[0]!.files).toEqual([])
  })

  it('buckets opened files into default and numbered groups', () => {
    const files = [opened('default', 'a.txt'), opened('123', 'b.txt'), opened('123', 'c.txt')]
    const pending: PendingChangelist[] = [
      { id: '123', description: 'my feature\ndetails', shelved: false },
    ]
    const groups = groupChangelists(files, pending, labels)

    expect(groups.map((g) => g.id)).toEqual(['default', numberedGroupId('123')])
    expect(groups[0]!.files.map((f) => f.depotFile)).toEqual(['//depot/a.txt'])
    expect(groups[1]!.label).toBe('#123: my feature')
    expect(groups[1]!.files).toHaveLength(2)
  })

  it('sorts numbered changelists ascending by numeric id', () => {
    const files = [opened('20', 'a'), opened('3', 'b'), opened('100', 'c')]
    const groups = groupChangelists(files, [], labels)
    expect(groups.map((g) => g.id)).toEqual([
      'default',
      numberedGroupId('3'),
      numberedGroupId('20'),
      numberedGroupId('100'),
    ])
  })

  it('shows a pending changelist with no open files', () => {
    const groups = groupChangelists(
      [],
      [{ id: '9', description: 'shelved only', shelved: true }],
      labels,
    )
    expect(groups.map((g) => g.id)).toEqual(['default', numberedGroupId('9')])
    expect(groups[1]!.files).toEqual([])
  })

  it('gives a numbered group the whole description as its tooltip', () => {
    const groups = groupChangelists(
      [],
      [{ id: '123', description: 'my feature\n\ndetails', shelved: false }],
      labels,
    )
    expect(groups[1]!.label).toBe('#123: my feature')
    expect(groups[1]!.tooltip).toBe('#123: my feature\n\ndetails')
  })

  it('labels a numbered changelist without a description by id only, and no tooltip', () => {
    const groups = groupChangelists([opened('7', 'a')], [], labels)
    expect(groups[1]!.label).toBe('#7')
    expect(groups[1]!.tooltip).toBeUndefined()
  })
})

describe('countOpened', () => {
  it('sums files across all groups', () => {
    const groups = groupChangelists(
      [opened('default', 'a'), opened('123', 'b'), opened('123', 'c')],
      [],
      labels,
    )
    expect(countOpened(groups)).toBe(3)
  })
})

describe('changelistIdFromGroupId', () => {
  it('maps the default group id to the literal default', () => {
    expect(changelistIdFromGroupId('default')).toBe('default')
  })

  it('extracts the numbered id from a cl: group id', () => {
    expect(changelistIdFromGroupId(numberedGroupId('4521'))).toBe('4521')
    expect(changelistIdFromGroupId('cl:7')).toBe('7')
  })

  it('extracts the numbered id from a shelved: group id', () => {
    expect(changelistIdFromGroupId(shelvedGroupId('4521'))).toBe('4521')
  })

  it('passes through an already-bare id', () => {
    expect(changelistIdFromGroupId('123')).toBe('123')
  })
})

describe('shelved group ids', () => {
  it('builds and recognises shelved group ids', () => {
    expect(shelvedGroupId('88')).toBe('shelved:88')
    expect(isShelvedGroupId('shelved:88')).toBe(true)
    expect(isShelvedGroupId(numberedGroupId('88'))).toBe(false)
    expect(isShelvedGroupId('default')).toBe(false)
  })
})
