import { Activity } from 'lucide-react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isKnownCodicon, isKnownIcon, resolveIcon } from '../icon-map.js'

function mustResolve(name: string) {
  const Icon = resolveIcon(name)
  if (!Icon) throw new Error(`icon not resolved: ${name}`)
  return Icon
}

describe('resolveIcon', () => {
  it('keeps curated ids on their Lucide glyph', () => {
    expect(resolveIcon('pulse')).toBe(Activity)
    expect(isKnownIcon('pulse')).toBe(true)
  })

  it('falls back to a real codicon outside the curated table', () => {
    const Icon = mustResolve('folder')
    const { container } = render(<Icon size={16} />)
    expect(container.querySelector('.codicon-folder')).not.toBeNull()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('normalizes $(id) and honours the modifier', () => {
    expect(resolveIcon('$(folder)')).toBe(resolveIcon('folder'))
    const Icon = mustResolve('$(files~spin)')
    const { container } = render(<Icon size={16} />)
    expect(container.querySelector('.codicon-files')).not.toBeNull()
    expect(container.querySelector('.codicon-modifier-spin')).not.toBeNull()
  })

  it('rejects unknown ids, paths and prototype keys', () => {
    expect(resolveIcon('acme.editor-service.nope')).toBeUndefined()
    expect(resolveIcon('./icon.svg')).toBeUndefined()
    expect(resolveIcon('constructor')).toBeUndefined()
    expect(resolveIcon('toString')).toBeUndefined()
    expect(isKnownCodicon('folder')).toBe(true)
    expect(isKnownCodicon('$(folder)')).toBe(true)
    expect(isKnownCodicon('acme.editor-service.nope')).toBe(false)
  })

  it('keeps component identity stable across calls', () => {
    expect(resolveIcon('folder')).toBe(resolveIcon('folder'))
  })
})
