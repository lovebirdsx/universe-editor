import { describe, expect, it, vi } from 'vitest'
import { Severity, URI } from '@universe-editor/platform'
import { openDroppedResource } from '../openDroppedResource.js'

function makeDeps(isDirectory: boolean | Error, openError?: Error) {
  const stat = vi.fn(async () => {
    if (isDirectory instanceof Error) throw isDirectory
    return { isDirectory } as Awaited<
      ReturnType<import('@universe-editor/platform').IFileService['stat']>
    >
  })
  const openWindow = vi.fn(async () => {
    if (openError) throw openError
  })
  const openEditor = vi.fn(async () => {
    if (openError) throw openError
    return undefined
  })
  const activateGroup = vi.fn(() => targetGroup)
  const targetGroup = { id: 7 } as import('@universe-editor/platform').IEditorGroup
  const notify = vi.fn(
    (_opts: Parameters<import('@universe-editor/platform').INotificationService['notify']>[0]) =>
      ({}) as ReturnType<import('@universe-editor/platform').INotificationService['notify']>,
  )
  return {
    deps: {
      fileService: { stat },
      windowsService: { openWindow },
      editorResolverService: { openEditor },
      notificationService: { notify },
    },
    stat,
    openWindow,
    openEditor,
    activateGroup,
    targetGroup,
    notify,
  }
}

describe('openDroppedResource', () => {
  it('opens a folder in a new window, not as an editor', async () => {
    const folder = URI.file('/ws/sub')
    const { deps, openWindow, openEditor } = makeDeps(true)
    expect(await openDroppedResource(folder, deps)).toBe(true)
    expect(openWindow).toHaveBeenCalledWith(folder)
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('opens a file as an editor, not a new window', async () => {
    const file = URI.file('/ws/a.ts')
    const { deps, openWindow, openEditor } = makeDeps(false)
    expect(await openDroppedResource(file, deps)).toBe(true)
    expect(openEditor).toHaveBeenCalledWith(file)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('treats an un-stattable URI as a file', async () => {
    const weird = URI.parse('untitled:foo')
    const { deps, openWindow, openEditor } = makeDeps(new Error('ENOENT'))
    expect(await openDroppedResource(weird, deps)).toBe(true)
    expect(openEditor).toHaveBeenCalledWith(weird)
    expect(openWindow).not.toHaveBeenCalled()
  })

  // Repro: dropping a file onto a NON-active group must open it there, not in the
  // active group. openEditor always targets the active group (and dedupes
  // "already open" against it), so the drop must activate its target group first.
  it('activates the drop-target group before opening a file', async () => {
    const file = URI.file('/ws/a.ts')
    const { deps, activateGroup, targetGroup, openEditor } = makeDeps(false)
    await openDroppedResource(file, {
      ...deps,
      groupsService: { activateGroup },
      targetGroup,
    })
    expect(activateGroup).toHaveBeenCalledWith(targetGroup)
    // Activation must happen before the open so openEditor's active-group dedup
    // is scoped to the drop target.
    expect(activateGroup.mock.invocationCallOrder[0]!).toBeLessThan(
      openEditor.mock.invocationCallOrder[0]!,
    )
  })

  it('does not activate a group when dropping a folder (opens a new window)', async () => {
    const folder = URI.file('/ws/sub')
    const { deps, activateGroup, targetGroup, openWindow } = makeDeps(true)
    await openDroppedResource(folder, {
      ...deps,
      groupsService: { activateGroup },
      targetGroup,
    })
    expect(openWindow).toHaveBeenCalledWith(folder)
    expect(activateGroup).not.toHaveBeenCalled()
  })

  it('notifies and returns false when opening a file fails', async () => {
    const file = URI.file('/ws/a.ts')
    const { deps, notify } = makeDeps(false, new Error('boom'))
    expect(await openDroppedResource(file, deps)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0]![0]
    expect(arg.severity).toBe(Severity.Error)
    expect(arg.message).toContain('a.ts')
  })

  it('explains a missing/inaccessible file (stat failed then open failed)', async () => {
    const file = URI.file('/ws/gone.ts')
    // stat throws (missing) AND the subsequent open throws — the message should
    // point at the "moved/deleted/inaccessible" cause.
    const { deps, notify } = makeDeps(new Error('ENOENT'), new Error('cannot read'))
    expect(await openDroppedResource(file, deps)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0].message).toMatch(/moved, deleted, or is not accessible/)
  })

  it('notifies and returns false when opening a folder in a new window fails', async () => {
    const folder = URI.file('/ws/sub')
    const { deps, notify } = makeDeps(true, new Error('no window'))
    expect(await openDroppedResource(folder, deps)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0].message).toContain('sub')
  })
})
