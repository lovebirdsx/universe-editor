/*---------------------------------------------------------------------------------------------
 *  In dev the shell is served from http://localhost, so a markdown-preview image
 *  addressed as universe-app://root/_resource_/... is cross-origin. webSecurity is
 *  relaxed for dev windows, but the page's <meta> CSP is a separate mechanism:
 *  unless `img-src` allows the universe-app: scheme, Chromium refuses the image and
 *  it renders broken. (Prod is same-origin so `'self'` already covers it — this is
 *  the dev-only gap.)
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { RESOURCE_PROTOCOL_SCHEME } from '../resourceUri.js'

const indexHtml = readFileSync(
  fileURLToPath(new URL('../../../index.html', import.meta.url)),
  'utf8',
)

function cspDirective(name: string): string {
  const meta = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/s)
  expect(meta, 'index.html must declare a CSP meta tag').not.toBeNull()
  const directive = meta![1]!
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name)
  return directive ?? ''
}

describe('markdown preview CSP', () => {
  it('img-src allows the universe-app resource scheme (dev cross-origin images)', () => {
    expect(cspDirective('img-src')).toContain(`${RESOURCE_PROTOCOL_SCHEME}:`)
  })
})
