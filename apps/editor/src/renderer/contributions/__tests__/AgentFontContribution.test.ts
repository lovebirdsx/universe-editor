import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import { AgentFontContribution } from '../AgentFontContribution.js'

afterEach(() => {
  document.documentElement.style.removeProperty('--agent-font-size')
  document.documentElement.style.removeProperty('--agent-font-family')
})

describe('AgentFontContribution', () => {
  it('applies the configured chat font size and family to the scoped CSS variables', () => {
    const config = new ConfigurationService()
    config.update('acp.fontSize', 16, ConfigurationTarget.User)
    config.update('acp.fontFamily', 'Georgia, serif', ConfigurationTarget.User)

    const contribution = new AgentFontContribution(config)

    const root = document.documentElement.style
    expect(root.getPropertyValue('--agent-font-size')).toBe('16px')
    expect(root.getPropertyValue('--agent-font-family')).toBe('Georgia, serif')

    config.update('acp.fontSize', 20, ConfigurationTarget.User)
    expect(root.getPropertyValue('--agent-font-size')).toBe('20px')

    contribution.dispose()
  })

  it('falls back to the default size and inherit family when unset or invalid', () => {
    const config = new ConfigurationService()
    const contribution = new AgentFontContribution(config)

    const root = document.documentElement.style
    expect(root.getPropertyValue('--agent-font-size')).toBe('14px')
    expect(root.getPropertyValue('--agent-font-family')).toBe('inherit')

    config.update('acp.fontSize', 0, ConfigurationTarget.User)
    expect(root.getPropertyValue('--agent-font-size')).toBe('14px')

    config.update('acp.fontFamily', '   ', ConfigurationTarget.User)
    expect(root.getPropertyValue('--agent-font-family')).toBe('inherit')

    contribution.dispose()
  })
})
