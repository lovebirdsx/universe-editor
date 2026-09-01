/*---------------------------------------------------------------------------------------------
 *  Tests for ScmService: the renderer-side SCM model fed by the host's
 *  mainThreadScm channel, plus commit-box edits flowing back to the host.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { IExtHostScm } from '@universe-editor/extensions-common'
import {
  ScmService,
  encodeScmProviderIds,
  resolveScmProviderId,
  resolveScmProviderIds,
  type IScmSourceControlModel,
} from '../ScmService.js'

function make(): { scm: ScmService; extHost: IExtHostScm; onChange: ReturnType<typeof vi.fn> } {
  const scm = new ScmService()
  const onChange = vi.fn().mockResolvedValue(undefined)
  const extHost: IExtHostScm = { $onInputBoxValueChange: onChange }
  scm.setExtHost(extHost)
  return { scm, extHost, onChange }
}

describe('ScmService', () => {
  it('exposes a registered source control with its groups and resources', async () => {
    const { scm } = make()
    await scm.$registerSourceControl(0, 'git', 'Git', '/repo')
    await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    await scm.$updateGroupResourceStates(1, [
      { resourceUri: '/repo/a.ts', contextValue: 'M' },
      { resourceUri: '/repo/b.ts', contextValue: 'U' },
    ])
    await scm.$updateSourceControl(0, { count: 2 })

    const controls = scm.sourceControls.get()
    expect(controls).toHaveLength(1)
    const sc = controls[0]!
    expect(sc.id).toBe('git')
    expect(sc.label).toBe('Git')
    expect(sc.rootUri).toBe('/repo')
    expect(sc.count.get()).toBe(2)

    const groups = sc.groups.get()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label.get()).toBe('Changes')
    expect(groups[0]!.resources.get().map((r) => r.resourceUri)).toEqual([
      '/repo/a.ts',
      '/repo/b.ts',
    ])
  })

  it('mirrors the host input-box value and reports user edits back to the host', async () => {
    const { scm, onChange } = make()
    await scm.$registerSourceControl(0, 'git', 'Git')

    await scm.$setInputBoxValue(0, 'from host')
    expect(scm.sourceControls.get()[0]!.inputValue.get()).toBe('from host')

    scm.changeInputBoxValue(0, 'typed by user')
    expect(scm.sourceControls.get()[0]!.inputValue.get()).toBe('typed by user')
    expect(onChange).toHaveBeenCalledWith(0, 'typed by user')
  })

  it('clears commit split-button actions when the host sends an empty array', async () => {
    // Regression: after a commit, git flips acceptInputActions from the commit
    // split-button set back to "no actions" (a single Push button). The host
    // reports the cleared state as an empty array; the renderer must apply it so
    // the split button collapses instead of keeping the stale Commit actions.
    const { scm } = make()
    await scm.$registerSourceControl(0, 'git', 'Git', '/repo')

    await scm.$updateSourceControl(0, {
      acceptInputCommand: { command: 'git.commit', title: 'Commit' },
      acceptInputActions: [
        { command: 'git.commit', title: 'Commit' },
        { command: 'git.commitAndPush', title: 'Commit & Push' },
      ],
    })
    expect(scm.sourceControls.get()[0]!.acceptActions.get()).toHaveLength(2)

    await scm.$updateSourceControl(0, {
      acceptInputCommand: { command: 'git.push', title: 'Push' },
      acceptInputActions: [],
    })
    expect(scm.sourceControls.get()[0]!.acceptActions.get()).toEqual([])
    expect(scm.sourceControls.get()[0]!.acceptCommand.get()?.command).toBe('git.push')
  })

  it('removes groups and source controls on unregister', async () => {
    const { scm } = make()
    await scm.$registerSourceControl(0, 'git', 'Git')
    await scm.$registerGroup(0, 1, 'index', 'Staged')
    expect(scm.sourceControls.get()[0]!.groups.get()).toHaveLength(1)

    await scm.$unregisterGroup(1)
    expect(scm.sourceControls.get()[0]!.groups.get()).toHaveLength(0)

    await scm.$unregisterSourceControl(0)
    expect(scm.sourceControls.get()).toHaveLength(0)
  })
})

describe('ScmService working-tree scan', () => {
  it('fires the scan event with the owning provider id, and never for zero entries', async () => {
    const { scm } = make()
    const seen: unknown[] = []
    scm.onDidPublishWorkingTreeScan((results) => {
      seen.push(results)
    })
    await scm.$registerSourceControl(0, 'perforce', 'Perforce', '/depot')

    await scm.$publishWorkingTreeScan(0, [
      {
        directory: '/depot/src',
        hints: [{ path: '/depot/src/a.ts', letter: 'RC', color: '#e2c08d' }],
      },
    ])
    expect(seen).toEqual([
      [
        {
          sourceControlId: 'perforce',
          directory: '/depot/src',
          hints: [{ path: '/depot/src/a.ts', letter: 'RC', color: '#e2c08d' }],
        },
      ],
    ])

    // An empty batch is a no-op (host guards it too — double safety).
    await scm.$publishWorkingTreeScan(0, [])
    expect(seen).toHaveLength(1)
  })

  it('silently ignores a scan for an unknown handle', async () => {
    const { scm } = make()
    const seen = vi.fn()
    scm.onDidPublishWorkingTreeScan(seen)
    await scm.$registerSourceControl(0, 'git', 'Git')

    await scm.$publishWorkingTreeScan(99, [
      { directory: '/repo', hints: [{ path: '/repo/x.ts', letter: 'M', color: '#e2c08d' }] },
    ])
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('ScmService supplementary decorations', () => {
  it('applies add / change / remove deltas to the per-provider map', async () => {
    const { scm } = make()
    await scm.$registerSourceControl(0, 'perforce', 'Perforce')
    const sc = scm.sourceControls.get()[0]!

    await scm.$updateSupplementaryDecorations(0, [
      { resourceUri: 'D:/ws/a.ts', description: '可更新', tooltip: '#4 → #7' },
      { resourceUri: 'D:/ws/b.ts', description: '他人占用' },
    ])
    expect(sc.supplementary.get().get('D:/ws/a.ts')).toEqual({
      resourceUri: 'D:/ws/a.ts',
      description: '可更新',
      tooltip: '#4 → #7',
    })
    expect(sc.supplementary.get().get('D:/ws/b.ts')?.tooltip).toBeUndefined()

    // A later delta changes one entry and removes the other.
    await scm.$updateSupplementaryDecorations(0, [
      { resourceUri: 'D:/ws/a.ts', description: '可更新', tooltip: '#4 → #9' },
      { resourceUri: 'D:/ws/b.ts', description: null },
    ])
    expect(sc.supplementary.get().get('D:/ws/a.ts')?.tooltip).toBe('#4 → #9')
    expect(sc.supplementary.get().has('D:/ws/b.ts')).toBe(false)
  })

  it('keeps each provider’s decorations separate', async () => {
    const { scm } = make()
    await scm.$registerSourceControl(0, 'perforce', 'Perforce')
    await scm.$registerSourceControl(1, 'git', 'Git')
    await scm.$updateSupplementaryDecorations(0, [
      { resourceUri: 'D:/ws/a.ts', description: '可更新' },
    ])

    const [p4, git] = scm.sourceControls.get()
    expect(p4!.supplementary.get().size).toBe(1)
    expect(git!.supplementary.get().size).toBe(0)
  })

  it('ignores a delta for an unknown handle', async () => {
    const { scm } = make()
    await expect(
      scm.$updateSupplementaryDecorations(42, [{ resourceUri: 'D:/x.ts', description: 'x' }]),
    ).resolves.toBeUndefined()
  })
})

describe('resolveScmProviderId(s)', () => {
  const model = (id: string, rootUri: string): IScmSourceControlModel =>
    ({ id, rootUri }) as unknown as IScmSourceControlModel

  it('resolveScmProviderId picks the single most-specific owner', () => {
    const controls = [model('perforce', '/depot/client'), model('git', '/depot/client/app')]
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts')).toBe('git')
    expect(resolveScmProviderId(controls, '/depot/client/other/x.ts')).toBe('perforce')
    expect(resolveScmProviderId(controls, '/elsewhere/x.ts')).toBeUndefined()
  })

  it('selectedRootUri wins over the longest prefix among the owners', () => {
    const controls = [model('perforce', '/depot/client'), model('git', '/depot/client/app')]
    // Both own the file; the SCM view has the outer p4 workspace selected.
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts', '/depot/client')).toBe(
      'perforce',
    )
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts', '/depot/client/app')).toBe(
      'git',
    )
  })

  it('falls back to the longest prefix when the selection owns nothing here', () => {
    const controls = [
      model('perforce', '/depot/client'),
      model('git', '/depot/client/app'),
      model('git', '/other/Repo'),
    ]
    // Selected repo does not contain the file → heuristic unchanged.
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts', '/other/Repo')).toBe('git')
    // Selected repo not registered at all (stale persisted value) → heuristic unchanged.
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts', '/gone/Repo')).toBe('git')
  })

  it('single ownership ignores the selection even when it points elsewhere', () => {
    const controls = [model('perforce', '/depot/client'), model('git', '/other/Repo')]
    expect(resolveScmProviderId(controls, '/depot/client/x.ts', '/other/Repo')).toBe('perforce')
  })

  it('selection disambiguates two providers sharing the same root', () => {
    const controls = [model('perforce', '/ws'), model('git', '/ws')]
    expect(resolveScmProviderId(controls, '/ws/x.ts', '/ws')).toBe('perforce')
  })

  it('selectedRootUri comparison is separator- and case-insensitive', () => {
    const controls = [model('perforce', '/depot/client'), model('git', '/depot/client/app')]
    // Persisted rootUri with backslashes, trailing slash and different casing still matches.
    expect(resolveScmProviderId(controls, '/depot/client/app/main.ts', '\\DEPOT\\CLIENT\\')).toBe(
      'perforce',
    )
  })

  it('resolveScmProviderIds returns every owner (nested git inside a p4 workspace)', () => {
    const controls = [model('perforce', '/depot/client'), model('git', '/depot/client/app')]
    // The reported bug: a file under the nested git repo is owned by BOTH.
    expect(resolveScmProviderIds(controls, '/depot/client/app/main.ts')).toEqual([
      'perforce',
      'git',
    ])
    // A file outside the git repo is owned by perforce only.
    expect(resolveScmProviderIds(controls, '/depot/client/other/x.ts')).toEqual(['perforce'])
    expect(resolveScmProviderIds(controls, '/elsewhere/x.ts')).toEqual([])
  })

  it('encodeScmProviderIds pipe-delimits for when-clause membership matching', () => {
    expect(encodeScmProviderIds(['perforce', 'git'])).toBe('|perforce|git|')
    expect(encodeScmProviderIds([])).toBe('')
    // The encoded value must match a per-provider membership regex.
    expect(/\|perforce\|/.test(encodeScmProviderIds(['perforce', 'git']))).toBe(true)
    expect(/\|git\|/.test(encodeScmProviderIds(['perforce', 'git']))).toBe(true)
    expect(/\|perforce\|/.test(encodeScmProviderIds(['git']))).toBe(false)
  })
})
