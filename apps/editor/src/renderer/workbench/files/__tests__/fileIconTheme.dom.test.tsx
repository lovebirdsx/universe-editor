/*---------------------------------------------------------------------------------------------
 *  FileIcon DOM contract: the inline-SVG glyph must not be rewritten on an
 *  ordinary re-render. React 19 compares `dangerouslySetInnerHTML` by object
 *  identity, so a fresh `{ __html }` object per render re-parses the SVG and
 *  replaces the glyph's DOM subtree every time a virtualized row re-renders.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { URI } from '@universe-editor/platform'
import { FileIcon } from '../fileIconTheme.js'

afterEach(cleanup)

describe('FileIcon glyph', () => {
  it('keeps the glyph DOM when re-rendered with the same icon', async () => {
    const { container, rerender } = render(
      <FileIcon resource={URI.file('/ws/a.ts')} isDirectory={false} />,
    )
    const glyph = container.querySelector('[data-file-icon] > span') as HTMLElement
    expect(glyph.querySelector('svg')).not.toBeNull()

    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(glyph, { childList: true, subtree: true, characterData: true })

    await act(async () => {
      rerender(<FileIcon resource={URI.file('/ws/a.ts')} isDirectory={false} />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    observer.disconnect()

    expect(mutations).toEqual([])
  })
})
