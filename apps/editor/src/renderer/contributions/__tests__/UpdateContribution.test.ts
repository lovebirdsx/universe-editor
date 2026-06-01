import { describe, it, expect } from 'vitest'
import { entryForState } from '../UpdateContribution.js'
import { DownloadUpdateAction, InstallUpdateAction } from '../../actions/updateActions.js'
import type { UpdateState } from '../../../shared/ipc/updateService.js'

const base = { currentVersion: '0.1.0' } satisfies Pick<UpdateState, 'currentVersion'>

describe('entryForState', () => {
  it('hides the entry for idle / not-available / error', () => {
    expect(entryForState({ status: 'idle', ...base })).toBeUndefined()
    expect(entryForState({ status: 'not-available', ...base })).toBeUndefined()
    expect(entryForState({ status: 'error', ...base, error: 'boom' })).toBeUndefined()
  })

  it('available → download command, prominent', () => {
    const entry = entryForState({ status: 'available', ...base, version: '0.2.0' })
    expect(entry?.command).toBe(DownloadUpdateAction.ID)
    expect(entry?.kind).toBe('prominent')
  })

  it('downloading → spinner showing percent', () => {
    const entry = entryForState({ status: 'downloading', ...base, version: '0.2.0', percent: 42 })
    expect(entry?.showProgress).toBe('spinning')
    expect(entry?.text).toContain('42')
  })

  it('downloaded → install command, prominent', () => {
    const entry = entryForState({ status: 'downloaded', ...base, version: '0.2.0' })
    expect(entry?.command).toBe(InstallUpdateAction.ID)
    expect(entry?.kind).toBe('prominent')
  })

  it('checking → spinner', () => {
    const entry = entryForState({ status: 'checking', ...base })
    expect(entry?.showProgress).toBe('spinning')
  })
})
