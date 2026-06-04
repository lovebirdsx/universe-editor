/*---------------------------------------------------------------------------------------------
 *  Tests for ScmService: the renderer-side SCM model fed by the host's
 *  mainThreadScm channel, plus commit-box edits flowing back to the host.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { IExtHostScm } from '@universe-editor/extensions-common'
import { ScmService } from '../ScmService.js'

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
