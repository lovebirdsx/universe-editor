/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the LAN tier. Mirrors mobileApp.ts but binds the
 *  self-signed HTTPS server on loopback with an ephemeral port, so the spec can
 *  assert certificate generation and a TLS WebSocket without a fixed port.
 *--------------------------------------------------------------------------------------------*/

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const TLS_MOBILE_ASSETS_DIR = join(__dirname, '..', '..', '..', 'mobile', 'dist')
export const TLS_MOBILE_E2E_CODE = '1234ABCD'

export const tlsTest = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  env: {
    UNIVERSE_MOBILE_GATEWAY: '1',
    UNIVERSE_MOBILE_BIND: 'lan',
    UNIVERSE_MOBILE_LAN_ADDRESS: '127.0.0.1',
    UNIVERSE_MOBILE_PORT: '0',
    UNIVERSE_MOBILE_E2E_CODE: TLS_MOBILE_E2E_CODE,
    UNIVERSE_MOBILE_ASSETS_DIR: TLS_MOBILE_ASSETS_DIR,
  },
})
