/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the phone delivery suite: the real git extension plus the
 *  gateway, because delivery drives `git.agentDelivery.*` through the extension host.
 *  A dedicated port and pairing code keep it independent from mobile.gateway.spec.ts
 *  when Playwright runs both files in parallel.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MOBILE_DELIVERY_ASSETS_DIR = join(__dirname, '..', '..', '..', 'mobile', 'dist')
export const MOBILE_DELIVERY_E2E_CODE = '5678EFGH'

async function findFreePort(): Promise<number> {
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

export const MOBILE_DELIVERY_PORT = await findFreePort()

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/git'],
  env: {
    UNIVERSE_MOBILE_GATEWAY: '1',
    UNIVERSE_MOBILE_PORT: String(MOBILE_DELIVERY_PORT),
    UNIVERSE_MOBILE_E2E_CODE: MOBILE_DELIVERY_E2E_CODE,
    UNIVERSE_MOBILE_ASSETS_DIR: MOBILE_DELIVERY_ASSETS_DIR,
  },
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
export type { E2EFixtures } from '@universe-editor/e2e-harness'
