import { createRequire } from 'node:module'

/**
 * Server version reported by the handshake environment and persisted in
 * server.json. Read from the package.json nearest this module at runtime so it
 * stays correct both from source (packages/remote-server/package.json) and from
 * a built bundle (dist/package.json or dist-bundle/package.json, which carry the
 * same version).
 */
function readPackageVersion(): string {
  const require = createRequire(import.meta.url)
  for (const rel of ['../package.json', './package.json']) {
    try {
      const pkg = require(rel) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version) {
        return pkg.version
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0'
}

export const SERVER_VERSION = readPackageVersion()
