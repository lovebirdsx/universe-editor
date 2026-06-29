/*---------------------------------------------------------------------------------------------
 *  Smoke test: verifies the platform package public API surface is importable.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  Emitter,
  DisposableStore,
  createDecorator,
  InstantiationService,
  ServiceCollection,
  LogLevel,
  NullLogger,
  LifecycleService,
  LifecyclePhase,
  CommandsRegistry,
  MenuRegistry,
  MenuId,
  ConfigurationRegistry,
  ConfigurationService,
} from '../index.js'

describe('platform public API surface', () => {
  it('exports Emitter and DisposableStore from base', () => {
    const store = new DisposableStore()
    const emitter = new Emitter<number>()
    store.add(emitter)
    let last = 0
    emitter.event((n) => (last = n))
    emitter.fire(42)
    expect(last).toBe(42)
    store.dispose()
  })

  it('exports DI container', () => {
    const IFoo = createDecorator<{ value: number }>('foo')
    const services = new ServiceCollection()
    services.set(IFoo, { value: 7 })
    const di = new InstantiationService(services)
    di.invokeFunction((acc) => {
      expect(acc.get(IFoo).value).toBe(7)
    })
    di.dispose()
  })

  it('exports log module', () => {
    const log = new NullLogger(LogLevel.Info)
    expect(() => log.info('ok')).not.toThrow()
    log.dispose()
  })

  it('exports lifecycle service', () => {
    const svc = new LifecycleService()
    expect(svc.phase).toBe(LifecyclePhase.Starting)
    svc.dispose()
  })

  it('exports command registry', () => {
    const d = CommandsRegistry.registerCommand('smoke.cmd', () => 'ok')
    expect(CommandsRegistry.getCommand('smoke.cmd')).toBeDefined()
    d.dispose()
  })

  it('exports menu registry', () => {
    const d = MenuRegistry.addMenuItem(MenuId.CommandPalette, { command: 'smoke.menu' })
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === 'smoke.menu',
      ),
    ).toBe(true)
    d.dispose()
  })

  it('exports configuration system', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'smoke',
      properties: { 'smoke.val': { type: 'string', default: 'x' } },
    })
    const svc = new ConfigurationService()
    expect(svc.get('smoke.val')).toBe('x')
    svc.dispose()
    d.dispose()
  })
})

/**
 * Guards the barrel convention: every source file that exports something must be
 * reachable from `src/index.ts` through the chain of per-directory `index.ts`
 * barrels. A new file that exports symbols but is never collected into a barrel
 * would silently fail to compile in apps — this test catches it in platform CI.
 */
describe('barrel coverage', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')

  // Intentionally-internal files (used by siblings, never part of the public API).
  const INTERNAL = new Set(['command/contextKeyParser.ts', 'command/contextKeyScanner.ts'])

  // `base/observable` exposes its own hand-curated public barrel (observable/index.ts);
  // its internals are not expected to be individually re-exported.
  const isObservableInternal = (rel: string): boolean =>
    rel.startsWith('base/observable/') && rel !== 'base/observable/index.ts'

  const toPosix = (p: string): string => p.split('\\').join('/')

  function listSourceFiles(dir: string, base = ''): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        out.push(...listSourceFiles(join(dir, entry.name), rel))
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(toPosix(rel))
      }
    }
    return out
  }

  // Resolve the set of files reachable from a barrel by following `export * from './x.js'`.
  function collectReachable(): Set<string> {
    const reachable = new Set<string>()
    const reExport = /export\s+\*\s+from\s+['"](\.[^'"]+)\.js['"]/g

    const visit = (relFile: string): void => {
      if (reachable.has(relFile)) return
      reachable.add(relFile)
      const content = readFileSync(join(srcDir, relFile), 'utf8')
      const fileDir = dirname(relFile)
      for (const m of content.matchAll(reExport)) {
        const target = toPosix(join(fileDir, `${m[1]}.ts`))
        visit(target)
      }
    }

    visit('index.ts')
    return reachable
  }

  it('every exporting source file is reachable from the root barrel', () => {
    const reachable = collectReachable()
    const all = listSourceFiles(srcDir)

    const orphans = all.filter((rel) => {
      if (rel === 'index.ts' || rel.endsWith('/index.ts')) return false
      if (INTERNAL.has(rel) || isObservableInternal(rel)) return false
      if (reachable.has(rel)) return false
      // Only flag files that actually export something.
      const content = readFileSync(join(srcDir, rel), 'utf8')
      return /^\s*export\s/m.test(content)
    })

    expect(
      orphans,
      `files exporting symbols but not collected into any barrel:\n${orphans.join('\n')}`,
    ).toEqual([])
  })
})
