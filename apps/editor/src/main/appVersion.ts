import { app } from 'electron'

declare const __APP_VERSION__: string

// Unpackaged (`electron out/main/index.js`) `app.getVersion()` returns Electron's
// own version, so dev/e2e read the build-time constant instead.
export function getAppVersion(): string {
  return app.isPackaged ? app.getVersion() : __APP_VERSION__
}
