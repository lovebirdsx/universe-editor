import { describe, expect, it } from 'vitest'
import { ViewContainerLocation, type IViewDescriptorService } from '@universe-editor/platform'
import { applyViewDrop } from '../applyViewDrop.js'

type Call = [method: string, ...args: unknown[]]

function makeFake(
  locations: Record<string, ViewContainerLocation>,
  viewsByContainer: Record<string, readonly string[]> = {},
): {
  service: IViewDescriptorService
  calls: Call[]
} {
  const calls: Call[] = []
  const service = {
    getViewContainerLocation: (id: string) => locations[id],
    getViewsByContainer: (id: string) => (viewsByContainer[id] ?? []).map((vid) => ({ id: vid })),
    moveContainerInLocation: (id: string, target: string) =>
      calls.push(['moveContainerInLocation', id, target]),
    moveViewContainerToLocation: (id: string, loc: ViewContainerLocation) =>
      calls.push(['moveViewContainerToLocation', id, loc]),
    moveViewsToContainer: (ids: readonly string[], target: string) =>
      calls.push(['moveViewsToContainer', ids, target]),
    moveViewToLocation: (id: string, loc: ViewContainerLocation) =>
      calls.push(['moveViewToLocation', id, loc]),
  } as unknown as IViewDescriptorService
  return { service, calls }
}

describe('applyViewDrop', () => {
  it('reorders a container dropped onto another in the same location', () => {
    const { service, calls } = makeFake({
      a: ViewContainerLocation.SideBar,
      b: ViewContainerLocation.SideBar,
    })
    applyViewDrop(service, { kind: 'container', id: 'a' }, { kind: 'container', containerId: 'b' })
    expect(calls).toEqual([['moveContainerInLocation', 'a', 'b']])
  })

  it('moves a container to the target location when dropped onto a container elsewhere', () => {
    const { service, calls } = makeFake({
      a: ViewContainerLocation.SideBar,
      b: ViewContainerLocation.Panel,
    })
    applyViewDrop(service, { kind: 'container', id: 'a' }, { kind: 'container', containerId: 'b' })
    expect(calls).toEqual([['moveViewContainerToLocation', 'a', ViewContainerLocation.Panel]])
  })

  it('moves a container to a bare location drop target', () => {
    const { service, calls } = makeFake({ a: ViewContainerLocation.SideBar })
    applyViewDrop(
      service,
      { kind: 'container', id: 'a' },
      { kind: 'location', location: ViewContainerLocation.SecondarySideBar },
    )
    expect(calls).toEqual([
      ['moveViewContainerToLocation', 'a', ViewContainerLocation.SecondarySideBar],
    ])
  })

  it('ignores a container dropped onto itself', () => {
    const { service, calls } = makeFake({ a: ViewContainerLocation.SideBar })
    applyViewDrop(service, { kind: 'container', id: 'a' }, { kind: 'container', containerId: 'a' })
    expect(calls).toEqual([])
  })

  it('merges every view of the source container into the target on a centre drop', () => {
    const { service, calls } = makeFake(
      { a: ViewContainerLocation.SideBar, b: ViewContainerLocation.Panel },
      { a: ['v1', 'v2'] },
    )
    applyViewDrop(
      service,
      { kind: 'container', id: 'a' },
      { kind: 'container', containerId: 'b', merge: true },
    )
    expect(calls).toEqual([['moveViewsToContainer', ['v1', 'v2'], 'b']])
  })

  it('does nothing when merging an empty source container', () => {
    const { service, calls } = makeFake(
      { a: ViewContainerLocation.SideBar, b: ViewContainerLocation.SideBar },
      { a: [] },
    )
    applyViewDrop(
      service,
      { kind: 'container', id: 'a' },
      { kind: 'container', containerId: 'b', merge: true },
    )
    expect(calls).toEqual([])
  })

  it('moves a view into an existing container', () => {
    const { service, calls } = makeFake({})
    applyViewDrop(service, { kind: 'view', id: 'v1' }, { kind: 'container', containerId: 'c1' })
    expect(calls).toEqual([['moveViewsToContainer', ['v1'], 'c1']])
  })

  it('moves a view to a bare location, generating a new container', () => {
    const { service, calls } = makeFake({})
    applyViewDrop(
      service,
      { kind: 'view', id: 'v1' },
      { kind: 'location', location: ViewContainerLocation.Panel },
    )
    expect(calls).toEqual([['moveViewToLocation', 'v1', ViewContainerLocation.Panel]])
  })
})
