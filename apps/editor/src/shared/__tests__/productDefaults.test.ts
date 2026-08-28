import { describe, expect, it } from 'vitest'
import {
  CONFIGURATION_DEFAULTS_ARGV_FLAG,
  encodeConfigurationDefaultsArg,
  parseConfigurationDefaults,
  parseConfigurationDefaultsArg,
} from '../productDefaults.js'

describe('parseConfigurationDefaults', () => {
  it('parses a flat object of dotted settings keys', () => {
    expect(parseConfigurationDefaults('{"perforce.swarm.url":"http://swarm/"}')).toEqual({
      'perforce.swarm.url': 'http://swarm/',
    })
  })

  it('treats undefined / empty input as no defaults', () => {
    expect(parseConfigurationDefaults(undefined)).toEqual({})
    expect(parseConfigurationDefaults('')).toEqual({})
  })

  // Malformed input must degrade to "no product defaults" rather than break startup:
  // this value is read on the boot path, before any UI exists to report an error.
  it('degrades to empty on malformed JSON', () => {
    expect(parseConfigurationDefaults('{not json')).toEqual({})
  })

  it('rejects non-object JSON shapes', () => {
    expect(parseConfigurationDefaults('null')).toEqual({})
    expect(parseConfigurationDefaults('[1,2]')).toEqual({})
    expect(parseConfigurationDefaults('"a string"')).toEqual({})
    expect(parseConfigurationDefaults('42')).toEqual({})
  })
})

describe('encodeConfigurationDefaultsArg / parseConfigurationDefaultsArg', () => {
  it('round-trips through argv', () => {
    const defaults = { 'perforce.swarm.url': 'http://swarm.example.com/' }
    const arg = encodeConfigurationDefaultsArg(defaults)
    expect(arg).toBeDefined()
    expect(parseConfigurationDefaultsArg(['electron', '.', arg!, '--other'])).toEqual(defaults)
  })

  // The value is base64 precisely so Chromium's argv writer and Node's argv reader
  // never have to agree on quoting rules for `"`, spaces or shell metacharacters.
  it('keeps the flag value free of quotes, spaces and metacharacters', () => {
    const arg = encodeConfigurationDefaultsArg({ 'a.b': 'x y "z" & ^ | %PATH%' })!
    const value = arg.slice(CONFIGURATION_DEFAULTS_ARGV_FLAG.length)
    expect(value).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(parseConfigurationDefaultsArg([arg])).toEqual({ 'a.b': 'x y "z" & ^ | %PATH%' })
  })

  it('survives non-ascii values (utf8, not latin1)', () => {
    const defaults = { 'a.b': '中文 — 值' }
    expect(parseConfigurationDefaultsArg([encodeConfigurationDefaultsArg(defaults)!])).toEqual(
      defaults,
    )
  })

  it('omits the flag entirely when there is nothing to inject', () => {
    expect(encodeConfigurationDefaultsArg({})).toBeUndefined()
  })

  it('returns empty when the flag is absent', () => {
    expect(parseConfigurationDefaultsArg(['electron', '.'])).toEqual({})
  })

  it('tolerates the flag with an empty value', () => {
    expect(parseConfigurationDefaultsArg([CONFIGURATION_DEFAULTS_ARGV_FLAG])).toEqual({})
  })

  it('degrades to empty on a corrupted flag value', () => {
    expect(
      parseConfigurationDefaultsArg([`${CONFIGURATION_DEFAULTS_ARGV_FLAG}!!!not base64`]),
    ).toEqual({})
  })
})
