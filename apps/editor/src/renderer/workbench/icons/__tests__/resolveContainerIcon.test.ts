import { describe, expect, it } from 'vitest'
import type {
  IViewContainerDescriptor,
  IViewDescriptor,
  IViewDescriptorService,
} from '@universe-editor/platform'
import { resolveContainerIconName } from '../resolveContainerIcon.js'

function view(containerId: string, icon?: string): IViewDescriptor {
  return {
    id: `${containerId}.${icon ?? 'none'}`,
    name: '',
    containerId,
    componentKey: 'test',
    order: 0,
    ...(icon === undefined ? {} : { icon }),
  }
}

function fakeService(views: readonly IViewDescriptor[]): IViewDescriptorService {
  return { getViewsByContainer: () => views } as unknown as IViewDescriptorService
}

const container = { id: 'c1', icon: 'window' } as IViewContainerDescriptor

describe('resolveContainerIconName', () => {
  it('uses the container icon for an empty container', () => {
    expect(resolveContainerIconName(container, fakeService([]))).toBe('window')
  })

  it('ignores a native view icon while the container holds its own views', () => {
    expect(resolveContainerIconName(container, fakeService([view('c1', 'search')]))).toBe('window')
  })

  it('ignores the first view icon when native and moved-in views are mixed', () => {
    const views = [view('other', 'search'), view('c1')]
    expect(resolveContainerIconName(container, fakeService(views))).toBe('window')
  })

  it('borrows the first view icon only when every view was moved in', () => {
    const views = [view('other', 'search'), view('elsewhere', 'files')]
    expect(resolveContainerIconName(container, fakeService(views))).toBe('search')
  })

  it('falls back to the container icon when the moved-in view has no icon', () => {
    expect(resolveContainerIconName(container, fakeService([view('other')]))).toBe('window')
  })
})
