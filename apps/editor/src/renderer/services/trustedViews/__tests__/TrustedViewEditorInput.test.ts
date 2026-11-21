import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { ITrustedViewContribution } from '@universe-editor/extensions-common'
import { TrustedViewEditorInput } from '../../editor/TrustedViewEditorInput.js'

const contribution: ITrustedViewContribution = {
  id: 'acme.status',
  name: 'Editor Service',
  location: 'editor',
  entry: './dist/renderer/status.js',
}

describe('TrustedViewEditorInput', () => {
  it('derives identity from extension + view + key', () => {
    const a = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: 'acme.status',
      key: 'main',
    })
    const b = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: 'acme.status',
      key: 'main',
    })
    const c = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: 'acme.status',
      key: 'other',
    })
    expect(a.id).toBe(b.id)
    expect(a.id).not.toBe(c.id)
    expect(a.getName()).toBe('acme.status')
  })

  it('round-trips state, title and key', () => {
    const input = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: contribution.id,
      key: 'k1',
      state: { job: 7 },
    })
    const revived = TrustedViewEditorInput.deserialize(input.serialize())
    expect(revived?.id).toBe(input.id)
    expect(revived?.state).toEqual({ job: 7 })
  })

  it('rejects malformed persisted data', () => {
    expect(TrustedViewEditorInput.deserialize(null)).toBeNull()
    expect(TrustedViewEditorInput.deserialize({})).toBeNull()
    expect(TrustedViewEditorInput.deserialize({ viewId: 'x', key: 'k' })).toBeNull()
  })

  it('updates the label through setTitle / setContributionName and fires once', () => {
    const input = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: contribution.id,
      key: 'k1',
    })
    const labels: string[] = []
    input.onDidChangeLabel(() => labels.push(input.getName()))
    input.setContributionName(contribution.name)
    expect(input.getName()).toBe(contribution.name)
    input.setTitle('Server')
    expect(input.getName()).toBe('Server')
    input.setTitle('Server')
    expect(labels).toEqual([contribution.name, 'Server'])
    expect(TrustedViewEditorInput.deserialize(input.serialize())?.getName()).toBe('Server')
  })

  it('exposes a namespaced resource so it cannot collide with a real file', () => {
    const input = new TrustedViewEditorInput({
      extensionId: 'acme.ext',
      viewId: contribution.id,
      key: 'k1',
    })
    expect(input.resource.scheme).toBe('trusted-view')
    expect(URI.revive(input.resource.toJSON())?.toString()).toBe(input.resource.toString())
  })
})
