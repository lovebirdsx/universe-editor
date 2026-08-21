/*---------------------------------------------------------------------------------------------
 *  Tests for the OutputChannelLogger: level gating (js/ts.tsserver.log)
 *  and the VSCode-style `timestamp [level] message` line shape.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { OutputChannel } from '@universe-editor/extension-api'
import {
  logVerbosityForSetting,
  loggerLevelForSetting,
  OutputChannelLogger,
  parseTsLogLevel,
  parseTsServerLogSetting,
} from '../logger.js'

function fakeChannel(): OutputChannel & { lines: string[]; shown: number } {
  const channel = {
    name: 'TypeScript',
    lines: [] as string[],
    shown: 0,
    append(text: string) {
      channel.lines.push(text)
    },
    appendLine(text: string) {
      channel.lines.push(text)
    },
    clear() {
      channel.lines.length = 0
    },
    show() {
      channel.shown++
    },
    dispose() {},
  }
  return channel
}

describe('parseTsLogLevel', () => {
  it('accepts the four setting values', () => {
    expect(parseTsLogLevel('off')).toBe('off')
    expect(parseTsLogLevel('error')).toBe('error')
    expect(parseTsLogLevel('info')).toBe('info')
    expect(parseTsLogLevel('verbose')).toBe('verbose')
  })

  it('rejects anything else', () => {
    expect(parseTsLogLevel('debug')).toBeUndefined()
    expect(parseTsLogLevel('')).toBeUndefined()
    expect(parseTsLogLevel(undefined)).toBeUndefined()
    expect(parseTsLogLevel(3)).toBeUndefined()
  })
})

describe('js/ts.tsserver.log setting mapping', () => {
  it('parseTsServerLogSetting accepts the five VSCode setting values', () => {
    expect(parseTsServerLogSetting('off')).toBe('off')
    expect(parseTsServerLogSetting('terse')).toBe('terse')
    expect(parseTsServerLogSetting('normal')).toBe('normal')
    expect(parseTsServerLogSetting('verbose')).toBe('verbose')
    expect(parseTsServerLogSetting('requestTime')).toBe('requestTime')
  })

  it('parseTsServerLogSetting rejects the plugin-internal levels and garbage', () => {
    expect(parseTsServerLogSetting('error')).toBeUndefined()
    expect(parseTsServerLogSetting('info')).toBeUndefined()
    expect(parseTsServerLogSetting('debug')).toBeUndefined()
    expect(parseTsServerLogSetting('')).toBeUndefined()
    expect(parseTsServerLogSetting(undefined)).toBeUndefined()
    expect(parseTsServerLogSetting(3)).toBeUndefined()
  })

  it('maps each setting to the plugin logger level', () => {
    expect(loggerLevelForSetting('off')).toBe('info')
    expect(loggerLevelForSetting('terse')).toBe('info')
    expect(loggerLevelForSetting('normal')).toBe('info')
    expect(loggerLevelForSetting('verbose')).toBe('verbose')
    expect(loggerLevelForSetting('requestTime')).toBe('verbose')
  })

  it('maps each setting to the tsserver logVerbosity (off → undefined)', () => {
    expect(logVerbosityForSetting('off')).toBeUndefined()
    expect(logVerbosityForSetting('terse')).toBe('terse')
    expect(logVerbosityForSetting('normal')).toBe('normal')
    expect(logVerbosityForSetting('verbose')).toBe('verbose')
    expect(logVerbosityForSetting('requestTime')).toBe('requestTime')
  })
})

describe('OutputChannelLogger', () => {
  it('writes timestamped, leveled lines to the channel', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel)
    logger.info('server started')
    expect(channel.lines).toHaveLength(1)
    expect(channel.lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] server started$/,
    )
  })

  it('gates verbose below the default info level', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel)
    logger.verbose('request timing')
    logger.info('visible')
    expect(channel.lines).toHaveLength(1)
    expect(channel.lines[0]).toContain('visible')
  })

  it('error level still passes at info', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel)
    logger.error('boom')
    expect(channel.lines[0]).toContain('[error] boom')
  })

  it('verbose level lets everything through', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel, 'verbose')
    logger.verbose('request timing')
    expect(channel.lines[0]).toContain('[verbose] request timing')
  })

  it('off silences everything', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel, 'off')
    logger.error('boom')
    logger.info('hi')
    logger.verbose('v')
    expect(channel.lines).toHaveLength(0)
  })

  it('error level keeps only errors', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel, 'error')
    logger.info('hi')
    logger.error('boom')
    expect(channel.lines).toHaveLength(1)
    expect(channel.lines[0]).toContain('[error] boom')
  })

  it('setLevel changes the gate at runtime', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel)
    logger.verbose('dropped')
    logger.setLevel('verbose')
    logger.verbose('kept')
    expect(logger.level).toBe('verbose')
    expect(channel.lines).toHaveLength(1)
    expect(channel.lines[0]).toContain('kept')
  })

  it('show() reveals the channel', () => {
    const channel = fakeChannel()
    const logger = new OutputChannelLogger(channel)
    logger.show()
    expect(channel.shown).toBe(1)
  })
})
