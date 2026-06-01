import { describe, expect, it } from 'vitest'
import { CliConfigSource } from '../../../configuration/sources/cliConfigSource.js'
import type { ConfigItem } from '../../../configuration/sources/configSource.js'

const strItem = (cli: string): ConfigItem<'string'> => ({ id: cli, type: 'string', cli })
const boolItem = (cli: string): ConfigItem<'boolean'> => ({ id: cli, type: 'boolean', cli })

describe('CliConfigSource', () => {
  it('parses --key=value', () => {
    const s = new CliConfigSource(['node', 'main.js', '--user-data-dir=C:\\tmp\\ue'])
    expect(s.getRawValue(strItem('user-data-dir'))).toBe('C:\\tmp\\ue')
  })

  it('parses space-separated --key value', () => {
    const s = new CliConfigSource(['node', 'main.js', '--user-data-dir', '/tmp/ue', '--foo'])
    expect(s.getRawValue(strItem('user-data-dir'))).toBe('/tmp/ue')
  })

  it('does not consume the next flag as a value', () => {
    const s = new CliConfigSource(['node', 'main.js', '--user-data-dir', '--foo'])
    expect(s.getRawValue(strItem('user-data-dir'))).toBeUndefined()
  })

  it('returns true for a present boolean flag', () => {
    const s = new CliConfigSource(['node', 'main.js', '--enable-thing'])
    expect(s.getRawValue(boolItem('enable-thing'))).toBe(true)
  })

  it('returns undefined when the flag is absent', () => {
    const s = new CliConfigSource(['node', 'main.js', '--other'])
    expect(s.getRawValue(strItem('user-data-dir'))).toBeUndefined()
  })

  it('returns undefined for items without a cli name', () => {
    const s = new CliConfigSource(['node', 'main.js', '--x=y'])
    expect(s.getRawValue({ id: 'x', type: 'string' })).toBeUndefined()
  })

  describe('short alias', () => {
    const boolAlias: ConfigItem<'boolean'> = {
      id: 'help',
      type: 'boolean',
      cli: 'help',
      cliAlias: 'h',
    }
    const strAlias: ConfigItem<'string'> = {
      id: 'out',
      type: 'string',
      cli: 'output',
      cliAlias: 'o',
    }

    it('returns true for a present boolean short flag', () => {
      const s = new CliConfigSource(['node', 'main.js', '-h'])
      expect(s.getRawValue(boolAlias)).toBe(true)
    })

    it('parses -k value and -k=value', () => {
      expect(new CliConfigSource(['node', '-o', '/tmp/a']).getRawValue(strAlias)).toBe('/tmp/a')
      expect(new CliConfigSource(['node', '-o=/tmp/b']).getRawValue(strAlias)).toBe('/tmp/b')
    })

    it('does not consume the next short flag as a value', () => {
      const s = new CliConfigSource(['node', '-o', '-h'])
      expect(s.getRawValue(strAlias)).toBeUndefined()
    })

    it('is undefined when neither long nor alias is present', () => {
      expect(new CliConfigSource(['node', '--other']).getRawValue(boolAlias)).toBeUndefined()
    })
  })
})
