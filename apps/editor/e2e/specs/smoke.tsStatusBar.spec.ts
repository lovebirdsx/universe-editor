/*---------------------------------------------------------------------------------------------
 * TS server status-bar smoke (P1).
 *
 * Once the language server is ready, the transient spinner converges to a
 * persistent "TypeScript" status-bar entry whose tooltip reports which server
 * implementation is running (typescript-language-server vs the Go native LSP)
 * plus its version.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreTypescriptSharedApp.js'
import { DEFAULT_TS_SERVER_IMPLEMENTATION } from '../../src/shared/tsServerImplementation.js'

function writeWorkspace(): { dir: string; aPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-tsstatus-'))
  const aPath = join(dir, 'a.ts')
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
  )
  writeFileSync(aPath, 'export const alpha = 1\n')
  return { dir: dir.replace(/\\/g, '/'), aPath: aPath.replace(/\\/g, '/') }
}

test.describe('@p1 typescript status bar', () => {
  // @serial: same cold-tsserver + parcel-watcher constraints as smoke.outline.
  test(
    'keeps a persistent entry naming the server implementation once ready',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      test.slow()
      await workbench.waitForRestored()

      const { dir, aPath } = writeWorkspace()
      await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
      await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), aPath)

      const statusbar = page.getByTestId('part-statusbar')
      // Mirrors the main-process preference chain: env override, else the
      // shared default (there's no settings.json in the e2e profile).
      const native =
        process.env.UNIVERSE_TS_SERVER !== undefined
          ? process.env.UNIVERSE_TS_SERVER === 'native'
          : DEFAULT_TS_SERVER_IMPLEMENTATION === 'native'
      const expectedServer = native
        ? 'TypeScript Native (tsgo)'
        : 'typescript-language-server (tsserver)'
      // The tooltip lives in `title`; it disambiguates from the Editor Language
      // entry which is also labelled "TypeScript".
      const entry = statusbar.locator(`button[title*="${expectedServer}"]`)
      await expect(entry).toBeVisible({ timeout: 30000 })
      // Icon-only text: the accessible name falls back to the tooltip.
      await expect(entry).toHaveAttribute(
        'aria-label',
        new RegExp(expectedServer.replace(/[()]/g, '\\$&')),
      )
      await expect(entry).toHaveAttribute('title', /\d+\.\d+\.\d+/)
    },
  )
})
