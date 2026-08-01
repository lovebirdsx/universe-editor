import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_API_VERSION } from '../lib/sdkVersion.js'

describe('CURRENT_API_VERSION', () => {
  it('matches packages/extension-api/package.json (bump guard)', () => {
    const apiPkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'extension-api',
      'package.json',
    )
    const apiPkg = JSON.parse(readFileSync(apiPkgPath, 'utf8')) as { version: string }
    expect(CURRENT_API_VERSION).toBe(apiPkg.version)
  })
})
