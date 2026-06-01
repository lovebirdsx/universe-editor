import * as pathPosix from 'node:path/posix'
import * as pathWin32 from 'node:path/win32'
import type { App } from 'electron'

export interface ProductIdentity {
  productName: string
  appUserModelId: string
  userDataDir: string
}

export interface ResolveEnv {
  isDev: boolean
  isE2E: boolean
  override?: string | undefined
  platform: NodeJS.Platform
  appData?: string | undefined
  xdgConfigHome?: string | undefined
  home?: string | undefined
}

const BASE_APP_ID = 'io.universe.editor'
const BASE_PRODUCT_NAME = 'Universe Editor'

export function resolveProductIdentity(env: ResolveEnv): ProductIdentity {
  const { productName, appUserModelId } = resolveProductFlavor(env)
  const path = env.platform === 'win32' ? pathWin32 : pathPosix

  const userDataDir = env.override
    ? toAbsolute(env.override, path)
    : path.join(platformAppDataRoot(env, path), productName)

  return { productName, appUserModelId, userDataDir }
}

function resolveProductFlavor(env: ResolveEnv): {
  productName: string
  appUserModelId: string
} {
  if (env.isE2E) {
    return {
      productName: `${BASE_PRODUCT_NAME} - E2E`,
      appUserModelId: `${BASE_APP_ID}.e2e`,
    }
  }
  if (env.isDev) {
    return {
      productName: `${BASE_PRODUCT_NAME} - Dev`,
      appUserModelId: `${BASE_APP_ID}.dev`,
    }
  }
  return { productName: BASE_PRODUCT_NAME, appUserModelId: BASE_APP_ID }
}

function platformAppDataRoot(env: ResolveEnv, path: typeof pathPosix): string {
  switch (env.platform) {
    case 'win32': {
      const appData = env.appData
      if (appData) return appData
      const home = env.home
      if (!home) {
        throw new Error('Windows: neither APPDATA nor HOME is set')
      }
      return path.join(home, 'AppData', 'Roaming')
    }
    case 'darwin': {
      const home = env.home ?? ''
      return path.join(home, 'Library', 'Application Support')
    }
    default: {
      const xdg = env.xdgConfigHome
      if (xdg) return xdg
      const home = env.home ?? ''
      return path.join(home, '.config')
    }
  }
}

function toAbsolute(p: string, path: typeof pathPosix): string {
  return path.isAbsolute(p) ? p : path.resolve(p)
}

export function applyProductIdentity(app: App, id: ProductIdentity): void {
  app.setName(id.productName)
  app.setPath('userData', id.userDataDir)
  if (process.platform === 'win32') {
    app.setAppUserModelId(id.appUserModelId)
  }
}

// Reading CLI args / env vars now lives in EnvironmentMainService (environment/);
// it produces a ResolveEnv via toResolveEnv(). Electron honors `--user-data-dir`
// natively, and EnvironmentMainService detects it (cli > UNIVERSE_USER_DATA_DIR)
// so explicit paths win over the flavor-based default — keeps Playwright's
// per-worker tmp dir isolation working.
