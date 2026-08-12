/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Chat context-menu target resolution — maps the DOM node under the cursor
 *  (or a menu command arg) to a typed copy target: an image block, a resource
 *  link, or a selection-context chip. The `data-uri` / `data-context-text`
 *  attributes are stamped by the rendering components; this module is the
 *  single read side so menu actions and context-key seeding stay in sync.
 *--------------------------------------------------------------------------------------------*/

export type AcpContextMenuTarget =
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'path'; readonly uri: string }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Walk up from `el` to the nearest copy-able chat fragment, most specific
 * first: an image nested inside a resource link resolves as the image.
 */
export function resolveChatContextTarget(el: HTMLElement): AcpContextMenuTarget | undefined {
  const image = el.closest('[data-testid="acp-image-block"]')
  if (image) {
    const src = image.getAttribute('src')
    if (src) return { kind: 'image', src }
  }
  const link = el.closest('[data-testid="acp-resource-link"]')
  if (link) {
    const uri = link.getAttribute('data-uri')
    if (uri) return { kind: 'path', uri }
  }
  const chip = el.closest('[data-testid="acp-selection-context-chip"]')
  if (chip) {
    const text = chip.getAttribute('data-context-text')
    if (text) return { kind: 'text', text }
  }
  return undefined
}

/**
 * Extract a validated {@link AcpContextMenuTarget} from a menu command arg of
 * the shape `{ sessionId, target? }`. Field-by-field validation — anything
 * malformed degrades to `undefined` rather than crashing the command.
 */
export function readContextTarget(arg: unknown): AcpContextMenuTarget | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined
  const target = (arg as Record<string, unknown>)['target']
  if (typeof target !== 'object' || target === null) return undefined
  const record = target as Record<string, unknown>
  switch (record['kind']) {
    case 'image': {
      const src = record['src']
      return typeof src === 'string' && src.length > 0 ? { kind: 'image', src } : undefined
    }
    case 'path': {
      const uri = record['uri']
      return typeof uri === 'string' && uri.length > 0 ? { kind: 'path', uri } : undefined
    }
    case 'text': {
      const text = record['text']
      return typeof text === 'string' && text.length > 0 ? { kind: 'text', text } : undefined
    }
    default:
      return undefined
  }
}
