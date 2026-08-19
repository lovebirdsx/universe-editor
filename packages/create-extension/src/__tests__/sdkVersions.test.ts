import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK_VERSIONS } from '../sdkVersions.js'

const pkgRoot = (name: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', name, 'package.json')

describe('SDK_VERSIONS bump guards', () => {
  it('extensionApi matches packages/extension-api', () => {
    const pkg = JSON.parse(readFileSync(pkgRoot('extension-api'), 'utf8')) as { version: string }
    expect(SDK_VERSIONS.extensionApi, '漂移：请运行 pnpm ext-packages:gen 重新生成').toBe(
      pkg.version,
    )
  })

  it('uex matches packages/uex', () => {
    const pkg = JSON.parse(readFileSync(pkgRoot('uex'), 'utf8')) as { version: string }
    expect(SDK_VERSIONS.uex, '漂移：请运行 pnpm ext-packages:gen 重新生成').toBe(pkg.version)
  })

  it('e2eHarness matches packages/e2e-harness', () => {
    const pkg = JSON.parse(readFileSync(pkgRoot('e2e-harness'), 'utf8')) as { version: string }
    expect(SDK_VERSIONS.e2eHarness, '漂移：请运行 pnpm ext-packages:gen 重新生成').toBe(pkg.version)
  })

  it('e2eContract matches packages/e2e-contract', () => {
    const pkg = JSON.parse(readFileSync(pkgRoot('e2e-contract'), 'utf8')) as { version: string }
    expect(SDK_VERSIONS.e2eContract, '漂移：请运行 pnpm ext-packages:gen 重新生成').toBe(
      pkg.version,
    )
  })
})
