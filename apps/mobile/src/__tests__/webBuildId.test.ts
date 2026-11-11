import { afterEach, describe, expect, it } from 'vitest'
import { compareWebBuildId, readClientWebBuildId } from '../webBuildId.js'

afterEach(() => {
  document.head.innerHTML = ''
})

function documentWithScript(script: { readonly src: string } | null): Document {
  return { querySelector: () => script } as unknown as Document
}

describe('readClientWebBuildId', () => {
  it('reads the module entry script the page loaded', () => {
    expect(readClientWebBuildId(documentWithScript({ src: '/assets/index-a.js' }))).toBe(
      'index-a.js',
    )
  })

  it('returns undefined when the shell has no module entry script', () => {
    expect(readClientWebBuildId(documentWithScript(null))).toBeUndefined()
    document.head.innerHTML = '<script type="module">void 0</script>'
    expect(readClientWebBuildId()).toBeUndefined()
  })
})

describe('compareWebBuildId', () => {
  it('reports a mismatch only when both sides are known and differ', () => {
    expect(compareWebBuildId('index-a.js', 'index-a.js')).toBeUndefined()
    expect(compareWebBuildId(undefined, 'index-a.js')).toBeUndefined()
    expect(compareWebBuildId('index-a.js', undefined)).toBeUndefined()
    expect(compareWebBuildId('index-b.js', 'index-a.js')).toEqual({
      serverBuildId: 'index-b.js',
      clientBuildId: 'index-a.js',
    })
  })
})
