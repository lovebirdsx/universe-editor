import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_API_VERSION } from '../lib/sdkVersion.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function readPkgVersion(...rel: string[]): string {
  const pkgPath = path.join(here, '..', '..', '..', ...rel, 'package.json')
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
}

describe('CURRENT_API_VERSION', () => {
  it('matches packages/extension-api/package.json (bump guard)', () => {
    expect(CURRENT_API_VERSION, '漂移：请运行 pnpm ext-packages:gen 重新生成').toBe(
      readPkgVersion('extension-api'),
    )
  })

  it('extension-api version matches the editor app version (unified version space)', () => {
    expect(
      readPkgVersion('extension-api'),
      '版本空间已统一：extension-api 包版本必须等于 apps/editor 版本（release.mjs 负责同步）',
    ).toBe(readPkgVersion('..', 'apps', 'editor'))
  })
})
