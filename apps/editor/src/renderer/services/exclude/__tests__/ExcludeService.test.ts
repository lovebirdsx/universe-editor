/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/exclude/ExcludeService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  LogLevel,
  type IFileWatcherService,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { ExcludeService } from '../ExcludeService.js'

function makeLoggerService(): ILoggerService {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as ILogger
  return {
    _serviceBrand: undefined,
    createLogger: () => logger,
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  } as unknown as ILoggerService
}

function makeWatcher(): IFileWatcherService & { setExcludes: ReturnType<typeof vi.fn> } {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    async watch() {},
    setExcludes: vi.fn(async () => {}),
    async unwatch() {},
  } as unknown as IFileWatcherService & { setExcludes: ReturnType<typeof vi.fn> }
}

function makeService() {
  const config = new ConfigurationService()
  const watcher = makeWatcher()
  const svc = new ExcludeService(config, watcher, makeLoggerService())
  return { config, watcher, svc }
}

describe('ExcludeService', () => {
  it('excludes files matched by files.exclude (kind=files)', () => {
    const { config, svc } = makeService()
    config.update('files.exclude', { '**/.git': true }, ConfigurationTarget.User)
    expect(svc.isExcluded('.git', 'files')).toBe(true)
    expect(svc.isExcluded('src/index.ts', 'files')).toBe(false)
    svc.dispose()
  })

  it('search kind unions files.exclude and search.exclude', () => {
    const { config, svc } = makeService()
    config.update('files.exclude', { '**/.git': true }, ConfigurationTarget.User)
    config.update('search.exclude', { '**/node_modules': true }, ConfigurationTarget.User)
    expect(svc.isExcluded('.git', 'search')).toBe(true)
    expect(svc.isExcluded('node_modules', 'search')).toBe(true)
    expect(svc.isExcluded('node_modules/pkg/index.js', 'search')).toBe(true)
    expect(svc.isExcluded('packages/a/node_modules/pkg/index.js', 'search')).toBe(true)
    // node_modules is search-only, so the files kind (Explorer) does not hide it.
    expect(svc.isExcluded('node_modules', 'files')).toBe(false)
    svc.dispose()
  })

  it('merges exclude objects across layers', () => {
    const { config, svc } = makeService()
    config.update('files.exclude', { '**/a': true }, ConfigurationTarget.User)
    config.update('files.exclude', { '**/b': true }, ConfigurationTarget.VSCodeWorkspace)
    expect(svc.isExcluded('a', 'files')).toBe(true)
    expect(svc.isExcluded('b', 'files')).toBe(true)
    svc.dispose()
  })

  it('a higher-layer false cancels a lower-layer exclude', () => {
    const { config, svc } = makeService()
    config.update('files.exclude', { '**/keep': true }, ConfigurationTarget.User)
    config.update('files.exclude', { '**/keep': false }, ConfigurationTarget.Project)
    expect(svc.isExcluded('keep', 'files')).toBe(false)
    svc.dispose()
  })

  it('pushes watcherExclude globs and fires onDidChange on change', () => {
    const { config, watcher, svc } = makeService()
    let changed = 0
    svc.onDidChange(() => changed++)
    config.update('files.watcherExclude', { '**/dist/**': true }, ConfigurationTarget.User)
    expect(watcher.setExcludes).toHaveBeenCalledWith(['**/dist/**'])
    expect(changed).toBeGreaterThan(0)
    expect(svc.currentWatcherGlobs).toEqual(['**/dist/**'])
    svc.dispose()
  })

  it('exposes bare directory-name ignores from the search set', () => {
    const { config, svc } = makeService()
    config.update(
      'search.exclude',
      { '**/node_modules': true, '**/*.log': true, dist: true },
      ConfigurationTarget.User,
    )
    const dirNames = svc.getDirNameIgnores()
    expect(dirNames).toContain('dist')
    expect(dirNames).toContain('node_modules')
    // File globs are not prunable directory names.
    expect(dirNames).not.toContain('**/*.log')
    svc.dispose()
  })
})
