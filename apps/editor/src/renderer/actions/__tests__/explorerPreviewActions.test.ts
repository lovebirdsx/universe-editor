/*---------------------------------------------------------------------------------------------
 *  Tests for the Explorer row's "Open Preview" action — the right-click twin of
 *  the hover eye button. The menu only offers it for previewable files, but the
 *  action also runs from a keybinding-free command invocation, so it has to
 *  route the right resource into the active group on its own. The two shapes the
 *  Explorer passes through here are worth pinning: URIs are revived from their
 *  IPC form, and args[1] is the multi-selection array rather than an options
 *  bag — treating it as options would silently preview the wrong file.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI, runWithInvocationModifiers, type ServicesAccessor } from '@universe-editor/platform'
import { openResourcePreview } from '../../services/resourcePreview/openResourcePreview.js'
import { ExplorerOpenPreviewAction } from '../explorerPreviewActions.js'

vi.mock('../../services/resourcePreview/openResourcePreview.js', () => ({
  openResourcePreview: vi.fn(() => true),
}))

function makeAccessor(): { accessor: ServicesAccessor } {
  return { accessor: {} as ServicesAccessor }
}

type PreviewCall = [ServicesAccessor, URI, string]
const call = (i = 0): PreviewCall =>
  vi.mocked(openResourcePreview).mock.calls[i] as unknown as PreviewCall

/** The first arg ExplorerContextMenu builds: a `URI`, before it crosses IPC. */
const explorerArg = (resource: URI): unknown => ({
  target: resource,
  resource,
  parent: URI.file('/ws'),
  isDirectory: false,
})

const md = (): URI => URI.file('/ws/README.md')

beforeEach(() => {
  vi.mocked(openResourcePreview).mockClear()
})

describe('ExplorerOpenPreviewAction', () => {
  it('opens the clicked resource preview at the default target', () => {
    const { accessor } = makeAccessor()

    new ExplorerOpenPreviewAction().run(accessor, explorerArg(md()))

    expect(openResourcePreview).toHaveBeenCalledTimes(1)
    const [passed, uri, target] = call()
    expect(passed).toBe(accessor)
    expect(uri.path).toBe('/ws/README.md')
    expect(target).toBe('default')
  })

  it('honours the Ctrl/Alt of the menu click that ran it', () => {
    const { accessor } = makeAccessor()
    const action = new ExplorerOpenPreviewAction()

    runWithInvocationModifiers({ ctrlKey: true }, () => action.run(accessor, explorerArg(md())))
    runWithInvocationModifiers({ altKey: true }, () => action.run(accessor, explorerArg(md())))

    expect(call(0)[2]).toBe('side')
    expect(call(1)[2]).toBe('newWindow')
  })

  // Explorer args come back from the command service as UriComponents, not URIs.
  it('revives the IPC form of the resource', () => {
    const { accessor } = makeAccessor()

    new ExplorerOpenPreviewAction().run(accessor, explorerArg(md().toJSON() as unknown as URI))

    expect(openResourcePreview).toHaveBeenCalledTimes(1)
    const [, uri] = call()
    expect(uri).toBeInstanceOf(URI)
    expect(uri.path).toBe('/ws/README.md')
    expect(uri.toString()).toBe('file:///ws/README.md')
  })

  it('ignores invocations that carry no resource', () => {
    const { accessor } = makeAccessor()
    const action = new ExplorerOpenPreviewAction()

    action.run(accessor)
    action.run(accessor, undefined)
    action.run(accessor, {})
    action.run(accessor, [])
    action.run(accessor, 'README.md')

    expect(openResourcePreview).not.toHaveBeenCalled()
  })

  // args[1] is the Explorer selection; only the primary is previewed.
  it('previews the primary resource and ignores the selection array', () => {
    const { accessor } = makeAccessor()
    const primary = md()
    const other = URI.file('/ws/other.md')

    new ExplorerOpenPreviewAction().run(accessor, explorerArg(primary), [
      { resource: primary },
      { resource: other },
    ])

    expect(openResourcePreview).toHaveBeenCalledTimes(1)
    const [, uri] = call()
    expect(uri.path).toBe('/ws/README.md')
  })
})
