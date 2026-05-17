import { describe, it, expect } from 'vitest'
import { computeResizeAfterSecondaryToggle } from '../resizeUtils.js'

describe('computeResizeAfterSecondaryToggle', () => {
  // ── Hiding secondary sidebar ─────────────────────────────────────────────

  it('hiding: freed secondary space goes entirely to editor, sidebar unchanged', () => {
    // secondary (300) was visible; hiding should give its 300px to editor
    const result = computeResizeAfterSecondaryToggle([240, 460, 300], false, 300)
    expect(result).toEqual([240, 760, 0])
  })

  it('hiding: sidebar stays at its value regardless of secondary size', () => {
    const result = computeResizeAfterSecondaryToggle([170, 530, 300], false, 300)
    expect(result).toEqual([170, 830, 0])
  })

  it('hiding: works when secondary preferred size differs from snapshot', () => {
    // snapshot secondary was 200, preferred 300 — snapshot wins for hide path
    const result = computeResizeAfterSecondaryToggle([240, 560, 200], false, 300)
    expect(result).toEqual([240, 760, 0])
  })

  // ── Showing secondary sidebar ────────────────────────────────────────────

  it('showing: space taken from editor, sidebar unchanged', () => {
    // secondary is hidden (snapshot[2]=0); showing allocates preferred size from editor
    const result = computeResizeAfterSecondaryToggle([240, 760, 0], true, 300)
    expect(result).toEqual([240, 460, 300])
  })

  it('showing: custom preferred size', () => {
    const result = computeResizeAfterSecondaryToggle([200, 800, 0], true, 250)
    expect(result).toEqual([200, 550, 250])
  })

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('returns null when total is 0 (layout not yet initialized)', () => {
    expect(computeResizeAfterSecondaryToggle([0, 0, 0], false, 300)).toBeNull()
    expect(computeResizeAfterSecondaryToggle([0, 0, 0], true, 300)).toBeNull()
  })

  it('returns null when showing would reduce editor to zero', () => {
    // sidebar=240, editor=100; showing 300px secondary would make editor=-140
    expect(computeResizeAfterSecondaryToggle([240, 100, 0], true, 300)).toBeNull()
  })

  it('returns null when showing would reduce editor to exactly zero', () => {
    // sidebar=200, editor=300; preferred=300 → newEditor=0
    expect(computeResizeAfterSecondaryToggle([200, 300, 0], true, 300)).toBeNull()
  })

  it('hiding with zero snapshot secondary passes through as noop-like correction', () => {
    // secondary was already 0 in snapshot (unexpected state) — editor unchanged
    const result = computeResizeAfterSecondaryToggle([240, 760, 0], false, 300)
    expect(result).toEqual([240, 760, 0])
  })
})
