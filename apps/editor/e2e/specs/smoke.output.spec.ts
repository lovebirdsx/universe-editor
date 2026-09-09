/*---------------------------------------------------------------------------------------------
 *  S6 — Toggle panel reveals Output tab (P1).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 output panel', () => {
  test('panel hosts Output tab and toggling round-trips visibility', async ({ workbench }) => {
    // Ensure panel is visible, regardless of starting state or storage replay.
    if (!(await workbench.getContextKey<boolean>('panelVisible'))) {
      await workbench.runCommand('workbench.action.togglePanel')
    }
    await workbench.panel.waitForVisible()
    await expect(workbench.panel.tab('workbench.view.output')).toBeAttached()
    await expect(workbench.panel.tab('workbench.view.output')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Toggle off — verifies the command actually drives the layout observable.
    await workbench.runCommand('workbench.action.togglePanel')
    await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
  })

  test('first error log reveals Output and activates the emitting channel', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    if (await workbench.getContextKey<boolean>('panelVisible')) {
      await workbench.runCommand('workbench.action.togglePanel')
      await expect.poll(() => workbench.getContextKey<boolean>('panelVisible')).toBe(false)
    }

    await workbench.page.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E auto reveal error log')
    })

    await expect
      .poll(() => workbench.getContextKey<boolean>('panelVisible'), { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
        timeout: 10_000,
      })
      .toBe('Renderer')
  })

  test('focus lands inside the output editor and keyboard navigation works @p1', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    if (!(await workbench.getContextKey<boolean>('panelVisible'))) {
      await workbench.runCommand('workbench.action.toggleOutput')
    }
    await workbench.panel.waitForVisible()

    // The Monaco editor inside the Output view owns keyboard focus, so arrow
    // keys / selection work without clicking into the panel first.
    //
    // Assert on the real keyboard-focus element, not the ViewBody fallback
    // container: `[data-view-id]` IS the fallback div, so `view.contains(active)`
    // would pass even when focus is stranded on it. With `editContext: true`
    // Monaco's focus element is `div.native-edit-context`; the sibling
    // `textarea.ime-text-area` is a tabindex=-1 aria-hidden IME placeholder that
    // must never receive focus (a past bug focused exactly it → dead keyboard).
    const readFocusState = () =>
      workbench.page.evaluate(() => {
        const view = document.querySelector('[data-view-id="workbench.view.output.main"]')
        const active = document.activeElement as HTMLElement | null
        if (!view || !active || !view.contains(active)) return 'outside'
        if (active.classList.contains('native-edit-context')) return 'monaco-focus'
        if (active.classList.contains('ime-text-area')) return 'ime-placeholder'
        if (active === view) return 'fallback-container'
        return 'other-inner'
      })

    await expect.poll(readFocusState).toBe('monaco-focus')

    // Emit a few log lines so the editor has content to move a cursor through.
    await workbench.page.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E keyboard navigation probe')
    })

    await workbench.page.keyboard.press('ArrowUp')
    await workbench.page.keyboard.press('ArrowDown')
    expect(await readFocusState()).toBe('monaco-focus')
  })

  test('first open of a never-picked EMPTY channel via Ctrl+Shift+U focuses the editor (no MRU dot)', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    // Wait out the one-shot bootstrap focus restore, otherwise it can steal
    // focus back to the Explorer mid-pick and flake the focus assertion.
    await workbench.waitForBootstrapFocusSettled()

    // A channel that exists but has NO content and has never been opened through
    // the Show Output Channels picker — so it carries no MRU dot. This is the
    // true first-open regression path: `activeChannelHasContent === false` used
    // to gate OutputView so LogOutputView never mounted, no focusable primary
    // was ever registered, and focusView() stranded keyboard focus on the
    // ViewBody fallback container. (An empty channel must still be a focusable
    // read-only editor — VSCode parity.)
    const channel = 'E2E First Open Empty Channel'
    await workbench.page.evaluate((name) => {
      window.__E2E__!.createOutputChannel(name)
    }, channel)

    // Drive the real keybinding so the whole pick → reveal → focus chain runs
    // end to end.
    await workbench.page.keyboard.press('ControlOrMeta+Shift+U')
    await workbench.quickInput.waitForVisible()
    await workbench.page.keyboard.type(channel)
    await workbench.page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await workbench.panel.waitForVisible()
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveOutputChannelName()), {
        timeout: 10_000,
      })
      .toBe(channel)

    // Focus must land on the real Monaco focus element, not the ViewBody
    // fallback container (the regression this guards).
    const readFocusState = () =>
      workbench.page.evaluate(() => {
        const view = document.querySelector('[data-view-id="workbench.view.output.main"]')
        const active = document.activeElement as HTMLElement | null
        if (!view || !active || !view.contains(active)) return 'outside'
        if (active.classList.contains('native-edit-context')) return 'monaco-focus'
        if (active.classList.contains('ime-text-area')) return 'ime-placeholder'
        if (active === view) return 'fallback-container'
        return 'other-inner'
      })
    await expect.poll(readFocusState, { timeout: 10_000 }).toBe('monaco-focus')

    // And keyboard navigation reaches the editor.
    await workbench.page.keyboard.press('ArrowUp')
    await workbench.page.keyboard.press('ArrowDown')
    expect(await readFocusState()).toBe('monaco-focus')
  })
})
