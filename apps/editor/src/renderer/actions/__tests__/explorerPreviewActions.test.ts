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
import { IEditorGroupsService, URI, type ServicesAccessor } from '@universe-editor/platform'
import { openResourcePreviewInGroup } from '../../services/resourcePreview/openResourcePreview.js'
import { ExplorerOpenPreviewAction } from '../explorerPreviewActions.js'

vi.mock('../../services/resourcePreview/openResourcePreview.js', () => ({
  openResourcePreviewInGroup: vi.fn(() => true),
}))

function makeAccessor(): { accessor: ServicesAccessor; activeGroup: object } {
  const activeGroup = { id: 'group' }
  const byId = new Map<unknown, unknown>([
    [IEditorGroupsService, { _serviceBrand: undefined, activeGroup }],
  ])
  const accessor = {
    get: (id: unknown) => {
      const service = byId.get(id)
      if (service === undefined) throw new Error('unexpected service lookup')
      return service
    },
  } as unknown as ServicesAccessor
  return { accessor, activeGroup }
}

/** The first arg ExplorerContextMenu builds: a `URI`, before it crosses IPC. */
const explorerArg = (resource: URI): unknown => ({
  target: resource,
  resource,
  parent: URI.file('/ws'),
  isDirectory: false,
})

const md = (): URI => URI.file('/ws/README.md')

beforeEach(() => {
  vi.mocked(openResourcePreviewInGroup).mockClear()
})

describe('ExplorerOpenPreviewAction', () => {
  it('opens the clicked resource preview in the active editor group', () => {
    const { accessor, activeGroup } = makeAccessor()

    new ExplorerOpenPreviewAction().run(accessor, explorerArg(md()))

    expect(openResourcePreviewInGroup).toHaveBeenCalledTimes(1)
    const [groups, group, uri] = vi.mocked(openResourcePreviewInGroup).mock.calls[0] as [
      { activeGroup: object },
      object,
      URI,
    ]
    expect(groups.activeGroup).toBe(activeGroup)
    expect(group).toBe(activeGroup)
    expect(uri.path).toBe('/ws/README.md')
  })

  // Explorer args come back from the command service as UriComponents, not URIs.
  it('revives the IPC form of the resource', () => {
    const { accessor } = makeAccessor()

    new ExplorerOpenPreviewAction().run(accessor, explorerArg(md().toJSON() as unknown as URI))

    expect(openResourcePreviewInGroup).toHaveBeenCalledTimes(1)
    const [, , uri] = vi.mocked(openResourcePreviewInGroup).mock.calls[0] as [unknown, unknown, URI]
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

    expect(openResourcePreviewInGroup).not.toHaveBeenCalled()
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

    expect(openResourcePreviewInGroup).toHaveBeenCalledTimes(1)
    const [, , uri] = vi.mocked(openResourcePreviewInGroup).mock.calls[0] as [unknown, unknown, URI]
    expect(uri.path).toBe('/ws/README.md')
  })
})
