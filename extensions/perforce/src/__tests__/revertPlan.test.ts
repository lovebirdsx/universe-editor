import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRevertTargets,
  knownChangelist,
  revertActionsOf,
  type OpenedTarget,
  type RevertPlan,
} from '../revertPlan.js'
import { norm } from '../pathUtil.js'

function openState(
  entries: readonly (readonly [string, string | undefined])[],
): Map<string, string | undefined> {
  return new Map(entries.map(([path, cl]) => [norm(path), cl]))
}

describe('classifyRevertTargets', () => {
  const paths = ['a.txt', 'b.txt', 'c.txt']

  it('empty selection → empty plan', () => {
    expect(classifyRevertTargets([], new Map())).toEqual({ opened: [], unopened: [] })
  })

  it('all unopened', () => {
    expect(classifyRevertTargets(paths, new Map())).toEqual({
      opened: [],
      unopened: paths,
    })
  })

  it('all opened, preserving default vs numbered changelist', () => {
    expect(
      classifyRevertTargets(
        paths,
        openState([
          ['a.txt', 'default'],
          ['b.txt', '123'],
          ['c.txt', 'default'],
        ]),
      ),
    ).toEqual({
      opened: [
        { path: 'a.txt', changelist: 'default' },
        { path: 'b.txt', changelist: '123' },
        { path: 'c.txt', changelist: 'default' },
      ],
      unopened: [],
    })
  })

  it('mixed → opened keep their CL, unopened stay out', () => {
    expect(
      classifyRevertTargets(
        paths,
        openState([
          ['a.txt', 'default'],
          ['c.txt', '9'],
        ]),
      ),
    ).toEqual({
      opened: [
        { path: 'a.txt', changelist: 'default' },
        { path: 'c.txt', changelist: '9' },
      ],
      unopened: ['b.txt'],
    })
  })

  it('opened with unknown changelist omits the field', () => {
    expect(classifyRevertTargets(['a.txt'], openState([['a.txt', undefined]]))).toEqual({
      opened: [{ path: 'a.txt' }],
      unopened: [],
    })
  })

  it('opened with a non-CL group id omits the field (no #resolve)', () => {
    expect(classifyRevertTargets(['a.txt'], openState([['a.txt', 'resolve']]))).toEqual({
      opened: [{ path: 'a.txt' }],
      unopened: [],
    })
  })

  it('directories + openedUnknown flags pass through (trailing slash stripped)', () => {
    expect(
      classifyRevertTargets([], new Map(), { directories: ['src/'], openedUnknown: true }),
    ).toEqual({
      opened: [],
      unopened: [],
      directories: ['src'],
      openedUnknown: true,
    })
  })

  it('multiple directories pass through with trailing slashes stripped', () => {
    expect(classifyRevertTargets([], new Map(), { directories: ['a/', 'b'] })).toEqual({
      opened: [],
      unopened: [],
      directories: ['a', 'b'],
    })
  })

  it('looks up open state by norm (slash / drive-letter folding)', () => {
    const path = 'X:/p4ws/main/a.txt'
    const keyed = 'X:\\p4ws\\main\\a.txt'
    expect(classifyRevertTargets([path], openState([[keyed, 'default']]))).toEqual({
      opened: [{ path, changelist: 'default' }],
      unopened: [],
    })
  })
})

describe('knownChangelist', () => {
  it('keeps default and numbered ids', () => {
    expect(knownChangelist('default')).toBe('default')
    expect(knownChangelist('123')).toBe('123')
    expect(knownChangelist('0')).toBe('0')
  })

  it('drops unknown / non-CL group ids', () => {
    expect(knownChangelist(undefined)).toBeUndefined()
    expect(knownChangelist('resolve')).toBeUndefined()
    expect(knownChangelist('cl:123')).toBeUndefined()
  })
})

