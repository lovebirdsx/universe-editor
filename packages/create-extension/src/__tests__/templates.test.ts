import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlaceholders } from '../placeholders.js'
import { SDK_VERSIONS } from '../sdkVersions.js'

const templatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
)

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, acc)
    else acc.push(abs)
  }
  return acc
}

const isBinary = (file: string) => ['.png', '.ico', '.icns'].includes(path.extname(file))

describe('templates', () => {
  it('every __token__ in any template is covered by buildPlaceholders', () => {
    const known = new Set(
      Object.keys(
        buildPlaceholders(
          { name: 'x', publisher: 'y', displayName: 'x', description: '', template: 'basic' },
          SDK_VERSIONS,
        ),
      ),
    )
    for (const template of readdirSync(templatesDir)) {
      for (const file of walk(path.join(templatesDir, template))) {
        if (isBinary(file)) continue
        const content = readFileSync(file, 'utf8')
        for (const match of content.matchAll(/__\w+__/g)) {
          expect(known.has(match[0]), `${template}/${path.basename(file)} uses ${match[0]}`).toBe(
            true,
          )
        }
      }
    }
  })

  it('template package.json files stay valid JSON (tokens are string-safe)', () => {
    for (const template of readdirSync(templatesDir)) {
      const pkgPath = path.join(templatesDir, template, 'package.json')
      const raw = readFileSync(pkgPath, 'utf8')
      const substituted = raw.replaceAll(/__\w+__/g, 'x')
      expect(() => JSON.parse(substituted), template).not.toThrow()
    }
  })

  it('template tsconfig keeps the three strictness red lines', () => {
    for (const template of readdirSync(templatesDir)) {
      const tsconfig = JSON.parse(
        readFileSync(path.join(templatesDir, template, 'tsconfig.json'), 'utf8'),
      ) as { compilerOptions: Record<string, unknown> }
      expect(tsconfig.compilerOptions.strict, template).toBe(true)
      expect(tsconfig.compilerOptions.noUncheckedIndexedAccess, template).toBe(true)
      expect(tsconfig.compilerOptions.exactOptionalPropertyTypes, template).toBe(true)
    }
  })

  it('both templates ship an icon.png placeholder', () => {
    for (const template of readdirSync(templatesDir)) {
      const icon = path.join(templatesDir, template, 'icon.png')
      expect(statSync(icon).size, template).toBeGreaterThan(0)
    }
  })
})
