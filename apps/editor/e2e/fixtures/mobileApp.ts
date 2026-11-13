/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the phone-gateway suite.
 *
 *  The gateway lives in the main process and is started from env overrides, so a
 *  fresh Electron per test is required (sharedApp's renderer reload cannot reset
 *  it). A free loopback port is picked at module load because the gateway rejects
 *  port 0; the spec serializes its own tests (file-level mode) so the same port
 *  is never bound twice concurrently. Assets point at the built PWA.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MOBILE_ASSETS_DIR = join(__dirname, '..', '..', '..', 'mobile', 'dist')
export const MOBILE_E2E_CODE = '1234ABCD'

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

export const MOBILE_GATEWAY_PORT = await findFreePort()

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  env: {
    UNIVERSE_MOBILE_GATEWAY: '1',
    UNIVERSE_MOBILE_PORT: String(MOBILE_GATEWAY_PORT),
    UNIVERSE_MOBILE_E2E_CODE: MOBILE_E2E_CODE,
    UNIVERSE_MOBILE_ASSETS_DIR: MOBILE_ASSETS_DIR,
  },
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
export type { E2EFixtures } from '@universe-editor/e2e-harness'
