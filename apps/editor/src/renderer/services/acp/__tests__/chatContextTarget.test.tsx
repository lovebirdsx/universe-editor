/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/chatContextTarget.ts
 *
 *  resolveChatContextTarget walks real DOM (happy-dom) built by hand; the
 *  rendering components' data attributes are contracted here so a drift on
 *  either side fails loud.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  readContextTarget,
  resolveChatContextTarget,
  type AcpContextMenuTarget,
} from '../chatContextTarget.js'

function el(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  const first = host.firstElementChild
  if (!(first instanceof HTMLElement)) throw new Error('bad fixture')
  return first
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('resolveChatContextTarget', () => {
  it('resolves an image block to its raw src', () => {
    const img = el(
      '<img data-testid="acp-image-block" src="data:image/png;base64,AAAA" alt="shot" />',
    )
    expect(resolveChatContextTarget(img)).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,AAAA',
    })
  })

  it('resolves a resource link to its data-uri', () => {
    const link = el(
      '<button data-testid="acp-resource-link" data-uri="file:///src/a.ts">a.ts</button>',
    )
    expect(resolveChatContextTarget(link)).toEqual({ kind: 'path', uri: 'file:///src/a.ts' })
  })

  it('resolves a selection-context chip to its data-context-text', () => {
    const chip = el(
      '<span data-testid="acp-selection-context-chip" data-context-text="const x = 1">x</span>',
    )
    expect(resolveChatContextTarget(chip)).toEqual({ kind: 'text', text: 'const x = 1' })
  })

  it('bubbles up from a nested child via closest', () => {
    const link = el(
      '<button data-testid="acp-resource-link" data-uri="file:///src/a.ts"><span class="icon"></span></button>',
    )
    const inner = link.querySelector('.icon')
    expect(inner instanceof HTMLElement).toBe(true)
    expect(resolveChatContextTarget(inner as HTMLElement)).toEqual({
      kind: 'path',
      uri: 'file:///src/a.ts',
    })
  })

  it('prefers the image when it is nested inside a resource link', () => {
    const link = el(
      '<a data-testid="acp-resource-link" data-uri="file:///img.png"><img data-testid="acp-image-block" src="data:image/png;base64,BBBB" /></a>',
    )
    const img = link.querySelector('[data-testid="acp-image-block"]') as HTMLElement
    expect(resolveChatContextTarget(img)).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,BBBB',
    })
  })

  it('returns undefined when the attribute is missing or empty', () => {
    const img = el('<img data-testid="acp-image-block" alt="no src" />')
    expect(resolveChatContextTarget(img)).toBeUndefined()
    const link = el('<button data-testid="acp-resource-link">no uri</button>')
    expect(resolveChatContextTarget(link)).toBeUndefined()
    const chip = el('<span data-testid="acp-selection-context-chip" data-context-text="">x</span>')
    expect(resolveChatContextTarget(chip)).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    const plain = el('<div><p>hello</p></div>').querySelector('p') as HTMLElement
    expect(resolveChatContextTarget(plain)).toBeUndefined()
  })
})

describe('readContextTarget', () => {
  const image: AcpContextMenuTarget = { kind: 'image', src: 'data:image/png;base64,AAAA' }

  it('extracts a valid target from a menu arg', () => {
    expect(readContextTarget({ sessionId: 's1', target: image })).toEqual(image)
    expect(
      readContextTarget({ sessionId: 's1', target: { kind: 'path', uri: 'file:///a.ts' } }),
    ).toEqual({ kind: 'path', uri: 'file:///a.ts' })
    expect(readContextTarget({ sessionId: 's1', target: { kind: 'text', text: 'hello' } })).toEqual(
      { kind: 'text', text: 'hello' },
    )
  })

  it('returns undefined when there is no target', () => {
    expect(readContextTarget({ sessionId: 's1' })).toBeUndefined()
    expect(readContextTarget(undefined)).toBeUndefined()
    expect(readContextTarget(null)).toBeUndefined()
    expect(readContextTarget('s1')).toBeUndefined()
    expect(readContextTarget(42)).toBeUndefined()
  })

  it('rejects malformed targets field by field', () => {
    expect(readContextTarget({ target: { kind: 'image' } })).toBeUndefined()
    expect(readContextTarget({ target: { kind: 'image', src: 42 } })).toBeUndefined()
    expect(readContextTarget({ target: { kind: 'image', src: '' } })).toBeUndefined()
    expect(readContextTarget({ target: { kind: 'path', uri: null } })).toBeUndefined()
    expect(readContextTarget({ target: { kind: 'text', text: {} } })).toBeUndefined()
    expect(readContextTarget({ target: { kind: 'unknown', src: 'x' } })).toBeUndefined()
    expect(readContextTarget({ target: 'image' })).toBeUndefined()
  })
})
