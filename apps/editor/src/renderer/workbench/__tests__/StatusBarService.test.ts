import { describe, it, expect, vi } from 'vitest'
import { autorun, StatusBarAlignment } from '@universe-editor/platform'
import { StatusBarService } from '../statusbar/StatusBarService.js'

describe('StatusBarService', () => {
  it('addEntry appends and returns a disposable that removes it', () => {
    const svc = new StatusBarService()
    const a = svc.addEntry({ text: 'a', alignment: StatusBarAlignment.Left, priority: 0 })
    svc.addEntry({ text: 'b', alignment: StatusBarAlignment.Right, priority: 0 })

    expect(svc.entries.get().map((e) => e.entry.text)).toEqual(['a', 'b'])

    a.dispose()
    expect(svc.entries.get().map((e) => e.entry.text)).toEqual(['b'])
  })

  it('disposing the same entry twice is a no-op', () => {
    const svc = new StatusBarService()
    const d = svc.addEntry({ text: 'x', alignment: StatusBarAlignment.Left, priority: 0 })
    d.dispose()
    d.dispose()
    expect(svc.entries.get()).toEqual([])
  })

  it('addEntry triggers exactly one reaction', () => {
    const svc = new StatusBarService()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.entries.read(r)
      spy()
    })
    spy.mockClear()

    svc.addEntry({ text: 'a', alignment: StatusBarAlignment.Left, priority: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
    d.dispose()
  })
})
