import { test, expect } from '../fixtures/app.mjs'

test.describe('@p1 __name__', () => {
  test('activates, registers its command and writes to its output channel', async ({
    page,
    workbench,
  }) => {
    // Cold extension host + activation on first command; give it room.
    test.slow()
    await workbench.waitForRestored()

    // The contributed command must be translated into the renderer registry (host
    // booted + manifest scanned) before direct execution can route to the extension;
    // the bootstrap proxy then waits for activation on first invocation.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('__name__.helloWorld')), {
        timeout: 15000,
      })
      .toBe(true)

    await page.evaluate(() => window.__E2E__!.runCommand('__name__.helloWorld'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutputChannelContent('__displayName__')), {
        timeout: 20000,
      })
      .toContain('Hello from __displayName__!')
  })
})
