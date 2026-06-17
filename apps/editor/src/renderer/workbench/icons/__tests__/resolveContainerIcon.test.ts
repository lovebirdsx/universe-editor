import { describe, expect, it } from 'vitest'
import type {
  IViewContainerDescriptor,
  IViewDescriptor,
  IViewDescriptorService,
} from '@universe-editor/platform'
import { resolveContainerIconName } from '../resolveContainerIcon.js'

function fakeService(views: readonly Partial<IViewDescriptor>[]): IViewDescriptorService {
  return {
    getViewsByContainer: () => views as readonly IViewDescriptor[],
  } as unknown as IViewDescriptorService
}

const container = { id: 'c1', icon: 'window' } as IViewContainerDescriptor

describe('resolveContainerIconName', () => {
  it('uses the first view icon when present', () => {
    const svc = fakeService([{ icon: 'search' }, { icon: 'files' }])
    expect(resolveContainerIconName(container, svc)).toBe('search')
  })

  it('falls back to the container icon for an empty container', () => {
    expect(resolveContainerIconName(container, fakeService([]))).toBe('window')
  })

  it('falls back to the container icon when the first view has no icon', () => {
    expect(resolveContainerIconName(container, fakeService([{}]))).toBe('window')
  })
})
