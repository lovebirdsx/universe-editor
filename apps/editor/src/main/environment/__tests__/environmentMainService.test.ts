import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentMainService } from '../environmentMainService.js'

function make(opts: {
  argv?: readonly string[]
  env?: Record<string, string | undefined>
  isDev?: boolean
  platform?: NodeJS.Platform
  homeDir?: string
}): EnvironmentMainService {
  return new EnvironmentMainService({
    argv: opts.argv ?? ['node', 'main.js'],
    env: opts.env ?? {},
    isDev: opts.isDev ?? false,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
  })
}

describe('userDataDirOverride', () => {
  it('prefers --user-data-dir over UNIVERSE_USER_DATA_DIR', () => {
    const env = make({
      argv: ['node', 'main.js', '--user-data-dir=/cli'],
      env: { UNIVERSE_USER_DATA_DIR: '/env' },
    })
    expect(env.userDataDirOverride).toBe('/cli')
  })

  it('falls back to the env var when no cli flag', () => {
    expect(make({ env: { UNIVERSE_USER_DATA_DIR: '/env' } }).userDataDirOverride).toBe('/env')
  })

  it('is undefined when neither is set', () => {
    expect(make({}).userDataDirOverride).toBeUndefined()
  })
})

describe('isE2E', () => {
  it('is true only for "1" (or "true")', () => {
    expect(make({ env: { UNIVERSE_E2E: '1' } }).isE2E).toBe(true)
    expect(make({ env: { UNIVERSE_E2E: 'true' } }).isE2E).toBe(true)
    expect(make({ env: { UNIVERSE_E2E: '0' } }).isE2E).toBe(false)
    expect(make({ env: {} }).isE2E).toBe(false)
  })
})

describe('rendererUrl / rendererDebug', () => {
  it('reads ELECTRON_RENDERER_URL and VSCODE_RENDERER_DEBUG', () => {
    const env = make({
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', VSCODE_RENDERER_DEBUG: '1' },
    })
    expect(env.rendererUrl).toBe('http://localhost:5173')
    expect(env.rendererDebug).toBe(true)
  })

  it('defaults rendererDebug to false and rendererUrl to undefined', () => {
    const env = make({})
    expect(env.rendererUrl).toBeUndefined()
    expect(env.rendererDebug).toBe(false)
  })
})

describe('updateUrl', () => {
  it('resolves cli > env', () => {
    const env = make({
      argv: ['node', 'main.js', '--update-url=http://cli/'],
      env: { UNIVERSE_UPDATE_URL: 'http://env/' },
    })
    expect(env.updateUrl).toBe('http://cli/')
  })

  it('skips an invalid (non-http) url and falls through', () => {
    const env = make({
      argv: ['node', 'main.js', '--update-url=ftp://bad/'],
      env: { UNIVERSE_UPDATE_URL: 'http://env/' },
    })
    expect(env.updateUrl).toBe('http://env/')
  })

  it('reads from <userData>/update-config.json after resolveFileConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    writeFileSync(join(dir, 'update-config.json'), JSON.stringify({ updateUrl: 'http://file/' }))
    const env = make({})
    expect(env.updateUrl).toBeUndefined()
    env.resolveFileConfig(dir)
    expect(env.updateUrl).toBe('http://file/')
  })

  it('cli/env outrank the file source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    writeFileSync(join(dir, 'update-config.json'), JSON.stringify({ updateUrl: 'http://file/' }))
    const env = make({ env: { UNIVERSE_UPDATE_URL: 'http://env/' } })
    env.resolveFileConfig(dir)
    expect(env.updateUrl).toBe('http://env/')
  })

  it('tolerates a missing config file', () => {
    const env = make({})
    env.resolveFileConfig(join(tmpdir(), 'does-not-exist-ue'))
    expect(env.updateUrl).toBeUndefined()
  })
})

