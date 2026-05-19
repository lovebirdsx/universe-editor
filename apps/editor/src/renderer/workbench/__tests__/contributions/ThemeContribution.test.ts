import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import { ThemeContribution } from '../../../contributions/ThemeContribution.js'

const monacoMock = vi.hoisted(() => ({
  setTheme: vi.fn(),
}))

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({
      editor: {
        setTheme: monacoMock.setTheme,
      },
    }),
  },
}))

afterEach(() => {
  monacoMock.setTheme.mockReset()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
})

describe('ThemeContribution', () => {
  it('applies the configured workbench theme to CSS and Monaco', () => {
    const config = new ConfigurationService()
    config.update('workbench.colorTheme', 'light', ConfigurationTarget.User)

    const contribution = new ThemeContribution(config)

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(monacoMock.setTheme).toHaveBeenLastCalledWith('vs')

    config.update('workbench.colorTheme', 'dark', ConfigurationTarget.User)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(monacoMock.setTheme).toHaveBeenLastCalledWith('vs-dark')

    contribution.dispose()
  })
})
