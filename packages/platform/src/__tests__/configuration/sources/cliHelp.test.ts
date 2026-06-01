import { describe, expect, it } from 'vitest'
import { buildHelpMessage, buildVersionMessage } from '../../../configuration/sources/cliHelp.js'
import type { ConfigItem } from '../../../configuration/sources/configSource.js'

const items: readonly ConfigItem[] = [
  { id: 'help', type: 'boolean', cli: 'help', cliAlias: 'h', description: 'Print usage' },
  {
    id: 'userDataDir',
    type: 'string',
    cli: 'user-data-dir',
    args: '<path>',
    description: 'Override the user data directory',
  },
  // No description → must not appear in help.
  { id: 'appData', type: 'string', env: 'APPDATA' },
]

describe('buildHelpMessage', () => {
  const help = buildHelpMessage({ executableName: 'universe-editor', version: '0.1.0', items })

  it('includes header, usage and described options', () => {
    expect(help).toContain('universe-editor 0.1.0')
    expect(help).toContain('Usage: universe-editor [options]')
    expect(help).toContain('-h --help')
    expect(help).toContain('--user-data-dir <path>')
    expect(help).toContain('Override the user data directory')
  })

  it('omits items without a description', () => {
    expect(help).not.toContain('APPDATA')
    expect(help).not.toContain('appData')
  })
})

describe('buildVersionMessage', () => {
  it('renders productName + version and extra lines', () => {
    const msg = buildVersionMessage({
      productName: 'Universe Editor',
      version: '0.1.0',
      extraLines: ['Electron 33.0.0', 'Node 20.0.0'],
    })
    expect(msg).toBe('Universe Editor 0.1.0\nElectron 33.0.0\nNode 20.0.0')
  })

  it('works without extra lines', () => {
    expect(buildVersionMessage({ productName: 'X', version: '1.2.3' })).toBe('X 1.2.3')
  })
})
