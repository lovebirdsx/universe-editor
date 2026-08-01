import { describe, it, expect, vi } from 'vitest'
import { runPrepublishScript } from '../lib/prepublish.js'
import { UexError } from '../errors.js'

describe('runPrepublishScript', () => {
  it('does nothing without a universe:prepublish script', async () => {
    const runner = vi.fn()
    expect(await runPrepublishScript('/ext', { build: 'x' }, runner)).toBe(false)
    expect(await runPrepublishScript('/ext', undefined, runner)).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  it('runs the script and returns true on success', async () => {
    const runner = vi.fn().mockReturnValue(0)
    expect(
      await runPrepublishScript('/ext', { 'universe:prepublish': 'npm run build' }, runner),
    ).toBe(true)
    expect(runner).toHaveBeenCalledWith('npm run universe:prepublish', '/ext')
  })

  it('throws UexError on failure', async () => {
    const runner = vi.fn().mockReturnValue(1)
    await expect(
      runPrepublishScript('/ext', { 'universe:prepublish': 'npm run build' }, runner),
    ).rejects.toBeInstanceOf(UexError)
  })
})