describe('revertActionsOf', () => {
  it('unopened-only → clean those paths, never revert', () => {
    expect(revertActionsOf({ opened: [], unopened: ['a.ts', 'b.ts'] })).toEqual({
      revert: [],
      clean: ['a.ts', 'b.ts'],
    })
  })

  it('opened-only → revert those paths, never clean', () => {
    expect(
      revertActionsOf({
        opened: [
          { path: 'a.ts', changelist: 'default' },
          { path: 'b.ts', changelist: '8' },
        ],
        unopened: [],
      }),
    ).toEqual({ revert: ['a.ts', 'b.ts'], clean: [] })
  })

  it('mixed → revert opened subset and clean unopened subset', () => {
    expect(
      revertActionsOf({
        opened: [{ path: 'a.ts', changelist: 'default' }],
        unopened: ['b.ts'],
      }),
    ).toEqual({ revert: ['a.ts'], clean: ['b.ts'] })
  })

  it('directory with no opened → clean dir/..., skip revert', () => {
    expect(revertActionsOf({ opened: [], unopened: [], directories: ['src'] })).toEqual({
      revert: [],
      clean: ['src/...'],
    })
  })

  it('directory with opened → revert and clean the same dir/... spec', () => {
    expect(
      revertActionsOf({
        opened: [{ path: 'src/a.ts', changelist: '8' }],
        unopened: [],
        directories: ['src'],
      }),
    ).toEqual({ revert: ['src/...'], clean: ['src/...'] })
  })

  it('directory fail-open (unknown, empty list) still reverts dir/...', () => {
    expect(
      revertActionsOf({
        opened: [],
        unopened: [],
        directories: ['src'],
        openedUnknown: true,
      }),
    ).toEqual({ revert: ['src/...'], clean: ['src/...'] })
  })

  it('multiple directories with no opened → clean every dir/..., skip revert', () => {
    expect(revertActionsOf({ opened: [], unopened: [], directories: ['a', 'b'] })).toEqual({
      revert: [],
      clean: ['a/...', 'b/...'],
    })
  })

  it('multiple directories with opened → revert and clean every dir/... spec', () => {
    expect(
      revertActionsOf({
        opened: [{ path: 'a/x.ts', changelist: '8' }],
        unopened: [],
        directories: ['a', 'b'],
      }),
    ).toEqual({ revert: ['a/...', 'b/...'], clean: ['a/...', 'b/...'] })
  })

  it('directories plus unopened files clean both specs and files', () => {
    expect(
      revertActionsOf({
        opened: [],
        unopened: ['x.ts'],
        directories: ['a', 'b'],
      }),
    ).toEqual({ revert: [], clean: ['a/...', 'b/...', 'x.ts'] })
  })
})

