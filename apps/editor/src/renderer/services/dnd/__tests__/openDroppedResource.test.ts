import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { openDroppedResource } from '../openDroppedResource.js'

function makeDeps(isDirectory: boolean | Error) {
  const stat = vi.fn(async () => {
    if (isDirectory instanceof Error) throw isDirectory
    return { isDirectory } as Awaited<
      ReturnType<import('@universe-editor/platform').IFileService['stat']>
    >
  })
  const openWindow = vi.fn(async () => {})
  const openEditor = vi.fn(async () => undefined)
  return {
    deps: {
      fileService: { stat },
      windowsService: { openWindow },
      editorResolverService: { openEditor },
    },
    stat,
    openWindow,
    openEditor,
  }
}

describe('openDroppedResource', () => {
  it('opens a folder in a new window, not as an editor', async () => {
    const folder = URI.file('/ws/sub')
    const { deps, openWindow, openEditor } = makeDeps(true)
    await openDroppedResource(folder, deps)
    expect(openWindow).toHaveBeenCalledWith(folder)
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('opens a file as an editor, not a new window', async () => {
    const file = URI.file('/ws/a.ts')
    const { deps, openWindow, openEditor } = makeDeps(false)
    await openDroppedResource(file, deps)
    expect(openEditor).toHaveBeenCalledWith(file)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('treats an un-stattable URI as a file', async () => {
    const weird = URI.parse('untitled:foo')
    const { deps, openWindow, openEditor } = makeDeps(new Error('ENOENT'))
    await openDroppedResource(weird, deps)
    expect(openEditor).toHaveBeenCalledWith(weird)
    expect(openWindow).not.toHaveBeenCalled()
  })
})
