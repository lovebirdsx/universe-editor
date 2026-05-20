import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import { WorkbenchFontContribution } from '../WorkbenchFontContribution.js'

afterEach(() => {
  document.documentElement.style.removeProperty('--font-ui')
})

describe('WorkbenchFontContribution', () => {
  it('applies the configured workbench font family to the UI CSS variable', () => {
    const config = new ConfigurationService()
    config.update('workbench.fontFamily', 'Inter, system-ui, sans-serif', ConfigurationTarget.User)

    const contribution = new WorkbenchFontContribution(config)

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      'Inter, system-ui, sans-serif',
    )

    config.update('workbench.fontFamily', "'IBM Plex Sans', sans-serif", ConfigurationTarget.User)

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      "'IBM Plex Sans', sans-serif",
    )

    contribution.dispose()
  })

  it('falls back when the configured font family is blank or not a string', () => {
    const config = new ConfigurationService()
    const contribution = new WorkbenchFontContribution(config)

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif",
    )

    config.update('workbench.fontFamily', '   ', ConfigurationTarget.User)
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif",
    )

    config.update('workbench.fontFamily', 123, ConfigurationTarget.User)
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif",
    )

    contribution.dispose()
  })
})