describe('formatRevertConfirm', () => {
  const original = process.env.UNIVERSE_DISPLAY_LOCALE

  afterEach(() => {
    if (original === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
    else process.env.UNIVERSE_DISPLAY_LOCALE = original
  })

  async function load(locale: string) {
    vi.resetModules()
    process.env.UNIVERSE_DISPLAY_LOCALE = locale
    return await import('../revertPlan.js')
  }

  function opened(path: string, changelist?: string): OpenedTarget {
    return changelist === undefined ? { path } : { path, changelist }
  }

  it('unopened one file uses the discard-one wording (basename, not full path)', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = { opened: [], unopened: ['X:/p4ws/main/foo.ts'] }
    expect(formatRevertConfirm(plan)).toBe(
      "Discard working-tree changes for 'foo.ts'? This cannot be undone.",
    )
  })

  it('unopened many files uses the count wording', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = { opened: [], unopened: ['a.ts', 'b.ts', 'c.ts'] }
    expect(formatRevertConfirm(plan)).toBe(
      'Discard working-tree changes for 3 files? This cannot be undone.',
    )
  })

  it('unopened directory uses the directory wording', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = { opened: [], unopened: [], directories: ['X:/p4ws/main/src'] }
    expect(formatRevertConfirm(plan)).toBe(
      "Discard working-tree changes under 'src'? This cannot be undone.",
    )
  })

  it('unopened multiple directories use the plural wording', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [],
      unopened: [],
      directories: ['X:/p4ws/main/src', 'X:/p4ws/main/assets'],
    }
    expect(formatRevertConfirm(plan)).toBe(
      'Discard working-tree changes under 2 directories? This cannot be undone.',
    )
  })

  it('unopened dirs plus unopened files names both losses', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [],
      unopened: ['a.ts', 'b.ts'],
      directories: ['X:/p4ws/main/src'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain("Discard working-tree changes under 'src'? This cannot be undone.")
    expect(text).toContain('Working-tree changes on 2 unopened file(s) will also be discarded.')
  })

  it('opened files list basename + Default vs #n', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [opened('X:/p4ws/main/foo.ts', 'default'), opened('X:/p4ws/main/bar.ts', '123')],
      unopened: [],
    }
    expect(formatRevertConfirm(plan)).toBe(
      [
        'These files will leave their changelist. Local changes will be lost.',
        'foo.ts  (Default)',
        'bar.ts  (#123)',
      ].join('\n'),
    )
  })

  it('truncates the opened list at listCap and reports the remainder', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: Array.from({ length: 11 }, (_, i) => opened(`f${i}.ts`, 'default')),
      unopened: [],
    }
    const text = formatRevertConfirm(plan, { listCap: 10 })
    expect(text).toContain('f0.ts  (Default)')
    expect(text).toContain('f9.ts  (Default)')
    expect(text).not.toContain('f10.ts')
    expect(text).toContain('…and 1 more')
  })

  it('mixed mentions the opened list and the unopened count', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [opened('foo.ts', 'default')],
      unopened: ['a.ts', 'b.ts'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('foo.ts  (Default)')
    expect(text).toContain('Working-tree changes on 2 unopened file(s) will also be discarded.')
  })

  it('directory with opened files lists them and warns about unopened drift', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [opened('src/foo.ts', '8')],
      unopened: [],
      directories: ['src'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('foo.ts  (#8)')
    expect(text).toContain(
      'Unopened working-tree changes under this directory will also be discarded.',
    )
  })

  it('multiple directories with opened files use the plural drift wording', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [opened('a/foo.ts', '8')],
      unopened: [],
      directories: ['a', 'b'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('foo.ts  (#8)')
    expect(text).toContain(
      'Unopened working-tree changes under these directories will also be discarded.',
    )
  })

  it('opened dirs plus unopened files names every loss (no else-if swallowing)', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [opened('a/foo.ts', 'default')],
      unopened: ['x.ts'],
      directories: ['a'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('foo.ts  (Default)')
    expect(text).toContain(
      'Unopened working-tree changes under this directory will also be discarded.',
    )
    expect(text).toContain('Working-tree changes on 1 unopened file(s) will also be discarded.')
  })

  it('directory fail-open (no list) uses the unknown-opened wording', async () => {
    const { formatRevertConfirm } = await load('en-US')
    const plan: RevertPlan = {
      opened: [],
      unopened: [],
      directories: ['src'],
      openedUnknown: true,
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('the list could not be determined')
    expect(text).toContain(
      'Unopened working-tree changes under this directory will also be discarded.',
    )
    expect(text).not.toContain("Discard working-tree changes under 'src'")
  })

  it('zh-CN opened list uses fullwidth parens and the 默认 label', async () => {
    const { formatRevertConfirm } = await load('zh-CN')
    const plan: RevertPlan = {
      opened: [opened('foo.ts', 'default'), opened('bar.ts', '123')],
      unopened: ['x.ts'],
    }
    const text = formatRevertConfirm(plan)
    expect(text).toContain('以下文件将离开 changelist')
    expect(text).toContain('foo.ts  （默认）')
    expect(text).toContain('bar.ts  （#123）')
    expect(text).toContain('其余 1 个未签出文件的工作区改动也会被丢弃。')
  })

  it('zh-CN multi-directory confirm uses the plural discard + drift wording', async () => {
    const { formatRevertConfirm } = await load('zh-CN')
    const unopened: RevertPlan = { opened: [], unopened: [], directories: ['a', 'b'] }
    expect(formatRevertConfirm(unopened)).toBe('放弃 2 个目录下的工作区改动？此操作不可撤销。')
    const withOpened: RevertPlan = {
      opened: [opened('a/foo.ts', '8')],
      unopened: [],
      directories: ['a', 'b'],
    }
    expect(formatRevertConfirm(withOpened)).toContain('这些目录下未签出的工作区改动也会被丢弃。')
  })
})
