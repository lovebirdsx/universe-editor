/**
 * Regression: the status bar showed the dashboard's RAW needsAction length while
 * the sidebar "Needs My Action" group showed a different number — the sidebar
 * applies the author whitelist / approvable-only filters and the client-side
 * ignore set (all renderer-only concepts the extension host cannot see). A user
 * with 30 raw actionable reviews but 0 displayed (filtered / ignored) saw "30"
 * in the status bar and "0" in the sidebar.
 *
 * The host therefore no longer derives the count from the dashboard at all: it
 * passively displays the renderer-pushed group-scope count (setCount), and
 * refresh() only re-checks availability to show/hide the item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  item: {
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  },
  dashboard: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn(() => mocks.item),
  },
}))

const { SwarmStatusBarController } = await import('../swarm/swarmStatusBar.js')

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isTraceEnabled: vi.fn(async () => false),
}

/** A client whose raw dashboard needsAction count is 30 — the scenario from the
 *  bug report: every one of them is filtered or ignored in the sidebar, so the
 *  group-scope count the renderer pushes is 0. */
function clientWithRawDashboard(needsActionCount: number) {
  mocks.dashboard.mockResolvedValue({
    needsAction: Array.from({ length: needsActionCount }, (_, i) => ({ id: String(i + 1) })),
    authored: [],
    participating: [],
  })
  return { dashboard: mocks.dashboard }
}

describe('SwarmStatusBarController', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.dashboard.mockReset()
  })

  it('displays the renderer-pushed group-scope count, not the raw dashboard length', async () => {
    const client = clientWithRawDashboard(30)
    const controller = new SwarmStatusBarController(async () => client as never, logger)
    await controller.refresh()

    // Sidebar shows 0 (all 30 filtered / ignored) → the status bar must agree.
    controller.setCount(0)

    expect(mocks.item.text).toBe('$(git-pull-request) 0')
    expect(mocks.item.show).toHaveBeenCalled()
    controller.dispose()
  })

  it('never re-derives the count from the dashboard on refresh', async () => {
    const client = clientWithRawDashboard(30)
    const controller = new SwarmStatusBarController(async () => client as never, logger)

    controller.setCount(0)
    await controller.refresh()

    expect(mocks.dashboard).not.toHaveBeenCalled()
    expect(mocks.item.text).toBe('$(git-pull-request) 0')
    controller.dispose()
  })

  it('updates the text and tooltip when the pushed count changes', async () => {
    const client = clientWithRawDashboard(30)
    const controller = new SwarmStatusBarController(async () => client as never, logger)
    await controller.refresh()

    controller.setCount(3)
    expect(mocks.item.text).toBe('$(git-pull-request) 3')
    expect(String(mocks.item.tooltip)).toContain('3')

    controller.setCount(0)
    expect(mocks.item.text).toBe('$(git-pull-request) 0')
    controller.dispose()
  })

  it('hides while Swarm is unavailable and reappears on the pushed count once back', async () => {
    let client: unknown = undefined
    const controller = new SwarmStatusBarController(async () => client as never, logger)

    await controller.refresh()
    expect(mocks.item.hide).toHaveBeenCalled()
    expect(mocks.item.show).not.toHaveBeenCalled()

    // Pushes while unavailable must not surface the item.
    controller.setCount(5)
    expect(mocks.item.show).not.toHaveBeenCalled()

    client = clientWithRawDashboard(30)
    await controller.refresh()
    expect(mocks.item.show).toHaveBeenCalled()
    expect(mocks.item.text).toBe('$(git-pull-request) 5')
    controller.dispose()
  })

  it('hides when the availability check fails', async () => {
    const controller = new SwarmStatusBarController(async () => {
      throw new Error('offline')
    }, logger)
    await controller.refresh()
    expect(mocks.item.hide).toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores setCount after dispose', async () => {
    const client = clientWithRawDashboard(30)
    const controller = new SwarmStatusBarController(async () => client as never, logger)
    await controller.refresh()
    controller.dispose()

    mocks.item.show.mockClear()
    controller.setCount(7)
    expect(mocks.item.show).not.toHaveBeenCalled()
  })
})