describe('galleryUrl', () => {
  it('resolves cli > env', () => {
    const env = make({
      argv: ['node', 'main.js', '--gallery-url=http://cli/'],
      env: { UNIVERSE_GALLERY_URL: 'http://env/' },
    })
    expect(env.galleryUrl).toBe('http://cli/')
  })

  it('skips an invalid (non-http) url', () => {
    const env = make({ argv: ['node', 'main.js', '--gallery-url=ftp://bad/'] })
    expect(env.galleryUrl).toBeUndefined()
  })

  it('is undefined by default (OSS: no marketplace)', () => {
    const env = make({})
    expect(env.galleryUrl).toBeUndefined()
  })

  it('reads galleryUrl from an update-config.json with a trailing comma (JSONC)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    writeFileSync(join(dir, 'update-config.json'), '{\n  "galleryUrl": "http://file/",\n}')
    const env = make({})
    env.resolveFileConfig(dir)
    expect(env.galleryUrl).toBe('http://file/')
  })

  it('reads galleryUrl from an update-config.json with // comments (JSONC)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    writeFileSync(
      join(dir, 'update-config.json'),
      '{\n  // marketplace endpoint\n  "galleryUrl": "http://file/"\n}',
    )
    const env = make({})
    env.resolveFileConfig(dir)
    expect(env.galleryUrl).toBe('http://file/')
  })

  it('falls back to the bundled product config (lowest priority)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    const product = join(dir, 'product.json')
    writeFileSync(product, JSON.stringify({ galleryUrl: 'http://product/' }))
    const env = make({})
    env.resolveFileConfig(dir, product)
    expect(env.galleryUrl).toBe('http://product/')
  })

  it('lets cli / env / update-config outrank the product config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    writeFileSync(join(dir, 'update-config.json'), JSON.stringify({ galleryUrl: 'http://file/' }))
    const product = join(dir, 'product.json')
    writeFileSync(product, JSON.stringify({ galleryUrl: 'http://product/' }))
    const env = make({})
    env.resolveFileConfig(dir, product)
    expect(env.galleryUrl).toBe('http://file/')
  })

  it('tolerates a missing product config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-env-'))
    const env = make({})
    env.resolveFileConfig(dir, join(dir, 'does-not-exist-product.json'))
    expect(env.galleryUrl).toBeUndefined()
  })
})

describe('configDir', () => {
  it('falls back to userData when nothing overrides it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-cfg-'))
    const env = make({})
    env.resolveFileConfig(dir)
    expect(env.configDir).toBe(dir)
  })

  it('reads <userData>/config-location.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-cfg-'))
    writeFileSync(join(dir, 'config-location.json'), JSON.stringify({ configDir: '/my/config' }))
    const env = make({})
    env.resolveFileConfig(dir)
    expect(env.configDir).toBe('/my/config')
  })

  it('resolves cli > env > file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-cfg-'))
    writeFileSync(join(dir, 'config-location.json'), JSON.stringify({ configDir: '/file' }))
    const env = make({
      argv: ['node', 'main.js', '--config-dir=/cli'],
      env: { UNIVERSE_CONFIG_DIR: '/env' },
    })
    env.resolveFileConfig(dir)
    expect(env.configDir).toBe('/cli')
  })

  it('env outranks the file source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ue-cfg-'))
    writeFileSync(join(dir, 'config-location.json'), JSON.stringify({ configDir: '/file' }))
    const env = make({ env: { UNIVERSE_CONFIG_DIR: '/env' } })
    env.resolveFileConfig(dir)
    expect(env.configDir).toBe('/env')
  })
})

describe('cli commands', () => {
  it('shouldPrintHelp for --help and -h', () => {
    expect(make({ argv: ['node', 'main.js', '--help'] }).shouldPrintHelp).toBe(true)
    expect(make({ argv: ['node', 'main.js', '-h'] }).shouldPrintHelp).toBe(true)
    expect(make({}).shouldPrintHelp).toBe(false)
  })

  it('shouldPrintVersion for --version and -v', () => {
    expect(make({ argv: ['node', 'main.js', '--version'] }).shouldPrintVersion).toBe(true)
    expect(make({ argv: ['node', 'main.js', '-v'] }).shouldPrintVersion).toBe(true)
    expect(make({}).shouldPrintVersion).toBe(false)
  })

  it('formatHelp lists the known cli options', () => {
    const help = make({}).formatHelp('universe-editor', '0.1.0')
    expect(help).toContain('Usage: universe-editor [options]')
    expect(help).toContain('--help')
    expect(help).toContain('--version')
    expect(help).toContain('--user-data-dir')
    expect(help).toContain('--config-dir')
    expect(help).toContain('--update-url')
  })

  it('formatVersion includes product name, version and extra lines', () => {
    const v = make({}).formatVersion('Universe Editor', '0.1.0', ['Electron 33'])
    expect(v).toBe('Universe Editor 0.1.0\nElectron 33')
  })
})

describe('toResolveEnv', () => {
  it('maps env vars equivalently to the legacy readEnvFromProcess', () => {
    const env = make({
      argv: ['node', 'main.js', '--user-data-dir=/cli'],
      env: {
        UNIVERSE_E2E: '1',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        HOME: 'C:\\Users\\u',
      },
      isDev: true,
      platform: 'win32',
    })
    expect(env.toResolveEnv()).toEqual({
      isDev: true,
      isE2E: true,
      platform: 'win32',
      home: 'C:\\Users\\u',
      override: '/cli',
      appData: 'C:\\Users\\u\\AppData\\Roaming',
    })
  })

  it('home falls back HOME -> USERPROFILE -> homeDir', () => {
    expect(make({ env: { USERPROFILE: '/up' }, homeDir: '/hd' }).toResolveEnv().home).toBe('/up')
    expect(make({ env: {}, homeDir: '/hd' }).toResolveEnv().home).toBe('/hd')
  })

  it('honors XDG_CONFIG_HOME', () => {
    const re = make({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homeDir: '/home/u',
    }).toResolveEnv()
    expect(re.xdgConfigHome).toBe('/xdg')
  })
})
