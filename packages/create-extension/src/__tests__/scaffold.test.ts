import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { scaffold } from '../scaffold.js'
import { ScaffoldError } from '../errors.js'
import { SDK_VERSIONS } from '../sdkVersions.js'

const answers = {
  name: 'demo-ext',
  publisher: 'acme',
  displayName: 'Demo Ext',
  description: 'a demo extension',
  template: 'basic' as const,
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'cue-scaffold-'))
}

function listRel(root: string, dir = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    if (entry.isDirectory()) listRel(root, abs, acc)
    else acc.push(rel)
  }
  return acc.sort()
}

describe('scaffold', () => {
  it('writes the basic template tree with substitutions applied', async () => {
    const dir = path.join(tmp(), 'demo-ext')
    await scaffold(answers, { targetDir: dir, force: false, versions: SDK_VERSIONS })

    expect(listRel(dir)).toEqual([
      '.gitignore',
      '.vscode/launch.json',
      '.vscode/tasks.json',
      'README.md',
      'e2e/fixtures/app.d.mts',
      'e2e/fixtures/app.mjs',
      'e2e/playwright.config.ts',
      'e2e/specs/command.spec.ts',
      'esbuild.config.mjs',
      'icon.png',
      'package.json',
      'scripts/e2e.mjs',
      'src/__tests__/extension.test.ts',
      'src/__tests__/hello.test.ts',
      'src/extension.ts',
      'src/hello.ts',
      'tsconfig.json',
      'vitest.config.ts',
    ])

    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pkg.name).toBe('demo-ext')
    expect(pkg.publisher).toBe('acme')
    expect(pkg.displayName).toBe('Demo Ext')
    expect((pkg.engines as { universe: string }).universe).toBe(
      `>=${SDK_VERSIONS.extensionApi} <1.0.0`,
    )
    expect((pkg.devDependencies as Record<string, string>)['@universe-editor/extension-api']).toBe(
      `^${SDK_VERSIONS.extensionApi}`,
    )

    const extSrc = readFileSync(path.join(dir, 'src', 'extension.ts'), 'utf8')
    expect(extSrc).toContain("'demo-ext.helloWorld'")
  })

  it('leaves no __token__ residue in any text file', async () => {
    const dir = path.join(tmp(), 'demo-ext')
    await scaffold(answers, { targetDir: dir, force: false, versions: SDK_VERSIONS })
    for (const rel of listRel(dir)) {
      if (rel === 'icon.png') continue
      const content = readFileSync(path.join(dir, rel), 'utf8')
      // window.__E2E__ (e2e probe handle) and __tests__ (vitest dir name) are
      // real names, not template tokens.
      const withoutHandles = content.replaceAll('__E2E__', '').replaceAll('__tests__', '')
      expect(withoutHandles, rel).not.toMatch(/__\w+__/)
    }
  })

  it('copies icon.png byte-for-byte', async () => {
    const dir = path.join(tmp(), 'demo-ext')
    const written = await scaffold(answers, {
      targetDir: dir,
      force: false,
      versions: SDK_VERSIONS,
    })
    const icon = written.find((p) => p.endsWith('icon.png'))!
    expect(statSync(icon).size).toBeGreaterThan(0)
    const src = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..',
      '..',
      'templates',
      'basic',
      'icon.png',
    )
    expect(readFileSync(icon)).toEqual(readFileSync(src))
  })

  it('refuses a non-empty directory without --force', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'keep.txt'), 'precious')
    const err = await scaffold(answers, {
      targetDir: dir,
      force: false,
      versions: SDK_VERSIONS,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScaffoldError)
    expect((err as ScaffoldError).hints.join(' ')).toContain('--force')
  })

  it('--force overwrites owned files but never deletes foreign ones', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'keep.txt'), 'precious')
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'extension.ts'), '// stale')

    await scaffold(answers, { targetDir: dir, force: true, versions: SDK_VERSIONS })
    expect(readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('precious')
    expect(readFileSync(path.join(dir, 'src', 'extension.ts'), 'utf8')).toContain(
      'demo-ext.helloWorld',
    )
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true)
  })

  it('rejects an unknown template', async () => {
    const err = await scaffold(
      { ...answers, template: 'nope' as 'basic' },
      { targetDir: path.join(tmp(), 'x'), force: false, versions: SDK_VERSIONS },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScaffoldError)
  })
})
