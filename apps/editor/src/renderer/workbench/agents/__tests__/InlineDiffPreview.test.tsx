/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for InlineDiffPreview — the collapsed window must anchor on the first
 *  change (codex emits whole-file diffs), not the file's first line.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { InlineDiffPreview, collapsedDiffWindow } from '../InlineDiffPreview.js'

afterEach(() => {
  cleanup()
})

describe('collapsedDiffWindow', () => {
  it('starts at 0 when the first change is at the top (claude hunk-style diff)', () => {
    expect(collapsedDiffWindow(30, 0, 12)).toEqual({ start: 0, count: 12 })
  })

  it('anchors a few lines above a change deep in the file (codex whole-file diff)', () => {
    // change at line 50 of a 100-line diff → window opens near it, not at line 0.
    expect(collapsedDiffWindow(100, 50, 12)).toEqual({ start: 47, count: 12 })
  })

  it('clamps the window so it never runs past the end', () => {
    expect(collapsedDiffWindow(20, 19, 12)).toEqual({ start: 8, count: 12 })
  })

  it('shows everything when the diff is shorter than the window', () => {
    expect(collapsedDiffWindow(5, 3, 12)).toEqual({ start: 0, count: 5 })
  })
})

describe('InlineDiffPreview', () => {
  function bigFile(changedLineIndex: number, total = 100): { oldText: string; newText: string } {
    const oldLines = Array.from({ length: total }, (_, i) => `line ${i}`)
    const newLines = [...oldLines]
    newLines[changedLineIndex] = 'CHANGED'
    return { oldText: oldLines.join('\n'), newText: newLines.join('\n') }
  }

  it('shows the changed line for a whole-file diff whose edit is far from the top', () => {
    const { oldText, newText } = bigFile(50)
    render(<InlineDiffPreview path="a.ts" oldText={oldText} newText={newText} onOpen={vi.fn()} />)
    const body = screen.getByTestId('acp-inline-diff').querySelector('pre')!
    expect(body.textContent).toContain('CHANGED')
    // The untouched top of the file must not be what the collapsed card shows.
    expect(body.textContent).not.toContain('line 0')
  })
})
