import { describe, expect, it } from 'vitest'
import { statusBarContent } from '../statusIndicator.js'
import type { TsServerSpec } from '../lspClient.js'

const tsls: TsServerSpec = { kind: 'tsls', cli: 'cli', tsserver: 'tsserver', version: '5.9.2' }
const native: TsServerSpec = { kind: 'native', binary: '/bin/tsgo', version: '7.0.0-dev.1' }

describe('statusBarContent', () => {
  it('starting shows only a spinner, naming the server in the tooltip', () => {
    const content = statusBarContent(tsls, 'starting')
    expect(content.text).toBe('')
    expect(content.showProgress).toBe('spinning')
    expect(content.visible).toBe(true)
    expect(content.tooltip).toContain('typescript-language-server (tsserver)')
  })

  it('ready stays visible with the version in the tooltip', () => {
    const content = statusBarContent(tsls, 'ready')
    expect(content.text).toBe('$(pulse)')
    expect(content.showProgress).toBe(false)
    expect(content.visible).toBe(true)
    expect(content.tooltip).toContain('typescript-language-server (tsserver)')
    expect(content.tooltip).toContain('5.9.2')
  })

  it('ready under native reports tsgo + version in the tooltip', () => {
    const content = statusBarContent(native, 'ready')
    expect(content.text).toBe('$(pulse)')
    expect(content.tooltip).toContain('TypeScript Native (tsgo)')
    expect(content.tooltip).toContain('7.0.0-dev.1')
  })

  it('error stays visible without a spinner', () => {
    const content = statusBarContent(native, 'error')
    expect(content.text).toBe('$(error)')
    expect(content.showProgress).toBe(false)
    expect(content.visible).toBe(true)
    expect(content.tooltip).toContain('TypeScript Native (tsgo)')
  })
})
