/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadWindow: bridging the host's window.* RPC to the editor's
 *  notification / quick-input / status-bar services.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Severity,
  StatusBarAlignment,
  type INotificationService,
  type IQuickInputService,
  type IStatusBarService,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { MainThreadWindow } from '../MainThreadWindow.js'

function fakeNotification(): {
  service: INotificationService
  notify: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
} {
  const notify = vi.fn()
  // Simulate the user clicking the first choice.
  const prompt = vi.fn((_sev, _msg, choices: { run: () => void }[]) => {
    choices[0]?.run()
    return Promise.resolve()
  })
  return { service: { notify, prompt } as unknown as INotificationService, notify, prompt }
}

function fakeStatusBar(): {
  service: IStatusBarService
  entries: Map<number, IStatusBarEntry>
  disposed: number[]
} {
  const entries = new Map<number, IStatusBarEntry>()
  const disposed: number[] = []
  let nextId = 0
  const service = {
    addEntry(entry: IStatusBarEntry): IStatusBarEntryAccessor {
      const id = nextId++
      entries.set(id, entry)
      return {
        update: (e: IStatusBarEntry) => entries.set(id, e),
        dispose: () => {
          entries.delete(id)
          disposed.push(id)
        },
      }
    },
  } as unknown as IStatusBarService
  return { service, entries, disposed }
}

describe('MainThreadWindow', () => {
  it('shows a plain notification and resolves undefined when no items', async () => {
    const notif = fakeNotification()
    const mt = new MainThreadWindow(
      notif.service,
      {} as IQuickInputService,
      {} as IStatusBarService,
    )
    await expect(mt.$showMessage('warning', 'heads up', [])).resolves.toBeUndefined()
    expect(notif.notify).toHaveBeenCalledWith({ severity: Severity.Warning, message: 'heads up' })
  })

  it('resolves to the picked item label when items are provided', async () => {
    const notif = fakeNotification()
    const mt = new MainThreadWindow(
      notif.service,
      {} as IQuickInputService,
      {} as IStatusBarService,
    )
    await expect(mt.$showMessage('error', 'pick one', ['Yes', 'No'])).resolves.toBe('Yes')
  })

  it('maps quick pick selection back to its label', async () => {
    const pick = vi.fn().mockResolvedValue({ id: '1', label: 'second' })
    const quick = { pick } as unknown as IQuickInputService
    const mt = new MainThreadWindow({} as INotificationService, quick, {} as IStatusBarService)
    await expect(mt.$showQuickPick(['first', 'second'], { placeHolder: 'choose' })).resolves.toBe(
      'second',
    )
    expect(pick).toHaveBeenCalledWith(
      [
        { id: '0', label: 'first' },
        { id: '1', label: 'second' },
      ],
      { placeholder: 'choose' },
    )
  })

  it('parses a $(icon) prefix and tracks the status-bar entry by handle', async () => {
    const sb = fakeStatusBar()
    const mt = new MainThreadWindow(
      {} as INotificationService,
      {} as IQuickInputService,
      sb.service,
    )

    await mt.$setStatusBarEntry(7, {
      text: '$(git-branch) main',
      alignment: 1,
      priority: 100,
      command: 'git.checkout',
    })
    const [entry] = [...sb.entries.values()]
    expect(entry?.icon).toBe('git-branch')
    expect(entry?.text).toBe('main')
    expect(entry?.alignment).toBe(StatusBarAlignment.Right)
    expect(entry?.command).toBe('git.checkout')

    // Update in place, then dispose.
    await mt.$setStatusBarEntry(7, { text: 'dev', alignment: 0, priority: 100 })
    expect([...sb.entries.values()][0]?.text).toBe('dev')

    await mt.$disposeStatusBarEntry(7)
    expect(sb.entries.size).toBe(0)
  })
})
