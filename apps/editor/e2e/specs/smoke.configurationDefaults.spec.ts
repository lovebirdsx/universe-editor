/*---------------------------------------------------------------------------------------------
 *  Build-time configuration defaults smoke (@p1).
 *
 *  Guards the four-hop injection chain end-to-end in a real Electron launch —
 *  env → EnvironmentMainService → base64 argv flag → preload → renderer
 *  ConfigurationRegistry override. Unit tests cover each hop in isolation; only
 *  a live launch proves Chromium's argv writer and Node's argv reader agree on
 *  the flag value, which is why it is base64 rather than raw JSON.
 *
 *  The injected values are deliberately unusual (quotes, spaces, shell
 *  metacharacters, non-ascii) — a naive raw-JSON argv would lose exactly these.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const INJECTED = {
  'perforce.swarm.url': 'http://swarm.example.com/',
  'issueReporter.tracker.serverUrl': 'http://tracker.example.com:3030',
  // A value that only survives if the argv hop is quoting-proof.
  'workbench.colorTheme': 'Theme "x y" & ^ | 中文',
} as const

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  env: { UNIVERSE_CONFIGURATION_DEFAULTS: JSON.stringify(INJECTED) },
})

test.describe('@p1 build-time configuration defaults', () => {
  test('injected defaults reach the renderer and lose to user settings', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Hop 1-5: every injected key is the effective value, verbatim.
    for (const [key, value] of Object.entries(INJECTED)) {
      await expect
        .poll(() => page.evaluate((k) => window.__E2E__!.getConfigurationValue(k), key))
        .toBe(value)
    }

    // Injected values live in the Default layer, so the settings editor must not
    // show them as user-modified.
    expect(
      await page.evaluate(() => window.__E2E__!.getConfigurationValueOrigin('perforce.swarm.url')),
    ).toBe('default')

    // A writable layer still wins, and clearing it falls back to the injected
    // value rather than the schema default (empty string).
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('perforce.swarm.url', 'http://user.example.com/'),
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getConfigurationValue('perforce.swarm.url')))
      .toBe('http://user.example.com/')

    await page.evaluate(() => window.__E2E__!.updateConfigValue('perforce.swarm.url', undefined))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getConfigurationValue('perforce.swarm.url')))
      .toBe(INJECTED['perforce.swarm.url'])
  })
})
