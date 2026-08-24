// @vitest-environment node
/*---------------------------------------------------------------------------------------------
 *  Overlay z-index ordering contract. The Select popover is portalled to
 *  document.body while its trigger can sit inside a fixed dialog, so it must
 *  outrank dialogs or it paints underneath them — a bug happy-dom cannot
 *  reproduce (no layout), hence this static assertion on the CSS sources.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync(new URL('../theme/tokens.css', import.meta.url), 'utf8')
const selectCss = readFileSync(new URL('../atoms/Select.module.css', import.meta.url), 'utf8')

function readToken(name: string): number {
  const raw = tokens.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1]
  if (raw === undefined) throw new Error(`missing ${name} in tokens.css`)
  return Number(raw)
}

describe('overlay z-index contract', () => {
  it('orders popover < dialog < dropdown < toast < tooltip', () => {
    const popover = readToken('--z-popover')
    const dialog = readToken('--z-dialog')
    const dropdown = readToken('--z-dropdown')
    const toast = readToken('--z-toast')
    const tooltip = readToken('--z-tooltip')
    expect(popover).toBeLessThan(dialog)
    expect(dialog).toBeLessThan(dropdown)
    expect(dropdown).toBeLessThan(toast)
    expect(toast).toBeLessThan(tooltip)
  })

  it('uses --z-dropdown for the Select popover', () => {
    const block = selectCss.match(/\.popover\s*\{([^}]*)\}/)
    expect(block?.[1]).toMatch(/z-index:\s*var\(--z-dropdown\)/)
  })
})
